//! GitHub via the `gh` CLI (uses the user's existing `gh auth`).

use serde::Serialize;
use serde_json::Value;
use std::path::Path;

fn gh(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    crate::git::exec("gh", cwd, args)
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checks {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
    pub failing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStatus {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// OPEN | CLOSED | MERGED
    pub state: String,
    pub is_draft: bool,
    /// MERGEABLE | CONFLICTING | UNKNOWN
    pub mergeable: String,
    /// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
    pub review_decision: String,
    pub checks: Checks,
}

const PR_FIELDS: &str = "number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup";

/// The PR for `branch`, or None if there isn't one.
pub fn pr_status(worktree: &Path, branch: &str) -> anyhow::Result<Option<PrStatus>> {
    match gh(worktree, &["pr", "view", branch, "--json", PR_FIELDS]) {
        Ok(out) => Ok(Some(parse_pr(&serde_json::from_str(&out)?))),
        Err(e) if e.to_string().contains("no pull requests found") => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn merge(worktree: &Path, number: u64) -> anyhow::Result<()> {
    gh(worktree, &["pr", "merge", &number.to_string(), "--squash"])?;
    Ok(())
}

pub fn mark_ready(worktree: &Path, number: u64) -> anyhow::Result<()> {
    gh(worktree, &["pr", "ready", &number.to_string()])?;
    Ok(())
}

fn parse_pr(v: &Value) -> PrStatus {
    let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    PrStatus {
        number: v["number"].as_u64().unwrap_or_default(),
        title: s("title"),
        url: s("url"),
        state: s("state"),
        is_draft: v["isDraft"].as_bool().unwrap_or(false),
        mergeable: s("mergeable"),
        review_decision: s("reviewDecision"),
        checks: summarize_checks(&v["statusCheckRollup"]),
    }
}

/// Rollup items are either CheckRuns (`status`/`conclusion`) or StatusContexts (`state`).
fn summarize_checks(rollup: &Value) -> Checks {
    let mut c = Checks::default();
    for item in rollup.as_array().into_iter().flatten() {
        let name = item["name"].as_str().or(item["context"].as_str()).unwrap_or("check").to_string();
        let verdict = match item["__typename"].as_str() {
            Some("StatusContext") => item["state"].as_str().unwrap_or_default(),
            _ if item["status"] != "COMPLETED" => "PENDING",
            _ => item["conclusion"].as_str().unwrap_or_default(),
        };
        match verdict {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => c.passed += 1,
            "PENDING" | "EXPECTED" | "QUEUED" | "IN_PROGRESS" | "" => c.pending += 1,
            _ => {
                c.failed += 1;
                c.failing.push(name);
            }
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rollup_mixed() {
        let c = summarize_checks(&json!([
            { "__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS" },
            { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE" },
            { "__typename": "CheckRun", "name": "e2e", "status": "IN_PROGRESS", "conclusion": "" },
            { "__typename": "StatusContext", "context": "vercel", "state": "ERROR" },
            { "__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SKIPPED" }
        ]));
        assert_eq!((c.passed, c.failed, c.pending), (2, 2, 1));
        assert_eq!(c.failing, ["test", "vercel"]);
    }

    #[test]
    fn pr_fields() {
        let pr = parse_pr(&json!({
            "number": 42, "title": "feat: x", "url": "https://github.com/o/r/pull/42", "state": "OPEN",
            "isDraft": true, "mergeable": "MERGEABLE", "reviewDecision": "", "statusCheckRollup": []
        }));
        assert_eq!(pr.number, 42);
        assert!(pr.is_draft);
        assert_eq!(pr.checks, Checks::default());
    }
}
