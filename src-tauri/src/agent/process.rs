use anyhow::{anyhow, Context};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

/// Resolves an agent binary on PATH (handles `.cmd`/`.exe` shims on Windows), then in the places
/// the vendors' own installers put it without touching PATH (see `fallback_dirs`).
pub fn resolve(bin: &str) -> anyhow::Result<PathBuf> {
    if let Ok(p) = which::which(bin) {
        return Ok(p);
    }
    let dirs = fallback_dirs(bin, std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).as_deref());
    which::which_in(bin, std::env::join_paths(&dirs).ok(), std::env::current_dir().unwrap_or_default())
        .with_context(|| format!("`{bin}` not found on PATH (also looked in {} common install locations)", dirs.len()))
}

/// Directories that may hold `bin` although PATH does not list them: the Codex app's own copy
/// (`~/.codex/.sandbox-bin`), the OpenAI VS Code extension's bundled CLI (newest version first),
/// and the usual global npm / pnpm / bun / local bin folders.
pub fn fallback_dirs(bin: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let Some(home) = home else { return vec![] };
    let mut dirs = vec![];
    if bin == "codex" {
        dirs.push(home.join(".codex").join(".sandbox-bin"));
        let ext = home.join(".vscode").join("extensions");
        let mut found: Vec<PathBuf> = std::fs::read_dir(&ext)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("openai.chatgpt"))
            .flat_map(|e| {
                let bin_dir = e.path().join("bin");
                std::fs::read_dir(&bin_dir).into_iter().flatten().flatten().map(|p| p.path()).collect::<Vec<_>>()
            })
            .filter(|p| p.is_dir())
            .collect();
        found.sort();
        found.reverse();
        dirs.extend(found);
    }
    dirs.extend([
        home.join("AppData").join("Roaming").join("npm"),
        home.join("AppData").join("Local").join("pnpm"),
        home.join(".bun").join("bin"),
        home.join(".local").join("bin"),
    ]);
    dirs.retain(|d| d.is_dir());
    dirs
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
    use super::{fallback_dirs, is_host_var};

    #[test]
    fn codex_is_found_where_the_codex_app_and_vscode_extension_keep_it() {
        let home = std::env::temp_dir().join(format!("orbit-fallback-{}", uuid::Uuid::new_v4().simple()));
        let sandbox = home.join(".codex").join(".sandbox-bin");
        let ext = home.join(".vscode/extensions/openai.chatgpt-1.0.0-win32-x64/bin/windows-x86_64");
        let other = home.join(".vscode/extensions/ms-python.python-1/bin/x");
        for d in [&sandbox, &ext, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        let dirs = fallback_dirs("codex", Some(&home));
        assert_eq!(dirs, [sandbox.clone(), ext.clone()], "app copy first, then the OpenAI extension only");
        assert!(fallback_dirs("claude", Some(&home)).is_empty(), "codex-specific dirs are not offered for other agents");
        assert!(fallback_dirs("codex", None).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn scrubs_host_session_vars_only() {
        assert!(is_host_var("CLAUDECODE"));
        assert!(is_host_var("CLAUDE_CODE_SESSION_ID"));
        assert!(is_host_var("CLAUDE_AGENT_SDK_VERSION"));
        assert!(!is_host_var("ANTHROPIC_API_KEY"));
        assert!(!is_host_var("CLAUDE_CONFIG_DIR"));
    }
}
