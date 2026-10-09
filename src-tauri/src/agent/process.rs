use anyhow::{anyhow, Context};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

/// Resolves an agent binary on PATH (handles `.cmd`/`.exe` shims on Windows).
pub fn resolve(bin: &str) -> anyhow::Result<PathBuf> {
    which::which(bin).with_context(|| format!("`{bin}` not found on PATH"))
}

/// Builds a piped, windowless child process with host-agent env vars scrubbed.
pub fn command(bin: &str, args: &[String], cwd: &Path) -> anyhow::Result<Command> {
    let path = resolve(bin)?;
    if !cwd.is_dir() {
        return Err(anyhow!("working directory does not exist: {}", cwd.display()));
    }
    let mut cmd = Command::new(path);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    scrub_env(&mut cmd);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// When the IDE itself is launched from inside a Claude Code session, that host's
/// env (auth proxy URL, session ids, entrypoint) leaks into children and breaks their auth.
fn scrub_env(cmd: &mut Command) {
    let inside_claude_host = std::env::var_os("CLAUDECODE").is_some();
    for (key, _) in std::env::vars_os() {
        let Some(key) = key.to_str() else { continue };
        if is_host_var(key) || (inside_claude_host && key == "ANTHROPIC_BASE_URL") {
            cmd.env_remove(key);
        }
    }
}

fn is_host_var(key: &str) -> bool {
    key == "CLAUDECODE"
        || key == "CLAUDE_PID"
        || key == "CLAUDE_EFFORT"
        || key.starts_with("CLAUDE_CODE_")
        || key.starts_with("CLAUDE_AGENT_SDK_")
        || key.starts_with("CLAUDE_PREVIEW_")
}

#[cfg(test)]
mod tests {
    use super::is_host_var;

    #[test]
    fn scrubs_host_session_vars_only() {
        assert!(is_host_var("CLAUDECODE"));
        assert!(is_host_var("CLAUDE_CODE_SESSION_ID"));
        assert!(is_host_var("CLAUDE_AGENT_SDK_VERSION"));
        assert!(!is_host_var("ANTHROPIC_API_KEY"));
        assert!(!is_host_var("CLAUDE_CONFIG_DIR"));
    }
}
