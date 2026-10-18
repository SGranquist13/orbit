//! Routines: messages that run on a schedule (every Monday at 9, once tomorrow at 3pm, or a cron
//! expression). A tokio task ticks every 30s; a due routine gets a workspace (fresh each run, or one
//! standing workspace) and its action is sent through the normal `send` path, so the transcript,
//! inbox, notifications and the phone all see it like any other turn. Routines only run while Orbit
//! is open; a run missed while it was closed happens once on launch, never once per miss.

use crate::agent::AgentKind;
use crate::db::{self, Workspace};
use crate::{archive_inner, create_workspace_inner, err, git, run_skill_with, AppState, CmdResult, NewWorkspaceArgs};
use chrono::{DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

const TICK_SECS: u64 = 30;
const SUMMARY_CHARS: usize = 500;
/// Format of `Schedule::at`: a local wall-clock time without zone.
const AT_FORMAT: &str = "%Y-%m-%dT%H:%M";

// ---------------------------------------------------------------- schedule

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    Once,
    Hourly,
    Daily,
    Weekdays,
    Weekly,
    Cron,
}

/// All times are local. `time` is "HH:MM" (hourly uses only the minutes, default :00),
/// `weekday` is 0-6 with 0 = Sunday (same as cron and JS), `at` is "YYYY-MM-DDTHH:MM" for `once`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub kind: ScheduleKind,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(default)]
    pub weekday: Option<u8>,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
}

fn parse_time(s: &str) -> Result<NaiveTime, String> {
    let (h, m) = s.split_once(':').ok_or_else(|| format!("invalid time \"{s}\" (expected HH:MM)"))?;
    let (h, m): (u32, u32) = (h.parse().map_err(|_| format!("invalid time \"{s}\""))?, m.parse().map_err(|_| format!("invalid time \"{s}\""))?);
    NaiveTime::from_hms_opt(h, m, 0).ok_or_else(|| format!("invalid time \"{s}\""))
}

fn parse_at(s: &str) -> Result<NaiveDateTime, String> {
    NaiveDateTime::parse_from_str(s, AT_FORMAT).map_err(|_| format!("invalid date/time \"{s}\" (expected YYYY-MM-DDTHH:MM)"))
}

impl Schedule {
    pub fn validate(&self) -> Result<(), String> {
        match self.kind {
            ScheduleKind::Once => {
                parse_at(self.at.as_deref().ok_or("pick a date and time")?)?;
            }
            ScheduleKind::Hourly => {
                if let Some(t) = &self.time {
                    parse_time(t)?;
                }
            }
            ScheduleKind::Daily | ScheduleKind::Weekdays => {
                parse_time(self.time.as_deref().ok_or("pick a time")?)?;
            }
            ScheduleKind::Weekly => {
                parse_time(self.time.as_deref().ok_or("pick a time")?)?;
                if self.weekday.ok_or("pick a day of the week")? > 6 {
                    return Err("weekday must be 0-6".into());
                }
            }
            ScheduleKind::Cron => {
                Cron::parse(self.cron.as_deref().ok_or("enter a cron expression")?)?;
            }
        }
        Ok(())
    }
}

/// A parsed 5-field cron expression (minute hour day-of-month month day-of-week).
#[derive(Debug, Clone, PartialEq)]
pub struct Cron {
    minutes: u64,
    hours: u64,
    dom: u64,
    months: u64,
    dow: u64,
    dom_star: bool,
    dow_star: bool,
}

/// One field into a bitmask over `min..=max`: `*`, `*/n`, `a`, `a-b`, `a-b/n`, `a/n`, comma lists.
fn parse_field(src: &str, name: &str, min: u32, max: u32) -> Result<u64, String> {
    let bad = || format!("invalid cron {name} field \"{src}\"");
    let mut mask = 0u64;
    for part in src.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => (r, s.parse::<u32>().map_err(|_| bad())?),
            None => (part, 1),
        };
        if step == 0 {
            return Err(bad());
        }
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (a.parse().map_err(|_| bad())?, b.parse().map_err(|_| bad())?)
        } else {
            let v: u32 = range.parse().map_err(|_| bad())?;
            // "5/15" means "from 5 to the end, every 15".
            (v, if part.contains('/') { max } else { v })
        };
        if lo < min || hi > max || lo > hi {
            return Err(bad());
        }
        let mut v = lo;
        while v <= hi {
            mask |= 1 << v;
            v += step;
        }
    }
    Ok(mask)
}

impl Cron {
    pub fn parse(expr: &str) -> Result<Self, String> {
        let f: Vec<&str> = expr.split_whitespace().collect();
        if f.len() != 5 {
            return Err(format!("cron needs 5 fields (minute hour day month weekday), got {}", f.len()));
        }
        let mut dow = parse_field(f[4], "weekday", 0, 7)?;
        if dow & (1 << 7) != 0 {
            dow = (dow | 1) & !(1 << 7); // 7 is Sunday too
        }
        Ok(Self {
            minutes: parse_field(f[0], "minute", 0, 59)?,
            hours: parse_field(f[1], "hour", 0, 23)?,
            dom: parse_field(f[2], "day", 1, 31)?,
            months: parse_field(f[3], "month", 1, 12)?,
            dow,
            dom_star: f[2].starts_with('*'),
            dow_star: f[4].starts_with('*'),
        })
    }

    fn day_matches(&self, d: NaiveDate) -> bool {
        if self.months & (1 << d.month()) == 0 {
            return false;
        }
        let dom = self.dom & (1 << d.day()) != 0;
        let dow = self.dow & (1 << d.weekday().num_days_from_sunday()) != 0;
        // Like Vixie cron: when both day fields are restricted, either may match.
        match (self.dom_star, self.dow_star) {
            (true, true) => true,
            (true, false) => dow,
            (false, true) => dom,
            (false, false) => dom || dow,
        }
    }
}

type Resolve<'a> = &'a dyn Fn(NaiveDateTime) -> LocalResult<DateTime<Utc>>;

/// Local wall time to an instant. The repeated hour of a fall-back resolves to its first
/// occurrence; a time inside a spring-forward gap resolves one hour later.
fn resolve_local(naive: NaiveDateTime, resolve: Resolve) -> Option<DateTime<Utc>> {
    resolve(naive).earliest().or_else(|| resolve(naive + Duration::hours(1)).earliest())
}

/// Zone-agnostic core of `next_after`: `resolve` maps local wall time to an instant (tests plug in
/// fake DST rules). Returns the first scheduled instant strictly after `from`.
fn next_core(s: &Schedule, from: DateTime<Utc>, from_local: NaiveDateTime, resolve: Resolve) -> Option<DateTime<Utc>> {
    let first_after = |naive: NaiveDateTime| resolve_local(naive, resolve).filter(|t| *t > from);
    let today = from_local.date();
    match s.kind {
        ScheduleKind::Once => resolve_local(parse_at(s.at.as_deref()?).ok()?, resolve).filter(|t| *t > from),
        ScheduleKind::Hourly => {
            let minute = s.time.as_deref().and_then(|t| parse_time(t).ok()).map_or(0, |t| t.minute());
            let base = today.and_hms_opt(from_local.hour(), minute, 0)?;
            (0..30).find_map(|i| first_after(base + Duration::hours(i)))
        }
        ScheduleKind::Daily | ScheduleKind::Weekdays | ScheduleKind::Weekly => {
            let time = parse_time(s.time.as_deref()?).ok()?;
            (0..=14).find_map(|d| {
                let date = today + Duration::days(d);
                let dow = date.weekday().num_days_from_sunday();
                let ok = match s.kind {
                    ScheduleKind::Weekdays => (1..=5).contains(&dow),
                    ScheduleKind::Weekly => Some(dow as u8) == s.weekday,
                    _ => true,
                };
                if ok { first_after(date.and_time(time)) } else { None }
            })
        }
        ScheduleKind::Cron => {
            let cron = Cron::parse(s.cron.as_deref()?).ok()?;
            // Eight years of days covers a Feb 29 that also needs a particular weekday.
            (0..366 * 8).find_map(|d| {
                let date = today + Duration::days(d);
                if !cron.day_matches(date) {
                    return None;
                }
                (0..24u32).filter(|h| cron.hours & (1 << h) != 0).find_map(|h| {
                    (0..60u32).filter(|m| cron.minutes & (1 << m) != 0).find_map(|m| first_after(date.and_hms_opt(h, m, 0)?))
                })
            })
        }
    }
}

/// The first run strictly after `from`, in local time; None when the schedule never fires again
/// (a past one-off) or is invalid.
pub fn next_after(s: &Schedule, from: DateTime<Local>) -> Option<DateTime<Local>> {
    let resolve = |n: NaiveDateTime| Local.from_local_datetime(&n).map(|d| d.with_timezone(&Utc));
    next_core(s, from.with_timezone(&Utc), from.naive_local(), &resolve).map(|t| t.with_timezone(&Local))
}

fn next_after_ms(s: &Schedule, from_ms: i64) -> Option<i64> {
    let from = Local.timestamp_millis_opt(from_ms).single()?;
    next_after(s, from).map(|t| t.timestamp_millis())
}

// ---------------------------------------------------------------- model

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    /// A chat message; a leading `/skill args` is expanded like in the composer.
    Prompt { text: String },
    Skill {
        skill_id: String,
        #[serde(default)]
        args: String,
    },
    /// Orbit's Simplify pass over what landed on base in the last 7 days: apply the low-risk
    /// candidates, and if anything stuck, ship them as a draft `refactor/` PR.
    Simplify,
}

/// How far back a Simplify routine looks.
const SIMPLIFY_DAYS: u32 = 7;
const SIMPLIFY_PREFIX: &str = "refactor/";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Fresh,
    Standing,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Fresh => "fresh",
            Mode::Standing => "standing",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "fresh" => Some(Mode::Fresh),
            "standing" => Some(Mode::Standing),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub schedule: Schedule,
    pub action: Action,
    pub agent: String,
    pub model: Option<String>,
    pub profile: Option<String>,
    pub mode: Mode,
    pub standing_workspace_id: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    /// Status of the most recent run, for the list's dot (computed on read).
    pub last_status: Option<String>,
    /// Slug of the teammate that owns this routine: its runs are tasks in that teammate's thread.
    pub teammate: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRun {
    pub id: String,
    pub routine_id: String,
    pub workspace_id: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    /// running | done | error | quiet | skipped
    pub status: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInput {
    pub id: Option<String>,
    pub repo_id: String,
    #[serde(default)]
    pub name: String,
    pub schedule: Schedule,
    pub action: Action,
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    pub mode: Mode,
    /// Bind a standing routine to an existing workspace (scheduling from the chat).
    #[serde(default)]
    pub standing_workspace_id: Option<String>,
    pub enabled: bool,
    /// Owner: a teammate slug, or None for a plain routine.
    #[serde(default)]
    pub teammate: Option<String>,
}

// ---------------------------------------------------------------- pure decisions

/// The teammate a run goes through, if any. Only message routines can be owned: a teammate takes a task,
/// not a skill call or a Simplify pass.
pub fn owner_of(r: &Routine) -> Option<&str> {
    r.teammate.as_deref().filter(|_| matches!(r.action, Action::Prompt { .. }))
}

/// Rules for owned routines: message only, and a fresh workspace each run (each run is a new task).
pub fn check_owner(teammate: Option<&str>, action: &Action, mode: Mode) -> Result<(), String> {
    if teammate.is_none() {
        return Ok(());
    }
    if !matches!(action, Action::Prompt { .. }) {
        return Err("A teammate's routine sends a message; skills and Simplify run without an owner".into());
    }
    if mode != Mode::Fresh {
        return Err("A teammate's routine starts a new task each run".into());
    }
    Ok(())
}

/// Which due routines to start this tick, oldest due first. Busy ones are skipped (and rescheduled);
/// at the concurrency cap the rest stay due for the next tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Due {
    Start,
    Skip,
}

pub fn plan_tick(routines: &[Routine], now: i64, running: usize, cap: usize, busy: &dyn Fn(&Routine) -> bool) -> Vec<(String, Due)> {
    let mut due: Vec<&Routine> = routines.iter().filter(|r| r.enabled && r.next_run_at.is_some_and(|n| n <= now)).collect();
    due.sort_by_key(|r| r.next_run_at);
    let mut slots = cap.saturating_sub(running);
    let mut plan = vec![];
    for r in due {
        if busy(r) {
            plan.push((r.id.clone(), Due::Skip));
        } else if slots > 0 {
            slots -= 1;
            plan.push((r.id.clone(), Due::Start));
        }
    }
    plan
}

/// A fresh run that finished cleanly and left nothing behind is just noise: archive it.
pub fn is_quiet(mode: Mode, status: &str, changed_files: usize, own_commits: bool) -> bool {
    mode == Mode::Fresh && status == "done" && changed_files == 0 && !own_commits
}

/// The summary model's verdict can also make a fresh, cleanly finished run quiet, but only when it left
/// no file changes behind (the model never archives work).
pub fn is_quiet_by_model(mode: Mode, status: &str, changed_files: usize, nothing_to_do: bool) -> bool {
    mode == Mode::Fresh && status == "done" && changed_files == 0 && nothing_to_do
}

pub const SUMMARY_SYSTEM: &str = "You summarize what a scheduled coding-agent run did, for a history list. Reply with one or two plain \
sentences (under 300 characters) saying what was done or found, not how. Set nothingToDo to true only when the run found nothing to do \
and changed nothing.";

pub fn summary_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": { "summary": { "type": "string" }, "nothingToDo": { "type": "boolean" } },
        "required": ["summary", "nothingToDo"]
    })
}

/// The summary prompt: the agent's closing message(s) and the files it changed (both capped).
pub fn summary_prompt(routine: &str, messages: &[String], files: &[String]) -> String {
    let said: String = messages.iter().map(|m| m.trim()).filter(|m| !m.is_empty()).collect::<Vec<_>>().join("\n---\n");
    let said: String = said.chars().rev().take(3_000).collect::<Vec<_>>().into_iter().rev().collect();
    let changed = if files.is_empty() {
        "none".to_string()
    } else {
        let shown: Vec<&str> = files.iter().take(30).map(String::as_str).collect();
        let more = files.len().saturating_sub(shown.len());
        format!("{}{}", shown.join(", "), if more > 0 { format!(" and {more} more") } else { String::new() })
    };
    format!("Routine: {routine}\n\nThe agent's closing message(s):\n{said}\n\nFiles changed: {changed}")
}

/// `(summary, nothingToDo)` from the model's reply; None when the summary is empty.
pub fn parse_summary(reply: &serde_json::Value) -> Option<(String, bool)> {
    let summary = reply["summary"].as_str()?.trim();
    (!summary.is_empty()).then(|| (trim_summary(summary), reply["nothingToDo"].as_bool().unwrap_or(false)))
}

/// The agent's messages from its last turn(s): back to the most recent user message, oldest first, at most `n`.
pub fn last_assistant_texts(events: &[db::StoredEvent], n: usize) -> Vec<String> {
    use crate::agent::AgentEvent;
    let mut out: Vec<String> = events
        .iter()
        .rev()
        .take_while(|e| !matches!(e.event, AgentEvent::UserMessage { .. }))
        .filter_map(|e| match &e.event {
            AgentEvent::Message { text } => Some(text.clone()),
            _ => None,
        })
        .take(n)
        .collect();
    out.reverse();
    out
}

fn trim_summary(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= SUMMARY_CHARS {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(SUMMARY_CHARS).collect::<String>().trim_end())
    }
}

/// Name used when the user left it blank: the first line of the prompt.
fn default_name(action: &Action) -> String {
    let line = match action {
        Action::Prompt { text } => text.trim().lines().next().unwrap_or("").trim().to_string(),
        Action::Skill { skill_id, .. } => format!("/{skill_id}"),
        Action::Simplify => "Simplify recent changes".to_string(),
    };
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > 48 {
        format!("{}…", line.chars().take(47).collect::<String>())
    } else if line.is_empty() {
        "Routine".into()
    } else {
        line
    }
}

fn routine_note(name: &str) -> String {
    format!(
        "[Scheduled routine \"{name}\"] This is an unattended scheduled run and nobody is watching live. You may commit your work and open a draft PR, but never merge a PR. If there is nothing to do, say so in one line and stop."
    )
}

// ---------------------------------------------------------------- runtime

fn changed(app: &AppHandle) {
    let _ = app.emit("routines-changed", ());
}

fn is_busy(state: &AppState, r: &Routine) -> bool {
    let running_run = state.db().routine_has_running_run(&r.id).unwrap_or(false);
    let standing_running = r.mode == Mode::Standing
        && r.standing_workspace_id.as_deref().is_some_and(|id| state.db().workspace(id).map(|w| w.status == "running").unwrap_or(false));
    running_run || standing_running
}

/// Starts the scheduler loop (called once from `run()` setup).
pub fn start(app: AppHandle, state: AppState) {
    tauri::async_runtime::spawn(async move {
        // Runs that were in flight when Orbit last closed can never complete.
        let _ = state.db().fail_stale_runs(db::now(), "Orbit closed during the run");
        loop {
            tick(&app, &state).await;
            tokio::time::sleep(std::time::Duration::from_secs(TICK_SECS)).await;
        }
    });
}

async fn tick(app: &AppHandle, state: &AppState) {
    let now = db::now();
    let routines = state.db().routines().unwrap_or_default();
    let running = state.db().running_runs_count().unwrap_or(0);
    let cap = state.settings().routine_concurrency as usize;
    let plan = plan_tick(&routines, now, running, cap, &|r| is_busy(state, r));
    let any = !plan.is_empty();
    for (id, due) in plan {
        let Some(r) = routines.iter().find(|r| r.id == id) else { continue };
        // Reschedule before starting so a slow start can never fire twice. A finished one-off
        // has no next time and switches itself off (it stays in the list as done).
        let next = next_after_ms(&r.schedule, now);
        let enabled = next.is_some() || r.schedule.kind != ScheduleKind::Once;
        let _ = state.db().set_routine_next(&id, next, enabled);
        match due {
            Due::Skip => {
                let run = RoutineRun {
                    id: uuid::Uuid::new_v4().to_string(),
                    routine_id: id.clone(),
                    workspace_id: r.standing_workspace_id.clone(),
                    started_at: now,
                    finished_at: Some(now),
                    status: "skipped".into(),
                    summary: Some("The previous run was still going".into()),
                };
                let _ = state.db().insert_run(&run);
                changed(app);
            }
            Due::Start => {
                if let Err(e) = start_run(app, state, &id).await {
                    eprintln!("routine {id} failed to start: {e}");
                }
            }
        }
    }
    if any {
        changed(app);
    }
}

/// Creates the run record and workspace and sends the action. Returns the run (status `running`).
pub async fn start_run(app: &AppHandle, state: &AppState, routine_id: &str) -> Result<RoutineRun, String> {
    let routine = state.db().routine(routine_id).map_err(err)?;
    let now = db::now();
    let mut run = RoutineRun {
        id: uuid::Uuid::new_v4().to_string(),
        routine_id: routine.id.clone(),
        workspace_id: None,
        started_at: now,
        finished_at: None,
        status: "running".into(),
        summary: None,
    };
    state.db().insert_run(&run).map_err(err)?;
    let _ = state.db().set_routine_last_run(&routine.id, now);
    changed(app);
    match launch(app, state, &routine).await {
        Ok(ws) => {
            let _ = state.db().set_run_workspace(&run.id, &ws.id);
            run.workspace_id = Some(ws.id);
            changed(app);
            Ok(run)
        }
        Err(e) => {
            let _ = state.db().finish_run(&run.id, "error", Some(&trim_summary(&e)), db::now());
            changed(app);
            Err(e)
        }
    }
}

/// An owned routine: the run is a task in the teammate's thread, marked as scheduled.
async fn launch_via_teammate(app: &AppHandle, state: &AppState, routine: &Routine, slug: &str) -> Result<Workspace, String> {
    let Action::Prompt { text } = &routine.action else { return Err("not a message routine".into()) };
    let t = crate::teammates::get(&state.home, slug).ok_or_else(|| format!("The owner `{slug}` no longer exists"))?;
    let repos = state.db().repos().map_err(err)?;
    let repo_id = crate::teammates::pick_repo(Some(&routine.repo_id), &t.repos, &repos)?;
    let start = crate::teammates::Start {
        slug: slug.to_string(),
        repo_id,
        name: Some(format!("{} {}", routine.name, Local::now().format("%Y-%m-%d %H:%M"))),
        display: text.clone(),
        payload: format!("{}\n\n{text}", routine_note(&routine.name)),
        origin: crate::teammates::Origin { parent_task_id: None, kind: Some("routine".into()), reference: Some(routine.name.clone()) },
        start_ref: None,
        user_message: false,
    };
    crate::teammates::start_task(app, state, start).await.map(|(_, ws)| ws)
}

async fn launch(app: &AppHandle, state: &AppState, routine: &Routine) -> Result<Workspace, String> {
    if let Some(slug) = owner_of(routine) {
        return launch_via_teammate(app, state, routine, slug).await;
    }
    let existing = routine
        .standing_workspace_id
        .as_deref()
        .filter(|_| routine.mode == Mode::Standing)
        .and_then(|id| state.db().workspaces().ok().and_then(|list| list.into_iter().find(|w| w.id == id)));
    let ws = match existing {
        Some(ws) => ws,
        None => {
            let name = match routine.mode {
                Mode::Fresh => format!("{} {}", routine.name, Local::now().format("%Y-%m-%d %H:%M")),
                Mode::Standing => routine.name.clone(),
            };
            let ws = create_workspace_inner(
                app,
                state,
                NewWorkspaceArgs {
                    repo_id: routine.repo_id.clone(),
                    name,
                    agent: routine.agent.clone(),
                    model: routine.model.clone(),
                    issue_number: None,
                    profile: routine.profile.clone(),
                    routine_id: Some(routine.id.clone()),
                    branch_prefix: (routine.action == Action::Simplify).then(|| SIMPLIFY_PREFIX.to_string()),
                    teammate: None,
                    start_ref: None,
                },
            )
            .await?;
            if routine.mode == Mode::Standing {
                let _ = state.db().set_routine_standing(&routine.id, &ws.id);
            }
            ws
        }
    };
    let note = routine_note(&routine.name);
    match &routine.action {
        Action::Prompt { text } => {
            let payload = format!("{note}\n\n{text}");
            crate::send(app, state, &ws.id, text.clone(), None, payload).map_err(err)?;
        }
        Action::Skill { skill_id, args } => {
            run_skill_with(app, state, &ws.id, skill_id, args, &format!("{args}\n\n{note}"))?;
        }
        Action::Simplify => {
            set_stage(&ws.id, Some(Stage::Simplifying));
            tauri::async_runtime::spawn(run_simplify(app.clone(), state.clone(), ws.id.clone(), routine.name.clone()));
        }
    }
    Ok(ws)
}

// ---------------------------------------------------------------- simplify action

/// Where an unattended Simplify run is. The agent's own turns (one per candidate, then the ship turn)
/// all end in a `TurnCompleted`, but only the ship turn ends the run, so `finish_turn` consults this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Simplifying,
    Shipping,
}

static STAGES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Stage>>> = std::sync::LazyLock::new(Default::default);

fn set_stage(ws_id: &str, stage: Option<Stage>) {
    let mut map = STAGES.lock().unwrap_or_else(|p| p.into_inner());
    match stage {
        Some(s) => map.insert(ws_id.to_string(), s),
        None => map.remove(ws_id),
    };
}

fn stage(ws_id: &str) -> Option<Stage> {
    STAGES.lock().unwrap_or_else(|p| p.into_inner()).get(ws_id).copied()
}

const SHIP_NOTES: &str = "This is an unattended Simplify run. Every commit on this branch is a behaviour-preserving `refactor:` cleanup of code merged \
to the base branch in the last 7 days. Open a draft PR titled `refactor: ...` that lists them; do not add or change behaviour.";

/// Find and apply the low-risk simplifications; if any stuck, run the ship gate and hand the agent the
/// ship skill (the run then finishes with that turn). Otherwise the run finishes here: quiet when the
/// workspace is untouched.
async fn run_simplify(app: AppHandle, state: AppState, ws_id: String, name: String) {
    let mut outcome = crate::simplify::run_unattended(&app, &state, &ws_id, SIMPLIFY_DAYS).await;
    let mut shipped = false;
    if outcome.applied > 0 {
        match ship_refactors(&app, &state, &ws_id, &name).await {
            Ok(None) => shipped = true,
            Ok(Some(why)) => outcome.summary = format!("{} {why}", outcome.summary),
            Err(e) => {
                outcome.summary = format!("{} Could not ship: {e}", outcome.summary);
                outcome.error = Some(e);
            }
        }
    }
    if shipped {
        return; // finish_turn ends the run when the ship turn completes
    }
    set_stage(&ws_id, None);
    let run = state.db().running_run_for_workspace(&ws_id).ok().flatten();
    let ws = state.db().workspace(&ws_id).ok();
    let Some(run) = run else { return };
    let status = if outcome.error.is_some() { "error" } else { "done" };
    let finish = Finish {
        status,
        summary: trim_summary(&outcome.summary),
        digest: vec![outcome.summary.clone()],
        is_error: status == "error",
        error: outcome.error.clone(),
        interrupted: false,
        // Reverted steps leave reset entries in the branch's reflog; they are not work of its own.
        ignore_reflog: true,
    };
    finish_run_with(&app, &state, run, &ws_id, ws, finish);
}

/// The ship gate, then `shipkit:ship` with notes. Ok(None) = shipping started; Ok(Some(why)) = not shipped.
async fn ship_refactors(app: &AppHandle, state: &AppState, ws_id: &str, name: &str) -> Result<Option<String>, String> {
    // The last edit turn's status update can trail the apply loop by a moment.
    for _ in 0..50 {
        if state.db().workspace(ws_id).map(|w| w.status != "running").unwrap_or(true) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let prep = crate::trunk::prepare_ship_inner(app, state, ws_id, false).await?;
    if !prep.ok {
        return Ok(Some("The checks failed on the combined result, so nothing was shipped; the commits stay on the branch.".into()));
    }
    let mut notes = SHIP_NOTES.to_string();
    if let Some(draft) = prep.notes {
        notes = format!("{notes}\n\n{draft}");
    }
    set_stage(ws_id, Some(Stage::Shipping));
    if let Err(e) = run_skill_with(app, state, ws_id, "shipkit:ship", "", &format!("{notes}\n\n{}", routine_note(name))) {
        set_stage(ws_id, Some(Stage::Simplifying));
        return Err(e);
    }
    Ok(None)
}

/// Called from `on_agent_event` on every `TurnCompleted`. If the workspace has a running routine run,
/// finishes it and returns true; the caller then skips its own notification, because a quiet run should
/// not ping anyone (the notification is sent here instead once we know the run was worth looking at).
/// Mid-way through an unattended Simplify run the turn belongs to the pass, not the run: swallowed.
pub fn finish_turn(app: &AppHandle, state: &AppState, ws_id: &str, ws: Option<&Workspace>, is_error: bool, error: Option<&str>, interrupted: bool) -> bool {
    let run = state.db().running_run_for_workspace(ws_id).ok().flatten();
    let Some(run) = run else { return false };
    match stage(ws_id) {
        Some(Stage::Simplifying) => return true,
        Some(Stage::Shipping) => set_stage(ws_id, None),
        None => {}
    }
    let last_text = state.db().summary(ws_id).ok().and_then(|s| s.last_assistant_text);
    let (status, summary) = if interrupted {
        ("error", "Stopped before finishing".to_string())
    } else if is_error {
        ("error", trim_summary(error.or(last_text.as_deref()).unwrap_or("The turn failed")))
    } else {
        ("done", trim_summary(last_text.as_deref().unwrap_or("Finished")))
    };
    let finish = Finish {
        status,
        summary,
        digest: vec![],
        is_error,
        error: error.map(str::to_string),
        interrupted,
        ignore_reflog: false,
    };
    finish_run_with(app, state, run, ws_id, ws.cloned(), finish);
    true
}

/// How a run ended, before the summary model has had its say.
struct Finish {
    status: &'static str,
    /// Stored on the row right away; the summary model may replace it a moment later.
    summary: String,
    /// What the summary model reads. Empty = the agent's last message(s), read from the transcript.
    digest: Vec<String>,
    is_error: bool,
    error: Option<String>,
    interrupted: bool,
    /// The branch's reflog counts reverted Simplify steps as the run's own commits; this ignores that.
    ignore_reflog: bool,
}

/// Finishes the run row synchronously, then (off the event thread) decides whether the run was quiet,
/// notifies if not, and asks the summary model for a better summary. The row never waits on the model.
fn finish_run_with(app: &AppHandle, state: &AppState, run: RoutineRun, ws_id: &str, ws: Option<Workspace>, f: Finish) {
    let _ = state.db().finish_run(&run.id, f.status, Some(&f.summary), db::now());
    changed(app);
    let (app, state, ws_id) = (app.clone(), state.clone(), ws_id.to_string());
    tauri::async_runtime::spawn(async move {
        let routine = state.db().routine(&run.routine_id).ok();
        let fresh = routine.as_ref().is_some_and(|r| r.mode == Mode::Fresh);
        let probe = if fresh && f.status == "done" { probe_workspace(&state, &ws_id).await } else { None };
        let quiet = probe.as_ref().is_some_and(|p| is_quiet(Mode::Fresh, "done", p.files.len(), p.own_commits && !f.ignore_reflog));
        match &probe {
            Some(p) if !quiet && fresh && f.status == "done" => {
                eprintln!("routine run {} not quiet: {} changed file(s), own commits: {}", run.id, p.files.len(), p.own_commits && !f.ignore_reflog)
            }
            None if fresh && f.status == "done" => eprintln!("routine run {} not quiet: git could not be probed", run.id),
            _ => {}
        }
        if quiet {
            if state.db().set_run_status_if(&run.id, "done", "quiet").unwrap_or(false) {
                archive_quiet(&app, &state, &ws_id).await;
            }
        } else if !f.interrupted {
            crate::notify_turn_done(&app, &state.settings(), ws.as_ref(), f.is_error, f.error.as_deref());
            crate::remote::on_turn_completed(&state, ws.as_ref(), f.is_error, f.error.as_deref());
        }
        if f.status != "done" {
            return;
        }
        let name = routine.map(|r| r.name).unwrap_or_default();
        let digest = if f.digest.is_empty() {
            let events = state.db().events(&ws_id).unwrap_or_default();
            last_assistant_texts(&events, 3)
        } else {
            f.digest.clone()
        };
        let files = probe.as_ref().map(|p| p.files.clone());
        refine_summary(&app, &state, &run.id, &ws_id, &name, &digest, files.as_deref(), quiet).await;
    });
}

/// Asks the summary model (`llm::Task::RoutineSummary`) for the run's summary and whether there was
/// nothing to do. Any failure leaves the fallback summary in place.
#[allow(clippy::too_many_arguments)]
async fn refine_summary(app: &AppHandle, state: &AppState, run_id: &str, ws_id: &str, name: &str, digest: &[String], files: Option<&[String]>, already_quiet: bool) {
    let prompt = summary_prompt(name, digest, files.unwrap_or(&[]));
    let schema = summary_schema();
    let call = crate::llm::complete_json(state, crate::llm::Task::RoutineSummary, SUMMARY_SYSTEM, &prompt, &schema);
    let Some(reply) = crate::trunk::bounded(std::time::Duration::from_secs(90), call).await else { return };
    let Some((summary, nothing_to_do)) = parse_summary(&reply) else { return };
    let _ = state.db().set_run_summary(run_id, &summary);
    // Only a probe that saw the worktree can vouch for "no file changes".
    if !already_quiet && files.is_some_and(|f| is_quiet_by_model(Mode::Fresh, "done", f.len(), nothing_to_do))
        && state.db().set_run_status_if(run_id, "done", "quiet").unwrap_or(false)
    {
        archive_quiet(app, state, ws_id).await;
    }
    changed(app);
}

async fn archive_quiet(app: &AppHandle, state: &AppState, ws_id: &str) {
    if archive_inner(state, ws_id, true, false).await.is_ok() {
        let _ = app.emit("workspace-archived", ws_id);
    }
    changed(app);
}

/// What a finished fresh workspace holds: changed files vs base, and whether its branch has commits of its own.
struct Probe {
    files: Vec<String>,
    own_commits: bool,
}

/// Untracked housekeeping a coding agent leaves in a worktree (`.claude/settings.local.json`, ...) is not
/// the run's work; everything tracked, and every other untracked file, is. (Git-ignored paths never
/// show up in `git::changes` in the first place.)
fn is_agent_housekeeping(c: &git::FileChange) -> bool {
    c.untracked && [".claude/", ".codex/"].iter().any(|d| c.path.starts_with(d))
}

/// Paths a run changed, minus agent housekeeping.
pub(crate) fn significant_files(changes: Vec<git::FileChange>) -> Vec<String> {
    changes.into_iter().filter(|c| !is_agent_housekeeping(c)).map(|c| c.path).collect()
}

/// None when git can't tell us: better a visible run than a lost one.
async fn probe_workspace(state: &AppState, ws_id: &str) -> Option<Probe> {
    let ws = state.db().workspace(ws_id).ok();
    let repo = ws.as_ref().and_then(|w| state.db().repo(&w.repo_id).ok());
    let (ws, repo) = (ws?, repo?);
    let (path, base, branch) = (PathBuf::from(&ws.path), repo.base_branch.clone(), ws.branch.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let files = significant_files(git::changes(&path, &base).ok()?);
        // Commits on the branch that base lacks. The branch reflog is not a reliable signal: background
        // sync rebases, resets and Simplify steps all write reflog entries without adding any work.
        let ahead = crate::git::commits_ahead(&path, &crate::trunk::base_ref(&path, &base))?;
        eprintln!(
            "routine probe for {branch}: {} changed file(s) {:?}, {ahead} commit(s) ahead of {base}",
            files.len(),
            files.iter().take(5).collect::<Vec<_>>()
        );
        Some(Probe { files, own_commits: ahead > 0 })
    })
    .await
    .ok()
    .flatten()
}

/// The agent process died mid-run: no `TurnCompleted` will ever come.
pub fn finish_exited(app: &AppHandle, state: &AppState, ws_id: &str) {
    set_stage(ws_id, None);
    let run = state.db().running_run_for_workspace(ws_id).ok().flatten();
    if let Some(run) = run {
        let _ = state.db().finish_run(&run.id, "error", Some("The agent process exited"), db::now());
        changed(app);
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn list_routines(state: State<AppState>) -> CmdResult<Vec<Routine>> {
    state.db().routines().map_err(err)
}

#[tauri::command]
pub fn save_routine(app: AppHandle, state: State<AppState>, input: RoutineInput) -> CmdResult<Routine> {
    AgentKind::parse(&input.agent).ok_or("unknown agent")?;
    input.schedule.validate()?;
    match &input.action {
        Action::Prompt { text } if text.trim().is_empty() => return Err("write the message to send".into()),
        Action::Skill { skill_id, .. } if skill_id.trim().is_empty() => return Err("pick a skill".into()),
        _ => {}
    }
    let teammate = input.teammate.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
    check_owner(teammate.as_deref(), &input.action, input.mode)?;
    if let Some(slug) = &teammate {
        if slug == crate::chief::SLUG {
            return Err("Chief plans work for others; give the routine to the teammate that does it".into());
        }
        crate::teammates::get(&state.home, slug).ok_or_else(|| format!("No teammate `{slug}`"))?;
    }
    state.db().repo(&input.repo_id).map_err(|_| "pick a repository".to_string())?;
    let now = db::now();
    let next = if input.enabled { next_after_ms(&input.schedule, now) } else { None };
    if input.enabled && next.is_none() {
        return Err(match input.schedule.kind {
            ScheduleKind::Once => "that time has already passed".into(),
            _ => "this schedule never fires".to_string(),
        });
    }
    let existing = match &input.id {
        Some(id) => Some(state.db().routine(id).map_err(err)?),
        None => None,
    };
    let name = Some(input.name.trim()).filter(|n| !n.is_empty()).map_or_else(|| default_name(&input.action), str::to_string);
    let routine = Routine {
        id: existing.as_ref().map_or_else(|| uuid::Uuid::new_v4().to_string(), |r| r.id.clone()),
        repo_id: input.repo_id,
        name,
        schedule: input.schedule,
        action: input.action,
        agent: input.agent,
        model: input.model.filter(|m| !m.is_empty()),
        profile: input.profile.filter(|p| !p.is_empty()),
        mode: input.mode,
        standing_workspace_id: input.standing_workspace_id.or_else(|| existing.as_ref().and_then(|r| r.standing_workspace_id.clone())),
        enabled: input.enabled,
        created_at: existing.as_ref().map_or(now, |r| r.created_at),
        last_run_at: existing.as_ref().and_then(|r| r.last_run_at),
        next_run_at: next,
        last_status: None,
        teammate,
    };
    if existing.is_some() {
        state.db().update_routine(&routine).map_err(err)?;
    } else {
        state.db().insert_routine(&routine).map_err(err)?;
    }
    changed(&app);
    state.db().routine(&routine.id).map_err(err)
}

#[tauri::command]
pub fn delete_routine(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<()> {
    state.db().delete_routine(&id).map_err(err)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn set_routine_enabled(app: AppHandle, state: State<AppState>, id: String, enabled: bool) -> CmdResult<Routine> {
    let r = state.db().routine(&id).map_err(err)?;
    let next = if enabled { next_after_ms(&r.schedule, db::now()) } else { None };
    if enabled && next.is_none() {
        return Err("that time has already passed; edit the routine to pick a new one".into());
    }
    state.db().set_routine_next(&id, next, enabled).map_err(err)?;
    changed(&app);
    state.db().routine(&id).map_err(err)
}

/// Runs now, ignoring the schedule and concurrency cap; the next scheduled time is unchanged.
#[tauri::command]
pub async fn run_routine_now(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<RoutineRun> {
    let r = state.db().routine(&id).map_err(err)?;
    if is_busy(&state, &r) {
        return Err("This routine is still running".into());
    }
    start_run(&app, &state, &id).await
}

#[tauri::command]
pub fn routine_runs(state: State<AppState>, routine_id: String, limit: Option<u32>) -> CmdResult<Vec<RoutineRun>> {
    state.db().routine_runs(&routine_id, limit.unwrap_or(20)).map_err(err)
}

/// The next `count` (default 3) times a schedule would fire, as ms epoch, for the editor preview.
#[tauri::command]
pub fn preview_schedule(schedule: Schedule, count: Option<usize>) -> CmdResult<Vec<i64>> {
    schedule.validate()?;
    let mut out = vec![];
    let mut from = db::now();
    for _ in 0..count.unwrap_or(3).min(10) {
        let Some(next) = next_after_ms(&schedule, from) else { break };
        out.push(next);
        from = next;
    }
    Ok(out)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use db::Db;

    fn sched(kind: ScheduleKind) -> Schedule {
        Schedule { kind, time: None, weekday: None, cron: None, at: None }
    }
    fn daily(time: &str) -> Schedule {
        Schedule { time: Some(time.into()), ..sched(ScheduleKind::Daily) }
    }
    fn cron(expr: &str) -> Schedule {
        Schedule { cron: Some(expr.into()), ..sched(ScheduleKind::Cron) }
    }
    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }
    /// Local time == UTC (no DST).
    fn plain(n: NaiveDateTime) -> LocalResult<DateTime<Utc>> {
        LocalResult::Single(Utc.from_utc_datetime(&n))
    }
    fn next_in(s: &Schedule, from: &str, resolve: Resolve) -> Option<String> {
        let f = dt(from);
        next_core(s, Utc.from_utc_datetime(&f), f, resolve).map(|t| t.format("%Y-%m-%d %H:%M").to_string())
    }
    fn next(s: &Schedule, from: &str) -> Option<String> {
        next_in(s, from, &plain)
    }

    #[test]
    fn hourly_and_minute_offset() {
        assert_eq!(next(&sched(ScheduleKind::Hourly), "2026-10-10 09:30").unwrap(), "2026-10-10 10:00");
        assert_eq!(next(&sched(ScheduleKind::Hourly), "2026-10-10 10:00").unwrap(), "2026-10-10 11:00", "strictly after");
        assert_eq!(next(&sched(ScheduleKind::Hourly), "2026-10-10 23:59").unwrap(), "2026-10-11 00:00");
        let h = Schedule { time: Some("00:15".into()), ..sched(ScheduleKind::Hourly) };
        assert_eq!(next(&h, "2026-10-10 09:20").unwrap(), "2026-10-10 10:15");
    }

    #[test]
    fn daily_rolls_over_midnight() {
        assert_eq!(next(&daily("09:00"), "2026-10-10 08:59").unwrap(), "2026-10-10 09:00");
        assert_eq!(next(&daily("09:00"), "2026-10-10 09:00").unwrap(), "2026-10-11 09:00");
        assert_eq!(next(&daily("00:00"), "2026-12-31 23:59").unwrap(), "2027-01-01 00:00");
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        let s = Schedule { time: Some("09:00".into()), ..sched(ScheduleKind::Weekdays) };
        // 2026-10-09 is a Friday.
        assert_eq!(next(&s, "2026-10-09 10:00").unwrap(), "2026-10-12 09:00");
        assert_eq!(next(&s, "2026-10-10 10:00").unwrap(), "2026-10-12 09:00");
        assert_eq!(next(&s, "2026-10-12 08:00").unwrap(), "2026-10-12 09:00");
    }

    #[test]
    fn weekly_wraps_to_next_week() {
        // 2026-10-10 is a Saturday; weekday 1 = Monday.
        let mon = Schedule { time: Some("09:00".into()), weekday: Some(1), ..sched(ScheduleKind::Weekly) };
        assert_eq!(next(&mon, "2026-10-10 12:00").unwrap(), "2026-10-12 09:00");
        assert_eq!(next(&mon, "2026-10-12 09:00").unwrap(), "2026-10-19 09:00");
        let sun = Schedule { weekday: Some(0), ..mon.clone() };
        assert_eq!(next(&sun, "2026-10-10 12:00").unwrap(), "2026-10-11 09:00");
    }

    #[test]
    fn once_fires_once() {
        let s = Schedule { at: Some("2026-10-11T15:00".into()), ..sched(ScheduleKind::Once) };
        assert_eq!(next(&s, "2026-10-10 09:00").unwrap(), "2026-10-11 15:00");
        assert_eq!(next(&s, "2026-10-11 15:00"), None);
        assert_eq!(next(&s, "2026-10-12 00:00"), None);
    }

    #[test]
    fn cron_lists_ranges_and_steps() {
        assert_eq!(next(&cron("*/15 * * * *"), "2026-10-10 09:07").unwrap(), "2026-10-10 09:15");
        assert_eq!(next(&cron("*/15 * * * *"), "2026-10-10 09:45").unwrap(), "2026-10-10 10:00");
        assert_eq!(next(&cron("0 9,17 * * *"), "2026-10-10 10:00").unwrap(), "2026-10-10 17:00");
        assert_eq!(next(&cron("30 8-10 * * *"), "2026-10-10 10:30").unwrap(), "2026-10-11 08:30");
        // Mon-Fri at 09:30 (Saturday -> Monday).
        assert_eq!(next(&cron("30 9 * * 1-5"), "2026-10-10 10:00").unwrap(), "2026-10-12 09:30");
        // 7 is Sunday too.
        assert_eq!(next(&cron("0 0 * * 7"), "2026-10-10 10:00").unwrap(), "2026-10-11 00:00");
        // Range with step and "a/n".
        assert_eq!(next(&cron("0-30/10 12 * * *"), "2026-10-10 12:11").unwrap(), "2026-10-10 12:20");
        assert_eq!(next(&cron("5/20 12 * * *"), "2026-10-10 12:06").unwrap(), "2026-10-10 12:25");
        // First of the month; and a leap day.
        assert_eq!(next(&cron("0 0 1 * *"), "2026-10-10 10:00").unwrap(), "2026-11-01 00:00");
        assert_eq!(next(&cron("0 0 29 2 *"), "2026-10-10 10:00").unwrap(), "2028-02-29 00:00");
        // dom and dow both set: either matches (13th, or a Friday).
        assert_eq!(next(&cron("0 0 13 * 5"), "2026-10-10 10:00").unwrap(), "2026-10-13 00:00");
    }

    #[test]
    fn cron_rejects_garbage() {
        for bad in ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "5-1 * * * *", "a * * * *", "* * * * 8"] {
            assert!(Cron::parse(bad).is_err(), "{bad:?} should be rejected");
        }
        assert!(cron("* * * * *").validate().is_ok());
        assert!(Schedule { time: Some("25:00".into()), ..sched(ScheduleKind::Daily) }.validate().is_err());
        assert!(sched(ScheduleKind::Weekly).validate().is_err());
        assert!(sched(ScheduleKind::Once).validate().is_err());
    }

    #[test]
    fn spring_forward_gap_shifts_instead_of_skipping() {
        // Local 02:00-03:00 on 2026-03-08 does not exist.
        let gap = |n: NaiveDateTime| {
            if n >= dt("2026-03-08 02:00") && n < dt("2026-03-08 03:00") { LocalResult::None } else { plain(n) }
        };
        assert_eq!(next_in(&daily("02:30"), "2026-03-07 12:00", &gap).unwrap(), "2026-03-08 03:30");
        assert_eq!(next_in(&daily("02:30"), "2026-03-08 03:30", &gap).unwrap(), "2026-03-09 02:30");
        // Hourly: the skipped hour is just not there.
        assert_eq!(next_in(&sched(ScheduleKind::Hourly), "2026-03-08 01:10", &gap).unwrap(), "2026-03-08 03:00");
    }

    #[test]
    fn fall_back_fires_once_and_never_in_the_past() {
        // Local 01:00-02:00 on 2026-11-01 happens twice: first as plain UTC, then an hour later.
        let fold = |n: NaiveDateTime| {
            if n >= dt("2026-11-01 01:00") && n < dt("2026-11-01 02:00") {
                LocalResult::Ambiguous(Utc.from_utc_datetime(&n), Utc.from_utc_datetime(&(n + Duration::hours(1))))
            } else {
                plain(n)
            }
        };
        assert_eq!(next_in(&daily("01:30"), "2026-11-01 00:00", &fold).unwrap(), "2026-11-01 01:30");
        // Already past the first 01:30: tomorrow, not the repeat.
        assert_eq!(next_in(&daily("01:30"), "2026-11-01 01:45", &fold).unwrap(), "2026-11-02 01:30");
        // Near midnight: a daily 00:00 right after 23:59 is the next calendar day.
        assert_eq!(next_in(&daily("00:00"), "2026-10-31 23:59", &fold).unwrap(), "2026-11-01 00:00");
    }

    #[test]
    fn next_after_works_in_the_real_local_zone() {
        let from = Local::now();
        let n = next_after(&daily("09:00"), from).unwrap();
        assert!(n > from && n - from <= Duration::hours(25));
    }

    fn routine(id: &str, enabled: bool, next: Option<i64>) -> Routine {
        Routine {
            id: id.into(),
            repo_id: "r".into(),
            name: id.into(),
            schedule: daily("09:00"),
            action: Action::Prompt { text: "hi".into() },
            agent: "claude".into(),
            model: None,
            profile: None,
            mode: Mode::Fresh,
            standing_workspace_id: None,
            enabled,
            created_at: 0,
            last_run_at: None,
            next_run_at: next,
            last_status: None,
            teammate: None,
        }
    }

    #[test]
    fn owned_routines_route_through_the_teammate() {
        let mut r = routine("r", true, None);
        assert_eq!(owner_of(&r), None);
        r.teammate = Some("builder".into());
        assert_eq!(owner_of(&r), Some("builder"));
        // Only message routines can be owned; a skill or Simplify routine ignores a stale owner.
        r.action = Action::Simplify;
        assert_eq!(owner_of(&r), None);
        r.action = Action::Skill { skill_id: "a:b".into(), args: String::new() };
        assert_eq!(owner_of(&r), None);

        let prompt = Action::Prompt { text: "x".into() };
        assert!(check_owner(None, &Action::Simplify, Mode::Standing).is_ok());
        assert!(check_owner(Some("builder"), &prompt, Mode::Fresh).is_ok());
        assert!(check_owner(Some("builder"), &Action::Simplify, Mode::Fresh).is_err());
        assert!(check_owner(Some("builder"), &prompt, Mode::Standing).is_err());
        // The owner survives the database round trip.
        let db = Db::memory();
        db.insert_repo(&db::Repo { id: "r".into(), name: "repo".into(), path: "/x".into(), base_branch: "main".into() }).unwrap();
        let mut owned = routine("owned", true, Some(5));
        owned.repo_id = "r".into();
        owned.teammate = Some("reviewer".into());
        db.insert_routine(&owned).unwrap();
        assert_eq!(db.routine("owned").unwrap().teammate.as_deref(), Some("reviewer"));
        owned.teammate = None;
        db.update_routine(&owned).unwrap();
        assert_eq!(db.routine("owned").unwrap().teammate, None);
    }

    #[test]
    fn missed_runs_start_once_oldest_first_within_the_cap() {
        let list = vec![
            routine("late", true, Some(500)),
            routine("older", true, Some(100)),
            routine("future", true, Some(5_000)),
            routine("off", false, Some(1)),
            routine("unscheduled", true, None),
        ];
        let never = |_: &Routine| false;
        let plan = plan_tick(&list, 1_000, 0, 2, &never);
        assert_eq!(plan, vec![("older".into(), Due::Start), ("late".into(), Due::Start)]);
        // One slot taken already: the newer one stays due for the next tick.
        assert_eq!(plan_tick(&list, 1_000, 1, 2, &never), vec![("older".into(), Due::Start)]);
        assert!(plan_tick(&list, 1_000, 2, 2, &never).is_empty());
        // Busy routines are skipped without using a slot.
        let busy = |r: &Routine| r.id == "older";
        assert_eq!(plan_tick(&list, 1_000, 1, 2, &busy), vec![("older".into(), Due::Skip), ("late".into(), Due::Start)]);
    }

    #[test]
    fn agent_housekeeping_does_not_count_as_changes() {
        let fc = |path: &str, untracked: bool| git::FileChange { path: path.into(), additions: 1, deletions: 0, untracked };
        let files = significant_files(vec![
            fc(".claude/settings.local.json", true),
            fc(".codex/state", true),
            fc("src/a.rs", false),
            fc("notes.md", true),
            fc(".claude/commands/x.md", false), // tracked: a real edit
        ]);
        assert_eq!(files, ["src/a.rs", "notes.md", ".claude/commands/x.md"]);
    }

    #[test]
    fn quiet_only_for_clean_fresh_runs() {
        assert!(is_quiet(Mode::Fresh, "done", 0, false));
        assert!(!is_quiet(Mode::Fresh, "done", 2, false));
        assert!(!is_quiet(Mode::Fresh, "done", 0, true));
        assert!(!is_quiet(Mode::Fresh, "error", 0, false));
        assert!(!is_quiet(Mode::Standing, "done", 0, false));
    }

    #[test]
    fn simplify_action_shape_and_name() {
        let a: Action = serde_json::from_str(r#"{"kind":"simplify"}"#).unwrap();
        assert_eq!(a, Action::Simplify);
        assert_eq!(serde_json::to_string(&Action::Simplify).unwrap(), r#"{"kind":"simplify"}"#);
        assert_eq!(default_name(&Action::Simplify), "Simplify recent changes");
    }

    #[test]
    fn the_summary_model_can_only_quiet_a_clean_fresh_run() {
        assert!(is_quiet_by_model(Mode::Fresh, "done", 0, true));
        assert!(!is_quiet_by_model(Mode::Fresh, "done", 0, false), "the model has to agree");
        assert!(!is_quiet_by_model(Mode::Fresh, "done", 1, true), "never over file changes");
        assert!(!is_quiet_by_model(Mode::Standing, "done", 0, true));
        assert!(!is_quiet_by_model(Mode::Fresh, "error", 0, true));
    }

    #[test]
    fn summary_prompt_parse_and_transcript_digest() {
        use crate::agent::AgentEvent;
        use serde_json::json;
        let files: Vec<String> = (0..40).map(|i| format!("f{i}.ts")).collect();
        let p = summary_prompt("Triage", &["Labelled 4 issues.".into(), "  ".into()], &files);
        assert!(p.contains("Routine: Triage") && p.contains("Labelled 4 issues.") && p.contains("f29.ts") && !p.contains("f30.ts") && p.contains("and 10 more"));
        assert!(summary_prompt("x", &[], &[]).contains("Files changed: none"));
        let long = summary_prompt("x", &["é".repeat(5_000)], &[]);
        assert!(long.chars().count() < 3_300, "the agent's text is capped");

        assert_eq!(parse_summary(&json!({ "summary": " Fixed two tests. ", "nothingToDo": false })), Some(("Fixed two tests.".into(), false)));
        assert_eq!(parse_summary(&json!({ "summary": "All clear", "nothingToDo": true })), Some(("All clear".into(), true)));
        assert_eq!(parse_summary(&json!({ "summary": "  ", "nothingToDo": true })), None);
        assert_eq!(parse_summary(&json!({ "nothingToDo": true })), None);

        let ev = |seq: i64, event: AgentEvent| db::StoredEvent { seq, ts: 0, event };
        let events = vec![
            ev(1, AgentEvent::Message { text: "old run".into() }),
            ev(2, AgentEvent::UserMessage { text: "go".into(), skill: None }),
            ev(3, AgentEvent::Message { text: "one".into() }),
            ev(4, AgentEvent::TurnStarted),
            ev(5, AgentEvent::Message { text: "two".into() }),
            ev(6, AgentEvent::Message { text: "three".into() }),
        ];
        assert_eq!(last_assistant_texts(&events, 2), ["two", "three"]);
        assert_eq!(last_assistant_texts(&events, 9), ["one", "two", "three"], "stops at the last user message");
        assert!(last_assistant_texts(&[], 3).is_empty());
    }

    #[test]
    fn summary_and_default_name() {
        assert_eq!(trim_summary("  short  "), "short");
        let long = "é".repeat(600);
        let t = trim_summary(&long);
        assert_eq!(t.chars().count(), SUMMARY_CHARS + 1);
        assert!(t.ends_with('…'));
        assert_eq!(default_name(&Action::Prompt { text: "\n  Triage new issues\nand label them".into() }), "Triage new issues");
        assert_eq!(default_name(&Action::Skill { skill_id: "shipkit:fix-ci".into(), args: String::new() }), "/shipkit:fix-ci");
        assert!(default_name(&Action::Prompt { text: "x".repeat(100) }).chars().count() <= 48);
        assert_eq!(default_name(&Action::Prompt { text: "  ".into() }), "Routine");
    }

    #[test]
    fn action_and_schedule_json_shapes() {
        let a: Action = serde_json::from_str(r#"{"kind":"skill","skillId":"shipkit:ship","args":"x"}"#).unwrap();
        assert_eq!(a, Action::Skill { skill_id: "shipkit:ship".into(), args: "x".into() });
        let a: Action = serde_json::from_str(r#"{"kind":"prompt","text":"hi"}"#).unwrap();
        assert_eq!(a, Action::Prompt { text: "hi".into() });
        let s: Schedule = serde_json::from_str(r#"{"kind":"weekdays","time":"09:00"}"#).unwrap();
        assert_eq!(s.kind, ScheduleKind::Weekdays);
        let s: Schedule = serde_json::from_str(r#"{"kind":"once","at":"2026-10-11T15:00"}"#).unwrap();
        assert!(s.validate().is_ok());
    }

    #[test]
    fn db_round_trip_runs_and_stale_cleanup() {
        let db = Db::memory();
        db.insert_repo(&db::Repo { id: "r".into(), name: "repo".into(), path: "/x".into(), base_branch: "main".into() }).unwrap();
        let mut r = routine("rt1", true, Some(1_000));
        r.repo_id = "r".into();
        r.schedule = cron("*/5 * * * *");
        r.action = Action::Skill { skill_id: "a:b".into(), args: "q".into() };
        r.model = Some("opus".into());
        db.insert_routine(&r).unwrap();
        assert_eq!(db.routine("rt1").unwrap(), r);
        assert_eq!(db.routines().unwrap(), vec![r.clone()]);

        r.name = "renamed".into();
        r.mode = Mode::Standing;
        r.enabled = false;
        r.next_run_at = None;
        db.update_routine(&r).unwrap();
        assert_eq!(db.routine("rt1").unwrap(), r);
        db.set_routine_next("rt1", Some(2_000), true).unwrap();
        db.set_routine_last_run("rt1", 1_500).unwrap();
        db.set_routine_standing("rt1", "ws1").unwrap();
        let got = db.routine("rt1").unwrap();
        assert_eq!((got.next_run_at, got.last_run_at, got.enabled), (Some(2_000), Some(1_500), true));
        assert_eq!(got.standing_workspace_id.as_deref(), Some("ws1"));

        let run = |id: &str, at: i64| RoutineRun {
            id: id.into(), routine_id: "rt1".into(), workspace_id: None, started_at: at, finished_at: None, status: "running".into(), summary: None,
        };
        db.insert_run(&run("a", 10)).unwrap();
        db.insert_run(&run("b", 20)).unwrap();
        assert_eq!(db.running_runs_count().unwrap(), 2);
        assert!(db.routine_has_running_run("rt1").unwrap());
        db.set_run_workspace("b", "ws1").unwrap();
        assert_eq!(db.running_run_for_workspace("ws1").unwrap().unwrap().id, "b");
        db.finish_run("b", "done", Some("all good"), 30).unwrap();
        assert!(db.running_run_for_workspace("ws1").unwrap().is_none());
        assert!(db.set_run_status_if("b", "done", "quiet").unwrap());
        assert!(!db.set_run_status_if("b", "done", "quiet").unwrap(), "only flips from the expected status");
        db.set_run_summary("b", "model summary").unwrap();
        assert_eq!(db.routine_runs("rt1", 1).unwrap()[0].summary.as_deref(), Some("model summary"));
        assert_eq!(db.routine("rt1").unwrap().last_status.as_deref(), Some("quiet"));
        assert_eq!(db.fail_stale_runs(40, "closed").unwrap(), 1);
        let runs = db.routine_runs("rt1", 10).unwrap();
        assert_eq!(runs.iter().map(|r| (r.id.as_str(), r.status.as_str())).collect::<Vec<_>>(), [("b", "quiet"), ("a", "error")]);
        assert_eq!(runs[1].summary.as_deref(), Some("closed"));
        assert_eq!(db.routine_runs("rt1", 1).unwrap().len(), 1);

        db.delete_routine("rt1").unwrap();
        assert!(db.routine("rt1").is_err());
        assert!(db.routine_runs("rt1", 10).unwrap().is_empty());
    }
}
