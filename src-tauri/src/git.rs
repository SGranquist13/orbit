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

/// Where an attached folder sits in its repository, for making it editable: `(repo toplevel, path of
/// the folder relative to it)` (empty for the root). A folder merely *inside* some parent repo is
/// only accepted when that repo actually tracks it (it has tracked files and is not git-ignored):
/// otherwise a worktree of the parent would contain none of it (e.g. a scratch dir under a repo's
/// ignored `.e2e/`). A tracked subfolder (monorepo package) is fine; its worktree is the whole repo.
pub fn editable_location(folder: &Path) -> Result<(PathBuf, PathBuf), String> {
    let top = toplevel(folder).map_err(|_| "Only git repositories can be made editable".to_string())?;
    let (cf, ct) = (crate::related::canonical(folder), crate::related::canonical(&top));
    let rel = match cf.strip_prefix(&ct) {
        Ok(r) => r.to_path_buf(),
        Err(_) => {
            // Windows drive-letter case or 8.3 differences: compare case-insensitively as strings.
            let (a, b) = (cf.to_string_lossy().to_lowercase(), ct.to_string_lossy().to_lowercase());
            match a.strip_prefix(&b) {
                Some(r) => PathBuf::from(r.trim_start_matches(['/', '\\'])),
                None => return Err("Only git repositories can be made editable".into()),
            }
        }
    };
    if rel.as_os_str().is_empty() {
        return Ok((top, rel));
    }
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let not_repo = || {
        format!(
            "Only git repositories can be made editable: this folder is inside {} but is not tracked by it (ignored or untracked); attach the repository itself",
            top.display()
        )
    };
    // `check-ignore -q` exits 0 when ignored, 1 when not; any other failure leaves us to ls-files.
    if run(&top, &["check-ignore", "-q", "--", &rel_str]).is_ok() {
        return Err(not_repo());
    }
    match run(&top, &["ls-files", "--", &rel_str]) {
        Ok(s) if !s.is_empty() => Ok((top, rel)),
        _ => Err(not_repo()),
    }
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

/// Commits reachable from HEAD but not from `base_ref`: the work this branch added. None when git can't say.
pub fn commits_ahead(worktree: &Path, base_ref: &str) -> Option<u32> {
    run(worktree, &["rev-list", "--count", &format!("{base_ref}..HEAD")]).ok()?.trim().parse().ok()
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

/// Every line of `git diff --numstat --no-renames` output as a (tracked) file change.
pub fn parse_numstat_lines(out: &str) -> Vec<FileChange> {
    out.lines().filter_map(parse_numstat).collect()
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

    fn tmp_repo(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orbit-git-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        run(&d, &["init", "-q", "-b", "main"]).unwrap();
        d
    }

    fn commit_all(d: &Path) {
        run(d, &["add", "-A"]).unwrap();
        run(d, &["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", "init"]).unwrap();
    }

    #[test]
    fn editable_location_root_tracked_subfolder_and_ignored_subfolder() {
        let d = tmp_repo("editable");
        std::fs::create_dir_all(d.join("packages/app")).unwrap();
        std::fs::write(d.join("packages/app/index.js"), "x").unwrap();
        std::fs::write(d.join(".gitignore"), ".scratch/\n").unwrap();
        std::fs::create_dir_all(d.join(".scratch/consumer")).unwrap();
        std::fs::write(d.join(".scratch/consumer/a.txt"), "x").unwrap();
        std::fs::create_dir_all(d.join("newdir")).unwrap();
        std::fs::write(d.join("newdir/b.txt"), "x").unwrap();
        commit_all(&d);
        std::fs::create_dir_all(d.join("untracked")).unwrap();
        std::fs::write(d.join("untracked/c.txt"), "x").unwrap();

        // The repository root.
        let (top, rel) = editable_location(&d).unwrap();
        assert!(rel.as_os_str().is_empty());
        assert_eq!(crate::related::canonical(&top), crate::related::canonical(&d));
        // A tracked monorepo package: allowed, with its relative path.
        let (_, rel) = editable_location(&d.join("packages").join("app")).unwrap();
        assert_eq!(rel.to_string_lossy().replace('\\', "/"), "packages/app");
        // Git-ignored and untracked folders inside the repo are not git repositories of their own.
        for bad in [".scratch/consumer", "untracked"] {
            let e = editable_location(&d.join(bad)).unwrap_err();
            assert!(e.contains("Only git repositories"), "{bad}: {e}");
        }
        // A folder outside any repo.
        let plain = std::env::temp_dir().join(format!("orbit-git-plain-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&plain).unwrap();
        assert!(editable_location(&plain).unwrap_err().contains("Only git repositories"));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&plain);
    }

    #[test]
    fn commits_ahead_ignores_reflog_noise() {
        let d = tmp_repo("ahead");
        std::fs::write(d.join("a.txt"), "1").unwrap();
        commit_all(&d);
        run(&d, &["checkout", "-q", "-b", "work"]).unwrap();
        assert_eq!(commits_ahead(&d, "main"), Some(0));
        // A commit that is then thrown away leaves reflog entries but no work.
        std::fs::write(d.join("b.txt"), "2").unwrap();
        run(&d, &["add", "-A"]).unwrap();
        run(&d, &["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", "tmp"]).unwrap();
        run(&d, &["reset", "-q", "--hard", "HEAD~1"]).unwrap();
        assert!(branch_has_own_commits(&d, "work"), "the reflog does see the noise");
        assert_eq!(commits_ahead(&d, "main"), Some(0), "but the branch added nothing");
        std::fs::write(d.join("c.txt"), "3").unwrap();
        run(&d, &["add", "-A"]).unwrap();
        run(&d, &["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", "real"]).unwrap();
        assert_eq!(commits_ahead(&d, "main"), Some(1));
        assert_eq!(commits_ahead(&d, "no-such-ref"), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn numstat() {
        let c = parse_numstat("12\t3\tsrc/main.rs").unwrap();
        assert_eq!((c.additions, c.deletions, c.path.as_str()), (12, 3, "src/main.rs"));
        assert_eq!(parse_numstat("-\t-\timg.png").unwrap().additions, 0);
    }
}
