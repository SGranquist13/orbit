//! Per-repository worktree preparation and development servers.
use crate::{agent::process, checks, db::Workspace, err, git, relock, AppState, CmdResult};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, VecDeque}, io::{BufRead, BufReader, Read}, path::{Path, PathBuf}, process::Child, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, watch};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoScripts {
    pub setup_script: Option<String>,
    pub run_script: Option<String>,
    pub copy_globs: Vec<String>,
}

fn matcher(root: &Path, globs: &[String]) -> anyhow::Result<ignore::overrides::Override> {
    let mut builder = ignore::overrides::OverrideBuilder::new(root);
    for glob in globs.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        anyhow::ensure!(!glob.starts_with('!') && !glob.contains(['\n', '\r']), "copy globs must be positive single-line patterns");
        builder.add(glob)?;
    }
    Ok(builder.build()?)
}

/// Git's untracked listing includes ignored files when no exclude flags are passed.
/// No state is changed, and tracked files (including modified tracked files) are excluded.
#[cfg_attr(not(test), allow(dead_code))]
pub fn matching_files(root: &Path, globs: &[String]) -> Vec<PathBuf> {
    matching_files_checked(root, globs).unwrap_or_default()
}

fn matching_files_checked(root: &Path, globs: &[String]) -> anyhow::Result<Vec<PathBuf>> {
    if globs.iter().all(|s| s.trim().is_empty()) { return Ok(vec![]); }
    let patterns = matcher(root, globs)?;
    let files = git::run_raw(root, &["ls-files", "--others", "--full-name", "-z"])?;
    let mut result = vec![];
    for name in files.split('\0').filter(|s| !s.is_empty()) {
        let rel = PathBuf::from(name);
        if rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) { continue; }
        let path = root.join(&rel);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
            && patterns.matched(&path, false).is_whitelist() {
            result.push(rel);
        }
    }
    result.sort();
    Ok(result)
}

fn copy_files(root: &Path, target: &Path, globs: &[String]) -> anyhow::Result<()> {
    let source_root = std::fs::canonicalize(root)?;
    for rel in matching_files_checked(root, globs)? {
        let source = root.join(&rel);
        anyhow::ensure!(std::fs::canonicalize(&source)?.starts_with(&source_root), "copy source escapes checkout");
        let mut dest = target.to_path_buf();
        let parts: Vec<_> = rel.components().collect();
        for part in &parts[..parts.len()-1] {
            dest.push(part.as_os_str());
            match std::fs::symlink_metadata(&dest) {
                Ok(m) => anyhow::ensure!(m.is_dir() && !m.file_type().is_symlink(), "unsafe copy destination: {}", dest.display()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(&dest)?,
                Err(e) => return Err(e.into()),
            }
        }
        dest.push(parts.last().unwrap().as_os_str());
        let mut output = match std::fs::OpenOptions::new().write(true).create_new(true).open(&dest) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        };
        std::io::copy(&mut std::fs::File::open(source)?, &mut output)?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_repo_scripts(state: State<AppState>, repo_id: String) -> CmdResult<RepoScripts> {
    state.db().repo_scripts(&repo_id).map_err(err)
}

#[tauri::command]
pub fn set_repo_scripts(state: State<AppState>, repo_id: String, scripts: RepoScripts) -> CmdResult<()> {
    let repo = state.db().repo(&repo_id).map_err(err)?;
    matcher(Path::new(&repo.path), &scripts.copy_globs).map_err(err)?;
    state.db().set_repo_scripts(&repo_id, &scripts).map_err(err)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status { Running, Done, Failed, TimedOut, Stopped }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEvent {
    workspace_id: String,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
}

#[derive(Default)]
struct Output { lines: VecDeque<String>, finished: bool }
impl Output {
    fn push(&mut self, line: String) {
        if self.lines.len() == 200 { self.lines.pop_front(); }
        self.lines.push_back(line.chars().take(8192).collect());
    }
}

fn event(app: &AppHandle, topic: &str, id: &str, status: Status, line: Option<String>) {
    let _ = app.emit(topic, ScriptEvent { workspace_id: id.into(), status, line });
}

struct ScriptFile(Option<PathBuf>);
impl Drop for ScriptFile {
    fn drop(&mut self) {
        if let Some(path) = &self.0 { let _ = std::fs::remove_file(path); }
    }
}

fn spawn_script(path: &Path, script: &str, port: Option<u16>) -> std::io::Result<(Child, ScriptFile)> {
    // cmd /C does not reliably execute embedded newlines; a batch file preserves script syntax.
    #[cfg(windows)]
    let (script, file) = {
        let file = ScriptFile(Some(std::env::temp_dir().join(format!("orbit-script-{}.cmd", uuid::Uuid::new_v4()))));
        let script_path = file.0.as_ref().unwrap();
        std::fs::write(script_path, format!("@echo off\r\n{}\r\n", script.replace("\r\n", "\n").replace('\n', "\r\n")))?;
        (script_path.to_string_lossy().to_string(), file)
    };
    #[cfg(not(windows))]
    let (script, file) = (script.to_string(), ScriptFile(None));
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/D", "/S", "/C"]).raw_arg(format!("\"\"{script}\"\""))
            .creation_flags(0x0800_0000).current_dir(path)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = checks::shell(path, &script);
    for key in process::host_env_keys() { cmd.env_remove(key); }
    if let Some(port) = port { cmd.env("PORT", port.to_string()).env("ORBIT_PORT", port.to_string()); }
    Ok((process::spawn_std(&mut cmd)?, file))
}

fn wait_setup(child: &mut Child, timeout: Duration) -> std::io::Result<Status> {
    let started = Instant::now();
    let result = loop {
        match child.try_wait() {
            Err(e) => break Err(e),
            Ok(Some(s)) => break Ok(if s.success() { Status::Done } else { Status::Failed }),
            Ok(None) if started.elapsed() >= timeout => break Ok(Status::TimedOut),
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
        }
    };
    checks::kill_tree(child.id());
    if !matches!(result, Ok(Status::Done | Status::Failed)) { let _ = child.kill(); }
    let _ = child.wait();
    result
}

fn finish_readers(readers: Vec<std::thread::JoinHandle<()>>) {
    // An escaped grandchild can keep a pipe open even after killing the process tree.
    let deadline = Instant::now() + Duration::from_secs(2);
    for reader in readers {
        while !reader.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if reader.is_finished() { let _ = reader.join(); }
    }
}

/// Readers bound both retained lines and individual lines, even for output without newlines.
fn stream(child: &mut Child, app: &AppHandle, topic: &'static str, id: &str, output: &Arc<Mutex<Output>>) -> Vec<std::thread::JoinHandle<()>> {
    let pipes: Vec<Box<dyn Read + Send>> = vec![Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    pipes.into_iter().map(|pipe| {
        let (app, id, output) = (app.clone(), id.to_string(), output.clone());
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            loop {
                let mut bytes = vec![];
                let n = reader.by_ref().take(8192).read_until(b'\n', &mut bytes).unwrap_or(0);
                if n == 0 { break; }
                let line = String::from_utf8_lossy(&bytes).trim_end_matches(['\r', '\n']).to_string();
                let mut stored = relock(&output);
                if stored.finished { break; }
                stored.push(line.clone());
                event(&app, topic, &id, Status::Running, Some(line));
            }
        })
    }).collect()
}

struct Preparation { done: watch::Receiver<bool>, output: Arc<Mutex<Output>>, status: Arc<Mutex<Status>>, notified: bool, tail: Option<oneshot::Receiver<()>>, sequence: u64 }
static SETUPS: OnceLock<Mutex<HashMap<String, Preparation>>> = OnceLock::new();
fn setups() -> &'static Mutex<HashMap<String, Preparation>> { SETUPS.get_or_init(Default::default) }

/// Registers the gate synchronously, before workspace creation can return or send a prompt.
pub fn begin(app: &AppHandle, state: &AppState, ws: &Workspace, root: PathBuf, scripts: RepoScripts) {
    if scripts.copy_globs.is_empty() && scripts.setup_script.as_deref().is_none_or(|s| s.trim().is_empty()) { return; }
    let (tx, done) = watch::channel(false);
    let output = Arc::new(Mutex::new(Output::default()));
    let status = Arc::new(Mutex::new(Status::Running));
    relock(setups()).insert(ws.id.clone(), Preparation { done, output: output.clone(), status: status.clone(), notified: false, tail: None, sequence: 0 });
    let (app, id, path, timeout) = (app.clone(), ws.id.clone(), PathBuf::from(&ws.path), Duration::from_secs(u64::from(state.settings().setup_timeout_minutes) * 60));
    event(&app, "workspace-setup", &id, Status::Running, None);
    tokio::spawn(async move {
        let worker_app = app.clone();
        let worker_id = id.clone();
        let worker_output = output.clone();
        let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Status> {
            copy_files(&root, &path, &scripts.copy_globs)?;
            let Some(script) = scripts.setup_script.filter(|s| !s.trim().is_empty()) else { return Ok(Status::Done) };
            let (mut child, _script_file) = spawn_script(&path, &script, None)?;
            let readers = stream(&mut child, &worker_app, "workspace-setup", &worker_id, &worker_output);
            let result = wait_setup(&mut child, timeout);
            finish_readers(readers);
            Ok(result?)
        }).await;
        let final_status = match result {
            Ok(Ok(s)) => s,
            error => {
                let line = format!("Setup failed: {error:?}");
                relock(&output).push(line.clone());
                event(&app, "workspace-setup", &id, Status::Running, Some(line));
                Status::Failed
            }
        };
        relock(&output).finished = true;
        *relock(&status) = final_status;
        event(&app, "workspace-setup", &id, final_status, None);
        let _ = tx.send(true);
    });
}

async fn wait_complete(id: &str) {
    let receiver = { relock(setups()).get(id).map(|p| p.done.clone()) };
    if let Some(mut receiver) = receiver { let _ = receiver.wait_for(|done| *done).await; }
}

pub async fn wait(id: &str) -> String {
    wait_complete(id).await;
    let mut map = relock(setups());
    let Some(preparation) = map.get_mut(id) else { return String::new() };
    if preparation.notified { return String::new(); }
    preparation.notified = true;
    let status = *relock(&preparation.status);
    if matches!(status, Status::Failed | Status::TimedOut) {
        let output = relock(&preparation.output);
        let tail = output.lines.iter().skip(output.lines.len().saturating_sub(20)).cloned().collect::<Vec<_>>().join("\n");
        format!("[Orbit: worktree setup {}. Last output:\n{tail}\n]\n\n", if status == Status::TimedOut { "timed out" } else { "failed" })
    } else { String::new() }
}

/// Reserve delivery order before spawning a task, so simultaneous sends retain their order
/// and the setup failure note belongs to the first message.
pub struct Gate {
    id: String,
    previous: Option<oneshot::Receiver<()>>,
    complete: Option<oneshot::Sender<()>>,
    sequence: u64,
}
impl Gate {
    pub async fn wait(&mut self) -> String {
        if let Some(previous) = self.previous.take() { let _ = previous.await; }
        wait(&self.id).await
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        let mut map = relock(setups());
        if let Some(preparation) = map.get_mut(&self.id) {
            if preparation.sequence == self.sequence { preparation.tail = None; }
        }
        if let Some(complete) = self.complete.take() { let _ = complete.send(()); }
    }
}
pub fn gate(id: &str) -> Option<Gate> {
    let mut map = relock(setups());
    let preparation = map.get_mut(id)?;
    if preparation.notified && preparation.tail.is_none() { return None; }
    let (complete, next) = oneshot::channel();
    let previous = preparation.tail.replace(next);
    preparation.sequence += 1;
    Some(Gate { id: id.into(), previous, complete: Some(complete), sequence: preparation.sequence })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus { pub status: Status, pub port: Option<u16> }
struct Run { pid: u32, status: Arc<Mutex<RunStatus>>, output: Arc<Mutex<Output>> }
static RUNS: OnceLock<Mutex<HashMap<String, Run>>> = OnceLock::new();
fn runs() -> &'static Mutex<HashMap<String, Run>> { RUNS.get_or_init(Default::default) }

#[tauri::command]
pub fn run_status(workspace_id: String) -> RunStatus {
    let map = relock(runs());
    map.get(&workspace_id).map(|r| relock(&r.status).clone()).unwrap_or(RunStatus { status: Status::Stopped, port: None })
}

#[tauri::command]
pub async fn start_run(app: AppHandle, state: State<'_, AppState>, workspace_id: String) -> CmdResult<u16> {
    // A development server must see copied configuration and installed dependencies too.
    wait_complete(&workspace_id).await;
    let ws = state.db().workspace(&workspace_id).map_err(err)?;
    let scripts = state.db().repo_scripts(&ws.repo_id).map_err(err)?;
    let script = scripts.run_script.filter(|s| !s.trim().is_empty()).ok_or("No run script configured")?;
    let mut map = relock(runs());
    if let Some(run) = map.get(&workspace_id) {
        let current = relock(&run.status).clone();
        if current.status == Status::Running { return current.port.ok_or("Run has no port".into()); }
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    drop(listener);
    let (mut child, script_file) = spawn_script(Path::new(&ws.path), &script, Some(port)).map_err(err)?;
    let status = Arc::new(Mutex::new(RunStatus { status: Status::Running, port: Some(port) }));
    let output = Arc::new(Mutex::new(Output::default()));
    map.insert(workspace_id.clone(), Run { pid: child.id(), status: status.clone(), output: output.clone() });
    event(&app, "workspace-run", &workspace_id, Status::Running, None);
    tokio::task::spawn_blocking(move || {
        let _script_file = script_file;
        let readers = stream(&mut child, &app, "workspace-run", &workspace_id, &output);
        let result = child.wait();
        checks::kill_tree(child.id());
        if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
        finish_readers(readers);
        relock(&output).finished = true;
        let mut current = relock(&status);
        if current.status == Status::Running {
            current.status = if result.is_ok_and(|s| s.success()) { Status::Done } else { Status::Failed };
            event(&app, "workspace-run", &workspace_id, current.status, None);
        }
    });
    Ok(port)
}

#[tauri::command]
pub fn stop_run(app: AppHandle, workspace_id: String) {
    let map = relock(runs());
    if let Some(run) = map.get(&workspace_id) {
        let mut status = relock(&run.status);
        if status.status == Status::Running {
            status.status = Status::Stopped;
            relock(&run.output).finished = true;
            checks::kill_tree(run.pid);
            event(&app, "workspace-run", &workspace_id, Status::Stopped, None);
        }
    }
}

pub fn close_all() {
    let map = relock(runs());
    for run in map.values() {
        if relock(&run.status).status == Status::Running { checks::kill_tree(run.pid); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scripts_support_multiple_lines_and_port_environment() {
        let root = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let script = "echo first\necho %PORT%:%ORBIT_PORT%";
        #[cfg(not(windows))]
        let script = "echo first\necho $PORT:$ORBIT_PORT";
        let (child, _file) = spawn_script(root.path(), script, Some(43210)).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(text.contains("first") && text.contains("43210:43210"), "{text}");
    }

    #[test]
    fn setup_timeout_kills_the_shell_and_its_children() {
        let root = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let script = "ping -n 60 127.0.0.1 > nul";
        #[cfg(not(windows))]
        let script = "sleep 60";
        let (mut child, _file) = spawn_script(root.path(), script, None).unwrap();
        let started = Instant::now();
        assert_eq!(wait_setup(&mut child, Duration::from_millis(200)).unwrap(), Status::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn setup_gates_messages_and_reports_failure_only_once_with_twenty_lines() {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, done) = watch::channel(false);
        let output = Arc::new(Mutex::new(Output::default()));
        for i in 0..250 { relock(&output).push(format!("line {i}")); }
        assert_eq!(relock(&output).lines.len(), 200);
        relock(setups()).insert(id.clone(), Preparation { done, output, status: Arc::new(Mutex::new(Status::Failed)), notified: false, tail: None, sequence: 0 });
        let task_id = id.clone();
        let task = tokio::spawn(async move { wait_complete(&task_id).await });
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        tx.send(true).unwrap();
        task.await.unwrap();
        // Waiting for a run must leave the agent's failure note intact.
        assert!(!relock(setups()).get(&id).unwrap().notified);
        let note = wait(&id).await;
        assert!(note.contains("setup failed"));
        assert!(note.contains("line 230\n") && note.contains("line 249"));
        assert!(!note.contains("line 229"));
        assert!(relock(setups()).get(&id).unwrap().notified);
        assert!(wait(&id).await.is_empty());
        relock(setups()).remove(&id);
    }

    #[tokio::test]
    async fn queued_messages_keep_order_and_the_failure_note_goes_to_the_first() {
        let id = uuid::Uuid::new_v4().to_string();
        let (_tx, done) = watch::channel(true);
        relock(setups()).insert(id.clone(), Preparation {
            done, output: Arc::new(Mutex::new(Output::default())), status: Arc::new(Mutex::new(Status::Failed)),
            notified: false, tail: None, sequence: 0,
        });
        let mut first = gate(&id).unwrap();
        let mut second = gate(&id).unwrap();
        let later = tokio::spawn(async move { second.wait().await });
        tokio::task::yield_now().await;
        assert!(!later.is_finished());
        assert!(first.wait().await.contains("setup failed"));
        drop(first);
        assert!(later.await.unwrap().is_empty());
        assert!(gate(&id).is_none());
        relock(setups()).remove(&id);
    }

    #[test]
    fn scripts_persist_and_clear_without_affecting_other_repositories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let db = crate::db::Db::open(&path).unwrap();
        for id in ["one", "two"] {
            db.insert_repo(&crate::db::Repo { id: id.into(), name: id.into(), path: dir.path().join(id).to_string_lossy().into(), base_branch: "main".into() }).unwrap();
        }
        assert!(db.repo_scripts("one").unwrap().setup_script.is_none());
        let scripts = RepoScripts { setup_script: Some("echo setup".into()), run_script: Some("echo run".into()), copy_globs: vec![".env*".into(), "config/**".into()] };
        db.set_repo_scripts("one", &scripts).unwrap();
        drop(db);
        let db = crate::db::Db::open(&path).unwrap();
        let restored = db.repo_scripts("one").unwrap();
        assert_eq!(restored.setup_script, scripts.setup_script);
        assert_eq!(restored.run_script, scripts.run_script);
        assert_eq!(restored.copy_globs, scripts.copy_globs);
        assert!(db.repo_scripts("two").unwrap().copy_globs.is_empty());
        db.set_repo_scripts("one", &RepoScripts::default()).unwrap();
        assert!(db.repo_scripts("one").unwrap().run_script.is_none());
    }

    #[test]
    fn matches_only_untracked_and_ignored_files_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        git::run(root.path(), &["init"]).unwrap();
        std::fs::create_dir(root.path().join("config")).unwrap();
        for (path, text) in [(".gitignore", ".env*\nconfig/\n"), (".env", "secret"), (".env.tracked", "tracked"), ("config/local.json", "{}"), ("loose.txt", "untracked"), ("other.txt", "skip")] {
            std::fs::write(root.path().join(path), text).unwrap();
        }
        git::run(root.path(), &["add", "-f", ".env.tracked"]).unwrap();
        let globs = vec![".env*".into(), "config/**".into(), "loose.txt".into()];
        assert_eq!(matching_files(root.path(), &globs), vec![PathBuf::from(".env"), PathBuf::from("config/local.json"), PathBuf::from("loose.txt")]);
        std::fs::write(target.path().join(".env"), "keep").unwrap();
        copy_files(root.path(), target.path(), &globs).unwrap();
        assert_eq!(std::fs::read_to_string(target.path().join(".env")).unwrap(), "keep");
        assert!(target.path().join("config/local.json").is_file());
        assert!(!target.path().join(".env.tracked").exists());
        assert!(matching_files(root.path(), &[]).is_empty());
        assert!(matcher(root.path(), &["[".into()]).is_err());
    }
}
