//! Mobile bridge: lets the companion phone app (ide_mobile) watch and drive workspaces over an
//! end-to-end encrypted WebSocket. Protocol: ide_mobile/docs/protocol.md.
//!
//! - `crypto.rs`  NaCl box (tweetnacl-compatible), keypair persistence format.
//! - `server.rs`  Transport, handshake, broadcast hub; Orbit-agnostic (`Backend` trait) so it is tested standalone.
//! - `push.rs`    Expo push on finished turns.
//! - this file    The Orbit backend (RPC allowlist), start/stop from settings, hooks and Tauri commands.
//!
//! Lock rule (see CLAUDE.md): never call something that locks `state.db()` while holding it.

pub mod crypto;
pub mod push;
pub mod server;

use crate::db::Workspace;
use crate::{AppState, CmdResult};
use crypto::{b64u, Keypair};
use serde::Serialize;
use serde_json::{json, Value};
use server::{Backend, Device, Hub, RunningServer, ServerConfig};
use std::net::{IpAddr, Ipv4Addr};
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
}

fn bridge() -> &'static Bridge {
    static B: OnceLock<Bridge> = OnceLock::new();
    B.get_or_init(|| Bridge {
        hub: Arc::new(Hub::new()),
        running: Mutex::new(None),
        error: Mutex::new(None),
        op: tokio::sync::Mutex::new(()),
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
            _ => Err("unknown method".into()),
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
    };
    let backend = Arc::new(OrbitBackend { app: app.clone(), state: state.clone() });
    match server::start(cfg, backend, b.hub.clone()).await {
        Ok(srv) => *b.running.lock().unwrap() = Some((port, srv)),
        Err(e) => *b.error.lock().unwrap() = Some(format!("Could not listen on port {port}: {e}")),
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
