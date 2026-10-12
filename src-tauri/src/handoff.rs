//! Hand-offs: a finished task's report becomes the next teammate's brief. Chips on the report card
//! (rule-based defaults by role, plus a "Hand to..." picker) call `teammate_handoff`, which opens a
//! new task for the target with a brief built from the report: summary, branch, changed files, PR link.
//!
//! Which workspace the target works in is decided per role (`workspace_plan`):
//! - Reviewer: a new, read-only worktree that starts at the source branch's tip (the same code, but
//!   its own folder and branch, so reviewing can never move the work).
//! - Shipper, and a Builder/Debugger fixing a Reviewer's findings: the **same workspace** (the same
//!   branch, so the PR is the same PR), when the target uses the same agent; the workspace changes
//!   identity (profile, memory, role note) via `teammates::adopt_task`. With a different agent a
//!   session can't be reused, so it falls back to a worktree starting at the branch tip.
//!   Findings go back to the workspace the review was *of*, not the reviewer's own copy.
//! - Everything else (a Planner's plan to a Builder): a fresh worktree from base; the plan is in the brief.

use crate::teammates::{self, adopt_task, clip, message, post, start_task, Origin, SendResult, Start, Teammate, TeammateTask};
use crate::{err, git, AppState, CmdResult};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

// ---------------------------------------------------------------- roles and chips

/// The role a teammate plays: its profile's name (`shipkit:builder` -> builder), else its slug.
pub fn role_of(slug: &str, profile: Option<&str>) -> String {
    profile.and_then(|p| p.rsplit(':').next()).filter(|r| !r.is_empty()).unwrap_or(slug).to_lowercase()
}

/// A pull request is mentioned: a /pull/ URL, `PR #12`, or `pull request #12`.
pub fn has_pr(text: &str) -> bool {
    extract_pr_url(text).is_some() || {
        let lower = text.to_lowercase();
        ["pr #", "pull request #"].iter().any(|k| lower.match_indices(k).any(|(i, _)| lower[i + k.len()..].starts_with(|c: char| c.is_ascii_digit())))
    }
}

pub fn extract_pr_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|w| w.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '<' | '>' | ',' | '.' | ';' | '"' | '\'')))
        .find(|w| w.starts_with("http") && w.contains("/pull/"))
        .map(String::from)
}

/// A review reported something to fix unless it says it found nothing. Heuristic on the report text.
pub fn has_findings(text: &str) -> bool {
    let lower = text.to_lowercase();
    ![
        "no findings", "no issues", "no problems", "nothing to fix", "nothing found", "looks good", "lgtm", "no blocking", "found no ", "didn't find any", "did not find any",
    ]
    .iter()
    .any(|p| lower.contains(p))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffChip {
    /// Target teammate slug.
    pub to: String,
    pub label: String,
}

/// A teammate a chip can point at.
pub struct Candidate {
    pub slug: String,
    pub name: String,
    pub role: String,
}

fn candidate(team: &[Candidate], role: &str) -> Option<usize> {
    team.iter().position(|c| c.slug == role).or_else(|| team.iter().position(|c| c.role == role))
}

/// The default chips for a finished report (at most three): Planner -> Builder; Builder or Debugger ->
/// Reviewer; Reviewer with findings -> Builder to fix; anything that opened a PR -> Shipper.
/// `team` excludes the source and Chief. Chips only appear for roles the team has.
pub fn default_chips(from_role: &str, report: &str, team: &[Candidate]) -> Vec<HandoffChip> {
    let mut wanted: Vec<(&str, &str)> = vec![];
    match from_role {
        "planner" => wanted.push(("builder", "Hand to")),
        "builder" | "debugger" => wanted.push(("reviewer", "Ask {} to check")),
        "reviewer" if has_findings(report) => wanted.push(("builder", "Hand fixes to")),
        _ => {}
    }
    if from_role != "shipper" && from_role != "ticket-writer" && has_pr(report) {
        wanted.push(("shipper", "Hand to"));
    }
    let mut chips: Vec<HandoffChip> = vec![];
    for (role, verb) in wanted {
        let Some(i) = candidate(team, role) else { continue };
        let c = &team[i];
        if chips.iter().any(|x| x.to == c.slug) {
            continue;
        }
        let label = if verb.contains("{}") { verb.replace("{}", &c.name) } else { format!("{verb} {}", c.name) };
        chips.push(HandoffChip { to: c.slug.clone(), label });
    }
    chips.truncate(3);
    chips
}

// ---------------------------------------------------------------- workspace choice and brief

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsPlan {
    /// A fresh worktree from the repo's base branch.
    FromBase,
    /// A fresh worktree starting at the source branch's tip.
    FromBranch,
    /// The source workspace itself: same branch, new owner.
    SameWorkspace,
}

pub fn workspace_plan(from_role: &str, to_role: &str, same_agent: bool) -> WsPlan {
    let continues_branch = to_role == "shipper" || (matches!(to_role, "builder" | "debugger") && from_role == "reviewer");
    if to_role == "reviewer" {
        WsPlan::FromBranch
    } else if continues_branch {
        if same_agent { WsPlan::SameWorkspace } else { WsPlan::FromBranch }
    } else {
        WsPlan::FromBase
    }
}

pub struct HandoffInfo {
    pub from_name: String,
    pub from_role: String,
    pub to_role: String,
    pub summary: String,
    pub branch: String,
    pub files: Vec<String>,
    pub pr_url: Option<String>,
    pub plan: WsPlan,
    pub note: Option<String>,
}

fn instruction(from_role: &str, to_role: &str) -> &'static str {
    match to_role {
        "reviewer" => "Review the changes on that branch. You are read-only: report findings ranked by severity with file and line, and say what you did not check.",
        "shipper" => "Get that branch shippable: run the checks, rebase on the base branch, fix what breaks, and open or update the draft pull request. Never merge.",
        "builder" | "debugger" if from_role == "reviewer" => {
            "Fix the findings above on this branch, highest severity first, adding a test where one was missing. Update the existing draft pull request if there is one."
        }
        "builder" => "Build what the report describes, with tests, and open a draft pull request. Never merge.",
        "debugger" => "Reproduce and fix what the report describes, with a regression test, and open a draft pull request. Never merge.",
        _ => "Continue from their report.",
    }
}

/// The new task's first message.
pub fn handoff_brief(i: &HandoffInfo) -> String {
    let mut s = format!("{} handed this to you. Their report:\n\n{}\n", i.from_name, i.summary.trim());
    let where_ = match i.plan {
        WsPlan::SameWorkspace => " (this workspace is already on it)",
        WsPlan::FromBranch => " (your workspace starts from its latest commit)",
        WsPlan::FromBase => " (for reference; your workspace starts from the base branch)",
    };
    s.push_str(&format!("\nBranch: {}{where_}\n", i.branch));
    if i.files.is_empty() {
        s.push_str("Changed files: none yet.\n");
    } else {
        let shown: Vec<&str> = i.files.iter().take(12).map(String::as_str).collect();
        let more = if i.files.len() > shown.len() { format!(" (+{} more)", i.files.len() - shown.len()) } else { String::new() };
        s.push_str(&format!("Changed files ({}): {}{more}\n", i.files.len(), shown.join(", ")));
    }
    if let Some(url) = &i.pr_url {
        s.push_str(&format!("Pull request: {url}\n"));
    }
    s.push_str(&format!("\nYour job: {}\n", instruction(&i.from_role, &i.to_role)));
    if let Some(n) = i.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        s.push_str(&format!("\nFrom the user: {n}\n"));
    }
    s.trim_end().to_string()
}

// ---------------------------------------------------------------- tasks with their chips

/// A task for the UI: the row, the chips its report offers, and who it was already handed to.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    #[serde(flatten)]
    pub task: TeammateTask,
    pub handoffs: Vec<HandoffChip>,
    pub handed_to: Vec<String>,
}

fn candidates(state: &AppState, exclude: &str) -> Vec<Candidate> {
    teammates::list(&state.home)
        .into_iter()
        .filter(|t| t.slug != exclude && t.slug != crate::chief::SLUG)
        .map(|t| Candidate { role: role_of(&t.slug, t.profile.as_deref()), slug: t.slug, name: t.name })
        .collect()
}

pub fn task_view(state: &AppState, task: TeammateTask) -> TaskView {
    let children = state.db().teammate_child_tasks(&task.id).unwrap_or_default();
    let handed_to: Vec<String> = children.iter().filter(|c| c.origin_kind.as_deref() == Some("handoff")).map(|c| c.slug.clone()).collect();
    let handoffs = if task.status == "done" {
        let from: Option<Teammate> = teammates::get(&state.home, &task.slug);
        let role = role_of(&task.slug, from.as_ref().and_then(|t| t.profile.as_deref()));
        default_chips(&role, task.summary.as_deref().unwrap_or(""), &candidates(state, &task.slug)).into_iter().filter(|c| !handed_to.contains(&c.to)).collect()
    } else {
        vec![]
    };
    TaskView { task, handoffs, handed_to }
}

// ---------------------------------------------------------------- command

async fn changed_files(path: String, base: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || git::changes(&PathBuf::from(path), &base).map(crate::routines::significant_files).unwrap_or_default())
        .await
        .unwrap_or_default()
}

/// Hands a finished (or waiting) task's result to another teammate as a new task.
#[tauri::command]
pub async fn teammate_handoff(app: AppHandle, state: State<'_, AppState>, from_task_id: String, to_slug: String, note: Option<String>) -> CmdResult<SendResult> {
    let src = state.db().teammate_task(&from_task_id).map_err(err)?.ok_or("That task no longer exists")?;
    if src.status == "running" {
        return Err("Wait for the task to finish before handing it on".into());
    }
    if to_slug == crate::chief::SLUG {
        return Err("Chief plans work; hand a result to a teammate that does it".into());
    }
    if to_slug == src.slug {
        return Err("A teammate can't hand work to itself".into());
    }
    let to = teammates::get(&state.home, &to_slug).ok_or_else(|| format!("No teammate `{to_slug}`"))?;
    let from = teammates::get(&state.home, &src.slug).ok_or_else(|| format!("No teammate `{}`", src.slug))?;
    let repos = state.db().repos().map_err(err)?;
    teammates::pick_repo(Some(&src.repo_id), &to.repos, &repos)?;
    let src_ws = state.db().workspace(&src.workspace_id).map_err(|_| "The task's workspace was archived, so there is nothing to hand on".to_string())?;
    let (from_role, to_role) = (role_of(&from.slug, from.profile.as_deref()), role_of(&to.slug, to.profile.as_deref()));
    // A review's findings belong on the branch that was reviewed, not on the reviewer's own copy.
    let reviewed = if from_role == "reviewer" && src.origin_kind.as_deref() == Some("handoff") {
        let parent = src.parent_task_id.as_deref().and_then(|id| state.db().teammate_task(id).ok().flatten());
        parent.and_then(|p| state.db().workspace(&p.workspace_id).ok())
    } else {
        None
    };
    let work = reviewed.unwrap_or(src_ws);
    let plan = workspace_plan(&from_role, &to_role, work.agent == to.agent);
    let base = state.db().repo(&src.repo_id).map(|r| r.base_branch).map_err(err)?;
    let files = changed_files(work.path.clone(), base).await;
    let summary = src.summary.clone().unwrap_or_else(|| "Finished.".into());
    let info = HandoffInfo {
        from_name: from.name.clone(),
        from_role,
        to_role,
        pr_url: extract_pr_url(&summary),
        summary,
        branch: work.branch.clone(),
        files,
        plan,
        note,
    };
    let brief = handoff_brief(&info);
    let start = Start {
        slug: to.slug.clone(),
        repo_id: src.repo_id.clone(),
        name: Some(clip(&format!("{}: {}", to.name, work.name), 60)),
        display: brief.clone(),
        payload: brief,
        origin: Origin { parent_task_id: Some(src.id.clone()), kind: Some("handoff".into()), reference: Some(src.slug.clone()) },
        start_ref: (plan == WsPlan::FromBranch).then(|| work.branch.clone()),
        user_message: false,
    };
    let (_, ws) = match plan {
        WsPlan::SameWorkspace => adopt_task(&app, &state, start, &work.id)?,
        _ => start_task(&app, &state, start).await?,
    };
    let mut line = message(&src.slug, "system", "handoff", &format!("Handed to {}", to.name), Some(&ws.id));
    line.meta = Some(to.slug.clone());
    post(&app, &state, line);
    Ok(SendResult { workspace_id: Some(ws.id), new_task: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn team() -> Vec<Candidate> {
        [("builder", "Builder", "builder"), ("reviewer", "Reviewer", "reviewer"), ("shipper", "Shipper", "shipper"), ("planner", "Planner", "planner")]
            .iter()
            .map(|(s, n, r)| Candidate { slug: s.to_string(), name: n.to_string(), role: r.to_string() })
            .collect()
    }

    fn labels(chips: &[HandoffChip]) -> Vec<(&str, &str)> {
        chips.iter().map(|c| (c.to.as_str(), c.label.as_str())).collect()
    }

    #[test]
    fn roles_come_from_the_profile() {
        assert_eq!(role_of("scout", Some("shipkit:Builder")), "builder");
        assert_eq!(role_of("scout", None), "scout");
        assert_eq!(role_of("planner", Some("shipkit:planner")), "planner");
    }

    #[test]
    fn default_chips_by_role() {
        assert_eq!(labels(&default_chips("planner", "Here is the plan.", &team())), [("builder", "Hand to Builder")]);
        assert_eq!(labels(&default_chips("builder", "Added the test.", &team())), [("reviewer", "Ask Reviewer to check")]);
        assert_eq!(labels(&default_chips("debugger", "Fixed.", &team())), [("reviewer", "Ask Reviewer to check")]);
        // A PR adds Shipper.
        assert_eq!(
            labels(&default_chips("builder", "Done. Draft PR #412 is open.", &team())),
            [("reviewer", "Ask Reviewer to check"), ("shipper", "Hand to Shipper")]
        );
        // A review with findings -> fixes to Builder; a clean one offers nothing.
        assert_eq!(labels(&default_chips("reviewer", "Two findings. High: double submit.", &team())), [("builder", "Hand fixes to Builder")]);
        assert!(default_chips("reviewer", "No issues found; looks good.", &team()).is_empty());
        // The shipper never hands back to itself; a ticket writer has no default.
        assert!(default_chips("shipper", "Draft PR #3 is up.", &team()).is_empty());
        assert!(default_chips("ticket-writer", "Opened issue #9.", &team()).is_empty());
        // Missing roles produce no chip; custom teammates are found by role.
        assert!(default_chips("builder", "Done.", &team()[..1]).is_empty());
        let custom = vec![Candidate { slug: "second-opinion".into(), name: "Second opinion".into(), role: "reviewer".into() }];
        assert_eq!(labels(&default_chips("builder", "Done.", &custom)), [("second-opinion", "Ask Second opinion to check")]);
    }

    #[test]
    fn pr_and_findings_detection() {
        assert!(has_pr("opened https://github.com/o/r/pull/12."));
        assert!(has_pr("Draft PR #412 is open") && has_pr("see pull request #7"));
        assert!(!has_pr("a draft pull request will follow") && !has_pr("PR review done"));
        assert_eq!(extract_pr_url("PR: (https://github.com/o/r/pull/12)."), Some("https://github.com/o/r/pull/12".into()));
        assert_eq!(extract_pr_url("no link"), None);
        assert!(has_findings("Two findings. High: x") && has_findings("Found a bug."));
        assert!(!has_findings("LGTM") && !has_findings("I found no issues."));
    }

    #[test]
    fn workspace_choice_per_role() {
        use WsPlan::*;
        assert_eq!(workspace_plan("builder", "reviewer", true), FromBranch);
        assert_eq!(workspace_plan("builder", "reviewer", false), FromBranch);
        assert_eq!(workspace_plan("builder", "shipper", true), SameWorkspace);
        assert_eq!(workspace_plan("builder", "shipper", false), FromBranch);
        assert_eq!(workspace_plan("reviewer", "builder", true), SameWorkspace);
        assert_eq!(workspace_plan("reviewer", "debugger", false), FromBranch);
        assert_eq!(workspace_plan("planner", "builder", true), FromBase);
        assert_eq!(workspace_plan("builder", "planner", true), FromBase);
    }

    #[test]
    fn briefs_carry_the_report_branch_files_and_pr() {
        let mut info = HandoffInfo {
            from_name: "Builder".into(),
            from_role: "builder".into(),
            to_role: "reviewer".into(),
            summary: "Fixed the crash. Draft PR #412.".into(),
            branch: "orbit/fix-crash-ab12".into(),
            files: (1..=14).map(|i| format!("src/f{i}.ts")).collect(),
            pr_url: Some("https://github.com/o/r/pull/412".into()),
            plan: WsPlan::FromBranch,
            note: Some("  focus on the retry path ".into()),
        };
        let b = handoff_brief(&info);
        assert!(b.starts_with("Builder handed this to you. Their report:\n\nFixed the crash. Draft PR #412."));
        assert!(b.contains("Branch: orbit/fix-crash-ab12 (your workspace starts from its latest commit)"));
        assert!(b.contains("Changed files (14): src/f1.ts") && b.contains("(+2 more)"));
        assert!(b.contains("Pull request: https://github.com/o/r/pull/412"));
        assert!(b.contains("Your job: Review the changes") && b.ends_with("From the user: focus on the retry path"));
        info.to_role = "shipper".into();
        info.plan = WsPlan::SameWorkspace;
        info.files.clear();
        info.pr_url = None;
        info.note = None;
        let s = handoff_brief(&info);
        assert!(s.contains("(this workspace is already on it)") && s.contains("Changed files: none yet.") && !s.contains("Pull request:"));
        assert!(s.contains("Your job: Get that branch shippable") && !s.contains("From the user"));
        info.from_role = "reviewer".into();
        info.to_role = "builder".into();
        assert!(handoff_brief(&info).contains("Fix the findings above"));
    }
}
