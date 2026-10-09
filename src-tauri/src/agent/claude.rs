//! Claude Code adapter: one long-lived `claude -p` process per session speaking
//! stream-json on stdin/stdout.

use super::{process, push_tail, AgentEvent, Command, EventSink, SessionConfig};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// Default permission mode: workspaces are isolated worktrees, so agents run unattended.
const PERMISSION_MODE: &str = "bypassPermissions";

/// File-editing tools denied in read-only roles (comma-separated, so the variadic flag can't swallow later args).
const READONLY_DENY: &str = "Edit,Write,MultiEdit,NotebookEdit";

/// Read-only roles run in the default permission mode, where anything not on this list is denied
/// (there is no one to approve prompts in -p mode). That also blocks Bash writes like `echo > f`,
/// which a tool denylist alone can't. GitHub issue commands stay allowed for the Ticket writer.
const READONLY_ALLOW: &str = "Read,Grep,Glob,LS,WebSearch,WebFetch,TodoWrite,Task,\
Bash(git status:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git branch:*),Bash(git blame:*),\
Bash(ls:*),Bash(rg:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr checks:*),\
Bash(gh issue view:*),Bash(gh issue list:*),Bash(gh issue create:*),Bash(gh label list:*)";

pub fn args(cfg: &SessionConfig) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        if cfg.readonly { "default" } else { PERMISSION_MODE },
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(model) = &cfg.model {
        a.extend(["--model".into(), model.clone()]);
    }
    if let Some(id) = &cfg.resume {
        a.extend(["--resume".into(), id.clone()]);
    }
    for dir in &cfg.plugin_dirs {
        a.extend(["--plugin-dir".into(), dir.display().to_string()]);
    }
    for dir in &cfg.add_dirs {
        a.extend(["--add-dir".into(), dir.display().to_string()]);
    }
    if cfg.readonly {
        a.extend(["--allowedTools".into(), READONLY_ALLOW.into()]);
        a.extend(["--disallowedTools".into(), READONLY_DENY.into()]);
    }
    if let Some(text) = &cfg.instructions {
        a.extend(["--append-system-prompt".into(), text.clone()]);
    }
    a
}

pub fn user_line(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    })
    .to_string()
}

fn interrupt_line(request_id: u64) -> String {
    json!({
        "type": "control_request",
        "request_id": format!("int-{request_id}"),
        "request": { "subtype": "interrupt" }
    })
    .to_string()
}

/// Maps one stream-json line to normalized events. Pure, so it is fixture-testable.
pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    // Subagent chatter (Task tool) is noise in the main transcript.
    if v.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
        return vec![];
    }
    match v["type"].as_str() {
        Some("system") if v["subtype"] == "init" => vec![AgentEvent::SessionStarted {
            session_id: v["session_id"].as_str().unwrap_or_default().to_string(),
            model: v["model"].as_str().map(String::from),
        }],
        Some("stream_event") => {
            let ev = &v["event"];
            if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                let text = ev["delta"]["text"].as_str().unwrap_or_default();
                return vec![AgentEvent::TextDelta { text: text.to_string() }];
            }
            vec![]
        }
        Some("assistant") => content(&v)
            .iter()
            .filter_map(|block| match block["type"].as_str()? {
                "text" => Some(AgentEvent::Message {
                    text: block["text"].as_str()?.to_string(),
                }),
                "tool_use" => Some(AgentEvent::ToolCall {
                    id: block["id"].as_str()?.to_string(),
                    name: block["name"].as_str()?.to_string(),
                    input: block["input"].clone(),
                }),
                _ => None,
            })
            .collect(),
        Some("user") => content(&v)
            .iter()
            .filter(|b| b["type"] == "tool_result")
            .map(|b| AgentEvent::ToolResult {
                id: b["tool_use_id"].as_str().unwrap_or_default().to_string(),
                output: tool_result_text(&b["content"]),
                is_error: b["is_error"].as_bool().unwrap_or(false),
            })
            .collect(),
        Some("result") => {
            let is_error = v["is_error"].as_bool().unwrap_or(false) || v["subtype"] != "success";
            vec![AgentEvent::TurnCompleted {
                duration_ms: v["duration_ms"].as_u64(),
                cost_usd: v["total_cost_usd"].as_f64(),
                is_error,
                error: is_error.then(|| v["result"].as_str().unwrap_or("turn failed").to_string()),
                interrupted: false,
            }]
        }
        _ => vec![],
    }
}

/// Claude reports an interrupted turn as a failed result; after we asked it to stop,
/// relabel that result as an interruption instead of an error.
fn relabel_interrupted(ev: AgentEvent, interrupt_pending: &AtomicBool) -> AgentEvent {
    match ev {
        AgentEvent::TurnCompleted { duration_ms, cost_usd, is_error, error, .. } => {
            if interrupt_pending.swap(false, Ordering::SeqCst) && is_error {
                AgentEvent::TurnCompleted { duration_ms, cost_usd, is_error: false, error: None, interrupted: true }
            } else {
                AgentEvent::TurnCompleted { duration_ms, cost_usd, is_error, error, interrupted: false }
            }
        }
        other => other,
    }
}

fn content(v: &Value) -> &[Value] {
    v["message"]["content"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn tool_result_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub fn spawn(cfg: SessionConfig, sink: EventSink, mut rx: mpsc::UnboundedReceiver<Command>) -> anyhow::Result<()> {
    let mut child = process::command("claude", &args(&cfg), &cfg.cwd)?.spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let interrupt_pending = Arc::new(AtomicBool::new(false));
    let out_sink = sink.clone();
    let pending = interrupt_pending.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            for ev in parse_line(&line) {
                out_sink(relabel_interrupted(ev, &pending));
            }
        }
    });

    let (err_tx, mut err_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = err_tx.send(line);
        }
    });

    tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut interrupts = 0u64;
        let code = loop {
            tokio::select! {
                status = child.wait() => break status.ok().and_then(|s| s.code()),
                Some(line) = err_rx.recv() => push_tail(&mut tail, line),
                cmd = rx.recv() => {
                    let line = match cmd {
                        Some(Command::User(text)) => user_line(&text),
                        Some(Command::Interrupt) => {
                            interrupts += 1;
                            interrupt_pending.store(true, Ordering::SeqCst);
                            interrupt_line(interrupts)
                        }
                        Some(Command::Shutdown) | None => {
                            let _ = child.kill().await;
                            break None;
                        }
                    };
                    if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                        sink(AgentEvent::Error { message: "claude stdin closed".into() });
                    }
                    let _ = stdin.flush().await;
                }
            }
        };
        while let Ok(line) = err_rx.try_recv() {
            push_tail(&mut tail, line);
        }
        sink(AgentEvent::Exited { code, stderr: tail.join("\n") });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_fixture(name: &str) -> Vec<AgentEvent> {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(path).unwrap().lines().flat_map(parse_line).collect()
    }

    #[test]
    fn full_turn_with_tool_use() {
        let evs = parse_fixture("claude_tool_turn.jsonl");
        assert_eq!(
            evs[0],
            AgentEvent::SessionStarted { session_id: "sess-1".into(), model: Some("claude-haiku".into()) }
        );
        assert!(evs.contains(&AgentEvent::TextDelta { text: "Reading".into() }));
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::ToolCall { name, .. } if name == "Read")));
        assert!(evs.contains(&AgentEvent::ToolResult {
            id: "toolu_1".into(),
            output: "hello world".into(),
            is_error: false
        }));
        assert!(evs.contains(&AgentEvent::Message { text: "The file says hello world.".into() }));
        assert!(matches!(
            evs.last(),
            Some(AgentEvent::TurnCompleted { is_error: false, duration_ms: Some(2100), .. })
        ));
    }

    #[test]
    fn real_cli_turn_read_then_write() {
        // Recorded from claude 2.1.295 (haiku): Read a.txt, Write b.txt, one-line reply.
        let evs = parse_fixture("claude_real_turn.jsonl");
        assert!(matches!(evs.first(), Some(AgentEvent::SessionStarted { .. })));
        let tools: Vec<_> = evs
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCall { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tools, ["Read", "Write"]);
        let results = evs.iter().filter(|e| matches!(e, AgentEvent::ToolResult { is_error: false, .. })).count();
        assert_eq!(results, 2);
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::TextDelta { .. })));
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::Message { text } if text.contains("b.txt"))));
        assert!(matches!(evs.last(), Some(AgentEvent::TurnCompleted { is_error: false, cost_usd: Some(_), .. })));
    }

    /// Drives the real `claude` binary through one turn: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_claude_session_round_trip() {
        let dir = std::env::temp_dir().join("orbit_claude_live");
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cfg = SessionConfig {
            kind: super::super::AgentKind::Claude,
            cwd: dir,
            model: Some("haiku".into()),
            resume: None,
            plugin_dirs: vec![],
            add_dirs: vec![],
            instructions: None,
            readonly: false,
        };
        let handle = super::super::spawn(cfg, std::sync::Arc::new(move |ev| {
            let _ = tx.send(ev);
        }))
        .unwrap();
        handle.send(Command::User("Reply with the single word: pong".into()));
        let mut seen = Vec::new();
        let done = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            while let Some(ev) = rx.recv().await {
                let end = matches!(ev, AgentEvent::TurnCompleted { .. } | AgentEvent::Exited { .. });
                seen.push(ev);
                if end {
                    break;
                }
            }
        })
        .await;
        handle.send(Command::Shutdown);
        eprintln!("{seen:#?}");
        assert!(done.is_ok(), "timed out");
        assert!(seen.iter().any(|e| matches!(e, AgentEvent::TurnCompleted { is_error: false, .. })));
    }

    #[test]
    fn auth_error_surfaces_as_failed_turn() {
        // Recorded from a real CLI with an expired login.
        let evs = parse_fixture("claude_auth_error.jsonl");
        match evs.last() {
            Some(AgentEvent::TurnCompleted { is_error: true, error: Some(e), .. }) => {
                assert!(e.contains("401"))
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn interrupted_turn_is_not_an_error() {
        let failed = || AgentEvent::TurnCompleted {
            duration_ms: None,
            cost_usd: None,
            is_error: true,
            error: Some("turn failed".into()),
            interrupted: false,
        };
        let pending = AtomicBool::new(true);
        assert!(matches!(
            relabel_interrupted(failed(), &pending),
            AgentEvent::TurnCompleted { is_error: false, interrupted: true, error: None, .. }
        ));
        // Flag is consumed: a later real failure stays a failure.
        assert!(matches!(relabel_interrupted(failed(), &pending), AgentEvent::TurnCompleted { is_error: true, .. }));
    }

    #[test]
    fn subagent_messages_are_skipped() {
        let line = r#"{"type":"assistant","parent_tool_use_id":"toolu_9","message":{"content":[{"type":"text","text":"inner"}]}}"#;
        assert!(parse_line(line).is_empty());
    }

    #[test]
    fn args_include_resume_and_plugins() {
        let cfg = SessionConfig {
            kind: super::super::AgentKind::Claude,
            cwd: ".".into(),
            model: Some("opus".into()),
            resume: Some("abc".into()),
            plugin_dirs: vec!["/packs/ecc".into()],
            add_dirs: vec!["/code/shared-ui".into(), "/code/api".into()],
            instructions: Some("ctx".into()),
            readonly: false,
        };
        let rw = args(&cfg).join(" ");
        assert!(!rw.contains("--disallowedTools") && rw.contains("--permission-mode bypassPermissions"));
        let cfg = SessionConfig { readonly: true, ..cfg };
        let a = args(&cfg).join(" ");
        // Read-only: no bypass, an explicit allowlist (so Bash writes are denied), edit tools denied.
        assert!(a.contains("--permission-mode default") && !a.contains("bypassPermissions"));
        assert!(args(&cfg).iter().any(|x| x == READONLY_ALLOW), "allowlist must be one argv entry");
        assert!(a.contains("--disallowedTools Edit,Write,MultiEdit,NotebookEdit --append-system-prompt"));
        assert!(a.contains("--model opus"));
        assert!(a.contains("--resume abc"));
        assert!(a.contains("--plugin-dir /packs/ecc"));
        assert!(a.contains("--add-dir /code/shared-ui --add-dir /code/api"));
        assert!(a.ends_with("--append-system-prompt ctx"));
    }
}
