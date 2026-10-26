//! Turn checkpoints and workspace history operations. Events are retained for audit.
use crate::agent::{AgentEvent, Command};
use crate::db::{StoredEvent, Workspace};
use crate::{create_workspace_inner, db, emit_workspace, err, git, relock, trunk, AppState, CmdResult, NewWorkspaceArgs};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, State};

// Always acquire before GIT_LOCK/db. Checkpoint publication and sends cannot overlap a rewind.
static OPERATIONS: Mutex<()> = Mutex::new(());
static RETIRED: std::sync::LazyLock<Mutex<HashSet<u64>>> = std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

thread_local! { static HELD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

/// Reentrant per thread: a send that fails ends its turn through `on_agent_event`, which takes this
/// lock again on the same thread. A plain Mutex would deadlock there.
pub(crate) struct OperationGuard(Option<MutexGuard<'static, ()>>);
impl Drop for OperationGuard {
    fn drop(&mut self) {
        if self.0.take().is_some() { HELD.with(|h| h.set(false)); }
    }
}

pub(crate) fn operation_lock() -> OperationGuard {
    if HELD.with(|h| h.get()) { return OperationGuard(None); }
    let guard = relock(&OPERATIONS);
    HELD.with(|h| h.set(true));
    OperationGuard(Some(guard))
}
pub(crate) fn retired(generation: u64) -> bool { relock(&RETIRED).contains(&generation) }

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnPoint {
    /// The TurnCompleted sequence, not the user-message sequence.
    pub seq: i64,
    /// One based; includes historical completed turns without checkpoints.
    pub turn_index: usize,
    pub sha: String,
    pub user_text_preview: String,
}

fn preview(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect()
}

/// Active event rows in sequence order. Unknown historical SHAs are never guessed.
pub fn turn_points(rows: &[StoredEvent]) -> Vec<TurnPoint> {
    let mut points = Vec::new();
    let mut user = String::new();
    let mut turn_index = 0;
    for row in rows {
        match &row.event {
            AgentEvent::UserMessage { text, skill, images, files } => {
                user = preview(&db::user_preview(text.clone(), skill.clone(), images, files));
            }
            AgentEvent::TurnCompleted { .. } => {
                turn_index += 1;
                if let Some(sha) = &row.commit_sha {
                    points.push(TurnPoint { seq: row.seq, turn_index, sha: sha.clone(), user_text_preview: user.clone() });
                }
                user.clear();
            }
            _ => {}
        }
    }
    points
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindPreview {
    pub target: TurnPoint,
    pub files: Vec<String>,
    pub dropped_turns: Vec<TurnPoint>,
}

fn target(rows: &[StoredEvent], seq: i64) -> anyhow::Result<TurnPoint> {
    turn_points(rows).into_iter().find(|p| p.seq == seq)
        .ok_or_else(|| anyhow::anyhow!("This turn has no saved checkpoint"))
}

fn handover(rows: &[StoredEvent], kept: &TurnPoint) -> String {
    let discarded = rows.iter().filter(|r| r.seq > kept.seq).filter_map(|r| match &r.event {
        AgentEvent::UserMessage { text, skill, images, files } => Some(preview(&db::user_preview(text.clone(), skill.clone(), images, files))),
        _ => None,
    }).collect::<Vec<_>>().join("; ");
    let mut note = format!(
        "The conversation and code were rewound to after turn {}. Later turns were discarded: {}.\n\nKept conversation:\n",
        kept.turn_index, if discarded.is_empty() { "(none)" } else { &discarded }
    );
    for row in rows.iter().filter(|r| r.seq <= kept.seq) {
        match &row.event {
            AgentEvent::UserMessage { text, skill, images, files } => {
                note.push_str(&format!("User: {}\n", db::user_preview(text.clone(), skill.clone(), images, files)));
            }
            AgentEvent::Message { text } => note.push_str(&format!("Assistant: {text}\n")),
            _ => {}
        }
    }
    note.push_str("\nContinue from this kept context. The next user message follows:\n\n");
    note
}

fn verify_sha(path: &Path, sha: &str) -> anyhow::Result<()> {
    anyhow::ensure!((sha.len() == 40 || sha.len() == 64) && sha.bytes().all(|b| b.is_ascii_hexdigit()), "Invalid checkpoint SHA");
    git::run(path, &["cat-file", "-e", &format!("{sha}^{{commit}}")])?;
    Ok(())
}

fn changed_files(path: &Path, sha: &str) -> anyhow::Result<Vec<String>> {
    verify_sha(path, sha)?;
    let tracked = git::run_raw(path, &["diff", "--name-only", "-z", sha, "--"])?;
    let untracked = git::run_raw(path, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut files: Vec<String> = tracked.split('\0').chain(untracked.split('\0'))
        .filter(|s| !s.is_empty()).map(str::to_owned).collect();
    files.sort();
    files.dedup();
    Ok(files)
}

/// Caller holds GIT_LOCK. Save dirty work even when automatic save commits are off.
fn reset_to(path: &Path, sha: &str) -> anyhow::Result<()> {
    verify_sha(path, sha)?;
    trunk::commit_save_point(path, "wip: before workspace rewind")?;
    git::run(path, &["reset", "--hard", sha])?;
    git::run(path, &["clean", "-fd"])?;
    Ok(())
}

#[tauri::command]
pub fn workspace_turn_points(state: State<AppState>, workspace_id: String) -> CmdResult<Vec<TurnPoint>> {
    let rows = state.db().events(&workspace_id).map_err(err)?;
    Ok(turn_points(&rows))
}

#[tauri::command]
pub fn rewind_preview(state: State<AppState>, workspace_id: String, seq: i64) -> CmdResult<RewindPreview> {
    let _operation = operation_lock();
    let _git = trunk::lock();
    let (ws, rows) = {
        let db = state.db();
        (db.workspace(&workspace_id).map_err(err)?, db.events(&workspace_id).map_err(err)?)
    };
    let kept = target(&rows, seq).map_err(err)?;
    let files = changed_files(Path::new(&ws.path), &kept.sha).map_err(err)?;
    let dropped_turns = turn_points(&rows).into_iter().filter(|p| p.seq > seq).collect();
    Ok(RewindPreview { target: kept, files, dropped_turns })
}

#[tauri::command]
pub fn rewind_workspace(app: AppHandle, state: State<AppState>, workspace_id: String, seq: i64) -> CmdResult<Workspace> {
    let _operation = operation_lock();
    let _git = trunk::lock();
    let (ws, rows) = {
        let db = state.db();
        (db.workspace(&workspace_id).map_err(err)?, db.events(&workspace_id).map_err(err)?)
    };
    if ws.status == "running" || crate::simplify::active(&workspace_id) {
        return Err("Stop the workspace before rewinding it".into());
    }
    let kept = target(&rows, seq).map_err(err)?;
    let note = handover(&rows, &kept);
    reset_to(Path::new(&ws.path), &kept.sha).map_err(err)?;
    let ws = state.db().rewind_events(&workspace_id, seq, &note).map_err(err)?;
    let taken = state.sessions_lock().remove(&workspace_id);
    if let Some(h) = taken {
        relock(&RETIRED).insert(h.generation);
        h.send(Command::Shutdown);
    }
    state.notices_lock().remove(&workspace_id);
    emit_workspace(&app, &ws);
    Ok(ws)
}

#[tauri::command]
pub async fn branch_from_turn(app: AppHandle, state: State<'_, AppState>, workspace_id: String, seq: i64, name: Option<String>) -> CmdResult<Workspace> {
    let (ws, kept, note) = {
        let _operation = operation_lock();
        let db = state.db();
        let ws = db.workspace(&workspace_id).map_err(err)?;
        let rows = db.events(&workspace_id).map_err(err)?;
        let kept = target(&rows, seq).map_err(err)?;
        let note = handover(&rows, &kept);
        (ws, kept, note)
    };
    let new = create_workspace_inner(&app, &state, NewWorkspaceArgs {
            branch: None, existing_branch: false,
        repo_id: ws.repo_id,
        name: name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("{} from turn {}", ws.name, kept.turn_index)),
        agent: ws.agent, model: ws.model, issue_number: ws.issue_number, profile: ws.profile,
        routine_id: None, branch_prefix: None, teammate: ws.teammate, start_ref: Some(kept.sha), attempt_group: None, branch_suffix: None,
    }).await?;
    state.db().set_setting(&format!("rewind_note:{}", new.id), &note).map_err(err)?;
    Ok(new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(seq: i64, event: AgentEvent, sha: Option<&str>) -> StoredEvent {
        StoredEvent { seq, ts: 0, event, commit_sha: sha.map(str::to_owned) }
    }
    fn user(seq: i64, text: &str) -> StoredEvent {
        row(seq, AgentEvent::UserMessage { text: text.into(), skill: None, images: vec![], files: vec![] }, None)
    }
    fn done(seq: i64, sha: Option<&str>) -> StoredEvent {
        row(seq, AgentEvent::TurnCompleted { duration_ms: None, cost_usd: None, is_error: false, error: None, interrupted: false }, sha)
    }

    #[test]
    fn turn_points_map_turns_to_commits() {
        let rows = vec![
            user(1, "make a"), row(2, AgentEvent::Message { text: "ok".into() }, None), done(3, Some("aaa")),
            user(4, "legacy  turn"), done(5, None),
            user(6, "make b"), done(7, Some("bbb")),
        ];
        let p = turn_points(&rows);
        assert_eq!(p.len(), 2);
        assert_eq!((p[0].seq, p[0].turn_index, p[0].sha.as_str(), p[0].user_text_preview.as_str()), (3, 1, "aaa", "make a"));
        assert_eq!((p[1].seq, p[1].turn_index, p[1].sha.as_str()), (7, 3, "bbb"));
        assert!(turn_points(&[]).is_empty());
    }

    #[test]
    fn handover_lists_discarded_turns() {
        let rows = vec![user(1, "make a"), done(2, Some("aaa")), user(3, "make b"), done(4, Some("bbb"))];
        let kept = target(&rows, 2).unwrap();
        let note = handover(&rows, &kept);
        assert!(note.contains("after turn 1") && note.contains("make b") && note.contains("User: make a"));
        assert!(target(&rows, 1).is_err());
    }
}

#[cfg(test)]
mod lock_tests {
    #[test]
    fn operation_lock_is_reentrant_on_one_thread() {
        let outer = super::operation_lock();
        let inner = super::operation_lock();
        drop(inner);
        drop(outer);
        // Released: another thread can take it.
        std::thread::spawn(|| drop(super::operation_lock())).join().unwrap();
    }
}
