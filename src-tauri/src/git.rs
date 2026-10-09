use anyhow::{anyhow, Context};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn run(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    exec("git", cwd, args)
}

/// Runs a CLI without a console window; errors carry its stderr.
pub fn exec(program: &str, cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().with_context(|| format!("{program} {}", args.join(" ")))?;
    if !out.status.success() {
        return Err(anyhow!(
            "{program} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

pub fn toplevel(path: &Path) -> anyhow::Result<PathBuf> {
    Ok(PathBuf::from(run(path, &["rev-parse", "--show-toplevel"])?))
}

/// `origin/HEAD` if known, else `main`/`master` if present, else the current branch.
pub fn default_branch(repo: &Path) -> String {
    if let Ok(r) = run(repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        return r.trim_start_matches("origin/").to_string();
    }
    for b in ["main", "master"] {
        if run(repo, &["rev-parse", "--verify", "--quiet", b]).is_ok() {
            return b.to_string();
        }
    }
    run(repo, &["branch", "--show-current"]).unwrap_or_else(|_| "main".into())
}

/// Lowercase, dash-separated, max 40 chars: "Fix Onboarding Crash!" -> "fix-onboarding-crash".
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(40).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "task".into() } else { out }
}

pub fn create_worktree(repo: &Path, path: &Path, branch: &str, base: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Prefer the freshest base; fall back to the local branch when offline / no remote.
    let _ = run(repo, &["fetch", "origin", base, "--quiet"]);
    let origin_base = format!("origin/{base}");
    let start = if run(repo, &["rev-parse", "--verify", "--quiet", &origin_base]).is_ok() {
        origin_base
    } else {
        base.to_string()
    };
    let p = path.to_string_lossy();
    run(repo, &["worktree", "add", "-b", branch, &p, &start])?;
    Ok(())
}

pub fn remove_worktree(repo: &Path, path: &Path) -> anyhow::Result<()> {
    run(repo, &["worktree", "remove", "--force", &path.to_string_lossy()])?;
    Ok(())
}

/// Re-attaches an existing branch as a worktree at `path` (used when restoring an archived workspace).
pub fn add_existing_worktree(repo: &Path, path: &Path, branch: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Drop records of worktrees whose folders were deleted by hand, or git refuses the branch as "in use".
    let _ = run(repo, &["worktree", "prune"]);
    run(repo, &["worktree", "add", &path.to_string_lossy(), branch])?;
    Ok(())
}

pub fn branch_exists(repo: &Path, branch: &str) -> bool {
    run(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

/// Local branches fully merged into `origin/<base>` (after a fetch), else into local `<base>`.
pub fn merged_branches(repo: &Path, base: &str) -> Vec<String> {
    let _ = run(repo, &["fetch", "origin", base, "--quiet"]);
    let origin_base = format!("origin/{base}");
    let target = if run(repo, &["rev-parse", "--verify", "--quiet", &origin_base]).is_ok() { origin_base } else { base.to_string() };
    run(repo, &["branch", "--merged", &target, "--format=%(refname:short)"])
        .map(|o| o.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// True if the branch ever moved past its creation (a fresh branch is trivially "merged" into its base).
pub fn branch_has_own_commits(repo: &Path, branch: &str) -> bool {
    run(repo, &["reflog", "show", "--format=%gs", &format!("refs/heads/{branch}")])
        .map(|o| o.lines().filter(|l| !l.trim().is_empty()).count() > 1)
        .unwrap_or(false)
}

/// True when the worktree has no uncommitted or untracked changes.
pub fn is_clean(worktree: &Path) -> bool {
    run(worktree, &["status", "--porcelain"]).map(|s| s.is_empty()).unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    pub untracked: bool,
}

/// Everything this workspace changed relative to where it branched from base:
/// committed + uncommitted tracked changes, plus untracked files.
pub fn changes(worktree: &Path, base: &str) -> anyhow::Result<Vec<FileChange>> {
    let origin_base = format!("origin/{base}");
    let merge_base = run(worktree, &["merge-base", "HEAD", &origin_base])
        .or_else(|_| run(worktree, &["merge-base", "HEAD", base]))
        .unwrap_or_else(|_| "HEAD".into());

    let mut out: Vec<FileChange> = run(worktree, &["diff", "--numstat", &merge_base])?
        .lines()
        .filter_map(parse_numstat)
        .collect();
    for path in run(worktree, &["ls-files", "--others", "--exclude-standard"])?.lines() {
        let additions = std::fs::read_to_string(worktree.join(path))
            .map(|s| s.lines().count() as u32)
            .unwrap_or(0);
        out.push(FileChange { path: path.to_string(), additions, deletions: 0, untracked: true });
    }
    Ok(out)
}

fn parse_numstat(line: &str) -> Option<FileChange> {
    let mut parts = line.splitn(3, '\t');
    let add = parts.next()?;
    let del = parts.next()?;
    let path = parts.next()?;
    Some(FileChange {
        path: path.to_string(),
        // Binary files report "-".
        additions: add.parse().unwrap_or(0),
        deletions: del.parse().unwrap_or(0),
        untracked: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_cases() {
        assert_eq!(slugify("Fix Onboarding Crash!"), "fix-onboarding-crash");
        assert_eq!(slugify("  --  "), "task");
        assert_eq!(slugify("a/b_c"), "a-b-c");
    }

    #[test]
    fn numstat() {
        let c = parse_numstat("12\t3\tsrc/main.rs").unwrap();
        assert_eq!((c.additions, c.deletions, c.path.as_str()), (12, 3, "src/main.rs"));
        assert_eq!(parse_numstat("-\t-\timg.png").unwrap().additions, 0);
    }
}
