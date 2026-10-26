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

/// Exact GitHub head, used to ensure local review anchors match the published commit.
pub fn review_target(worktree: &Path, branch: &str) -> anyhow::Result<(u64, String)> {
    let out = gh(worktree, &["pr", "view", branch, "--json", "number,headRefOid,state"])?;
    let v: Value = serde_json::from_str(&out)?;
    anyhow::ensure!(v["state"] == "OPEN", "Review requires an open pull request");
    let number = v["number"].as_u64().ok_or_else(|| anyhow::anyhow!("PR has no number"))?;
    let head = v["headRefOid"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| anyhow::anyhow!("PR has no head SHA"))?;
    Ok((number, head.to_string()))
}

pub fn review_payload(review: &crate::review::Review) -> Value {
    serde_json::json!({
        "commit_id": review.head_sha,
        "event": "COMMENT",
        "body": review.summary,
        "comments": review.findings.iter().map(|f| serde_json::json!({
            "path": f.path, "line": f.line, "side": "RIGHT",
            "body": format!("**{}: {}**\n\n{}", f.severity, f.title, f.body)
        })).collect::<Vec<_>>()
    })
}

pub fn post_review(worktree: &Path, review: &crate::review::Review) -> anyhow::Result<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let (number, head) = review_target(worktree, &review.pr_number.to_string())?;
    anyhow::ensure!(number == review.pr_number && head == review.head_sha, "The PR head changed; run a new review before posting");
    let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{number}/reviews");
    let mut cmd = Command::new("gh");
    cmd.args(["api", "--method", "POST", &endpoint, "--input", "-"]).current_dir(worktree)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    let mut child = crate::agent::process::spawn_std(&mut cmd)?;
    let payload = serde_json::to_vec(&review_payload(review))?;
    let written = child.stdin.take().ok_or_else(|| anyhow::anyhow!("gh stdin unavailable"))?.write_all(&payload);
    let out = child.wait_with_output()?;
    written?;
    anyhow::ensure!(out.status.success(), "GitHub review failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    Ok(())
}

/// Arguments for `gh pr merge`. The local branch is held by a worktree, so `--delete-branch` is
/// never used; the remote ref is deleted separately (see `merge`).
fn merge_args(number: u64, method: &str) -> anyhow::Result<Vec<String>> {
    let flag = match method {
        "squash" | "merge" | "rebase" => format!("--{method}"),
        other => anyhow::bail!("unknown merge method {other}"),
    };
    Ok(vec!["pr".into(), "merge".into(), number.to_string(), flag])
}

/// Merges the PR with `method`; optionally deletes the remote branch afterwards (best effort:
/// the repo may already auto-delete head branches).
pub fn merge(worktree: &Path, number: u64, method: &str, delete_remote_branch: Option<&str>) -> anyhow::Result<()> {
    let args = merge_args(number, method)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    gh(worktree, &args)?;
    if let Some(branch) = delete_remote_branch {
        let endpoint = format!("repos/{{owner}}/{{repo}}/git/refs/heads/{branch}");
        let _ = gh(worktree, &["api", "-X", "DELETE", &endpoint]);
    }
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
pub(crate) fn summarize_checks(rollup: &Value) -> Checks {
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub labels: Vec<String>,
    pub author: String,
    pub updated_at: String,
    pub comments: u32,
}

const ISSUE_FIELDS: &str = "number,title,url,state,labels,author,updatedAt,comments";

/// Open issues of the repo at `repo_path`. Errors starting with "No GitHub remote" mean
/// the repo isn't on GitHub (or `gh` can't tell which repo it is).
pub fn list_issues(repo_path: &Path) -> anyhow::Result<Vec<Issue>> {
    match gh(repo_path, &["issue", "list", "--state", "open", "--limit", "100", "--json", ISSUE_FIELDS]) {
        Ok(out) => parse_issues(&out),
        Err(e) => {
            let lower = e.to_string().to_lowercase();
            if lower.contains("no git remotes") || lower.contains("none of the git remotes") || lower.contains("not a github") {
                anyhow::bail!("No GitHub remote found for this repo");
            }
            Err(e)
        }
    }
}

/// The URL of issue `number` in the repo at `cwd`.
pub fn issue_url(cwd: &Path, number: i64) -> anyhow::Result<String> {
    let out = gh(cwd, &["issue", "view", &number.to_string(), "--json", "url"])?;
    let v: Value = serde_json::from_str(&out)?;
    v["url"].as_str().map(str::to_string).ok_or_else(|| anyhow::anyhow!("gh returned no url for issue #{number}"))
}

fn parse_issues(json: &str) -> anyhow::Result<Vec<Issue>> {
    let v: Value = serde_json::from_str(json)?;
    Ok(v.as_array().into_iter().flatten().map(parse_issue).collect())
}

fn parse_issue(v: &Value) -> Issue {
    let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    Issue {
        number: v["number"].as_u64().unwrap_or_default(),
        title: s("title"),
        url: s("url"),
        state: s("state"),
        labels: v["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| l["name"].as_str().or(l.as_str()))
            .map(str::to_string)
            .collect(),
        // Deleted accounts come back as null or with an empty login.
        author: v["author"]["login"].as_str().filter(|a| !a.is_empty()).unwrap_or("ghost").to_string(),
        updated_at: s("updatedAt"),
        // `comments` is an array of comment objects (or a bare count in other output).
        comments: v["comments"].as_array().map(|a| a.len() as u32).or(v["comments"].as_u64().map(|n| n as u32)).unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn review_payload_anchors_comments_to_commit() {
        let review = crate::review::Review {
            workspace_id: "w".into(), pr_number: 7, head_sha: "abc123".into(), created_at: 0,
            summary: "One issue".into(), findings: vec![crate::review::Finding {
                path: "src/a.rs".into(), line: 12, severity: "bug".into(), title: "Missing guard".into(), body: "Fails on empty input".into(),
            }],
        };
        assert_eq!(review_payload(&review), json!({"commit_id":"abc123","event":"COMMENT","body":"One issue",
            "comments":[{"path":"src/a.rs","line":12,"side":"RIGHT","body":"**bug: Missing guard**\n\nFails on empty input"}]}));
        let mut empty = review;
        empty.findings.clear();
        assert_eq!(review_payload(&empty)["comments"], json!([]));
    }

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
    fn merge_args_per_method() {
        assert_eq!(merge_args(7, "squash").unwrap(), ["pr", "merge", "7", "--squash"]);
        assert_eq!(merge_args(7, "merge").unwrap()[3], "--merge");
        assert_eq!(merge_args(7, "rebase").unwrap()[3], "--rebase");
        assert!(merge_args(7, "ff").is_err());
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

    #[test]
    fn issues_parse() {
        let issues = parse_issues(
            r#"[
              {"number": 12, "title": "Crash on save", "url": "https://github.com/o/r/issues/12", "state": "OPEN",
               "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "p1"}],
               "author": {"login": "ada"}, "updatedAt": "2026-05-01T10:00:00Z",
               "comments": [{"body": "a"}, {"body": "b"}]},
              {"number": 7, "title": "Odd one", "url": "u", "state": "OPEN", "labels": [], "author": null,
               "updatedAt": "2026-04-01T00:00:00Z", "comments": []},
              {"number": 3}
            ]"#,
        )
        .unwrap();
        assert_eq!(issues.len(), 3);
        assert_eq!(issues[0].labels, ["bug", "p1"]);
        assert_eq!((issues[0].author.as_str(), issues[0].comments, issues[0].updated_at.as_str()), ("ada", 2, "2026-05-01T10:00:00Z"));
        assert_eq!((issues[1].author.as_str(), issues[1].comments), ("ghost", 0));
        assert_eq!((issues[2].number, issues[2].title.as_str(), issues[2].labels.len()), (3, "", 0));
        assert!(parse_issues("[]").unwrap().is_empty());
        assert!(parse_issues("not json").is_err());
    }
}
