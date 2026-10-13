//! AI teammates: persistent, named coworkers you hand a task to. You message one in its own thread;
//! it creates the workspace (worktree + branch) itself, does the work there, and reports back in the
//! thread. A teammate is a markdown file (bundled starter team, or `~/.orbit/teammates/<slug>.md`)
//! plus a memory file it appends durable learnings to. Profiles stay the per-workspace mode; a
//! teammate may name one for the workspaces it creates.
//!
//! Flow: `teammate_send` either continues the teammate's open task (the message goes to that
//! workspace through the normal `send`) or starts a new one (`create_workspace_inner`, marked with
//! `workspaces.teammate`). When the task workspace's turn ends, `finish_turn` (called from
//! `on_agent_event`, like routines) posts a `task_report` into the thread.

use crate::db::{self, Repo};
use crate::{create_workspace_inner, err, git, AppState, CmdResult, NewWorkspaceArgs};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

/// Starter team: (slug, file contents). Also written to `packs/shipkit/teammates/` on startup.
pub const BUNDLED: &[(&str, &str)] = &[
    ("chief", include_str!("../shipkit/teammates/chief.md")),
    ("builder", include_str!("../shipkit/teammates/builder.md")),
    ("debugger", include_str!("../shipkit/teammates/debugger.md")),
    ("planner", include_str!("../shipkit/teammates/planner.md")),
    ("reviewer", include_str!("../shipkit/teammates/reviewer.md")),
    ("shipper", include_str!("../shipkit/teammates/shipper.md")),
    ("ticket-writer", include_str!("../shipkit/teammates/ticket-writer.md")),
];

/// How much of the memory file goes into a workspace's context.
pub const MEMORY_CAP: usize = 4096;
const SUMMARY_CHARS: usize = 600;

// ---------------------------------------------------------------- definitions

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Teammate {
    /// File stem; stable id.
    pub slug: String,
    pub name: String,
    /// One glyph/letter, or the name of an icon from the UI's small set.
    pub avatar: String,
    pub description: String,
    pub agent: String,
    pub model: Option<String>,
    /// Profile id (`shipkit:builder`) for the workspaces it creates.
    pub profile: Option<String>,
    /// Repo ids or names it may work in; empty = any.
    pub repos: Vec<String>,
    /// None = inherit from the profile.
    pub readonly: Option<bool>,
    pub instructions: String,
    /// Has a starter definition shipped with Orbit.
    pub bundled: bool,
    /// A custom file replaces the starter definition (so "reset to default" is possible).
    pub overridden: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeammateInput {
    /// Set when editing; absent for a new teammate (derived from the name).
    pub slug: Option<String>,
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub description: String,
    pub agent: String,
    pub model: Option<String>,
    pub profile: Option<String>,
    #[serde(default)]
    pub repos: Vec<String>,
    pub readonly: Option<bool>,
    #[serde(default)]
    pub instructions: String,
}

pub fn dir(home: &Path) -> PathBuf {
    home.join("teammates")
}

fn file_path(home: &Path, slug: &str) -> PathBuf {
    dir(home).join(format!("{slug}.md"))
}

pub fn memory_path(home: &Path, slug: &str) -> PathBuf {
    dir(home).join(format!("{slug}.memory.md"))
}

pub fn valid_slug(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !s.starts_with('-')
}

fn title_case(slug: &str) -> String {
    let n = slug.replace(['-', '_'], " ");
    let mut c = n.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// `a, b`, `[a, b]`, or a YAML block list that the frontmatter reader folded into `- a - b`.
fn parse_list(v: &str) -> Vec<String> {
    let v = v.trim().trim_matches(['[', ']']);
    let parts: Vec<&str> = if v.contains(',') { v.split(',').collect() } else if v.starts_with("- ") { v.split(" - ").collect() } else { vec![v] };
    parts
        .into_iter()
        .map(|p| p.trim().trim_start_matches("- ").trim().trim_matches(['"', '\'']).to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn bare(v: &str) -> &str {
    v.split(" #").next().unwrap_or(v).trim()
}

/// Reads one definition file. Tolerant: missing keys fall back to defaults.
pub fn parse(slug: &str, text: &str, bundled: bool, overridden: bool) -> Teammate {
    let (fm, body) = crate::skills::parse_frontmatter(text);
    let field = |k: &str| fm.get(k).map(|v| bare(v).to_string()).filter(|v| !v.is_empty());
    let name = fm.get("name").map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| title_case(slug));
    let avatar = fm
        .get("avatar")
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default());
    Teammate {
        slug: slug.to_string(),
        name,
        avatar,
        description: fm.get("description").map(|d| d.trim().to_string()).unwrap_or_default(),
        agent: field("agent").map(|a| a.to_lowercase()).filter(|a| a == "claude" || a == "codex").unwrap_or_else(|| "claude".into()),
        model: field("model"),
        profile: field("profile").map(|p| normalize_profile(&p)),
        repos: field("repos").map(|r| parse_list(&r)).unwrap_or_default(),
        readonly: field("readonly").and_then(|v| match v.to_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        }),
        instructions: body.trim().to_string(),
        bundled,
        overridden,
    }
}

/// `builder` -> `shipkit:builder`; full ids pass through.
pub fn normalize_profile(p: &str) -> String {
    let p = p.trim();
    if p.contains(':') {
        p.to_string()
    } else {
        format!("{}:{p}", crate::skills::BUILTIN_PACK)
    }
}

fn quote(s: &str) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("\"{}\"", one_line.replace('"', "\\\""))
}

/// The file written for a custom teammate; `parse` reads it back.
pub fn render(t: &Teammate) -> String {
    let mut s = format!("---\nname: {}\navatar: {}\ndescription: {}\nagent: {}\n", quote(&t.name), quote(&t.avatar), quote(&t.description), t.agent);
    if let Some(m) = t.model.as_deref().filter(|m| !m.is_empty()) {
        s.push_str(&format!("model: {m}\n"));
    }
    if let Some(p) = t.profile.as_deref().filter(|p| !p.is_empty()) {
        s.push_str(&format!("profile: {p}\n"));
    }
    if !t.repos.is_empty() {
        s.push_str(&format!("repos: {}\n", t.repos.join(", ")));
    }
    if let Some(r) = t.readonly {
        s.push_str(&format!("readonly: {r}\n"));
    }
    s.push_str("---\n");
    s.push_str(t.instructions.trim());
    s.push('\n');
    s
}

fn read_custom(home: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(dir(home)) else { return vec![] };
    let mut out: Vec<(String, String)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .filter_map(|p| {
            // `<slug>.memory.md` has a dot in its stem, which is never a valid slug.
            let slug = p.file_stem()?.to_string_lossy().to_string();
            valid_slug(&slug).then(|| std::fs::read_to_string(&p).ok().map(|t| (slug, t)))?
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// The starter team first (a same-slug custom file replaces its definition), then custom ones by name.
pub fn list(home: &Path) -> Vec<Teammate> {
    let custom = read_custom(home);
    let mut out: Vec<Teammate> = BUNDLED
        .iter()
        .map(|(slug, text)| match custom.iter().find(|(s, _)| s == slug) {
            Some((_, over)) => parse(slug, over, true, true),
            None => parse(slug, text, true, false),
        })
        .collect();
    let mut extra: Vec<Teammate> = custom.iter().filter(|(s, _)| !BUNDLED.iter().any(|(b, _)| b == s)).map(|(s, t)| parse(s, t, false, false)).collect();
    extra.sort_by_key(|t| t.name.to_lowercase());
    out.extend(extra);
    out
}

pub fn get(home: &Path, slug: &str) -> Option<Teammate> {
    list(home).into_iter().find(|t| t.slug == slug)
}

/// Saves a definition as a custom file (overriding a starter one when the slug matches).
pub fn save(home: &Path, input: TeammateInput) -> Result<Teammate, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("A teammate needs a name".into());
    }
    if input.agent != "claude" && input.agent != "codex" {
        return Err(format!("unknown agent {}", input.agent));
    }
    let existing = list(home);
    let slug = match input.slug.as_deref().filter(|s| !s.is_empty()) {
        Some(s) if valid_slug(s) => s.to_string(),
        Some(s) => return Err(format!("invalid teammate id `{s}`")),
        None => {
            let base = git::slugify(&name);
            let mut slug = base.clone();
            let mut n = 2;
            while existing.iter().any(|t| t.slug == slug) {
                slug = format!("{base}-{n}");
                n += 1;
            }
            slug
        }
    };
    let bundled = BUNDLED.iter().any(|(b, _)| *b == slug);
    let t = Teammate {
        slug: slug.clone(),
        avatar: Some(input.avatar.trim().to_string()).filter(|a| !a.is_empty()).unwrap_or_else(|| name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default()),
        name,
        description: input.description.trim().to_string(),
        agent: input.agent,
        model: input.model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
        profile: input.profile.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).map(|p| normalize_profile(&p)),
        repos: input.repos.into_iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect(),
        readonly: input.readonly,
        instructions: input.instructions.trim().to_string(),
        bundled,
        overridden: bundled,
    };
    std::fs::create_dir_all(dir(home)).map_err(err)?;
    std::fs::write(file_path(home, &slug), render(&t)).map_err(err)?;
    Ok(t)
}

/// Deletes a custom teammate (and its memory), or resets an overridden starter one to its default
/// (its memory is kept). A starter teammate with no override has nothing to delete.
pub fn delete(home: &Path, slug: &str) -> Result<(), String> {
    if !valid_slug(slug) {
        return Err(format!("invalid teammate id `{slug}`"));
    }
    let path = file_path(home, slug);
    let bundled = BUNDLED.iter().any(|(b, _)| *b == slug);
    if !path.is_file() {
        return Err(if bundled { "This starter teammate is already at its default".into() } else { format!("No teammate `{slug}`") });
    }
    std::fs::remove_file(&path).map_err(err)?;
    if !bundled {
        let _ = std::fs::remove_file(memory_path(home, slug));
    }
    Ok(())
}

/// Mirrors the starter files into the shipkit pack folder so they can be read next to the profiles.
pub fn install_bundled(root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(root.join("teammates"))?;
    for (slug, text) in BUNDLED {
        std::fs::write(root.join("teammates").join(format!("{slug}.md")), text)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- memory

const MEMORY_HEADER: &str = "# Memory\n";

/// Creates the memory file on first use.
pub fn ensure_memory(home: &Path, slug: &str) -> PathBuf {
    let path = memory_path(home, slug);
    if !path.exists() {
        let _ = std::fs::create_dir_all(dir(home));
        let _ = std::fs::write(&path, MEMORY_HEADER);
    }
    path
}

pub fn read_memory(home: &Path, slug: &str) -> String {
    std::fs::read_to_string(memory_path(home, slug)).unwrap_or_default()
}

/// The newest notes that fit in `cap` bytes, starting on a line boundary (agents append, so the tail is current).
pub fn memory_excerpt(text: &str, cap: usize) -> String {
    let text = text.trim();
    if text.len() <= cap {
        return text.to_string();
    }
    let mut start = text.len() - cap;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let tail = &text[start..];
    let tail = match tail.find('\n') {
        Some(i) if i + 1 < tail.len() => &tail[i + 1..],
        _ => tail,
    };
    format!("(earlier notes trimmed)\n{}", tail.trim())
}

const PROTOCOL: &str = "How you work: the user handed you this task through your thread, and nobody is watching live. \
When you finish a turn, end with a concise report: what you did, links or paths to what you produced (branch, PR URL, files), \
and exactly what you need from the user, if anything. If you need an answer before you can continue, ask one short question and stop. \
Open a draft pull request when the work is ready; never merge.";

/// The "who you are" block appended to the workspace context of every workspace a teammate creates.
pub fn context_section(home: &Path, t: &Teammate) -> String {
    let path = ensure_memory(home, &t.slug);
    let notes = memory_excerpt(&read_memory(home, &t.slug), MEMORY_CAP);
    let notes = if notes.is_empty() || notes == MEMORY_HEADER.trim() { "(no notes yet)".to_string() } else { notes };
    let mut s = format!("\n## You are {}, a teammate\n", t.name);
    if !t.instructions.is_empty() {
        s.push_str(&t.instructions);
        s.push_str("\n\n");
    }
    s.push_str(PROTOCOL);
    s.push_str(&format!(
        "\n\n## Your memory\nYour notes file (absolute path): {}\nAt the end of a task, append durable learnings to it as short bullet points: the user's preferences, decisions, repository quirks. \
         Never rewrite or delete existing notes, and skip this if you learned nothing durable. Your notes so far:\n---\n{notes}\n---\n",
        path.display()
    ));
    s
}

/// Read-only unless the teammate says otherwise; with nothing set it follows its profile.
pub fn effective_readonly(teammate: Option<bool>, profile_readonly: bool) -> bool {
    teammate.unwrap_or(profile_readonly)
}

// ---------------------------------------------------------------- threads, tasks, status

/// `role`: user | teammate | system. `kind`: message | task_started | task_report | error.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeammateMessage {
    pub id: String,
    pub slug: String,
    pub ts: i64,
    pub role: String,
    pub text: String,
    pub workspace_id: Option<String>,
    pub kind: String,
    /// Task status when a started/report card was posted.
    pub status: Option<String>,
    /// Changed files in the task workspace when a report was posted.
    pub files: Option<i64>,
    /// Extra reference: the plan id (`plan`, combined report), the target teammate (`handoff`), or the origin (`brief`).
    pub meta: Option<String>,
}

pub(crate) fn message(slug: &str, role: &str, kind: &str, text: &str, workspace_id: Option<&str>) -> TeammateMessage {
    TeammateMessage {
        id: uuid::Uuid::new_v4().to_string(),
        slug: slug.to_string(),
        ts: db::now(),
        role: role.into(),
        text: text.into(),
        workspace_id: workspace_id.map(String::from),
        kind: kind.into(),
        status: None,
        files: None,
        meta: None,
    }
}

/// `status`: running | done | error | waiting.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeammateTask {
    pub id: String,
    pub slug: String,
    pub workspace_id: String,
    pub repo_id: String,
    pub status: String,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub summary: Option<String>,
    /// What started this task: a Chief plan's id (`origin_kind` = chief) or the task it was handed off from.
    pub parent_task_id: Option<String>,
    /// `chief` | `handoff` | `routine`; None for a task the user started.
    pub origin_kind: Option<String>,
    /// Slug of the delegating teammate (chief, handoff) or the routine's name (routine).
    pub origin_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Working,
    NeedsYou,
    Idle,
}

/// Working while any task runs; otherwise needs you when a task waits for an answer or a report is unseen.
pub fn derive_status(task_statuses: &[&str], unseen_report: bool) -> Status {
    if task_statuses.contains(&"running") {
        Status::Working
    } else if task_statuses.contains(&"waiting") || unseen_report {
        Status::NeedsYou
    } else {
        Status::Idle
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Delegation {
    New,
    Continue(String),
}

/// `new_task`: the user's explicit choice (None = decide). Continue only into a task that is still open.
pub fn decide(new_task: Option<bool>, open: Option<&TeammateTask>) -> Delegation {
    match (new_task, open) {
        (Some(true), _) | (_, None) => Delegation::New,
        (_, Some(t)) => Delegation::Continue(t.id.clone()),
    }
}

/// The repository for a new task. `allowed` holds repo ids or names (empty = any repo).
pub fn pick_repo(requested: Option<&str>, allowed: &[String], repos: &[Repo]) -> Result<String, String> {
    let pool: Vec<&Repo> = repos
        .iter()
        .filter(|r| allowed.is_empty() || allowed.iter().any(|a| a == &r.id || a.eq_ignore_ascii_case(&r.name)))
        .collect();
    if pool.is_empty() {
        return Err(if allowed.is_empty() { "Add a repository first".into() } else { "None of this teammate's repositories are added to Orbit".into() });
    }
    match requested.filter(|r| !r.is_empty()) {
        Some(id) => pool.iter().find(|r| r.id == id).map(|r| r.id.clone()).ok_or_else(|| "That repository isn't one this teammate may work in".to_string()),
        None if pool.len() == 1 => Ok(pool[0].id.clone()),
        None => Err("Pick a repository for this task".into()),
    }
}

/// How a finished turn lands in the thread, before the report model has had its say.
#[derive(Debug, PartialEq, Eq)]
pub struct Route {
    pub task_status: &'static str,
    pub role: &'static str,
    pub kind: &'static str,
}

pub fn route_turn(is_error: bool, interrupted: bool, needs_you: bool) -> Route {
    if interrupted {
        Route { task_status: "waiting", role: "system", kind: "task_report" }
    } else if is_error {
        Route { task_status: "error", role: "system", kind: "error" }
    } else if needs_you {
        Route { task_status: "waiting", role: "teammate", kind: "task_report" }
    } else {
        Route { task_status: "done", role: "teammate", kind: "task_report" }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub summary: String,
    pub needs_you: bool,
    pub question: Option<String>,
}

pub(crate) fn clip(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(max).collect::<String>().trim_end())
    }
}

fn asks_question(text: &str) -> bool {
    text.trim().lines().rev().find(|l| !l.trim().is_empty()).is_some_and(|l| l.trim().ends_with('?'))
}

/// `{ "summary": string, "needsYou": boolean, "question"?: string }` from the report model.
pub fn parse_report(v: &Value) -> Option<Report> {
    let summary = v["summary"].as_str().map(str::trim).filter(|s| !s.is_empty())?;
    let question = v["question"].as_str().map(str::trim).filter(|q| !q.is_empty()).map(String::from);
    let needs_you = v["needsYou"].as_bool().unwrap_or(false);
    Some(Report { summary: clip(summary, SUMMARY_CHARS), needs_you, question: question.filter(|_| needs_you) })
}

/// Used when the report model is Off, slow or wrong: the agent's own last message, trimmed.
pub fn fallback_report(last_text: Option<&str>) -> Report {
    match last_text.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => Report { summary: clip(t, SUMMARY_CHARS), needs_you: asks_question(t), question: None },
        None => Report { summary: "Finished.".into(), needs_you: false, question: None },
    }
}

/// What goes in the thread: the summary, plus the question when it isn't already part of it.
pub fn report_text(r: &Report) -> String {
    match r.question.as_deref() {
        Some(q) if !r.summary.contains(q) => format!("{}\n\n{q}", r.summary),
        _ => r.summary.clone(),
    }
}

const REPORT_SYSTEM: &str = "You write the one report a coworker sends back after finishing a turn of work. Reply with JSON only. \
`summary`: 1 to 3 plain sentences saying what was done and where the result is (branch, PR link, files), no markdown headings. \
`needsYou`: true only if the coworker explicitly asks the person a question or says it cannot continue without a decision. \
A short or terse reply (even a single word), or a reply that merely completes the request, is finished work: needsYou false. \
`question`: when needsYou, the exact question to put to them, otherwise omit.";

fn report_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": { "summary": { "type": "string" }, "needsYou": { "type": "boolean" }, "question": { "type": "string" } },
        "required": ["summary", "needsYou"],
    })
}

fn report_prompt(name: &str, digest: &[String], files: &[String]) -> String {
    let files_line = if files.is_empty() {
        "No files were changed.".to_string()
    } else {
        format!("Changed files ({}): {}", files.len(), files.iter().take(12).cloned().collect::<Vec<_>>().join(", "))
    };
    let said = digest.iter().map(|d| clip(d, 1500)).collect::<Vec<_>>().join("\n---\n");
    format!("Teammate: {name}\n{files_line}\nTheir last message(s) this turn:\n{said}")
}

// ---------------------------------------------------------------- runtime

pub(crate) fn changed(app: &AppHandle, slug: &str) {
    let _ = app.emit("teammate-changed", slug);
}

pub(crate) fn post(app: &AppHandle, state: &AppState, m: TeammateMessage) {
    let slug = m.slug.clone();
    let _ = state.db().insert_teammate_message(&m);
    changed(app, &slug);
}

/// Hook for `on_agent_event`: a user message in a teammate's workspace (typed in the workspace itself)
/// reopens its task, so the turn's end is reported. `/compact` is housekeeping, not a request.
pub fn on_user_message(app: &AppHandle, state: &AppState, ws_id: &str, text: &str) {
    if text.trim_start().starts_with("/compact") {
        return;
    }
    let task = state.db().teammate_task_for_workspace(ws_id).ok().flatten();
    let Some(task) = task.filter(|t| t.status != "running" && t.status != "error") else { return };
    let _ = state.db().update_teammate_task(&task.id, "running", None, None);
    changed(app, &task.slug);
}

/// Hook for `on_agent_event`: the task workspace's turn ended. Posts the report into the thread
/// (an error or a stop right away, a finished turn once the report model has summarized it).
pub fn finish_turn(app: &AppHandle, state: &AppState, ws_id: &str, is_error: bool, error: Option<&str>, interrupted: bool) {
    let task = state.db().teammate_task_for_workspace(ws_id).ok().flatten();
    let Some(task) = task.filter(|t| t.status == "running") else { return };
    if is_error || interrupted {
        let route = route_turn(is_error, interrupted, false);
        let text = if interrupted { "Stopped before finishing. Send a message to continue.".to_string() } else { clip(error.unwrap_or("The turn failed"), SUMMARY_CHARS) };
        let finished = (route.task_status == "error").then(db::now);
        let _ = state.db().update_teammate_task(&task.id, route.task_status, Some(&text), finished);
        let mut m = message(&task.slug, route.role, route.kind, &text, Some(ws_id));
        m.status = Some(route.task_status.into());
        post(app, state, m);
        crate::chief::task_changed(app, state, &task.id);
        return;
    }
    let (app, state, ws_id) = (app.clone(), state.clone(), ws_id.to_string());
    tauri::async_runtime::spawn(async move { report(&app, &state, &task, &ws_id).await });
}

/// Changed files of the task workspace, minus agent housekeeping; None when git can't tell.
async fn changed_files(state: &AppState, ws_id: &str) -> Option<Vec<String>> {
    let ws = state.db().workspace(ws_id).ok();
    let repo = ws.as_ref().and_then(|w| state.db().repo(&w.repo_id).ok());
    let (ws, repo) = (ws?, repo?);
    let (path, base) = (PathBuf::from(&ws.path), repo.base_branch);
    tauri::async_runtime::spawn_blocking(move || git::changes(&path, &base).ok().map(crate::routines::significant_files)).await.ok().flatten()
}

async fn report(app: &AppHandle, state: &AppState, task: &TeammateTask, ws_id: &str) {
    let name = crate::teammates::get(&state.home, &task.slug).map(|t| t.name).unwrap_or_else(|| task.slug.clone());
    let events = state.db().events(ws_id).unwrap_or_default();
    let digest = crate::routines::last_assistant_texts(&events, 3);
    let files = changed_files(state, ws_id).await;
    let last = digest.last().cloned();
    let prompt = report_prompt(&name, &digest, files.as_deref().unwrap_or(&[]));
    let schema = report_schema();
    let call = crate::llm::complete_json(state, crate::llm::Task::TeammateReport, REPORT_SYSTEM, &prompt, &schema);
    let modelled = crate::trunk::bounded(std::time::Duration::from_secs(90), call).await.and_then(|v| parse_report(&v));
    let r = modelled.unwrap_or_else(|| fallback_report(last.as_deref()));
    let route = route_turn(false, false, r.needs_you);
    let finished = (route.task_status != "waiting").then(db::now);
    let _ = state.db().update_teammate_task(&task.id, route.task_status, Some(&r.summary), finished);
    let mut m = message(&task.slug, route.role, route.kind, &report_text(&r), Some(ws_id));
    m.status = Some(route.task_status.into());
    m.files = files.map(|f| f.len() as i64);
    post(app, state, m);
    crate::chief::task_changed(app, state, &task.id);
}

// ---------------------------------------------------------------- commands

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeammateView {
    #[serde(flatten)]
    pub teammate: Teammate,
    pub status: Status,
    pub last_message: Option<TeammateMessage>,
    pub open_tasks: usize,
    /// A report arrived since the user last opened the thread.
    pub unseen: bool,
}

fn seen_key(slug: &str) -> String {
    format!("teammate_seen:{slug}")
}

fn view(state: &AppState, teammate: Teammate) -> TeammateView {
    let slug = teammate.slug.clone();
    // Bind each db result first: the guard must be dropped before the next lock.
    let tasks = state.db().teammate_tasks(&slug).unwrap_or_default();
    let last_message = state.db().last_teammate_message(&slug).ok().flatten();
    let report_ts = state.db().last_teammate_report_ts(&slug).ok().flatten();
    let seen = state.db().setting(&seen_key(&slug)).ok().flatten().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    let unseen = report_ts.is_some_and(|ts| ts > seen);
    let open: Vec<&str> = tasks.iter().filter(|t| t.status == "running" || t.status == "waiting").map(|t| t.status.as_str()).collect();
    let status = if slug == crate::chief::SLUG {
        let plans = state.db().plans(&slug).unwrap_or_default();
        let shapes: Vec<(String, Vec<crate::chief::PartState>)> = plans.iter().map(|p| (p.status.clone(), crate::chief::part_states(state, p))).collect();
        crate::chief::derive_status(&shapes, unseen)
    } else {
        derive_status(&open, unseen)
    };
    TeammateView { status, open_tasks: open.len(), last_message, unseen, teammate }
}

#[tauri::command]
pub fn list_teammates(state: State<AppState>) -> Vec<TeammateView> {
    list(&state.home).into_iter().map(|t| view(&state, t)).collect()
}

#[tauri::command]
pub fn get_teammate(state: State<AppState>, slug: String) -> CmdResult<TeammateView> {
    let t = get(&state.home, &slug).ok_or_else(|| format!("No teammate `{slug}`"))?;
    Ok(view(&state, t))
}

#[tauri::command]
pub fn save_teammate(app: AppHandle, state: State<AppState>, input: TeammateInput) -> CmdResult<TeammateView> {
    let t = save(&state.home, input)?;
    changed(&app, &t.slug);
    Ok(view(&state, t))
}

/// Deletes a custom teammate, or resets an overridden starter one to its default.
#[tauri::command]
pub fn delete_teammate(app: AppHandle, state: State<AppState>, slug: String) -> CmdResult<()> {
    let bundled = BUNDLED.iter().any(|(b, _)| *b == slug);
    delete(&state.home, &slug)?;
    if !bundled {
        let _ = state.db().delete_teammate_data(&slug);
    }
    changed(&app, &slug);
    Ok(())
}

#[tauri::command]
pub fn teammate_thread(state: State<AppState>, slug: String, limit: Option<u32>) -> CmdResult<Vec<TeammateMessage>> {
    state.db().teammate_thread(&slug, limit.unwrap_or(200)).map_err(err)
}

#[tauri::command]
pub fn teammate_tasks(state: State<AppState>, slug: String) -> CmdResult<Vec<crate::handoff::TaskView>> {
    let tasks = state.db().teammate_tasks(&slug).map_err(err)?;
    Ok(tasks.into_iter().map(|t| crate::handoff::task_view(&state, t)).collect())
}

/// The user opened the thread: reports up to now no longer count as unseen.
#[tauri::command]
pub fn teammate_mark_seen(app: AppHandle, state: State<AppState>, slug: String) -> CmdResult<()> {
    state.db().set_setting(&seen_key(&slug), &db::now().to_string()).map_err(err)?;
    changed(&app, &slug);
    Ok(())
}

#[tauri::command]
pub fn teammate_memory(state: State<AppState>, slug: String) -> CmdResult<String> {
    if !valid_slug(&slug) {
        return Err(format!("invalid teammate id `{slug}`"));
    }
    Ok(read_memory(&state.home, &slug))
}

#[tauri::command]
pub fn set_teammate_memory(state: State<AppState>, slug: String, text: String) -> CmdResult<()> {
    if !valid_slug(&slug) {
        return Err(format!("invalid teammate id `{slug}`"));
    }
    ensure_memory(&state.home, &slug);
    std::fs::write(memory_path(&state.home, &slug), text).map_err(err)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    /// None for Chief: it plans instead of opening a workspace.
    pub workspace_id: Option<String>,
    pub new_task: bool,
}

/// Name for a task workspace: the first line of the message, shortened.
fn task_name(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = line.chars().take(60).collect();
    if short.is_empty() { "Task".into() } else if line.chars().count() > 60 { format!("{}…", short.trim_end()) } else { short }
}

/// Hands the teammate a message. Continues its open task (the message also shows in that workspace),
/// or starts a new one: a workspace it creates itself, with the message as the first prompt.
/// `new_task`: Some(true) forces a new task, None continues the open one if there is one.
#[tauri::command]
pub async fn teammate_send(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
    text: String,
    repo_id: Option<String>,
    new_task: Option<bool>,
) -> CmdResult<SendResult> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Write a message first".into());
    }
    let t = get(&state.home, &slug).ok_or_else(|| format!("No teammate `{slug}`"))?;
    if slug == crate::chief::SLUG {
        return crate::chief::send(&app, &state, &t, text, repo_id).await;
    }
    let open = state.db().open_teammate_task(&slug).map_err(err)?;
    // A task whose workspace has been archived cannot be continued.
    let live = state.db().workspaces().map_err(err)?;
    let open = open.filter(|task| live.iter().any(|w| w.id == task.workspace_id));
    match decide(new_task, open.as_ref()) {
        Delegation::Continue(_) => {
            let task = open.expect("Continue implies an open task");
            post(&app, &state, message(&slug, "user", "message", &text, Some(&task.workspace_id)));
            let _ = state.db().update_teammate_task(&task.id, "running", None, None);
            changed(&app, &slug);
            if let Err(e) = crate::send(&app, &state, &task.workspace_id, text.clone(), None, text) {
                post(&app, &state, message(&slug, "system", "error", &format!("Couldn't reach the task: {e}"), Some(&task.workspace_id)));
                return Err(err(e));
            }
            Ok(SendResult { workspace_id: Some(task.workspace_id), new_task: false })
        }
        Delegation::New => {
            let repos = state.db().repos().map_err(err)?;
            let repo_id = pick_repo(repo_id.as_deref(), &t.repos, &repos)?;
            let start = Start { slug, repo_id, name: None, display: text.clone(), payload: text, origin: Origin::default(), start_ref: None, user_message: true };
            let (_, ws) = start_task(&app, &state, start).await?;
            Ok(SendResult { workspace_id: Some(ws.id), new_task: true })
        }
    }
}

/// Where a task came from. All None = the user typed it into the teammate's thread.
#[derive(Debug, Clone, Default)]
pub struct Origin {
    pub parent_task_id: Option<String>,
    pub kind: Option<String>,
    pub reference: Option<String>,
}

pub struct Start {
    pub slug: String,
    pub repo_id: String,
    /// Workspace name; None = derived from `display`.
    pub name: Option<String>,
    /// What the thread shows: the user's message, or the brief for a delegated task.
    pub display: String,
    /// What the agent receives.
    pub payload: String,
    pub origin: Origin,
    /// Branch or ref the new worktree starts from instead of the repo's base (review hand-offs).
    pub start_ref: Option<String>,
    /// A task the user typed shows their message bubble; a delegated one shows its brief.
    pub user_message: bool,
}

fn task_row(slug: &str, ws_id: &str, repo_id: &str, origin: &Origin) -> TeammateTask {
    TeammateTask {
        id: uuid::Uuid::new_v4().to_string(),
        slug: slug.to_string(),
        workspace_id: ws_id.to_string(),
        repo_id: repo_id.to_string(),
        status: "running".into(),
        created_at: db::now(),
        finished_at: None,
        summary: None,
        parent_task_id: origin.parent_task_id.clone(),
        origin_kind: origin.kind.clone(),
        origin_ref: origin.reference.clone(),
    }
}

/// The thread entries a new task leaves: the user's message or the delegated brief, then the "Started" card.
fn announce(app: &AppHandle, state: &AppState, s: &Start, ws: &db::Workspace) {
    if s.user_message {
        post(app, state, message(&s.slug, "user", "message", &s.display, Some(&ws.id)));
    } else {
        let mut brief = message(&s.slug, "system", "brief", &s.display, Some(&ws.id));
        brief.meta = s.origin.kind.clone();
        post(app, state, brief);
    }
    let mut started = message(&s.slug, "teammate", "task_started", &ws.name, Some(&ws.id));
    started.status = Some("running".into());
    post(app, state, started);
}

/// Creates the workspace for a new task, records it, posts to the thread and sends the first prompt.
pub(crate) async fn start_task(app: &AppHandle, state: &AppState, s: Start) -> CmdResult<(TeammateTask, db::Workspace)> {
    let t = get(&state.home, &s.slug).ok_or_else(|| format!("No teammate `{}`", s.slug))?;
    let name = s.name.clone().unwrap_or_else(|| task_name(&s.display));
    let ws = create_workspace_inner(
        app,
        state,
        NewWorkspaceArgs {
            repo_id: s.repo_id.clone(),
            name,
            agent: t.agent.clone(),
            model: t.model.clone(),
            issue_number: None,
            profile: t.profile.clone(),
            routine_id: None,
            branch_prefix: None,
            teammate: Some(s.slug.clone()),
            start_ref: s.start_ref.clone(),
        },
    )
    .await?;
    let task = task_row(&s.slug, &ws.id, &s.repo_id, &s.origin);
    state.db().insert_teammate_task(&task).map_err(err)?;
    announce(app, state, &s, &ws);
    if s.name.is_none() && crate::is_derived_name(&ws.name, &s.display) {
        tauri::async_runtime::spawn(crate::name_workspace(app.clone(), state.clone(), ws.id.clone(), ws.name.clone(), s.display.clone()));
    }
    if let Err(e) = crate::send(app, state, &ws.id, s.display.clone(), None, s.payload.clone()) {
        let _ = state.db().update_teammate_task(&task.id, "error", Some(&e.to_string()), Some(db::now()));
        post(app, state, message(&s.slug, "system", "error", &format!("Couldn't start the task: {e}"), Some(&ws.id)));
        return Err(err(e));
    }
    Ok((task, ws))
}

/// Hands an existing workspace to another teammate of the same agent: the workspace takes over its role
/// (profile, identity, memory), keeps its branch and history, and a new task is opened for it.
pub(crate) fn adopt_task(app: &AppHandle, state: &AppState, s: Start, ws_id: &str) -> CmdResult<(TeammateTask, db::Workspace)> {
    let t = get(&state.home, &s.slug).ok_or_else(|| format!("No teammate `{}`", s.slug))?;
    let ws = state.db().workspace(ws_id).map_err(|_| "That workspace no longer exists".to_string())?;
    if ws.agent != t.agent {
        return Err(format!("{} uses a different agent than the workspace", t.name));
    }
    if ws.status == "running" {
        return Err("That workspace is still working".into());
    }
    state.db().set_workspace_teammate(ws_id, Some(&s.slug)).map_err(err)?;
    let ws = crate::switch_profile(app, state, ws_id, t.profile.as_deref()).map_err(err)?;
    let note = format!("[Orbit: this workspace was handed to {} ({}). Follow their instructions from now on; the earlier role no longer applies.]\n\n", t.name, s.slug);
    {
        let mut notices = state.role_notices.lock().unwrap();
        let merged = format!("{}{note}", notices.remove(ws_id).unwrap_or_default());
        notices.insert(ws_id.to_string(), merged);
    }
    let task = task_row(&s.slug, ws_id, &ws.repo_id, &s.origin);
    state.db().insert_teammate_task(&task).map_err(err)?;
    announce(app, state, &s, &ws);
    if let Err(e) = crate::send(app, state, ws_id, s.display.clone(), None, s.payload.clone()) {
        let _ = state.db().update_teammate_task(&task.id, "error", Some(&e.to_string()), Some(db::now()));
        post(app, state, message(&s.slug, "system", "error", &format!("Couldn't start the task: {e}"), Some(ws_id)));
        return Err(err(e));
    }
    Ok((task, ws))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn tmp_home() -> PathBuf {
        let d = std::env::temp_dir().join(format!("orbit-teammates-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn input(name: &str) -> TeammateInput {
        TeammateInput {
            slug: None,
            name: name.into(),
            avatar: "".into(),
            description: "Does \"things\": carefully".into(),
            agent: "claude".into(),
            model: Some("haiku".into()),
            profile: Some("builder".into()),
            repos: vec!["orbit".into(), "site".into()],
            readonly: Some(false),
            instructions: "Be brief.\nAsk before deleting.".into(),
        }
    }

    fn repo(id: &str, name: &str) -> Repo {
        Repo { id: id.into(), name: name.into(), path: format!("/{name}"), base_branch: "main".into() }
    }

    fn task(id: &str, status: &str) -> TeammateTask {
        TeammateTask { id: id.into(), slug: "builder".into(), workspace_id: format!("w-{id}"), repo_id: "r".into(), status: status.into(), created_at: 1, finished_at: None, summary: None, parent_task_id: None, origin_kind: None, origin_ref: None }
    }

    #[test]
    fn starter_team_parses_and_maps_to_profiles() {
        let home = tmp_home();
        let team = list(&home);
        let slugs: Vec<&str> = team.iter().map(|t| t.slug.as_str()).collect();
        assert_eq!(slugs, ["chief", "builder", "debugger", "planner", "reviewer", "shipper", "ticket-writer"]);
        let by = |s: &str| team.iter().find(|t| t.slug == s).unwrap();
        assert_eq!(by("builder").profile.as_deref(), Some("shipkit:builder"));
        assert_eq!(by("builder").agent, "claude");
        assert_eq!(by("reviewer").agent, "codex");
        assert_eq!(by("ticket-writer").name, "Ticket writer");
        assert_eq!(by("ticket-writer").avatar, "portrait:documentation");
        assert!(team.iter().all(|t| t.bundled && !t.overridden && !t.instructions.is_empty()));
        assert!(by("builder").instructions.contains("Never merge"));
    }

    #[test]
    fn definitions_round_trip_through_the_file() {
        let t = Teammate {
            slug: "scout".into(),
            name: "Scout".into(),
            avatar: "S".into(),
            description: "Does \"things\": carefully".into(),
            agent: "codex".into(),
            model: Some("gpt-5".into()),
            profile: Some("shipkit:planner".into()),
            repos: vec!["orbit".into(), "site".into()],
            readonly: Some(true),
            instructions: "Be brief.\n\nAsk before deleting.".into(),
            bundled: false,
            overridden: false,
        };
        assert_eq!(parse("scout", &render(&t), false, false), t);
        // Unset optionals stay unset, and a bare profile name is expanded.
        let bare_t = parse("x", "---\nname: X\nprofile: debugger\n---\nhi", false, false);
        assert_eq!((bare_t.readonly, bare_t.model, bare_t.profile.as_deref(), bare_t.agent.as_str()), (None, None, Some("shipkit:debugger"), "claude"));
        // Block-list repos fold into one line.
        assert_eq!(parse("x", "---\nrepos:\n  - a\n  - b\n---\n", false, false).repos, ["a", "b"]);
        // No frontmatter at all: defaults from the slug.
        let plain = parse("my-helper", "Just do it.", false, false);
        assert_eq!((plain.name.as_str(), plain.avatar.as_str(), plain.instructions.as_str()), ("My helper", "M", "Just do it."));
    }

    #[test]
    fn custom_teammates_override_and_reset() {
        let home = tmp_home();
        // New custom teammate: slug from the name, listed after the starter team.
        let s = save(&home, input("Scout")).unwrap();
        assert_eq!((s.slug.as_str(), s.avatar.as_str(), s.bundled), ("scout", "S", false));
        assert_eq!(s.profile.as_deref(), Some("shipkit:builder"));
        assert_eq!(list(&home).last().unwrap().slug, "scout");
        // Same name again does not clobber it.
        assert_eq!(save(&home, input("Scout")).unwrap().slug, "scout-2");
        // Overriding a starter teammate keeps its place and flags it.
        let mut over = input("Builder (mine)");
        over.slug = Some("builder".into());
        let o = save(&home, over).unwrap();
        assert!(o.bundled && o.overridden);
        let team = list(&home);
        assert_eq!(team[1].slug, "builder");
        assert_eq!(team[1].name, "Builder (mine)");
        assert!(team[1].overridden);
        assert_eq!(team.iter().filter(|t| t.slug == "builder").count(), 1);
        // Reset to default deletes the override only.
        delete(&home, "builder").unwrap();
        assert_eq!(get(&home, "builder").unwrap().name, "Builder");
        assert!(!get(&home, "builder").unwrap().overridden);
        assert!(delete(&home, "builder").is_err());
        // Deleting a custom teammate removes its file and memory.
        ensure_memory(&home, "scout");
        delete(&home, "scout").unwrap();
        assert!(get(&home, "scout").is_none());
        assert!(!memory_path(&home, "scout").exists());
        // Memory files are never mistaken for definitions.
        ensure_memory(&home, "scout-2");
        assert_eq!(list(&home).iter().filter(|t| t.slug.contains("memory")).count(), 0);
        // Validation.
        let mut bad = input("");
        assert!(save(&home, bad.clone()).is_err());
        bad.name = "Ok".into();
        bad.slug = Some("../evil".into());
        assert!(save(&home, bad.clone()).is_err());
        bad.slug = None;
        bad.agent = "gpt".into();
        assert!(save(&home, bad).is_err());
    }

    #[test]
    fn memory_is_capped_to_the_newest_notes() {
        assert_eq!(memory_excerpt("  - short  \n", 100), "- short");
        let notes: String = (0..400).map(|i| format!("- note number {i}\n")).collect();
        let cut = memory_excerpt(&notes, 200);
        assert!(cut.starts_with("(earlier notes trimmed)\n- note number "));
        assert!(cut.ends_with("- note number 399"));
        assert!(cut.len() <= 200 + "(earlier notes trimmed)\n".len());
        // Never splits a multi-byte character.
        let wide = "é".repeat(500);
        assert!(memory_excerpt(&wide, 101).chars().all(|c| c == 'é' || c.is_ascii()));
    }

    #[test]
    fn context_section_carries_memory_path_and_notes() {
        let home = tmp_home();
        let t = get(&home, "builder").unwrap();
        let fresh = context_section(&home, &t);
        let path = memory_path(&home, "builder");
        assert!(path.is_file());
        assert!(fresh.contains("You are Builder, a teammate"));
        assert!(fresh.contains(&path.display().to_string()));
        assert!(fresh.contains("(no notes yet)"));
        assert!(fresh.contains("never merge"));
        std::fs::write(&path, "# Memory\n- prefers small PRs\n").unwrap();
        assert!(context_section(&home, &t).contains("- prefers small PRs"));
    }

    #[test]
    fn delegation_continues_only_open_tasks_unless_forced() {
        let open = task("t1", "waiting");
        assert_eq!(decide(None, Some(&open)), Delegation::Continue("t1".into()));
        assert_eq!(decide(Some(false), Some(&open)), Delegation::Continue("t1".into()));
        assert_eq!(decide(Some(true), Some(&open)), Delegation::New);
        assert_eq!(decide(None, None), Delegation::New);
        assert_eq!(decide(Some(false), None), Delegation::New);
    }

    #[test]
    fn repo_choice_respects_the_allowed_list() {
        let repos = [repo("1", "orbit"), repo("2", "site"), repo("3", "docs")];
        // Any repo allowed: the user must pick when there are several, and may only pick known ones.
        assert!(pick_repo(None, &[], &repos).unwrap_err().contains("Pick a repository"));
        assert_eq!(pick_repo(Some("2"), &[], &repos).unwrap(), "2");
        assert!(pick_repo(Some("9"), &[], &repos).is_err());
        assert_eq!(pick_repo(None, &[], &repos[..1]).unwrap(), "1");
        assert!(pick_repo(None, &[], &[]).is_err());
        // One allowed repo (by name, any case) is chosen automatically; others are refused.
        let only = vec!["SITE".to_string()];
        assert_eq!(pick_repo(None, &only, &repos).unwrap(), "2");
        assert!(pick_repo(Some("1"), &only, &repos).is_err());
        // Allowed by id, two of three: still ambiguous.
        let two = vec!["1".to_string(), "docs".to_string()];
        assert!(pick_repo(None, &two, &repos).is_err());
        assert_eq!(pick_repo(Some("3"), &two, &repos).unwrap(), "3");
        // None of the allowed repos exist in Orbit.
        assert!(pick_repo(None, &["nope".to_string()], &repos).unwrap_err().contains("None of"));
    }

    #[test]
    fn status_working_beats_needs_you_beats_idle() {
        assert_eq!(derive_status(&[], false), Status::Idle);
        assert_eq!(derive_status(&[], true), Status::NeedsYou);
        assert_eq!(derive_status(&["waiting"], false), Status::NeedsYou);
        assert_eq!(derive_status(&["running"], false), Status::Working);
        assert_eq!(derive_status(&["waiting", "running"], true), Status::Working);
    }

    #[test]
    fn turn_routing() {
        assert_eq!(route_turn(false, false, false), Route { task_status: "done", role: "teammate", kind: "task_report" });
        assert_eq!(route_turn(false, false, true), Route { task_status: "waiting", role: "teammate", kind: "task_report" });
        assert_eq!(route_turn(true, false, false), Route { task_status: "error", role: "system", kind: "error" });
        // A stop keeps the task open so the next message continues it.
        assert_eq!(route_turn(false, true, false).task_status, "waiting");
        assert_eq!(route_turn(true, true, true).task_status, "waiting");
    }

    #[test]
    fn reports_parse_and_fall_back() {
        let ok = parse_report(&serde_json::json!({ "summary": " Fixed it on branch x. ", "needsYou": true, "question": "Merge now?" })).unwrap();
        assert_eq!(ok, Report { summary: "Fixed it on branch x.".into(), needs_you: true, question: Some("Merge now?".into()) });
        assert_eq!(report_text(&ok), "Fixed it on branch x.\n\nMerge now?");
        // A question only counts when the teammate is blocked on it.
        let quiet = parse_report(&serde_json::json!({ "summary": "Done.", "needsYou": false, "question": "Anything else?" })).unwrap();
        assert_eq!((quiet.needs_you, quiet.question), (false, None));
        assert!(parse_report(&serde_json::json!({ "summary": "  ", "needsYou": false })).is_none());
        assert!(parse_report(&serde_json::json!({ "needsYou": true })).is_none());
        // Fallback: the agent's own last message, trimmed; a trailing question keeps the task waiting.
        let long = "x".repeat(2000);
        let f = fallback_report(Some(&long));
        assert_eq!(f.summary.chars().count(), SUMMARY_CHARS + 1);
        assert!(f.summary.ends_with('…') && !f.needs_you);
        assert!(!fallback_report(Some("set")).needs_you);
        assert!(REPORT_SYSTEM.contains("single word"));
        assert!(fallback_report(Some("Added the test.\n\nShould I also update the docs?")).needs_you);
        assert_eq!(fallback_report(None).summary, "Finished.");
        assert_eq!(fallback_report(Some("   ")).summary, "Finished.");
        // The summary already contains the question: not repeated.
        let dup = Report { summary: "Should I merge?".into(), needs_you: true, question: Some("Should I merge?".into()) };
        assert_eq!(report_text(&dup), "Should I merge?");
    }

    #[test]
    fn task_names_come_from_the_first_line() {
        assert_eq!(task_name("  Fix the login bug\nwith details"), "Fix the login bug");
        assert!(task_name(&"word ".repeat(40)).ends_with('…'));
        assert_eq!(task_name("   "), "Task");
    }

    #[test]
    fn threads_and_tasks_persist() {
        let db = Db::memory();
        let mut m1 = message("builder", "user", "message", "Fix the bug", Some("w1"));
        m1.ts = 10;
        let mut m2 = message("builder", "teammate", "task_started", "Fix the bug", Some("w1"));
        m2.ts = 10;
        m2.status = Some("running".into());
        let mut m3 = message("builder", "teammate", "task_report", "Fixed.", Some("w1"));
        m3.ts = 20;
        m3.files = Some(3);
        for m in [&m1, &m2, &m3, &message("planner", "user", "message", "other thread", None)] {
            db.insert_teammate_message(m).unwrap();
        }
        let thread = db.teammate_thread("builder", 10).unwrap();
        assert_eq!(thread.iter().map(|m| m.kind.as_str()).collect::<Vec<_>>(), ["message", "task_started", "task_report"]);
        assert_eq!(db.teammate_thread("builder", 2).unwrap().len(), 2);
        assert_eq!(db.teammate_thread("builder", 2).unwrap()[1].files, Some(3));
        assert_eq!(db.last_teammate_message("builder").unwrap().unwrap().text, "Fixed.");
        assert_eq!(db.last_teammate_report_ts("builder").unwrap(), Some(20));
        assert_eq!(db.last_teammate_report_ts("planner").unwrap(), None);

        let mut t = task("t1", "running");
        t.workspace_id = "w1".into();
        db.insert_teammate_task(&t).unwrap();
        assert_eq!(db.open_teammate_task("builder").unwrap().unwrap().id, "t1");
        assert_eq!(db.teammate_task_for_workspace("w1").unwrap().unwrap().status, "running");
        db.update_teammate_task("t1", "waiting", Some("needs an answer"), None).unwrap();
        assert_eq!(db.open_teammate_task("builder").unwrap().unwrap().summary.as_deref(), Some("needs an answer"));
        db.update_teammate_task("t1", "done", None, Some(99)).unwrap();
        let done = db.teammate_tasks("builder").unwrap();
        assert_eq!((done[0].status.as_str(), done[0].finished_at, done[0].summary.as_deref()), ("done", Some(99), Some("needs an answer")));
        assert!(db.open_teammate_task("builder").unwrap().is_none());
        db.delete_teammate_data("builder").unwrap();
        assert!(db.teammate_thread("builder", 10).unwrap().is_empty() && db.teammate_tasks("builder").unwrap().is_empty());
        assert_eq!(db.teammate_thread("planner", 10).unwrap().len(), 1);
    }

    #[test]
    fn readonly_follows_the_profile_unless_set() {
        assert!(effective_readonly(None, true));
        assert!(!effective_readonly(None, false));
        assert!(effective_readonly(Some(true), false));
        assert!(!effective_readonly(Some(false), true));
    }
}
