//! Agent layer: every supported CLI agent is driven over stdio and its output is
//! normalized into `AgentEvent`s, so the rest of the app never sees agent-specific shapes.

pub mod claude;
pub mod codex;
pub mod job;
pub mod process;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
}

/// Normalized event stream shared by all agents. Persisted (except deltas) and sent to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    SessionStarted { session_id: String, model: Option<String> },
    /// What the user typed. When sent via a skill, `text` holds the skill's arguments.
    UserMessage {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skill: Option<String>,
    },
    TurnStarted,
    TextDelta { text: String },
    Message { text: String },
    ToolCall { id: String, name: String, input: Value },
    /// Live tool input; the final ToolCall replaces it in history.
    ToolDraft { id: String, name: String, input: Value },
    ToolResult { id: String, output: String, is_error: bool },
    TurnCompleted {
        duration_ms: Option<u64>,
        cost_usd: Option<f64>,
        is_error: bool,
        error: Option<String>,
        /// The user stopped the turn; not an error.
        #[serde(default)]
        interrupted: bool,
    },
    /// Tokens and cost of the turn that just ended, plus how full the context window is.
    /// Emitted right before that turn's `TurnCompleted`.
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
        /// Current context size (what the next request will carry), not the turn total.
        context_tokens: Option<u64>,
        context_window: Option<u64>,
        cost_usd: Option<f64>,
        model: Option<String>,
    },
    /// The user started a fresh agent session in this workspace; earlier context is gone.
    SessionReset,
    Error { message: String },
    Exited { code: Option<i32>, stderr: String },
}

impl AgentEvent {
    /// Drafts and deltas are only useful live; final calls/messages replace them in history.
    pub fn is_persistent(&self) -> bool {
        !matches!(self, AgentEvent::TextDelta { .. } | AgentEvent::ToolDraft { .. })
    }
}

pub struct SessionConfig {
    pub kind: AgentKind,
    pub cwd: PathBuf,
    pub model: Option<String>,
    /// Agent-native session/thread id to resume.
    pub resume: Option<String>,
    /// Skill packs passed to Claude as `--plugin-dir`.
    pub plugin_dirs: Vec<PathBuf>,
    /// Extra folders the agent may access, passed to Claude as `--add-dir`.
    pub add_dirs: Vec<PathBuf>,
    /// Workspace context appended to the agent's system prompt.
    pub instructions: Option<String>,
    /// Read-only role: Claude may edit only scratch files; Codex uses a read-only sandbox.
    pub readonly: bool,
    /// Claude permission mode for non-readonly sessions (`bypassPermissions` | `acceptEdits`).
    pub permission_mode: String,
    /// Codex sandbox for non-readonly sessions (`danger-full-access` | `workspace-write`).
    pub sandbox: String,
    /// Ollama base URL, used only when `model` is a `local:<name>` model (experimental local agents).
    pub local_url: Option<String>,
}

/// Workspace models of the form `local:<name>` run the agent against a local Ollama server.
pub const LOCAL_MODEL_PREFIX: &str = "local:";

/// The Ollama model name if `model` selects a local model.
pub fn local_model(model: &str) -> Option<&str> {
    model.strip_prefix(LOCAL_MODEL_PREFIX).filter(|m| !m.is_empty())
}

pub enum Command {
    User(String),
    /// Summarise the conversation to free context. Claude takes the `/compact` slash command
    /// as a user message; Codex has a dedicated JSON-RPC method.
    Compact,
    Interrupt,
    Shutdown,
}

pub type EventSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

#[derive(Clone)]
pub struct SessionHandle {
    tx: mpsc::UnboundedSender<Command>,
    /// Distinguishes successive sessions of one workspace, so a late exit from an old process
    /// can't evict the session that replaced it.
    pub generation: u64,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Allocates the generation for the next `spawn` (callers need it before the sink exists).
pub fn next_generation() -> u64 {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

impl SessionHandle {
    /// Returns false if the session task has already exited.
    pub fn send(&self, cmd: Command) -> bool {
        self.tx.send(cmd).is_ok()
    }
}

pub fn spawn(cfg: SessionConfig, generation: u64, sink: EventSink) -> anyhow::Result<SessionHandle> {
    let (tx, rx) = mpsc::unbounded_channel();
    match cfg.kind {
        AgentKind::Claude => claude::spawn(cfg, sink, rx)?,
        AgentKind::Codex => codex::spawn(cfg, sink, rx)?,
    }
    Ok(SessionHandle { tx, generation })
}

/// Keeps the last few stderr lines for error reporting on exit.
pub(crate) fn push_tail(tail: &mut Vec<String>, line: String) {
    tail.push(line);
    if tail.len() > 20 {
        tail.remove(0);
    }
}
