//! Agent layer: every supported CLI agent is driven over stdio and its output is
//! normalized into `AgentEvent`s, so the rest of the app never sees agent-specific shapes.

pub mod claude;
pub mod codex;
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
    Error { message: String },
    Exited { code: Option<i32>, stderr: String },
}

impl AgentEvent {
    /// Deltas are only useful live; the final `Message` replaces them in history.
    pub fn is_persistent(&self) -> bool {
        !matches!(self, AgentEvent::TextDelta { .. })
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
    /// Read-only role: the agent may not edit files (Claude file tools denied, Codex sandboxed).
    pub readonly: bool,
    /// Claude permission mode for non-readonly sessions (`bypassPermissions` | `acceptEdits`).
    pub permission_mode: String,
    /// Codex sandbox for non-readonly sessions (`danger-full-access` | `workspace-write`).
    pub sandbox: String,
}

pub enum Command {
    User(String),
    Interrupt,
    Shutdown,
}

pub type EventSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

#[derive(Clone)]
pub struct SessionHandle {
    tx: mpsc::UnboundedSender<Command>,
}

impl SessionHandle {
    /// Returns false if the session task has already exited.
    pub fn send(&self, cmd: Command) -> bool {
        self.tx.send(cmd).is_ok()
    }
}

pub fn spawn(cfg: SessionConfig, sink: EventSink) -> anyhow::Result<SessionHandle> {
    let (tx, rx) = mpsc::unbounded_channel();
    match cfg.kind {
        AgentKind::Claude => claude::spawn(cfg, sink, rx)?,
        AgentKind::Codex => codex::spawn(cfg, sink, rx)?,
    }
    Ok(SessionHandle { tx })
}

/// Keeps the last few stderr lines for error reporting on exit.
pub(crate) fn push_tail(tail: &mut Vec<String>, line: String) {
    tail.push(line);
    if tail.len() > 20 {
        tail.remove(0);
    }
}
