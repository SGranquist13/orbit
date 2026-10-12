//! Chief, the coordinator teammate. You message Chief with a vague request; one planning call (a
//! utility model call through `llm`, `Task::ChiefPlan`, not an agent session: splitting a request needs
//! the request, the repo's shape and the team's descriptions, not tools) returns a plan: parts, each
//! for one teammate, some depending on others. The plan sits in Chief's thread as a card until you
//! Start it. Starting creates one task per part through the same `teammates::start_task` path a direct
//! message uses; a part with dependencies waits until those tasks report `done`, then starts by itself
//! with their summaries and branches added to its brief. When every part is done Chief posts one
//! combined report. Children stop at draft PRs as always; Chief never merges.
//!
//! `parent_task_id` of a child task holds the plan id (`origin_kind` = chief). Plans live in
//! `teammate_plans` (parts as JSON); a part's live state comes from its task's status.

use crate::db;
use crate::teammates::{self, clip, message, post, Origin, SendResult, Start, Teammate};
use crate::{err, AppState, CmdResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use tauri::{AppHandle, State};

pub const SLUG: &str = "chief";
/// A plan with more parts than this is a sign the request should be split by the user first.
const MAX_PARTS: usize = 6;
const PLAN_TIMEOUT_SECS: u64 = 120;

// ---------------------------------------------------------------- plan model

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanPart {
    /// Teammate slug.
    pub teammate: String,
    pub title: String,
    pub brief: String,
    /// Indices (into the plan's parts) that must be done before this one starts.
    #[serde(default)]
    pub depends_on: Vec<usize>,
    /// Set once the part has been started.
    #[serde(default)]
    pub task_id: Option<String>,
    /// The part could not be started (workspace creation failed).
    #[serde(default)]
    pub failed: Option<String>,
    /// A failure has been announced in the thread.
    #[serde(default)]
    pub notified: bool,
}

/// `status`: planning | proposed | running | done | cancelled | failed.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub slug: String,
    pub repo_id: String,
    pub request: String,
    pub summary: String,
    pub parts: Vec<PlanPart>,
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PartState {
    Pending,
    Running,
    Waiting,
    Done,
    Failed,
}

pub fn part_state(task_status: Option<&str>, start_failed: bool) -> PartState {
    if start_failed {
        return PartState::Failed;
    }
    match task_status {
        Some("running") => PartState::Running,
        Some("waiting") => PartState::Waiting,
        Some("done") => PartState::Done,
        Some("error") => PartState::Failed,
        _ => PartState::Pending,
    }
}

/// Parts that can start now: not started yet, every dependency done.
pub fn startable(states: &[PartState], deps: &[Vec<usize>]) -> Vec<usize> {
    (0..states.len()).filter(|&i| states[i] == PartState::Pending && deps[i].iter().all(|&d| states.get(d) == Some(&PartState::Done))).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Progress {
    Running,
    Done,
    /// Nothing is running and nothing can start, but not everything is done: a part failed.
    Stuck,
}

pub fn progress(states: &[PartState], deps: &[Vec<usize>]) -> Progress {
    if !states.is_empty() && states.iter().all(|s| *s == PartState::Done) {
        Progress::Done
    } else if states.iter().any(|s| matches!(s, PartState::Running | PartState::Waiting)) || !startable(states, deps).is_empty() {
        Progress::Running
    } else {
        Progress::Stuck
    }
}

/// Chief's status like a person's: needs you when a plan awaits Start or a part failed or asks a
/// question; working while it plans or parts run; otherwise an unseen report counts.
pub fn derive_status(plans: &[(String, Vec<PartState>)], unseen_report: bool) -> teammates::Status {
    use teammates::Status;
    let needs = plans.iter().any(|(status, parts)| {
        status == "proposed" || (status == "running" && parts.iter().any(|p| matches!(p, PartState::Failed | PartState::Waiting)))
    });
    let working = plans.iter().any(|(status, parts)| status == "planning" || (status == "running" && parts.iter().any(|p| matches!(p, PartState::Running | PartState::Pending))));
    if needs {
        Status::NeedsYou
    } else if working {
        Status::Working
    } else if unseen_report {
        Status::NeedsYou
    } else {
        Status::Idle
    }
}

// ---------------------------------------------------------------- parsing and validation

fn plan_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string" },
            "parts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "teammate": { "type": "string" },
                        "title": { "type": "string" },
                        "brief": { "type": "string" },
                        "dependsOn": { "type": "array", "items": { "type": "integer" } }
                    },
                    "required": ["teammate", "title", "brief"]
                }
            }
        },
        "required": ["summary", "parts"]
    })
}

/// Cycle check over the kept parts (Kahn). True when every part can be ordered.
fn acyclic(deps: &[Vec<usize>]) -> bool {
    let n = deps.len();
    let mut indegree: Vec<usize> = deps.iter().map(Vec::len).collect();
    let mut queue: VecDeque<usize> = (0..n).filter(|&i| indegree[i] == 0).collect();
    let mut seen = 0;
    while let Some(i) = queue.pop_front() {
        seen += 1;
        for (j, d) in deps.iter().enumerate() {
            if d.contains(&i) {
                indegree[j] -= 1;
                if indegree[j] == 0 {
                    queue.push_back(j);
                }
            }
        }
    }
    seen == n
}

/// `{ summary, parts: [{ teammate, title, brief, dependsOn? }] }` from the model (or the Edit form).
/// Parts for unknown teammates (or empty briefs) are dropped and the dependency indices remapped; a
/// dependency on a dropped part is dropped with it. Self and out-of-range dependencies are ignored. A
/// dependency cycle is an error: nothing could ever start.
pub fn parse_plan(v: &Value, known: &[String]) -> Result<(String, Vec<PlanPart>), String> {
    let raw = v["parts"].as_array().ok_or("The plan has no parts")?;
    let raw = &raw[..raw.len().min(MAX_PARTS)];
    let mut new_index: Vec<Option<usize>> = vec![None; raw.len()];
    let mut parts: Vec<PlanPart> = vec![];
    for (i, p) in raw.iter().enumerate() {
        let teammate = p["teammate"].as_str().unwrap_or("").trim().to_lowercase();
        let brief = p["brief"].as_str().unwrap_or("").trim().to_string();
        if brief.is_empty() || teammate == SLUG || !known.contains(&teammate) {
            continue;
        }
        let title = Some(p["title"].as_str().unwrap_or("").trim()).filter(|t| !t.is_empty()).map_or_else(|| clip(brief.lines().next().unwrap_or(""), 60), |t| clip(t, 80));
        new_index[i] = Some(parts.len());
        parts.push(PlanPart { teammate, title, brief, ..Default::default() });
    }
    if parts.is_empty() {
        return Err("Chief couldn't match this request to any of your teammates".into());
    }
    for (i, p) in raw.iter().enumerate() {
        let Some(me) = new_index[i] else { continue };
        let mut deps: Vec<usize> = p["dependsOn"].as_array().map(|a| a.iter().filter_map(Value::as_u64).filter_map(|d| new_index.get(d as usize).copied().flatten()).filter(|&d| d != me).collect()).unwrap_or_default();
        deps.sort_unstable();
        deps.dedup();
        parts[me].depends_on = deps;
    }
    let deps: Vec<Vec<usize>> = parts.iter().map(|p| p.depends_on.clone()).collect();
    if !acyclic(&deps) {
        return Err("The plan has a dependency cycle: no part could start".into());
    }
    let summary = v["summary"].as_str().map(str::trim).filter(|s| !s.is_empty()).map_or_else(|| "A plan for this request".to_string(), |s| clip(s, 400));
    Ok((summary, parts))
}

const PLAN_SYSTEM: &str = "You are Chief, a coordinator. Split the request into parts for your teammates and reply with JSON only. \
`summary`: one or two sentences saying how you split it and why. `parts`: the smallest set of parts that gets it done (usually two to four). \
Each part has `teammate` (one of the listed ids, exactly), `title` (at most 8 words), `brief` (a self-contained instruction for that teammate: what to do, where in the repo, what done looks like) \
and optionally `dependsOn`: zero-based indices of parts in this same list whose results it needs. Run parts in parallel unless one truly needs another's result. \
Every part stops at a draft pull request; never plan a merge. Do not invent teammates.";

/// The team as the planning call sees it: id, name, description.
pub struct Member {
    pub slug: String,
    pub name: String,
    pub description: String,
}

pub fn plan_prompt(request: &str, repo: &str, listing: &[String], team: &[Member]) -> String {
    let team_lines: Vec<String> = team.iter().map(|m| format!("- {} ({}): {}", m.slug, m.name, if m.description.is_empty() { "no description" } else { &m.description })).collect();
    let top = if listing.is_empty() { "(unknown)".to_string() } else { listing.join(", ") };
    format!("Repository: {repo}\nTop-level files and folders: {top}\n\nTeammates you can use:\n{}\n\nRequest:\n{request}", team_lines.join("\n"))
}

// ---------------------------------------------------------------- briefs and reports

/// What an earlier part left behind, for the parts that depend on it.
pub struct Prior {
    pub title: String,
    pub teammate: String,
    pub summary: String,
    pub branch: Option<String>,
}

/// A part's brief plus the results of the parts it waited for.
pub fn dependency_brief(brief: &str, priors: &[Prior]) -> String {
    if priors.is_empty() {
        return brief.to_string();
    }
    let lines: Vec<String> = priors
        .iter()
        .map(|p| {
            let branch = p.branch.as_deref().map(|b| format!(" [branch: {b}]")).unwrap_or_default();
            format!("- {} ({}){branch}: {}", p.title, p.teammate, p.summary)
        })
        .collect();
    format!("{brief}\n\nEarlier parts of this plan are done. Build on them (their branches are in the same repository):\n{}", lines.join("\n"))
}

/// One line per part; used when the report model is Off, slow or wrong.
pub fn combined_fallback(summary: &str, parts: &[(String, String, String)]) -> String {
    let lines: Vec<String> = parts.iter().map(|(title, name, text)| format!("- {title} ({name}): {text}")).collect();
    format!("{summary}\n\nAll parts are done:\n{}", lines.join("\n"))
}

const COMBINED_SYSTEM: &str = "You are Chief. Your teammates finished the parts of a plan. Write the one report you send back, as JSON. \
`summary`: 2 to 5 plain sentences: what got done overall, where the results are (branches, PR links), and what the person should look at first. No markdown headings. \
`needsYou`: true only if something is blocked on the person's decision.";

fn combined_prompt(request: &str, parts: &[(String, String, String)]) -> String {
    let lines: Vec<String> = parts.iter().map(|(title, name, text)| format!("Part \"{title}\" by {name}:\n{}", clip(text, 700))).collect();
    format!("Original request:\n{request}\n\nReports:\n{}", lines.join("\n---\n"))
}

// ---------------------------------------------------------------- runtime

/// Part states from live task rows.
pub fn part_states(state: &AppState, plan: &Plan) -> Vec<PartState> {
    plan.parts
        .iter()
        .map(|p| {
            let task = p.task_id.as_deref().and_then(|id| state.db().teammate_task(id).ok().flatten());
            part_state(task.as_ref().map(|t| t.status.as_str()), p.failed.is_some())
        })
        .collect()
}

fn save_plan(state: &AppState, plan: &Plan) {
    let _ = state.db().update_plan(plan);
}

fn repo_listing(path: &str) -> Vec<String> {
    let skip = [".git", "node_modules", "target", ".claude", ".codex", "dist", ".next"];
    let mut names: Vec<String> = std::fs::read_dir(path)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    let dir = e.path().is_dir();
                    (!skip.contains(&n.as_str())).then(|| if dir { format!("{n}/") } else { n })
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.truncate(40);
    names
}

/// A message to Chief: records the request, posts a plan card in the "planning" state and asks the model.
pub async fn send(app: &AppHandle, state: &AppState, t: &Teammate, text: String, repo_id: Option<String>) -> CmdResult<SendResult> {
    let repos = state.db().repos().map_err(err)?;
    let repo_id = teammates::pick_repo(repo_id.as_deref(), &t.repos, &repos)?;
    let plan = Plan { id: uuid::Uuid::new_v4().to_string(), slug: SLUG.into(), repo_id, request: text.clone(), summary: String::new(), parts: vec![], status: "planning".into(), created_at: db::now() };
    state.db().insert_plan(&plan).map_err(err)?;
    post(app, state, message(SLUG, "user", "message", &text, None));
    let mut card = message(SLUG, "teammate", "plan", "", None);
    card.meta = Some(plan.id.clone());
    post(app, state, card);
    tauri::async_runtime::spawn(plan_request(app.clone(), state.clone(), plan.id.clone(), t.instructions.clone()));
    Ok(SendResult { workspace_id: None, new_task: true })
}

async fn plan_request(app: AppHandle, state: AppState, plan_id: String, instructions: String) {
    let Some(mut plan) = state.db().plan(&plan_id).ok().flatten() else { return };
    let repo = state.db().repo(&plan.repo_id).ok();
    let repos_one: Vec<db::Repo> = repo.iter().cloned().collect();
    let team: Vec<Member> = teammates::list(&state.home)
        .into_iter()
        .filter(|m| m.slug != SLUG && teammates::pick_repo(Some(&plan.repo_id), &m.repos, &repos_one).is_ok())
        .map(|m| Member { slug: m.slug, name: m.name, description: m.description })
        .collect();
    let known: Vec<String> = team.iter().map(|m| m.slug.clone()).collect();
    let listing = repo.as_ref().map(|r| repo_listing(&r.path)).unwrap_or_default();
    let prompt = plan_prompt(&plan.request, repo.as_ref().map_or("(unknown)", |r| r.name.as_str()), &listing, &team);
    let system = if instructions.trim().is_empty() { PLAN_SYSTEM.to_string() } else { format!("{PLAN_SYSTEM}\n\nYour standing instructions:\n{}", instructions.trim()) };
    let schema = plan_schema();
    let call = crate::llm::complete_json(&state, crate::llm::Task::ChiefPlan, &system, &prompt, &schema);
    let outcome = match crate::trunk::bounded(std::time::Duration::from_secs(PLAN_TIMEOUT_SECS), call).await {
        Some(v) => parse_plan(&v, &known),
        None => Err("The planning call didn't answer (check Settings > Models, or try again)".into()),
    };
    match outcome {
        Ok((summary, parts)) => {
            plan.summary = summary;
            plan.parts = parts;
            plan.status = "proposed".into();
        }
        Err(e) => {
            plan.summary = e.clone();
            plan.status = "failed".into();
            post(&app, &state, message(SLUG, "system", "error", &format!("Couldn't plan that: {e}"), None));
        }
    }
    save_plan(&state, &plan);
    teammates::changed(&app, SLUG);
}

/// Hook for `teammates::report` / `finish_turn`: a task changed status. If a Chief plan owns it, advance the plan.
pub fn task_changed(app: &AppHandle, state: &AppState, task_id: &str) {
    let task = state.db().teammate_task(task_id).ok().flatten();
    let Some(task) = task.filter(|t| t.origin_kind.as_deref() == Some("chief")) else { return };
    let Some(plan_id) = task.parent_task_id else { return };
    let (app, state) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move { advance(&app, &state, &plan_id).await });
}

/// One advance at a time: two parts finishing together must not both start the same dependant.
static ADVANCE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Starts every part that is ready, announces failures, and posts the combined report once all are done.
pub async fn advance(app: &AppHandle, state: &AppState, plan_id: &str) {
    let finished = {
        let _guard = ADVANCE.lock().await;
        let Some(mut plan) = state.db().plan(plan_id).ok().flatten() else { return };
        if plan.status != "running" {
            return;
        }
        let deps: Vec<Vec<usize>> = plan.parts.iter().map(|p| p.depends_on.clone()).collect();
        for i in startable(&part_states(state, &plan), &deps) {
            start_part(app, state, &mut plan, i).await;
            save_plan(state, &plan);
            teammates::changed(app, SLUG);
        }
        let states = part_states(state, &plan);
        for (i, st) in states.iter().enumerate() {
            if *st == PartState::Failed && !plan.parts[i].notified {
                plan.parts[i].notified = true;
                let part = &plan.parts[i];
                let why = part.failed.clone().or_else(|| part.task_id.as_deref().and_then(|id| state.db().teammate_task(id).ok().flatten()).and_then(|t| t.summary)).unwrap_or_else(|| "it failed".into());
                post(app, state, message(SLUG, "system", "error", &format!("\"{}\" ({}) failed: {}", part.title, part.teammate, clip(&why, 300)), None));
            }
        }
        let done = progress(&states, &deps) == Progress::Done;
        if done {
            plan.status = "done".into();
        }
        save_plan(state, &plan);
        teammates::changed(app, SLUG);
        done.then_some(plan)
    };
    if let Some(plan) = finished {
        finish_plan(app, state, &plan).await;
    }
}

async fn start_part(app: &AppHandle, state: &AppState, plan: &mut Plan, i: usize) {
    let priors: Vec<Prior> = plan.parts[i]
        .depends_on
        .iter()
        .filter_map(|&d| {
            let part = plan.parts.get(d)?;
            let task = part.task_id.as_deref().and_then(|id| state.db().teammate_task(id).ok().flatten())?;
            let ws = state.db().workspace(&task.workspace_id).ok();
            let name = teammates::get(&state.home, &part.teammate).map_or_else(|| part.teammate.clone(), |t| t.name);
            Some(Prior { title: part.title.clone(), teammate: name, summary: task.summary.unwrap_or_else(|| "Finished.".into()), branch: ws.map(|w| w.branch) })
        })
        .collect();
    let part = plan.parts[i].clone();
    let brief = dependency_brief(&part.brief, &priors);
    let start = Start {
        slug: part.teammate.clone(),
        repo_id: plan.repo_id.clone(),
        name: Some(clip(&part.title, 60)),
        display: brief.clone(),
        payload: brief,
        origin: Origin { parent_task_id: Some(plan.id.clone()), kind: Some("chief".into()), reference: Some(SLUG.into()) },
        start_ref: None,
        user_message: false,
    };
    match teammates::start_task(app, state, start).await {
        Ok((task, _)) => plan.parts[i].task_id = Some(task.id),
        Err(e) => plan.parts[i].failed = Some(e),
    }
}

/// The combined report: one model call over the children's summaries, falling back to a list.
async fn finish_plan(app: &AppHandle, state: &AppState, plan: &Plan) {
    let reports: Vec<(String, String, String)> = plan
        .parts
        .iter()
        .map(|p| {
            let task = p.task_id.as_deref().and_then(|id| state.db().teammate_task(id).ok().flatten());
            let name = teammates::get(&state.home, &p.teammate).map_or_else(|| p.teammate.clone(), |t| t.name);
            (p.title.clone(), name, task.and_then(|t| t.summary).unwrap_or_else(|| "Finished.".into()))
        })
        .collect();
    let prompt = combined_prompt(&plan.request, &reports);
    let schema = serde_json::json!({ "type": "object", "properties": { "summary": { "type": "string" }, "needsYou": { "type": "boolean" } }, "required": ["summary", "needsYou"] });
    let call = crate::llm::complete_json(state, crate::llm::Task::TeammateReport, COMBINED_SYSTEM, &prompt, &schema);
    let modelled = crate::trunk::bounded(std::time::Duration::from_secs(90), call).await.and_then(|v| v["summary"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
    let text = modelled.unwrap_or_else(|| combined_fallback(&plan.summary, &reports));
    let mut m = message(SLUG, "teammate", "task_report", &text, None);
    m.status = Some("done".into());
    m.meta = Some(plan.id.clone());
    post(app, state, m);
}

// ---------------------------------------------------------------- commands

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartView {
    #[serde(flatten)]
    pub part: PlanPart,
    pub state: PartState,
    pub summary: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    #[serde(flatten)]
    pub plan: Plan,
    /// Same order as `plan.parts`, with live state; the flattened `parts` carries the raw definitions.
    pub views: Vec<PartView>,
}

fn view(state: &AppState, plan: Plan) -> PlanView {
    let states = part_states(state, &plan);
    let views = plan
        .parts
        .iter()
        .zip(states)
        .map(|(p, st)| {
            let task = p.task_id.as_deref().and_then(|id| state.db().teammate_task(id).ok().flatten());
            PartView { part: p.clone(), state: st, summary: task.as_ref().and_then(|t| t.summary.clone()).or_else(|| p.failed.clone()), workspace_id: task.map(|t| t.workspace_id) }
        })
        .collect();
    PlanView { plan, views }
}

#[tauri::command]
pub fn teammate_plans(state: State<AppState>, slug: String) -> CmdResult<Vec<PlanView>> {
    let plans = state.db().plans(&slug).map_err(err)?;
    Ok(plans.into_iter().map(|p| view(&state, p)).collect())
}

fn load(state: &AppState, id: &str) -> CmdResult<Plan> {
    state.db().plan(id).map_err(err)?.ok_or_else(|| "That plan no longer exists".to_string())
}

/// Start all: the plan runs; parts with no dependencies start now.
#[tauri::command]
pub async fn chief_plan_start(app: AppHandle, state: State<'_, AppState>, plan_id: String) -> CmdResult<()> {
    let mut plan = load(&state, &plan_id)?;
    if plan.status != "proposed" {
        return Err("This plan isn't waiting to be started".into());
    }
    plan.status = "running".into();
    state.db().update_plan(&plan).map_err(err)?;
    teammates::changed(&app, SLUG);
    advance(&app, &state, &plan_id).await;
    Ok(())
}

/// Edit: replaces the proposed plan's summary and parts (same validation as the model's reply).
#[tauri::command]
pub fn chief_plan_edit(app: AppHandle, state: State<AppState>, plan_id: String, plan: Value) -> CmdResult<()> {
    let mut current = load(&state, &plan_id)?;
    if current.status != "proposed" {
        return Err("Only a plan that hasn't started can be edited".into());
    }
    let repos = state.db().repos().map_err(err)?;
    let repos_one: Vec<db::Repo> = repos.into_iter().filter(|r| r.id == current.repo_id).collect();
    let known: Vec<String> = teammates::list(&state.home).into_iter().filter(|m| m.slug != SLUG && teammates::pick_repo(Some(&current.repo_id), &m.repos, &repos_one).is_ok()).map(|m| m.slug).collect();
    let (summary, parts) = parse_plan(&plan, &known)?;
    current.summary = summary;
    current.parts = parts;
    state.db().update_plan(&current).map_err(err)?;
    teammates::changed(&app, SLUG);
    Ok(())
}

/// Cancel: a proposed plan is dropped; a running plan stops starting parts (running ones finish).
#[tauri::command]
pub fn chief_plan_cancel(app: AppHandle, state: State<AppState>, plan_id: String) -> CmdResult<()> {
    let mut plan = load(&state, &plan_id)?;
    if plan.status == "done" || plan.status == "cancelled" {
        return Ok(());
    }
    plan.status = "cancelled".into();
    state.db().update_plan(&plan).map_err(err)?;
    teammates::changed(&app, SLUG);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn known() -> Vec<String> {
        ["builder", "reviewer", "planner"].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plan_parsing_drops_unknown_teammates_and_remaps_dependencies() {
        let v = json!({
            "summary": " Split in three. ",
            "parts": [
                { "teammate": "planner", "title": "Plan it", "brief": "Write the plan" },
                { "teammate": "wizard", "title": "Magic", "brief": "Do magic" },
                { "teammate": "Builder", "title": "Build", "brief": "Build it", "dependsOn": [0, 1, 2, 9] },
                { "teammate": "chief", "title": "Self", "brief": "Loop" },
                { "teammate": "reviewer", "title": "Review", "brief": "Check it", "dependsOn": [2] }
            ]
        });
        let (summary, parts) = parse_plan(&v, &known()).unwrap();
        assert_eq!(summary, "Split in three.");
        assert_eq!(parts.iter().map(|p| p.teammate.as_str()).collect::<Vec<_>>(), ["planner", "builder", "reviewer"]);
        // Builder depended on 0 (kept), 1 (dropped), itself (2) and 9 (out of range): only planner stays.
        assert_eq!(parts[1].depends_on, [0]);
        // The reviewer's dependency on old index 2 now points at new index 1.
        assert_eq!(parts[2].depends_on, [1]);
        assert!(parts.iter().all(|p| p.task_id.is_none() && !p.notified));
    }

    #[test]
    fn plan_parsing_rejects_cycles_and_empty_plans() {
        let cyc = json!({ "parts": [
            { "teammate": "builder", "title": "A", "brief": "a", "dependsOn": [1] },
            { "teammate": "reviewer", "title": "B", "brief": "b", "dependsOn": [0] }
        ]});
        assert!(parse_plan(&cyc, &known()).unwrap_err().contains("cycle"));
        // A self dependency is ignored rather than counted as a cycle.
        let selfdep = json!({ "parts": [{ "teammate": "builder", "title": "A", "brief": "a", "dependsOn": [0] }] });
        assert_eq!(parse_plan(&selfdep, &known()).unwrap().1[0].depends_on, Vec::<usize>::new());
        // All unknown / blank briefs / no parts key.
        assert!(parse_plan(&json!({ "parts": [{ "teammate": "nobody", "title": "x", "brief": "y" }] }), &known()).is_err());
        assert!(parse_plan(&json!({ "parts": [{ "teammate": "builder", "title": "x", "brief": "  " }] }), &known()).is_err());
        assert!(parse_plan(&json!({ "summary": "x" }), &known()).is_err());
        // A missing summary or title gets a sensible default; parts are capped.
        let many = json!({ "parts": (0..9).map(|i| json!({ "teammate": "builder", "brief": format!("job {i}") })).collect::<Vec<_>>() });
        let (summary, parts) = parse_plan(&many, &known()).unwrap();
        assert_eq!((parts.len(), parts[0].title.as_str()), (MAX_PARTS, "job 0"));
        assert!(!summary.is_empty());
    }

    #[test]
    fn scheduling_starts_only_ready_parts() {
        use PartState::*;
        let deps = vec![vec![], vec![0], vec![0, 1], vec![]];
        // Nothing started: the roots go, dependants wait.
        assert_eq!(startable(&[Pending, Pending, Pending, Pending], &deps), [0, 3]);
        // The first finished: its dependant is ready, the one needing two is not.
        assert_eq!(startable(&[Done, Pending, Pending, Running], &deps), [1]);
        assert_eq!(startable(&[Done, Done, Pending, Done], &deps), [2]);
        // Running, waiting and failed parts never restart; a failed dependency blocks its dependants.
        assert_eq!(startable(&[Failed, Pending, Pending, Waiting], &deps), Vec::<usize>::new());
        assert_eq!(startable(&[Done, Running, Pending, Done], &deps), Vec::<usize>::new());
    }

    #[test]
    fn progress_and_status() {
        use PartState::*;
        let deps = vec![vec![], vec![0]];
        assert_eq!(progress(&[Done, Done], &deps), Progress::Done);
        assert_eq!(progress(&[Running, Pending], &deps), Progress::Running);
        assert_eq!(progress(&[Done, Pending], &deps), Progress::Running);
        assert_eq!(progress(&[Waiting, Pending], &deps), Progress::Running);
        assert_eq!(progress(&[Failed, Pending], &deps), Progress::Stuck);
        assert_eq!(progress(&[], &[]), Progress::Stuck);

        let plan = |status: &str, parts: &[PartState]| (status.to_string(), parts.to_vec());
        use teammates::Status as S;
        assert_eq!(derive_status(&[], false), S::Idle);
        assert_eq!(derive_status(&[], true), S::NeedsYou);
        assert_eq!(derive_status(&[plan("planning", &[])], false), S::Working);
        // A plan awaiting Start needs you; so does a failed or asking part even while others run.
        assert_eq!(derive_status(&[plan("proposed", &[Pending])], false), S::NeedsYou);
        assert_eq!(derive_status(&[plan("running", &[Running, Failed])], false), S::NeedsYou);
        assert_eq!(derive_status(&[plan("running", &[Running, Waiting])], false), S::NeedsYou);
        assert_eq!(derive_status(&[plan("running", &[Done, Running])], false), S::Working);
        assert_eq!(derive_status(&[plan("running", &[Done, Pending])], false), S::Working);
        // Finished, cancelled and failed-to-plan plans are quiet.
        assert_eq!(derive_status(&[plan("done", &[Done]), plan("cancelled", &[Pending]), plan("failed", &[])], false), S::Idle);
    }

    #[test]
    fn briefs_carry_earlier_results() {
        assert_eq!(dependency_brief("Review it", &[]), "Review it");
        let b = dependency_brief(
            "Review it",
            &[Prior { title: "Build".into(), teammate: "Builder".into(), summary: "Done, PR #5.".into(), branch: Some("orbit/build-ab12".into()) }, Prior { title: "Docs".into(), teammate: "Writer".into(), summary: "Done.".into(), branch: None }],
        );
        assert!(b.starts_with("Review it\n\n"));
        assert!(b.contains("- Build (Builder) [branch: orbit/build-ab12]: Done, PR #5."));
        assert!(b.contains("- Docs (Writer): Done."));
        let f = combined_fallback("Two parts.", &[("A".into(), "Builder".into(), "ok".into()), ("B".into(), "Reviewer".into(), "fine".into())]);
        assert_eq!(f, "Two parts.\n\nAll parts are done:\n- A (Builder): ok\n- B (Reviewer): fine");
    }

    #[test]
    fn the_planning_prompt_lists_team_and_repo() {
        let team = [Member { slug: "builder".into(), name: "Builder".into(), description: "Builds".into() }, Member { slug: "x".into(), name: "X".into(), description: "".into() }];
        let p = plan_prompt("Do the thing", "orbit", &["src/".into(), "README.md".into()], &team);
        assert!(p.contains("Repository: orbit") && p.contains("src/, README.md"));
        assert!(p.contains("- builder (Builder): Builds") && p.contains("- x (X): no description"));
        assert!(p.ends_with("Request:\nDo the thing"));
    }

    #[test]
    fn plans_persist_with_their_parts() {
        let db = db::Db::memory();
        let mut plan = Plan {
            id: "p1".into(),
            slug: SLUG.into(),
            repo_id: "r".into(),
            request: "Ship it".into(),
            summary: "Two parts".into(),
            parts: vec![PlanPart { teammate: "builder".into(), title: "Build".into(), brief: "b".into(), ..Default::default() }, PlanPart { teammate: "reviewer".into(), title: "Review".into(), brief: "r".into(), depends_on: vec![0], ..Default::default() }],
            status: "proposed".into(),
            created_at: 5,
        };
        db.insert_plan(&plan).unwrap();
        assert_eq!(db.plan("p1").unwrap().unwrap(), plan);
        plan.status = "running".into();
        plan.parts[0].task_id = Some("t1".into());
        db.update_plan(&plan).unwrap();
        assert_eq!(db.plans(SLUG).unwrap(), vec![plan.clone()]);
        assert!(db.plans("builder").unwrap().is_empty() && db.plan("nope").unwrap().is_none());
        // Child tasks are found by their parent (the plan id).
        let mut t = teammates::TeammateTask {
            id: "t1".into(), slug: "builder".into(), workspace_id: "w".into(), repo_id: "r".into(), status: "done".into(), created_at: 1, finished_at: Some(2), summary: Some("ok".into()),
            parent_task_id: Some("p1".into()), origin_kind: Some("chief".into()), origin_ref: Some(SLUG.into()),
        };
        db.insert_teammate_task(&t).unwrap();
        t.id = "t2".into();
        t.parent_task_id = None;
        db.insert_teammate_task(&t).unwrap();
        assert_eq!(db.teammate_child_tasks("p1").unwrap().iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["t1"]);
        assert_eq!(db.teammate_task("t1").unwrap().unwrap().origin_kind.as_deref(), Some("chief"));
        db.delete_teammate_data(SLUG).unwrap();
        assert!(db.plans(SLUG).unwrap().is_empty());
    }
}
