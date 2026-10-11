use anyhow::{anyhow, Context};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

/// Resolves an agent binary on PATH (handles `.cmd`/`.exe` shims on Windows), then in the places
/// the vendors' own installers put it without touching PATH (see `fallback_dirs`).
pub fn resolve(bin: &str) -> anyhow::Result<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    if let Ok(p) = which::which(bin) {
        // An npm `codex.cmd` shim runs a Node wrapper that re-spawns the real binary; drive the native
        // binary inside the package instead, so Orbit talks to the process it expects over plain pipes.
        if bin == "codex" {
            if let Some(native) = native_behind_shim(&p) {
                return Ok(native);
            }
        }
        return Ok(p);
    }
    let dirs = fallback_dirs(bin, home.as_deref());
    which::which_in(bin, std::env::join_paths(&dirs).ok(), std::env::current_dir().unwrap_or_default())
        .with_context(|| format!("`{bin}` not found on PATH (also looked in {} common install locations)", dirs.len()))
}

/// For an npm shim (`<prefix>/codex.cmd`), the platform package's native `codex.exe`, if installed.
pub fn native_behind_shim(shim: &Path) -> Option<PathBuf> {
    let ext = shim.extension()?.to_string_lossy().to_ascii_lowercase();
    if !matches!(ext.as_str(), "cmd" | "bat" | "ps1") {
        return None;
    }
    let pkg = shim.parent()?.join("node_modules").join("@openai").join("codex").join("node_modules").join("@openai");
    std::fs::read_dir(&pkg)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("codex-win32"))
        .flat_map(|e| std::fs::read_dir(e.path().join("vendor")).into_iter().flatten().flatten())
        .map(|v| v.path().join("bin").join("codex.exe"))
        .find(|p| p.is_file())
}

/// Directories that may hold `bin` although PATH does not list them: the Codex app's own copy
/// (`~/.codex/.sandbox-bin`), the OpenAI VS Code extension's bundled CLI (newest version first),
/// and the usual global npm / pnpm / bun / local bin folders.
pub fn fallback_dirs(bin: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let Some(home) = home else { return vec![] };
    let mut dirs = vec![];
    if bin == "codex" {
        // The Codex desktop app's own binary (newest build first) is the one known to serve `app-server`.
        let app_bins = home.join("AppData").join("Local").join("OpenAI").join("Codex").join("bin");
        let mut builds: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&app_bins)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().join("codex.exe").is_file())
            .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
            .collect();
        builds.sort_by(|a, b| b.0.cmp(&a.0));
        dirs.extend(builds.into_iter().map(|b| b.1));
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
        let build = home.join("AppData/Local/OpenAI/Codex/bin/abc123");
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("codex.exe"), b"").unwrap();
        assert_eq!(fallback_dirs("codex", Some(&home))[0], build, "the Codex app's own build comes before the sandbox copy");
        assert!(fallback_dirs("claude", Some(&home)).is_empty(), "codex-specific dirs are not offered for other agents");
        assert!(fallback_dirs("codex", None).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn npm_shim_maps_to_the_native_binary() {
        let root = std::env::temp_dir().join(format!("orbit-shim-{}", uuid::Uuid::new_v4().simple()));
        let bin = root.join("node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("codex.exe"), b"").unwrap();
        assert_eq!(super::native_behind_shim(&root.join("codex.cmd")), Some(bin.join("codex.exe")));
        assert_eq!(super::native_behind_shim(&root.join("codex.exe")), None, "real binaries are used as they are");
        assert_eq!(super::native_behind_shim(&std::env::temp_dir().join("codex.cmd")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scrubs_host_session_vars_only() {
        assert!(is_host_var("CLAUDECODE"));
        assert!(is_host_var("CLAUDE_CODE_SESSION_ID"));
        assert!(is_host_var("CLAUDE_AGENT_SDK_VERSION"));
        assert!(!is_host_var("ANTHROPIC_API_KEY"));
        assert!(!is_host_var("CLAUDE_CONFIG_DIR"));
    }

    /// Opt-in (`-- --include-ignored`): spawns the resolved `codex app-server` exactly as the adapter
    /// does and expects an `initialize` response, i.e. the binary Orbit picks is a working CLI.
    #[tokio::test]
    #[ignore]
    async fn live_codex_app_server_answers_initialize() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let path = super::resolve("codex").expect("codex resolves");
        eprintln!("resolved codex: {}", path.display());
        let mut cmd = super::command("codex", &["app-server".to_string()], &std::env::temp_dir()).unwrap();
        let mut child = cmd.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut err = BufReader::new(child.stderr.take().unwrap()).lines();
        stdin.write_all(b"{\"id\":0,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"orbit\",\"title\":\"Orbit\",\"version\":\"0\"},\"capabilities\":null}}\n").await.unwrap();
        let got = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            tokio::select! {
                l = out.next_line() => format!("stdout: {l:?}"),
                l = err.next_line() => format!("stderr: {l:?}"),
                s = child.wait() => format!("exited early: {s:?}"),
            }
        })
        .await;
        eprintln!("{got:?}");
        assert!(matches!(&got, Ok(s) if s.contains("result")), "{got:?}");
    }
}
