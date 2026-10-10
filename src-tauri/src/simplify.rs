//! Simplification pass (PLANNING #8). Orbit runs and polices the loop; the agent only proposes and
//! edits. Find: a one-shot, enforced read-only `claude -p` over the workspace's diff returns
//! structured candidates. Apply: one edit turn per ticked candidate on the workspace's own session,
//! then Orbit checks it (no test files touched, the repo's check command green) and commits it as
//! `refactor: ...`, or resets the worktree and records why it was skipped. State lives in memory
//! per workspace and is lost on restart.

use crate::agent::{AgentEvent, Command};
use crate::checks::{self, CheckKind, CheckResult};
use crate::db::Workspace;
use crate::trunk;
use crate::{emit_workspace, err, git, AppState, CmdResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, Notify};

/// The most one edit turn may take before Orbit interrupts it and skips the candidate.
const TURN_LIMIT: Duration = Duration::from_secs(20 * 60);
const FIND_LIMIT: Duration = Duration::from_secs(8 * 60);
/// How much diff text goes into the find prompt (whole), and per file.
const SCOPE_BUDGET: usize = 60_000;
const SCOPE_PER_FILE: usize = 12_000;

pub const SIGNALS: &[&str] =
    &["nesting", "longFunction", "nestedTernary", "booleanFlags", "duplication", "deadCode", "needlessWrapper", "naming", "other"];
pub const RISKS: &[&str] = &["low", "medium", "high"];

// ---- types ----

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub file: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signal: String,
    pub title: String,
    pub rationale: String,
    pub proposed_change: String,
    pub risk: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Finding,
    Ready,
    Applying,
    Done,
}

/// One candidate's progress through Apply. `status`: queued | editing | checking | applied | skipped | noop.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub candidate_id: String,
    pub status: String,
    /// Why it was skipped (or the check output tail), when there is something to say.
    pub detail: Option<String>,
    /// Short hash of the `refactor:` commit when applied.
    pub commit: Option<String>,
    /// Deleted minus added lines of the commit (negative when it grew).
    pub lines_removed: i64,
    /// Applied without a check command to vouch for it.
    pub unchecked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimplifyState {
    pub workspace_id: String,
    pub phase: Phase,
    pub candidates: Vec<Candidate>,
    pub rows: Vec<Row>,
    pub error: Option<String>,
    /// Files in the find scope, and a note when the diff was too big to include whole.
    pub scope_files: usize,
    pub scope_note: Option<String>,
    /// The check command Apply will use; None means rows are applied unchecked.
    pub check_command: Option<String>,
    pub cancelled: bool,
}

impl SimplifyState {
    fn new(workspace_id: &str) -> Self {
        Self {
            workspace_id: workspace_id.to_string(),
            phase: Phase::Idle,
            candidates: vec![],
            rows: vec![],
            error: None,
            scope_files: 0,
            scope_note: None,
            check_command: None,
            cancelled: false,
        }
    }
}

struct Run {
    state: SimplifyState,
    cancel: Arc<AtomicBool>,
    wake: Arc<Notify>,
    /// The find task, so Cancel can drop the `claude` child it owns.
    find_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

static RUNS: LazyLock<Mutex<HashMap<String, Run>>> = LazyLock::new(Default::default);

fn runs() -> std::sync::MutexGuard<'static, HashMap<String, Run>> {
    RUNS.lock().unwrap_or_else(|p| p.into_inner())
}

/// True while an Apply sequence owns the worktree: `trunk::save_point` must not commit then.
pub fn active(ws_id: &str) -> bool {
    runs().get(ws_id).is_some_and(|r| r.state.phase == Phase::Applying)
}

/// Mutates the workspace's state, then pushes the new snapshot to the UI.
fn update(app: &AppHandle, ws_id: &str, f: impl FnOnce(&mut Run)) {
    let snapshot = {
        let mut map = runs();
        let run = map.entry(ws_id.to_string()).or_insert_with(|| Run {
            state: SimplifyState::new(ws_id),
            cancel: Arc::new(AtomicBool::new(false)),
            wake: Arc::new(Notify::new()),
            find_task: None,
        });
        f(run);
        run.state.clone()
    };
    let _ = app.emit("simplify", snapshot);
}

fn set_row(app: &AppHandle, ws_id: &str, candidate_id: &str, f: impl FnOnce(&mut Row)) {
    update(app, ws_id, |r| {
        if let Some(row) = r.state.rows.iter_mut().find(|x| x.candidate_id == candidate_id) {
            f(row);
        }
    });
}

// ---- turn waiting ----

pub struct TurnEnd {
    pub error: Option<String>,
    pub interrupted: bool,
}

static WAITERS: LazyLock<Mutex<HashMap<String, oneshot::Sender<TurnEnd>>>> = LazyLock::new(Default::default);

/// Called for every agent event (from `on_agent_event`); wakes an Apply step waiting for its turn to end.
pub fn on_event(ws_id: &str, ev: &AgentEvent) {
    let end = match ev {
        AgentEvent::TurnCompleted { is_error, error, interrupted, .. } => TurnEnd {
            error: is_error.then(|| error.clone().unwrap_or_else(|| "the turn failed".into())),
            interrupted: *interrupted,
        },
        AgentEvent::Exited { .. } => TurnEnd { error: Some("the agent exited".into()), interrupted: false },
        _ => return,
    };
    if let Some(tx) = WAITERS.lock().unwrap_or_else(|p| p.into_inner()).remove(ws_id) {
        let _ = tx.send(end);
    }
}

// ---- pure logic ----

/// Test, spec, fixture and snapshot files: the pass never edits these, and a step that touches one is reverted.
pub fn is_test_path(path: &str) -> bool {
    let p = path.replace('\\', "/").to_lowercase();
    let mut parts: Vec<&str> = p.split('/').collect();
    let file = parts.pop().unwrap_or("");
    const DIRS: &[&str] = &["test", "tests", "__tests__", "spec", "specs", "e2e", "__snapshots__", "__mocks__", "testdata", "fixtures"];
    if parts.iter().any(|d| DIRS.contains(d)) {
        return true;
    }
    let stem = file.split('.').next().unwrap_or("");
    file.contains(".test.")
        || file.contains(".spec.")
        || file == "conftest.py"
        || stem == "e2e"
        || stem.starts_with("test_")
        || stem.starts_with("e2e-")
        || stem.ends_with("_test")
        || stem.ends_with("_spec")
        || stem.ends_with(".test")
        || ((file.ends_with(".java") || file.ends_with(".kt") || file.ends_with(".cs")) && (stem.ends_with("test") || stem.ends_with("tests")))
}

/// Files worth showing the find pass: not tests, lockfiles, generated or minified output.
pub fn is_simplifiable(path: &str) -> bool {
    let p = path.replace('\\', "/").to_lowercase();
    let file = p.rsplit('/').next().unwrap_or("");
    let skip_ext = [".lock", ".lockb", ".min.js", ".min.css", ".map", ".snap", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".pdf"];
    let skip_names = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "cargo.lock", "go.sum"];
    !is_test_path(path) && !skip_ext.iter().any(|e| file.ends_with(e)) && !skip_names.contains(&file) && !p.contains("/node_modules/") && !p.starts_with("node_modules/")
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CheckOutcome {
    NotConfigured,
    Ran(CheckKind),
}

#[derive(Debug, Clone, PartialEq)]
pub enum StepDecision {
    /// The agent changed nothing.
    NoOp,
    /// The edit touched these test files: revert.
    TouchedTests(Vec<String>),
    /// Checks did not pass: revert.
    ChecksFailed(CheckKind),
    /// Keep it; `checked` is false when there was no check command to vouch for it.
    Commit { checked: bool },
}

/// What to do with one finished edit step. `check` runs lazily, only when the step changed files and
/// none were tests (no point paying for a check on something that is reverted anyway).
pub fn decide_step(changed: &[String], check: impl FnOnce() -> CheckOutcome) -> StepDecision {
    if changed.is_empty() {
        return StepDecision::NoOp;
    }
    let tests: Vec<String> = changed.iter().filter(|f| is_test_path(f)).cloned().collect();
    if !tests.is_empty() {
        return StepDecision::TouchedTests(tests);
    }
    match check() {
        CheckOutcome::NotConfigured => StepDecision::Commit { checked: false },
        CheckOutcome::Ran(CheckKind::Pass) => StepDecision::Commit { checked: true },
        CheckOutcome::Ran(kind) => StepDecision::ChecksFailed(kind),
    }
}

/// Row text for a reverted step.
pub fn skip_reason(d: &StepDecision) -> Option<String> {
    match d {
        StepDecision::TouchedTests(files) => Some(format!("touched tests ({})", files.join(", "))),
        StepDecision::ChecksFailed(CheckKind::TimedOut) => Some("checks timed out".into()),
        StepDecision::ChecksFailed(CheckKind::InstallFailed) => Some("dependencies failed to install".into()),
        StepDecision::ChecksFailed(_) => Some("checks failed".into()),
        _ => None,
    }
}

pub fn commit_message(title: &str) -> String {
    let t = title.lines().next().unwrap_or("").trim().trim_end_matches('.');
    let t: String = t.chars().take(72).collect();
    format!("refactor: {}", if t.is_empty() { "simplify" } else { &t })
}

fn pick<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).map(str::trim).unwrap_or("")
}

fn line_no(v: &Value, key: &str) -> Option<u32> {
    let n = v.get(key)?;
    n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)).map(|n| n.min(u32::MAX as u64) as u32)
}

/// Reads `claude -p --output-format json` output into candidates: tolerant of sloppy fields, strict
/// about what Apply depends on (a file, a title, unique ids, no test files, at most `max`).
pub fn parse_find_output(stdout: &str, max: usize) -> Result<Vec<Candidate>, String> {
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|_| "claude returned an unreadable response".to_string())?;
    if v.get("is_error").and_then(Value::as_bool) == Some(true) {
        let msg = v.get("result").and_then(Value::as_str).unwrap_or("claude reported an error");
        return Err(msg.chars().take(300).collect());
    }
    let body = match v.get("structured_output").filter(|s| s.is_object()) {
        Some(s) => s.clone(),
        None => v
            .get("result")
            .and_then(Value::as_str)
            .and_then(|s| serde_json::from_str::<Value>(s.trim()).ok())
            .filter(Value::is_object)
            .ok_or_else(|| "claude returned no structured result".to_string())?,
    };
    let list = body.get("candidates").and_then(Value::as_array).ok_or_else(|| "the result has no candidates list".to_string())?;
    let mut out: Vec<Candidate> = vec![];
    for c in list {
        let file = pick(c, "file").trim_start_matches("./").replace('\\', "/");
        let title = pick(c, "title");
        if file.is_empty() || title.is_empty() || is_test_path(&file) {
            continue;
        }
        let start = line_no(c, "startLine").unwrap_or(1).max(1);
        let end = line_no(c, "endLine").unwrap_or(start).max(start);
        let signal = pick(c, "signal");
        let risk = pick(c, "risk");
        out.push(Candidate {
            id: format!("c{}", out.len() + 1),
            file,
            start_line: start,
            end_line: end,
            signal: if SIGNALS.contains(&signal) { signal } else { "other" }.to_string(),
            title: title.to_string(),
            rationale: pick(c, "rationale").to_string(),
            proposed_change: pick(c, "proposedChange").to_string(),
            risk: if RISKS.contains(&risk) { risk } else { "medium" }.to_string(),
        });
        if out.len() >= max {
            break;
        }
    }
    Ok(out)
}

pub struct ScopeFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    /// Unified diff (or the head of a new file); empty when unavailable.
    pub diff: String,
}

fn clip(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

/// The scope text for the find prompt: each file's diff while the budget lasts, then a one-line
/// entry telling the agent to read the rest itself. Returns the text and how many diffs were left out.
pub fn assemble_scope(files: &[ScopeFile], budget: usize, per_file: usize) -> (String, usize) {
    let mut text = String::new();
    let mut omitted = 0;
    for f in files {
        let header = format!("--- {} (+{} -{})\n", f.path, f.additions, f.deletions);
        let (body, cut) = clip(&f.diff, per_file);
        if f.diff.is_empty() || text.len() + header.len() + body.len() > budget {
            text.push_str(&format!("{header}(diff not included: read the file)\n\n"));
            omitted += 1;
        } else {
            text.push_str(&header);
            text.push_str(&body);
            if cut {
                text.push_str("\n(diff cut short: read the file for the rest)");
            }
            text.push_str("\n\n");
        }
    }
    (text, omitted)
}

const FIND_SCHEMA: &str = r#"{"type":"object","properties":{"candidates":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"file":{"type":"string"},"startLine":{"type":"integer"},"endLine":{"type":"integer"},"signal":{"type":"string","enum":["nesting","longFunction","nestedTernary","booleanFlags","duplication","deadCode","needlessWrapper","naming","other"]},"title":{"type":"string"},"rationale":{"type":"string"},"proposedChange":{"type":"string"},"risk":{"type":"string","enum":["low","medium","high"]}},"required":["id","file","startLine","endLine","signal","title","rationale","proposedChange","risk"]}}},"required":["candidates"]}"#;

/// What the find pass looks at. `Diff` is the workspace's own changes against base (the panel's
/// button); `Since` is the work that landed on base in the last `days` days, for a workspace that has
/// no changes of its own yet (the Simplify routine).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scope {
    Diff,
    Since { days: u32 },
}

impl Scope {
    fn subject(self) -> &'static str {
        match self {
            Scope::Diff => "the changes made on this git branch",
            Scope::Since { .. } => "recently merged changes on this repository's base branch",
        }
    }

    fn framing(self, base: &str) -> String {
        match self {
            Scope::Diff => format!("The branch is compared against `{base}`."),
            Scope::Since { days } => format!(
                "The working tree is `{base}` as it is now. These are the changes that landed on it in the last {days} days (a unified diff per file)."
            ),
        }
    }
}

pub fn find_prompt(kind: Scope, base: &str, scope: &str, max: usize) -> String {
    let (subject, framing) = (kind.subject(), kind.framing(base));
    format!(
        "You are reviewing {subject} for code that can be simplified. \
This is analysis only: you cannot edit anything and must not try to. Use Read, Grep and Glob.\n\n\
Goal: list concrete simplifications that make the changed code easier to read and maintain while preserving its behaviour exactly.\n\n\
Rules\n\
- Preserve behaviour exactly: same inputs, outputs, side effects, error handling and ordering. If you cannot be sure a change preserves it, leave it out or mark it risk \"high\".\n\
- Follow the project's conventions. Read CLAUDE.md (if there is one) and the neighbouring code first; a simplification must look like it belongs.\n\
- Clarity over fewer lines. Do not propose dense one-liners or clever tricks, and do not merge unrelated concerns just to shorten code. A nested ternary is a reason to simplify, not to compact.\n\
- Only the changed code: candidates must sit in code that appears in the changes below (the changed lines and the functions around them). Never propose refactors of untouched code.\n\
- Understand before touching: before proposing to remove a guard, wrapper or apparently dead branch, find out why it exists (callers, comments, neighbouring code). If you cannot tell, skip it.\n\
- Never propose changes to test files or changes that would require editing tests.\n\
- Skip code that is already clean. An empty list is a good answer.\n\
- At most {max} candidates, most valuable first. Each must stand alone: applying one must not depend on another, and candidates must not overlap in lines.\n\n\
Signals: nesting (deep nesting that early returns or guard clauses would flatten), longFunction (one function doing several jobs that splits cleanly), nestedTernary, booleanFlags (boolean parameters that switch behaviour), duplication, deadCode, needlessWrapper (an abstraction that only forwards), naming (misleading names, only when clearly worth it), other.\n\n\
For each candidate give: id (c1, c2, ...), file (path relative to the repository root), startLine and endLine of the code in its current state, signal, a short imperative title (under 70 characters, no trailing period), rationale (why it is harder to read now), proposedChange (what to do, concretely enough that an engineer who has not seen this analysis could do it) and risk (low: mechanical and local; medium: touches several call sites or subtle control flow; high: could plausibly change behaviour).\n\n\
{framing} The changes (a unified diff per file, possibly cut short) follow.\n\n<changes>\n{scope}</changes>\n\n\
Respond only with the structured result."
    )
}

pub fn apply_prompt(c: &Candidate) -> String {
    format!(
        "Orbit's simplification pass asks you to make exactly one change in this worktree.\n\n\
Simplify: {title}\n\
Where: {file}, lines {start}-{end} (re-read the file; line numbers may have moved)\n\
Signal: {signal}\n\
Why: {rationale}\n\
What to do: {change}\n\n\
Rules\n\
- Preserve behaviour exactly. If, once you look closely, the change is not safe or not worth it, make no edits and say why in one sentence.\n\
- Follow the project's conventions and the style of the surrounding code. Clarity over fewer lines.\n\
- Touch only what this change needs. Do not edit test files, and do not fix unrelated things you notice.\n\
- Do not commit, stage or push; Orbit will run the project's checks and commit the result itself, or revert it if they fail.\n\
- Keep your reply to two sentences: what you changed, or why you did not.",
        title = c.title,
        file = c.file,
        start = c.start_line,
        end = c.end_line,
        signal = c.signal,
        rationale = c.rationale,
        change = c.proposed_change,
    )
}

// ---- git side (blocking; call inside spawn_blocking) ----

fn merge_base(wt: &Path, base: &str) -> String {
    git::run(wt, &["merge-base", "HEAD", &trunk::base_ref(wt, base)]).unwrap_or_else(|_| "HEAD".into())
}

struct Built {
    text: String,
    files: usize,
    omitted: usize,
}

/// The empty tree, the "before" side of a window that reaches back past the repo's first commit. Git
/// knows its hash but only has the object once something writes it, so write it (from an empty file).
fn empty_tree(wt: &Path) -> anyhow::Result<String> {
    let file = std::env::temp_dir().join(format!("orbit-empty-{}", uuid::Uuid::new_v4()));
    std::fs::write(&file, b"")?;
    let out = git::run(wt, &["hash-object", "-t", "tree", "-w", &file.to_string_lossy()]);
    let _ = std::fs::remove_file(&file);
    out
}

/// The scope for `Scope::Since`: files that changed on base in the last `days` days, biggest change
/// first. Files that no longer exist in the worktree (deleted since) and non-source files are left out.
fn build_scope_since(wt: &Path, base: &str, days: u32) -> anyhow::Result<Built> {
    let target = trunk::base_ref(wt, base);
    // The last commit before the window; everything after it is "recent".
    let before = git::run(wt, &["rev-list", "-1", &format!("--before={days}.days.ago"), &target]).unwrap_or_default();
    let before = if before.trim().is_empty() { empty_tree(wt)? } else { before.trim().to_string() };
    let numstat = git::run(wt, &["diff", "--numstat", "--no-renames", &before, &target])?;
    let mut files: Vec<ScopeFile> = vec![];
    for c in git::parse_numstat_lines(&numstat).into_iter().filter(|c| is_simplifiable(&c.path) && wt.join(&c.path).is_file()) {
        let diff = git::run(wt, &["diff", &before, &target, "--", &c.path]).unwrap_or_default();
        files.push(ScopeFile { path: c.path, additions: c.additions, deletions: c.deletions, diff });
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.additions + f.deletions));
    let (text, omitted) = assemble_scope(&files, SCOPE_BUDGET, SCOPE_PER_FILE);
    Ok(Built { text, files: files.len(), omitted })
}

fn build_scope(wt: &Path, base: &str) -> anyhow::Result<Built> {
    let mb = merge_base(wt, base);
    let mut files: Vec<ScopeFile> = vec![];
    for c in git::changes(wt, base)?.into_iter().filter(|c| is_simplifiable(&c.path)) {
        let diff = if c.untracked {
            std::fs::read_to_string(wt.join(&c.path)).map(|s| format!("(new file)\n{s}")).unwrap_or_default()
        } else {
            git::run(wt, &["diff", &mb, "--", &c.path]).unwrap_or_default()
        };
        files.push(ScopeFile { path: c.path, additions: c.additions, deletions: c.deletions, diff });
    }
    // Biggest changes first: they matter most and are the likeliest to be cut when the budget runs out.
    files.sort_by_key(|f| std::cmp::Reverse(f.additions + f.deletions));
    let (text, omitted) = assemble_scope(&files, SCOPE_BUDGET, SCOPE_PER_FILE);
    Ok(Built { text, files: files.len(), omitted })
}

fn head(wt: &Path) -> anyhow::Result<String> {
    git::run(wt, &["rev-parse", "HEAD"])
}

/// Files that differ from `pre` in the worktree (committed by the agent or not, new files included).
fn changed_since(wt: &Path, pre: &str) -> anyhow::Result<Vec<String>> {
    git::run(wt, &["add", "-A"])?;
    Ok(git::run(wt, &["diff", "--cached", "--no-renames", "--name-only", pre])?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Puts the worktree back exactly at `pre` (it was clean there), dropping any commits and new files.
fn revert_to(wt: &Path, pre: &str) {
    let _ = git::run(wt, &["reset", "--hard", pre]);
    let _ = git::run(wt, &["clean", "-fd"]);
}

/// Commits the staged result as one `refactor:` commit on top of `pre`; (short hash, lines removed).
fn commit_step(wt: &Path, pre: &str, title: &str) -> anyhow::Result<(String, i64)> {
    // The agent may have committed itself despite being told not to: fold it into one commit.
    git::run(wt, &["reset", "--soft", pre])?;
    git::run(wt, &["add", "-A"])?;
    git::run(wt, &["-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", &commit_message(title)])?;
    let hash = git::run(wt, &["rev-parse", "--short", "HEAD"])?;
    let removed = git::run(wt, &["diff", "--numstat", pre, "HEAD"])?
        .lines()
        .filter_map(|l| {
            let mut p = l.split('\t');
            Some(p.next()?.parse::<i64>().unwrap_or(0) - p.next()?.parse::<i64>().unwrap_or(0))
        })
        .fold(0, |acc, d| acc - d);
    Ok((hash, removed))
}

// ---- find ----

async fn run_find(ws: &Workspace, base: String, kind: Scope, model: String, max: usize) -> Result<(Vec<Candidate>, usize, Option<String>), String> {
    let wt = PathBuf::from(&ws.path);
    let (wt2, base2) = (wt.clone(), base.clone());
    let scope = tauri::async_runtime::spawn_blocking(move || match kind {
        Scope::Diff => build_scope(&wt2, &base2),
        Scope::Since { days } => build_scope_since(&wt2, &base2, days),
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    if scope.files == 0 {
        return Ok((vec![], 0, None));
    }
    let prompt = find_prompt(kind, &base, &scope.text, max);
    // Enforced read-only: the built-in tool set itself is limited to Read/Grep/Glob (no Edit, Write or Bash
    // exists for this process), on top of the default permission mode and an explicit allowlist. The prompt
    // goes through stdin because a big diff would not fit a Windows command line.
    let args: Vec<String> = [
        "-p", "--model", model.as_str(), "--output-format", "json", "--no-session-persistence",
        "--setting-sources", "local", "--permission-mode", "default",
        "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob",
        "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash",
        "--json-schema", FIND_SCHEMA,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let mut cmd = crate::agent::process::command("claude", &args, &wt).map_err(err)?;
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await.map_err(err)?;
    }
    let out = tokio::time::timeout(FIND_LIMIT, child.wait_with_output())
        .await
        .map_err(|_| "the analysis timed out".to_string())?
        .map_err(err)?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let candidates = parse_find_output(&stdout, max).map_err(|e| {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let hint = stderr.trim().lines().last().unwrap_or("");
        if hint.is_empty() { e } else { format!("{e} ({hint})") }
    })?;
    let note = (scope.omitted > 0).then(|| {
        format!("The change is large: {} of {} files were too big to include whole, so the analysis read them itself.", scope.omitted, scope.files)
    });
    Ok((candidates, scope.files, note))
}

// ---- apply ----

fn interrupt(state: &AppState, ws_id: &str) {
    if let Some(h) = state.sessions.lock().unwrap().get(ws_id) {
        h.send(Command::Interrupt);
    }
}

/// Everything after the agent's edit turn: decide, then commit or revert. Returns the finished row fields.
fn finish_step(wt: &Path, pre: &str, title: &str, check: impl FnOnce() -> (CheckOutcome, Option<CheckResult>)) -> anyhow::Result<(StepDecision, Option<CheckResult>, Option<(String, i64)>)> {
    // The git lock is not held while the check runs: it can take minutes and would stall other workspaces.
    let changed = {
        let _g = trunk::lock();
        changed_since(wt, pre)?
    };
    let mut result = None;
    let decision = decide_step(&changed, || {
        let (outcome, r) = check();
        result = r;
        outcome
    });
    let _g = trunk::lock();
    let mut commit = None;
    match &decision {
        StepDecision::Commit { .. } => commit = Some(commit_step(wt, pre, title)?),
        _ => revert_to(wt, pre),
    }
    Ok((decision, result, commit))
}

async fn apply_loop(app: AppHandle, state: AppState, ws_id: String, ids: Vec<String>, cancel: Arc<AtomicBool>, wake: Arc<Notify>) {
    let (ws, cmd) = match state.db().workspace(&ws_id) {
        Ok(ws) => {
            let cmd = trunk::resolve_command(&state, &ws);
            (ws, cmd)
        }
        Err(_) => return,
    };
    let wt = PathBuf::from(&ws.path);
    let candidates: Vec<Candidate> = runs().get(&ws_id).map(|r| r.state.candidates.clone()).unwrap_or_default();

    for id in ids {
        let Some(c) = candidates.iter().find(|c| c.id == id).cloned() else { continue };
        if cancel.load(Ordering::SeqCst) {
            set_row(&app, &ws_id, &id, |r| {
                r.status = "skipped".into();
                r.detail = Some("cancelled".into());
            });
            continue;
        }
        let wt2 = wt.clone();
        let pre = match tauri::async_runtime::spawn_blocking(move || head(&wt2)).await {
            Ok(Ok(h)) => h,
            _ => {
                set_row(&app, &ws_id, &id, |r| {
                    r.status = "skipped".into();
                    r.detail = Some("could not read the current commit".into());
                });
                continue;
            }
        };
        set_row(&app, &ws_id, &id, |r| r.status = "editing".into());

        // Register for the turn's end before sending, so a fast turn cannot slip past.
        let (tx, mut rx) = oneshot::channel();
        WAITERS.lock().unwrap_or_else(|p| p.into_inner()).insert(ws_id.clone(), tx);
        if let Err(e) = crate::send(&app, &state, &ws_id, format!("Simplify: {}", c.title), None, apply_prompt(&c)) {
            WAITERS.lock().unwrap_or_else(|p| p.into_inner()).remove(&ws_id);
            set_row(&app, &ws_id, &id, |r| {
                r.status = "skipped".into();
                r.detail = Some(format!("could not reach the agent: {e}"));
            });
            continue;
        }
        let waited = tokio::time::timeout(TURN_LIMIT, async {
            tokio::select! {
                r = &mut rx => (r.ok(), false),
                _ = wake.notified() => (None, true),
            }
        })
        .await;
        let (end, cancelled_now, timed_out) = match waited {
            Ok((end, cancelled)) => (end, cancelled, false),
            Err(_) => (None, false, true),
        };
        if cancelled_now || timed_out {
            // Stop the turn and give it a moment to land before touching the tree.
            interrupt(&state, &ws_id);
            let _ = tokio::time::timeout(Duration::from_secs(20), &mut rx).await;
        }
        WAITERS.lock().unwrap_or_else(|p| p.into_inner()).remove(&ws_id);

        let stop_reason = if cancelled_now || cancel.load(Ordering::SeqCst) {
            Some("cancelled".to_string())
        } else if timed_out {
            Some("the agent took too long".to_string())
        } else {
            match &end {
                Some(e) if e.interrupted => Some("the turn was interrupted".to_string()),
                Some(e) => e.error.as_ref().map(|m| format!("the agent failed: {m}")),
                None => Some("the agent stopped responding".to_string()),
            }
        };
        if let Some(reason) = stop_reason {
            let (wt2, pre2) = (wt.clone(), pre.clone());
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _g = trunk::lock();
                revert_to(&wt2, &pre2);
            })
            .await;
            set_row(&app, &ws_id, &id, |r| {
                r.status = "skipped".into();
                r.detail = Some(reason);
            });
            continue;
        }

        set_row(&app, &ws_id, &id, |r| r.status = "checking".into());
        let (wt2, pre2, title, cmd2) = (wt.clone(), pre.clone(), c.title.clone(), cmd.clone());
        let opts = trunk::run_options(&state);
        let step = tauri::async_runtime::spawn_blocking(move || {
            finish_step(&wt2, &pre2, &title, || match &cmd2 {
                None => (CheckOutcome::NotConfigured, None),
                Some(cmd) => {
                    let r = checks::run(&wt2, cmd, opts);
                    (CheckOutcome::Ran(r.kind), Some(r))
                }
            })
        })
        .await;
        match step {
            Ok(Ok((decision, result, commit))) => set_row(&app, &ws_id, &id, |r| match &decision {
                StepDecision::NoOp => {
                    r.status = "noop".into();
                    r.detail = Some("the agent made no change".into());
                }
                StepDecision::Commit { checked } => {
                    r.status = "applied".into();
                    r.unchecked = !checked;
                    if let Some((hash, removed)) = &commit {
                        r.commit = Some(hash.clone());
                        r.lines_removed = *removed;
                    }
                }
                other => {
                    r.status = "skipped".into();
                    r.detail = skip_reason(other);
                    if let Some(res) = &result {
                        if matches!(other, StepDecision::ChecksFailed(_)) {
                            r.detail = Some(format!("{}\n{}", skip_reason(other).unwrap_or_default(), res.output_tail));
                        }
                    }
                }
            }),
            Ok(Err(e)) => {
                let (wt2, pre2) = (wt.clone(), pre.clone());
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    let _g = trunk::lock();
                    revert_to(&wt2, &pre2);
                })
                .await;
                set_row(&app, &ws_id, &id, |r| {
                    r.status = "skipped".into();
                    r.detail = Some(format!("git failed: {e}"));
                });
            }
            Err(e) => set_row(&app, &ws_id, &id, |r| {
                r.status = "skipped".into();
                r.detail = Some(format!("internal error: {e}"));
            }),
        }
    }

    update(&app, &ws_id, |r| {
        r.state.phase = Phase::Done;
        r.state.cancelled = r.cancel.load(Ordering::SeqCst);
    });
    // The branch moved (or was restored): refresh the row the UI shows.
    if let Ok(w) = state.db().workspace(&ws_id) {
        emit_workspace(&app, &w);
    }
}

// ---- commands ----

fn snapshot(ws_id: &str) -> SimplifyState {
    runs().get(ws_id).map(|r| r.state.clone()).unwrap_or_else(|| SimplifyState::new(ws_id))
}

#[tauri::command]
pub fn simplify_state(workspace_id: String) -> SimplifyState {
    snapshot(&workspace_id)
}

/// Checks the workspace can be analysed and flips its state to Finding; returns the base branch.
fn begin_find(app: &AppHandle, state: &AppState, ws: &Workspace) -> CmdResult<String> {
    if ws.status == "running" {
        return Err("Wait for the current turn to finish before simplifying".into());
    }
    if matches!(snapshot(&ws.id).phase, Phase::Finding | Phase::Applying) {
        return Err("Simplify is already running for this workspace".into());
    }
    let base = state.db().repo(&ws.repo_id).map_err(err)?.base_branch;
    let cmd = trunk::resolve_command(state, ws);
    update(app, &ws.id, |r| {
        r.state = SimplifyState::new(&ws.id);
        r.state.phase = Phase::Finding;
        r.state.check_command = cmd;
        r.cancel.store(false, Ordering::SeqCst);
    });
    Ok(base)
}

/// Runs the analysis and records the outcome: Ready with the candidates, or Idle with the error.
async fn find_and_record(app: AppHandle, state: AppState, ws: Workspace, base: String, scope: Scope) {
    let settings = state.settings();
    let found = run_find(&ws, base, scope, settings.simplify_model.clone(), settings.simplify_max_candidates as usize).await;
    update(&app, &ws.id, |r| {
        r.find_task = None;
        match found {
            Ok((candidates, files, note)) => {
                r.state.rows = candidates
                    .iter()
                    .map(|c| Row { candidate_id: c.id.clone(), status: "queued".into(), detail: None, commit: None, lines_removed: 0, unchecked: false })
                    .collect();
                r.state.candidates = candidates;
                r.state.scope_files = files;
                r.state.scope_note = note;
                r.state.phase = Phase::Ready;
            }
            Err(e) => {
                r.state.error = Some(e);
                r.state.phase = Phase::Idle;
            }
        }
    });
}

/// Starts the read-only analysis; progress and the result arrive as `simplify` events.
#[tauri::command]
pub async fn simplify_find(app: AppHandle, state: State<'_, AppState>, workspace_id: String) -> CmdResult<SimplifyState> {
    let state: AppState = state.inner().clone();
    let ws = state.db().workspace(&workspace_id).map_err(err)?;
    let base = begin_find(&app, &state, &ws)?;
    let handle = tauri::async_runtime::spawn(find_and_record(app.clone(), state, ws.clone(), base, Scope::Diff));
    update(&app, &ws.id, |r| r.find_task = Some(handle));
    Ok(snapshot(&workspace_id))
}

/// Applies the ticked candidates one at a time on the workspace's own agent session.
#[tauri::command]
pub async fn simplify_apply(app: AppHandle, state: State<'_, AppState>, workspace_id: String, candidate_ids: Vec<String>) -> CmdResult<SimplifyState> {
    let state: AppState = state.inner().clone();
    let ws = state.db().workspace(&workspace_id).map_err(err)?;
    let (ids, cancel, wake) = begin_apply(&app, &state, &ws, &candidate_ids).await?;
    tauri::async_runtime::spawn(apply_loop(app.clone(), state.clone(), workspace_id.clone(), ids, cancel, wake));
    Ok(snapshot(&workspace_id))
}

/// Everything before the first edit turn: guards, a clean tree, and the state flipped to Applying.
async fn begin_apply(app: &AppHandle, state: &AppState, ws: &Workspace, candidate_ids: &[String]) -> CmdResult<(Vec<String>, Arc<AtomicBool>, Arc<Notify>)> {
    let workspace_id = ws.id.clone();
    if ws.status == "running" {
        return Err("Wait for the current turn to finish before applying".into());
    }
    if crate::resolve_profile(state, ws).is_some_and(|p| p.readonly) {
        return Err("This workspace's profile is read-only, so it can't make edits. Switch profile first.".into());
    }
    let current = snapshot(&workspace_id);
    if !matches!(current.phase, Phase::Ready | Phase::Done) {
        return Err("Find simplifications first".into());
    }
    // Keep the list's order and ignore unknown or repeated ids.
    let ids: Vec<String> = current.candidates.iter().filter(|c| candidate_ids.contains(&c.id)).map(|c| c.id.clone()).collect();
    if ids.is_empty() {
        return Err("Select at least one simplification".into());
    }
    // A step ends with `git reset --hard`, so the tree must be clean now: anything uncommitted becomes a save point.
    let settings = state.settings();
    let wt = PathBuf::from(&ws.path);
    let save = settings.save_commits;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = trunk::lock();
        if git::is_clean(&wt) {
            return Ok(());
        }
        if !save {
            return Err("The worktree has uncommitted changes. Commit them first (Simplify resets failed steps and would lose them).".to_string());
        }
        trunk::commit_save_point(&wt, "wip: before simplify").map(|_| ()).map_err(err)
    })
    .await
    .map_err(err)??;

    let (cancel, wake) = {
        let mut map = runs();
        let run = map.get_mut(&workspace_id).ok_or("Find simplifications first")?;
        run.cancel.store(false, Ordering::SeqCst);
        run.state.phase = Phase::Applying;
        run.state.cancelled = false;
        run.state.check_command = trunk::resolve_command(state, ws);
        for row in run.state.rows.iter_mut().filter(|r| ids.contains(&r.candidate_id)) {
            *row = Row { candidate_id: row.candidate_id.clone(), status: "queued".into(), detail: None, commit: None, lines_removed: 0, unchecked: false };
        }
        (run.cancel.clone(), run.wake.clone())
    };
    update(app, &workspace_id, |_| {});
    Ok((ids, cancel, wake))
}

// ---- unattended pass (Routines) ----

/// Candidates the unattended pass applies: the low-risk ones, in list order.
pub fn low_risk_ids(candidates: &[Candidate]) -> Vec<String> {
    candidates.iter().filter(|c| c.risk == "low").map(|c| c.id.clone()).collect()
}

/// What an unattended pass ended with; `summary` reads as a routine run's summary.
pub struct Outcome {
    pub applied: usize,
    pub summary: String,
    pub error: Option<String>,
}

/// A one-paragraph account of a pass for the routine run row (and the summary model's input).
pub fn run_summary(scope_files: usize, candidates: &[Candidate], rows: &[Row], days: u32) -> String {
    let low = low_risk_ids(candidates).len();
    let head = format!(
        "Looked at {scope_files} {} changed in the last {days} days and found {} {} ({low} low-risk).",
        if scope_files == 1 { "file" } else { "files" },
        candidates.len(),
        if candidates.len() == 1 { "candidate" } else { "candidates" }
    );
    if low == 0 {
        return head;
    }
    let applied = rows.iter().filter(|r| r.status == "applied").count();
    let mut out = format!("{head} Applied {applied} of {low}.");
    let skipped: Vec<String> = rows
        .iter()
        .filter(|r| r.status == "skipped")
        .filter_map(|r| {
            let title = candidates.iter().find(|c| c.id == r.candidate_id).map(|c| c.title.as_str())?;
            let why = r.detail.as_deref().and_then(|d| d.lines().next()).unwrap_or("skipped");
            Some(format!("{title} ({why})"))
        })
        .collect();
    if !skipped.is_empty() {
        out.push_str(&format!(" Skipped: {}.", skipped.join("; ")));
    }
    out
}

/// Find, then apply every low-risk candidate, without anyone clicking. The caller owns what happens
/// next (ship if anything was applied). Medium and high-risk candidates are never applied unattended.
pub async fn run_unattended(app: &AppHandle, state: &AppState, ws_id: &str, days: u32) -> Outcome {
    let fail = |e: String| Outcome { applied: 0, summary: format!("Simplify failed: {e}"), error: Some(e) };
    let ws = match state.db().workspace(ws_id) {
        Ok(ws) => ws,
        Err(e) => return fail(err(e)),
    };
    let base = match begin_find(app, state, &ws) {
        Ok(b) => b,
        Err(e) => return fail(e),
    };
    find_and_record(app.clone(), state.clone(), ws.clone(), base, Scope::Since { days }).await;
    let found = snapshot(ws_id);
    if let Some(e) = found.error {
        return fail(e);
    }
    let ids = low_risk_ids(&found.candidates);
    if ids.is_empty() {
        update(app, ws_id, |r| r.state.phase = Phase::Done);
        return Outcome { applied: 0, summary: run_summary(found.scope_files, &found.candidates, &[], days), error: None };
    }
    let (ids, cancel, wake) = match begin_apply(app, state, &ws, &ids).await {
        Ok(t) => t,
        Err(e) => {
            update(app, ws_id, |r| r.state.phase = Phase::Ready);
            return fail(e);
        }
    };
    apply_loop(app.clone(), state.clone(), ws_id.to_string(), ids, cancel, wake).await;
    let done = snapshot(ws_id);
    Outcome {
        applied: done.rows.iter().filter(|r| r.status == "applied").count(),
        summary: run_summary(found.scope_files, &done.candidates, &done.rows, days),
        error: None,
    }
}

/// Stops a running analysis, or the apply sequence after reverting the step in flight.
#[tauri::command]
pub fn simplify_cancel(app: AppHandle, workspace_id: String) -> SimplifyState {
    let phase = snapshot(&workspace_id).phase;
    match phase {
        Phase::Finding => update(&app, &workspace_id, |r| {
            if let Some(t) = r.find_task.take() {
                t.abort();
            }
            r.state.phase = Phase::Idle;
        }),
        Phase::Applying => update(&app, &workspace_id, |r| {
            r.cancel.store(true, Ordering::SeqCst);
            r.wake.notify_one();
        }),
        _ => {}
    }
    snapshot(&workspace_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognises_test_paths() {
        for p in [
            "src/foo.test.ts", "src/foo.spec.tsx", "tests/api.rs", "src-tauri/tests/fixtures/a.jsonl", "pkg/__tests__/x.js", "foo_test.go", "test_utils.py",
            "app/conftest.py", "scripts/e2e.mjs", "scripts/e2e-github.mjs", "src/FooTest.java", "spec/models/user_spec.rb", "src\\tests\\a.rs", "a/__snapshots__/b.snap",
        ] {
            assert!(is_test_path(p), "{p} should be a test path");
        }
        for p in ["src/lib/attention.ts", "src-tauri/src/checks.rs", "src/latest.ts", "src/contest.ts", "src/protester.rs", "README.md", "src/components/Spectrum.tsx"] {
            assert!(!is_test_path(p), "{p} should not be a test path");
        }
    }

    #[test]
    fn scope_skips_tests_locks_and_generated() {
        assert!(is_simplifiable("src/app.ts"));
        for p in ["src/app.test.ts", "bun.lock", "package-lock.json", "dist/app.min.js", "logo.png", "node_modules/x/y.js", "Cargo.lock"] {
            assert!(!is_simplifiable(p), "{p}");
        }
    }

    #[test]
    fn step_decisions() {
        let src = vec!["src/a.ts".to_string()];
        let never = || -> CheckOutcome { panic!("check must not run") };
        // Nothing changed: no-op, no check.
        assert_eq!(decide_step(&[], never), StepDecision::NoOp);
        // Touching a test reverts without paying for a check.
        let both = vec!["src/a.ts".to_string(), "src/a.test.ts".to_string()];
        assert_eq!(decide_step(&both, never), StepDecision::TouchedTests(vec!["src/a.test.ts".into()]));
        // Checks decide the rest.
        assert_eq!(decide_step(&src, || CheckOutcome::Ran(CheckKind::Pass)), StepDecision::Commit { checked: true });
        assert_eq!(decide_step(&src, || CheckOutcome::Ran(CheckKind::Fail)), StepDecision::ChecksFailed(CheckKind::Fail));
        assert_eq!(decide_step(&src, || CheckOutcome::Ran(CheckKind::TimedOut)), StepDecision::ChecksFailed(CheckKind::TimedOut));
        assert_eq!(decide_step(&src, || CheckOutcome::NotConfigured), StepDecision::Commit { checked: false });
        assert_eq!(skip_reason(&StepDecision::ChecksFailed(CheckKind::Fail)).as_deref(), Some("checks failed"));
        assert_eq!(skip_reason(&StepDecision::ChecksFailed(CheckKind::InstallFailed)).as_deref(), Some("dependencies failed to install"));
        assert!(skip_reason(&StepDecision::TouchedTests(vec!["a.test.ts".into()])).unwrap().starts_with("touched tests"));
        assert_eq!(skip_reason(&StepDecision::Commit { checked: true }), None);
    }

    #[test]
    fn commit_messages() {
        assert_eq!(commit_message("Flatten nesting in parse()."), "refactor: Flatten nesting in parse()");
        assert_eq!(commit_message("  "), "refactor: simplify");
        assert!(commit_message(&"x".repeat(200)).len() <= "refactor: ".len() + 72);
    }

    #[test]
    fn parses_structured_output() {
        let out = json!({
            "type": "result", "is_error": false,
            "structured_output": { "candidates": [
                { "id": "zzz", "file": "./src/a.ts", "startLine": 10, "endLine": 40, "signal": "nesting", "title": "Flatten parse()", "rationale": "r", "proposedChange": "use guards", "risk": "low" },
                { "id": "c1", "file": "src/b.ts", "startLine": 5.0, "endLine": 2, "signal": "weird", "title": "Rename x", "rationale": "", "proposedChange": "", "risk": "scary" },
                { "file": "src/a.test.ts", "title": "Tidy test", "startLine": 1, "endLine": 2 },
                { "file": "", "title": "no file" },
                { "file": "src/c.ts", "title": "" },
                { "file": "src\\d.ts", "title": "Dedupe", "startLine": 1, "endLine": 3, "signal": "duplication", "risk": "medium" }
            ] }
        })
        .to_string();
        let c = parse_find_output(&out, 12).unwrap();
        assert_eq!(c.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["c1", "c2", "c3"]);
        assert_eq!((c[0].file.as_str(), c[0].start_line, c[0].end_line, c[0].risk.as_str()), ("src/a.ts", 10, 40, "low"));
        // Unknown signal/risk fall back; an end before the start is lifted to the start.
        assert_eq!((c[1].signal.as_str(), c[1].risk.as_str(), c[1].start_line, c[1].end_line), ("other", "medium", 5, 5));
        assert_eq!(c[2].file, "src/d.ts");
        assert_eq!(parse_find_output(&out, 2).unwrap().len(), 2);
    }

    #[test]
    fn parse_failures_and_empty_results() {
        assert_eq!(parse_find_output(r#"{"structured_output":{"candidates":[]}}"#, 5).unwrap(), vec![]);
        assert!(parse_find_output("not json", 5).is_err());
        assert!(parse_find_output(r#"{"is_error":true,"result":"Credit balance is too low"}"#, 5).unwrap_err().contains("Credit"));
        assert!(parse_find_output(r#"{"result":"I could not do it"}"#, 5).is_err());
        // Falls back to a JSON string in `result`.
        let r = json!({ "result": json!({ "candidates": [{ "file": "a.ts", "title": "T" }] }).to_string() }).to_string();
        assert_eq!(parse_find_output(&r, 5).unwrap().len(), 1);
    }

    #[test]
    fn scope_respects_the_budget() {
        let f = |p: &str, n: usize| ScopeFile { path: p.into(), additions: 3, deletions: 1, diff: "x".repeat(n) };
        let files = vec![f("a.ts", 50), f("b.ts", 50), f("c.ts", 500), ScopeFile { path: "d.ts".into(), additions: 1, deletions: 0, diff: String::new() }];
        let (text, omitted) = assemble_scope(&files, 200, 100);
        assert_eq!(omitted, 2, "c.ts is over the budget and d.ts has no diff");
        assert!(text.contains("--- a.ts (+3 -1)") && text.contains("--- c.ts") && text.contains("read the file"));
        // A long diff is cut per file and says so.
        let (text, omitted) = assemble_scope(&[f("e.ts", 300)], 10_000, 100);
        assert_eq!(omitted, 0);
        assert!(text.contains("diff cut short"));
    }

    #[test]
    fn prompts_carry_their_inputs() {
        let p = find_prompt(Scope::Diff, "main", "--- a.ts\n", 7);
        assert!(p.contains("At most 7 candidates") && p.contains("`main`") && p.contains("--- a.ts") && p.contains("Preserve behaviour exactly"));
        let c = Candidate {
            id: "c1".into(), file: "src/a.ts".into(), start_line: 3, end_line: 9, signal: "nesting".into(),
            title: "Flatten parse()".into(), rationale: "deep".into(), proposed_change: "guard clauses".into(), risk: "low".into(),
        };
        let a = apply_prompt(&c);
        assert!(a.contains("Simplify: Flatten parse()") && a.contains("src/a.ts, lines 3-9") && a.contains("guard clauses") && a.contains("Do not commit"));
    }

    // ---- git behaviour on a real repo ----

    fn tmp_repo() -> PathBuf {
        let d = std::env::temp_dir().join(format!("orbit-simplify-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        for a in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git::run(&d, &a).unwrap();
        }
        std::fs::write(d.join("a.ts"), "export const a = 1;\n").unwrap();
        git::run(&d, &["add", "-A"]).unwrap();
        git::run(&d, &["commit", "-q", "-m", "init"]).unwrap();
        d
    }

    #[test]
    fn step_commit_revert_and_noop_on_a_real_repo() {
        let d = tmp_repo();
        let pre = head(&d).unwrap();

        // No change.
        assert!(changed_since(&d, &pre).unwrap().is_empty());

        // An edit plus a new file: kept as one refactor commit with lines removed counted.
        std::fs::write(d.join("a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n").unwrap();
        std::fs::write(d.join("new.ts"), "x\n").unwrap();
        let mut changed = changed_since(&d, &pre).unwrap();
        changed.sort();
        assert_eq!(changed, ["a.ts", "new.ts"]);
        let (hash, removed) = commit_step(&d, &pre, "Add b and c.").unwrap();
        assert_eq!(removed, -3, "three lines added, none deleted");
        assert_eq!(git::run(&d, &["log", "-1", "--format=%s"]).unwrap(), "refactor: Add b and c");
        assert_eq!(git::run(&d, &["rev-parse", "--short", "HEAD"]).unwrap(), hash);
        assert!(git::is_clean(&d));

        // An agent that committed itself is folded into one commit.
        let pre2 = head(&d).unwrap();
        std::fs::write(d.join("a.ts"), "export const a = 1;\n").unwrap();
        git::run(&d, &["commit", "-qam", "agent commit"]).unwrap();
        std::fs::write(d.join("extra.ts"), "y\n").unwrap();
        assert_eq!(changed_since(&d, &pre2).unwrap().len(), 2);
        let (_, removed) = commit_step(&d, &pre2, "Fold").unwrap();
        assert_eq!(git::run(&d, &["rev-list", "--count", &format!("{pre2}..HEAD")]).unwrap(), "1");
        assert_eq!(removed, 1, "two lines deleted, one added");

        // Revert brings back the exact tree, untracked files included.
        let pre3 = head(&d).unwrap();
        std::fs::write(d.join("a.ts"), "broken\n").unwrap();
        std::fs::write(d.join("junk.ts"), "z\n").unwrap();
        git::run(&d, &["commit", "-qam", "agent commit"]).unwrap();
        std::fs::write(d.join("more.ts"), "z\n").unwrap();
        revert_to(&d, &pre3);
        assert_eq!(head(&d).unwrap(), pre3);
        assert!(git::is_clean(&d) && !d.join("junk.ts").exists() && !d.join("more.ts").exists());
    }

    #[test]
    fn a_step_touching_tests_is_reverted_without_running_checks() {
        let d = tmp_repo();
        let pre = head(&d).unwrap();
        std::fs::write(d.join("a.test.ts"), "t\n").unwrap();
        std::fs::write(d.join("a.ts"), "export const a = 2;\n").unwrap();
        let (decision, result, commit) = finish_step(&d, &pre, "Whatever", || panic!("checks must not run")).unwrap();
        assert!(matches!(decision, StepDecision::TouchedTests(_)) && result.is_none() && commit.is_none());
        assert!(git::is_clean(&d) && !d.join("a.test.ts").exists());
        // (git may check the file out with CRLF on Windows.)
        assert_eq!(std::fs::read_to_string(d.join("a.ts")).unwrap().replace("\r\n", "\n"), "export const a = 1;\n");
    }

    #[test]
    fn a_failing_check_reverts_and_a_passing_one_commits() {
        let d = tmp_repo();
        let pre = head(&d).unwrap();
        let ran = |ok: bool| move || (CheckOutcome::Ran(if ok { CheckKind::Pass } else { CheckKind::Fail }), None);
        std::fs::write(d.join("a.ts"), "export const a = 2;\n").unwrap();
        let (decision, _, commit) = finish_step(&d, &pre, "Fails", ran(false)).unwrap();
        assert_eq!(decision, StepDecision::ChecksFailed(CheckKind::Fail));
        assert!(commit.is_none() && git::is_clean(&d) && head(&d).unwrap() == pre);
        std::fs::write(d.join("a.ts"), "export const a = 2;\n").unwrap();
        let (decision, _, commit) = finish_step(&d, &pre, "Passes", ran(true)).unwrap();
        assert_eq!(decision, StepDecision::Commit { checked: true });
        assert!(commit.is_some() && git::is_clean(&d) && head(&d).unwrap() != pre);
        // No change at all.
        let pre = head(&d).unwrap();
        let (decision, _, commit) = finish_step(&d, &pre, "Nothing", || panic!("no check for a no-op")).unwrap();
        assert_eq!((decision, commit), (StepDecision::NoOp, None));
    }

    #[test]
    fn scope_reads_the_diff_against_base() {
        let d = tmp_repo();
        git::run(&d, &["checkout", "-q", "-b", "feature"]).unwrap();
        std::fs::write(d.join("a.ts"), "export const a = 1;\nexport const z = 9;\n").unwrap();
        std::fs::write(d.join("a.test.ts"), "t\n").unwrap();
        std::fs::write(d.join("fresh.ts"), "hello\n").unwrap();
        git::run(&d, &["add", "-A"]).unwrap();
        git::run(&d, &["commit", "-q", "-m", "feat"]).unwrap();
        std::fs::write(d.join("untracked.ts"), "u\n").unwrap();
        let s = build_scope(&d, "main").unwrap();
        assert_eq!(s.files, 3, "a.ts, fresh.ts, untracked.ts; the test file is out of scope");
        assert!(s.text.contains("+export const z = 9;") && s.text.contains("hello") && s.text.contains("(new file)") && !s.text.contains("a.test.ts"));
    }

    fn commit_dated(d: &Path, msg: &str, date: &str) {
        let ok = std::process::Command::new("git")
            .args(["commit", "-q", "-m", msg])
            .current_dir(d)
            .env("GIT_COMMITTER_DATE", date)
            .env("GIT_AUTHOR_DATE", date)
            .status()
            .unwrap()
            .success();
        assert!(ok);
    }

    #[test]
    fn since_scope_reads_what_landed_on_base_in_the_window() {
        let d = tmp_repo();
        // The repo's first commit is long ago, with a file nobody has touched since.
        std::fs::write(d.join("old.ts"), "export const old = 1;\n").unwrap();
        std::fs::write(d.join("gone.ts"), "export const gone = 1;\n").unwrap();
        git::run(&d, &["add", "-A"]).unwrap();
        commit_dated(&d, "ancient", "2020-01-01T00:00:00");
        // Recent work on main: an edit, a new file, a test, and a deletion.
        std::fs::write(d.join("a.ts"), "export const a = 1;\nexport const z = 9;\n").unwrap();
        std::fs::write(d.join("b.ts"), "export const b = 2;\n").unwrap();
        std::fs::write(d.join("b.test.ts"), "t\n").unwrap();
        std::fs::remove_file(d.join("gone.ts")).unwrap();
        git::run(&d, &["add", "-A"]).unwrap();
        git::run(&d, &["commit", "-q", "-m", "recent"]).unwrap();

        let s = build_scope_since(&d, "main", 7).unwrap();
        assert_eq!(s.files, 2, "a.ts and b.ts only: old.ts is outside the window, gone.ts is deleted, tests are out of scope");
        assert!(s.text.contains("+export const z = 9;") && s.text.contains("--- b.ts") && !s.text.contains("old.ts") && !s.text.contains("gone.ts"));

        // A window reaching past the first commit counts everything that still exists.
        let all = build_scope_since(&d, "main", 4_000).unwrap();
        assert_eq!(all.files, 3, "a.ts, b.ts, old.ts");
    }

    #[test]
    fn since_prompt_and_unattended_summary() {
        let p = find_prompt(Scope::Since { days: 7 }, "main", "--- a.ts\n", 4);
        assert!(p.contains("recently merged") && p.contains("last 7 days") && p.contains("At most 4") && p.contains("--- a.ts"));
        // The button's scope reads as before.
        let diff = find_prompt(Scope::Diff, "main", "x", 4);
        assert!(diff.contains("compared against `main`") && diff.contains("the changes made on this git branch") && !diff.contains("last 7 days"));

        let cand = |id: &str, title: &str, risk: &str| Candidate {
            id: id.into(), file: "a.ts".into(), start_line: 1, end_line: 2, signal: "other".into(), title: title.into(),
            rationale: String::new(), proposed_change: String::new(), risk: risk.into(),
        };
        let cands = vec![cand("c1", "Flatten parse", "low"), cand("c2", "Split run", "medium"), cand("c3", "Drop wrapper", "low")];
        assert_eq!(low_risk_ids(&cands), ["c1", "c3"]);
        let row = |id: &str, status: &str, detail: Option<&str>| Row {
            candidate_id: id.into(), status: status.into(), detail: detail.map(String::from), commit: None, lines_removed: 0, unchecked: false,
        };
        let rows = vec![row("c1", "applied", None), row("c3", "skipped", Some("checks failed\nfull output"))];
        let s = run_summary(5, &cands, &rows, 7);
        assert_eq!(
            s,
            "Looked at 5 files changed in the last 7 days and found 3 candidates (2 low-risk). Applied 1 of 2. Skipped: Drop wrapper (checks failed)."
        );
        assert_eq!(run_summary(1, &[], &[], 7), "Looked at 1 file changed in the last 7 days and found 0 candidates (0 low-risk).");
    }

    /// Needs `claude` on PATH and costs a few cents: `cargo test -- --include-ignored live_find`.
    #[tokio::test]
    #[ignore]
    async fn live_find_flags_an_over_nested_function() {
        let d = tmp_repo();
        git::run(&d, &["checkout", "-q", "-b", "feature"]).unwrap();
        std::fs::write(
            d.join("ship.js"),
            "function shippingCost(order) {\n  let cost = 0;\n  if (order) {\n    if (order.items) {\n      if (order.items.length > 0) {\n        if (order.destination) {\n          if (order.destination.country === 'US') {\n            if (order.total > 100) {\n              cost = 0;\n            } else {\n              cost = 5;\n            }\n          } else {\n            cost = 20;\n          }\n        }\n      }\n    }\n  }\n  return cost;\n}\nmodule.exports = { shippingCost };\n",
        )
        .unwrap();
        git::run(&d, &["add", "-A"]).unwrap();
        git::run(&d, &["commit", "-q", "-m", "feat: shipping"]).unwrap();

        let scope = build_scope(&d, "main").unwrap();
        let prompt = find_prompt(Scope::Diff, "main", &scope.text, 5);
        let args: Vec<String> = [
            "-p", "--model", "haiku", "--output-format", "json", "--no-session-persistence", "--setting-sources", "local", "--permission-mode", "default",
            "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash", "--json-schema", FIND_SCHEMA,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let mut cmd = crate::agent::process::command("claude", &args, &d).unwrap();
        let mut child = cmd.spawn().unwrap();
        child.stdin.take().unwrap().write_all(prompt.as_bytes()).await.unwrap();
        let out = tokio::time::timeout(Duration::from_secs(240), child.wait_with_output()).await.unwrap().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let found = parse_find_output(&stdout, 5).unwrap_or_else(|e| panic!("{e}\n{stdout}"));
        eprintln!("{found:#?}");
        assert!(!found.is_empty(), "expected at least one candidate: {stdout}");
        assert!(found.iter().any(|c| c.file == "ship.js"), "{found:?}");
        assert!(git::is_clean(&d), "the find pass must not edit anything");
    }
}
