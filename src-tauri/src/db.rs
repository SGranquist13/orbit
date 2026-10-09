use crate::agent::AgentEvent;
use anyhow::Context;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::path::Path;

pub struct Db {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub base_branch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub branch: String,
    pub path: String,
    pub agent: String,
    pub model: Option<String>,
    /// idle | running | done | error
    pub status: String,
    pub agent_session_id: Option<String>,
    pub issue_number: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Last event seq the user has seen (opened the workspace at or after it).
    pub seen_seq: i64,
    /// Last event seq at which the user dismissed this workspace from the inbox.
    pub dismissed_seq: i64,
    /// Profile id (`<plugin>:<name>`); None = builder.
    pub profile: Option<String>,
    /// Hidden from the inbox until this time (ms epoch); 0 = not snoozed.
    pub snoozed_until: i64,
}

/// What the inbox needs to know about a workspace's recent activity.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub workspace_id: String,
    pub last_seq: i64,
    pub last_activity_ts: i64,
    pub last_turn_seq: i64,
    pub last_turn_error: Option<String>,
    pub last_turn_interrupted: bool,
    pub last_assistant_text: Option<String>,
    pub last_user_text: Option<String>,
}

/// Another project folder attached to a workspace so its agent can read (or, via its own
/// worktree, edit) it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub workspace_id: String,
    pub path: String,
    /// Folder name, derived from `path`.
    pub name: String,
    pub editable: bool,
    /// Isolated worktree of the attached repo; set once the folder has been made editable.
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub seq: i64,
    pub ts: i64,
    pub event: AgentEvent,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  agent_session_id TEXT,
  issue_number INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ws ON events(workspace_id, seq);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  path TEXT NOT NULL,
  editable INTEGER NOT NULL DEFAULT 0,
  worktree_path TEXT,
  branch TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, path)
);
CREATE TABLE IF NOT EXISTS repo_related (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  path TEXT NOT NULL,
  PRIMARY KEY(repo_id, path)
);
";

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn workspace_from_row(r: &Row) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: r.get("id")?,
        repo_id: r.get("repo_id")?,
        name: r.get("name")?,
        branch: r.get("branch")?,
        path: r.get("path")?,
        agent: r.get("agent")?,
        model: r.get("model")?,
        status: r.get("status")?,
        agent_session_id: r.get("agent_session_id")?,
        issue_number: r.get("issue_number")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        seen_seq: r.get("seen_seq")?,
        dismissed_seq: r.get("dismissed_seq")?,
        profile: r.get("profile")?,
        snoozed_until: r.get("snoozed_until")?,
    })
}

fn attachment_from_row(r: &Row) -> rusqlite::Result<Attachment> {
    let path: String = r.get("path")?;
    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(Attachment {
        id: r.get("id")?,
        workspace_id: r.get("workspace_id")?,
        name,
        path,
        editable: r.get::<_, i64>("editable")? != 0,
        worktree_path: r.get("worktree_path")?,
        branch: r.get("branch")?,
    })
}

/// Additive schema changes for databases created by older builds.
fn migrate(conn: &Connection) -> anyhow::Result<()> {
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(workspaces)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    for (col, ddl) in [
        ("seen_seq", "ALTER TABLE workspaces ADD COLUMN seen_seq INTEGER NOT NULL DEFAULT 0"),
        ("dismissed_seq", "ALTER TABLE workspaces ADD COLUMN dismissed_seq INTEGER NOT NULL DEFAULT 0"),
        ("profile", "ALTER TABLE workspaces ADD COLUMN profile TEXT"),
        ("snoozed_until", "ALTER TABLE workspaces ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !cols.iter().any(|c| c == col) {
            conn.execute(ddl, [])?;
        }
    }
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        // Agents can't survive an app restart; anything mid-run is now idle.
        conn.execute("UPDATE workspaces SET status = 'idle' WHERE status = 'running'", [])?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        migrate(&conn).unwrap();
        Self { conn }
    }

    pub fn setting(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn insert_repo(&self, repo: &Repo) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO repos (id, name, path, base_branch, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![repo.id, repo.name, repo.path, repo.base_branch, now()],
        )?;
        Ok(())
    }

    pub fn repos(&self) -> anyhow::Result<Vec<Repo>> {
        let mut stmt = self.conn.prepare("SELECT id, name, path, base_branch FROM repos ORDER BY name")?;
        let rows = stmt.query_map([], |r| {
            Ok(Repo { id: r.get(0)?, name: r.get(1)?, path: r.get(2)?, base_branch: r.get(3)? })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn repo(&self, id: &str) -> anyhow::Result<Repo> {
        Ok(self.conn.query_row("SELECT id, name, path, base_branch FROM repos WHERE id = ?1", [id], |r| {
            Ok(Repo { id: r.get(0)?, name: r.get(1)?, path: r.get(2)?, base_branch: r.get(3)? })
        })?)
    }

    pub fn insert_workspace(&self, ws: &Workspace) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO workspaces (id, repo_id, name, branch, path, agent, model, status, issue_number, created_at, updated_at, profile)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                ws.id, ws.repo_id, ws.name, ws.branch, ws.path, ws.agent, ws.model, ws.status,
                ws.issue_number, ws.created_at, ws.updated_at, ws.profile
            ],
        )?;
        Ok(())
    }

    pub fn workspaces(&self) -> anyhow::Result<Vec<Workspace>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM workspaces WHERE archived = 0 ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], workspace_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn workspace(&self, id: &str) -> anyhow::Result<Workspace> {
        Ok(self
            .conn
            .query_row("SELECT * FROM workspaces WHERE id = ?1", [id], workspace_from_row)
            .with_context(|| format!("workspace {id} not found"))?)
    }

    pub fn set_status(&self, id: &str, status: &str) -> anyhow::Result<Workspace> {
        self.conn.execute(
            "UPDATE workspaces SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, status, now()],
        )?;
        self.workspace(id)
    }

    pub fn set_profile(&self, id: &str, profile: Option<&str>) -> anyhow::Result<Workspace> {
        self.conn.execute("UPDATE workspaces SET profile = ?2 WHERE id = ?1", params![id, profile])?;
        self.workspace(id)
    }

    pub fn set_snoozed(&self, id: &str, until: i64) -> anyhow::Result<Workspace> {
        self.conn.execute("UPDATE workspaces SET snoozed_until = ?2 WHERE id = ?1", params![id, until])?;
        self.workspace(id)
    }

    pub fn set_agent_session(&self, id: &str, session_id: &str) -> anyhow::Result<()> {
        self.conn
            .execute("UPDATE workspaces SET agent_session_id = ?2 WHERE id = ?1", params![id, session_id])?;
        Ok(())
    }

    pub fn clear_agent_session(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("UPDATE workspaces SET agent_session_id = NULL WHERE id = ?1", [id])?;
        Ok(())
    }

    /// `Usage` and `SessionReset` events (one workspace, or all of them), in seq order.
    /// Payloads are serde-tagged, so a prefix LIKE finds them without parsing every event.
    pub fn usage_rows(&self, workspace_id: Option<&str>) -> anyhow::Result<Vec<crate::usage::Row>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_id, ts, payload FROM events
             WHERE (?1 IS NULL OR workspace_id = ?1)
               AND (payload LIKE '{\"type\":\"usage\"%' OR payload LIKE '{\"type\":\"sessionReset\"%')
             ORDER BY seq",
        )?;
        let rows = stmt.query_map([workspace_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (workspace_id, ts, payload) = row?;
            if let Ok(event) = serde_json::from_str(&payload) {
                out.push(crate::usage::Row { workspace_id, ts, event });
            }
        }
        Ok(out)
    }

    /// Every workspace, archived or not, so usage history survives archiving.
    pub fn all_workspaces(&self) -> anyhow::Result<Vec<Workspace>> {
        let mut stmt = self.conn.prepare("SELECT * FROM workspaces")?;
        let rows = stmt.query_map([], workspace_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn last_seq(&self, id: &str) -> anyhow::Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM events WHERE workspace_id = ?1", [id], |r| r.get(0))?)
    }

    /// Marks everything up to the latest event as seen. Returns the new seen seq.
    pub fn mark_seen(&self, id: &str) -> anyhow::Result<i64> {
        let seq = self.last_seq(id)?;
        self.conn
            .execute("UPDATE workspaces SET seen_seq = MAX(seen_seq, ?2) WHERE id = ?1", params![id, seq])?;
        Ok(seq)
    }

    /// Hides the workspace from the inbox until it has new activity. Returns the dismissed seq.
    pub fn dismiss(&self, id: &str) -> anyhow::Result<i64> {
        let seq = self.last_seq(id)?;
        self.conn
            .execute("UPDATE workspaces SET dismissed_seq = MAX(dismissed_seq, ?2) WHERE id = ?1", params![id, seq])?;
        Ok(seq)
    }

    /// Latest event of a given type (payloads are serde-tagged, so they start with {"type":"…").
    fn latest(&self, id: &str, kind: &str) -> anyhow::Result<Option<StoredEvent>> {
        let prefix = format!("{{\"type\":\"{kind}\"%");
        let row = self
            .conn
            .query_row(
                "SELECT seq, ts, payload FROM events WHERE workspace_id = ?1 AND payload LIKE ?2 ORDER BY seq DESC LIMIT 1",
                params![id, prefix],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
            )
            .optional()?;
        Ok(row.and_then(|(seq, ts, payload)| serde_json::from_str(&payload).ok().map(|event| StoredEvent { seq, ts, event })))
    }

    pub fn summary(&self, id: &str) -> anyhow::Result<Summary> {
        let (last_seq, last_activity_ts) = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0), COALESCE(MAX(ts), 0) FROM events WHERE workspace_id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
        let mut s = Summary { workspace_id: id.to_string(), last_seq, last_activity_ts, ..Default::default() };
        if let Some(StoredEvent { seq, event: AgentEvent::TurnCompleted { is_error, error, interrupted, .. }, .. }) =
            self.latest(id, "turnCompleted")?
        {
            s.last_turn_seq = seq;
            s.last_turn_error = if is_error { error.or(Some("Turn failed".into())) } else { None };
            s.last_turn_interrupted = interrupted;
        }
        if let Some(StoredEvent { event: AgentEvent::Message { text }, .. }) = self.latest(id, "message")? {
            s.last_assistant_text = Some(text);
        }
        if let Some(StoredEvent { event: AgentEvent::UserMessage { text, skill }, .. }) = self.latest(id, "userMessage")? {
            s.last_user_text = Some(match skill {
                Some(skill) if text.is_empty() => format!("/{skill}"),
                Some(skill) => format!("/{skill} {text}"),
                None => text,
            });
        }
        Ok(s)
    }

    pub fn attachments(&self, workspace_id: &str) -> anyhow::Result<Vec<Attachment>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM attachments WHERE workspace_id = ?1 ORDER BY created_at, rowid")?;
        let rows = stmt.query_map([workspace_id], attachment_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn attachment(&self, id: &str) -> anyhow::Result<Attachment> {
        Ok(self
            .conn
            .query_row("SELECT * FROM attachments WHERE id = ?1", [id], attachment_from_row)
            .with_context(|| format!("attachment {id} not found"))?)
    }

    /// Idempotent per (workspace, path): attaching the same folder twice returns the first row.
    pub fn add_attachment(&self, workspace_id: &str, path: &str) -> anyhow::Result<Attachment> {
        self.conn.execute(
            "INSERT OR IGNORE INTO attachments (id, workspace_id, path, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![uuid::Uuid::new_v4().to_string(), workspace_id, path, now()],
        )?;
        Ok(self.conn.query_row(
            "SELECT * FROM attachments WHERE workspace_id = ?1 AND path = ?2",
            params![workspace_id, path],
            attachment_from_row,
        )?)
    }

    pub fn set_attachment_editable(
        &self,
        id: &str,
        editable: bool,
        worktree: Option<(&str, &str)>,
    ) -> anyhow::Result<Attachment> {
        self.conn.execute("UPDATE attachments SET editable = ?2 WHERE id = ?1", params![id, editable])?;
        if let Some((path, branch)) = worktree {
            self.conn.execute(
                "UPDATE attachments SET worktree_path = ?2, branch = ?3 WHERE id = ?1",
                params![id, path, branch],
            )?;
        }
        self.attachment(id)
    }

    pub fn remove_attachment(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM attachments WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Folders attached automatically to every new workspace of the repo.
    pub fn related_defaults(&self, repo_id: &str) -> anyhow::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT path FROM repo_related WHERE repo_id = ?1 ORDER BY path")?;
        let rows = stmt.query_map([repo_id], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn set_related_default(&self, repo_id: &str, path: &str, enabled: bool) -> anyhow::Result<()> {
        if enabled {
            self.conn
                .execute("INSERT OR IGNORE INTO repo_related (repo_id, path) VALUES (?1, ?2)", params![repo_id, path])?;
        } else {
            self.conn
                .execute("DELETE FROM repo_related WHERE repo_id = ?1 AND path = ?2", params![repo_id, path])?;
        }
        Ok(())
    }

    pub fn archive_workspace(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("UPDATE workspaces SET archived = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn append_event(&self, workspace_id: &str, ev: &AgentEvent) -> anyhow::Result<StoredEvent> {
        let ts = now();
        self.conn.execute(
            "INSERT INTO events (workspace_id, ts, payload) VALUES (?1, ?2, ?3)",
            params![workspace_id, ts, serde_json::to_string(ev)?],
        )?;
        Ok(StoredEvent { seq: self.conn.last_insert_rowid(), ts, event: ev.clone() })
    }

    pub fn events(&self, workspace_id: &str) -> anyhow::Result<Vec<StoredEvent>> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, ts, payload FROM events WHERE workspace_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map([workspace_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, ts, payload) = row?;
            // Skip rows from older event schemas rather than failing the whole transcript.
            if let Ok(event) = serde_json::from_str(&payload) {
                out.push(StoredEvent { seq, ts, event });
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_round_trip() {
        let db = Db::memory();
        db.insert_repo(&Repo { id: "r".into(), name: "r".into(), path: "/r".into(), base_branch: "main".into() })
            .unwrap();
        let ws = Workspace {
            id: "w".into(),
            repo_id: "r".into(),
            name: "w".into(),
            branch: "b".into(),
            path: "/w".into(),
            agent: "claude".into(),
            model: None,
            status: "idle".into(),
            agent_session_id: None,
            issue_number: None,
            created_at: 0,
            updated_at: 0,
            seen_seq: 0,
            dismissed_seq: 0,
            profile: None,
            snoozed_until: 0,
        };
        db.insert_workspace(&ws).unwrap();
        db.append_event("w", &AgentEvent::UserMessage { text: "hi".into(), skill: None }).unwrap();
        let evs = db.events("w").unwrap();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].event, AgentEvent::UserMessage { text: "hi".into(), skill: None });
        assert_eq!(db.set_status("w", "running").unwrap().status, "running");

        // Inbox bookkeeping.
        db.append_event("w", &AgentEvent::Message { text: "Should I add tests?".into() }).unwrap();
        let done = db
            .append_event(
                "w",
                &AgentEvent::TurnCompleted { duration_ms: None, cost_usd: None, is_error: false, error: None, interrupted: false },
            )
            .unwrap();
        let s = db.summary("w").unwrap();
        assert_eq!(s.last_seq, done.seq);
        assert_eq!(s.last_turn_seq, done.seq);
        assert_eq!(s.last_assistant_text.as_deref(), Some("Should I add tests?"));
        assert_eq!(s.last_user_text.as_deref(), Some("hi"));
        assert_eq!(db.workspace("w").unwrap().seen_seq, 0);
        assert_eq!(db.mark_seen("w").unwrap(), done.seq);
        assert_eq!(db.workspace("w").unwrap().seen_seq, done.seq);
        assert_eq!(db.dismiss("w").unwrap(), done.seq);

        // Snooze round-trips and survives other updates.
        assert_eq!(db.workspace("w").unwrap().snoozed_until, 0);
        assert_eq!(db.set_snoozed("w", 1_700_000_000_000).unwrap().snoozed_until, 1_700_000_000_000);
        assert_eq!(db.set_status("w", "done").unwrap().snoozed_until, 1_700_000_000_000);
        assert_eq!(db.set_snoozed("w", 0).unwrap().snoozed_until, 0);
    }

    #[test]
    fn usage_rows_and_session_clear() {
        let db = Db::memory();
        db.insert_repo(&Repo { id: "r".into(), name: "r".into(), path: "/r".into(), base_branch: "main".into() })
            .unwrap();
        let mk = |id: &str| Workspace {
            id: id.into(),
            repo_id: "r".into(),
            name: id.into(),
            branch: "b".into(),
            path: "/w".into(),
            agent: "claude".into(),
            model: None,
            status: "idle".into(),
            agent_session_id: None,
            issue_number: None,
            created_at: 0,
            updated_at: 0,
            seen_seq: 0,
            dismissed_seq: 0,
            profile: None,
            snoozed_until: 0,
        };
        db.insert_workspace(&mk("w")).unwrap();
        db.insert_workspace(&mk("x")).unwrap();
        let usage = AgentEvent::Usage {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
            context_tokens: Some(5),
            context_window: Some(100),
            cost_usd: Some(0.1),
            model: None,
        };
        db.append_event("w", &AgentEvent::Message { text: "noise".into() }).unwrap();
        db.append_event("w", &usage).unwrap();
        db.append_event("w", &AgentEvent::SessionReset).unwrap();
        db.append_event("x", &usage).unwrap();
        assert_eq!(db.usage_rows(Some("w")).unwrap().len(), 2);
        assert_eq!(db.usage_rows(None).unwrap().len(), 3);
        let u = crate::usage::workspace_usage("w", &db.usage_rows(Some("w")).unwrap().iter().collect::<Vec<_>>());
        assert_eq!((u.total.turns, u.session.turns, u.context_tokens), (1, 0, None));

        db.set_agent_session("w", "s1").unwrap();
        db.clear_agent_session("w").unwrap();
        assert_eq!(db.workspace("w").unwrap().agent_session_id, None);
    }

    #[test]
    fn migrate_adds_snoozed_until_to_old_db() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        // SCHEMA has no snoozed_until, so this is the "old database" shape.
        let cols = |c: &Connection| -> Vec<String> {
            c.prepare("PRAGMA table_info(workspaces)").unwrap().query_map([], |r| r.get::<_, String>(1)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert!(!cols(&conn).contains(&"snoozed_until".to_string()));
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // idempotent
        assert!(cols(&conn).contains(&"snoozed_until".to_string()));
    }

    #[test]
    fn attachments_and_related_defaults() {
        let db = Db::memory();
        db.insert_repo(&Repo { id: "r".into(), name: "r".into(), path: "/r".into(), base_branch: "main".into() })
            .unwrap();
        let ws = Workspace {
            id: "w".into(),
            repo_id: "r".into(),
            name: "w".into(),
            branch: "b".into(),
            path: "/w".into(),
            agent: "claude".into(),
            model: None,
            status: "idle".into(),
            agent_session_id: None,
            issue_number: None,
            created_at: 0,
            updated_at: 0,
            seen_seq: 0,
            dismissed_seq: 0,
            profile: None,
            snoozed_until: 0,
        };
        db.insert_workspace(&ws).unwrap();

        let a = db.add_attachment("w", "/code/shared-ui").unwrap();
        assert_eq!((a.name.as_str(), a.editable, a.worktree_path.as_deref()), ("shared-ui", false, None));
        // Idempotent per (workspace, path).
        assert_eq!(db.add_attachment("w", "/code/shared-ui").unwrap().id, a.id);
        assert_eq!(db.attachments("w").unwrap().len(), 1);

        let e = db.set_attachment_editable(&a.id, true, Some(("/wt/shared-ui", "me/fix-1234"))).unwrap();
        assert!(e.editable);
        assert_eq!((e.worktree_path.as_deref(), e.branch.as_deref()), (Some("/wt/shared-ui"), Some("me/fix-1234")));
        // Disabling keeps the worktree so no work is lost.
        let off = db.set_attachment_editable(&a.id, false, None).unwrap();
        assert!(!off.editable);
        assert_eq!(off.worktree_path.as_deref(), Some("/wt/shared-ui"));

        db.remove_attachment(&a.id).unwrap();
        assert!(db.attachments("w").unwrap().is_empty());

        db.set_related_default("r", "/code/api", true).unwrap();
        db.set_related_default("r", "/code/api", true).unwrap();
        assert_eq!(db.related_defaults("r").unwrap(), vec!["/code/api".to_string()]);
        db.set_related_default("r", "/code/api", false).unwrap();
        assert!(db.related_defaults("r").unwrap().is_empty());
    }
}
