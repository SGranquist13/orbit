//! One prompt, sibling worktrees, persisted completion and check summaries.
use crate::{agent::{AgentEvent, AgentKind, Command, ImageRef}, checks, db, err, git, trunk, AppState, CmdResult, NewWorkspaceArgs};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

// Serializes creation and user lifecycle actions, including partial-start cleanup.
static LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus { Pass, Fail, TimedOut, None }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttemptSummary {
    pub checks: CheckStatus,
    pub files_changed: usize,
    pub additions: u64,
    pub deletions: u64,
    pub duration_ms: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub workspace_id: String,
    pub finished: bool,
    pub duration_ms: Option<u64>,
    pub cost_usd: Option<f64>,
    pub summary: Option<AttemptSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptGroup {
    pub id: String,
    pub prompt: String,
    pub repo_id: String,
    pub created_at: i64,
    pub status: String,
    pub winner_workspace_id: Option<String>,
    pub workspace_ids: Vec<String>,
    pub attempts: Vec<Attempt>,
}

#[derive(Debug, Deserialize)]
pub struct AttemptInput { pub agent: String, pub model: Option<String> }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub repo_id: String,
    pub prompt: String,
    pub attempts: Vec<AttemptInput>,
    pub profile: Option<String>,
    #[serde(default)]
    pub images: Vec<ImageRef>,
}

/// Stable ordering: passing checks first, then smallest total line delta. Missing summaries last.
pub fn rank(attempts: &[Attempt]) -> Vec<Attempt> {
    let mut ranked = attempts.to_vec();
    ranked.sort_by_key(|a| match &a.summary {
        Some(s) => (if s.checks == CheckStatus::Pass { 0 } else { 1 }, s.additions.saturating_add(s.deletions)),
        None => (2, u64::MAX),
    });
    ranked
}

fn publish(app: &AppHandle, state: &AppState, id: &str) {
    let group = state.db().attempt_group(id);
    if let Ok(group) = group { let _ = app.emit("attempts", group); }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_attempts(app: AppHandle, state: State<'_, AppState>, repo_id: String, prompt: String, attempts: Vec<AttemptInput>, profile: Option<String>, images: Option<Vec<ImageRef>>) -> CmdResult<AttemptGroup> {
    let args = StartArgs { repo_id, prompt, attempts, profile, images: images.unwrap_or_default() };
    let _guard = LIFECYCLE.lock().await;
    if !(2..=4).contains(&args.attempts.len()) { return Err("Choose 2–4 attempts".into()); }
    if args.prompt.trim().is_empty() { return Err("Prompt is required".into()); }
    for a in &args.attempts { AgentKind::parse(&a.agent).ok_or("unknown agent")?; }
    let repo = state.db().repo(&args.repo_id).map_err(err)?;
    let group = AttemptGroup { id: uuid::Uuid::new_v4().to_string(), prompt: args.prompt.clone(), repo_id: args.repo_id.clone(), created_at: db::now(), status: "running".into(), winner_workspace_id: None, workspace_ids: vec![], attempts: vec![] };
    state.db().insert_attempt_group(&group, args.attempts.len()).map_err(err)?;
    let slug = git::slugify(&args.prompt);
    let mut created = vec![];
    // The first worktree fetches base; pin every sibling to that exact commit.
    let mut start_ref = None;
    for (i, a) in args.attempts.into_iter().enumerate() {
        let letter = (b'a' + i as u8) as char;
        let result = crate::create_workspace_inner(&app, &state, NewWorkspaceArgs {
            repo_id: repo.id.clone(), name: format!("{slug} · {}", letter.to_ascii_uppercase()), agent: a.agent, model: a.model,
            issue_number: None, profile: args.profile.clone(), routine_id: None, branch_prefix: None, teammate: None,
            start_ref: start_ref.clone(), attempt_group: Some(group.id.clone()), branch_suffix: Some(letter.to_string()),
        }).await;
        match result {
            Ok(ws) => {
                created.push(ws.id.clone());
                let record = state.db().insert_attempt(&group.id, &ws.id).map_err(err);
                if let Err(e) = record {
                    close_inner(&app, &state, &group.id, None, &created).await?;
                    return Err(e);
                }
                if start_ref.is_none() {
                    let path = ws.path.clone();
                    let pinned = tauri::async_runtime::spawn_blocking(move || git::run(Path::new(&path), &["rev-parse", "HEAD"])).await.map_err(err).and_then(|r| r.map_err(err));
                    match pinned {
                        Ok(reference) => start_ref = Some(reference),
                        Err(e) => { close_inner(&app, &state, &group.id, None, &created).await?; return Err(e); }
                    }
                }
            }
            Err(e) => { close_inner(&app, &state, &group.id, None, &created).await?; return Err(e); }
        }
    }
    // All entries exist before any agent can finish. A failed launch emits TurnCompleted itself.
    for id in &created {
        let _ = crate::send_with_images(&app, &state, id, args.prompt.clone(), None, args.prompt.clone(), args.images.clone(), vec![]);
    }
    publish(&app, &state, &group.id);
    state.db().attempt_group(&group.id).map_err(err)
}

pub fn finish_turn(app: &AppHandle, state: &AppState, workspace: &str, event: &AgentEvent) {
    let AgentEvent::TurnCompleted { duration_ms, cost_usd, .. } = event else { return };
    let group = state.db().finish_attempt(workspace, *duration_ms, *cost_usd);
    let Ok(Some(id)) = group else { return };
    let claimed = state.db().claim_attempt_checks(&id).unwrap_or(false);
    if !claimed { return; }
    let (app, state) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        let guard = LIFECYCLE.lock().await;
        let group = state.db().attempt_group(&id);
        let Ok(group) = group else { return };
        if group.status != "running" { return; }
        let options = trunk::run_options(&state);
        let mut jobs = vec![];
        for attempt in group.attempts {
            let ws = state.db().workspace(&attempt.workspace_id);
            let Ok(ws) = ws else { continue };
            let command = trunk::resolve_command(&state, &ws);
            let base = state.db().repo(&ws.repo_id).map(|r| r.base_branch);
            let Ok(base) = base else { continue };
            jobs.push(tauri::async_runtime::spawn_blocking(move || {
                let checks = match command {
                    None => CheckStatus::None,
                    Some(cmd) => match checks::run(Path::new(&ws.path), &cmd, options).kind {
                        checks::CheckKind::Pass => CheckStatus::Pass,
                        checks::CheckKind::TimedOut => CheckStatus::TimedOut,
                        _ => CheckStatus::Fail,
                    },
                };
                let files = git::changes(Path::new(&ws.path), &base);
                // A failed stat must not rank as a zero-line solution.
                let (files_changed, additions, deletions) = match files {
                    Ok(files) => (files.len(), files.iter().map(|f| f.additions as u64).sum(), files.iter().map(|f| f.deletions as u64).sum()),
                    Err(_) => (0, u64::MAX, 0),
                };
                (attempt.workspace_id, AttemptSummary { checks, files_changed, additions, deletions, duration_ms: attempt.duration_ms, cost_usd: attempt.cost_usd })
            }));
        }
        drop(guard);
        // Jobs are all started before awaiting, so checks run in parallel.
        for job in jobs {
            if let Ok((workspace, summary)) = job.await {
                let _ = state.db().store_attempt_summary(&id, &workspace, &summary);
            }
        }
        publish(&app, &state, &id);
    });
}

#[tauri::command]
pub fn attempt_group(state: State<AppState>, id: String) -> CmdResult<AttemptGroup> {
    let mut group = state.db().attempt_group(&id).map_err(err)?;
    group.attempts = rank(&group.attempts);
    Ok(group)
}

#[tauri::command]
pub async fn compare_attempts(state: State<'_, AppState>, a_ws: String, b_ws: String, path: Option<String>) -> CmdResult<String> {
    let a = state.db().workspace(&a_ws).map_err(err)?;
    let b = state.db().workspace(&b_ws).map_err(err)?;
    if a.repo_id != b.repo_id { return Err("Attempts must belong to the same repository".into()); }
    let repo = state.db().repo(&a.repo_id).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || branch_diff(Path::new(&repo.path), &a.branch, &b.branch, path.as_deref())).await.map_err(err)?
}

fn branch_diff(repo: &Path, a: &str, b: &str, path: Option<&str>) -> CmdResult<String> {
    let range = format!("refs/heads/{a}..refs/heads/{b}");
    let mut args = vec!["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", &range, "--"];
    if let Some(path) = path { args.push(path); }
    let diff = git::run(repo, &args).map_err(err)?;
    Ok(cap_diff(diff))
}

const DIFF_CAP: usize = 128 * 1024;
fn cap_diff(mut diff: String) -> String {
    if diff.len() > DIFF_CAP {
        let mut end = DIFF_CAP;
        while !diff.is_char_boundary(end) { end -= 1; }
        diff.truncate(end);
        diff.push_str("\n(diff truncated)");
    }
    diff
}

async fn close_inner(app: &AppHandle, state: &AppState, id: &str, winner: Option<&str>, workspaces: &[String]) -> CmdResult<()> {
    // Close first: late completion events cannot schedule checks or reopen the group.
    state.db().close_attempt_group(id, winner).map_err(err)?;
    for workspace in workspaces.iter().filter(|w| Some(w.as_str()) != winner) {
        {
            let sessions = state.sessions_lock();
            if let Some(h) = sessions.get(workspace) { h.send(Command::Interrupt); }
        }
        crate::archive_inner(state, workspace, false, false).await?;
        let _ = app.emit("workspace-archived", workspace);
    }
    publish(app, state, id);
    Ok(())
}

#[tauri::command]
pub async fn pick_attempt(app: AppHandle, state: State<'_, AppState>, group_id: String, workspace_id: String) -> CmdResult<AttemptGroup> {
    let _guard = LIFECYCLE.lock().await;
    let group = state.db().attempt_group(&group_id).map_err(err)?;
    if !group.workspace_ids.contains(&workspace_id) { return Err("Workspace is not in this attempt group".into()); }
    if group.status != "running" && group.winner_workspace_id.as_deref() != Some(&workspace_id) { return Err("Attempt group is already closed".into()); }
    close_inner(&app, &state, &group_id, Some(&workspace_id), &group.workspace_ids).await?;
    state.db().attempt_group(&group_id).map_err(err)
}

#[tauri::command]
pub async fn cancel_attempts(app: AppHandle, state: State<'_, AppState>, group_id: String) -> CmdResult<AttemptGroup> {
    let _guard = LIFECYCLE.lock().await;
    let group = state.db().attempt_group(&group_id).map_err(err)?;
    if group.status == "picked" { return Err("Attempt group already has a winner".into()); }
    close_inner(&app, &state, &group_id, None, &group.workspace_ids).await?;
    state.db().attempt_group(&group_id).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn attempt(id: &str, checks: CheckStatus, additions: u64, deletions: u64) -> Attempt {
        Attempt { workspace_id: id.into(), finished: true, duration_ms: Some(10), cost_usd: Some(0.1), summary: Some(AttemptSummary { checks, files_changed: 1, additions, deletions, duration_ms: Some(10), cost_usd: Some(0.1) }) }
    }
    #[test]
    fn ranks_checks_then_total_lines_stably() {
        let rows = vec![attempt("fail", CheckStatus::Fail, 0, 0), attempt("large", CheckStatus::Pass, 3, 5), attempt("small", CheckStatus::Pass, 1, 2), attempt("tie", CheckStatus::Pass, 2, 1), attempt("none", CheckStatus::None, 1, 0), attempt("timeout", CheckStatus::TimedOut, 2, 0)];
        assert_eq!(rank(&rows).iter().map(|a| a.workspace_id.as_str()).collect::<Vec<_>>(), vec!["small", "tie", "large", "fail", "none", "timeout"]);
        assert!(rank(&[]).is_empty());
    }
    #[test]
    fn persists_initial_completion_and_claims_checks_once() {
        let db = db::Db::memory();
        let group = AttemptGroup { id: "g".into(), prompt: "fix".into(), repo_id: "r".into(), created_at: 1, status: "running".into(), winner_workspace_id: None, workspace_ids: vec![], attempts: vec![] };
        db.insert_attempt_group(&group, 2).unwrap();
        db.insert_attempt("g", "a").unwrap();
        db.finish_attempt("a", Some(12), Some(0.2)).unwrap();
        assert!(!db.claim_attempt_checks("g").unwrap());
        db.insert_attempt("g", "b").unwrap();
        db.finish_attempt("b", None, None).unwrap();
        assert!(db.claim_attempt_checks("g").unwrap());
        assert!(!db.claim_attempt_checks("g").unwrap());
        assert!(db.finish_attempt("a", Some(99), None).unwrap().is_none());
        let summary = attempt("a", CheckStatus::Pass, 2, 3).summary.unwrap();
        db.store_attempt_summary("g", "a", &summary).unwrap();
        let loaded = db.attempt_group("g").unwrap();
        assert_eq!(loaded.workspace_ids, vec!["a", "b"]);
        assert_eq!(loaded.attempts[0].duration_ms, Some(12));
        assert_eq!(loaded.attempts[0].summary.as_ref(), Some(&summary));
        db.close_attempt_group("g", Some("a")).unwrap();
        db.close_attempt_group("g", None).unwrap();
        assert_eq!(db.attempt_group("g").unwrap().winner_workspace_id.as_deref(), Some("a"));
        db.store_attempt_summary("g", "b", &summary).unwrap();
        assert!(db.attempt_group("g").unwrap().attempts[1].summary.is_none());
    }
    #[test]
    fn branch_comparison_filters_literal_paths_and_caps_unicode() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git::run(repo, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(repo.join("a.txt"), "old\n").unwrap();
        std::fs::write(repo.join("b.txt"), "old\n").unwrap();
        git::run(repo, &["add", "-A"]).unwrap();
        git::run(repo, &["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", "base"]).unwrap();
        git::run(repo, &["branch", "attempt-a"]).unwrap();
        git::run(repo, &["switch", "-c", "attempt-b"]).unwrap();
        std::fs::write(repo.join("a.txt"), "new-a\n").unwrap();
        std::fs::write(repo.join("b.txt"), "new-b\n").unwrap();
        git::run(repo, &["add", "-A"]).unwrap();
        git::run(repo, &["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", "change"]).unwrap();
        let all = branch_diff(repo, "attempt-a", "attempt-b", None).unwrap();
        assert!(all.contains("+new-a") && all.contains("+new-b"));
        let one = branch_diff(repo, "attempt-a", "attempt-b", Some("a.txt")).unwrap();
        assert!(one.contains("+new-a") && !one.contains("new-b"));
        assert!(branch_diff(repo, "attempt-a", "attempt-b", Some("*.txt")).unwrap().is_empty());
        assert!(branch_diff(repo, "attempt-a", "attempt-a", None).unwrap().is_empty());
        assert!(branch_diff(repo, "attempt-a", "missing", None).is_err());
        let unicode = cap_diff("\u{20ac}".repeat(DIFF_CAP));
        assert!(unicode.ends_with("\n(diff truncated)"));
        assert!(unicode.len() <= DIFF_CAP + 17);
    }

    #[test]
    fn cancelled_group_ignores_late_completion_and_workspace_link_round_trips() {
        let db = db::Db::memory();
        db.insert_repo(&db::Repo { id: "r".into(), name: "repo".into(), path: "repo".into(), base_branch: "main".into() }).unwrap();
        db.insert_workspace(&db::Workspace { id: "a".into(), repo_id: "r".into(), attempt_group: Some("g".into()), ..Default::default() }).unwrap();
        assert_eq!(db.workspace("a").unwrap().attempt_group.as_deref(), Some("g"));
        let group = AttemptGroup { id: "g".into(), prompt: "fix".into(), repo_id: "r".into(), created_at: 1, status: "running".into(), winner_workspace_id: None, workspace_ids: vec![], attempts: vec![] };
        db.insert_attempt_group(&group, 2).unwrap();
        db.insert_attempt("g", "a").unwrap();
        db.insert_attempt("g", "b").unwrap();
        db.finish_attempt("a", None, None).unwrap();
        db.close_attempt_group("g", None).unwrap();
        assert!(db.finish_attempt("b", Some(99), Some(1.0)).unwrap().is_none());
        assert!(!db.claim_attempt_checks("g").unwrap());
        let loaded = db.attempt_group("g").unwrap();
        assert_eq!(loaded.status, "cancelled");
        assert!(!loaded.attempts[1].finished);
    }

}
