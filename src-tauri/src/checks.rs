//! Per-repo check command: auto-detected from the repo's manifests (or overridden in Settings)
//! and run by Orbit itself, so shipping gates and the Simplify pass share one definition of "green".

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const TAIL_BYTES: usize = 4096;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub ok: bool,
    pub kind: CheckKind,
    pub command: String,
    /// Last ~4KB of combined stdout + stderr.
    pub output_tail: String,
    pub duration_ms: u64,
}

/// `detected` is what Orbit found; `override` is the user's per-repo override (if any).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckCommandInfo {
    pub detected: Option<String>,
    #[serde(rename = "override")]
    pub override_cmd: Option<String>,
}

/// The first fast check Orbit can find for the repo, or None.
pub fn detect(repo: &Path) -> Option<String> {
    if let Ok(text) = std::fs::read_to_string(repo.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let runner = if repo.join("bun.lock").exists() || repo.join("bun.lockb").exists() {
                "bun"
            } else if repo.join("pnpm-lock.yaml").exists() {
                "pnpm"
            } else if repo.join("yarn.lock").exists() {
                "yarn"
            } else {
                "npm"
            };
            if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
                for name in ["typecheck", "check", "lint", "test"] {
                    if scripts.contains_key(name) {
                        return Some(format!("{runner} run {name}"));
                    }
                }
            }
        }
    }
    if repo.join("Cargo.toml").exists() {
        return Some("cargo check".into());
    }
    if repo.join("go.mod").exists() {
        return Some("go build ./...".into());
    }
    None
}

/// The command to run: the override if set (and non-blank), else the detected one.
pub fn effective(repo: &Path, override_cmd: Option<&str>) -> Option<String> {
    override_cmd.map(str::trim).filter(|c| !c.is_empty()).map(String::from).or_else(|| detect(repo))
}

fn tail(bytes: &[u8]) -> String {
    let start = bytes.len().saturating_sub(TAIL_BYTES);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

/// What a check run came to, beyond pass/fail: the inbox words timeouts and install failures
/// differently from a genuine code failure.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CheckKind {
    Pass,
    Fail,
    TimedOut,
    InstallFailed,
}

/// How to run a check: the per-run timeout and whether to install JS dependencies first.
#[derive(Debug, Clone, Copy)]
pub struct RunOptions {
    pub timeout: Duration,
    pub install: bool,
}

/// True when the check command goes through a JS package runner (so it needs `node_modules`).
fn uses_js_runner(cmd: &str) -> bool {
    cmd.split(|c: char| c.is_whitespace() || matches!(c, '&' | '|' | ';' | '(' | ')'))
        .filter(|t| !t.is_empty())
        .any(|t| {
            let t = t.trim_matches(|c| c == '"' || c == '\'');
            let base = t.rsplit(['/', '\\']).next().unwrap_or(t).to_lowercase();
            let base = base.trim_end_matches(".cmd").trim_end_matches(".exe");
            matches!(base, "npm" | "npx" | "bun" | "bunx" | "pnpm" | "pnpx" | "yarn")
        })
}

/// True when package.json declares at least one dependency or devDependency.
fn declares_dependencies(repo: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(repo.join("package.json")) else { return false };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    ["dependencies", "devDependencies"]
        .iter()
        .any(|k| v.get(*k).and_then(|d| d.as_object()).is_some_and(|d| !d.is_empty()))
}

/// The install command a fresh worktree needs before the JS check `check_cmd` can run: only when
/// that command runs through a package runner, `package.json` declares dependencies, and
/// `node_modules` is missing. Matches the lockfile the way `detect` does; without any lockfile
/// `npm ci` would refuse to run, so it falls back to `npm install`.
pub fn install_command(repo: &Path, check_cmd: &str) -> Option<String> {
    if !repo.join("package.json").exists() || repo.join("node_modules").exists() {
        return None;
    }
    if !uses_js_runner(check_cmd) || !declares_dependencies(repo) {
        return None;
    }
    let cmd = if repo.join("bun.lock").exists() || repo.join("bun.lockb").exists() {
        "bun install"
    } else if repo.join("pnpm-lock.yaml").exists() {
        "pnpm install --frozen-lockfile"
    } else if repo.join("yarn.lock").exists() {
        "yarn install --frozen-lockfile"
    } else if repo.join("package-lock.json").exists() || repo.join("npm-shrinkwrap.json").exists() {
        "npm ci"
    } else {
        "npm install --no-audit --no-fund"
    };
    Some(cmd.into())
}

/// Kills `pid` and everything it spawned.
pub(crate) fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // The child leads its own process group (see `shell`), so a negative pid reaches the tree.
        let _ = Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).status();
    }
}

pub(crate) fn shell(worktree: &Path, cmd: &str) -> Command {
    #[cfg(windows)]
    let mut c = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.args(["/C", cmd]).creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        use std::os::unix::process::CommandExt;
        let mut c = Command::new("sh");
        c.args(["-c", cmd]).process_group(0);
        c
    };
    c.current_dir(worktree).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c
}

struct Ran {
    ok: bool,
    output: String,
    timed_out: bool,
}

/// Runs `cmd` through the platform shell, killing its process tree after `timeout`.
fn run_shell(worktree: &Path, cmd: &str, timeout: Duration) -> Ran {
    let mut child = match crate::agent::process::spawn_std(&mut shell(worktree, cmd)) {
        Ok(c) => c,
        Err(e) => return Ran { ok: false, output: format!("could not start `{cmd}`: {e}"), timed_out: false },
    };
    let (tx, rx) = mpsc::channel::<(bool, Vec<u8>)>();
    let pipes: [(bool, Option<Box<dyn Read + Send>>); 2] = [
        (false, child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
        (true, child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
    ];
    for (is_err, pipe) in pipes {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = vec![];
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            let _ = tx.send((is_err, buf));
        });
    }
    drop(tx);
    let started = Instant::now();
    let (mut ok, mut timed_out) = (false, false);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                ok = status.success();
                break;
            }
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => break,
        }
    }
    // A grandchild that escaped the kill can hold a pipe open; don't wait on it forever.
    let (mut out, mut err) = (vec![], vec![]);
    for _ in 0..2 {
        match rx.recv_timeout(Duration::from_secs(if timed_out { 2 } else { 30 })) {
            Ok((false, b)) => out = b,
            Ok((true, b)) => err = b,
            Err(_) => break,
        }
    }
    out.extend_from_slice(&err);
    Ran { ok: ok && !timed_out, output: tail(&out), timed_out }
}

fn duration_label(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 60 && s.is_multiple_of(60) { format!("{} min", s / 60) } else { format!("{s} s") }
}

/// Runs `cmd` in `worktree` (without a console window): installs JS dependencies first when the
/// worktree needs them, and gives up on either step after `opts.timeout`.
pub fn run(worktree: &Path, cmd: &str, opts: RunOptions) -> CheckResult {
    let started = Instant::now();
    let done = |ok: bool, kind: CheckKind, command: &str, output: String| CheckResult {
        ok,
        kind,
        command: command.to_string(),
        output_tail: output.trim().to_string(),
        duration_ms: started.elapsed().as_millis() as u64,
    };
    if opts.install {
        if let Some(install) = install_command(worktree, cmd) {
            let r = run_shell(worktree, &install, opts.timeout);
            if !r.ok {
                let note = if r.timed_out {
                    format!("`{install}` timed out after {}: dependencies failed to install", duration_label(opts.timeout))
                } else {
                    "dependencies failed to install".to_string()
                };
                return done(false, CheckKind::InstallFailed, &install, format!("{}\n{note}", r.output));
            }
        }
    }
    let r = run_shell(worktree, cmd, opts.timeout);
    if r.timed_out {
        let note = format!("timed out after {}", duration_label(opts.timeout));
        return done(false, CheckKind::TimedOut, cmd, format!("{}\n{note}", r.output));
    }
    done(r.ok, if r.ok { CheckKind::Pass } else { CheckKind::Fail }, cmd, r.output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("orbit-checks-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn detects_package_scripts_by_priority_and_lockfile() {
        let d = tmp("pkg");
        std::fs::write(d.join("package.json"), r#"{"scripts":{"test":"x","lint":"y"}}"#).unwrap();
        assert_eq!(detect(&d).as_deref(), Some("npm run lint"));
        std::fs::write(d.join("package.json"), r#"{"scripts":{"test":"x","typecheck":"tsc"}}"#).unwrap();
        std::fs::write(d.join("bun.lock"), "").unwrap();
        assert_eq!(detect(&d).as_deref(), Some("bun run typecheck"));
        std::fs::remove_file(d.join("bun.lock")).unwrap();
        std::fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(detect(&d).as_deref(), Some("pnpm run typecheck"));
        std::fs::remove_file(d.join("pnpm-lock.yaml")).unwrap();
        std::fs::write(d.join("yarn.lock"), "").unwrap();
        assert_eq!(detect(&d).as_deref(), Some("yarn run typecheck"));
    }

    #[test]
    fn detects_cargo_go_and_none() {
        let d = tmp("cargo");
        assert_eq!(detect(&d), None);
        std::fs::write(d.join("pyproject.toml"), "").unwrap();
        assert_eq!(detect(&d), None);
        std::fs::write(d.join("go.mod"), "").unwrap();
        assert_eq!(detect(&d).as_deref(), Some("go build ./..."));
        std::fs::write(d.join("Cargo.toml"), "").unwrap();
        assert_eq!(detect(&d).as_deref(), Some("cargo check"));
        // package.json without usable scripts falls through.
        std::fs::write(d.join("package.json"), r#"{"scripts":{"build":"x"}}"#).unwrap();
        assert_eq!(detect(&d).as_deref(), Some("cargo check"));
    }

    #[test]
    fn override_wins_and_blank_falls_back() {
        let d = tmp("ovr");
        std::fs::write(d.join("Cargo.toml"), "").unwrap();
        assert_eq!(effective(&d, Some("make ci")).as_deref(), Some("make ci"));
        assert_eq!(effective(&d, Some("  ")).as_deref(), Some("cargo check"));
        assert_eq!(effective(&d, None).as_deref(), Some("cargo check"));
    }

    #[test]
    fn run_reports_success_failure_and_output() {
        let d = tmp("run");
        let opts = RunOptions { timeout: Duration::from_secs(60), install: false };
        let ok = run(&d, "echo hello", opts);
        assert!(ok.ok && ok.kind == CheckKind::Pass && ok.output_tail.contains("hello"));
        let bad = run(&d, "echo boom 1>&2 && exit 3", opts);
        assert!(!bad.ok && bad.kind == CheckKind::Fail && bad.output_tail.contains("boom"));
    }

    #[test]
    fn a_sleeping_command_is_killed_on_timeout() {
        let d = tmp("timeout");
        #[cfg(windows)]
        let sleeper = "ping -n 60 127.0.0.1 > nul";
        #[cfg(not(windows))]
        let sleeper = "sleep 60";
        let started = Instant::now();
        let r = run(&d, sleeper, RunOptions { timeout: Duration::from_secs(1), install: false });
        assert!(!r.ok && r.kind == CheckKind::TimedOut, "{r:?}");
        assert!(r.output_tail.contains("timed out after 1 s"));
        assert!(started.elapsed() < Duration::from_secs(20), "should not wait out the sleep");
    }

    #[test]
    fn install_is_needed_only_without_node_modules() {
        let d = tmp("install");
        let check = "npm run check";
        assert_eq!(install_command(&d, check), None, "no package.json");
        std::fs::write(d.join("package.json"), r#"{"devDependencies":{"typescript":"^5"}}"#).unwrap();
        assert_eq!(install_command(&d, check).as_deref(), Some("npm install --no-audit --no-fund"), "no lockfile");
        std::fs::write(d.join("package-lock.json"), "{}").unwrap();
        assert_eq!(install_command(&d, check).as_deref(), Some("npm ci"));
        std::fs::write(d.join("yarn.lock"), "").unwrap();
        assert_eq!(install_command(&d, check).as_deref(), Some("yarn install --frozen-lockfile"));
        std::fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(install_command(&d, check).as_deref(), Some("pnpm install --frozen-lockfile"));
        std::fs::write(d.join("bun.lockb"), "").unwrap();
        assert_eq!(install_command(&d, check).as_deref(), Some("bun install"));
        std::fs::create_dir(d.join("node_modules")).unwrap();
        assert_eq!(install_command(&d, check), None, "already installed");
    }

    #[test]
    fn install_skipped_unless_the_check_needs_node_modules() {
        let d = tmp("install-skip");
        // No dependencies declared: nothing to install, whatever the check is.
        std::fs::write(d.join("package.json"), r#"{"name":"x"}"#).unwrap();
        assert_eq!(install_command(&d, "npm test"), None);
        std::fs::write(d.join("package.json"), r#"{"name":"x","dependencies":{}}"#).unwrap();
        assert_eq!(install_command(&d, "npm test"), None, "empty dependencies");
        // Dependencies declared, but the check doesn't run through a JS runner.
        std::fs::write(d.join("package.json"), r#"{"dependencies":{"left-pad":"1"}}"#).unwrap();
        assert_eq!(install_command(&d, "exit 0"), None);
        assert_eq!(install_command(&d, "cargo check"), None);
        assert_eq!(install_command(&d, "node check.js"), None);
        // JS runners, including inside a compound command and with a path or .cmd suffix.
        for c in ["npm test", "npx tsc", "bun run check", "bunx vitest", "pnpm lint", "yarn test", "cargo fmt && npm test", "C:\\x\\npm.cmd run lint"] {
            assert!(install_command(&d, c).is_some(), "{c}");
        }
        assert!(!uses_js_runner("echo npmx && make"));
    }

    #[test]
    fn tail_keeps_the_end() {
        let big = "a".repeat(10_000) + "END";
        let t = tail(big.as_bytes());
        assert!(t.len() <= TAIL_BYTES && t.ends_with("END"));
    }
}
