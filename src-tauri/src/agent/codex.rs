//! Codex adapter: `codex app-server` speaks JSON-RPC over stdio. One process per session,
//! one thread per workspace. Messages sent mid-turn use `turn/steer`.

use super::{process, push_tail, AgentEvent, Command, EventSink, SessionConfig};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::ChildStdout;
use tokio::sync::mpsc;

/// Workspaces are isolated worktrees and shipping needs network (git push, gh), so the
/// agent runs unsandboxed and never asks for approval.
const APPROVAL_POLICY: &str = "never";
const SANDBOX_READONLY: &str = "read-only";

/// Maps one server notification to normalized events. Pure, so it is fixture-testable.
pub fn parse_notification(method: &str, p: &Value) -> Vec<AgentEvent> {
    match method {
        "turn/started" => vec![AgentEvent::TurnStarted],
        "item/agentMessage/delta" => vec![AgentEvent::TextDelta {
            text: p["delta"].as_str().unwrap_or_default().to_string(),
        }],
        "item/started" => item_started(&p["item"]).into_iter().collect(),
        "item/completed" => item_completed(&p["item"]).into_iter().collect(),
        "turn/completed" => {
            let turn = &p["turn"];
            let failed = turn["status"] == "failed";
            vec![AgentEvent::TurnCompleted {
                duration_ms: None,
                cost_usd: None,
                is_error: failed,
                error: failed.then(|| error_message(&turn["error"])),
                interrupted: turn["status"] == "interrupted",
            }]
        }
        "error" if p["willRetry"] == true => vec![AgentEvent::Error {
            message: format!("{} (retrying)", error_message(&p["error"])),
        }],
        _ => vec![],
    }
}

fn item_started(item: &Value) -> Option<AgentEvent> {
    let id = item["id"].as_str()?.to_string();
    let (name, input) = match item["type"].as_str()? {
        "commandExecution" => ("Bash".to_string(), json!({ "command": item["command"] })),
        "fileChange" => ("Edit".to_string(), json!({ "files": change_paths(item) })),
        "mcpToolCall" => (
            format!("{}/{}", item["server"].as_str()?, item["tool"].as_str()?),
            item["arguments"].clone(),
        ),
        "webSearch" => ("WebSearch".to_string(), json!({ "query": item["query"] })),
        _ => return None,
    };
    Some(AgentEvent::ToolCall { id, name, input })
}

fn item_completed(item: &Value) -> Option<AgentEvent> {
    let id = item["id"].as_str()?.to_string();
    match item["type"].as_str()? {
        "agentMessage" => Some(AgentEvent::Message { text: item["text"].as_str()?.to_string() }),
        "commandExecution" => Some(AgentEvent::ToolResult {
            id,
            output: item["aggregatedOutput"].as_str().unwrap_or_default().to_string(),
            is_error: item["exitCode"].as_i64().is_some_and(|c| c != 0) || item["status"] == "failed",
        }),
        "fileChange" => Some(AgentEvent::ToolResult {
            id,
            output: change_paths(item).join("\n"),
            is_error: item["status"] != "completed",
        }),
        "mcpToolCall" => Some(AgentEvent::ToolResult {
            id,
            output: if item["error"].is_null() {
                item["result"]["content"].to_string()
            } else {
                error_message(&item["error"])
            },
            is_error: !item["error"].is_null(),
        }),
        "webSearch" => Some(AgentEvent::ToolResult { id, output: String::new(), is_error: false }),
        _ => None,
    }
}

fn change_paths(item: &Value) -> Vec<String> {
    item["changes"]
        .as_array()
        .map(|cs| cs.iter().filter_map(|c| c["path"].as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Codex wraps API errors as a JSON string in `message`; unwrap `detail` when present.
fn error_message(err: &Value) -> String {
    let msg = err["message"].as_str().unwrap_or("unknown error");
    serde_json::from_str::<Value>(msg)
        .ok()
        .and_then(|v| v["detail"].as_str().map(String::from))
        .unwrap_or_else(|| msg.to_string())
}

fn text_input(text: &str) -> Value {
    json!([{ "type": "text", "text": text, "text_elements": [] }])
}

#[derive(Clone, Copy)]
enum Pending {
    Initialize,
    Thread,
    Turn,
    Other,
}

struct Rpc {
    stdin: tokio::process::ChildStdin,
    next_id: u64,
    pending: HashMap<u64, Pending>,
}

impl Rpc {
    async fn write(&mut self, msg: Value) {
        let _ = self.stdin.write_all(format!("{msg}\n").as_bytes()).await;
        let _ = self.stdin.flush().await;
    }

    async fn request(&mut self, method: &str, params: Value, kind: Pending) {
        self.next_id += 1;
        self.pending.insert(self.next_id, kind);
        self.write(json!({ "id": self.next_id, "method": method, "params": params })).await;
    }
}

struct State {
    cfg: SessionConfig,
    thread_id: Option<String>,
    turn_id: Option<String>,
    /// A turn/start was sent but its id is not known yet.
    turn_starting: bool,
    queued: Vec<String>,
}

pub fn spawn(cfg: SessionConfig, sink: EventSink, mut rx: mpsc::UnboundedReceiver<Command>) -> anyhow::Result<()> {
    let mut child = process::command("codex", &["app-server".to_string()], &cfg.cwd)?.spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    let mut stdout: Lines<BufReader<ChildStdout>> = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let stderr = child.stderr.take().expect("piped stderr");

    let (err_tx, mut err_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = err_tx.send(line);
        }
    });

    tokio::spawn(async move {
        let mut rpc = Rpc { stdin, next_id: 0, pending: HashMap::new() };
        let mut st = State { cfg, thread_id: None, turn_id: None, turn_starting: false, queued: vec![] };
        let mut tail = Vec::new();

        rpc.request(
            "initialize",
            json!({ "clientInfo": { "name": "orbit", "title": "Orbit", "version": env!("CARGO_PKG_VERSION") }, "capabilities": null }),
            Pending::Initialize,
        )
        .await;

        let code = loop {
            tokio::select! {
                status = child.wait() => break status.ok().and_then(|s| s.code()),
                Some(line) = err_rx.recv() => push_tail(&mut tail, line),
                line = stdout.next_line() => {
                    let Ok(Some(line)) = line else { continue };
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    handle_message(&mut rpc, &mut st, &sink, msg).await;
                }
                cmd = rx.recv() => match cmd {
                    Some(Command::User(text)) => send_user(&mut rpc, &mut st, text).await,
                    Some(Command::Interrupt) => {
                        if let (Some(thread), Some(turn)) = (&st.thread_id, &st.turn_id) {
                            let params = json!({ "threadId": thread, "turnId": turn });
                            rpc.request("turn/interrupt", params, Pending::Other).await;
                        }
                        st.queued.clear();
                    }
                    Some(Command::Shutdown) | None => {
                        let _ = child.kill().await;
                        break None;
                    }
                },
            }
        };
        while let Ok(line) = err_rx.try_recv() {
            push_tail(&mut tail, line);
        }
        sink(AgentEvent::Exited { code, stderr: tail.join("\n") });
    });
    Ok(())
}

async fn send_user(rpc: &mut Rpc, st: &mut State, text: String) {
    let Some(thread) = st.thread_id.clone() else {
        st.queued.push(text);
        return;
    };
    match (&st.turn_id, st.turn_starting) {
        (Some(turn), _) => {
            let params = json!({ "threadId": thread, "input": text_input(&text), "expectedTurnId": turn });
            rpc.request("turn/steer", params, Pending::Other).await;
        }
        (None, true) => st.queued.push(text),
        (None, false) => {
            st.turn_starting = true;
            let params = json!({ "threadId": thread, "input": text_input(&text) });
            rpc.request("turn/start", params, Pending::Turn).await;
        }
    }
}

async fn handle_message(rpc: &mut Rpc, st: &mut State, sink: &EventSink, msg: Value) {
    let method = msg["method"].as_str();
    match (msg.get("id").filter(|id| !id.is_null()), method) {
        // Server -> client request (approvals, user input): we run unattended, so accept.
        (Some(id), Some(_)) => {
            rpc.write(json!({ "id": id, "result": { "decision": "accept" } })).await;
        }
        // Response to one of our requests.
        (Some(id), None) => {
            let kind = id.as_u64().and_then(|i| rpc.pending.remove(&i)).unwrap_or(Pending::Other);
            if let Some(err) = msg.get("error") {
                sink(AgentEvent::Error { message: error_message(err) });
                if matches!(kind, Pending::Turn) {
                    st.turn_starting = false;
                }
                return;
            }
            let result = &msg["result"];
            match kind {
                Pending::Initialize => {
                    rpc.write(json!({ "method": "initialized" })).await;
                    let mut params = json!({
                        "cwd": st.cfg.cwd.display().to_string(),
                        "approvalPolicy": APPROVAL_POLICY,
                        "sandbox": if st.cfg.readonly { SANDBOX_READONLY } else { st.cfg.sandbox.as_str() },
                        "persistExtendedHistory": false,
                    });
                    if let Some(model) = &st.cfg.model {
                        params["model"] = json!(model);
                    }
                    if let Some(text) = &st.cfg.instructions {
                        params["developerInstructions"] = json!(text);
                    }
                    if let Some(id) = &st.cfg.resume {
                        params["threadId"] = json!(id);
                        rpc.request("thread/resume", params, Pending::Thread).await;
                    } else {
                        params["experimentalRawEvents"] = json!(false);
                        rpc.request("thread/start", params, Pending::Thread).await;
                    }
                }
                Pending::Thread => {
                    let id = result["thread"]["id"].as_str().unwrap_or_default().to_string();
                    st.thread_id = Some(id.clone());
                    sink(AgentEvent::SessionStarted { session_id: id, model: result["model"].as_str().map(String::from) });
                    flush_queue(rpc, st).await;
                }
                Pending::Turn => {
                    st.turn_starting = false;
                    if let Some(id) = result["turn"]["id"].as_str() {
                        st.turn_id = Some(id.to_string());
                    }
                    flush_queue(rpc, st).await;
                }
                Pending::Other => {}
            }
        }
        // Notification.
        (None, Some(method)) => {
            let params = &msg["params"];
            match method {
                "turn/started" => st.turn_id = params["turn"]["id"].as_str().map(String::from),
                "turn/completed" => st.turn_id = None,
                _ => {}
            }
            for ev in parse_notification(method, params) {
                sink(ev);
            }
            if method == "turn/completed" {
                flush_queue(rpc, st).await;
            }
        }
        (None, None) => {}
    }
}

/// Sends queued messages: the first starts a turn, the rest steer it once its id is known.
async fn flush_queue(rpc: &mut Rpc, st: &mut State) {
    while !st.queued.is_empty() && !st.turn_starting {
        let text = st.queued.remove(0);
        send_user(rpc, st, text).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_fixture(name: &str) -> Vec<AgentEvent> {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|m| m.get("id").is_none())
            .flat_map(|m| parse_notification(m["method"].as_str().unwrap_or_default(), &m["params"]))
            .collect()
    }

    /// Drives the real `codex` binary through handshake + one turn: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_codex_session_round_trip() {
        let dir = std::env::temp_dir().join("orbit_codex_live");
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cfg = SessionConfig { kind: super::super::AgentKind::Codex, cwd: dir, model: None, resume: None, plugin_dirs: vec![], add_dirs: vec![], instructions: None, readonly: false, permission_mode: "bypassPermissions".into(), sandbox: "danger-full-access".into() };
        let handle = super::super::spawn(cfg, std::sync::Arc::new(move |ev| { let _ = tx.send(ev); })).unwrap();
        handle.send(Command::User("Reply with the single word: pong".into()));
        let mut seen = Vec::new();
        let done = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            while let Some(ev) = rx.recv().await {
                let end = matches!(ev, AgentEvent::TurnCompleted { .. } | AgentEvent::Exited { .. });
                seen.push(ev);
                if end { break; }
            }
        })
        .await;
        handle.send(Command::Shutdown);
        eprintln!("{seen:#?}");
        assert!(done.is_ok(), "timed out");
        assert!(matches!(seen.first(), Some(AgentEvent::SessionStarted { .. })));
        assert!(seen.iter().any(|e| matches!(e, AgentEvent::TurnCompleted { is_error: false, .. })));
        assert!(seen.iter().any(|e| matches!(e, AgentEvent::Message { .. })));
    }

    #[test]
    fn model_error_is_a_failed_turn_with_readable_message() {
        // Recorded from a real codex-cli 0.107 run.
        let evs = parse_fixture("codex_model_error.jsonl");
        assert_eq!(evs.first(), Some(&AgentEvent::TurnStarted));
        match evs.last() {
            Some(AgentEvent::TurnCompleted { is_error: true, error: Some(e), .. }) => {
                assert!(e.starts_with("The 'gpt-6.1-sol' model is not supported"), "{e}")
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn tool_turn_maps_commands_files_and_messages() {
        let evs = parse_fixture("codex_tool_turn.jsonl");
        assert!(evs.contains(&AgentEvent::ToolCall {
            id: "call_1".into(),
            name: "Bash".into(),
            input: json!({ "command": "cat a.txt" })
        }));
        assert!(evs.contains(&AgentEvent::ToolResult { id: "call_1".into(), output: "hello world\n".into(), is_error: false }));
        assert!(evs.contains(&AgentEvent::ToolResult { id: "patch_1".into(), output: "b.txt".into(), is_error: false }));
        assert!(evs.contains(&AgentEvent::TextDelta { text: "Done".into() }));
        assert!(evs.contains(&AgentEvent::Message { text: "Done: read a.txt and created b.txt.".into() }));
        assert!(matches!(evs.last(), Some(AgentEvent::TurnCompleted { is_error: false, .. })));
    }
}
