//! `review` for local clients (orb): the file list and commit list for one diff scope
//! (docs/tui/spec/behaviour.md §4.1). The client fetches both sides with `fileAt` and diffs itself.

use crate::code::fs::is_sha;
use crate::git::{self, FileChange};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

/// Git's empty tree: the old side of a root commit.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
pub const WORKTREE: &str = "worktree";
const MAX_COMMITS: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub enum Scope {
    Base,
    Turn,
    Commit(String),
}

impl Scope {
    pub fn parse(v: Option<&Value>) -> Result<Scope, String> {
        let v = v.ok_or("missing scope")?;
        match v.get("kind").and_then(Value::as_str) {
            Some("base") => Ok(Scope::Base),
            Some("turn") => Ok(Scope::Turn),
            Some("commit") => {
                let sha = v.get("sha").and_then(Value::as_str).ok_or("missing scope.sha")?;
                if !is_sha(sha) {
                    return Err("invalid sha".into());
                }
                Ok(Scope::Commit(sha.to_string()))
            }
            Some(other) => Err(format!("unknown scope kind {other}")),
            None => Err("missing scope.kind".into()),
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Scope::Base => json!({ "kind": "base" }),
            Scope::Turn => json!({ "kind": "turn" }),
            Scope::Commit(sha) => json!({ "kind": "commit", "sha": sha }),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    /// Committer time, ms since the epoch (like every other `ts` in the protocol).
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub scope: Value,
    pub old_ref: String,
    pub new_ref: String,
    pub files: Vec<FileChange>,
    pub commits: Vec<Commit>,
    pub turn_available: bool,
}

/// `turn_shas`: the `commitSha` of every `turnCompleted` that has one, oldest first.
pub fn review(wt: &Path, base_branch: &str, scope: &Scope, turn_shas: &[String], save_commits: bool) -> Result<Review, String> {
    let e = |e: anyhow::Error| format!("{e:#}");
    let turn_available = save_commits && !turn_shas.is_empty();
    let merge_base = git::run(wt, &["rev-parse", &git::changes_merge_base(wt, base_branch)]).map_err(e)?;
    let (old_ref, new_ref) = match scope {
        Scope::Base => (merge_base.clone(), WORKTREE.to_string()),
        Scope::Turn => {
            if !turn_available {
                return Err("No turn to review: save points are off or no turn has been committed yet".into());
            }
            let old = match turn_shas {
                [.., before, _last] => resolve(wt, before)?,
                [only] => parent(wt, only)?,
                [] => unreachable!(),
            };
            (old, WORKTREE.to_string())
        }
        Scope::Commit(sha) => {
            let full = resolve(wt, sha)?;
            (parent(wt, &full)?, full)
        }
    };
    let files = diff_files(wt, &old_ref, (new_ref != WORKTREE).then_some(new_ref.as_str())).map_err(e)?;
    let commits = commits(wt, &merge_base).map_err(e)?;
    Ok(Review { scope: scope.to_json(), old_ref, new_ref, files, commits, turn_available })
}

fn resolve(wt: &Path, rev: &str) -> Result<String, String> {
    git::run(wt, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).map_err(|_| format!("unknown commit {rev}"))
}

/// `<sha>^`, or the empty tree for a root commit.
fn parent(wt: &Path, sha: &str) -> Result<String, String> {
    let full = resolve(wt, sha)?;
    Ok(git::run(wt, &["rev-parse", "--verify", "--quiet", &format!("{full}^")]).unwrap_or_else(|_| EMPTY_TREE.to_string()))
}

/// `git diff --numstat old [new]`, plus untracked files when the new side is the worktree.
pub fn diff_files(wt: &Path, old: &str, new: Option<&str>) -> anyhow::Result<Vec<FileChange>> {
    let mut args = vec!["diff", "--numstat", "--no-renames", "-z", old];
    args.extend(new);
    let mut out = parse_numstat_z(&git::run_raw(wt, &args)?);
    if new.is_none() {
        for path in git::run_raw(wt, &["ls-files", "-z", "--others", "--exclude-standard"])?.split('\0').filter(|p| !p.is_empty()) {
            let additions = std::fs::read_to_string(wt.join(path)).map(|s| s.lines().count() as u32).unwrap_or(0);
            out.push(FileChange { path: path.to_string(), additions, deletions: 0, untracked: true });
        }
    }
    Ok(out)
}

/// `--numstat -z --no-renames`: `add\tdel\tpath\0` per file (binary files report `-`).
fn parse_numstat_z(out: &str) -> Vec<FileChange> {
    out.split('\0')
        .filter_map(|rec| {
            let mut parts = rec.splitn(3, '\t');
            let (add, del, path) = (parts.next()?, parts.next()?, parts.next()?);
            (!path.is_empty()).then(|| FileChange {
                path: path.to_string(),
                additions: add.parse().unwrap_or(0),
                deletions: del.parse().unwrap_or(0),
                untracked: false,
            })
        })
        .collect()
}

/// `merge_base..HEAD`, newest first, at most 50.
fn commits(wt: &Path, merge_base: &str) -> anyhow::Result<Vec<Commit>> {
    let range = format!("{merge_base}..HEAD");
    let out = git::run(wt, &["log", "--no-color", &format!("--max-count={MAX_COMMITS}"), "--format=%H%x1f%ct%x1f%s", &range])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, '\u{1f}');
            let (sha, ct, subject) = (p.next()?, p.next()?, p.next().unwrap_or(""));
            Some(Commit { sha: sha.to_string(), subject: subject.to_string(), ts: ct.parse::<i64>().ok()? * 1000 })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Repo(tempfile::TempDir);
    impl Repo {
        fn new() -> Repo {
            let r = Repo(tempfile::tempdir().unwrap());
            r.git(&["init", "-q", "-b", "main"]);
            r
        }
        fn path(&self) -> &Path {
            self.0.path()
        }
        fn git(&self, args: &[&str]) -> String {
            git::run(self.path(), args).unwrap()
        }
        fn write(&self, rel: &str, text: &str) {
            fs::write(self.path().join(rel), text).unwrap();
        }
        fn commit(&self, msg: &str) -> String {
            self.git(&["add", "-A"]);
            self.git(&["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", msg]);
            self.git(&["rev-parse", "HEAD"])
        }
    }

    fn paths(r: &Review) -> Vec<(String, u32, u32, bool)> {
        let mut v: Vec<_> = r.files.iter().map(|f| (f.path.clone(), f.additions, f.deletions, f.untracked)).collect();
        v.sort();
        v
    }

    fn fx(path: &str, a: u32, d: u32, u: bool) -> (String, u32, u32, bool) {
        (path.to_string(), a, d, u)
    }

    #[test]
    fn parses_scopes() {
        assert_eq!(Scope::parse(Some(&json!({ "kind": "base" }))), Ok(Scope::Base));
        assert_eq!(Scope::parse(Some(&json!({ "kind": "turn" }))), Ok(Scope::Turn));
        assert_eq!(Scope::parse(Some(&json!({ "kind": "commit", "sha": "abcdef1" }))), Ok(Scope::Commit("abcdef1".into())));
        assert_eq!(Scope::parse(None).unwrap_err(), "missing scope");
        assert_eq!(Scope::parse(Some(&json!({}))).unwrap_err(), "missing scope.kind");
        assert_eq!(Scope::parse(Some(&json!({ "kind": "x" }))).unwrap_err(), "unknown scope kind x");
        assert_eq!(Scope::parse(Some(&json!({ "kind": "commit" }))).unwrap_err(), "missing scope.sha");
        assert_eq!(Scope::parse(Some(&json!({ "kind": "commit", "sha": "HEAD~1" }))).unwrap_err(), "invalid sha");
    }

    #[test]
    fn scopes_against_a_real_repo() {
        let r = Repo::new();
        r.write("keep.txt", "a\nb\n");
        r.write("gone.txt", "x\n");
        let base = r.commit("base");
        r.git(&["checkout", "-qb", "feature"]);
        r.write("keep.txt", "a\nB\nc\n");
        let t1 = r.commit("turn one");
        fs::remove_file(r.path().join("gone.txt")).unwrap();
        r.write("new.txt", "n\n");
        let t2 = r.commit("turn two");
        // Uncommitted + untracked on top.
        r.write("keep.txt", "a\nB\nc\nd\n");
        r.write("untracked.txt", "u1\nu2\n");

        // Base: merge base (no origin, so local `main`) → worktree, incl. deleted and untracked.
        let rv = review(r.path(), "main", &Scope::Base, &[], true).unwrap();
        assert_eq!(rv.old_ref, base);
        assert_eq!(rv.new_ref, "worktree");
        assert_eq!(rv.scope, json!({ "kind": "base" }));
        assert!(!rv.turn_available);
        assert_eq!(
            paths(&rv),
            vec![fx("gone.txt", 0, 1, false), fx("keep.txt", 3, 1, false), fx("new.txt", 1, 0, false), fx("untracked.txt", 2, 0, true)]
        );
        let subjects: Vec<_> = rv.commits.iter().map(|c| (c.sha.as_str(), c.subject.as_str())).collect();
        assert_eq!(subjects, vec![(t2.as_str(), "turn two"), (t1.as_str(), "turn one")]);
        assert!(rv.commits[0].ts > 1_000_000_000_000);

        // Turn with no turn commits, or with save points off: unavailable.
        assert!(review(r.path(), "main", &Scope::Turn, &[], true).is_err());
        let off = review(r.path(), "main", &Scope::Turn, std::slice::from_ref(&t1), false);
        assert!(off.is_err());
        assert!(!review(r.path(), "main", &Scope::Base, std::slice::from_ref(&t1), false).unwrap().turn_available);

        // Turn: second-to-last turn commit → worktree.
        let rv = review(r.path(), "main", &Scope::Turn, &[t1.clone(), t2.clone()], true).unwrap();
        assert!(rv.turn_available);
        assert_eq!(rv.old_ref, t1);
        assert_eq!(paths(&rv), vec![fx("gone.txt", 0, 1, false), fx("keep.txt", 1, 0, false), fx("new.txt", 1, 0, false), fx("untracked.txt", 2, 0, true)]);
        // Only one turn commit: its parent.
        let rv = review(r.path(), "main", &Scope::Turn, std::slice::from_ref(&t2), true).unwrap();
        assert_eq!(rv.old_ref, t1);

        // Commit: <sha>^ → <sha>, no worktree changes or untracked files; short shas resolve.
        let rv = review(r.path(), "main", &Scope::Commit(t2[..8].to_string()), &[], true).unwrap();
        assert_eq!((rv.old_ref.as_str(), rv.new_ref.as_str()), (t1.as_str(), t2.as_str()));
        assert_eq!(paths(&rv), vec![fx("gone.txt", 0, 1, false), fx("new.txt", 1, 0, false)]);
        // Root commit: empty tree on the old side.
        let rv = review(r.path(), "main", &Scope::Commit(base.clone()), &[], true).unwrap();
        assert_eq!(rv.old_ref, EMPTY_TREE);
        assert_eq!(paths(&rv), vec![fx("gone.txt", 1, 0, false), fx("keep.txt", 2, 0, false)]);
        // Unknown commit.
        assert!(review(r.path(), "main", &Scope::Commit("deadbeef".into()), &[], true).unwrap_err().contains("unknown commit"));
    }
}
