use anyhow::{anyhow, Context};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::process::Command;

/// Resolves an agent binary by identity, not by name. `bun run` puts every ancestor
/// `node_modules/.bin` on PATH, so the first `codex` / `claude` hit can be an unrelated npm package.
/// For those two CLIs each candidate (PATH hits in order, then the vendors' own install locations,
/// see `fallback_dirs`) is accepted only when `--version` identifies it; the verified path is cached
/// for the app's lifetime. Other tools (`gh`, `git`) resolve to the first PATH hit.
pub fn resolve(bin: &str) -> anyhow::Result<PathBuf> {
    if identity_of(bin).is_none() {
        return resolve_plain(bin);
    }
    let cached = verified_cache().lock().unwrap_or_else(|e| e.into_inner()).get(bin).cloned();
    if let Some(p) = cached {
        return Ok(p);
    }
    let cands = candidates(bin, std::env::var_os("PATH"), home_dir().as_deref());
    let found = pick(bin, &cands, &probe_version)?;
    verified_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(bin.to_string(), found.clone());
    Ok(found)
}

fn verified_cache() -> &'static Mutex<HashMap<String, PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn resolve_plain(bin: &str) -> anyhow::Result<PathBuf> {
    if let Ok(p) = which::which(bin) {
        return Ok(p);
    }
    let dirs = fallback_dirs(bin, home_dir().as_deref());
    which::which_in(bin, std::env::join_paths(&dirs).ok(), std::env::current_dir().unwrap_or_default())
        .with_context(|| format!("`{bin}` not found on PATH (also looked in {} common install locations)", dirs.len()))
}

/// What a CLI must look like to be accepted: display name, vendor, official npm package, `--version` matcher.
struct Identity {
    name: &'static str,
    owner: &'static str,
    package: &'static [&'static str],
    matches: fn(&str) -> bool,
}

fn identity_of(bin: &str) -> Option<Identity> {
    match bin {
        "codex" => Some(Identity { name: "Codex", owner: "OpenAI's Codex", package: &["@openai", "codex"], matches: codex_version_ok }),
        "claude" => Some(Identity { name: "Claude Code", owner: "Anthropic's Claude Code", package: &["@anthropic-ai", "claude-code"], matches: claude_version_ok }),
        _ => None,
    }
}

/// `codex --version` prints `codex-cli 0.160.0` (the Codex app's build: `codex-cli 0.162.0-alpha.17.2`).
pub fn codex_version_ok(out: &str) -> bool {
    out.lines().any(|l| l.trim_start().to_ascii_lowercase().starts_with("codex-cli"))
}

/// `claude --version` prints `2.1.295 (Claude Code)`.
pub fn claude_version_ok(out: &str) -> bool {
    out.contains("(Claude Code)")
}

/// A binary in a `node_modules/.bin` folder belongs to whatever package the project installed under
/// that name. True when it is not in such a folder, or that `node_modules` holds the official package.
pub fn npm_bin_is_official(path: &Path, package: &[&str]) -> bool {
    let Some(dir) = path.parent() else { return true };
    let in_bin = dir.file_name().is_some_and(|n| n == ".bin") && dir.parent().and_then(Path::file_name).is_some_and(|n| n == "node_modules");
    if !in_bin {
        return true;
    }
    let mut pkg = dir.parent().map(Path::to_path_buf).unwrap_or_default();
    pkg.extend(package);
    pkg.join("package.json").is_file()
}

/// Every plausible location for `bin`, best first: PATH hits (npm shims mapped to the native Codex
/// binary), then the fallback install dirs. Duplicates removed.
pub fn candidates(bin: &str, path_var: Option<OsString>, home: Option<&Path>) -> Vec<PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut out: Vec<PathBuf> = vec![];
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Ok(hits) = which::which_in_all(bin, path_var, &cwd) {
        for p in hits {
            // An npm `codex.cmd` shim runs a Node wrapper that re-spawns the real binary; drive the native
            // binary inside the package instead, so Orbit talks to the process it expects over plain pipes.
            match (bin == "codex").then(|| native_behind_shim(&p)).flatten() {
                Some(native) => push(native),
                None => push(p),
            }
        }
    }
    let dirs = fallback_dirs(bin, home);
    if let Ok(hits) = which::which_in_all(bin, std::env::join_paths(&dirs).ok(), &cwd) {
        hits.for_each(&mut push);
    }
    out
}

/// First candidate that is not a foreign npm package and whose `--version` output identifies the right CLI.
fn pick(bin: &str, cands: &[PathBuf], version_of: &dyn Fn(&Path) -> Option<String>) -> anyhow::Result<PathBuf> {
    let id = identity_of(bin).ok_or_else(|| anyhow!("no identity check for `{bin}`"))?;
    let mut rejected: Option<&PathBuf> = None;
    for c in cands {
        if npm_bin_is_official(c, id.package) && version_of(c).is_some_and(|out| (id.matches)(&out)) {
            return Ok(c.clone());
        }
        rejected.get_or_insert(c);
    }
    Err(match rejected {
        Some(p) => anyhow!("Couldn't find the {} CLI (found {}, but it isn't {})", id.name, p.display(), id.owner),
        None => anyhow!("Couldn't find the {} CLI (`{bin}` is not on PATH or in the usual install locations)", id.name),
    })
}

/// Runs `<path> --version` once: windowless, stdin null, 5 s timeout. Returns stdout + stderr.
fn probe_version(path: &Path) -> Option<String> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    fn drain(r: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut buf = vec![];
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    }
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    let mut text = out.join().unwrap_or_default();
    text.push('\n');
    text.push_str(&err.join().unwrap_or_default());
    Some(text)
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
    fn version_matchers() {
        assert!(super::codex_version_ok("codex-cli 0.160.0\n"));
        assert!(super::codex_version_ok("\ncodex-cli 0.162.0-alpha.17.2"));
        assert!(!super::codex_version_ok("0.2.3\n(node:11316) Warning: Accessing non-existent property 'lineno'"));
        assert!(!super::codex_version_ok(""));
        assert!(super::claude_version_ok("2.1.295 (Claude Code)\n"));
        assert!(!super::claude_version_ok("1.0.0\n"));
    }

    #[test]
    fn foreign_npm_packages_in_node_modules_bin_are_rejected() {
        let root = std::env::temp_dir().join(format!("orbit-npm-{}", uuid::Uuid::new_v4().simple()));
        let bin = root.join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(root.join("node_modules/codex")).unwrap();
        std::fs::write(root.join("node_modules/codex/package.json"), br#"{"name":"codex"}"#).unwrap();
        let codex = bin.join("codex.exe");
        let pkg = ["@openai", "codex"];
        assert!(!super::npm_bin_is_official(&codex, &pkg), "unrelated `codex` package");
        std::fs::create_dir_all(root.join("node_modules/@openai/codex")).unwrap();
        std::fs::write(root.join("node_modules/@openai/codex/package.json"), br#"{"name":"@openai/codex"}"#).unwrap();
        assert!(super::npm_bin_is_official(&codex, &pkg), "official package installed alongside");
        assert!(super::npm_bin_is_official(&root.join("elsewhere/codex.exe"), &pkg), "outside node_modules/.bin is not judged by path");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn candidates_keep_path_order_then_fallbacks_and_pick_first_verified() {
        let root = std::env::temp_dir().join(format!("orbit-cand-{}", uuid::Uuid::new_v4().simple()));
        let (a, b) = (root.join("a"), root.join("b"));
        let sandbox = root.join(".codex/.sandbox-bin");
        for d in [&a, &b, &sandbox] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("codex.exe"), b"").unwrap();
        }
        let path = std::env::join_paths([&a, &b]).unwrap();
        let cands = super::candidates("codex", Some(path), Some(&root));
        assert_eq!(cands, [a.join("codex.exe"), b.join("codex.exe"), sandbox.join("codex.exe")]);
        let fake = |p: &std::path::Path| Some(if p.starts_with(&a) { "0.2.3".to_string() } else { "codex-cli 1.0.0".to_string() });
        assert_eq!(super::pick("codex", &cands, &fake).unwrap(), b.join("codex.exe"));
        let never = |_: &std::path::Path| Some("0.2.3".to_string());
        let err = super::pick("codex", &cands, &never).unwrap_err().to_string();
        assert!(err.contains("Couldn't find the Codex CLI") && err.contains("isn't OpenAI's Codex"), "{err}");
        let err = super::pick("codex", &[], &never).unwrap_err().to_string();
        assert!(err.contains("not on PATH"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Opt-in: with the user's home `node_modules\.bin` (holding the unrelated npm `codex`) first on PATH,
    /// resolution must still land on a native OpenAI binary.
    #[test]
    #[ignore]
    fn live_codex_skips_unrelated_npm_package() {
        let bad = home_for_live().join("node_modules").join(".bin");
        let mut paths = vec![bad.clone()];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
        let cands = super::candidates("codex", Some(std::env::join_paths(paths).unwrap()), Some(&home_for_live()));
        eprintln!("candidates: {cands:#?}");
        assert!(cands.first().is_some_and(|c| c.starts_with(&bad)), "the bad codex is first on PATH");
        let got = super::pick("codex", &cands, &super::probe_version).expect("a real codex verifies");
        eprintln!("picked: {}", got.display());
        assert!(!got.starts_with(&bad));
        assert!(super::codex_version_ok(&super::probe_version(&got).unwrap()));
    }

    fn home_for_live() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var_os("USERPROFILE").expect("USERPROFILE"))
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
