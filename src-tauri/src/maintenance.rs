//! Environment diagnostics and data housekeeping for the Settings page.

use crate::agent::process;
use crate::db::{Repo, Workspace};
use crate::{gh, git};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    pub ok: bool,
    /// Why no verified binary was found (e.g. the first `claude` on PATH is not Claude Code).
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    pub user: Option<String>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub claude: ClaudeInfo,
    pub codex: CodexInfo,
    pub gh: GhInfo,
    pub git: GitInfo,
    pub orbit_home: String,
    pub db_size_bytes: u64,
    pub worktree_count: u32,
}

/// Runs `bin args` with a short timeout and the host-agent env scrubbed. Returns (success, stdout+stderr).
async fn probe(bin: &str, args: &[&str], cwd: &Path) -> Option<(bool, String)> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let mut cmd = process::command(bin, &args, cwd).ok()?;
    cmd.stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(8), cmd.output()).await.ok()?.ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), text))
}

/// The verified path (agent CLIs are checked by `--version`, see `process::resolve`) or why there is none.
fn path_of(bin: &str) -> (Option<String>, Option<String>) {
    match process::resolve(bin) {
        Ok(p) => (Some(p.display().to_string()), None),
        Err(e) => (None, Some(e.to_string())),
    }
}

/// First `x.y.z` looking token in the text.
pub fn parse_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == ',' || c == '(' || c == ')')
        .map(|t| t.trim_start_matches('v'))
        .find(|t| t.contains('.') && t.chars().next().is_some_and(|c| c.is_ascii_digit()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .map(str::to_string)
}

/// Scopes from `gh auth status`: `- Token scopes: 'repo', 'read:org'` (quotes absent in some versions).
pub fn parse_scopes(text: &str) -> Vec<String> {
    text.lines()
        .find_map(|l| l.split_once("Token scopes:").map(|(_, rest)| rest))
        .map(|rest| {
            rest.split(',')
                .map(|s| s.trim().trim_matches(|c| c == '\'' || c == '"').to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub async fn environment_info(home: &Path) -> EnvironmentInfo {
    let (claude_v, codex_v, codex_login, gh_v, gh_user, gh_status, git_v) = tokio::join!(
        probe("claude", &["--version"], home),
        probe("codex", &["--version"], home),
        probe("codex", &["login", "status"], home),
        probe("gh", &["--version"], home),
        probe("gh", &["api", "user", "--jq", ".login"], home),
        probe("gh", &["auth", "status"], home),
        probe("git", &["--version"], home),
    );
    let ver = |p: &Option<(bool, String)>| p.as_ref().filter(|(ok, _)| *ok).and_then(|(_, t)| parse_version(t));
    let (claude_path, claude_error) = path_of("claude");
    let (codex_path, codex_error) = path_of("codex");
    EnvironmentInfo {
        claude: ClaudeInfo { path: claude_path, version: ver(&claude_v), ok: claude_v.as_ref().is_some_and(|(ok, _)| *ok), error: claude_error },
        codex: CodexInfo {
            path: codex_path,
            error: codex_error,
            version: ver(&codex_v),
            logged_in: codex_login.as_ref().is_some_and(|(ok, t)| *ok && t.to_lowercase().contains("logged in")),
        },
        gh: GhInfo {
            path: path_of("gh").0,
            version: ver(&gh_v),
            user: gh_user
                .filter(|(ok, _)| *ok)
                .map(|(_, t)| t.lines().next().unwrap_or_default().trim().to_string())
                .filter(|u| !u.is_empty()),
            scopes: gh_status.map(|(_, t)| parse_scopes(&t)).unwrap_or_default(),
        },
        git: GitInfo { path: path_of("git").0, version: ver(&git_v) },
        orbit_home: home.display().to_string(),
        db_size_bytes: std::fs::metadata(home.join("state.db")).map(|m| m.len()).unwrap_or(0),
        worktree_count: count_worktrees(&home.join("worktrees")),
    }
}

/// `worktrees/<repo>/<slug>` directories.
fn count_worktrees(root: &Path) -> u32 {
    let dirs = |p: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(p)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default()
    };
    dirs(root).iter().map(|repo| dirs(repo).len() as u32).sum()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCandidate {
    pub workspace_id: String,
    pub name: String,
    pub branch: String,
    pub reason: String,
}

/// Workspaces whose branch has landed in the base branch (git says merged, or the PR is MERGED)
/// and whose worktree still exists and is clean. Blocking: runs git/gh.
pub fn find_cleanup_candidates(workspaces: &[Workspace], repos: &[Repo]) -> Vec<CleanupCandidate> {
    let mut out = vec![];
    for repo in repos {
        let repo_path = Path::new(&repo.path);
        let mine: Vec<&Workspace> = workspaces
            .iter()
            .filter(|w| w.repo_id == repo.id && w.status != "running" && Path::new(&w.path).is_dir())
            .collect();
        if mine.is_empty() {
            continue;
        }
        let merged = git::merged_branches(repo_path, &repo.base_branch);
        for w in mine {
            if !git::is_clean(Path::new(&w.path)) {
                continue;
            }
            let reason = if merged.contains(&w.branch) && git::branch_has_own_commits(repo_path, &w.branch) {
                Some(format!("Merged into {}", repo.base_branch))
            } else {
                match gh::pr_status(repo_path, &w.branch) {
                    Ok(Some(pr)) if pr.state == "MERGED" => Some(format!("PR #{} merged", pr.number)),
                    _ => None,
                }
            };
            if let Some(reason) = reason {
                out.push(CleanupCandidate { workspace_id: w.id.clone(), name: w.name.clone(), branch: w.branch.clone(), reason });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_from_cli_banners() {
        assert_eq!(parse_version("2.1.4 (Claude Code)").as_deref(), Some("2.1.4"));
        assert_eq!(parse_version("codex-cli 0.46.0").as_deref(), Some("0.46.0"));
        assert_eq!(parse_version("gh version 2.62.0 (2024-11-06)\nhttps://github.com/cli/cli/releases/tag/v2.62.0").as_deref(), Some("2.62.0"));
        assert_eq!(parse_version("git version 2.47.1.windows.1").as_deref(), Some("2.47.1.windows.1"));
        assert_eq!(parse_version("nothing here"), None);
    }

    #[test]
    fn scopes_parse() {
        let t = "github.com\n  ✓ Logged in to github.com account ada (keyring)\n  - Token scopes: 'gist', 'read:org', 'repo'\n";
        assert_eq!(parse_scopes(t), ["gist", "read:org", "repo"]);
        assert!(parse_scopes("You are not logged in").is_empty());
    }
}
