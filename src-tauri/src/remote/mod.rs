//! Mobile bridge: lets the companion phone app (ide_mobile) watch and drive workspaces over an
//! end-to-end encrypted WebSocket. Protocol: ide_mobile/docs/protocol.md.
//!
//! - `crypto.rs`  NaCl box (tweetnacl-compatible), keypair persistence format.
//! - `server.rs`  Transport, handshake, broadcast hub; Orbit-agnostic (`Backend` trait) so it is tested standalone.
//! - `push.rs`    Expo push on finished turns.
//! - `review.rs`  Review scopes (file + commit lists) for local clients.
//! - this file    The Orbit backend (RPC allowlist), start/stop from settings, the local listener, hooks and Tauri commands.
//!
//! The same server also runs as an always-on loopback listener for local clients (`orb`, the
//! terminal UI): token auth from `<orbit home>/local.json`, then plaintext frames
//! (docs/tui/spec/protocol.md).
//!
//! Lock rule (see CLAUDE.md): never call something that locks `state.db()` while holding it.

pub mod crypto;
pub mod push;
pub mod review;
pub mod server;

#[cfg(test)]
mod orb_interop;

use crate::db::Workspace;
use crate::{AppState, CmdResult};
use crypto::{b64u, random_bytes, Keypair};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use server::{Backend, Device, Hub, Mode, RunningServer, ServerConfig};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, State};

const KEYPAIR_KEY: &str = "remote_keypair";
const DEVICES_KEY: &str = "remote_devices";

struct Bridge {
    hub: Arc<Hub>,
    /// Port the listener is bound to, while running.
    running: Mutex<Option<(u16, RunningServer)>>,
    error: Mutex<Option<String>>,
    /// Serializes start/stop so rapid setting changes cannot interleave.
    op: tokio::sync::Mutex<()>,
    /// The always-on loopback listener for local clients.
    local: Mutex<Option<LocalListener>>,
}

struct LocalListener {
    _server: RunningServer,
    file: PathBuf,
    token: String,
}

fn bridge() -> &'static Bridge {
    static B: OnceLock<Bridge> = OnceLock::new();
    B.get_or_init(|| Bridge {
        hub: Arc::new(Hub::new()),
        running: Mutex::new(None),
        error: Mutex::new(None),
        op: tokio::sync::Mutex::new(()),
        local: Mutex::new(None),
    })
}

// ---- hooks called from lib.rs (cheap no-ops when no phone is connected) ----

/// Mirrors an `agent-event` emitted to the desktop UI.
pub fn publish_event(payload: &crate::AgentEventPayload) {
    let hub = &bridge().hub;
    if !hub.has_listeners() {
        return;
    }
    if let Ok(Value::Object(mut m)) = serde_json::to_value(payload) {
        m.insert("t".into(), "event".into());
        hub.publish(Value::Object(m));
    }
}

/// Mirrors a `workspace` update emitted to the desktop UI.
pub fn publish_workspace(ws: &Workspace) {
    let hub = &bridge().hub;
    if hub.has_listeners() {
        hub.publish(json!({ "t": "workspace", "workspace": ws }));
    }
}

/// Called after a non-interrupted turn ends. Reads settings/devices (db locks) strictly before any I/O.
pub fn on_turn_completed(state: &AppState, ws: Option<&Workspace>, is_error: bool, error: Option<&str>) {
    let Some(ws) = ws else { return };
    let s = state.settings();
    if !(s.remote_enabled && s.remote_push) {
        return;
    }
    let devices = load_devices(state);
    push::notify_turn_done(devices, ws, is_error, error);
}

// ---- persistence ----

fn load_devices(state: &AppState) -> Vec<Device> {
    let raw = state.db().setting(DEVICES_KEY).ok().flatten();
    raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_devices(state: &AppState, devices: &[Device]) {
    if let Ok(s) = serde_json::to_string(devices) {
        let _ = state.db().set_setting(DEVICES_KEY, &s);
    }
}

fn orbit_keypair(state: &AppState) -> Keypair {
    let existing = state.db().setting(KEYPAIR_KEY).ok().flatten();
    if let Some(k) = existing.as_deref().and_then(Keypair::from_json) {
        return k;
    }
    let k = Keypair::generate();
    let _ = state.db().set_setting(KEYPAIR_KEY, &k.to_json());
    k
}

fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Orbit".into())
}

// ---- Orbit backend (the RPC allowlist) ----

struct OrbitBackend {
    app: AppHandle,
    state: AppState,
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| format!("missing {key}"))
}

/// An optional string (missing or null → empty).
fn opt_str_param(params: &Value, key: &str) -> Result<String, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(format!("{key} must be a string")),
    }
}

fn opt_bool_param(params: &Value, key: &str) -> Result<bool, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(format!("{key} must be a boolean")),
    }
}

/// `ref` of `fileAt`: the working tree or a commit.
#[derive(Debug, PartialEq)]
enum FileRef {
    Worktree,
    Sha(String),
}

/// The methods added for local clients (protocol 2), with their params validated before any state
/// is touched. The five phone methods are dispatched inline in [`OrbitBackend::rpc`], unchanged.
#[derive(Debug, PartialEq)]
enum Request {
    Hello,
    Dismiss { id: String },
    ListSkills { id: Option<String> },
    RunSkill { id: String, skill: String, args: String },
    PrStatus { id: String },
    Ship { id: String, skip_checks: bool },
    Merge { id: String, number: u64 },
    Review { id: String, scope: review::Scope },
    FileAt { id: String, path: String, file_ref: FileRef },
    SendReview { id: String, comments: Vec<crate::review_message::ReviewComment> },
}

fn parse_request(method: &str, params: &Value) -> Result<Request, String> {
    let id = || str_param(params, "workspaceId").map(str::to_string);
    Ok(match method {
        "hello" => Request::Hello,
        "dismiss" => Request::Dismiss { id: id()? },
        "listSkills" => Request::ListSkills { id: Some(opt_str_param(params, "workspaceId")?).filter(|s| !s.is_empty()) },
        "runSkill" => Request::RunSkill { id: id()?, skill: str_param(params, "skillId")?.to_string(), args: opt_str_param(params, "args")? },
        "prStatus" => Request::PrStatus { id: id()? },
        "ship" => Request::Ship { id: id()?, skip_checks: opt_bool_param(params, "skipChecks")? },
        "merge" => {
            let id = id()?;
            let number = params.get("number").and_then(Value::as_u64).filter(|n| *n > 0).ok_or("missing number")?;
            Request::Merge { id, number }
        }
        "review" => {
            let id = id()?;
            Request::Review { id, scope: review::Scope::parse(params.get("scope"))? }
        }
        "fileAt" => {
            let id = id()?;
            let path = str_param(params, "path")?.to_string();
            let file_ref = match str_param(params, "ref")? {
                "worktree" => FileRef::Worktree,
                sha if crate::code::fs::is_sha(sha) => FileRef::Sha(sha.to_string()),
                _ => return Err("ref must be \"worktree\" or a commit sha".into()),
            };
            Request::FileAt { id, path, file_ref }
        }
        "sendReview" => {
            let id = id()?;
            let comments: Vec<crate::review_message::ReviewComment> =
                serde_json::from_value(params.get("comments").cloned().ok_or("missing comments")?).map_err(|e| format!("invalid comments: {e}"))?;
            if comments.is_empty() {
                return Err("no comments to send".into());
            }
            if let Some(c) = comments.iter().find(|c| c.start_line == 0 || c.end_line < c.start_line || !matches!(c.side.as_str(), "old" | "new")) {
                return Err(format!("invalid comment on {}: lines are an inclusive 1-based range and side is old or new", c.path));
            }
            Request::SendReview { id, comments }
        }
        _ => return Err("unknown method".into()),
    })
}

/// Skills of the enabled packs: shipkit first, then by pack, then by name.
fn sort_skills(skills: &mut [crate::skills::Skill]) {
    skills.sort_by(|a, b| (a.pack != "shipkit").cmp(&(b.pack != "shipkit")).then_with(|| a.pack.cmp(&b.pack)).then_with(|| a.name.cmp(&b.name)));
}

fn to_json<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

impl OrbitBackend {
    /// The workspace row, or `unknown workspace`.
    fn workspace(&self, id: &str) -> Result<Workspace, String> {
        // Bind first: the guard must be gone before anything else locks the db.
        let found = self.state.db().workspace(id);
        found.map_err(|e| match e.downcast_ref::<rusqlite::Error>() {
            Some(rusqlite::Error::QueryReturnedNoRows) => "unknown workspace".to_string(),
            _ => crate::err(e),
        })
    }

    fn execute(&self, req: Request) -> Result<Value, String> {
        let (app, st) = (&self.app, &self.state);
        let e = crate::err;
        match req {
            Request::Hello => {
                let s = st.settings();
                Ok(json!({
                    "settings": { "staleDays": s.stale_days, "staleBehind": s.stale_behind, "saveCommits": s.save_commits },
                    "version": env!("CARGO_PKG_VERSION"),
                }))
            }
            Request::Dismiss { id } => {
                self.workspace(&id)?;
                let seq = st.db().dismiss(&id).map_err(e)?;
                Ok(json!(seq))
            }
            Request::ListSkills { id } => {
                let disabled = match id {
                    Some(id) => self.workspace(&id)?.disabled_packs,
                    None => vec![],
                };
                let packs = st.packs().map_err(e)?;
                let mut skills = crate::skills::list_skills(&crate::skills::effective_packs(&packs, &disabled));
                sort_skills(&mut skills);
                to_json(skills)
            }
            Request::RunSkill { id, skill, args } => {
                self.workspace(&id)?;
                crate::run_skill_with(app, st, &id, &skill, &args, &args)?;
                Ok(Value::Null)
            }
            Request::PrStatus { id } => {
                let ws = self.workspace(&id)?;
                let pr = crate::gh::pr_status(Path::new(&ws.path), &ws.branch).map_err(e)?;
                if pr.as_ref().is_some_and(|p| p.state == "OPEN") {
                    crate::review::after_ship(app, st, &id);
                }
                to_json(pr)
            }
            Request::Ship { id, skip_checks } => {
                self.workspace(&id)?;
                // Mirrors `ship` in src/stores/app.ts: the gate, then the shipping skill when it passed.
                let prepared = tauri::async_runtime::block_on(crate::trunk::prepare_ship_inner(app, st, &id, skip_checks))?;
                if prepared.ok {
                    let notes = prepared.notes.clone().unwrap_or_default();
                    crate::run_skill_with(app, st, &id, "shipkit:ship", &notes, &notes)?;
                }
                to_json(prepared)
            }
            Request::Merge { id, number } => {
                let ws = self.workspace(&id)?;
                let settings = st.settings();
                let delete = settings.delete_branch_on_merge.then_some(ws.branch.as_str());
                crate::gh::merge(Path::new(&ws.path), number, &settings.merge_method, delete).map_err(e)?;
                // Archive/cleanup and syncing the other workspaces; neither can fail the merge itself.
                to_json(tauri::async_runtime::block_on(crate::trunk::after_merge(app, st, &id)))
            }
            Request::Review { id, scope } => {
                let ws = self.workspace(&id)?;
                let repo = st.db().repo(&ws.repo_id).map_err(e)?;
                let save_commits = st.settings().save_commits;
                let events = st.db().events(&id).map_err(e)?;
                let turn_shas: Vec<String> = events
                    .into_iter()
                    .filter(|ev| matches!(ev.event, crate::AgentEvent::TurnCompleted { .. }))
                    .filter_map(|ev| ev.commit_sha)
                    .collect();
                to_json(review::review(Path::new(&ws.path), &repo.base_branch, &scope, &turn_shas, save_commits)?)
            }
            Request::FileAt { id, path, file_ref } => {
                let ws = self.workspace(&id)?;
                let file = match file_ref {
                    FileRef::Worktree => crate::code::fs::file_at_worktree(&ws.path, &path)?,
                    FileRef::Sha(sha) => crate::code::fs::file_at_sha(&ws.path, &path, &sha)?,
                };
                to_json(file)
            }
            Request::SendReview { id, comments } => {
                self.workspace(&id)?;
                let text = crate::review_message::review_message(&comments);
                crate::send(app, st, &id, text.clone(), None, text).map_err(e)?;
                Ok(Value::Null)
            }
        }
    }
}

impl Backend for OrbitBackend {
    fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let st = &self.state;
        let e = |e: anyhow::Error| e.to_string();
        let j = |e: serde_json::Error| e.to_string();
        match method {
            "snapshot" => {
                let db = st.db();
                let repos = db.repos().map_err(e)?;
                let workspaces = db.workspaces().map_err(e)?;
                let summaries = workspaces.iter().map(|w| db.summary(&w.id).map_err(e)).collect::<Result<Vec<_>, _>>()?;
                serde_json::to_value(json!({ "repos": repos, "workspaces": workspaces, "summaries": summaries })).map_err(j)
            }
            "events" => {
                let id = str_param(&params, "workspaceId")?;
                let since = params.get("sinceSeq").and_then(Value::as_i64);
                let mut events = st.db().events(id).map_err(e)?;
                if let Some(since) = since {
                    events.retain(|ev| ev.seq > since);
                }
                serde_json::to_value(events).map_err(j)
            }
            "send" => {
                let id = str_param(&params, "workspaceId")?;
                let text = str_param(&params, "text")?.to_string();
                crate::send(&self.app, st, id, text.clone(), None, text).map_err(e)?;
                Ok(Value::Null)
            }
            "interrupt" => {
                let id = str_param(&params, "workspaceId")?;
                if let Some(h) = st.sessions_lock().get(id) {
                    h.send(crate::Command::Interrupt);
                }
                Ok(Value::Null)
            }
            "markSeen" => {
                let id = str_param(&params, "workspaceId")?;
                let seq = st.db().mark_seen(id).map_err(e)?;
                Ok(json!(seq))
            }
            _ => self.execute(parse_request(method, &params)?),
        }
    }

    fn devices(&self) -> Vec<Device> {
        load_devices(&self.state)
    }

    fn save_devices(&self, devices: &[Device]) {
        save_devices(&self.state, devices);
    }
}

/// Device persistence only, for commands that edit the list outside a socket.
struct DeviceStore(AppState);

impl Backend for DeviceStore {
    fn rpc(&self, _: &str, _: Value) -> Result<Value, String> {
        Err("unused".into())
    }
    fn devices(&self) -> Vec<Device> {
        load_devices(&self.0)
    }
    fn save_devices(&self, devices: &[Device]) {
        save_devices(&self.0, devices);
    }
}

// ---- lifecycle ----

/// Brings the listener in line with settings (call at startup and after settings change).
pub async fn apply(app: &AppHandle, state: &AppState) {
    let s = state.settings();
    let b = bridge();
    let _op = b.op.lock().await;
    let want = s.remote_enabled.then_some(s.remote_port);
    let current = b.running.lock().unwrap().as_ref().map(|(p, _)| *p);
    if current == want && (want.is_some() || b.error.lock().unwrap().is_none()) {
        return;
    }
    // Dropping the old server stops it and closes its sockets.
    let old = b.running.lock().unwrap().take();
    drop(old);
    *b.error.lock().unwrap() = None;
    let Some(port) = want else { return };
    let cfg = ServerConfig {
        keypair: orbit_keypair(state),
        name: machine_name(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        port,
        mode: Mode::Phone,
    };
    let backend = Arc::new(OrbitBackend { app: app.clone(), state: state.clone() });
    match server::start(cfg, backend, b.hub.clone()).await {
        Ok(srv) => *b.running.lock().unwrap() = Some((port, srv)),
        Err(e) => *b.error.lock().unwrap() = Some(format!("Could not listen on port {port}: {e}")),
    }
}

// ---- local listener (orb) ----

pub const LOCAL_FILE: &str = "local.json";

/// `<orbit home>/local.json`: how local clients find and authenticate to the running app.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LocalInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
    pub protocol: u32,
}

/// Writes `local.json` atomically (temp file + rename), owner-only on Unix.
pub fn write_local_file(home: &Path, info: &LocalInfo) -> std::io::Result<PathBuf> {
    use std::io::Write;
    std::fs::create_dir_all(home)?;
    let path = home.join(LOCAL_FILE);
    let temp = home.join(format!(".{LOCAL_FILE}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&temp)?;
        f.write_all(serde_json::to_string_pretty(info).map_err(std::io::Error::other)?.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&temp, &path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    Ok(path)
}

/// Deletes `local.json` if it is still ours (a newer launch may have replaced it).
fn remove_local_file(file: &Path, token: &str) {
    let ours = std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<LocalInfo>(&s).ok())
        .is_some_and(|info| info.token == token);
    if ours {
        let _ = std::fs::remove_file(file);
    }
}

/// Starts the loopback listener for local clients (always on, whatever Settings > Mobile says) and
/// publishes its port and a fresh token in `local.json`.
pub async fn start_local(app: &AppHandle, state: &AppState) {
    let token = b64u(&random_bytes::<32>());
    let version = env!("CARGO_PKG_VERSION").to_string();
    let cfg = ServerConfig {
        keypair: orbit_keypair(state),
        name: machine_name(),
        version: version.clone(),
        bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
        port: 0,
        mode: Mode::Local { token: token.clone() },
    };
    let backend = Arc::new(OrbitBackend { app: app.clone(), state: state.clone() });
    let server = match server::start(cfg, backend, bridge().hub.clone()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("local listener: could not bind 127.0.0.1: {e}");
            return;
        }
    };
    let info = LocalInfo { port: server.addr.port(), token: token.clone(), pid: std::process::id(), version, protocol: server::PROTOCOL_VERSION };
    match write_local_file(&state.home, &info) {
        Ok(file) => *bridge().local.lock().unwrap() = Some(LocalListener { _server: server, file, token }),
        Err(e) => eprintln!("local listener: could not write {}: {e}", state.home.join(LOCAL_FILE).display()),
    }
}

/// On app exit: stop the local listener and delete `local.json` (best effort).
pub fn stop_local() {
    let local = bridge().local.lock().unwrap().take();
    if let Some(l) = local {
        remove_local_file(&l.file, &l.token);
    }
}

/// Non-loopback IPv4 addresses, Tailscale (100.64.0.0/10) first.
fn local_addresses() -> Vec<String> {
    let mut v: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() => Some(ip),
            _ => None,
        })
        .collect();
    v.sort_by_key(|ip| !is_tailscale(ip));
    v.dedup();
    v.into_iter().map(|ip| ip.to_string()).collect()
}

fn is_tailscale(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, 0x2d | 0x5f | 0x2e | 0x7e) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn pairing_uri(pk: &[u8; 32], code: &str, port: u16, hosts: &[String], name: &str) -> String {
    format!("orbit://pair?v=1&pk={}&code={code}&port={port}&hosts={}&name={}", b64u(pk), hosts.join(","), percent_encode(name))
}

// ---- Tauri commands ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    running: bool,
    port: u16,
    addresses: Vec<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairing {
    uri: String,
    svg: String,
    expires_at: i64,
}

#[tauri::command]
pub fn remote_status(state: State<AppState>) -> RemoteStatus {
    let b = bridge();
    let running = b.running.lock().unwrap().as_ref().map(|(p, _)| *p);
    let port = running.unwrap_or_else(|| state.settings().remote_port);
    let error = b.error.lock().unwrap().clone();
    RemoteStatus { running: running.is_some(), port, addresses: local_addresses(), error }
}

#[tauri::command]
pub fn remote_pairing(state: State<AppState>) -> CmdResult<RemotePairing> {
    let port = bridge().running.lock().unwrap().as_ref().map(|(p, _)| *p).ok_or("Turn on \"Allow phone connections\" first")?;
    let hosts = local_addresses();
    if hosts.is_empty() {
        return Err("No network address found for this computer".into());
    }
    let kp = orbit_keypair(&state);
    let (code, expires_at) = bridge().hub.new_pairing();
    let uri = pairing_uri(&kp.public(), &code, port, &hosts, &machine_name());
    let svg = qrcode::QrCode::new(uri.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    Ok(RemotePairing { uri, svg, expires_at })
}

#[tauri::command]
pub fn remote_devices(state: State<AppState>) -> Vec<Device> {
    let mut list = load_devices(&state);
    list.sort_by_key(|d| std::cmp::Reverse(d.last_seen_at));
    list
}

/// Deletes the device record and closes its live sockets.
#[tauri::command]
pub fn remote_revoke(state: State<AppState>, id: String) -> CmdResult<()> {
    let hub = &bridge().hub;
    // Same read-modify-write path the server uses, so a concurrent auth cannot resurrect the record.
    hub.mutate_devices(&DeviceStore(state.inner().clone()), |list| list.retain(|d| d.id != id));
    hub.revoke(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_file_is_atomic_owner_only_and_removed_only_when_ours() {
        let home = tempfile::tempdir().unwrap();
        let nested = home.path().join("orbit-home");
        let info = LocalInfo { port: 51234, token: b64u(&random_bytes::<32>()), pid: 42, version: "0.4.0".into(), protocol: 2 };
        let path = write_local_file(&nested, &info).unwrap();
        assert_eq!(path, nested.join("local.json"));
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw, json!({ "port": 51234, "token": info.token, "pid": 42, "version": "0.4.0", "protocol": 2 }));
        assert_eq!(info.token.len(), 43, "b64url of 32 bytes, unpadded");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Rewriting replaces it in place and leaves no temp files.
        let next = LocalInfo { port: 1, token: "other".into(), ..info.clone() };
        write_local_file(&nested, &next).unwrap();
        let names: Vec<_> = std::fs::read_dir(&nested).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("local.json")]);
        // A stale launch's token does not delete the newer file; the owner's does.
        remove_local_file(&path, &info.token);
        assert!(path.exists());
        remove_local_file(&path, "other");
        assert!(!path.exists());
    }

    #[test]
    fn parses_new_methods_and_validates_params() {
        let p = |m: &str, v: Value| parse_request(m, &v);
        let ws = |extra: Value| {
            let mut v = json!({ "workspaceId": "w1" });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        assert_eq!(p("hello", json!({})), Ok(Request::Hello));
        assert_eq!(p("nope", json!({})), Err("unknown method".into()));
        // Every method that takes a workspace requires it.
        for m in ["dismiss", "runSkill", "prStatus", "ship", "merge", "review", "fileAt", "sendReview"] {
            assert_eq!(p(m, json!({})), Err("missing workspaceId".into()), "{m}");
            assert_eq!(p(m, json!({ "workspaceId": "" })), Err("missing workspaceId".into()), "{m}");
        }
        assert_eq!(p("dismiss", ws(json!({}))), Ok(Request::Dismiss { id: "w1".into() }));
        assert_eq!(p("prStatus", ws(json!({}))), Ok(Request::PrStatus { id: "w1".into() }));

        assert_eq!(p("listSkills", json!({})), Ok(Request::ListSkills { id: None }));
        assert_eq!(p("listSkills", ws(json!({}))), Ok(Request::ListSkills { id: Some("w1".into()) }));
        assert!(p("listSkills", json!({ "workspaceId": 3 })).is_err());

        assert_eq!(p("runSkill", ws(json!({}))), Err("missing skillId".into()));
        assert_eq!(
            p("runSkill", ws(json!({ "skillId": "shipkit:ship" }))),
            Ok(Request::RunSkill { id: "w1".into(), skill: "shipkit:ship".into(), args: String::new() })
        );
        assert_eq!(
            p("runSkill", ws(json!({ "skillId": "a:b", "args": "x y" }))),
            Ok(Request::RunSkill { id: "w1".into(), skill: "a:b".into(), args: "x y".into() })
        );
        assert_eq!(p("runSkill", ws(json!({ "skillId": "a:b", "args": 1 }))), Err("args must be a string".into()));

        assert_eq!(p("ship", ws(json!({}))), Ok(Request::Ship { id: "w1".into(), skip_checks: false }));
        assert_eq!(p("ship", ws(json!({ "skipChecks": true }))), Ok(Request::Ship { id: "w1".into(), skip_checks: true }));
        assert_eq!(p("ship", ws(json!({ "skipChecks": "yes" }))), Err("skipChecks must be a boolean".into()));

        assert_eq!(p("merge", ws(json!({}))), Err("missing number".into()));
        assert_eq!(p("merge", ws(json!({ "number": "12" }))), Err("missing number".into()));
        assert_eq!(p("merge", ws(json!({ "number": 12 }))), Ok(Request::Merge { id: "w1".into(), number: 12 }));

        assert_eq!(p("review", ws(json!({}))), Err("missing scope".into()));
        assert_eq!(p("review", ws(json!({ "scope": { "kind": "turn" } }))), Ok(Request::Review { id: "w1".into(), scope: review::Scope::Turn }));
        assert_eq!(p("review", ws(json!({ "scope": { "kind": "commit", "sha": "nothex!" } }))), Err("invalid sha".into()));

        assert_eq!(p("fileAt", ws(json!({ "ref": "worktree" }))), Err("missing path".into()));
        assert_eq!(p("fileAt", ws(json!({ "path": "a" }))), Err("missing ref".into()));
        assert_eq!(
            p("fileAt", ws(json!({ "path": "a", "ref": "worktree" }))),
            Ok(Request::FileAt { id: "w1".into(), path: "a".into(), file_ref: FileRef::Worktree })
        );
        assert_eq!(
            p("fileAt", ws(json!({ "path": "a", "ref": "abcdef0" }))),
            Ok(Request::FileAt { id: "w1".into(), path: "a".into(), file_ref: FileRef::Sha("abcdef0".into()) })
        );
        for bad in ["HEAD", "base", "abc", "main~1"] {
            assert!(p("fileAt", ws(json!({ "path": "a", "ref": bad }))).is_err(), "{bad}");
        }

        let c = json!({ "path": "a.rs", "startLine": 2, "endLine": 3, "side": "new", "text": "t", "excerpt": "e" });
        assert_eq!(p("sendReview", ws(json!({}))), Err("missing comments".into()));
        assert_eq!(p("sendReview", ws(json!({ "comments": [] }))), Err("no comments to send".into()));
        assert!(p("sendReview", ws(json!({ "comments": [{ "path": "a" }] }))).unwrap_err().starts_with("invalid comments"));
        let Ok(Request::SendReview { comments, .. }) = p("sendReview", ws(json!({ "comments": [c] }))) else { panic!("sendReview should parse") };
        assert_eq!((comments[0].start_line, comments[0].end_line, comments[0].side.as_str()), (2, 3, "new"));
        for bad in [json!({ "startLine": 0 }), json!({ "endLine": 1 }), json!({ "side": "left" })] {
            let mut c = c.clone();
            c.as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());
            assert!(p("sendReview", ws(json!({ "comments": [c] }))).unwrap_err().starts_with("invalid comment on a.rs"));
        }
    }

    #[test]
    fn skills_sort_shipkit_first_then_pack_then_name() {
        let sk = |pack: &str, name: &str| crate::skills::Skill {
            id: format!("{pack}:{name}"),
            pack: pack.into(),
            kind: crate::skills::SkillKind::Skill,
            name: name.into(),
            description: String::new(),
            argument_hint: None,
            path: String::new(),
        };
        let mut v = vec![sk("alpha", "z"), sk("shipkit", "ship"), sk("alpha", "a"), sk("shipkit", "fix-ci"), sk("beta", "a")];
        sort_skills(&mut v);
        let ids: Vec<_> = v.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["shipkit:fix-ci", "shipkit:ship", "alpha:a", "alpha:z", "beta:a"]);
    }

    #[test]
    fn tailscale_range() {
        assert!(is_tailscale(&"100.101.2.3".parse().unwrap()));
        assert!(!is_tailscale(&"100.200.2.3".parse().unwrap()));
        assert!(!is_tailscale(&"192.168.1.5".parse().unwrap()));
    }

    #[test]
    fn pairing_uri_shape() {
        let uri = pairing_uri(&[0xfb; 32], "CODE", 47821, &["100.1.2.3".into(), "192.168.1.5".into()], "My PC");
        assert!(uri.starts_with("orbit://pair?v=1&pk=-"));
        assert!(uri.ends_with("&code=CODE&port=47821&hosts=100.1.2.3,192.168.1.5&name=My%20PC"));
        // base64url, unpadded.
        let pk = uri.split("pk=").nth(1).unwrap().split('&').next().unwrap();
        assert!(!pk.contains('=') && !pk.contains('+') && !pk.contains('/'));
    }
}
