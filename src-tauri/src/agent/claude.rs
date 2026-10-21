//! Claude Code adapter: one long-lived `claude -p` process per session speaking
//! stream-json on stdin/stdout.

use super::{process, push_tail, AgentEvent, AgentKind, Command, EventSink, ImageRef, LimitWindow, RateLimits, SessionConfig};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// Read-only roles run in the default permission mode, where anything not on this list is denied
/// (there is no one to approve prompts in -p mode). That also blocks Bash writes like `echo > f`,
/// which a tool denylist alone can't. Edit(path) covers all file-editing tools, including Write;
/// allow scratch files only under the real home's ~/.orbit/tmp, independent of ORBIT_HOME.
/// A blanket Edit/Write/MultiEdit deny would override that scoped allow. Keep NotebookEdit denied.
/// GitHub issue commands stay allowed for the Ticket writer. Lists are comma-separated so the
/// variadic flags can't swallow later args.
const READONLY_DENY: &str = "NotebookEdit";
const READONLY_ALLOW: &str = "Read,Grep,Glob,LS,WebSearch,WebFetch,TodoWrite,Task,TaskCreate,TaskUpdate,TaskList,TaskGet,Edit(~/.orbit/tmp/**),\
Bash(git status:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git branch:*),Bash(git blame:*),\
Bash(ls:*),Bash(rg:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr checks:*),\
Bash(gh issue view:*),Bash(gh issue list:*),Bash(gh issue create:*),Bash(gh label list:*)";

// Claude Code only expands `default` when used alone; combining it with task tools drops built-ins.
// Explicitly expose Orbit's tools, excluding scheduling and coordination managed by Orbit itself.
// Availability via --tools does not bypass the read-only --allowedTools permission rules.
const SESSION_TOOLS: &str = "Task,Bash,PowerShell,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch,Skill,ToolSearch,TaskStop,TaskCreate,TaskUpdate,TaskList,TaskGet";

/// Must match the fixed home-relative permission rule, even when ORBIT_HOME is customized.
pub fn scratch_dir() -> anyhow::Result<std::path::PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("could not find your home folder for Claude scratch files"))?;
    Ok(home.join(".orbit").join("tmp"))
}

pub fn args(cfg: &SessionConfig) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        SESSION_TOOLS,
        "--permission-mode",
        if cfg.readonly { "default" } else { cfg.permission_mode.as_str() },
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(path) = &cfg.mcp_config {
        a.extend(["--mcp-config".into(), path.display().to_string()]);
    }
    if let Some(model) = &cfg.model {
        a.extend(["--model".into(), super::local_model(model).unwrap_or(model).to_string()]);
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

/// Env that points Claude Code at Ollama's Anthropic-compatible `/v1/messages` endpoint for a
/// `local:<name>` model. Empty for normal sessions. Set on this spawn only (after the host scrub).
pub fn local_env(cfg: &SessionConfig) -> Vec<(&'static str, String)> {
    let local = cfg.model.as_deref().and_then(super::local_model).is_some();
    match (&cfg.local_url, local) {
        (Some(url), true) => vec![
            ("ANTHROPIC_BASE_URL", url.clone()),
            ("ANTHROPIC_AUTH_TOKEN", "ollama".into()),
            // An empty key stops a real one from taking precedence over the token.
            ("ANTHROPIC_API_KEY", String::new()),
        ],
        _ => vec![],
    }
}

pub fn user_line(text: &str) -> String {
    user_line_with_images(text, &[])
}

/// A user message: one base64 image block per `(media_type, data)`, then the text (omitted when
/// empty and there are images).
pub fn user_line_with_images(text: &str, images: &[(String, String)]) -> String {
    let mut content: Vec<Value> = images
        .iter()
        .map(|(media_type, data)| json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } }))
        .collect();
    if !text.is_empty() || content.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string()
}

/// Images inside a `tool_result` content array (e.g. the Read tool on a PNG), base64 still inline.
fn tool_result_images(c: &Value) -> Vec<ImageRef> {
    c.as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"] == "image" && p["source"]["type"] == "base64")
                .filter_map(|p| {
                    Some(ImageRef {
                        path: String::new(),
                        media_type: p["source"]["media_type"].as_str()?.to_string(),
                        data: Some(p["source"]["data"].as_str()?.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn interrupt_line(request_id: u64) -> String {
    json!({
        "type": "control_request",
        "request_id": format!("int-{request_id}"),
        "request": { "subtype": "interrupt" }
    })
    .to_string()
}

/// Maps one stream-json line to normalized events without cross-line state (no context size).
#[cfg(test)]
pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    ClaudeParser::default().parse(line)
}

/// Stateful line parser. A `result` line only carries per-turn totals (a turn makes several API
/// calls), so the context size comes from the last `assistant` message's usage seen before it.
#[derive(Default)]
pub struct ClaudeParser {
    tool_blocks: HashMap<u64, ToolBlock>,
    tasks: HashMap<String, ClaudeTask>,
    task_order: Vec<String>,
    /// Mutations waiting for a successful tool_result, keyed by tool_use_id.
    task_calls: HashMap<String, (String, Value)>,
    /// input + cache read + cache creation of the latest assistant message this turn.
    last_context: Option<u64>,
    /// A `/compact` happened this turn, so the context shrank without an assistant message.
    compacted: Option<u64>,
    model: Option<String>,
}

#[derive(PartialEq, Eq)]
struct ClaudeTask {
    subject: String,
    active_form: Option<String>,
    status: super::PlanStatus,
}

struct ToolBlock {
    id: String,
    name: String,
    buffer: String,
    emitted_bytes: usize,
}

impl ToolBlock {
    fn draft(&self, input: Value) -> AgentEvent {
        AgentEvent::ToolDraft { id: self.id.clone(), name: self.name.clone(), input }
    }
}

impl ClaudeParser {
    // SessionReset replaces the process/parser. Init and compaction also discard task state.
    fn reset_tasks(&mut self) {
        self.tasks.clear();
        self.task_order.clear();
        self.task_calls.clear();
    }

    fn task_plan(&self) -> AgentEvent {
        let items = self.task_order.iter().filter_map(|id| self.tasks.get(id)).map(|task| {
            let text = if task.status == super::PlanStatus::InProgress {
                task.active_form.as_ref().unwrap_or(&task.subject)
            } else {
                &task.subject
            };
            super::PlanItem { text: text.clone(), status: task.status.clone() }
        }).collect();
        AgentEvent::Plan { items, explanation: None }
    }

    fn task_result(&mut self, block: &Value, result: &Value) -> Option<AgentEvent> {
        let (name, input) = self.task_calls.remove(block["tool_use_id"].as_str()?)?;
        if block["is_error"] == true || result["success"] == false {
            return None;
        }
        if name == "TaskCreate" {
            let output = tool_result_text(&block["content"]);
            let id = result["task"]["id"].as_str().or_else(|| {
                output.strip_prefix("Task #")?.split_once(" created successfully:").map(|(id, _)| id)
            })?;
            let task = ClaudeTask {
                subject: input["subject"].as_str()?.into(),
                active_form: input["activeForm"].as_str().map(String::from),
                status: super::PlanStatus::Pending,
            };
            if self.tasks.get(id) == Some(&task) { return None; }
            if !self.tasks.contains_key(id) { self.task_order.push(id.into()); }
            self.tasks.insert(id.into(), task);
        } else {
            let id = input["taskId"].as_str()?;
            if input["status"] == "deleted" {
                self.tasks.remove(id)?;
                self.task_order.retain(|key| key != id);
            } else {
                let task = self.tasks.get_mut(id)?;
                let before = (task.subject.clone(), task.active_form.clone(), task.status.clone());
                if let Some(subject) = input["subject"].as_str() { task.subject = subject.into(); }
                if let Some(active) = input["activeForm"].as_str() { task.active_form = Some(active.into()); }
                match input["status"].as_str() {
                    Some("pending") => task.status = super::PlanStatus::Pending,
                    Some("in_progress") => task.status = super::PlanStatus::InProgress,
                    Some("completed") => task.status = super::PlanStatus::Done,
                    _ => {}
                }
                if before == (task.subject.clone(), task.active_form.clone(), task.status.clone()) { return None; }
            }
        }
        Some(self.task_plan())
    }

    pub fn parse(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        // Subagent chatter (Task tool) is noise in the main transcript.
        if v.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
            return vec![];
        }
        match v["type"].as_str() {
            Some("rate_limit_event") => {
                let info = &v["rate_limit_info"];
                let kind = |s: &str| match s {
                    "five_hour" => "fiveHour".to_string(),
                    "seven_day" => "weekly".to_string(),
                    other => other.to_string(),
                };
                let windows = if let Some(unified) = info["unifiedWindows"].as_object() {
                    unified.iter().filter_map(|(name, window)| Some(LimitWindow {
                        kind: kind(name),
                        used_percent: (window["utilization"].as_f64()? * 100.0).clamp(0.0, 100.0),
                        resets_at: window["resetsAt"].as_i64(),
                    })).collect()
                } else {
                    info["rateLimitType"].as_str().map(|name| LimitWindow {
                        kind: kind(name),
                        // Older events provide only the active limit and status, not utilization.
                        used_percent: info["utilization"].as_f64().map(|u| u * 100.0)
                            .unwrap_or(if info["status"] == "rejected" { 100.0 } else { 0.0 }).clamp(0.0, 100.0),
                        resets_at: info["resetsAt"].as_i64(),
                    }).into_iter().collect()
                };
                vec![AgentEvent::RateLimits(RateLimits {
                    agent: AgentKind::Claude, windows, status: info["status"].as_str().map(String::from),
                })]
            }
            Some("system") if v["subtype"] == "init" => {
                self.reset_tasks();
                self.model = v["model"].as_str().map(String::from);
                vec![AgentEvent::SessionStarted {
                    session_id: v["session_id"].as_str().unwrap_or_default().to_string(),
                    model: self.model.clone(),
                }]
            }
            Some("system") if v["subtype"] == "compact_boundary" => {
                let had_tasks = !self.tasks.is_empty();
                self.reset_tasks();
                self.compacted = Some(v["compact_metadata"]["post_tokens"].as_u64().unwrap_or(0));
                if had_tasks { vec![self.task_plan()] } else { vec![] }
            }
            Some("stream_event") => {
                let ev = &v["event"];
                let index = ev["index"].as_u64();
                match ev["type"].as_str() {
                    Some("message_start" | "message_stop") => self.tool_blocks.clear(),
                    Some("content_block_start") => {
                        if let Some(index) = index {
                            self.tool_blocks.remove(&index);
                            let b = &ev["content_block"];
                            if b["type"] == "tool_use" {
                                if let (Some(id), Some(name)) = (b["id"].as_str(), b["name"].as_str()) {
                                    if matches!(name, "Write" | "Edit" | "MultiEdit" | "NotebookEdit") {
                                        self.tool_blocks.insert(index, ToolBlock {
                                            id: id.into(), name: name.into(), buffer: String::new(), emitted_bytes: 0,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    Some("content_block_delta") if ev["delta"]["type"] == "input_json_delta" => {
                        if let Some(block) = index.and_then(|i| self.tool_blocks.get_mut(&i)) {
                            let fragment = ev["delta"]["partial_json"].as_str().unwrap_or_default();
                            block.buffer.push_str(fragment);
                            if block.buffer.len() - block.emitted_bytes >= 40 || fragment.contains("\\n") {
                                block.emitted_bytes = block.buffer.len();
                                return vec![block.draft(partial_json_value(&block.buffer))];
                            }
                        }
                    }
                    Some("content_block_stop") => {
                        if let Some(block) = index.and_then(|i| self.tool_blocks.remove(&i)) {
                            if let Ok(input) = serde_json::from_str(&block.buffer) {
                                return vec![block.draft(input)];
                            }
                        }
                    }
                    _ => {}
                }
                if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                    let text = ev["delta"]["text"].as_str().unwrap_or_default();
                    return vec![AgentEvent::TextDelta { text: text.to_string() }];
                }
                vec![]
            }
            Some("assistant") => {
                let u = &v["message"]["usage"];
                if u.is_object() {
                    let n = |k: &str| u[k].as_u64().unwrap_or(0);
                    self.last_context =
                        Some(n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens"));
                }
                let mut events: Vec<_> = content(&v)
                    .iter()
                    .filter_map(|block| match block["type"].as_str()? {
                        "text" => Some(AgentEvent::Message { text: block["text"].as_str()?.to_string() }),
                        "tool_use" => Some(AgentEvent::ToolCall {
                            id: block["id"].as_str()?.to_string(),
                            name: block["name"].as_str()?.to_string(),
                            input: block["input"].clone(),
                        }),
                        _ => None,
                    })
                    .collect();
                for block in content(&v) {
                    if block["type"] == "tool_use" && matches!(block["name"].as_str(), Some("TaskCreate" | "TaskUpdate")) {
                        if let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str()) {
                            self.task_calls.insert(id.into(), (name.into(), block["input"].clone()));
                        }
                    }
                    if block["type"] == "tool_use" && block["name"] == "TodoWrite" {
                        if let Some(todos) = block["input"]["todos"].as_array() {
                            let items = todos.iter().filter_map(|todo| {
                                let status = match todo["status"].as_str()? {
                                    "pending" => super::PlanStatus::Pending,
                                    "in_progress" => super::PlanStatus::InProgress,
                                    "completed" => super::PlanStatus::Done,
                                    _ => return None,
                                };
                                let text = if status == super::PlanStatus::InProgress {
                                    todo["activeForm"].as_str().or_else(|| todo["content"].as_str())?
                                } else {
                                    todo["content"].as_str()?
                                };
                                Some(super::PlanItem { text: text.into(), status })
                            }).collect();
                            events.push(AgentEvent::Plan { items, explanation: None });
                        }
                    }
                }
                events
            }
            Some("user") => {
                let mut events = Vec::new();
                for b in content(&v).iter().filter(|b| b["type"] == "tool_result") {
                    events.push(AgentEvent::ToolResult {
                        id: b["tool_use_id"].as_str().unwrap_or_default().to_string(),
                        output: tool_result_text(&b["content"]),
                        is_error: b["is_error"].as_bool().unwrap_or(false),
                        images: tool_result_images(&b["content"]),
                    });
                    if let Some(plan) = self.task_result(b, &v["tool_use_result"]) {
                        events.push(plan);
                    }
                }
                events
            }
            Some("result") => {
                self.tool_blocks.clear();
                let is_error = v["is_error"].as_bool().unwrap_or(false) || v["subtype"] != "success";
                let mut out = Vec::new();
                if let Some(usage) = self.usage(&v) {
                    out.push(usage);
                }
                out.push(AgentEvent::TurnCompleted {
                    duration_ms: v["duration_ms"].as_u64(),
                    cost_usd: v["total_cost_usd"].as_f64(),
                    is_error,
                    error: is_error.then(|| v["result"].as_str().unwrap_or("turn failed").to_string()),
                    interrupted: false,
                });
                out
            }
            _ => vec![],
        }
    }

    /// `Usage` for a `result` line, consuming this turn's tracked context state.
    fn usage(&mut self, v: &Value) -> Option<AgentEvent> {
        let context_tokens = self.last_context.take().or(self.compacted);
        self.compacted = None;
        let u = &v["usage"];
        let n = |k: &str| u[k].as_u64().unwrap_or(0);
        let (input_tokens, output_tokens) = (n("input_tokens"), n("output_tokens"));
        let (cache_read_tokens, cache_write_tokens) = (n("cache_read_input_tokens"), n("cache_creation_input_tokens"));
        let cost_usd = v["total_cost_usd"].as_f64();
        if input_tokens + output_tokens + cache_read_tokens + cache_write_tokens == 0 && cost_usd.is_none() {
            return None;
        }
        // modelUsage is keyed by model; prefer the session's model, else the first entry.
        let models = v["modelUsage"].as_object();
        let entry = models.and_then(|m| self.model.as_ref().and_then(|k| m.get(k)).or_else(|| m.values().next()));
        let model = self.model.clone().or_else(|| models.and_then(|m| m.keys().next().cloned()));
        Some(AgentEvent::Usage {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            context_tokens,
            context_window: entry.and_then(|e| e["contextWindow"].as_u64()),
            cost_usd,
            model,
        })
    }
}

/// Repair a JSON prefix without inventing keys or values. Only value strings may be
/// completed; unfinished object members are discarded. All repaired tokens still
/// go through serde_json, including escape and Unicode validation.
pub fn partial_json_value(s: &str) -> Value {
    struct Prefix<'a> { s: &'a str, pos: usize }
    impl Prefix<'_> {
        fn peek(&mut self) -> Option<u8> {
            while self.s.as_bytes().get(self.pos).is_some_and(u8::is_ascii_whitespace) {
                self.pos += 1;
            }
            self.s.as_bytes().get(self.pos).copied()
        }

        fn string(&mut self, key: bool) -> Option<String> {
            let start = self.pos;
            self.pos += 1;
            let mut escaped = false;
            while let Some(&b) = self.s.as_bytes().get(self.pos) {
                self.pos += 1;
                if escaped { escaped = false; }
                else if b == b'\\' { escaped = true; }
                else if b == b'"' {
                    let token = &self.s[start..self.pos];
                    return serde_json::from_str::<Value>(token).ok().map(|_| token.to_string());
                }
            }
            if key { return None; }
            // Longest valid string prefix: drops a dangling backslash, partial
            // Unicode escape, or a high surrogate awaiting its low surrogate.
            let mut end = self.pos;
            loop {
                let token = format!("{}\"", &self.s[start..end]);
                if serde_json::from_str::<Value>(&token).is_ok() { return Some(token); }
                if end <= start + 1 { return None; }
                end -= 1;
                while !self.s.is_char_boundary(end) { end -= 1; }
            }
        }

        fn value(&mut self, depth: usize) -> Option<String> {
            if depth > 128 { return None; }
            match self.peek()? {
                b'"' => self.string(false),
                b'{' | b'[' => {
                    let object = self.s.as_bytes()[self.pos] == b'{';
                    self.pos += 1;
                    let close = if object { b'}' } else { b']' };
                    let mut members = Vec::new();
                    loop {
                        match self.peek() {
                            Some(b) if b == close => { self.pos += 1; break; }
                            None => break,
                            _ => {}
                        }
                        let key = if object {
                            if self.peek() != Some(b'"') { break; }
                            let Some(key) = self.string(true) else { break; };
                            if self.peek() != Some(b':') { break; }
                            self.pos += 1;
                            Some(key)
                        } else { None };
                        let Some(value) = self.value(depth + 1) else { break; };
                        members.push(match key {
                            Some(key) => format!("{key}:{value}"),
                            None => value,
                        });
                        if self.peek() != Some(b',') {
                            if self.peek() == Some(close) { self.pos += 1; }
                            break;
                        }
                        self.pos += 1;
                    }
                    let (open, close) = if object { ('{', '}') } else { ('[', ']') };
                    Some(format!("{open}{}{close}", members.join(",")))
                }
                _ => {
                    let start = self.pos;
                    while self.s.as_bytes().get(self.pos).is_some_and(|b| !b.is_ascii_whitespace() && !b",]}".contains(b)) {
                        self.pos += 1;
                    }
                    let token = &self.s[start..self.pos];
                    // Preserve the longest complete primitive prefix, if any.
                    (1..=token.len()).rev().filter(|&n| token.is_char_boundary(n))
                        .find_map(|n| serde_json::from_str::<Value>(&token[..n]).ok().map(|_| token[..n].to_string()))
                }
            }
        }
    }
    if let Ok(value) = serde_json::from_str(s) { return value; }
    Prefix { s, pos: 0 }.value(0)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
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
    if cfg.readonly {
        let scratch = scratch_dir()?;
        std::fs::create_dir_all(&scratch)
            .map_err(|e| anyhow::anyhow!("could not create Claude scratch folder {}: {e}", scratch.display()))?;
    }
    let mut cmd = process::command("claude", &args(&cfg), &cfg.cwd)?;
    for (k, v) in local_env(&cfg) {
        cmd.env(k, v);
    }
    let mut child = process::spawn(&mut cmd)?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let interrupt_pending = Arc::new(AtomicBool::new(false));
    let out_sink = sink.clone();
    let pending = interrupt_pending.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut parser = ClaudeParser::default();
        while let Ok(Some(line)) = lines.next_line().await {
            for ev in parser.parse(&line) {
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
                        Some(Command::User { text, images }) => {
                            let (loaded, errors) = crate::images::load_base64(&images);
                            for message in errors {
                                sink(AgentEvent::Error { message });
                            }
                            user_line_with_images(&text, &loaded)
                        }
                        Some(Command::Compact) => user_line("/compact"),
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

    #[test]
    fn user_line_with_images_orders_images_before_text() {
        let imgs = vec![("image/png".to_string(), "AAAA".to_string())];
        let v: Value = serde_json::from_str(&user_line_with_images("what is this?", &imgs)).unwrap();
        let c = v["message"]["content"].as_array().unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0], json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}));
        assert_eq!(c[1], json!({"type":"text","text":"what is this?"}));
        // images only: no empty text block
        let v: Value = serde_json::from_str(&user_line_with_images("", &imgs)).unwrap();
        assert_eq!(v["message"]["content"].as_array().unwrap().len(), 1);
        // plain text unchanged
        let v: Value = serde_json::from_str(&user_line("hi")).unwrap();
        assert_eq!(v["message"]["content"], json!([{"type":"text","text":"hi"}]));
    }

    #[test]
    fn tool_result_with_image_block() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}},{"type":"text","text":"ok"}]}]}}"#;
        let evs = parse_line(line);
        assert_eq!(evs, vec![AgentEvent::ToolResult {
            id: "toolu_9".into(),
            output: "ok".into(),
            is_error: false,
            images: vec![ImageRef { path: String::new(), media_type: "image/png".into(), data: Some("iVBORw0KGgo=".into()) }],
        }]);
    }

    #[test]
    fn partial_json_truncated_members_and_containers() {
        for (source, expected) in [
            ("", json!({})),
            ("{", json!({})),
            (r#"{"file_pa"#, json!({})),
            (r#"{"a":1,"file_path""#, json!({"a":1})),
            (r#"{"a":1,"file_path": "#, json!({"a":1})),
            (r#"{"content":"hello"#, json!({"content":"hello"})),
            (r#"{"a":1,"b":tru"#, json!({"a":1})),
            (r#"{"edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_str"#,
             json!({"edits":[{"old_string":"a","new_string":"b"},{"old_string":"c"}]})),
            (r#"{"edits":[{"old_string":"a","new_string":"b"},"#, json!({"edits":[{"old_string":"a","new_string":"b"}]})),
            (r#"{"edits":[{"old_string":"a","new_string":"b"#, json!({"edits":[{"old_string":"a","new_string":"b"}]})),
            (r#"{"a":1,"broken":???}"#, json!({"a":1})),
        ] {
            assert_eq!(partial_json_value(source), expected, "{source:?}");
        }
    }

    #[test]
    fn partial_json_escapes_windows_paths_and_unicode() {
        for (source, expected) in [
            (r#"{"s":"a\"#, "a"),
            (r#"{"s":"a\n"#, "a\n"),
            (r#"{"s":"a\\"#, "a\\"),
            (r#"{"s":"a\""#, "a\""),
            (r#"{"s":"a\u00"#, "a"),
            (r#"{"s":"a\u0041"#, "aA"),
            (r#"{"s":"a\uD83D\uDE"#, "a"),
            (r#"{"s":"a\uD83D\uDE80"#, "a🚀"),
            (r#"{"s":"C:\\Users\\you\\poem.txt"#, r"C:\Users\you\poem.txt"),
            (r#"{"s":"你好 café 🚀"#, "你好 café 🚀"),
        ] {
            assert_eq!(partial_json_value(source), json!({"s":expected}), "{source:?}");
        }
    }

    #[test]
    fn partial_json_every_string_prefix_is_monotonic() {
        let input = json!({"content": "line\nquote \" slash \\ café 你好 🚀"});
        let source = input.to_string();
        let mut previous = String::new();
        for end in (0..=source.len()).filter(|&end| source.is_char_boundary(end)) {
            let value = partial_json_value(&source[..end]);
            let content = value["content"].as_str().unwrap_or_default();
            assert!(content.starts_with(&previous), "{end}: {value}");
            assert!(input["content"].as_str().unwrap().starts_with(content));
            previous = content.into();
        }
        assert_eq!(partial_json_value(&source), input);
    }

    #[test]
    fn real_streamed_write_edit_drafts_preserve_existing_events() {
        let source = include_str!("../../tests/fixtures/claude_streamed_write_edit.jsonl");
        let mut parser = ClaudeParser::default();
        let events: Vec<_> = source.lines().flat_map(|line| parser.parse(line)).collect();
        // Removing the new previews must leave exactly the old, stateless parser output,
        // including text, calls, results, completion and the stateful usage context.
        let mut baseline = ClaudeParser::default();
        let original: Vec<_> = source.lines().filter(|line| {
            let v: Value = serde_json::from_str(line).unwrap();
            v["type"] != "stream_event" || v["event"]["delta"]["type"] == "text_delta"
        }).flat_map(|line| baseline.parse(line)).collect();
        assert_eq!(events.iter().filter(|e| !matches!(e, AgentEvent::ToolDraft { .. })).cloned().collect::<Vec<_>>(), original);
        for name in ["Write", "Edit"] {
            let (id, input) = events.iter().find_map(|e| match e {
                AgentEvent::ToolCall { id, name: n, input } if n == name => Some((id, input)),
                _ => None,
            }).unwrap();
            let drafts: Vec<_> = events.iter().filter_map(|e| match e {
                AgentEvent::ToolDraft { id: draft_id, name: n, input } if n == name => {
                    assert_eq!(draft_id, id);
                    assert!(!e.is_persistent());
                    Some(input)
                }
                _ => None,
            }).collect();
            assert!(drafts.len() >= 2);
            for draft in drafts.iter().skip(2) {
                assert_eq!(draft["file_path"], input["file_path"]);
            }
            if name == "Write" {
                let mut previous = "";
                for draft in &drafts {
                    let content = draft["content"].as_str().unwrap_or_default();
                    assert!(content.starts_with(previous));
                    previous = content;
                }
                assert_eq!(*drafts.last().unwrap(), input);
            }
        }
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::ToolDraft { name, .. } if name == "Read")));
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::ToolCall { .. })).count(), 3);
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::ToolResult { .. })).count(), 3);
        assert!(events.iter().any(|e| matches!(e, AgentEvent::TextDelta { .. })));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Usage { .. })));
        assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { is_error: false, .. })));
    }

    #[test]
    fn tool_draft_throttling_indices_and_cleanup() {
        let mut p = ClaudeParser::default();
        let mut event = |ev: Value| p.parse(&json!({"type":"stream_event","event":ev}).to_string());
        for (index, name) in [(0, "Write"), (1, "NotebookEdit"), (2, "MultiEdit"), (3, "Read")] {
            assert!(event(json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":format!("t{index}"),"name":name,"input":{}}})).is_empty());
        }
        let delta = |index, fragment: &str| json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":fragment}});
        let first = format!("{{\"content\":\"{}", "a".repeat(28)); // exactly 40 bytes
        assert!(event(delta(0, &first[..39])).is_empty());
        assert!(matches!(event(delta(0, &first[39..])).as_slice(), [AgentEvent::ToolDraft { id, .. }] if id == "t0"));
        assert!(event(delta(0, "b")).is_empty());
        assert_eq!(event(delta(0, r"\n")).len(), 1);
        for index in [1, 2] {
            assert_eq!(event(delta(index, r#"{"text":"hi\n"#)).len(), 1);
        }
        assert!(event(delta(3, &first)).is_empty());
        assert!(event(json!({"type":"content_block_stop","index":0})).is_empty()); // invalid/incomplete input
        assert!(event(delta(0, &first)).is_empty()); // forgotten
        assert!(event(delta(1, r#""}"#)).is_empty());
        assert_eq!(event(json!({"type":"content_block_stop","index":1})).len(), 1);
        event(json!({"type":"message_start"}));
        assert!(event(delta(2, &first)).is_empty());
    }

    fn parse_fixture(name: &str) -> Vec<AgentEvent> {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        let mut parser = ClaudeParser::default();
        std::fs::read_to_string(path).unwrap().lines().flat_map(|l| parser.parse(l)).collect()
    }

    #[test]
    fn real_turn_reports_plan_rate_limits() {
        let events = parse_fixture("claude_real_turn.jsonl");
        let limits: Vec<_> = events.iter().filter_map(|ev| match ev {
            AgentEvent::RateLimits(limits) => Some(limits),
            _ => None,
        }).collect();
        assert_eq!(limits.len(), 1);
        assert_eq!(limits[0], &RateLimits {
            agent: AgentKind::Claude,
            windows: vec![
                LimitWindow { kind: "fiveHour".into(), used_percent: 13.0, resets_at: Some(1791520200) },
                LimitWindow { kind: "weekly".into(), used_percent: 6.0, resets_at: Some(1791594000) },
            ],
            status: Some("allowed".into()),
        });
    }

    #[test]
    fn rate_limits_fallback_unknown_windows_and_bounds() {
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"seven_day","resetsAt":123}}"#;
        let ev = parse_line(line).remove(0);
        assert!(matches!(ev, AgentEvent::RateLimits(RateLimits { windows, .. })
            if windows == vec![LimitWindow { kind: "weekly".into(), used_percent: 100.0, resets_at: Some(123) }]));
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"extra":{"utilization":1.2},"bad":{},"five_hour":{"utilization":-0.1}}}}"#;
        let events = parse_line(line);
        let AgentEvent::RateLimits(limits) = &events[0] else { panic!("rate limits"); };
        assert_eq!(limits.windows, vec![
            LimitWindow { kind: "extra".into(), used_percent: 100.0, resets_at: None },
            LimitWindow { kind: "fiveHour".into(), used_percent: 0.0, resets_at: None },
        ]);
        assert_eq!(limits.status, None);
    }

    #[test]
    fn recorded_task_tools_emit_ordered_plans() {
        let events = parse_fixture("claude_task_tools.jsonl");
        let plans: Vec<_> = events.iter().filter_map(|event| match event {
            AgentEvent::Plan { items, explanation } => {
                assert_eq!(*explanation, None);
                Some(items)
            }
            _ => None,
        }).collect();
        assert_eq!(plans.len(), 9, "three creates and six status changes");
        let final_plan = plans.last().unwrap();
        assert_eq!(final_plan.len(), 3);
        for (index, item) in final_plan.iter().enumerate() {
            assert_eq!(item.text, format!("Step {}: Say hello", index + 1));
            assert_eq!(item.status, super::super::PlanStatus::Done);
        }
        assert!(plans.iter().any(|items| items.iter().any(|item|
            item.status == super::super::PlanStatus::InProgress && item.text == "Saying hello (step 1)")));
        assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolCall { name, .. } if name == "TaskCreate")));
        assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolResult { is_error: false, .. })));
        assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { is_error: false, .. })));
    }

    fn task_call(parser: &mut ClaudeParser, id: &str, name: &str, input: Value) -> Vec<AgentEvent> {
        parser.parse(&json!({"type":"assistant","message":{"content":[{
            "type":"tool_use","id":id,"name":name,"input":input
        }]}}).to_string())
    }

    fn task_reply(parser: &mut ClaudeParser, id: &str, text: &str, result: Value, error: bool) -> Vec<AgentEvent> {
        parser.parse(&json!({"type":"user","tool_use_result":result,"message":{"content":[{
            "type":"tool_result","tool_use_id":id,"content":text,"is_error":error
        }]}}).to_string())
    }

    #[test]
    fn task_results_match_calls_and_handle_failures_edits_and_deletion() {
        let mut p = ClaudeParser::default();
        task_call(&mut p, "a", "TaskCreate", json!({"subject":"First","activeForm":"Working"}));
        task_call(&mut p, "b", "TaskCreate", json!({"subject":"Second"}));
        // Results can arrive in a different order from calls; subjects stay matched to their ids.
        task_reply(&mut p, "b", "Task #2 created successfully: Second", Value::Null, false);
        task_reply(&mut p, "a", "ok", json!({"task":{"id":"1"}}), false);
        assert_eq!(p.tasks["1"].subject, "First");
        assert_eq!(p.tasks["2"].subject, "Second");
        assert_eq!(p.task_order, vec!["2", "1"]);
        task_call(&mut p, "failed", "TaskUpdate", json!({"taskId":"1","status":"completed"}));
        assert_eq!(task_reply(&mut p, "failed", "failed", Value::Null, true).len(), 1);
        assert_eq!(p.tasks["1"].status, super::super::PlanStatus::Pending);
        task_call(&mut p, "failed-create", "TaskCreate", json!({"subject":"Bad"}));
        task_reply(&mut p, "failed-create", "failed", json!({"success":false}), false);
        assert_eq!(p.tasks.len(), 2);
        task_call(&mut p, "update", "TaskUpdate", json!({"taskId":"2","subject":"Revised","status":"in_progress"}));
        task_reply(&mut p, "update", "ok", Value::Null, false);
        let AgentEvent::Plan { items, .. } = p.task_plan() else { panic!("plan"); };
        assert_eq!(items[0].text, "Revised", "missing activeForm falls back to subject");
        task_call(&mut p, "pending", "TaskUpdate", json!({"taskId":"2","status":"pending"}));
        task_reply(&mut p, "pending", "ok", Value::Null, false);
        assert_eq!(p.tasks["2"].status, super::super::PlanStatus::Pending);
        task_call(&mut p, "delete", "TaskUpdate", json!({"taskId":"1","status":"deleted"}));
        assert_eq!(task_reply(&mut p, "delete", "ok", Value::Null, false).len(), 2);
        assert!(!p.tasks.contains_key("1"));
        assert_eq!(p.task_order, vec!["2"]);
        assert_eq!(task_reply(&mut p, "delete", "ok", Value::Null, false).len(), 1, "duplicate result ignored");
    }

    #[test]
    fn task_state_resets_on_compact_and_session_init() {
        let mut p = ClaudeParser::default();
        for reset in [
            json!({"type":"system","subtype":"compact_boundary"}),
            json!({"type":"system","subtype":"init","session_id":"new"}),
        ] {
            task_call(&mut p, "create", "TaskCreate", json!({"subject":"Old"}));
            task_reply(&mut p, "create", "ok", json!({"task":{"id":"1"}}), false);
            task_call(&mut p, "late", "TaskCreate", json!({"subject":"Late"}));
            p.parse(&reset.to_string());
            assert!(p.tasks.is_empty() && p.task_order.is_empty() && p.task_calls.is_empty());
            assert_eq!(task_reply(&mut p, "late", "ok", json!({"task":{"id":"2"}}), false).len(), 1);
        }
    }

    #[test]
    fn todo_write_normalizes_plan_and_keeps_tool_calls() {
        // Synthetic: no recorded fixture contains TodoWrite. Input follows Claude's
        // documented input: https://code.claude.com/docs/en/agent-sdk/python#todowrite
        let events = parse_fixture("claude_todo_synthetic.jsonl");
        assert_eq!(events.len(), 4);
        assert!(matches!(&events[0], AgentEvent::ToolCall { id, name, input }
            if id == "todo-1" && name == "TodoWrite" && input["todos"].as_array().unwrap().len() == 3));
        assert_eq!(serde_json::to_value(&events[1]).unwrap(), json!({
            "type":"plan", "explanation":null, "items":[
                {"text":"Inspect code","status":"done"},
                {"text":"Writing tests","status":"inProgress"},
                {"text":"Run checks","status":"pending"}
            ]
        }));
        assert!(matches!(&events[2], AgentEvent::ToolCall { name, .. } if name == "TodoWrite"));
        assert_eq!(events[3], AgentEvent::Plan { items: vec![], explanation: None });
        assert!(events[1].is_persistent());
        let wire = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(serde_json::from_value::<AgentEvent>(wire).unwrap(), events[1]);
        let mut nested: Value = serde_json::from_str(include_str!("../../tests/fixtures/claude_todo_synthetic.jsonl").lines().next().unwrap()).unwrap();
        nested["parent_tool_use_id"] = json!("parent");
        assert!(parse_line(&nested.to_string()).is_empty());
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
            is_error: false,
            images: vec![]
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
            permission_mode: "bypassPermissions".into(),
            sandbox: "danger-full-access".into(),
            mcp_servers: vec![], mcp_config: None, local_url: None,
        };
        let handle = super::super::spawn(cfg, 0, std::sync::Arc::new(move |ev| {
            let _ = tx.send(ev);
        }))
        .unwrap();
        handle.send(Command::User { text: "Reply with the single word: pong".into(), images: vec![] });
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

    /// Sends a red PNG to the real `claude` binary and expects it to name the colour:
    /// `cargo test -- --ignored live_claude_image_attachment`.
    #[tokio::test]
    #[ignore]
    async fn live_claude_image_attachment() {
        use base64::Engine;
        let dir = std::env::temp_dir().join("orbit_claude_image_attachment");
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("red.png");
        std::fs::write(&png, base64::engine::general_purpose::STANDARD.decode(crate::images::RED_PNG_B64).unwrap()).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cfg = SessionConfig { kind: super::super::AgentKind::Claude, cwd: dir, model: Some("haiku".into()), resume: None, plugin_dirs: vec![], add_dirs: vec![], instructions: None, readonly: false, permission_mode: "bypassPermissions".into(), sandbox: "danger-full-access".into(), mcp_servers: vec![], mcp_config: None, local_url: None };
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
    fn real_turn_usage_uses_last_message_for_context() {
        let evs = parse_fixture("claude_real_turn.jsonl");
        let i = evs.iter().position(|e| matches!(e, AgentEvent::Usage { .. })).expect("usage event");
        // Turn totals come from `result.usage`; context is the LAST assistant message
        // (2 + 24278 read + 2659 written), not the sum over the turn's API calls.
        assert_eq!(
            evs[i],
            AgentEvent::Usage {
                input_tokens: 4,
                output_tokens: 395,
                cache_read_tokens: 37963,
                cache_write_tokens: 13252,
                context_tokens: Some(2 + 24278 + 2659),
                context_window: Some(1_000_000),
                cost_usd: Some(0.00322793),
                model: Some("claude-haiku-5-5".into()),
            }
        );
        // Usage precedes the turn's TurnCompleted.
        assert!(matches!(evs[i + 1], AgentEvent::TurnCompleted { .. }));
    }

    #[test]
    fn real_compact_drops_context_to_post_tokens() {
        // Recorded from claude 2.1.x: one turn, then `/compact` (pre 24871 -> post 2266 tokens).
        let path = format!("{}/tests/fixtures/claude_compact.jsonl", env!("CARGO_MANIFEST_DIR"));
        let mut p = ClaudeParser::default();
        let usages: Vec<Option<u64>> = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .flat_map(|l| p.parse(l))
            .filter_map(|e| match e {
                AgentEvent::Usage { context_tokens, .. } => Some(context_tokens),
                _ => None,
            })
            .collect();
        assert_eq!(usages.len(), 2, "one Usage per result line");
        assert!(usages[0].is_some_and(|t| t > 20_000), "first turn carries the full context: {usages:?}");
        assert_eq!(usages[1], Some(2266), "after /compact the context is the boundary's post_tokens");
    }

    #[test]
    fn compact_boundary_resets_context_when_no_assistant_message() {
        let mut p = ClaudeParser::default();
        p.parse(r#"{"type":"system","subtype":"compact_boundary","compact_metadata":{"post_tokens":4200}}"#);
        let evs = p.parse(
            r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5}}"#,
        );
        assert!(matches!(evs[0], AgentEvent::Usage { context_tokens: Some(4200), .. }));
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
            permission_mode: "bypassPermissions".into(),
            sandbox: "danger-full-access".into(),
            mcp_servers: vec![], mcp_config: Some("/mcp/workspace.json".into()), local_url: None,
        };
        let rw = args(&cfg).join(" ");
        assert!(args(&cfg).windows(2).any(|pair| pair == ["--tools", SESSION_TOOLS]));
        // Check the actual argv value: `default,TaskCreate,...` silently removes built-ins.
        let built_args = args(&cfg);
        let tools = &built_args.windows(2).find(|pair| pair[0] == "--tools").unwrap()[1];
        for tool in ["Read", "Edit", "Bash", "TaskCreate"] {
            assert!(tools.split(',').any(|available| available == tool), "missing {tool}");
        }
        assert!(!tools.contains("default,"));
        assert!(!rw.contains("--disallowedTools") && rw.contains("--permission-mode bypassPermissions"));
        let cfg = SessionConfig { permission_mode: "acceptEdits".into(), ..cfg };
        assert!(args(&cfg).join(" ").contains("--permission-mode acceptEdits"));
        let cfg = SessionConfig { readonly: true, ..cfg };
        let a = args(&cfg).join(" ");
        // Read-only: default mode enforces the allowlist, with only scoped scratch writes.
        assert!(a.contains("--permission-mode default") && !a.contains("bypassPermissions"));
        assert!(args(&cfg).iter().any(|x| x == READONLY_ALLOW), "allowlist must be one argv entry");
        assert!(args(&cfg).windows(2).any(|pair| pair == ["--tools", SESSION_TOOLS]));
        for tool in ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] {
            assert!(READONLY_ALLOW.split(',').any(|allowed| allowed == tool));
        }
        assert!(a.contains("--disallowedTools NotebookEdit --append-system-prompt"));
        assert!(a.contains("--mcp-config /mcp/workspace.json"));
        assert!(!a.contains("--strict-mcp-config"));
        assert!(a.contains("--model opus"));
        assert!(a.contains("--resume abc"));
        assert!(a.contains("--plugin-dir /packs/ecc"));
        assert!(a.contains("--add-dir /code/shared-ui --add-dir /code/api"));
        assert!(a.ends_with("--append-system-prompt ctx"));
        assert!(local_env(&cfg).is_empty());
        // A local model drops the prefix from --model and points Claude at Ollama.
        let cfg = SessionConfig { model: Some("local:qwen3:8b".into()), local_url: Some("http://localhost:11434".into()), ..cfg };
        assert!(args(&cfg).join(" ").contains("--model qwen3:8b"));
        let env = local_env(&cfg);
        assert!(env.contains(&("ANTHROPIC_BASE_URL", "http://localhost:11434".to_string())));
        assert!(env.contains(&("ANTHROPIC_AUTH_TOKEN", "ollama".to_string())));
    }

    #[test]
    fn readonly_file_permissions_are_scoped_to_scratch() {
        let allow: Vec<_> = READONLY_ALLOW.split(',').collect();
        assert!(allow.contains(&"Edit(~/.orbit/tmp/**)"));
        for tool in ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"] {
            assert!(!allow.contains(&tool), "must not allow unrestricted {tool}");
        }
        assert_eq!(READONLY_DENY, "NotebookEdit", "blanket edit denies override the scoped allow");
        assert!(allow.contains(&"Bash(gh issue create:*)"));
    }
}
