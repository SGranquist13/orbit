// Deadlock guard: `match state.db()...`/`if let ... = x.lock()...` keep the MutexGuard alive through the body.
// Enforced by `bun run check:guards` (clippy); bind the value first.
#![deny(clippy::significant_drop_in_scrutinee)]

mod agent;
mod checks;
mod code;
mod db;
mod gh;
mod git;
mod llm;
mod maintenance;
mod related;
mod remote;
mod routines;
mod settings;
mod simplify;
mod skills;
mod chief;
mod handoff;
mod teammates;
mod trunk;
mod usage;

use agent::{AgentEvent, AgentKind, Command, SessionConfig, SessionHandle};
use db::{Attachment, Db, Repo, StoredEvent, Workspace};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

const DEFAULT_PROFILE: &str = "shipkit:builder";

type CmdResult<T> = Result<T, String>;

/// Command error text. `{:#}` keeps anyhow's context chain (and is plain `Display` for other errors).
fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

/// Locks a mutex even if a panicking thread poisoned it: one panic must not brick every command.
pub(crate) fn relock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub struct Inner {
    db: Mutex<Db>,
    sessions: Mutex<HashMap<String, SessionHandle>>,
    /// One-shot notes prepended to the next message after a profile switch.
    role_notices: Mutex<HashMap<String, String>>,
    home: PathBuf,
}

type AppState = Arc<Inner>;

impl Inner {
    fn db(&self) -> std::sync::MutexGuard<'_, Db> {
        relock(&self.db)
    }

    fn sessions_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, SessionHandle>> {
        relock(&self.sessions)
    }

    fn notices_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        relock(&self.role_notices)
    }

    fn disabled_packs(&self) -> Vec<String> {
        self.db()
            .setting("disabled_packs")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn packs(&self) -> anyhow::Result<Vec<skills::Pack>> {
        skills::list_packs(&self.home, &self.disabled_packs())
    }

    /// Plugin dirs are fixed at spawn, so idle sessions are dropped after pack changes;
    /// the next message respawns them with `--resume`. Running turns are left alone.
    fn restart_idle_sessions(&self) {
        let running: Vec<String> = self
            .db()
            .workspaces()
            .unwrap_or_default()
            .into_iter()
            .filter(|w| w.status == "running")
            .map(|w| w.id)
            .collect();
        self.sessions_lock().retain(|id, h| {
            let keep = running.contains(id);
            if !keep {
                h.send(Command::Shutdown);
            }
            keep
        });
    }

    /// Attached folders change `--add-dir`, which is fixed at spawn, so an idle session is
    /// dropped; the next message respawns it with `--resume` and the new folders.
    fn restart_session_if_idle(&self, workspace_id: &str) {
        let running = self.db().workspace(workspace_id).map(|w| w.status == "running").unwrap_or(false);
        if running {
            return;
        }
        let taken = self.sessions_lock().remove(workspace_id);
        if let Some(h) = taken {
            h.send(Command::Shutdown);
        }
    }

    /// Attached folders that still exist; missing ones are skipped rather than failing the spawn.
    fn live_attachments(&self, workspace_id: &str) -> Vec<Attachment> {
        let mut list = self.db().attachments(workspace_id).unwrap_or_default();
        list.retain(|a| Path::new(&a.path).is_dir());
        list
    }

    /// Current typed settings (defaults for anything unset; legacy `branch_prefix` honoured).
    fn settings(&self) -> settings::Settings {
        let db = self.db();
        let blob = db.setting(settings::KEY).ok().flatten();
        let legacy = db.setting(settings::LEGACY_BRANCH_PREFIX_KEY).ok().flatten();
        settings::Settings::load(blob.as_deref(), legacy.as_deref())
    }

    fn branch_prefix(&self) -> String {
        self.settings().branch_prefix
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEventPayload {
    workspace_id: String,
    seq: Option<i64>,
    ts: i64,
    event: AgentEvent,
}

fn emit_workspace(app: &AppHandle, ws: &Workspace) {
    remote::publish_workspace(ws);
    let _ = app.emit("workspace", ws);
}

/// Handles one normalized event: persist, update workspace status, notify, forward to UI.
fn on_agent_event(app: &AppHandle, state: &AppState, ws_id: &str, ev: AgentEvent) {
    // Drafts are desktop UI previews only: bypass persistence and all turn bookkeeping hooks.
    // They stay off the mobile bridge: the phone protocol (ide_mobile/docs/protocol.md) has no such event.
    if matches!(ev, AgentEvent::ToolDraft { .. }) {
        let payload = AgentEventPayload { workspace_id: ws_id.to_string(), seq: None, ts: db::now(), event: ev };
        let _ = app.emit("agent-event", payload);
        return;
    }
    // The process died on its own (not our Shutdown, which has no exit code) while a turn was in flight:
    // end that turn as an error first, so the UI, routines and Simplify never wait on a TurnCompleted
    // that will not come.
    if let AgentEvent::Exited { code: Some(code), stderr } = &ev {
        let running = state.db().workspace(ws_id).map(|w| w.status == "running").unwrap_or(false);
        if running {
            let tail: String = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            let error = format!("The agent exited (code {code}) before finishing the turn.{}", if tail.is_empty() { String::new() } else { format!("\n{tail}") });
            on_agent_event(app, state, ws_id, AgentEvent::TurnCompleted { duration_ms: None, cost_usd: None, is_error: true, error: Some(error), interrupted: false });
        }
    }
    simplify::on_event(ws_id, &ev);
    let mut seq = None;
    let mut ts = db::now();
    let mut updated = None;
    {
        let db = state.db();
        if ev.is_persistent() {
            if let Ok(stored) = db.append_event(ws_id, &ev) {
                seq = Some(stored.seq);
                ts = stored.ts;
            }
        }
        match &ev {
            AgentEvent::SessionStarted { session_id, .. } if !session_id.is_empty() => {
                let _ = db.set_agent_session(ws_id, session_id);
            }
            // A new message supersedes the last failed-checks flag.
            AgentEvent::UserMessage { .. } => {
                if db.clear_checks_failed(ws_id).unwrap_or(false) {
                    updated = db.workspace(ws_id).ok();
                }
            }
            AgentEvent::TurnStarted => updated = db.set_status(ws_id, "running").ok(),
            AgentEvent::TurnCompleted { is_error, interrupted, .. } => {
                let status = if *interrupted { "idle" } else if *is_error { "error" } else { "done" };
                updated = db.set_status(ws_id, status).ok()
            }
            AgentEvent::Exited { .. } => {
                let status = db.workspace(ws_id).map(|w| w.status).unwrap_or_default();
                updated = db.set_status(ws_id, if status == "running" { "error" } else { &status }).ok();
            }
            _ => {}
        }
    }
    if let AgentEvent::UserMessage { text, .. } = &ev {
        teammates::on_user_message(app, state, ws_id, text);
    }
    if let AgentEvent::TurnCompleted { is_error, error, interrupted, .. } = &ev {
        teammates::finish_turn(app, state, ws_id, *is_error, error.as_deref(), *interrupted);
        // A routine run defers its notification until it knows whether the run was worth reporting.
        let routine = routines::finish_turn(app, state, ws_id, updated.as_ref(), *is_error, error.as_deref(), *interrupted);
        // The user stopped it themselves, so no notification for interruptions.
        if !routine && !*interrupted {
            notify_turn_done(app, &state.settings(), updated.as_ref(), *is_error, error.as_deref());
            remote::on_turn_completed(state, updated.as_ref(), *is_error, error.as_deref());
        }
    }
    if let AgentEvent::Exited { .. } = &ev {
        routines::finish_exited(app, state, ws_id);
    }
    // Save point + sync bookkeeping happen off the event thread (and after the status update above).
    if matches!(ev, AgentEvent::TurnCompleted { .. }) {
        let (app2, state2, id) = (app.clone(), state.clone(), ws_id.to_string());
        tauri::async_runtime::spawn_blocking(move || trunk::save_point(&app2, &state2, &id));
    }
    let payload = AgentEventPayload { workspace_id: ws_id.to_string(), seq, ts, event: ev };
    remote::publish_event(&payload);
    let _ = app.emit("agent-event", payload);
    if let Some(ws) = updated {
        emit_workspace(app, &ws);
    }
}

pub(crate) fn notify_turn_done(app: &AppHandle, settings: &settings::Settings, ws: Option<&Workspace>, is_error: bool, error: Option<&str>) {
    if !settings.notifications {
        return;
    }
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    let Some(ws) = ws.filter(|_| !(focused && settings.notify_only_unfocused)) else { return };
    let body = if is_error { error.unwrap_or("Turn failed").to_string() } else { "Finished — ready for you".into() };
    let _ = app.notification().builder().title(&ws.name).body(body).show();
}

/// Appended to every agent's system prompt so shipping skills know the branch, base, and issue.
fn workspace_context(ws: &Workspace, repo: &Repo, attachments: &[Attachment], profile: Option<&skills::Profile>, teammate: Option<&str>, readonly: bool) -> String {
    let mut s = format!(
        "You are running inside an Orbit workspace named \"{}\".\n\
         - Repository: {}. Your working directory is a dedicated git worktree for this task; work only there.\n\
         - Branch: {}. Base branch: {} (open PRs against it).\n",
        ws.name, repo.name, ws.branch, repo.base_branch
    );
    if let Some(n) = ws.issue_number {
        s.push_str(&format!("- Linked GitHub issue: #{n}. PR descriptions must include \"Closes #{n}\".\n"));
    }
    if !attachments.is_empty() {
        s.push_str(
            "- Attached folders (other projects the developer works on; check them for consumers of anything you change):\n",
        );
        for a in attachments {
            match (&a.worktree_path, &a.branch, a.editable) {
                (Some(wt), Some(branch), true) => s.push_str(&format!(
                    "  - {wt} (editable worktree of {} on branch {branch}: you may edit and commit here; ship it alongside this workspace)\n",
                    a.path
                )),
                _ => s.push_str(&format!("  - {} (read-only reference: read it, never modify it)\n", a.path)),
            }
        }
    }
    if let Some(p) = profile {
        s.push_str(&format!("\n## Your role: {}\n{}\n", p.name, p.instructions));
    }
    if readonly {
        s.push_str("You are in a read-only role: do not create, edit, or delete files outside the scratch folder, and do not commit or push.\n");
        if let Ok(scratch) = agent::claude::scratch_dir() {
            s.push_str(&format!("Scratch folder for temporary files (the only place you can write): {}\n", scratch.display()));
        }
    }
    if let Some(t) = teammate {
        s.push_str(t);
    }
    s
}

/// The workspace's active profile: the stored id, else (or if it has vanished) shipkit:builder.
fn resolve_profile(state: &AppState, ws: &Workspace) -> Option<skills::Profile> {
    let all = skills::list_profiles(&state.packs().ok()?);
    let find = |id: &str| all.iter().find(|p| p.id == id).cloned();
    ws.profile.as_deref().and_then(find).or_else(|| find(DEFAULT_PROFILE))
}

fn ensure_session(app: &AppHandle, state: &AppState, ws: &Workspace) -> anyhow::Result<SessionHandle> {
    if let Some(h) = state.sessions_lock().get(&ws.id) {
        return Ok(h.clone());
    }
    let kind = AgentKind::parse(&ws.agent).ok_or_else(|| anyhow::anyhow!("unknown agent {}", ws.agent))?;
    let repo = state.db().repo(&ws.repo_id)?;
    // Only Claude loads plugins; Codex gets skills expanded inline by `run_skill`.
    let plugin_dirs = match kind {
        AgentKind::Claude => state.packs()?.into_iter().filter(|p| p.enabled).map(|p| PathBuf::from(p.path)).collect(),
        AgentKind::Codex => vec![],
    };
    let attachments = state.live_attachments(&ws.id);
    // Editable attachments point at their own worktree so edits stay isolated from the original.
    let add_dirs = match kind {
        AgentKind::Claude => attachments
            .iter()
            .map(|a| match (&a.worktree_path, a.editable) {
                (Some(wt), true) => PathBuf::from(wt),
                _ => PathBuf::from(&a.path),
            })
            .collect(),
        AgentKind::Codex => vec![],
    };
    let profile = resolve_profile(state, ws);
    // A teammate's workspace also carries who it is, its memory, and (for Claude) access to its notes folder.
    let teammate = ws.teammate.as_deref().and_then(|slug| teammates::get(&state.home, slug));
    let readonly = match &teammate {
        Some(t) => teammates::effective_readonly(t.readonly, profile.as_ref().is_some_and(|p| p.readonly)),
        None => profile.as_ref().is_some_and(|p| p.readonly),
    };
    let teammate_context = teammate.as_ref().map(|t| teammates::context_section(&state.home, t));
    let mut add_dirs = add_dirs;
    if teammate.is_some() && kind == AgentKind::Claude {
        add_dirs.push(teammates::dir(&state.home));
    }
    let settings = state.settings();
    let settings_local_ollama_url = settings.ollama_url();
    let cfg = SessionConfig {
        kind,
        cwd: PathBuf::from(&ws.path),
        model: ws.model.clone(),
        resume: ws.agent_session_id.clone(),
        plugin_dirs,
        add_dirs,
        instructions: Some(workspace_context(ws, &repo, &attachments, profile.as_ref(), teammate_context.as_deref(), readonly)),
        readonly,
        permission_mode: settings.claude_permission_mode,
        sandbox: settings.codex_sandbox,
        local_url: Some(settings_local_ollama_url),
    };
    let (app2, state2, id) = (app.clone(), state.clone(), ws.id.clone());
    let generation = agent::next_generation();
    let handle = agent::spawn(
        cfg,
        generation,
        Arc::new(move |ev| {
            let exited = matches!(ev, AgentEvent::Exited { .. });
            on_agent_event(&app2, &state2, &id, ev);
            if exited {
                // Only forget this session if it is still the current one: a restarted or reset
                // workspace may already have a newer session that must keep running.
                let mut sessions = state2.sessions_lock();
                if sessions.get(&id).is_some_and(|h| h.generation == generation) {
                    sessions.remove(&id);
                }
            }
        }),
    )?;
    state.sessions_lock().insert(ws.id.clone(), handle.clone());
    Ok(handle)
}

#[tauri::command]
fn list_repos(state: State<AppState>) -> CmdResult<Vec<Repo>> {
    state.db().repos().map_err(err)
}

#[tauri::command]
async fn add_repo(state: State<'_, AppState>, path: String) -> CmdResult<Repo> {
    // git runs off the main thread; the db lock is only taken afterwards.
    let repo = tauri::async_runtime::spawn_blocking(move || -> CmdResult<Repo> {
        if !git::git_available() {
            return Err(git::not_installed("git").replace("`git` is not installed", "Git is not installed"));
        }
        let top = git::toplevel(Path::new(&path)).map_err(|_| format!("{path} is not a git repository"))?;
        let name = top.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
        Ok(Repo {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            base_branch: git::default_branch(&top),
            path: top.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(err)??;
    let db = state.db();
    if let Some(existing) = db.repos().map_err(err)?.into_iter().find(|r| r.path == repo.path) {
        return Ok(existing);
    }
    db.insert_repo(&repo).map_err(err)?;
    Ok(repo)
}

#[tauri::command]
fn list_workspaces(state: State<AppState>) -> CmdResult<Vec<Workspace>> {
    state.db().workspaces().map_err(err)
}

pub(crate) struct NewWorkspaceArgs {
    pub repo_id: String,
    pub name: String,
    pub agent: String,
    pub model: Option<String>,
    pub issue_number: Option<i64>,
    pub profile: Option<String>,
    /// Set when a routine run creates the workspace.
    pub routine_id: Option<String>,
    /// Replaces the Settings branch prefix for this workspace (Simplify routines use `refactor/`).
    pub branch_prefix: Option<String>,
    /// Set when a teammate creates the workspace for a task.
    pub teammate: Option<String>,
    /// Branch or ref the worktree starts from instead of the repo's base (review hand-offs).
    pub start_ref: Option<String>,
}

/// Worktree + branch + DB row + attachments; shared by `create_workspace` and routine runs.
pub(crate) async fn create_workspace_inner(app: &AppHandle, state: &AppState, args: NewWorkspaceArgs) -> CmdResult<Workspace> {
    let NewWorkspaceArgs { repo_id, name, agent, model, issue_number, profile, routine_id, branch_prefix, teammate, start_ref } = args;
    AgentKind::parse(&agent).ok_or("unknown agent")?;
    let repo = state.db().repo(&repo_id).map_err(err)?;
    let slug = match issue_number {
        Some(n) => format!("{n}-{}", git::slugify(&name)),
        None => git::slugify(&name),
    };
    // Unique suffix keeps re-used names from colliding with existing branches/dirs.
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..4];
    let dir_name = format!("{slug}-{suffix}");
    let branch = format!("{}{slug}-{suffix}", branch_prefix.unwrap_or_else(|| state.branch_prefix()));
    let path = state.home.join("worktrees").join(&repo.name).join(&dir_name);

    let (repo_path, base, wt_path, br) = (PathBuf::from(&repo.path), repo.base_branch.clone(), path.clone(), branch.clone());
    tauri::async_runtime::spawn_blocking(move || match start_ref {
        Some(start) => git::create_worktree_from(&repo_path, &wt_path, &br, &start),
        None => git::create_worktree(&repo_path, &wt_path, &br, &base),
    })
        .await
        .map_err(err)?
        .map_err(err)?;

    let ts = db::now();
    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        repo_id,
        name,
        branch,
        path: path.to_string_lossy().to_string(),
        agent,
        model: model.filter(|m| !m.is_empty()),
        status: "idle".into(),
        agent_session_id: None,
        issue_number,
        created_at: ts,
        updated_at: ts,
        seen_seq: 0,
        dismissed_seq: 0,
        profile: profile.filter(|p| !p.is_empty()),
        snoozed_until: 0,
        routine_id,
        teammate,
        ..Default::default()
    };
    state.db().insert_workspace(&ws).map_err(err)?;
    // The repo's "always attach" folders (read-only); skip ones that have since disappeared.
    {
        let db = state.db();
        for p in db.related_defaults(&ws.repo_id).unwrap_or_default() {
            if Path::new(&p).is_dir() {
                let _ = db.add_attachment(&ws.id, &p);
            }
        }
    }
    emit_workspace(app, &ws);
    Ok(ws)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: one parameter per UI field
async fn create_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
    agent: String,
    model: Option<String>,
    prompt: Option<String>,
    issue_number: Option<i64>,
    profile: Option<String>,
) -> CmdResult<Workspace> {
    let ws = create_workspace_inner(&app, &state, NewWorkspaceArgs { repo_id, name, agent, model, issue_number, profile, routine_id: None, branch_prefix: None, teammate: None, start_ref: None }).await?;
    if let Some(p) = prompt.filter(|p| !p.trim().is_empty()) {
        // Issues already have titles, and a typed name is kept: only the auto-derived one is replaced.
        if issue_number.is_none() && is_derived_name(&ws.name, &p) {
            tauri::async_runtime::spawn(name_workspace(app.clone(), state.inner().clone(), ws.id.clone(), ws.name.clone(), p.clone()));
        }
        send(&app, &state, &ws.id, p.clone(), None, p).map_err(err)?;
    }
    Ok(ws)
}

/// True when `name` is just the (possibly truncated) first line of `prompt`, as the UI derives it.
fn is_derived_name(name: &str, prompt: &str) -> bool {
    let first_line = prompt.trim().lines().next().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    let n = name.trim_end_matches('…').trim();
    !n.is_empty() && first_line.starts_with(n)
}

/// Cleans a model-written workspace name: strips quotes and punctuation, at most 5 words, 40 chars.
fn clean_name(raw: &str) -> Option<String> {
    let words: Vec<&str> = raw
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '.')
        .split_whitespace()
        .take(5)
        .collect();
    let name: String = words.join(" ").chars().take(40).collect();
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// Replaces a workspace's prompt-derived display name with a short model-written one. Silent on
/// any failure (the original name stays); never touches the branch or worktree path.
async fn name_workspace(app: AppHandle, state: AppState, id: String, original: String, prompt: String) {
    let schema = serde_json::json!({ "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] });
    let system = "You name coding tasks. Reply with a short name of 2 to 5 words in sentence case, no quotes, no trailing punctuation.";
    let clipped: String = prompt.chars().take(800).collect();
    let Ok(Some(v)) = llm::complete_json(&state, llm::Task::WorkspaceName, system, &format!("Task:\n{clipped}"), &schema).await else { return };
    let Some(name) = v["name"].as_str().and_then(clean_name) else { return };
    // Bind each db result first: the guard must be dropped before the next lock.
    let current = state.db().workspace(&id);
    if !current.is_ok_and(|w| w.name == original) {
        return;
    }
    let updated = state.db().set_name(&id, &name);
    if let Ok(ws) = updated {
        emit_workspace(&app, &ws);
    }
}

/// Creates a workspace for a GitHub issue (no prompt) and runs `shipkit:start-issue` on it,
/// so the agent reads the issue itself via `gh`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: one parameter per UI field
async fn start_issue(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    number: i64,
    title: String,
    profile: Option<String>,
    agent: String,
    model: Option<String>,
) -> CmdResult<Workspace> {
    let profile = profile.filter(|p| !p.is_empty()).or_else(|| Some(DEFAULT_PROFILE.to_string()));
    let ws = create_workspace(app.clone(), state.clone(), repo_id, title, agent, model, None, Some(number), profile).await?;
    // start-issue implements; a read-only role (e.g. Planner) is asked for a plan instead.
    if resolve_profile(&state, &ws).is_some_and(|p| p.readonly) {
        let text = format!(
            "Plan GitHub issue #{number}: read it with `gh issue view {number} --comments`, explore the relevant code, \
             and write an implementation plan. Don't change anything."
        );
        send(&app, &state, &ws.id, text.clone(), None, text).map_err(err)?;
    } else {
        run_skill(app, state.clone(), ws.id.clone(), "shipkit:start-issue".into(), String::new()).await?;
    }
    // Re-read so the returned status is "running".
    let latest = state.db().workspace(&ws.id).unwrap_or(ws);
    Ok(latest)
}

#[tauri::command]
async fn list_issues(state: State<'_, AppState>, repo_id: String) -> CmdResult<Vec<gh::Issue>> {
    let repo = state.db().repo(&repo_id).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || gh::list_issues(Path::new(&repo.path)))
        .await
        .map_err(err)?
        .map_err(err)
}

/// URL of the GitHub issue linked to the workspace.
#[tauri::command]
async fn issue_url(state: State<'_, AppState>, workspace_id: String) -> CmdResult<String> {
    let ws = state.db().workspace(&workspace_id).map_err(err)?;
    let n = ws.issue_number.ok_or("This workspace has no linked issue")?;
    tauri::async_runtime::spawn_blocking(move || gh::issue_url(Path::new(&ws.path), n))
        .await
        .map_err(err)?
        .map_err(err)
}

/// Switches the workspace's role. An idle session restarts so the new instructions and
/// restrictions apply on the next message; a running turn keeps its old role until it ends.
#[tauri::command]
fn set_workspace_profile(app: AppHandle, state: State<AppState>, id: String, profile: Option<String>) -> CmdResult<Workspace> {
    switch_profile(&app, &state, &id, profile.as_deref()).map_err(err)
}

/// Shared by the command and teammate hand-offs that reuse a workspace.
pub(crate) fn switch_profile(app: &AppHandle, state: &AppState, id: &str, profile: Option<&str>) -> anyhow::Result<Workspace> {
    // Bind first: the db guard must be dropped before resolve_profile locks it again.
    let current = state.db().workspace(id).ok();
    let before = current.and_then(|w| resolve_profile(state, &w));
    let ws = state.db().set_profile(id, profile.filter(|p| !p.is_empty()))?;
    state.restart_session_if_idle(id);
    // A resumed agent keeps following the role it saw earlier in the conversation unless told
    // otherwise, so the next message carries an explicit hand-over note.
    if let (Some(old), Some(new)) = (before, resolve_profile(state, &ws)) {
        if old.id != new.id {
            let access = if new.readonly {
                "You are now read-only: do not create, edit or delete files."
            } else {
                "You may now edit files in this workspace; earlier read-only restrictions no longer apply."
            };
            let note = format!(
                "[Orbit: this workspace switched from the {} role to the {} role. Follow your new role instructions in the system prompt; they replace the earlier role. {access}]\n\n",
                old.name, new.name
            );
            state.notices_lock().insert(id.to_string(), note);
        }
    }
    emit_workspace(app, &ws);
    Ok(ws)
}

#[tauri::command]
fn list_attachments(state: State<AppState>, workspace_id: String) -> CmdResult<Vec<Attachment>> {
    state.db().attachments(&workspace_id).map_err(err)
}

#[tauri::command]
async fn attach_folder(state: State<'_, AppState>, workspace_id: String, path: String) -> CmdResult<Attachment> {
    let path = tauri::async_runtime::spawn_blocking(move || -> CmdResult<String> {
        if !Path::new(&path).is_dir() {
            return Err(format!("{path} is not a folder"));
        }
        Ok(related::canonical(Path::new(&path)).to_string_lossy().to_string())
    })
    .await
    .map_err(err)??;
    let attachment = state.db().add_attachment(&workspace_id, &path).map_err(err)?;
    state.restart_session_if_idle(&workspace_id);
    Ok(attachment)
}

#[tauri::command]
async fn detach_folder(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let a = state.db().attachment(&id).map_err(err)?;
    if let Some(wt) = a.worktree_path.as_deref().map(PathBuf::from).filter(|wt| wt.exists()) {
        let origin = PathBuf::from(&a.path);
        let name = a.name.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            if !git::is_clean(&wt) {
                return Err(format!("{name} has uncommitted changes in its worktree; commit or discard them first"));
            }
            // `wt` may be a subfolder of the worktree; remove the whole worktree it belongs to.
            let top = git::toplevel(&origin).map_err(err)?;
            let wt_root = git::toplevel(&wt).map_err(err)?;
            git::remove_worktree(&top, &wt_root).map_err(err)
        })
        .await
        .map_err(err)??;
    }
    state.db().remove_attachment(&id).map_err(err)?;
    state.restart_session_if_idle(&a.workspace_id);
    Ok(())
}

#[tauri::command]
async fn set_attachment_editable(state: State<'_, AppState>, id: String, editable: bool) -> CmdResult<Attachment> {
    let a = state.db().attachment(&id).map_err(err)?;
    let mut created = None;
    if editable && a.worktree_path.is_none() {
        let ws = state.db().workspace(&a.workspace_id).map_err(err)?;
        let origin = PathBuf::from(&a.path);
        // The folder must be a repo root, or a subfolder the repo tracks (monorepo package).
        let (top, rel) = git::editable_location(&origin)?;
        let repo_name = top.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| a.name.clone());
        // Same naming as `create_workspace`: unique suffix, worktree under ~/.orbit/worktrees/<repo>.
        let suffix = &uuid::Uuid::new_v4().simple().to_string()[..4];
        let ws_dir = Path::new(&ws.path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| git::slugify(&ws.name));
        let path = state.home.join("worktrees").join(&repo_name).join(format!("{ws_dir}-{suffix}"));
        let branch = format!("{}{}-{suffix}", state.branch_prefix(), git::slugify(&ws.name));
        let (wt, br) = (path.clone(), branch.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let base = git::default_branch(&top);
            git::create_worktree(&top, &wt, &br, &base)
        })
        .await
        .map_err(err)?
        .map_err(err)?;
        // For a subfolder the attachment points at the same subfolder inside the new worktree.
        created = Some((path.join(&rel).to_string_lossy().to_string(), branch));
    }
    // Disabling keeps the worktree so no work is lost.
    let updated = state
        .db()
        .set_attachment_editable(&id, editable, created.as_ref().map(|(p, b)| (p.as_str(), b.as_str())))
        .map_err(err)?;
    state.restart_session_if_idle(&a.workspace_id);
    Ok(updated)
}

/// Projects that use, or are used by, the workspace's repo and aren't attached yet.
#[tauri::command]
async fn discover_related(state: State<'_, AppState>, workspace_id: String) -> CmdResult<Vec<related::Related>> {
    let ws = state.db().workspace(&workspace_id).map_err(err)?;
    let repo = state.db().repo(&ws.repo_id).map_err(err)?;
    let known: Vec<PathBuf> = state.db().repos().map_err(err)?.into_iter().map(|r| PathBuf::from(r.path)).collect();
    let attached: Vec<PathBuf> = state
        .db()
        .attachments(&workspace_id)
        .map_err(err)?
        .iter()
        .map(|a| related::canonical(Path::new(&a.path)))
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(&repo.path);
        let candidates = related::candidates(&project, &known);
        let mut found = related::discover(&project, &candidates);
        found.retain(|r| !attached.contains(&related::canonical(Path::new(&r.path))));
        found
    })
    .await
    .map_err(err)
}

#[tauri::command]
fn get_related_defaults(state: State<AppState>, repo_id: String) -> CmdResult<Vec<String>> {
    state.db().related_defaults(&repo_id).map_err(err)
}

#[tauri::command]
fn set_related_default(state: State<AppState>, repo_id: String, path: String, enabled: bool) -> CmdResult<()> {
    let path = related::canonical(Path::new(&path)).to_string_lossy().to_string();
    state.db().set_related_default(&repo_id, &path, enabled).map_err(err)
}

/// Records what the user did (`display` + optional `skill`) and sends `payload` to the agent.
fn send(app: &AppHandle, state: &AppState, id: &str, display: String, skill: Option<String>, payload: String) -> anyhow::Result<()> {
    let ws = state.db().workspace(id)?;
    on_agent_event(app, state, id, AgentEvent::UserMessage { text: display, skill });
    // Pending role hand-over note from a profile switch goes to the agent, not the transcript.
    let note = state.notices_lock().remove(id);
    let payload = match note {
        Some(note) => format!("{note}{payload}"),
        None => payload,
    };
    // A session that cannot start (binary missing, bad cwd) must end the turn visibly: the message is
    // already in the transcript, and callers waiting for TurnCompleted (Simplify, routines) would hang.
    let fail = |e: anyhow::Error| {
        on_agent_event(app, state, id, AgentEvent::TurnCompleted { duration_ms: None, cost_usd: None, is_error: true, error: Some(e.to_string()), interrupted: false });
        e
    };
    let handle = ensure_session(app, state, &ws).map_err(fail)?;
    if !handle.send(Command::User(payload.clone())) {
        // Session died between lookup and send: drop it and retry once with a fresh process.
        state.sessions_lock().remove(id);
        ensure_session(app, state, &ws).map_err(fail)?.send(Command::User(payload));
    }
    let ws = state.db().set_status(id, "running")?;
    emit_workspace(app, &ws);
    Ok(())
}

/// Async so agent processes are spawned inside the Tokio runtime.
#[tauri::command]
async fn send_message(app: AppHandle, state: State<'_, AppState>, id: String, text: String) -> CmdResult<()> {
    send(&app, &state, &id, text.clone(), None, text).map_err(err)
}

/// Runs a pack skill/command: natively as a slash command for Claude, expanded inline for Codex.
#[tauri::command]
async fn run_skill(app: AppHandle, state: State<'_, AppState>, id: String, skill_id: String, args: String) -> CmdResult<()> {
    run_skill_with(&app, &state, &id, &skill_id, &args, &args)
}

/// `display_args` is what the transcript shows; `payload_args` is what the agent receives
/// (routines append their unattended-run note there).
pub(crate) fn run_skill_with(app: &AppHandle, state: &AppState, id: &str, skill_id: &str, display_args: &str, payload_args: &str) -> CmdResult<()> {
    let ws = state.db().workspace(id).map_err(err)?;
    let skill = skills::list_skills(&state.packs().map_err(err)?)
        .into_iter()
        .find(|s| s.id == skill_id)
        .ok_or_else(|| format!("skill {skill_id} not found or its pack is disabled"))?;
    let (display, args) = (display_args.trim().to_string(), payload_args.trim().to_string());
    let payload = match AgentKind::parse(&ws.agent) {
        Some(AgentKind::Codex) => skills::expand(&skill, &args).map_err(err)?,
        _ => format!("/{} {args}", skill.id).trim_end().to_string(),
    };
    send(app, state, id, display, Some(skill.id), payload).map_err(err)
}

/// Skill ids shown as one-click chips above the composer.
#[tauri::command]
fn get_pins(state: State<AppState>) -> CmdResult<Vec<String>> {
    let saved = state.db().setting("pinned_skills").map_err(err)?;
    Ok(saved
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| skills::DEFAULT_PINS.iter().map(|s| s.to_string()).collect()))
}

#[tauri::command]
fn set_pins(state: State<AppState>, pins: Vec<String>) -> CmdResult<()> {
    state.db().set_setting("pinned_skills", &serde_json::to_string(&pins).map_err(err)?).map_err(err)
}

#[tauri::command]
fn list_packs(state: State<AppState>) -> CmdResult<Vec<skills::Pack>> {
    state.packs().map_err(err)
}

#[tauri::command]
fn list_skills(state: State<AppState>) -> CmdResult<Vec<skills::Skill>> {
    Ok(skills::list_skills(&state.packs().map_err(err)?))
}

#[tauri::command]
fn list_profiles(state: State<AppState>) -> CmdResult<Vec<skills::Profile>> {
    Ok(skills::list_profiles(&state.packs().map_err(err)?))
}

#[tauri::command]
async fn install_pack(state: State<'_, AppState>, url: String) -> CmdResult<skills::Pack> {
    let home = state.home.clone();
    let name = tauri::async_runtime::spawn_blocking(move || skills::install(&home, &url))
        .await
        .map_err(err)?
        .map_err(err)?;
    state.restart_idle_sessions();
    state.packs().map_err(err)?.into_iter().find(|p| p.name == name).ok_or_else(|| "install failed".into())
}

#[tauri::command]
async fn update_pack(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    let home = state.home.clone();
    tauri::async_runtime::spawn_blocking(move || skills::update(&home, &name))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
fn remove_pack(state: State<AppState>, name: String) -> CmdResult<()> {
    skills::remove(&state.home, &name).map_err(err)?;
    state.restart_idle_sessions();
    Ok(())
}

#[tauri::command]
fn set_pack_enabled(state: State<AppState>, name: String, enabled: bool) -> CmdResult<()> {
    let mut disabled = state.disabled_packs();
    disabled.retain(|n| n != &name);
    if !enabled {
        disabled.push(name);
    }
    state.db().set_setting("disabled_packs", &serde_json::to_string(&disabled).map_err(err)?).map_err(err)?;
    state.restart_idle_sessions();
    Ok(())
}

#[tauri::command]
async fn pr_status(state: State<'_, AppState>, id: String) -> CmdResult<Option<gh::PrStatus>> {
    let ws = state.db().workspace(&id).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || gh::pr_status(Path::new(&ws.path), &ws.branch))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
async fn merge_pr(app: AppHandle, state: State<'_, AppState>, id: String, number: u64) -> CmdResult<trunk::MergeOutcome> {
    let ws = state.db().workspace(&id).map_err(err)?;
    let settings = state.settings();
    tauri::async_runtime::spawn_blocking(move || {
        let delete = settings.delete_branch_on_merge.then_some(ws.branch.as_str());
        gh::merge(Path::new(&ws.path), number, &settings.merge_method, delete)
    })
        .await
        .map_err(err)?
        .map_err(err)?;
    // Archive/cleanup and syncing the other workspaces; neither can fail the merge itself.
    Ok(trunk::after_merge(&app, state.inner(), &id).await)
}

#[tauri::command]
async fn mark_pr_ready(state: State<'_, AppState>, id: String, number: u64) -> CmdResult<()> {
    let ws = state.db().workspace(&id).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || gh::mark_ready(Path::new(&ws.path), number))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
fn interrupt(state: State<AppState>, id: String) {
    if let Some(h) = state.sessions_lock().get(&id) {
        h.send(Command::Interrupt);
    }
}

/// Frees context by summarising the conversation (Claude: `/compact`; Codex: `thread/compact/start`).
#[tauri::command]
async fn compact_session(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let ws = state.db().workspace(&id).map_err(err)?;
    if ws.status == "running" {
        return Err("Wait for the current turn to finish before compacting".into());
    }
    if ws.agent_session_id.is_none() {
        return Err("Nothing to compact yet".into());
    }
    on_agent_event(&app, &state, &id, AgentEvent::UserMessage { text: "/compact".into(), skill: None });
    let handle = ensure_session(&app, &state, &ws).map_err(err)?;
    if !handle.send(Command::Compact) {
        state.sessions_lock().remove(&id);
        ensure_session(&app, &state, &ws).map_err(err)?.send(Command::Compact);
    }
    // Claude runs `/compact` as a turn (status follows its events); Codex's compaction has no
    // turn/started, so only mark Claude as running.
    if ws.agent == "claude" {
        let ws = state.db().set_status(&id, "running").map_err(err)?;
        emit_workspace(&app, &ws);
    }
    Ok(())
}

/// Drops the agent session so the next message starts from a clean context in the same worktree.
#[tauri::command]
fn new_session(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<()> {
    let taken = state.sessions_lock().remove(&id);
    if let Some(h) = taken {
        h.send(Command::Shutdown);
    }
    let ws = {
        let db = state.db();
        db.clear_agent_session(&id).map_err(err)?;
        db.set_status(&id, "idle").map_err(err)?
    };
    state.notices_lock().remove(&id);
    on_agent_event(&app, &state, &id, AgentEvent::SessionReset);
    emit_workspace(&app, &ws);
    Ok(())
}

#[tauri::command]
fn workspace_usage(state: State<AppState>, id: String) -> CmdResult<usage::WorkspaceUsage> {
    let rows = state.db().usage_rows(Some(&id)).map_err(err)?;
    Ok(usage::workspace_usage(&id, &rows.iter().collect::<Vec<_>>()))
}

/// Usage of every workspace in one call, so the app can seed its live map at startup.
#[tauri::command]
fn all_workspace_usage(state: State<AppState>) -> CmdResult<Vec<usage::WorkspaceUsage>> {
    let (rows, workspaces) = {
        let db = state.db();
        (db.usage_rows(None).map_err(err)?, db.all_workspaces().map_err(err)?)
    };
    Ok(workspaces
        .iter()
        .map(|w| {
            let mine: Vec<&usage::Row> = rows.iter().filter(|r| r.workspace_id == w.id).collect();
            usage::workspace_usage(&w.id, &mine)
        })
        .filter(|u| u.total.turns > 0)
        .collect())
}

#[tauri::command]
fn usage_report(state: State<AppState>, since_ms: Option<i64>) -> CmdResult<usage::Report> {
    let (rows, workspaces) = {
        let db = state.db();
        (db.usage_rows(None).map_err(err)?, db.all_workspaces().map_err(err)?)
    };
    let infos: Vec<usage::WorkspaceInfo> = workspaces
        .into_iter()
        .map(|w| usage::WorkspaceInfo { id: w.id, name: w.name, agent: w.agent })
        .collect();
    Ok(usage::report(&rows, &infos, since_ms, db::now()))
}

/// Renames a workspace's display name (the branch and worktree stay as they are).
#[tauri::command]
fn rename_workspace(app: AppHandle, state: State<AppState>, id: String, name: String) -> CmdResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("A workspace needs a name".into());
    }
    let updated = state.db().set_name(&id, &name);
    let ws = updated.map_err(err)?;
    emit_workspace(&app, &ws);
    Ok(())
}

#[tauri::command]
fn stop_session(state: State<AppState>, id: String) {
    let taken = state.sessions_lock().remove(&id);
    if let Some(h) = taken {
        h.send(Command::Shutdown);
    }
}

#[tauri::command]
fn load_events(state: State<AppState>, id: String) -> CmdResult<Vec<StoredEvent>> {
    state.db().events(&id).map_err(err)
}

#[tauri::command]
async fn workspace_changes(state: State<'_, AppState>, id: String) -> CmdResult<Vec<git::FileChange>> {
    let ws = state.db().workspace(&id).map_err(err)?;
    let repo = state.db().repo(&ws.repo_id).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || git::changes(Path::new(&ws.path), &repo.base_branch))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
async fn archive_workspace(
    state: State<'_, AppState>,
    id: String,
    remove_worktree: bool,
    force: Option<bool>,
) -> CmdResult<()> {
    archive_inner(&state, &id, remove_worktree, force.unwrap_or(false)).await
}

/// The refusal for archiving a worktree that has unsaved work (the UI keys on the prefix).
pub(crate) fn dirty_error(paths: &[String]) -> String {
    format!("Uncommitted changes: {}", paths.join(", "))
}

/// Archives a workspace. Removing the worktree discards uncommitted/untracked files, so without
/// `force` a dirty worktree is refused before anything (including the session) is touched.
pub(crate) async fn archive_inner(state: &AppState, id: &str, remove_worktree: bool, force: bool) -> CmdResult<()> {
    let id = id.to_string();
    let ws = state.db().workspace(&id).map_err(err)?;
    if remove_worktree && !force {
        let wt = PathBuf::from(&ws.path);
        let dirty = tauri::async_runtime::spawn_blocking(move || {
            if wt.exists() { git::dirty_paths(&wt, 6) } else { Vec::new() }
        })
        .await
        .map_err(err)?;
        if !dirty.is_empty() {
            return Err(dirty_error(&dirty));
        }
    }
    let taken = state.sessions_lock().remove(&id);
    if let Some(h) = taken {
        h.send(Command::Shutdown);
    }
    if remove_worktree {
        let repo = state.db().repo(&ws.repo_id).map_err(err)?;
        let (repo_path, wt) = (PathBuf::from(repo.path), PathBuf::from(&ws.path));
        tauri::async_runtime::spawn_blocking(move || git::remove_worktree(&repo_path, &wt))
            .await
            .map_err(err)?
            .map_err(err)?;
    }
    state.db().archive_workspace(&id).map_err(err)
}

#[tauri::command]
fn workspace_summaries(state: State<AppState>) -> CmdResult<Vec<db::Summary>> {
    let db = state.db();
    db.workspaces().map_err(err)?.iter().map(|w| db.summary(&w.id).map_err(err)).collect()
}

#[tauri::command]
fn workspace_summary(state: State<AppState>, id: String) -> CmdResult<db::Summary> {
    state.db().summary(&id).map_err(err)
}

/// Returns the new seen seq.
#[tauri::command]
fn mark_seen(state: State<AppState>, id: String) -> CmdResult<i64> {
    state.db().mark_seen(&id).map_err(err)
}

/// Returns the new dismissed seq.
#[tauri::command]
fn dismiss_workspace(state: State<AppState>, id: String) -> CmdResult<i64> {
    state.db().dismiss(&id).map_err(err)
}

/// Hides the workspace from the inbox until `until` (ms epoch); 0 clears the snooze.
#[tauri::command]
fn snooze_workspace(app: AppHandle, state: State<AppState>, id: String, until: i64) -> CmdResult<Workspace> {
    let ws = state.db().set_snoozed(&id, until).map_err(err)?;
    emit_workspace(&app, &ws);
    Ok(ws)
}

/// Up to 3 next-prompt ideas for the inbox, from a one-shot utility call (`llm::Task::Suggestions`).
#[tauri::command]
async fn suggest_prompts(
    state: State<'_, AppState>,
    id: String,
    reason: String,
    offered: Option<Vec<String>>,
) -> CmdResult<Vec<String>> {
    let settings = state.settings();
    if !settings.ai_suggestions {
        return Ok(vec![]);
    }
    let summary = state.db().summary(&id).map_err(err)?;
    let clip = |s: Option<String>, n: usize| {
        let s = s.unwrap_or_default();
        if s.chars().count() > n { format!("…{}", s.chars().rev().take(n).collect::<Vec<_>>().into_iter().rev().collect::<String>()) } else { s }
    };
    let prompt = format!(
        "You help a developer drive a coding agent. The agent's session needs attention ({reason}).\n\
         The developer's last message:\n<user>{}</user>\n\
         The agent's last message:\n<agent>{}</agent>\n{}\
         Suggest up to 3 short, concrete next prompts the developer is likely to send (each under 14 words). \
         If the agent asked a question, include likely answers. No slash commands.{}",
        clip(summary.last_user_text, 600),
        clip(summary.last_assistant_text, 1500),
        summary.last_turn_error.map(|e| format!("The turn failed with: {e}\n")).unwrap_or_default(),
        match offered.unwrap_or_default() {
            o if o.is_empty() => String::new(),
            o => format!(" These are already offered, so suggest different ones: {}.", o.join("; ")),
        },
    );
    let schema = serde_json::json!({
        "type": "object",
        "properties": { "suggestions": { "type": "array", "items": { "type": "string" }, "maxItems": 3 } },
        "required": ["suggestions"],
    });
    let reply = llm::complete_json(&state, llm::Task::Suggestions, "", &prompt, &schema).await.map_err(err)?;
    Ok(reply
        .and_then(|v| v["suggestions"].as_array().cloned())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).take(3).collect())
        .unwrap_or_default())
}

/// Ollama / OpenAI-compatible server status and installed models, for Settings > Models.
#[tauri::command]
async fn local_models_status(state: State<'_, AppState>) -> CmdResult<llm::LocalStatus> {
    let settings = state.settings();
    Ok(llm::status(&settings).await)
}

/// A tiny JSON round-trip against one local model (`backend`: "ollama" | "openaiCompat").
#[tauri::command]
async fn test_local_model(state: State<'_, AppState>, backend: String, model: String) -> CmdResult<llm::TestResult> {
    let settings = state.settings();
    llm::test_model(&settings, &backend, &model).await.map_err(err)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> settings::Settings {
    state.settings()
}

/// Merges `patch` (camelCase keys) into the settings, validates, persists, returns the result.
/// Agent mode changes only take effect on new sessions, so idle ones are restarted.
#[tauri::command]
async fn update_settings(app: AppHandle, state: State<'_, AppState>, patch: serde_json::Value) -> CmdResult<settings::Settings> {
    let before = state.settings();
    let after = before.patched(&patch)?;
    state.db().set_setting(settings::KEY, &serde_json::to_string(&after).map_err(err)?).map_err(err)?;
    if before.claude_permission_mode != after.claude_permission_mode || before.codex_sandbox != after.codex_sandbox {
        state.restart_idle_sessions();
    }
    if before.remote_enabled != after.remote_enabled || before.remote_port != after.remote_port {
        remote::apply(&app, &state).await;
    }
    Ok(after)
}

#[tauri::command]
async fn environment_info(state: State<'_, AppState>) -> CmdResult<maintenance::EnvironmentInfo> {
    Ok(maintenance::environment_info(&state.home).await)
}

#[tauri::command]
fn list_archived_workspaces(state: State<AppState>) -> CmdResult<Vec<Workspace>> {
    state.db().archived_workspaces().map_err(err)
}

/// Unarchives a workspace; recreates its worktree on the existing branch if the folder is gone.
#[tauri::command]
async fn restore_workspace(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<Workspace> {
    let ws = state.db().workspace(&id).map_err(err)?;
    if !Path::new(&ws.path).is_dir() {
        let repo = state.db().repo(&ws.repo_id).map_err(err)?;
        let (repo_path, wt, branch) = (PathBuf::from(repo.path), PathBuf::from(&ws.path), ws.branch.clone());
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            if !git::branch_exists(&repo_path, &branch) {
                return Err(format!("Branch {branch} no longer exists, so the worktree cannot be recreated"));
            }
            git::add_existing_worktree(&repo_path, &wt, &branch).map_err(err)
        })
        .await
        .map_err(err)??;
    }
    let restored = state.db().unarchive_workspace(&id).map_err(err)?;
    emit_workspace(&app, &restored);
    Ok(restored)
}

/// Workspaces whose branch has been merged and whose worktree is clean. `dry_run` only lists them;
/// otherwise each is archived and its worktree removed (the branch is kept).
#[tauri::command]
async fn cleanup_merged_worktrees(state: State<'_, AppState>, dry_run: bool) -> CmdResult<Vec<maintenance::CleanupCandidate>> {
    // Bind each db result first: the guard must be dropped before the next lock.
    let mut workspaces = state.db().workspaces().map_err(err)?;
    let archived = state.db().archived_workspaces().map_err(err)?;
    workspaces.extend(archived);
    let repos = state.db().repos().map_err(err)?;
    let (ws2, repos2) = (workspaces.clone(), repos.clone());
    let candidates = tauri::async_runtime::spawn_blocking(move || maintenance::find_cleanup_candidates(&ws2, &repos2))
        .await
        .map_err(err)?;
    if dry_run {
        return Ok(candidates);
    }
    let mut done = vec![];
    for c in candidates {
        let Some(ws) = workspaces.iter().find(|w| w.id == c.workspace_id) else { continue };
        let Some(repo) = repos.iter().find(|r| r.id == ws.repo_id) else { continue };
        let taken = state.sessions_lock().remove(&ws.id);
        if let Some(h) = taken {
            h.send(Command::Shutdown);
        }
        let (repo_path, wt) = (PathBuf::from(&repo.path), PathBuf::from(&ws.path));
        let removed = tauri::async_runtime::spawn_blocking(move || git::remove_worktree(&repo_path, &wt)).await.map_err(err)?;
        if removed.is_err() {
            continue;
        }
        state.db().archive_workspace(&ws.id).map_err(err)?;
        done.push(c);
    }
    Ok(done)
}

#[tauri::command]
fn get_setting(state: State<AppState>, key: String) -> CmdResult<Option<String>> {
    check_setting_key(&key)?;
    state.db().setting(&key).map_err(err)
}

#[tauri::command]
fn set_setting(state: State<AppState>, key: String, value: String) -> CmdResult<()> {
    check_setting_key(&key)?;
    state.db().set_setting(&key, &value).map_err(err)
}

/// The webview may only touch the keys the UI uses; secrets such as `remote_keypair` stay backend-only.
fn check_setting_key(key: &str) -> CmdResult<()> {
    const ALLOWED: [&str; 3] = [settings::KEY, "pinned_skills", "disabled_packs"];
    if ALLOWED.contains(&key) || key.starts_with("teammate_seen:") {
        Ok(())
    } else {
        Err(format!("Setting \"{key}\" is not available to the UI"))
    }
}

/// `~/.orbit`, moving pre-rename `~/.agentic-ide` state over once. If that old folder has
/// worktrees we keep using it in place: git links worktrees by absolute path.
fn default_home() -> anyhow::Result<PathBuf> {
    let base = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("could not find your home folder (set ORBIT_HOME to choose where Orbit keeps its data)"))?;
    Ok(default_home_in(&base))
}

fn default_home_in(base: &Path) -> PathBuf {
    let home = base.join(".orbit");
    let legacy = base.join(".agentic-ide");
    if !home.exists() && legacy.exists() {
        if legacy.join("worktrees").exists() {
            return legacy;
        }
        if let Err(e) = std::fs::rename(&legacy, &home) {
            eprintln!("could not migrate {} to {}: {e}", legacy.display(), home.display());
            return legacy;
        }
    }
    home
}

/// Opens `<home>/state.db`. A database SQLite can't read is moved aside to `state.db.corrupt-<ts>`
/// and recreated once; the second return value is where the old file went.
fn open_db(home: &Path) -> anyhow::Result<(Db, Option<PathBuf>)> {
    use anyhow::Context;
    std::fs::create_dir_all(home).with_context(|| format!("could not create {}", home.display()))?;
    let path = home.join("state.db");
    match Db::open(&path) {
        Ok(db) => Ok((db, None)),
        Err(first) if path.exists() => {
            let aside = home.join(format!("state.db.corrupt-{}", db::now()));
            std::fs::rename(&path, &aside)
                .with_context(|| format!("{} could not be opened ({first:#}) and could not be moved aside", path.display()))?;
            // The WAL/SHM files belong to the old database.
            for ext in ["-wal", "-shm"] {
                let _ = std::fs::remove_file(home.join(format!("state.db{ext}")));
            }
            let db = Db::open(&path).with_context(|| format!("could not create a new database at {}", path.display()))?;
            Ok((db, Some(aside)))
        }
        Err(e) => Err(e.context(format!("could not open {}", path.display()))),
    }
}

/// A native dialog for failures that happen before any window exists.
fn startup_dialog(app: &tauri::App, kind: tauri_plugin_dialog::MessageDialogKind, message: String) {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().message(message).title("Orbit").kind(kind).blocking_show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    agent::job::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // ORBIT_HOME isolates state for tests and side-by-side dev builds.
            let started = std::env::var_os("ORBIT_HOME")
                .map(|h| Ok(PathBuf::from(h)))
                .unwrap_or_else(default_home)
                .and_then(|home| open_db(&home).map(|(db, aside)| (home, db, aside)));
            let (home, db, aside) = match started {
                Ok(v) => v,
                Err(e) => {
                    startup_dialog(app, tauri_plugin_dialog::MessageDialogKind::Error, format!("Orbit could not start.\n\n{e:#}"));
                    return Err(e.into());
                }
            };
            if let Some(aside) = aside {
                startup_dialog(
                    app,
                    tauri_plugin_dialog::MessageDialogKind::Warning,
                    format!("Orbit's database could not be read, so it started with a fresh one. The old file was kept at:\n{}", aside.display()),
                );
            }
            if let Err(e) = skills::install_builtin(&home) {
                eprintln!("failed to install shipkit: {e}");
            }
            let state: AppState = Arc::new(Inner { db: Mutex::new(db), sessions: Mutex::default(), role_notices: Mutex::default(), home });
            app.manage::<AppState>(state.clone());
            // Phone bridge: listens only while Settings > Mobile allows it.
            let handle = app.handle().clone();
            let remote_state = state.clone();
            tauri::async_runtime::spawn(async move { remote::apply(&handle, &remote_state).await });
            // Keeps idle workspaces close to base (Settings > Git).
            trunk::start(app.handle().clone(), state.clone());
            routines::start(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            code::fs::code_list_dir,
            code::fs::code_read_file,
            code::fs::code_write_file,
            code::fs::code_create,
            code::fs::code_rename,
            code::fs::code_delete,
            code::fs::code_list_files,
            code::fs::code_file_at,
            code::watch::code_watch,
            code::watch::code_unwatch,
            code::search::code_search,
            code::pty::pty_open,
            code::pty::pty_write,
            code::pty::pty_resize,
            code::pty::pty_close,
            list_repos,
            add_repo,
            list_workspaces,
            create_workspace,
            send_message,
            interrupt,
            stop_session,
            rename_workspace,
            compact_session,
            new_session,
            workspace_usage,
            all_workspace_usage,
            usage_report,
            load_events,
            workspace_changes,
            archive_workspace,
            get_setting,
            get_settings,
            update_settings,
            environment_info,
            list_archived_workspaces,
            restore_workspace,
            cleanup_merged_worktrees,
            workspace_summaries,
            workspace_summary,
            mark_seen,
            dismiss_workspace,
            snooze_workspace,
            start_issue,
            list_issues,
            issue_url,
            suggest_prompts,
            local_models_status,
            test_local_model,
            set_setting,
            run_skill,
            get_pins,
            set_pins,
            list_packs,
            list_skills,
            list_profiles,
            set_workspace_profile,
            install_pack,
            update_pack,
            remove_pack,
            set_pack_enabled,
            pr_status,
            merge_pr,
            mark_pr_ready,
            list_attachments,
            attach_folder,
            detach_folder,
            set_attachment_editable,
            discover_related,
            get_related_defaults,
            set_related_default,
            trunk::get_check_command,
            trunk::set_check_command,
            trunk::run_checks,
            trunk::prepare_ship,
            trunk::undo_last_turn,
            trunk::workspace_overlaps,
            trunk::sync_now,
            simplify::simplify_state,
            simplify::simplify_find,
            simplify::simplify_apply,
            simplify::simplify_cancel,
            remote::remote_status,
            remote::remote_pairing,
            remote::remote_devices,
            remote::remote_revoke,
            teammates::list_teammates,
            teammates::get_teammate,
            teammates::save_teammate,
            teammates::delete_teammate,
            teammates::teammate_thread,
            teammates::teammate_tasks,
            teammates::teammate_send,
            teammates::teammate_mark_seen,
            teammates::teammate_memory,
            teammates::set_teammate_memory,
            chief::teammate_plans,
            chief::chief_plan_start,
            chief::chief_plan_edit,
            chief::chief_plan_cancel,
            handoff::teammate_handoff,
            routines::list_routines,
            routines::save_routine,
            routines::delete_routine,
            routines::set_routine_enabled,
            routines::run_routine_now,
            routines::routine_runs,
            routines::preview_schedule,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) { code::pty::close_all(); }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_db_is_moved_aside_and_recreated() {
        let home = std::env::temp_dir().join(format!("orbit-open-db-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("state.db"), "this is not a sqlite database, just text".repeat(20)).unwrap();
        let (db, aside) = open_db(&home).unwrap();
        let aside = aside.expect("old file kept");
        assert!(aside.exists() && aside.file_name().unwrap().to_string_lossy().starts_with("state.db.corrupt-"));
        assert!(db.setting("anything").unwrap().is_none());
        drop(db);
        // A healthy db opens without moving anything.
        assert!(open_db(&home).unwrap().1.is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn poisoned_locks_still_open() {
        let m = Arc::new(Mutex::new(1));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.is_poisoned());
        assert_eq!(*relock(&m), 1);
    }

    #[test]
    fn ui_cannot_read_secret_settings() {
        assert!(check_setting_key("remote_keypair").is_err());
        assert!(check_setting_key("remote_devices").is_err());
        assert!(check_setting_key("app_settings").is_ok());
        assert!(check_setting_key("teammate_seen:chief").is_ok());
        assert!(check_setting_key("random").is_err());
    }

    #[test]
    fn dirty_error_starts_with_marker() {
        assert!(dirty_error(&["a.txt".into(), "b.txt".into()]).starts_with("Uncommitted changes: a.txt, b.txt"));
    }

    #[tokio::test]
    async fn archive_refuses_a_dirty_worktree_unless_forced() {
        let root = std::env::temp_dir().join(format!("orbit-arch-{}", uuid::Uuid::new_v4().simple()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git::run(&repo, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(repo.join("a.txt"), "1").unwrap();
        git::run(&repo, &["add", "-A"]).unwrap();
        git::run(&repo, &["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", "init"]).unwrap();
        let wt = root.join("wt");
        git::run(&repo, &["worktree", "add", "-b", "w", &wt.to_string_lossy()]).unwrap();
        std::fs::write(wt.join("scratch.txt"), "precious").unwrap();

        let db = Db::memory();
        db.insert_repo(&Repo { id: "r".into(), name: "repo".into(), base_branch: "main".into(), path: repo.to_string_lossy().to_string() }).unwrap();
        let ws = Workspace {
            id: "w".into(), repo_id: "r".into(), name: "task".into(), branch: "w".into(), path: wt.to_string_lossy().to_string(),
            agent: "claude".into(), status: "idle".into(), ..Default::default()
        };
        db.insert_workspace(&ws).unwrap();
        let state: AppState = Arc::new(Inner { db: Mutex::new(db), sessions: Mutex::default(), role_notices: Mutex::default(), home: root.clone() });

        let e = archive_inner(&state, &ws.id, true, false).await.unwrap_err();
        assert!(e.starts_with("Uncommitted changes:") && e.contains("scratch.txt"), "{e}");
        assert!(wt.join("scratch.txt").exists(), "nothing was removed");
        archive_inner(&state, &ws.id, true, true).await.unwrap();
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn derived_names_are_recognised() {
        assert!(is_derived_name("Fix the login bug", "Fix the login bug\nmore detail"));
        assert!(is_derived_name("Fix the login bu…", "Fix  the login bug and more"));
        assert!(!is_derived_name("My own name", "Fix the login bug"));
    }

    #[test]
    fn model_names_are_cleaned() {
        assert_eq!(clean_name("\"Fix login redirect loop.\"").as_deref(), Some("Fix login redirect loop"));
        assert_eq!(clean_name("one two three four five six seven").as_deref(), Some("one two three four five"));
        assert_eq!(clean_name("  \"\" ").as_deref(), None);
    }
}
