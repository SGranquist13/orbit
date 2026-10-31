//! Port of `src/lib/transcript.ts`: folds the flat event stream into render blocks.

use orbit_proto::{AgentEvent, StoredEvent};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub output: Option<String>,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    User {
        key: String,
        text: String,
        skill: Option<String>,
        images: usize,
        files: usize,
    },
    Assistant {
        key: String,
        text: String,
    },
    Tools {
        key: String,
        calls: Vec<ToolCall>,
    },
    TurnEnd {
        key: String,
        duration_ms: Option<u64>,
        cost_usd: Option<f64>,
        tokens: Option<u64>,
        error: Option<String>,
        interrupted: bool,
    },
    Plan {
        key: String,
        done: usize,
        total: usize,
    },
    SessionReset {
        key: String,
    },
    Error {
        key: String,
        message: String,
    },
}

impl Block {
    pub fn key(&self) -> &str {
        match self {
            Block::User { key, .. }
            | Block::Assistant { key, .. }
            | Block::Tools { key, .. }
            | Block::TurnEnd { key, .. }
            | Block::Plan { key, .. }
            | Block::SessionReset { key }
            | Block::Error { key, .. } => key,
        }
    }
}

pub fn fold(events: &[StoredEvent]) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut turn_tokens: Option<u64> = None;

    for e in events {
        let key = e.seq.to_string();
        match &e.event {
            AgentEvent::Plan { items, .. } => {
                if !items.is_empty() {
                    let done = items.iter().filter(|i| i.status == "done").count();
                    blocks.push(Block::Plan { key, done, total: items.len() });
                }
            }
            AgentEvent::UserMessage { text, skill, images, files } => blocks.push(Block::User {
                key,
                text: text.clone(),
                skill: skill.clone(),
                images: images.len(),
                files: files.len(),
            }),
            AgentEvent::Message { text } => {
                if !text.trim().is_empty() {
                    blocks.push(Block::Assistant { key, text: text.clone() });
                }
            }
            AgentEvent::ToolCall { id, name, input } => {
                let call = ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                    output: None,
                    is_error: false,
                };
                // Consecutive tool calls collapse into one group, like "5 tool calls".
                match blocks.last_mut() {
                    Some(Block::Tools { calls, .. }) => calls.push(call),
                    _ => blocks.push(Block::Tools { key, calls: vec![call] }),
                }
            }
            AgentEvent::ToolResult { id, output, is_error } => {
                // Results attach by id to the call, wherever its group is.
                'find: for b in blocks.iter_mut().rev() {
                    if let Block::Tools { calls, .. } = b {
                        for c in calls.iter_mut() {
                            if &c.id == id {
                                c.output = Some(output.clone());
                                c.is_error = *is_error;
                                break 'find;
                            }
                        }
                    }
                }
            }
            AgentEvent::Usage { input_tokens, output_tokens, cache_write_tokens, .. } => {
                turn_tokens = Some(input_tokens + output_tokens + cache_write_tokens);
            }
            AgentEvent::SessionReset => blocks.push(Block::SessionReset { key }),
            AgentEvent::TurnCompleted { duration_ms, cost_usd, is_error, error, interrupted } => {
                blocks.push(Block::TurnEnd {
                    key,
                    duration_ms: *duration_ms,
                    cost_usd: *cost_usd,
                    tokens: turn_tokens.take(),
                    error: is_error.then(|| error.clone().unwrap_or_else(|| "Turn failed".into())),
                    interrupted: *interrupted,
                });
            }
            AgentEvent::Error { message } => blocks.push(Block::Error { key, message: message.clone() }),
            AgentEvent::Exited { code: Some(code), stderr } if *code != 0 => {
                let mut message = format!("Agent exited with code {code}");
                if !stderr.is_empty() {
                    message.push('\n');
                    message.push_str(stderr);
                }
                blocks.push(Block::Error { key, message });
            }
            _ => {}
        }
    }
    blocks
}

/// 12400 -> "12.4k", 1_500_000 -> "1.5M".
pub fn format_tokens(n: u64) -> String {
    let trim = |s: String| s.strip_suffix(".0").map(str::to_string).unwrap_or(s);
    if n < 1000 {
        n.to_string()
    } else if n < 100_000 {
        let v = n as f64 / 1000.0;
        trim(if n < 10_000 { format!("{v:.1}") } else { format!("{v:.0}") }) + "k"
    } else if n < 1_000_000 {
        format!("{}k", (n as f64 / 1000.0).round() as u64)
    } else {
        trim(format!("{:.1}", n as f64 / 1_000_000.0)) + "M"
    }
}

pub fn format_cost(usd: f64) -> String {
    if usd < 0.1 {
        format!("${usd:.3}")
    } else {
        format!("${usd:.2}")
    }
}

pub fn format_duration(ms: u64) -> String {
    let s = (ms as f64 / 1000.0).round() as u64;
    if s < 60 {
        format!("{s}s")
    } else {
        format!("{}m {}s", s / 60, s % 60)
    }
}

fn base(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

/// One-line summary of a tool call's input, e.g. the command or file it touched.
pub fn tool_summary(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match name {
        "Bash" => s("command"),
        "Read" | "ViewImage" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            if let Some(files) = input.get("files").and_then(Value::as_array) {
                return files
                    .iter()
                    .map(|f| base(f.as_str().map(str::to_string).unwrap_or_else(|| f.to_string()).as_str()).to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
            }
            let p =
                [s("file_path"), s("notebook_path"), s("path")].into_iter().find(|p| !p.is_empty()).unwrap_or_default();
            base(&p).to_string()
        }
        "Grep" | "Glob" => s("pattern"),
        "WebSearch" => s("query"),
        "WebFetch" => s("url"),
        "Task" | "Agent" => s("description"),
        "TodoWrite" => {
            input.get("todos").and_then(Value::as_array).map(|t| format!("{} todos", t.len())).unwrap_or_default()
        }
        _ => String::new(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Search,
    Read,
    Edit,
    Command,
    Other,
}

pub fn tool_kind(name: &str) -> ToolKind {
    match name {
        "Grep" | "Glob" | "WebSearch" => ToolKind::Search,
        "Read" | "ViewImage" | "WebFetch" => ToolKind::Read,
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => ToolKind::Edit,
        "Bash" => ToolKind::Command,
        _ => ToolKind::Other,
    }
}

/// The short verb shown on a tool row (visual.md §3.2).
pub fn tool_verb(name: &str) -> String {
    match name {
        "Grep" | "Glob" => "grep".into(),
        "Read" | "ViewImage" => "read".into(),
        "Write" => "write".into(),
        "Edit" | "MultiEdit" | "NotebookEdit" => "edit".into(),
        "Bash" => "run".into(),
        "WebSearch" => "search".into(),
        "WebFetch" => "fetch".into(),
        "TodoWrite" => "todo".into(),
        other => other.to_lowercase(),
    }
}

fn line_count(s: &str) -> u32 {
    if s.is_empty() {
        0
    } else {
        s.trim_end_matches('\n').split('\n').count() as u32
    }
}

/// `(+added, −removed)` from what the agent asked for (behaviour.md §1.3).
pub fn edit_counts(name: &str, input: &Value) -> Option<(u32, u32)> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match name {
        "Edit" => Some((line_count(&s(input, "new_string")), line_count(&s(input, "old_string")))),
        "MultiEdit" => input.get("edits").and_then(Value::as_array).map(|edits| {
            edits
                .iter()
                .fold((0, 0), |(a, d), e| (a + line_count(&s(e, "new_string")), d + line_count(&s(e, "old_string"))))
        }),
        "Write" => Some((line_count(&s(input, "content")), 0)),
        _ => None,
    }
}

/// "5 tool calls · 2 edits" for a folded group.
pub fn folded_label(calls: &[ToolCall]) -> String {
    let n = calls.len();
    let edits = calls.iter().filter(|c| tool_kind(&c.name) == ToolKind::Edit).count();
    let mut s = format!("{n} tool call{}", if n == 1 { "" } else { "s" });
    if edits > 0 {
        s.push_str(&format!(" · {edits} edit{}", if edits == 1 { "" } else { "s" }));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(seq: i64, v: Value) -> StoredEvent {
        StoredEvent { commit_sha: None, seq, ts: 0, event: serde_json::from_value(v).unwrap() }
    }

    #[test]
    fn folds_like_the_desktop() {
        let events = vec![
            ev(1, json!({"type":"userMessage","text":"fix it"})),
            ev(2, json!({"type":"turnStarted"})),
            ev(3, json!({"type":"message","text":"Looking."})),
            ev(4, json!({"type":"toolCall","id":"a","name":"Grep","input":{"pattern":"login"}})),
            ev(
                5,
                json!({"type":"toolCall","id":"b","name":"Edit","input":{"file_path":"src/a.ts","old_string":"x","new_string":"y\nz"}}),
            ),
            ev(6, json!({"type":"toolResult","id":"a","output":"3 matches","isError":false})),
            ev(7, json!({"type":"toolResult","id":"b","output":"boom","isError":true})),
            ev(8, json!({"type":"message","text":"  "})),
            ev(
                9,
                json!({"type":"usage","inputTokens":1000,"outputTokens":200,"cacheReadTokens":9999,"cacheWriteTokens":50}),
            ),
            ev(10, json!({"type":"turnCompleted","durationMs":38000,"costUsd":0.02,"isError":false,"error":null})),
            ev(11, json!({"type":"sessionReset"})),
            ev(12, json!({"type":"exited","code":1,"stderr":"auth"})),
            ev(13, json!({"type":"exited","code":0,"stderr":""})),
            ev(14, json!({"type":"turnCompleted","durationMs":null,"costUsd":null,"isError":true,"error":null})),
        ];
        let b = fold(&events);
        assert_eq!(b.len(), 7);
        assert!(matches!(&b[0], Block::User { text, .. } if text == "fix it"));
        assert!(matches!(&b[1], Block::Assistant { .. }));
        let Block::Tools { calls, key } = &b[2] else { panic!() };
        assert_eq!(key, "4");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].output.as_deref(), Some("3 matches"));
        assert!(calls[1].is_error);
        assert!(matches!(&b[3], Block::TurnEnd { tokens: Some(1250), error: None, .. }));
        assert!(matches!(&b[4], Block::SessionReset { .. }));
        assert!(matches!(&b[5], Block::Error { message, .. } if message == "Agent exited with code 1\nauth"));
        assert!(matches!(&b[6], Block::TurnEnd { error: Some(e), tokens: None, .. } if e == "Turn failed"));
    }

    #[test]
    fn summaries_and_counts() {
        assert_eq!(tool_summary("Bash", &json!({"command":"bun test"})), "bun test");
        assert_eq!(tool_summary("Read", &json!({"file_path":"C:\\src\\a.ts"})), "a.ts");
        assert_eq!(tool_summary("Edit", &json!({"files":["src/a.ts","b/c.rs"]})), "a.ts, c.rs");
        assert_eq!(tool_summary("TodoWrite", &json!({"todos":[1,2]})), "2 todos");
        assert_eq!(tool_summary("Mystery", &json!({})), "");
        assert_eq!(edit_counts("Write", &json!({"content":"a\nb\nc\n"})), Some((3, 0)));
        assert_eq!(
            edit_counts(
                "MultiEdit",
                &json!({"edits":[{"old_string":"a","new_string":"b\nc"},{"old_string":"d\ne","new_string":""}]})
            ),
            Some((2, 3))
        );
        assert_eq!(edit_counts("Bash", &json!({})), None);
    }

    #[test]
    fn formats() {
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(12_400), "12k");
        assert_eq!(format_tokens(1_200), "1.2k");
        assert_eq!(format_tokens(2_000), "2k");
        assert_eq!(format_tokens(412_000), "412k");
        assert_eq!(format_tokens(1_500_000), "1.5M");
        assert_eq!(format_tokens(2_000_000), "2M");
        assert_eq!(format_duration(38_000), "38s");
        assert_eq!(format_duration(125_000), "2m 5s");
        assert_eq!(format_cost(0.0123), "$0.012");
        assert_eq!(format_cost(1.5), "$1.50");
    }
}
