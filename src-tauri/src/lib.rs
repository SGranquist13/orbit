mod agent;
mod db;
mod gh;
mod git;
mod related;
mod skills;

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

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
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
        self.db.lock().expect("db lock poisoned")
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
        self.sessions.lock().unwrap().retain(|id, h| {
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
        if let Some(h) = self.sessions.lock().unwrap().remove(workspace_id) {
            h.send(Command::Shutdown);
        }
    }

    /// Attached folders that still exist; missing ones are skipped rather than failing the spawn.
    fn live_attachments(&self, workspace_id: &str) -> Vec<Attachment> {
        let mut list = self.db().attachments(workspace_id).unwrap_or_default();
        list.retain(|a| Path::new(&a.path).is_dir());
        list
    }

    fn branch_prefix(&self) -> String {
        self.db().setting("branch_prefix").ok().flatten().unwrap_or_else(|| {
            let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
            let user = git::slugify(&user);
            if user == "task" { String::new() } else { format!("{user}/") }
        })
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
    let _ = app.emit("workspace", ws);
}

/// Handles one normalized event: persist, update workspace status, notify, forward to UI.
fn on_agent_event(app: &AppHandle, state: &AppState, ws_id: &str, ev: AgentEvent) {
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
    if matches!(ev, AgentEvent::Exited { .. }) {
        state.sessions.lock().unwrap().remove(ws_id);
    }
    // The user stopped it themselves, so no notification for interruptions.
    if let AgentEvent::TurnCompleted { is_error, error, interrupted: false, .. } = &ev {
        notify_turn_done(app, updated.as_ref(), *is_error, error.as_deref());
    }
    let _ = app.emit("agent-event", AgentEventPayload { workspace_id: ws_id.to_string(), seq, ts, event: ev });
    if let Some(ws) = updated {
        emit_workspace(app, &ws);
    }
}

fn notify_turn_done(app: &AppHandle, ws: Option<&Workspace>, is_error: bool, error: Option<&str>) {
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    let Some(ws) = ws.filter(|_| !focused) else { return };
    let body = if is_error { error.unwrap_or("Turn failed").to_string() } else { "Finished — ready for you".into() };
    let _ = app.notification().builder().title(&ws.name).body(body).show();
}

/// Appended to every agent's system prompt so shipping skills know the branch, base, and issue.
fn workspace_context(ws: &Workspace, repo: &Repo, attachments: &[Attachment], profile: Option<&skills::Profile>) -> String {
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
        if p.readonly {
            s.push_str("You are in a read-only role: do not create, edit, or delete files, and do not commit or push.\n");
        }
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
    if let Some(h) = state.sessions.lock().unwrap().get(&ws.id) {
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
    let cfg = SessionConfig {
        kind,
        cwd: PathBuf::from(&ws.path),
        model: ws.model.clone(),
        resume: ws.agent_session_id.clone(),
        plugin_dirs,
        add_dirs,
        instructions: Some(workspace_context(ws, &repo, &attachments, profile.as_ref())),
        readonly: profile.as_ref().is_some_and(|p| p.readonly),
    };
    let (app2, state2, id) = (app.clone(), state.clone(), ws.id.clone());
    let handle = agent::spawn(cfg, Arc::new(move |ev| on_agent_event(&app2, &state2, &id, ev)))?;
    state.sessions.lock().unwrap().insert(ws.id.clone(), handle.clone());
    Ok(handle)
}

#[tauri::command]
fn list_repos(state: State<AppState>) -> CmdResult<Vec<Repo>> {
    state.db().repos().map_err(err)
}

#[tauri::command]
fn add_repo(state: State<AppState>, path: String) -> CmdResult<Repo> {
    let top = git::toplevel(Path::new(&path)).map_err(|_| format!("{path} is not a git repository"))?;
    let name = top.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
    let repo = Repo {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        base_branch: git::default_branch(&top),
        path: top.to_string_lossy().to_string(),
    };
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

#[tauri::command]
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
    AgentKind::parse(&agent).ok_or("unknown agent")?;
    let repo = state.db().repo(&repo_id).map_err(err)?;
    let slug = match issue_number {
        Some(n) => format!("{n}-{}", git::slugify(&name)),
        None => git::slugify(&name),
    };
    // Unique suffix keeps re-used names from colliding with existing branches/dirs.
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..4];
    let dir_name = format!("{slug}-{suffix}");
    let branch = format!("{}{slug}-{suffix}", state.branch_prefix());
    let path = state.home.join("worktrees").join(&repo.name).join(&dir_name);

    let (repo_path, base, wt_path, br) = (PathBuf::from(&repo.path), repo.base_branch.clone(), path.clone(), branch.clone());
    tauri::async_runtime::spawn_blocking(move || git::create_worktree(&repo_path, &wt_path, &br, &base))
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
    emit_workspace(&app, &ws);
    if let Some(p) = prompt.filter(|p| !p.trim().is_empty()) {
        send(&app, &state, &ws.id, p.clone(), None, p).map_err(err)?;
    }
    Ok(ws)
}

/// Creates a workspace for a GitHub issue (no prompt) and runs `shipkit:start-issue` on it,
/// so the agent reads the issue itself via `gh`.
#[tauri::command]
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
    // Bind first: the db guard must be dropped before resolve_profile locks it again.
    let current = state.db().workspace(&id).ok();
    let before = current.and_then(|w| resolve_profile(&state, &w));
    let ws = state.db().set_profile(&id, profile.as_deref().filter(|p| !p.is_empty())).map_err(err)?;
    state.restart_session_if_idle(&id);
    // A resumed agent keeps following the role it saw earlier in the conversation unless told
    // otherwise, so the next message carries an explicit hand-over note.
    if let (Some(old), Some(new)) = (before, resolve_profile(&state, &ws)) {
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
            state.role_notices.lock().unwrap().insert(id.clone(), note);
        }
    }
    emit_workspace(&app, &ws);
    Ok(ws)
}

#[tauri::command]
fn list_attachments(state: State<AppState>, workspace_id: String) -> CmdResult<Vec<Attachment>> {
    state.db().attachments(&workspace_id).map_err(err)
}

#[tauri::command]
fn attach_folder(state: State<AppState>, workspace_id: String, path: String) -> CmdResult<Attachment> {
    if !Path::new(&path).is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let path = related::canonical(Path::new(&path)).to_string_lossy().to_string();
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
            let top = git::toplevel(&origin).map_err(err)?;
            git::remove_worktree(&top, &wt).map_err(err)
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
        let top = git::toplevel(&origin).map_err(|_| "Only git repositories can be made editable".to_string())?;
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
        created = Some((path.to_string_lossy().to_string(), branch));
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
    let payload = match state.role_notices.lock().unwrap().remove(id) {
        Some(note) => format!("{note}{payload}"),
        None => payload,
    };
    let handle = ensure_session(app, state, &ws)?;
    if !handle.send(Command::User(payload.clone())) {
        // Session died between lookup and send: drop it and retry once with a fresh process.
        state.sessions.lock().unwrap().remove(id);
        ensure_session(app, state, &ws)?.send(Command::User(payload));
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
    let ws = state.db().workspace(&id).map_err(err)?;
    let skill = skills::list_skills(&state.packs().map_err(err)?)
        .into_iter()
        .find(|s| s.id == skill_id)
        .ok_or_else(|| format!("skill {skill_id} not found or its pack is disabled"))?;
    let args = args.trim().to_string();
    let payload = match AgentKind::parse(&ws.agent) {
        Some(AgentKind::Codex) => skills::expand(&skill, &args).map_err(err)?,
        _ => format!("/{} {args}", skill.id).trim_end().to_string(),
    };
    send(&app, &state, &id, args, Some(skill.id), payload).map_err(err)
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
async fn merge_pr(state: State<'_, AppState>, id: String, number: u64) -> CmdResult<()> {
    let ws = state.db().workspace(&id).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || gh::merge(Path::new(&ws.path), number))
        .await
        .map_err(err)?
        .map_err(err)
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
    if let Some(h) = state.sessions.lock().unwrap().get(&id) {
        h.send(Command::Interrupt);
    }
}

#[tauri::command]
fn stop_session(state: State<AppState>, id: String) {
    if let Some(h) = state.sessions.lock().unwrap().remove(&id) {
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
async fn archive_workspace(state: State<'_, AppState>, id: String, remove_worktree: bool) -> CmdResult<()> {
    if let Some(h) = state.sessions.lock().unwrap().remove(&id) {
        h.send(Command::Shutdown);
    }
    let ws = state.db().workspace(&id).map_err(err)?;
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

/// Up to 3 next-prompt ideas for the inbox, from a one-shot Haiku call (no tools, ~$0.0002).
#[tauri::command]
async fn suggest_prompts(
    state: State<'_, AppState>,
    id: String,
    reason: String,
    offered: Option<Vec<String>>,
) -> CmdResult<Vec<String>> {
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
    let schema = r#"{"type":"object","properties":{"suggestions":{"type":"array","items":{"type":"string"},"maxItems":3}},"required":["suggestions"]}"#;
    let args: Vec<String> = [
        "-p", "--model", "haiku", "--output-format", "json", "--no-session-persistence",
        // No user plugins/hooks and no tools: fast, cheap, side-effect free.
        "--setting-sources", "local", "--tools", "", "--json-schema", schema, &prompt,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let mut cmd = agent::process::command("claude", &args, &state.home).map_err(err)?;
    cmd.stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(std::time::Duration::from_secs(45), cmd.output())
        .await
        .map_err(|_| "suggestions timed out".to_string())?
        .map_err(err)?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| "suggestions: unreadable response".to_string())?;
    Ok(v["structured_output"]["suggestions"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).take(3).collect())
        .unwrap_or_default())
}

#[tauri::command]
fn get_setting(state: State<AppState>, key: String) -> CmdResult<Option<String>> {
    state.db().setting(&key).map_err(err)
}

#[tauri::command]
fn set_setting(state: State<AppState>, key: String, value: String) -> CmdResult<()> {
    state.db().set_setting(&key, &value).map_err(err)
}

/// `~/.orbit`, moving pre-rename `~/.agentic-ide` state over once. If that old folder has
/// worktrees we keep using it in place: git links worktrees by absolute path.
fn default_home() -> PathBuf {
    let base = dirs::home_dir().expect("home dir");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // ORBIT_HOME isolates state for tests and side-by-side dev builds.
            let home = std::env::var_os("ORBIT_HOME").map(PathBuf::from).unwrap_or_else(default_home);
            std::fs::create_dir_all(&home)?;
            let db = Db::open(&home.join("state.db"))?;
            if let Err(e) = skills::install_builtin(&home) {
                eprintln!("failed to install shipkit: {e}");
            }
            app.manage::<AppState>(Arc::new(Inner { db: Mutex::new(db), sessions: Mutex::default(), role_notices: Mutex::default(), home }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_repos,
            add_repo,
            list_workspaces,
            create_workspace,
            send_message,
            interrupt,
            stop_session,
            load_events,
            workspace_changes,
            archive_workspace,
            get_setting,
            workspace_summaries,
            workspace_summary,
            mark_seen,
            dismiss_workspace,
            snooze_workspace,
            start_issue,
            list_issues,
            issue_url,
            suggest_prompts,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
