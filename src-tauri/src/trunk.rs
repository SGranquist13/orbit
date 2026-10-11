//! Trunk-based git handling as application logic (PLANNING #7): save-point commits, squashing them
//! before Ship, running checks, keeping idle workspaces rebased on base, overlap detection and
//! post-merge cleanup. Deterministic git code does the work; agents are only asked to resolve conflicts
//! or fix failing checks (through the inbox). Every behaviour is switchable in Settings > Git.

use crate::agent::Command;
use crate::checks::{self, CheckCommandInfo, CheckResult};
use crate::db::Workspace;
use crate::git;
use crate::{emit_workspace, err, AppState, CmdResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, State};

/// Serialises Orbit's own mutating git operations (commit, reset, rebase) so they never trip over
/// each other's `index.lock`.
static GIT_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock() -> std::sync::MutexGuard<'static, ()> {
    GIT_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

// ---- pure logic ----

const WIP_PREFIX: &str = "wip:";

/// `wip: <first line of the user's message, truncated>`.
pub fn wip_message(user_text: &str) -> String {
    let first = user_text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut subject: String = first.chars().take(60).collect();
    if first.chars().count() > 60 {
        subject.push('…');
    }
    if subject.is_empty() { format!("{WIP_PREFIX} save point") } else { format!("{WIP_PREFIX} {subject}") }
}

/// Prompts for model-written text stay small: a diff is cut to this many characters.
const DIFF_CAP: usize = 8_000;

fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}\n(cut short)", s.chars().take(max).collect::<String>())
    }
}

pub const COMMIT_SYSTEM: &str = "You write git commit messages. Reply with a subject of at most 60 characters in the imperative mood \
(\"Add retry to the sync loop\"), no trailing period and no type prefix, and a body of at most two short sentences saying why. \
Describe what the diff does, not what the user asked.";

pub fn commit_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": { "subject": { "type": "string" }, "body": { "type": "string" } },
        "required": ["subject", "body"]
    })
}

/// The prompt for a model-written save-point message: the user's message, the stat, and a capped diff.
pub fn commit_prompt(user_text: &str, stat: &str, diff: &str) -> String {
    format!(
        "The user asked the coding agent:\n{}\n\nStaged changes (stat):\n{}\n\nStaged diff:\n{}",
        clip_chars(user_text.trim(), 600),
        clip_chars(stat.trim(), 1_500),
        clip_chars(diff, DIFF_CAP)
    )
}

/// `wip: <subject>` (plus a body) from the model's reply; None when the reply has no usable subject.
pub fn model_message(reply: &serde_json::Value) -> Option<String> {
    let subject = reply["subject"].as_str()?.lines().map(str::trim).find(|l| !l.is_empty())?;
    let subject = subject.trim_matches(|c: char| c == '"' || c == '`' || c == '\'');
    let subject = subject.strip_prefix("wip:").or_else(|| subject.strip_prefix("WIP:")).unwrap_or(subject).trim().trim_end_matches('.');
    if subject.is_empty() {
        return None;
    }
    let mut cut: String = subject.chars().take(60).collect();
    if subject.chars().count() > 60 {
        cut.push('…');
    }
    let body = reply["body"].as_str().map(str::trim).filter(|b| !b.is_empty()).map(|b| clip_chars(b, 400));
    Some(match body {
        Some(b) => format!("{WIP_PREFIX} {cut}\n\n{b}"),
        None => format!("{WIP_PREFIX} {cut}"),
    })
}

/// The save-point message: the model's when it produced one in time, otherwise today's prompt-derived one.
pub fn choose_message(reply: Option<&serde_json::Value>, user_text: &str) -> String {
    reply.and_then(model_message).unwrap_or_else(|| wip_message(user_text))
}

/// Awaits a model call for at most `limit`; a timeout, an error and an Off task all read as None.
pub async fn bounded<T>(limit: Duration, call: impl std::future::Future<Output = anyhow::Result<Option<T>>>) -> Option<T> {
    tokio::time::timeout(limit, call).await.ok().and_then(Result::ok).flatten()
}

/// Only an explicit non-default model drafts PR text: a Claude draft would cost a call to produce what
/// the shipping agent writes anyway, while a local model does the drafting for free.
pub fn pr_draft_enabled(task_setting: &str) -> bool {
    task_setting.starts_with("local:")
}

pub const PR_SYSTEM: &str = "You draft pull request descriptions. The title is conventional-commit style (\"feat: ...\", \"fix: ...\"), \
at most 70 characters. The body has a \"What\" paragraph (1-3 sentences, why the change exists) and a \"Changes\" bullet list. \
Describe only what the diff shows; do not invent testing that was not run.";

pub fn pr_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": { "title": { "type": "string" }, "body": { "type": "string" } },
        "required": ["title", "body"]
    })
}

pub fn pr_prompt(branch: &str, base: &str, issue: Option<i64>, stat: &str, diff: &str) -> String {
    let issue = issue.map(|n| format!("Linked GitHub issue: #{n} (the body must end with \"Closes #{n}\").\n")).unwrap_or_default();
    format!(
        "Branch `{branch}`, opened against `{base}`.\n{issue}\nChanges (stat):\n{}\n\nDiff:\n{}",
        clip_chars(stat.trim(), 2_000),
        clip_chars(diff, DIFF_CAP)
    )
}

/// The extra-notes argument for `shipkit:ship`: the draft, flagged as something to verify.
pub fn pr_notes(reply: &serde_json::Value) -> Option<String> {
    let title = reply["title"].as_str()?.trim();
    let body = reply["body"].as_str()?.trim();
    if title.is_empty() || body.is_empty() {
        return None;
    }
    Some(format!(
        "Orbit drafted this PR text from the diff. Check it against the changes, fix anything wrong, and use it for the PR.\nTitle: {}\n\n{}",
        title.lines().next().unwrap_or(title).trim(),
        clip_chars(body, 1_500)
    ))
}

pub fn is_wip(subject: &str) -> bool {
    subject.starts_with(WIP_PREFIX)
}

/// How many commits at the tip (newest first) are `wip:` commits.
pub fn leading_wip<S: AsRef<str>>(subjects_newest_first: &[S]) -> usize {
    subjects_newest_first.iter().take_while(|s| is_wip(s.as_ref())).count()
}

/// Result of the Ship gate for a check run: (may ship, raise the inbox flag).
pub fn gate(checks_mode: &str, passed: bool) -> (bool, bool) {
    match checks_mode {
        "off" => (true, false),
        "warn" => (true, !passed),
        _ => (passed, !passed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SyncAction {
    Skip,
    /// Only record how far behind/ahead the branch is.
    Record,
    Rebase,
}

/// What a sync pass may do to one workspace. Never touches a running one.
pub fn sync_action(mode: &str, behind: i64, clean: bool, running: bool) -> SyncAction {
    if mode == "off" || running {
        return SyncAction::Skip;
    }
    if mode == "auto" && clean && behind > 0 {
        SyncAction::Rebase
    } else {
        SyncAction::Record
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Overlap {
    pub a: String,
    pub b: String,
    pub files: Vec<String>,
}

/// Pairs of workspaces (ids) that changed at least one common file.
pub fn overlaps(changed: &[(String, Vec<String>)]) -> Vec<Overlap> {
    let mut out = vec![];
    for (i, (a, fa)) in changed.iter().enumerate() {
        for (b, fb) in &changed[i + 1..] {
            let mut files: Vec<String> = fa.iter().filter(|f| fb.contains(f)).cloned().collect();
            files.sort();
            files.dedup();
            if !files.is_empty() {
                out.push(Overlap { a: a.clone(), b: b.clone(), files });
            }
        }
    }
    out
}

// ---- git operations (run in a worktree) ----

/// `origin/<base>` when it exists, else the local base branch.
pub fn base_ref(worktree: &Path, base: &str) -> String {
    let origin = format!("origin/{base}");
    if git::run(worktree, &["rev-parse", "--verify", "--quiet", &origin]).is_ok() { origin } else { base.to_string() }
}

/// Commits everything as a `wip:` save point; false when there was nothing to commit.
pub fn commit_save_point(worktree: &Path, message: &str) -> anyhow::Result<bool> {
    if git::is_clean(worktree) {
        return Ok(false);
    }
    git::run(worktree, &["add", "-A"])?;
    // Hooks and signing are for the real commits the agent writes at Ship, not for save points.
    git::run(worktree, &["-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", message])?;
    Ok(true)
}

fn is_pushed(worktree: &Path) -> bool {
    git::run(worktree, &["merge-base", "--is-ancestor", "HEAD", "@{u}"]).is_ok()
}

/// Drops the newest save point (and any uncommitted edits made since). Only when HEAD is an unpushed `wip:` commit.
pub fn undo_save_point(worktree: &Path) -> anyhow::Result<()> {
    let subject = git::run(worktree, &["log", "-1", "--format=%s"])?;
    if !is_wip(&subject) {
        anyhow::bail!("The last turn has no Orbit save point to undo (it was committed by the agent, or save points are off)");
    }
    if is_pushed(worktree) {
        anyhow::bail!("The last save point is already pushed, so it can't be undone here");
    }
    git::run(worktree, &["reset", "--hard", "HEAD~1"])?;
    Ok(())
}

/// Folds the unpushed run of `wip:` commits at the tip back into the index (`reset --soft`), so the
/// agent's ship writes conventional commits. Returns how many were squashed. The lower bound is the
/// upstream if the branch has one, else the merge-base with base; non-wip commits are never touched.
pub fn squash_wip(worktree: &Path, base: &str) -> anyhow::Result<usize> {
    let lower = if git::run(worktree, &["rev-parse", "--verify", "--quiet", "@{u}"]).is_ok() {
        git::run(worktree, &["merge-base", "HEAD", "@{u}"])?
    } else {
        git::run(worktree, &["merge-base", "HEAD", &base_ref(worktree, base)])?
    };
    let log = git::run(worktree, &["log", "--first-parent", "--format=%s", &format!("{lower}..HEAD")])?;
    let subjects: Vec<&str> = log.lines().collect();
    let n = leading_wip(&subjects);
    if n > 0 {
        git::run(worktree, &["reset", "--soft", &format!("HEAD~{n}")])?;
    }
    Ok(n)
}

/// (behind, ahead) relative to base: commits base has that the branch lacks, and vice versa.
pub fn behind_ahead(worktree: &Path, base: &str) -> anyhow::Result<(i64, i64)> {
    let range = format!("{}...HEAD", base_ref(worktree, base));
    let out = git::run(worktree, &["rev-list", "--left-right", "--count", &range])?;
    let mut it = out.split_whitespace().map(|n| n.parse::<i64>().unwrap_or(0));
    Ok((it.next().unwrap_or(0), it.next().unwrap_or(0)))
}

#[derive(Debug, PartialEq)]
pub enum RebaseOutcome {
    Clean,
    /// Conflicting files; the rebase has been aborted and the branch is untouched.
    Conflict(Vec<String>),
    Failed(String),
}

pub fn try_rebase(worktree: &Path, base: &str) -> RebaseOutcome {
    let target = base_ref(worktree, base);
    match git::run(worktree, &["rebase", &target]) {
        Ok(_) => RebaseOutcome::Clean,
        Err(e) => {
            let files: Vec<String> = git::run(worktree, &["diff", "--name-only", "--diff-filter=U"])
                .map(|o| o.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
                .unwrap_or_default();
            let _ = git::run(worktree, &["rebase", "--abort"]);
            if files.is_empty() { RebaseOutcome::Failed(e.to_string()) } else { RebaseOutcome::Conflict(files) }
        }
    }
}

// ---- orchestration (needs app state) ----

/// After a turn: commit the worktree as a save point (if enabled), then refresh behind/ahead.
/// Runs on a blocking thread; never holds the db lock across git calls.
pub fn save_point(app: &AppHandle, state: &AppState, ws_id: &str) {
    let settings = state.settings();
    let found = state.db().workspace(ws_id);
    let ws = match found {
        Ok(w) => w,
        Err(_) => return,
    };
    // A Simplify step commits (or reverts) its own result; a save point would swallow it as `wip:`.
    if settings.save_commits && !crate::simplify::active(ws_id) {
        let text = state.db().last_user_text(ws_id).unwrap_or_default();
        let msg = if settings.commit_messages == "model" { written_message(state, &settings, Path::new(&ws.path), &text) } else { wip_message(&text) };
        let _g = lock();
        if let Err(e) = commit_save_point(Path::new(&ws.path), &msg) {
            eprintln!("save point for {} failed: {e}", ws.name);
        }
    }
    let base = state.db().repo(&ws.repo_id).map(|r| r.base_branch).unwrap_or_default();
    if let Some(w) = sync_one(state, ws_id, &base, "suggest") {
        emit_workspace(app, &w);
    }
}

/// Stages everything and returns (stat, diff) of what a save point would commit; None when the tree is clean.
fn staged_summary(worktree: &Path) -> Option<(String, String)> {
    let _g = lock();
    if git::is_clean(worktree) {
        return None;
    }
    git::run(worktree, &["add", "-A"]).ok()?;
    Some((git::run(worktree, &["diff", "--cached", "--stat"]).ok()?, git::run(worktree, &["diff", "--cached"]).unwrap_or_default()))
}

/// The save-point message when "Written by a model" is on. Runs on the blocking save-point thread with
/// no git lock held; any failure or a call slower than the local timeout falls back to the prompt-derived
/// message, so a save point never waits on a model for long.
fn written_message(state: &AppState, settings: &crate::settings::Settings, worktree: &Path, user_text: &str) -> String {
    let Some((stat, diff)) = staged_summary(worktree) else { return wip_message(user_text) };
    let prompt = commit_prompt(user_text, &stat, &diff);
    let schema = commit_schema();
    let call = crate::llm::complete_json(state, crate::llm::Task::CommitMessage, COMMIT_SYSTEM, &prompt, &schema);
    let reply = tauri::async_runtime::block_on(bounded(Duration::from_secs(settings.local_timeout_secs), call));
    choose_message(reply.as_ref(), user_text)
}

/// Syncs one workspace per `mode`; returns the updated row if anything stored changed.
fn sync_one(state: &AppState, id: &str, base: &str, mode: &str) -> Option<Workspace> {
    let ws = state.db().workspace(id).ok()?;
    let path = PathBuf::from(&ws.path);
    if !path.is_dir() {
        return None;
    }
    let (behind, ahead) = behind_ahead(&path, base).ok()?;
    let mut conflicts = ws.sync_conflicts.clone();
    match sync_action(mode, behind, git::is_clean(&path), ws.status == "running") {
        SyncAction::Skip => return None,
        SyncAction::Record => {}
        SyncAction::Rebase => {
            let _g = lock();
            // The agent may have started since we looked; re-check right before touching the tree.
            let fresh = state.db().workspace(id).ok()?;
            if fresh.status == "running" || !git::is_clean(&path) {
                return None;
            }
            match try_rebase(&path, base) {
                RebaseOutcome::Clean => conflicts.clear(),
                RebaseOutcome::Conflict(files) => conflicts = files,
                RebaseOutcome::Failed(_) => return None,
            }
        }
    }
    let (behind, ahead) = behind_ahead(&path, base).unwrap_or((behind, ahead));
    if behind == 0 {
        conflicts.clear();
    }
    if (behind, ahead) == (ws.behind, ws.ahead) && conflicts == ws.sync_conflicts {
        return None;
    }
    state.db().set_sync(id, behind, ahead, &conflicts).ok()
}

/// Fetches base for the repo, then syncs its workspaces (`priority` ids first). `only` limits the
/// pass to one workspace and forces a rebase attempt even in Suggest mode (the user asked for it).
pub async fn sync_repo(app: &AppHandle, state: &AppState, repo_id: &str, priority: &[String], only: Option<&str>) {
    let mode = if only.is_some() { "auto".to_string() } else { state.settings().sync_mode };
    if mode == "off" {
        return;
    }
    let found = state.db().repo(repo_id);
    let repo = match found {
        Ok(r) => r,
        Err(_) => return,
    };
    let (rp, base) = (PathBuf::from(&repo.path), repo.base_branch.clone());
    let _ = tauri::async_runtime::spawn_blocking(move || git::run(&rp, &["fetch", "origin", &base, "--quiet"])).await;
    let mut list: Vec<Workspace> = state.db().workspaces().unwrap_or_default();
    list.retain(|w| w.repo_id == repo_id && only.map_or(true, |o| o == w.id));
    list.sort_by_key(|w| priority.iter().position(|p| *p == w.id).unwrap_or(usize::MAX));
    for w in list {
        let (st, id, base, mode) = (state.clone(), w.id.clone(), repo.base_branch.clone(), mode.clone());
        if let Ok(Some(updated)) = tauri::async_runtime::spawn_blocking(move || sync_one(&st, &id, &base, &mode)).await {
            emit_workspace(app, &updated);
        }
    }
}

/// Background loop: fetch + sync every `syncIntervalMinutes`. Settings are re-read each round.
pub fn start(app: AppHandle, state: AppState) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let repos = state.db().repos().unwrap_or_default();
            for r in repos {
                sync_repo(&app, &state, &r.id, &[], None).await;
            }
            let minutes = state.settings().sync_interval_minutes.max(1) as u64;
            tokio::time::sleep(Duration::from_secs(minutes * 60)).await;
        }
    });
}

fn changed_files(ws: &Workspace, base: &str) -> Vec<String> {
    git::changes(Path::new(&ws.path), base).map(|c| c.into_iter().map(|f| f.path).collect()).unwrap_or_default()
}

/// Overlaps among live workspaces of each repo.
fn compute_overlaps(workspaces: Vec<Workspace>, repos: &[crate::db::Repo]) -> Vec<Overlap> {
    let mut out = vec![];
    for repo in repos {
        let changed: Vec<(String, Vec<String>)> = workspaces
            .iter()
            .filter(|w| w.repo_id == repo.id && Path::new(&w.path).is_dir())
            .map(|w| (w.id.clone(), changed_files(w, &repo.base_branch)))
            .collect();
        out.extend(overlaps(&changed));
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub archived: bool,
}

/// Runs after a successful merge: archive the workspace (if enabled), then sync the repo's other
/// workspaces, those overlapping the merged one first.
pub async fn after_merge(app: &AppHandle, state: &AppState, ws_id: &str) -> MergeOutcome {
    let settings = state.settings();
    let Ok(ws) = state.db().workspace(ws_id) else { return MergeOutcome { archived: false } };
    let Ok(repo) = state.db().repo(&ws.repo_id) else { return MergeOutcome { archived: false } };
    let all = state.db().workspaces().unwrap_or_default();
    let (repos, merged_id) = (vec![repo.clone()], ws.id.clone());
    let overlapping: Vec<String> = tauri::async_runtime::spawn_blocking(move || {
        compute_overlaps(all, &repos)
            .into_iter()
            .filter_map(|o| if o.a == merged_id { Some(o.b) } else if o.b == merged_id { Some(o.a) } else { None })
            .collect()
    })
    .await
    .unwrap_or_default();

    let mut archived = false;
    if settings.archive_on_merge {
        archived = archive_merged(state, &ws, &repo, settings.delete_local_branch).await;
    }
    let (app2, st2, repo_id) = (app.clone(), state.clone(), repo.id.clone());
    tauri::async_runtime::spawn(async move { sync_repo(&app2, &st2, &repo_id, &overlapping, None).await });
    MergeOutcome { archived }
}

/// Archives a merged workspace and removes its worktree (and, optionally, its local branch).
/// Keeps everything when the worktree has uncommitted or unpushed work.
async fn archive_merged(state: &AppState, ws: &Workspace, repo: &crate::db::Repo, delete_branch: bool) -> bool {
    let (repo_path, wt, branch) = (PathBuf::from(&repo.path), PathBuf::from(&ws.path), ws.branch.clone());
    let wt2 = wt.clone();
    let safe = tauri::async_runtime::spawn_blocking(move || {
        !wt2.is_dir()
            || (git::is_clean(&wt2)
                && git::run(&wt2, &["rev-list", "--count", "@{u}..HEAD"]).map(|n| n.trim() == "0").unwrap_or(true))
    })
    .await
    .unwrap_or(false);
    if !safe {
        return false;
    }
    let taken = state.sessions.lock().unwrap().remove(&ws.id);
    if let Some(h) = taken {
        h.send(Command::Shutdown);
    }
    let removed = tauri::async_runtime::spawn_blocking(move || {
        if wt.is_dir() && git::remove_worktree(&repo_path, &wt).is_err() {
            return false;
        }
        if delete_branch {
            let _ = git::run(&repo_path, &["branch", "-D", &branch]);
        }
        true
    })
    .await
    .unwrap_or(false);
    if !removed {
        return false;
    }
    state.db().archive_workspace(&ws.id).is_ok()
}

// ---- commands ----

#[tauri::command]
pub fn get_check_command(state: State<AppState>, repo_id: String) -> CmdResult<CheckCommandInfo> {
    let repo = state.db().repo(&repo_id).map_err(err)?;
    let override_cmd = state.db().check_command(&repo_id).map_err(err)?;
    Ok(CheckCommandInfo { detected: checks::detect(Path::new(&repo.path)), override_cmd })
}

#[tauri::command]
pub fn set_check_command(state: State<AppState>, repo_id: String, cmd: Option<String>) -> CmdResult<()> {
    let cmd = cmd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    state.db().set_check_command(&repo_id, cmd.as_deref()).map_err(err)
}

/// The command for a workspace's repo, resolved against its worktree.
pub fn resolve_command(state: &AppState, ws: &Workspace) -> Option<String> {
    let override_cmd = state.db().check_command(&ws.repo_id).ok().flatten();
    checks::effective(Path::new(&ws.path), override_cmd.as_deref())
}

/// Timeout and install behaviour for a check run, from Settings > Git.
pub fn run_options(state: &AppState) -> checks::RunOptions {
    let s = state.settings();
    checks::RunOptions { timeout: Duration::from_secs(s.check_timeout_minutes as u64 * 60), install: s.install_before_checks }
}

async fn run_and_record(app: &AppHandle, state: &AppState, ws: &Workspace, cmd: String, flag_on_fail: bool) -> CmdResult<CheckResult> {
    let wt = PathBuf::from(&ws.path);
    let opts = run_options(state);
    let result = tauri::async_runtime::spawn_blocking(move || checks::run(&wt, &cmd, opts)).await.map_err(err)?;
    let failed = flag_on_fail && !result.ok;
    let updated = state.db().set_checks(&ws.id, failed, &result.command, &result.output_tail).map_err(err)?;
    emit_workspace(app, &updated);
    Ok(result)
}

#[tauri::command]
pub async fn run_checks(app: AppHandle, state: State<'_, AppState>, workspace_id: String) -> CmdResult<CheckResult> {
    let state: AppState = state.inner().clone();
    let ws = state.db().workspace(&workspace_id).map_err(err)?;
    let cmd = resolve_command(&state, &ws).ok_or("No check command found for this repo. Set one in Settings > Git.")?;
    run_and_record(&app, &state, &ws, cmd, true).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareShip {
    pub ok: bool,
    pub checks: Option<CheckResult>,
    pub squashed: usize,
    /// A PR title and body Orbit drafted (only when Settings > Models points PR drafts at a local model);
    /// pass it to `shipkit:ship` as its extra-notes argument.
    pub notes: Option<String>,
}

/// The Ship gate: runs checks per `checksMode`, then squashes unpushed save points. `ok: false`
/// means the UI must not run `shipkit:ship`.
#[tauri::command]
pub async fn prepare_ship(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: String,
    skip_checks: Option<bool>,
) -> CmdResult<PrepareShip> {
    prepare_ship_inner(&app, state.inner(), &workspace_id, skip_checks == Some(true)).await
}

pub(crate) async fn prepare_ship_inner(app: &AppHandle, state: &AppState, workspace_id: &str, skip_checks: bool) -> CmdResult<PrepareShip> {
    let ws = state.db().workspace(workspace_id).map_err(err)?;
    if ws.status == "running" {
        return Err("Wait for the current turn to finish before shipping".into());
    }
    let settings = state.settings();
    let mut result = None;
    if skip_checks {
        if ws.checks_failed {
            // Bind first: an `if let` keeps the db guard alive through its body (edition 2021).
            let cleared = state.db().clear_checks_failed(&ws.id).unwrap_or(false);
            let updated = if cleared { state.db().workspace(&ws.id).ok() } else { None };
            if let Some(w) = updated {
                emit_workspace(app, &w);
            }
        }
    } else if settings.checks_mode != "off" {
        if let Some(cmd) = resolve_command(state, &ws) {
            let r = run_and_record(app, state, &ws, cmd, true).await?;
            let (proceed, _) = gate(&settings.checks_mode, r.ok);
            result = Some(r);
            if !proceed {
                return Ok(PrepareShip { ok: false, checks: result, squashed: 0, notes: None });
            }
        }
    }
    let base = state.db().repo(&ws.repo_id).map_err(err)?.base_branch;
    let wt = PathBuf::from(&ws.path);
    let mut squashed = 0;
    if settings.squash_wip {
        let (wt, base) = (wt.clone(), base.clone());
        squashed = tauri::async_runtime::spawn_blocking(move || {
            let _g = lock();
            squash_wip(&wt, &base)
        })
        .await
        .map_err(err)?
        .map_err(err)?;
    }
    let notes = if pr_draft_enabled(&settings.model_pr_description) { draft_pr(state, &settings, &ws, &wt, &base).await } else { None };
    Ok(PrepareShip { ok: true, checks: result, squashed, notes })
}

/// Drafts the PR title and body from the branch's diff. Best effort: any failure or a call slower than
/// the local timeout just means the shipping agent writes the PR itself, as it always did.
async fn draft_pr(state: &AppState, settings: &crate::settings::Settings, ws: &Workspace, wt: &Path, base: &str) -> Option<String> {
    let (wt, base2) = (wt.to_path_buf(), base.to_string());
    let (stat, diff) = tauri::async_runtime::spawn_blocking(move || {
        // Working tree against the merge-base: committed work plus anything the squash left staged.
        let mb = git::run(&wt, &["merge-base", "HEAD", &base_ref(&wt, &base2)]).ok()?;
        Some((git::run(&wt, &["diff", "--stat", &mb]).ok()?, git::run(&wt, &["diff", &mb]).ok()?))
    })
    .await
    .ok()??;
    if diff.trim().is_empty() {
        return None;
    }
    let prompt = pr_prompt(&ws.branch, base, ws.issue_number, &stat, &diff);
    let schema = pr_schema();
    let call = crate::llm::complete_json(state, crate::llm::Task::PrDescription, PR_SYSTEM, &prompt, &schema);
    let reply = bounded(Duration::from_secs(settings.local_timeout_secs), call).await?;
    pr_notes(&reply)
}

#[tauri::command]
pub async fn undo_last_turn(app: AppHandle, state: State<'_, AppState>, workspace_id: String) -> CmdResult<()> {
    let state: AppState = state.inner().clone();
    let ws = state.db().workspace(&workspace_id).map_err(err)?;
    if ws.status == "running" {
        return Err("Stop the agent before undoing its last turn".into());
    }
    let wt = PathBuf::from(&ws.path);
    tauri::async_runtime::spawn_blocking(move || {
        let _g = lock();
        undo_save_point(&wt)
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    let base = state.db().repo(&ws.repo_id).map(|r| r.base_branch).unwrap_or_default();
    let st = state.clone();
    let id = ws.id.clone();
    if let Ok(Some(w)) = tauri::async_runtime::spawn_blocking(move || sync_one(&st, &id, &base, "suggest")).await {
        emit_workspace(&app, &w);
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_overlaps(state: State<'_, AppState>) -> CmdResult<Vec<Overlap>> {
    let workspaces = state.db().workspaces().map_err(err)?;
    let repos = state.db().repos().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || compute_overlaps(workspaces, &repos)).await.map_err(err)
}

/// Fetches base and rebases this workspace now (even in Suggest mode); conflicts land in the inbox.
#[tauri::command]
pub async fn sync_now(app: AppHandle, state: State<'_, AppState>, workspace_id: String) -> CmdResult<Workspace> {
    let state: AppState = state.inner().clone();
    let ws = state.db().workspace(&workspace_id).map_err(err)?;
    if ws.status == "running" {
        return Err("Wait for the current turn to finish before syncing".into());
    }
    sync_repo(&app, &state, &ws.repo_id, &[], Some(&ws.id)).await;
    let latest = state.db().workspace(&workspace_id).map_err(err);
    latest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("orbit-trunk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn g(d: &Path, args: &[&str]) -> String {
        git::run(d, args).unwrap()
    }

    /// A repo on `main` with one commit.
    fn repo() -> PathBuf {
        let d = tmp();
        g(&d, &["init", "-q", "-b", "main"]);
        g(&d, &["config", "user.email", "t@example.com"]);
        g(&d, &["config", "user.name", "Test"]);
        g(&d, &["config", "commit.gpgsign", "false"]);
        std::fs::write(d.join("a.txt"), "one\n").unwrap();
        g(&d, &["add", "-A"]);
        g(&d, &["commit", "-q", "-m", "init"]);
        d
    }

    fn commit_file(d: &Path, name: &str, body: &str, msg: &str) {
        std::fs::write(d.join(name), body).unwrap();
        g(d, &["add", "-A"]);
        g(d, &["commit", "-q", "-m", msg]);
    }

    fn head_subject(d: &Path) -> String {
        g(d, &["log", "-1", "--format=%s"])
    }

    #[test]
    fn wip_messages() {
        assert_eq!(wip_message("Fix the login bug\nmore detail"), "wip: Fix the login bug");
        assert_eq!(wip_message("\n  \n"), "wip: save point");
        let long = wip_message(&"x".repeat(100));
        assert_eq!(long.chars().count(), "wip: ".len() + 61);
        assert!(long.ends_with('…'));
        assert!(is_wip("wip: a") && !is_wip("feat: wip: a"));
    }

    #[test]
    fn commit_prompt_is_capped_and_carries_the_inputs() {
        let big = "+line\n".repeat(10_000);
        let p = commit_prompt("Fix the login bug\nplease", " a.ts | 2 +-", &big);
        assert!(p.contains("Fix the login bug") && p.contains("a.ts | 2 +-") && p.contains("(cut short)"));
        assert!(p.chars().count() < DIFF_CAP + 1_000, "the prompt must stay small, got {}", p.chars().count());
        let small = commit_prompt("hi", "", "+x");
        assert!(small.contains("+x") && !small.contains("(cut short)"));
    }

    #[test]
    fn model_messages_keep_the_wip_prefix_and_fall_back() {
        use serde_json::json;
        assert_eq!(model_message(&json!({ "subject": "Add retry to sync.", "body": "" })).unwrap(), "wip: Add retry to sync");
        assert_eq!(
            model_message(&json!({ "subject": "\"wip: Add retry\"\nignored", "body": " Because flaky. " })).unwrap(),
            "wip: Add retry\n\nBecause flaky."
        );
        let long = model_message(&json!({ "subject": "x".repeat(100), "body": "" })).unwrap();
        assert!(is_wip(&long) && long.chars().count() <= "wip: ".len() + 61);
        assert_eq!(model_message(&json!({ "subject": "  ", "body": "b" })), None);
        assert_eq!(model_message(&json!({ "body": "b" })), None);
        // choose_message: a usable reply wins, anything else is today's prompt-derived message.
        let ok = json!({ "subject": "Add retry", "body": "" });
        assert_eq!(choose_message(Some(&ok), "Fix the login bug"), "wip: Add retry");
        assert_eq!(choose_message(None, "Fix the login bug"), "wip: Fix the login bug");
        assert_eq!(choose_message(Some(&json!({ "subject": "" })), "Fix the login bug"), "wip: Fix the login bug");
    }

    #[tokio::test]
    async fn a_slow_or_failed_model_call_reads_as_none() {
        let limit = Duration::from_millis(50);
        assert_eq!(bounded(limit, async { Ok(Some(1)) }).await, Some(1));
        assert_eq!(bounded::<i32>(limit, async { Ok(None) }).await, None);
        assert_eq!(bounded::<i32>(limit, async { anyhow::bail!("down") }).await, None);
        let slow = async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok(Some(2))
        };
        let started = std::time::Instant::now();
        assert_eq!(bounded(limit, slow).await, None);
        assert!(started.elapsed() < Duration::from_secs(2), "the timeout must cut the call short");
    }

    #[test]
    fn pr_drafts_only_for_a_chosen_local_model() {
        use serde_json::json;
        assert!(!pr_draft_enabled("default") && pr_draft_enabled("local:llama3.2:3b"));
        let p = pr_prompt("feat/x", "main", Some(12), " a.ts | 2 +-", "+x");
        assert!(p.contains("`feat/x`") && p.contains("`main`") && p.contains("#12") && p.contains("+x"));
        assert!(!pr_prompt("b", "main", None, "", "").contains("issue"));
        let notes = pr_notes(&json!({ "title": "feat: add x\nextra", "body": "## What\nx" })).unwrap();
        assert!(notes.contains("Title: feat: add x\n") && notes.contains("## What") && notes.contains("Check it against the changes"));
        assert_eq!(pr_notes(&json!({ "title": "", "body": "b" })), None);
        assert_eq!(pr_notes(&json!({ "title": "t" })), None);
    }

    #[test]
    fn leading_wip_counts_only_the_tip_run() {
        assert_eq!(leading_wip(&["wip: b", "wip: a", "feat: x", "wip: old"]), 2);
        assert_eq!(leading_wip(&["feat: x", "wip: a"]), 0);
        assert_eq!(leading_wip::<&str>(&[]), 0);
    }

    #[test]
    fn checks_gate_modes() {
        assert_eq!(gate("block", false), (false, true));
        assert_eq!(gate("block", true), (true, false));
        // Warn: the flag is raised for the inbox but Ship proceeds.
        assert_eq!(gate("warn", false), (true, true));
        assert_eq!(gate("warn", true), (true, false));
        assert_eq!(gate("off", false), (true, false));
    }

    #[test]
    fn sync_modes() {
        use SyncAction::*;
        assert_eq!(sync_action("auto", 3, true, false), Rebase);
        // Suggest only records; automatic never rebases a dirty tree, a current branch or a running agent.
        assert_eq!(sync_action("suggest", 3, true, false), Record);
        assert_eq!(sync_action("auto", 3, false, false), Record);
        assert_eq!(sync_action("auto", 0, true, false), Record);
        assert_eq!(sync_action("auto", 3, true, true), Skip);
        assert_eq!(sync_action("off", 3, true, false), Skip);
    }

    #[test]
    fn overlap_pairs() {
        let list = vec![
            ("a".to_string(), vec!["x.rs".to_string(), "y.rs".to_string()]),
            ("b".to_string(), vec!["y.rs".to_string(), "z.rs".to_string()]),
            ("c".to_string(), vec!["q.rs".to_string()]),
        ];
        assert_eq!(overlaps(&list), vec![Overlap { a: "a".into(), b: "b".into(), files: vec!["y.rs".into()] }]);
        assert!(overlaps(&list[2..]).is_empty());
    }

    #[test]
    fn save_point_commits_dirty_tree_once() {
        let d = repo();
        assert!(!commit_save_point(&d, "wip: nothing").unwrap());
        std::fs::write(d.join("a.txt"), "two\n").unwrap();
        std::fs::write(d.join("new.txt"), "n\n").unwrap();
        assert!(commit_save_point(&d, "wip: edit a").unwrap());
        assert_eq!(head_subject(&d), "wip: edit a");
        assert!(git::is_clean(&d));
        assert!(!commit_save_point(&d, "wip: again").unwrap());
    }

    #[test]
    fn squash_folds_tip_wip_run_only() {
        let d = repo();
        g(&d, &["checkout", "-q", "-b", "feat"]);
        commit_file(&d, "a.txt", "feat\n", "wip: early");
        commit_file(&d, "b.txt", "b\n", "feat: real commit");
        commit_file(&d, "c.txt", "c\n", "wip: one");
        commit_file(&d, "d.txt", "d\n", "wip: two");
        assert_eq!(squash_wip(&d, "main").unwrap(), 2);
        assert_eq!(head_subject(&d), "feat: real commit");
        // The squashed changes are staged, not lost.
        let staged = g(&d, &["diff", "--cached", "--name-only"]);
        assert!(staged.contains("c.txt") && staged.contains("d.txt"));
        assert_eq!(squash_wip(&d, "main").unwrap(), 0);
    }

    #[test]
    fn squash_all_wip_resets_to_base() {
        let d = repo();
        let base = g(&d, &["rev-parse", "HEAD"]);
        g(&d, &["checkout", "-q", "-b", "feat"]);
        commit_file(&d, "b.txt", "b\n", "wip: one");
        commit_file(&d, "c.txt", "c\n", "wip: two");
        assert_eq!(squash_wip(&d, "main").unwrap(), 2);
        assert_eq!(g(&d, &["rev-parse", "HEAD"]), base);
        assert!(g(&d, &["diff", "--cached", "--name-only"]).contains("b.txt"));
    }

    #[test]
    fn undo_only_unpushed_wip_head() {
        let d = repo();
        commit_file(&d, "b.txt", "b\n", "feat: not a save point");
        assert!(undo_save_point(&d).is_err());
        commit_file(&d, "c.txt", "c\n", "wip: turn");
        undo_save_point(&d).unwrap();
        assert_eq!(head_subject(&d), "feat: not a save point");
        assert!(!d.join("c.txt").exists());
    }

    #[test]
    fn undo_refuses_pushed_save_points() {
        let d = repo();
        let remote = tmp();
        g(&remote, &["init", "-q", "--bare", "-b", "main"]);
        g(&d, &["remote", "add", "origin", &remote.to_string_lossy()]);
        commit_file(&d, "c.txt", "c\n", "wip: pushed");
        g(&d, &["push", "-q", "-u", "origin", "main"]);
        assert!(undo_save_point(&d).is_err());
        assert!(d.join("c.txt").exists());
    }

    #[test]
    fn rebase_clean_and_behind_ahead() {
        let d = repo();
        g(&d, &["checkout", "-q", "-b", "feat"]);
        commit_file(&d, "f.txt", "f\n", "feat: f");
        g(&d, &["checkout", "-q", "main"]);
        commit_file(&d, "m.txt", "m\n", "chore: m");
        g(&d, &["checkout", "-q", "feat"]);
        assert_eq!(behind_ahead(&d, "main").unwrap(), (1, 1));
        assert_eq!(try_rebase(&d, "main"), RebaseOutcome::Clean);
        assert_eq!(behind_ahead(&d, "main").unwrap(), (0, 1));
    }

    #[test]
    fn rebase_conflict_is_detected_and_aborted() {
        let d = repo();
        g(&d, &["checkout", "-q", "-b", "feat"]);
        commit_file(&d, "a.txt", "feature side\n", "feat: edit a");
        let before = g(&d, &["rev-parse", "HEAD"]);
        g(&d, &["checkout", "-q", "main"]);
        commit_file(&d, "a.txt", "main side\n", "chore: edit a on main");
        g(&d, &["checkout", "-q", "feat"]);
        assert_eq!(try_rebase(&d, "main"), RebaseOutcome::Conflict(vec!["a.txt".into()]));
        // Aborted: same commit, no rebase in progress, clean tree.
        assert_eq!(g(&d, &["rev-parse", "HEAD"]), before);
        assert!(!d.join(".git/rebase-merge").exists() && !d.join(".git/rebase-apply").exists());
        assert!(git::is_clean(&d));
    }
}
