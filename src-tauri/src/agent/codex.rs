//! Codex adapter: `codex app-server` speaks JSON-RPC over stdio. One process per session,
//! one thread per workspace. Messages sent mid-turn use `turn/steer`.

use super::{process, push_tail, AgentEvent, Command, EventSink, ImageRef, SessionConfig};
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
        "item/fileChange/patchUpdated" => vec![AgentEvent::ToolDraft {
            id: p["itemId"].as_str().unwrap_or_default().to_string(),
            name: "Edit".into(),
            input: json!({ "files": change_paths(p), "changes": p["changes"] }),
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

/// Stateful wrapper over `parse_notification` that adds `Usage`. Codex streams
/// `thread/tokenUsage/updated` after each API call of a turn (`last` = that call, `total` =
/// whole thread), so a turn's usage is the sum of `last` across its updates; the context size
/// is the latest call's total. `Usage` is emitted just before the turn's `TurnCompleted`.
#[derive(Default)]
pub struct CodexParser {
    in_turn: bool,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    context: Option<u64>,
    window: Option<u64>,
    pub model: Option<String>,
}

impl CodexParser {
    pub fn parse(&mut self, method: &str, p: &Value) -> Vec<AgentEvent> {
        match method {
            "turn/started" => {
                self.in_turn = true;
                (self.input, self.output, self.cache_read, self.cache_write) = (0, 0, 0, 0);
            }
            "thread/tokenUsage/updated" => {
                let usage = &p["tokenUsage"];
                let last = &usage["last"];
                let n = |k: &str| last[k].as_u64().unwrap_or(0);
                // OpenAI counts cached/written tokens inside `inputTokens`; report them separately.
                let (cached, written) = (n("cachedInputTokens"), n("cacheWriteInputTokens"));
                let (input, output) = (n("inputTokens").saturating_sub(cached + written), n("outputTokens"));
                self.context = last["totalTokens"].as_u64().or(self.context);
                self.window = usage["modelContextWindow"].as_u64().or(self.window);
                if self.in_turn {
                    self.input += input;
                    self.output += output;
                    self.cache_read += cached;
                    self.cache_write += written;
                } else {
                    // Outside a turn (e.g. after a compaction): only the context size changed.
                    return vec![self.usage_event(0, 0, 0, 0)];
                }
            }
            "turn/completed" => {
                self.in_turn = false;
                let mut out = vec![self.usage_event(self.input, self.output, self.cache_read, self.cache_write)];
                out.extend(parse_notification(method, p));
                return out;
            }
            _ => {}
        }
        parse_notification(method, p)
    }

    fn usage_event(&self, input: u64, output: u64, cache_read: u64, cache_write: u64) -> AgentEvent {
        AgentEvent::Usage {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            context_tokens: self.context,
            context_window: self.window,
            // Codex runs on the ChatGPT plan, so there is no per-token cost.
            cost_usd: None,
            model: self.model.clone(),
        }
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
        "imageView" => ("ViewImage".to_string(), json!({ "path": item["path"] })),
        "imageGeneration" => ("GenerateImage".to_string(), json!({ "prompt": item["revisedPrompt"] })),
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
            images: vec![],
        }),
        "fileChange" => Some(AgentEvent::ToolResult {
            id,
            output: change_paths(item).join("\n"),
            is_error: item["status"] != "completed",
            images: vec![],
        }),
        "mcpToolCall" => Some(AgentEvent::ToolResult {
            id,
            output: if item["error"].is_null() {
                item["result"]["content"].to_string()
            } else {
                error_message(&item["error"])
            },
            is_error: !item["error"].is_null(),
            images: vec![],
        }),
        "webSearch" => Some(AgentEvent::ToolResult { id, output: String::new(), is_error: false, images: vec![] }),
        "imageView" => {
            let path = item["path"].as_str()?;
            Some(AgentEvent::ToolResult { id, output: path.to_string(), is_error: false, images: image_refs(Some(path)) })
        }
        "imageGeneration" => Some(AgentEvent::ToolResult {
            id,
            output: item["revisedPrompt"].as_str().unwrap_or_default().to_string(),
            is_error: item["status"] == "failed" || !item["failure"].is_null(),
            images: image_refs(item["savedPath"].as_str()),
        }),
        _ => None,
    }
}

/// An image on disk as an `ImageRef`, if the extension is a supported image type.
fn image_refs(path: Option<&str>) -> Vec<ImageRef> {
    path.and_then(|p| {
        let media_type = crate::images::media_type_for_path(std::path::Path::new(p))?;
        Some(ImageRef { path: p.to_string(), media_type: media_type.to_string(), data: None })
    })
    .into_iter()
    .collect()
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

/// Codex `UserInput[]`: a text item (omitted when empty and there are images) plus one
/// `localImage` item per image.
fn user_input(text: &str, images: &[ImageRef]) -> Value {
    let mut items = Vec::new();
    if !text.is_empty() || images.is_empty() {
        items.push(json!({ "type": "text", "text": text, "text_elements": [] }));
    }
    items.extend(images.iter().map(|i| json!({ "type": "localImage", "path": i.path })));
    Value::Array(items)
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
    queued: Vec<(String, Vec<ImageRef>)>,
    parser: CodexParser,
}

/// `codex app-server`, plus the built-in Ollama provider for a `local:<name>` model.
pub fn app_server_args(cfg: &SessionConfig) -> Vec<String> {
    let mut a = vec!["app-server".to_string()];
    a.extend(crate::mcp::codex_args(&cfg.mcp_servers));
    if cfg.model.as_deref().and_then(super::local_model).is_some() {
        a.extend(["-c".into(), "model_provider=\"ollama\"".into()]);
    }
    a
}

pub fn spawn(cfg: SessionConfig, sink: EventSink, mut rx: mpsc::UnboundedReceiver<Command>) -> anyhow::Result<()> {
    let mut cmd = process::command("codex", &app_server_args(&cfg), &cfg.cwd)?;
    if let (Some(url), true) = (&cfg.local_url, cfg.model.as_deref().and_then(super::local_model).is_some()) {
        // Codex's built-in `ollama` provider defaults to localhost:11434; a custom URL goes via its env override.
        if url.trim_end_matches('/') != "http://localhost:11434" {
            cmd.env("CODEX_OSS_BASE_URL", format!("{}/v1", url.trim_end_matches('/')));
        }
    }
    let mut child = process::spawn(&mut cmd)?;
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
        let mut st = State { cfg, thread_id: None, turn_id: None, turn_starting: false, queued: vec![], parser: CodexParser::default() };
        let mut tail = Vec::new();
        // So an early exit says which binary it was (shows in the error turn and the transcript).
        if let Ok(p) = process::resolve("codex") {
            tail.push(format!("[orbit] codex binary: {}", p.display()));
        }

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
                    Some(Command::User { text, images }) => send_user(&mut rpc, &mut st, text, images).await,
                    Some(Command::Compact) => {
                        if let Some(thread) = &st.thread_id {
                            rpc.request("thread/compact/start", json!({ "threadId": thread }), Pending::Other).await;
                        }
                    }
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

async fn send_user(rpc: &mut Rpc, st: &mut State, text: String, images: Vec<ImageRef>) {
    let Some(thread) = st.thread_id.clone() else {
        st.queued.push((text, images));
        return;
    };
    match (&st.turn_id, st.turn_starting) {
        (Some(turn), _) => {
            let params = json!({ "threadId": thread, "input": user_input(&text, &images), "expectedTurnId": turn });
            rpc.request("turn/steer", params, Pending::Other).await;
        }
        (None, true) => st.queued.push((text, images)),
        (None, false) => {
            st.turn_starting = true;
            let params = json!({ "threadId": thread, "input": user_input(&text, &images) });
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
                        params["model"] = json!(super::local_model(model).unwrap_or(model));
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
                    st.parser.model = result["model"].as_str().map(String::from);
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
            for ev in st.parser.parse(method, params) {
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
        let (text, images) = st.queued.remove(0);
        send_user(rpc, st, text, images).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_input_has_local_images() {
        let img = ImageRef { path: "/h/images/w/ab.png".into(), media_type: "image/png".into(), data: None };
        assert_eq!(
            user_input("look", &[img.clone()]),
            json!([{"type":"text","text":"look","text_elements":[]},{"type":"localImage","path":"/h/images/w/ab.png"}])
        );
        assert_eq!(user_input("", &[img]), json!([{"type":"localImage","path":"/h/images/w/ab.png"}]));
        assert_eq!(user_input("hi", &[]), json!([{"type":"text","text":"hi","text_elements":[]}]));
    }

    #[test]
    fn image_view_item_maps_to_tool_call_and_result() {
        let item = json!({ "type": "imageView", "id": "iv1", "path": "/w/shot.png" });
        assert_eq!(item_started(&item), Some(AgentEvent::ToolCall { id: "iv1".into(), name: "ViewImage".into(), input: json!({"path":"/w/shot.png"}) }));
        assert_eq!(item_completed(&item), Some(AgentEvent::ToolResult {
            id: "iv1".into(),
            output: "/w/shot.png".into(),
            is_error: false,
            images: vec![ImageRef { path: "/w/shot.png".into(), media_type: "image/png".into(), data: None }],
        }));
    }

    #[test]
    fn file_change_patch_updated_draft() {
        // Hand-written from FileChangePatchUpdatedNotification; no recorded Codex stream exists.
        let params = json!({
            "threadId":"thread-1", "turnId":"turn-1", "itemId":"edit-1",
            "changes":[
                {"path":"src/main.rs","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1 @@\n-old\n+new"},
                {"path":"poem.txt","kind":{"type":"add"},"diff":"+hello"}
            ]
        });
        let events = CodexParser::default().parse("item/fileChange/patchUpdated", &params);
        assert_eq!(events, vec![AgentEvent::ToolDraft {
            id: "edit-1".into(), name: "Edit".into(),
            input: json!({"files":["src/main.rs","poem.txt"],"changes":params["changes"]}),
        }]);
        assert!(!events[0].is_persistent());
        let wire = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(wire["type"], "toolDraft");
        assert_eq!(serde_json::from_value::<AgentEvent>(wire).unwrap(), events[0]);
        let final_call = item_started(&json!({"id":"edit-1","type":"fileChange","changes":params["changes"]})).unwrap();
        assert!(final_call.is_persistent());
        assert!(matches!(final_call, AgentEvent::ToolCall { input, .. } if input["files"] == json!(["src/main.rs","poem.txt"])));
        assert!(!AgentEvent::TextDelta { text:"hi".into() }.is_persistent());
    }

    #[test]
    fn mcp_overrides_are_passed_even_for_readonly_sessions() {
        let server: crate::mcp::McpServer = serde_json::from_value(json!({
            "id":"one", "name":"docs", "transport":"http", "url":"https://example.com/mcp", "enabled":true
        })).unwrap();
        let cfg = SessionConfig {
            kind: super::super::AgentKind::Codex, cwd: ".".into(), model: None, resume: None,
            plugin_dirs: vec![], add_dirs: vec![], instructions: None, readonly: true,
            permission_mode: "bypassPermissions".into(), sandbox: "danger-full-access".into(), local_url: None,
            mcp_servers: vec![server.clone()], mcp_config: None,
        };
        let mut expected = vec!["app-server".to_string()];
        expected.extend(crate::mcp::codex_args(&[server]));
        assert_eq!(app_server_args(&cfg), expected);
        assert_eq!(app_server_args(&SessionConfig { readonly: false, ..cfg }), expected);
    }

    fn parse_fixture(name: &str) -> Vec<AgentEvent> {
        let mut parser = CodexParser::default();
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|m| m.get("id").is_none())
            .flat_map(|m| parser.parse(m["method"].as_str().unwrap_or_default(), &m["params"]))
            .collect()
    }

    #[test]
    fn usage_turn_reports_tokens_and_context() {
        // Recorded from codex-cli 0.162 (`Reply with: pong`). inputTokens (20235) includes the
        // 13440 cached tokens, which we report separately.
        let mut parser = CodexParser { model: Some("gpt-6.1-sol".into()), ..Default::default() };
        let path = format!("{}/tests/fixtures/codex_usage_turn.jsonl", env!("CARGO_MANIFEST_DIR"));
        let evs: Vec<AgentEvent> = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|m| m.get("id").is_none())
            .flat_map(|m| parser.parse(m["method"].as_str().unwrap(), &m["params"]))
            .collect();
        let n = evs.len();
        assert_eq!(
            evs[n - 2],
            AgentEvent::Usage {
                input_tokens: 20235 - 13440,
                output_tokens: 5,
                cache_read_tokens: 13440,
                cache_write_tokens: 0,
                context_tokens: Some(20240),
                context_window: Some(258_400),
                cost_usd: None,
                model: Some("gpt-6.1-sol".into()),
            }
        );
        assert!(matches!(evs[n - 1], AgentEvent::TurnCompleted { is_error: false, .. }));
        assert!(evs.contains(&AgentEvent::Message { text: "pong".into() }));
    }

    #[test]
    fn usage_sums_api_calls_within_a_turn() {
        let mut p = CodexParser::default();
        p.parse("turn/started", &json!({}));
        let upd = |input: u64, cached: u64, out: u64| {
            json!({ "tokenUsage": { "last": { "totalTokens": input + out, "inputTokens": input, "cachedInputTokens": cached,
                "cacheWriteInputTokens": 0, "outputTokens": out }, "modelContextWindow": 1000 } })
        };
        p.parse("thread/tokenUsage/updated", &upd(100, 40, 10));
        p.parse("thread/tokenUsage/updated", &upd(150, 100, 20));
        let evs = p.parse("turn/completed", &json!({ "turn": { "status": "completed" } }));
        assert!(matches!(
            evs[0],
            AgentEvent::Usage {
                input_tokens: 110, output_tokens: 30, cache_read_tokens: 140, context_tokens: Some(170), ..
            }
        ));
    }

    /// Drives the real `codex` binary through handshake + one turn: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_codex_session_round_trip() {
        let dir = std::env::temp_dir().join("orbit_codex_live");
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cfg = SessionConfig { kind: super::super::AgentKind::Codex, cwd: dir, model: None, resume: None, plugin_dirs: vec![], add_dirs: vec![], instructions: None, readonly: false, permission_mode: "bypassPermissions".into(), sandbox: "danger-full-access".into(), mcp_servers: vec![], mcp_config: None, local_url: None };
        let handle = super::super::spawn(cfg, 0, std::sync::Arc::new(move |ev| { let _ = tx.send(ev); })).unwrap();
        handle.send(Command::User { text: "Reply with the single word: pong".into(), images: vec![] });
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

    /// Sends a red PNG to the real `codex` binary and expects it to name the colour:
    /// `cargo test -- --ignored live_codex_image_attachment`.
    #[tokio::test]
    #[ignore]
    async fn live_codex_image_attachment() {
        use base64::Engine;
        let dir = std::env::temp_dir().join("orbit_codex_image_attachment");
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("red.png");
        std::fs::write(&png, base64::engine::general_purpose::STANDARD.decode(crate::images::RED_PNG_B64).unwrap()).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cfg = SessionConfig { kind: super::super::AgentKind::Codex, cwd: dir, model: None, resume: None, plugin_dirs: vec![], add_dirs: vec![], instructions: None, readonly: false, permission_mode: "bypassPermissions".into(), sandbox: "danger-full-access".into(), mcp_servers: vec![], mcp_config: None, local_url: None };
        let handle = super::super::spawn(cfg, 0, std::sync::Arc::new(move |ev| { let _ = tx.send(ev); })).unwrap();
        handle.send(Command::User {
            text: "What colour is this image? One word.".into(),
            images: vec![ImageRef { path: png.to_string_lossy().to_string(), media_type: "image/png".into(), data: None }],
        });
        let mut seen = Vec::new();
        let done = tokio::time::timeout(std::time::Duration::from_secs(180), async {
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
        assert!(seen.iter().any(|e| matches!(e, AgentEvent::TurnCompleted { is_error: false, .. })), "turn failed");
        assert!(seen.iter().any(|e| matches!(e, AgentEvent::Message { text } if text.to_lowercase().contains("red"))), "no message naming red");
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
        assert!(evs.contains(&AgentEvent::ToolResult { id: "call_1".into(), output: "hello world\n".into(), is_error: false, images: vec![] }));
        assert!(evs.contains(&AgentEvent::ToolResult { id: "patch_1".into(), output: "b.txt".into(), is_error: false, images: vec![] }));
        assert!(evs.contains(&AgentEvent::TextDelta { text: "Done".into() }));
        assert!(evs.contains(&AgentEvent::Message { text: "Done: read a.txt and created b.txt.".into() }));
        assert!(matches!(evs.last(), Some(AgentEvent::TurnCompleted { is_error: false, .. })));
    }
}
