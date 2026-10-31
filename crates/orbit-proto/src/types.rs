//! Wire types mirrored from `src-tauri` (db.rs, gh.rs, trunk.rs, skills.rs, git.rs) and
//! `src/lib/ipc.ts`. Plain serde structs, camelCase. Unknown fields are ignored and every
//! optional field has a default, so a newer app never breaks an older client.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub base_branch: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    #[default]
    Idle,
    Running,
    Done,
    Error,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub branch: String,
    pub path: String,
    /// `claude` or `codex`.
    pub agent: String,
    pub model: Option<String>,
    pub status: Status,
    pub issue_number: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub seen_seq: i64,
    pub dismissed_seq: i64,
    pub profile: Option<String>,
    pub snoozed_until: i64,
    pub checks_failed: bool,
    pub checks_command: Option<String>,
    pub checks_output: Option<String>,
    pub sync_conflicts: Vec<String>,
    pub behind: i64,
    pub ahead: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Summary {
    pub workspace_id: String,
    pub last_seq: i64,
    pub last_activity_ts: i64,
    pub last_turn_seq: i64,
    pub last_turn_error: Option<String>,
    pub last_turn_interrupted: bool,
    pub last_assistant_text: Option<String>,
    pub last_user_text: Option<String>,
    pub routine_name: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub repos: Vec<Repo>,
    pub workspaces: Vec<Workspace>,
    pub summaries: Vec<Summary>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageRef {
    pub path: String,
    pub media_type: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FileRef {
    pub path: String,
    pub name: String,
    pub media_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanItem {
    pub text: String,
    /// `pending` | `inProgress` | `done`
    pub status: String,
}

/// The normalized agent event (`AgentEvent` in `src-tauri/src/agent/mod.rs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    SessionStarted {
        #[serde(default)]
        session_id: String,
        #[serde(default)]
        model: Option<String>,
    },
    UserMessage {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skill: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<FileRef>,
    },
    TurnStarted,
    Plan {
        #[serde(default)]
        items: Vec<PlanItem>,
        #[serde(default)]
        explanation: Option<String>,
    },
    TextDelta {
        text: String,
    },
    Message {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        id: String,
        #[serde(default)]
        output: String,
        #[serde(default)]
        is_error: bool,
    },
    TurnCompleted {
        #[serde(default)]
        duration_ms: Option<u64>,
        #[serde(default)]
        cost_usd: Option<f64>,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        interrupted: bool,
    },
    Usage {
        #[serde(default)]
        input_tokens: u64,
        #[serde(default)]
        output_tokens: u64,
        #[serde(default)]
        cache_read_tokens: u64,
        #[serde(default)]
        cache_write_tokens: u64,
        #[serde(default)]
        context_tokens: Option<u64>,
        #[serde(default)]
        context_window: Option<u64>,
        #[serde(default)]
        cost_usd: Option<f64>,
        #[serde(default)]
        model: Option<String>,
    },
    SessionReset,
    Error {
        message: String,
    },
    Exited {
        #[serde(default)]
        code: Option<i64>,
        #[serde(default)]
        stderr: String,
    },
    /// `rateLimits`, `toolDraft` and anything newer: ignored by the TUI.
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    #[serde(default)]
    pub commit_sha: Option<String>,
    pub seq: i64,
    #[serde(default)]
    pub ts: i64,
    pub event: AgentEvent,
}

/// `{ t: "event", workspaceId, seq, ts, event }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPush {
    pub workspace_id: String,
    #[serde(default)]
    pub seq: Option<i64>,
    #[serde(default)]
    pub ts: i64,
    pub event: AgentEvent,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Skill {
    pub id: String,
    pub pack: String,
    /// `command` | `skill`
    pub kind: String,
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrChecks {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
    pub failing: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrStatus {
    pub number: i64,
    pub title: String,
    pub url: String,
    /// `OPEN` | `CLOSED` | `MERGED`
    pub state: String,
    pub is_draft: bool,
    pub mergeable: String,
    pub review_decision: String,
    pub checks: PrChecks,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckResult {
    pub ok: bool,
    /// `pass` | `fail` | `timedOut` | `installFailed`
    pub kind: String,
    pub command: String,
    pub output_tail: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrepareShip {
    pub ok: bool,
    pub checks: Option<CheckResult>,
    pub squashed: u32,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MergeOutcome {
    pub archived: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FileChange {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    pub untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    Base,
    Turn,
    Commit { sha: String },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    pub ts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub scope: Scope,
    #[serde(default)]
    pub old_ref: String,
    #[serde(default)]
    pub new_ref: String,
    #[serde(default)]
    pub files: Vec<FileChange>,
    #[serde(default)]
    pub commits: Vec<Commit>,
    #[serde(default)]
    pub turn_available: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FileAt {
    pub text: Option<String>,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    /// `old` | `new`
    pub side: String,
    pub text: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HelloSettings {
    pub stale_days: u32,
    pub stale_behind: u32,
    pub save_commits: bool,
}

impl Default for HelloSettings {
    fn default() -> Self {
        HelloSettings { stale_days: 7, stale_behind: 50, save_commits: true }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hello {
    pub settings: HelloSettings,
    pub version: String,
}

/// A frame the server pushes without being asked.
#[derive(Debug, Clone, PartialEq)]
pub enum Push {
    Event(EventPush),
    Workspace(Workspace),
    WorkspaceRemoved(String),
    Summary(Summary),
    Disconnected,
    Reconnected,
}

impl Push {
    /// Parses a plaintext server frame (`t: "event" | "workspace" | …`). `None` for anything else.
    pub fn from_frame(v: &Value) -> Option<Push> {
        match v.get("t")?.as_str()? {
            "event" => serde_json::from_value(v.clone()).ok().map(Push::Event),
            "workspace" => serde_json::from_value(v.get("workspace")?.clone()).ok().map(Push::Workspace),
            "workspace-removed" => Some(Push::WorkspaceRemoved(v.get("workspaceId")?.as_str()?.to_string())),
            "summary" => serde_json::from_value(v.get("summary")?.clone()).ok().map(Push::Summary),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn events_parse_and_unknown_is_other() {
        let e: AgentEvent =
            serde_json::from_value(json!({"type":"toolResult","id":"t1","output":"ok","isError":true})).unwrap();
        assert_eq!(e, AgentEvent::ToolResult { id: "t1".into(), output: "ok".into(), is_error: true });
        let e: AgentEvent = serde_json::from_value(json!({"type":"rateLimits","agent":"claude","windows":[]})).unwrap();
        assert_eq!(e, AgentEvent::Other);
        let e: AgentEvent = serde_json::from_value(
            json!({"type":"turnCompleted","durationMs":1200,"costUsd":null,"isError":false,"error":null}),
        )
        .unwrap();
        assert!(matches!(e, AgentEvent::TurnCompleted { duration_ms: Some(1200), interrupted: false, .. }));
        let e: AgentEvent = serde_json::from_value(json!({"type":"turnStarted"})).unwrap();
        assert_eq!(e, AgentEvent::TurnStarted);
    }

    #[test]
    fn workspace_tolerates_extra_and_missing_fields() {
        let w: Workspace = serde_json::from_value(
            json!({"id":"w1","name":"fix","status":"running","teammate":null,"disabledPacks":[]}),
        )
        .unwrap();
        assert_eq!(w.status, Status::Running);
        assert_eq!(w.sync_conflicts, Vec::<String>::new());
    }

    #[test]
    fn push_frames() {
        let p = Push::from_frame(
            &json!({"t":"event","workspaceId":"w","seq":null,"ts":1,"event":{"type":"textDelta","text":"hi"}}),
        )
        .unwrap();
        assert!(matches!(p, Push::Event(EventPush { seq: None, .. })));
        let p = Push::from_frame(&json!({"t":"workspace-removed","workspaceId":"w"})).unwrap();
        assert_eq!(p, Push::WorkspaceRemoved("w".into()));
        assert!(Push::from_frame(&json!({"t":"rpc-result"})).is_none());
    }

    #[test]
    fn scope_shape() {
        assert_eq!(
            serde_json::to_value(Scope::Commit { sha: "abc".into() }).unwrap(),
            json!({"kind":"commit","sha":"abc"})
        );
        assert_eq!(serde_json::to_value(Scope::Base).unwrap(), json!({"kind":"base"}));
    }
}
