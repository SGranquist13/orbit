//! Per-repo check command: auto-detected from the repo's manifests (or overridden in Settings)
//! and run by Orbit itself, so shipping gates and the Simplify pass share one definition of "green".

use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

const TAIL_BYTES: usize = 4096;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub ok: bool,
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

/// Runs `cmd` through the platform shell in `worktree` without a console window.
pub fn run(worktree: &Path, cmd: &str) -> CheckResult {
    let started = Instant::now();
    #[cfg(windows)]
    let mut c = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.args(["/C", cmd]).creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let mut c = Command::new("sh");
        c.args(["-c", cmd]);
        c
    };
    c.current_dir(worktree).stdin(Stdio::null());
    let (ok, output) = match c.output() {
        Ok(out) => {
            let mut all = out.stdout;
            all.extend_from_slice(&out.stderr);
            (out.status.success(), tail(&all))
        }
        Err(e) => (false, format!("could not start `{cmd}`: {e}")),
    };
    CheckResult { ok, command: cmd.to_string(), output_tail: output, duration_ms: started.elapsed().as_millis() as u64 }
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
        let ok = run(&d, "echo hello");
        assert!(ok.ok && ok.output_tail.contains("hello"));
        let bad = run(&d, "echo boom 1>&2 && exit 3");
        assert!(!bad.ok && bad.output_tail.contains("boom"));
    }

    #[test]
    fn tail_keeps_the_end() {
        let big = "a".repeat(10_000) + "END";
        let t = tail(big.as_bytes());
        assert!(t.len() <= TAIL_BYTES && t.ends_with("END"));
    }
}
