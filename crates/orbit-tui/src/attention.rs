//! Port of `src/lib/attention.ts`: which workspaces need you, and why (behaviour.md §2).
//! The `review` reason is not ported in v1.

use crate::text::first_line;
use orbit_proto::{HelloSettings, PrStatus, Status, Summary, Workspace};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Reason {
    Error,
    Question,
    ChecksFailed,
    NeedsSync,
    Checks,
    Changes,
    Done,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Group {
    NeedsYou,
    Running,
    Done,
}

impl Group {
    pub fn label(self) -> &'static str {
        match self {
            Group::NeedsYou => "needs you",
            Group::Running => "running",
            Group::Done => "done",
        }
    }
}

/// Which colour a status dot gets (mapped to theme tokens by the views).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Bad,
    Info,
    Warn,
    Ok,
    Run,
    Merged,
    Mute,
}

pub fn is_snoozed(ws: &Workspace, now: i64) -> bool {
    now < ws.snoozed_until
}

const DAY_MS: i64 = 86_400_000;

pub fn is_stale(ws: &Workspace, limits: &HelloSettings, now: i64) -> bool {
    (limits.stale_days > 0 && now - ws.created_at >= limits.stale_days as i64 * DAY_MS)
        || (limits.stale_behind > 0 && ws.behind >= limits.stale_behind as i64)
}

pub fn asks_question(text: Option<&str>) -> bool {
    let Some(text) = text else { return false };
    let trimmed = text.trim();
    let last = trimmed.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("");
    if last.ends_with('?') {
        return true;
    }
    // A sentence-ending "?" after a word, not code like `a ? b` or a URL query string.
    let chars: Vec<char> = trimmed.chars().collect();
    let tail = &chars[chars.len().saturating_sub(200)..];
    tail.iter().enumerate().any(|(i, &c)| {
        c == '?'
            && i > 0
            && (tail[i - 1].is_alphanumeric() || matches!(tail[i - 1], ')' | '"' | '\'' | '”'))
            && tail.get(i + 1).is_none_or(|n| n.is_whitespace())
    })
}

pub fn attention_reason(
    ws: &Workspace,
    summary: Option<&Summary>,
    pr: Option<&PrStatus>,
    limits: &HelloSettings,
    now: i64,
) -> Option<Reason> {
    let summary = summary?;
    if ws.status == Status::Running || is_snoozed(ws, now) || ws.dismissed_seq >= summary.last_seq {
        return None;
    }
    let unseen = summary.last_seq > ws.seen_seq;
    let failed = ws.status == Status::Error || (summary.last_turn_error.is_some() && !summary.last_turn_interrupted);
    let open = pr.filter(|p| p.state == "OPEN");
    if unseen && failed {
        return Some(Reason::Error);
    }
    if unseen && asks_question(summary.last_assistant_text.as_deref()) {
        return Some(Reason::Question);
    }
    if ws.checks_failed {
        return Some(Reason::ChecksFailed);
    }
    if !ws.sync_conflicts.is_empty() {
        return Some(Reason::NeedsSync);
    }
    if open.is_some_and(|p| p.checks.failed > 0) {
        return Some(Reason::Checks);
    }
    if open.is_some_and(|p| p.review_decision == "CHANGES_REQUESTED") {
        return Some(Reason::Changes);
    }
    if unseen && summary.last_turn_seq > ws.seen_seq {
        return Some(Reason::Done);
    }
    if is_stale(ws, limits, now) {
        return Some(Reason::Stale);
    }
    None
}

pub fn label(r: Reason) -> &'static str {
    match r {
        Reason::Error => "Failed",
        Reason::Question => "Asked you",
        Reason::ChecksFailed => "Checks failed",
        Reason::NeedsSync => "Needs sync",
        Reason::Checks => "Checks failing",
        Reason::Changes => "Changes requested",
        Reason::Done => "Finished",
        Reason::Stale => "Stale branch",
    }
}

pub fn group(ws: &Workspace, reason: Option<Reason>) -> Group {
    if reason.is_some() {
        Group::NeedsYou
    } else if ws.status == Status::Running {
        Group::Running
    } else {
        Group::Done
    }
}

/// Dot colour (visual.md §3.5).
pub fn tone(ws: &Workspace, reason: Option<Reason>, pr: Option<&PrStatus>) -> Tone {
    match reason {
        Some(Reason::Error | Reason::ChecksFailed | Reason::Checks) => Tone::Bad,
        Some(Reason::Question) => Tone::Info,
        Some(Reason::NeedsSync | Reason::Changes | Reason::Stale) => Tone::Warn,
        Some(Reason::Done) => Tone::Ok,
        None if ws.status == Status::Running => Tone::Run,
        None if pr.is_some_and(|p| p.state == "MERGED") => Tone::Merged,
        None => Tone::Mute,
    }
}

/// The detail after the reason label (behaviour.md §2.3).
pub fn detail(
    r: Reason,
    ws: &Workspace,
    s: Option<&Summary>,
    pr: Option<&PrStatus>,
    limits: &HelloSettings,
    now: i64,
) -> String {
    let assistant = s.and_then(|s| s.last_assistant_text.as_deref()).unwrap_or("");
    match r {
        Reason::Error => first_line(s.and_then(|s| s.last_turn_error.as_deref()).unwrap_or("")).to_string(),
        Reason::Question => {
            let lines: Vec<&str> = assistant.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
            lines.iter().rev().find(|l| l.ends_with('?')).or(lines.last()).map(|l| l.to_string()).unwrap_or_default()
        }
        Reason::ChecksFailed => ws.checks_command.clone().unwrap_or_default(),
        Reason::NeedsSync => {
            let n = ws.sync_conflicts.len();
            format!("conflicts in {n} file{}", if n == 1 { "" } else { "s" })
        }
        Reason::Checks => pr
            .map(|p| {
                let total = p.checks.passed + p.checks.failed + p.checks.pending;
                format!("{} of {total} checks failing", p.checks.failed)
            })
            .unwrap_or_default(),
        Reason::Changes => pr.map(|p| format!("changes requested on #{}", p.number)).unwrap_or_default(),
        Reason::Done => first_line(assistant).to_string(),
        Reason::Stale => {
            let days = (now - ws.created_at) / DAY_MS;
            if limits.stale_days > 0 && days >= limits.stale_days as i64 {
                format!("open {days} days")
            } else {
                format!("{} behind", ws.behind)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Suggestion {
    Text { label: String, text: String },
    Skill { label: String, skill_id: String },
    Ship { label: String, anyway: bool },
}

impl Suggestion {
    pub fn label(&self) -> &str {
        match self {
            Suggestion::Text { label, .. } | Suggestion::Skill { label, .. } | Suggestion::Ship { label, .. } => label,
        }
    }
}

pub fn fix_checks_prompt(ws: &Workspace) -> String {
    let cmd = ws.checks_command.as_deref().unwrap_or("the check command");
    format!(
        "The check command `{cmd}` failed in this workspace. Fix the failures and re-run it until it passes, \
         then tell me it is ready to ship.\n\nLast output:\n```\n{}\n```",
        ws.checks_output.as_deref().unwrap_or("")
    )
}

pub fn resolve_conflicts_prompt(ws: &Workspace, base: &str) -> String {
    format!(
        "Your branch is behind origin/{base} and Orbit's automatic rebase hit conflicts in: {}.\n\
         Run `git fetch origin {base}` and `git rebase origin/{base}`. Resolve each conflict keeping the intent of both sides, \
         `git add` the files and `git rebase --continue` until it finishes. Then run the project's checks and fix anything the merge broke. \
         Don't push; just tell me when it is done.",
        ws.sync_conflicts.join(", ")
    )
}

/// `ruleSuggestions`, with v1's filter (no sync / simplify / handoff; changed files unknown → 0).
pub fn rule_suggestions(r: Reason, ws: &Workspace, has_pr: bool, base: &str) -> Vec<Suggestion> {
    let text = |l: &str| Suggestion::Text { label: l.into(), text: l.into() };
    let ship = |l: &str, anyway: bool| Suggestion::Ship { label: l.into(), anyway };
    match r {
        Reason::ChecksFailed => {
            vec![
                Suggestion::Text { label: "Fix checks".into(), text: fix_checks_prompt(ws) },
                ship("Ship anyway", true),
            ]
        }
        Reason::NeedsSync => {
            vec![Suggestion::Text { label: "Resolve conflicts".into(), text: resolve_conflicts_prompt(ws, base) }]
        }
        Reason::Stale => vec![text("Keep going")],
        Reason::Error => vec![text("Try that again"), text("Explain what went wrong and propose a fix")],
        Reason::Question => vec![text("Yes, go ahead"), text("No, stop here and summarize")],
        Reason::Checks => vec![
            Suggestion::Skill { label: "Fix CI".into(), skill_id: "shipkit:fix-ci".into() },
            text("Explain why CI is failing"),
        ],
        Reason::Changes => {
            vec![Suggestion::Skill { label: "Address comments".into(), skill_id: "shipkit:address-comments".into() }]
        }
        Reason::Done => {
            let mut out = Vec::new();
            if has_pr {
                out.push(ship("Push updates", false));
            }
            out.push(text("Keep going"));
            out.push(text("Summarize what changed"));
            out.truncate(3);
            out
        }
    }
}

/// "now", "5m", "3h", "2d".
pub fn time_ago(ts: i64, now: i64) -> String {
    let s = (now - ts).max(0) / 1000;
    if s < 60 {
        "now".into()
    } else if s < 3600 {
        format!("{}m", s / 60)
    } else if s < 86_400 {
        format!("{}h", s / 3600)
    } else {
        format!("{}d", s / 86_400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn ws() -> Workspace {
        Workspace { id: "w".into(), name: "w".into(), seen_seq: 5, created_at: NOW - 1000, ..Default::default() }
    }
    fn sum(last_seq: i64, turn: i64) -> Summary {
        Summary { workspace_id: "w".into(), last_seq, last_turn_seq: turn, ..Default::default() }
    }
    fn reason(w: &Workspace, s: &Summary, pr: Option<&PrStatus>) -> Option<Reason> {
        attention_reason(w, Some(s), pr, &HelloSettings::default(), NOW)
    }
    fn pr(failed: u32, decision: &str) -> PrStatus {
        PrStatus {
            number: 7,
            state: "OPEN".into(),
            review_decision: decision.into(),
            checks: orbit_proto::PrChecks { passed: 2, failed, pending: 0, failing: vec![] },
            ..Default::default()
        }
    }

    #[test]
    fn each_reason() {
        let w = ws();
        assert_eq!(reason(&w, &sum(5, 5), None), None, "seen");
        assert_eq!(reason(&w, &sum(9, 9), None), Some(Reason::Done));
        let mut s = sum(9, 9);
        s.last_turn_error = Some("boom".into());
        assert_eq!(reason(&w, &s, None), Some(Reason::Error));
        s.last_turn_interrupted = true;
        assert_eq!(reason(&w, &s, None), Some(Reason::Done), "an interrupt isn't a failure");
        let mut s = sum(9, 9);
        s.last_assistant_text = Some("Done.\nKeep the old headline as a subtitle?".into());
        assert_eq!(reason(&w, &s, None), Some(Reason::Question));
        let mut c = ws();
        c.checks_failed = true;
        assert_eq!(reason(&c, &sum(5, 5), None), Some(Reason::ChecksFailed));
        let mut c = ws();
        c.sync_conflicts = vec!["a".into()];
        assert_eq!(reason(&c, &sum(5, 5), None), Some(Reason::NeedsSync));
        assert_eq!(reason(&w, &sum(5, 5), Some(&pr(1, ""))), Some(Reason::Checks));
        assert_eq!(reason(&w, &sum(5, 5), Some(&pr(0, "CHANGES_REQUESTED"))), Some(Reason::Changes));
        let mut old = ws();
        old.created_at = NOW - 8 * DAY_MS;
        assert_eq!(reason(&old, &sum(5, 5), None), Some(Reason::Stale));
    }

    #[test]
    fn gates_and_priority() {
        let mut w = ws();
        w.checks_failed = true;
        let mut s = sum(9, 9);
        s.last_turn_error = Some("x".into());
        assert_eq!(reason(&w, &s, None), Some(Reason::Error), "error beats checks");
        w.status = Status::Running;
        assert_eq!(reason(&w, &s, None), None, "running never needs you");
        w.status = Status::Idle;
        w.snoozed_until = NOW + 1;
        assert_eq!(reason(&w, &s, None), None, "snoozed");
        w.snoozed_until = 0;
        w.dismissed_seq = 9;
        assert_eq!(reason(&w, &s, None), None, "dismissed");
        assert_eq!(attention_reason(&ws(), None, None, &HelloSettings::default(), NOW), None);
    }

    #[test]
    fn questions() {
        assert!(asks_question(Some("Should I?")));
        assert!(asks_question(Some("Want me to ship it? I can also wait.")));
        assert!(!asks_question(Some("Use `a ? b : c` here.")));
        assert!(!asks_question(Some("See https://x.io/?q=1")));
        assert!(!asks_question(None));
    }

    #[test]
    fn details_and_suggestions() {
        let mut w = ws();
        w.sync_conflicts = vec!["a".into(), "b".into()];
        let st = HelloSettings::default();
        assert_eq!(detail(Reason::NeedsSync, &w, None, None, &st, NOW), "conflicts in 2 files");
        assert_eq!(detail(Reason::Checks, &w, None, Some(&pr(1, "")), &st, NOW), "1 of 3 checks failing");
        let mut s = sum(9, 9);
        s.last_assistant_text = Some("All set.\nShip it?\nOr not.".into());
        assert_eq!(detail(Reason::Question, &w, Some(&s), None, &st, NOW), "Ship it?");
        let sug = rule_suggestions(Reason::Done, &w, true, "main");
        assert_eq!(
            sug.iter().map(|s| s.label()).collect::<Vec<_>>(),
            vec!["Push updates", "Keep going", "Summarize what changed"]
        );
        assert!(rule_suggestions(Reason::NeedsSync, &w, false, "main")[0].label() == "Resolve conflicts");
        assert_eq!(time_ago(NOW - 3 * 60_000, NOW), "3m");
        assert_eq!(time_ago(NOW, NOW), "now");
    }
}
