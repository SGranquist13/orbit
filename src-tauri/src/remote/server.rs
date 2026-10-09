//! Transport + handshake for the phone bridge (see ide_mobile/docs/protocol.md). Knows nothing about
//! Orbit: the RPC dispatch and device persistence sit behind [`Backend`], so tests run a real server
//! with a fake backend on a random port.

use super::crypto::{b64, b64u, parse_pk, random_bytes, Keypair, Sealed};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, watch};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

pub const PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_PORT: u16 = 47821;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(20);
pub const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    /// b64 X25519 public key.
    pub public_key: String,
    pub push_token: Option<String>,
    pub paired_at: i64,
    pub last_seen_at: i64,
}

/// Orbit-specific half of the bridge.
pub trait Backend: Send + Sync + 'static {
    /// Runs one allowlisted RPC (everything except `registerPush`, which the server handles itself).
    fn rpc(&self, method: &str, params: Value) -> Result<Value, String>;
    fn devices(&self) -> Vec<Device>;
    fn save_devices(&self, devices: &[Device]);
}

struct Pairing {
    code: String,
    expires: Instant,
}

/// Shared between the server tasks and the rest of Orbit (event publishing, pairing, revocation).
pub struct Hub {
    messages: broadcast::Sender<Arc<Value>>,
    revoked: broadcast::Sender<String>,
    pairing: Mutex<Option<Pairing>>,
    devices_lock: Mutex<()>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        Self {
            messages: broadcast::channel(2048).0,
            revoked: broadcast::channel(64).0,
            pairing: Mutex::new(None),
            devices_lock: Mutex::new(()),
        }
    }

    pub fn has_listeners(&self) -> bool {
        self.messages.receiver_count() > 0
    }

    /// Sends a plaintext protocol message (`event` / `workspace`) to every connected phone.
    pub fn publish(&self, msg: Value) {
        let _ = self.messages.send(Arc::new(msg));
    }

    /// Closes the live sockets of a device.
    pub fn revoke(&self, device_id: &str) {
        let _ = self.revoked.send(device_id.to_string());
    }

    /// New single-use code (b64url of 16 random bytes); replaces any previous one.
    /// Returns `(code, expiresAt ms)`.
    pub fn new_pairing(&self) -> (String, i64) {
        self.new_pairing_ttl(PAIRING_TTL)
    }

    pub fn new_pairing_ttl(&self, ttl: Duration) -> (String, i64) {
        let code = b64u(&random_bytes::<16>());
        let expires_at_ms = now_ms() + ttl.as_millis() as i64;
        *self.pairing.lock().unwrap() = Some(Pairing { code: code.clone(), expires: Instant::now() + ttl });
        (code, expires_at_ms)
    }

    /// Consumes the code if it is the current one. Errors are protocol codes.
    fn take_pairing(&self, code: &str) -> Result<(), &'static str> {
        let mut slot = self.pairing.lock().unwrap();
        match slot.as_ref() {
            Some(p) if p.code == code => {
                let expired = Instant::now() >= p.expires;
                *slot = None;
                if expired {
                    Err("code_expired")
                } else {
                    Ok(())
                }
            }
            _ => Err("bad_code"),
        }
    }

    /// Read-modify-write on the persisted device list, serialized across connections.
    pub fn mutate_devices<R>(&self, backend: &dyn Backend, f: impl FnOnce(&mut Vec<Device>) -> R) -> R {
        let _g = self.devices_lock.lock().unwrap();
        let mut list = backend.devices();
        let r = f(&mut list);
        backend.save_devices(&list);
        r
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Clone)]
pub struct ServerConfig {
    pub keypair: Keypair,
    pub name: String,
    pub version: String,
    pub bind: IpAddr,
    pub port: u16,
}

pub struct RunningServer {
    #[cfg_attr(not(test), allow(dead_code))]
    pub addr: SocketAddr,
    shutdown: watch::Sender<bool>,
}

impl RunningServer {
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.stop();
    }
}

pub async fn start(cfg: ServerConfig, backend: Arc<dyn Backend>, hub: Arc<Hub>) -> std::io::Result<RunningServer> {
    let listener = TcpListener::bind(SocketAddr::new(cfg.bind, cfg.port)).await?;
    let addr = listener.local_addr()?;
    let (shutdown, mut stop) = watch::channel(false);
    let cfg = Arc::new(cfg);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let (cfg, backend, hub, stop) = (cfg.clone(), backend.clone(), hub.clone(), stop.clone());
                    tokio::spawn(async move {
                        let _ = handle_connection(stream, cfg, backend, hub, stop).await;
                    });
                }
            }
        }
    });
    Ok(RunningServer { addr, shutdown })
}

type Ws = WebSocketStream<TcpStream>;

async fn send_json(ws: &mut Ws, v: &Value) -> Result<(), ()> {
    ws.send(Message::text(v.to_string())).await.map_err(|_| ())
}

async fn send_error(ws: &mut Ws, code: &str, message: &str) {
    let _ = send_json(ws, &json!({ "t": "error", "code": code, "message": message })).await;
    let _ = ws.close(None).await;
}

fn check_path(req: &Request, resp: Response) -> Result<Response, ErrorResponse> {
    if req.uri().path() == "/v1" {
        Ok(resp)
    } else {
        let mut r = ErrorResponse::new(Some("not found".into()));
        *r.status_mut() = StatusCode::NOT_FOUND;
        Err(r)
    }
}

struct Authed {
    device: Device,
    peer: [u8; 32],
}

async fn handle_connection(
    stream: TcpStream,
    cfg: Arc<ServerConfig>,
    backend: Arc<dyn Backend>,
    hub: Arc<Hub>,
    mut stop: watch::Receiver<bool>,
) -> Result<(), ()> {
    let mut ws = tokio_tungstenite::accept_hdr_async(stream, check_path).await.map_err(|_| ())?;
    // Subscribe before the handshake completes so nothing is missed between `ready` and the loop.
    let mut messages = hub.messages.subscribe();
    let mut revoked = hub.revoked.subscribe();

    let challenge = b64(&random_bytes::<32>());
    send_json(
        &mut ws,
        &json!({ "t": "hello", "v": PROTOCOL_VERSION, "pk": b64(&cfg.keypair.public()), "challenge": challenge, "name": cfg.name }),
    )
    .await?;

    let authed = match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut ws, &cfg, &*backend, &hub, &challenge)).await {
        Ok(Ok(a)) => a,
        Ok(Err((code, message))) => {
            send_error(&mut ws, code, &message).await;
            return Err(());
        }
        Err(_) => {
            send_error(&mut ws, "protocol", "handshake timed out").await;
            return Err(());
        }
    };
    let Authed { device, peer } = authed;
    let ready = cfg.keypair.seal_json(&peer, &json!({ "deviceId": device.id, "orbit": { "name": cfg.name, "version": cfg.version } }));
    send_json(&mut ws, &json!({ "t": "ready", "box": ready })).await?;

    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            _ = ping.tick() => {
                if ws.send(Message::Ping(Vec::new().into())).await.is_err() { break }
            }
            id = revoked.recv() => {
                match id {
                    Ok(id) if id == device.id => break,
                    Err(broadcast::error::RecvError::Closed) => break,
                    _ => {}
                }
            }
            msg = messages.recv() => {
                match msg {
                    Ok(m) => {
                        let sealed = cfg.keypair.seal_json(&peer, &m);
                        if send_json(&mut ws, &box_frame(&sealed)).await.is_err() { break }
                    }
                    // Fell behind: the phone notices the seq gap and refetches.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            frame = ws.next() => {
                let Some(Ok(frame)) = frame else { break };
                match frame {
                    Message::Text(t) => {
                        let Some(req) = open_box_frame(&cfg.keypair, &peer, t.as_str()) else {
                            send_error(&mut ws, "protocol", "expected a valid box frame").await;
                            break;
                        };
                        if let Some(reply) = run_rpc(&req, &device.id, backend.clone(), hub.clone()).await {
                            let sealed = cfg.keypair.seal_json(&peer, &reply);
                            if send_json(&mut ws, &box_frame(&sealed)).await.is_err() { break }
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                    _ => {
                        send_error(&mut ws, "protocol", "text frames only").await;
                        break;
                    }
                }
            }
        }
    }
    Ok(())
}

fn box_frame(s: &Sealed) -> Value {
    json!({ "t": "box", "n": s.n, "c": s.c })
}

fn open_box_frame(kp: &Keypair, peer: &[u8; 32], text: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("t")?.as_str()? != "box" {
        return None;
    }
    let sealed = Sealed { n: v.get("n")?.as_str()?.into(), c: v.get("c")?.as_str()?.into() };
    kp.open_json(peer, &sealed).ok()
}

async fn run_rpc(req: &Value, device_id: &str, backend: Arc<dyn Backend>, hub: Arc<Hub>) -> Option<Value> {
    if req.get("t").and_then(Value::as_str) != Some("rpc") {
        return None;
    }
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
    let device_id = device_id.to_string();
    // Backend calls take std mutexes and may spawn agents; keep them off the socket task.
    let result = tokio::task::spawn_blocking(move || {
        if method == "registerPush" {
            register_push(&*backend, &hub, &device_id, &params)
        } else {
            backend.rpc(&method, params)
        }
    })
    .await
    .unwrap_or_else(|e| Err(format!("internal error: {e}")));
    Some(match result {
        Ok(v) => json!({ "t": "rpc-result", "id": id, "ok": true, "result": v }),
        Err(e) => json!({ "t": "rpc-result", "id": id, "ok": false, "error": e }),
    })
}

fn register_push(backend: &dyn Backend, hub: &Hub, device_id: &str, params: &Value) -> Result<Value, String> {
    let token = match params.get("token") {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::String(_)) | Some(Value::Null) | None => None,
        _ => return Err("token must be a string or null".into()),
    };
    let found = hub.mutate_devices(backend, |list| match list.iter_mut().find(|d| d.id == device_id) {
        Some(d) => {
            d.push_token = token;
            true
        }
        None => false,
    });
    if found {
        Ok(Value::Null)
    } else {
        Err("unknown device".into())
    }
}

type HandshakeError = (&'static str, String);

async fn next_text(ws: &mut Ws) -> Result<String, HandshakeError> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => return Ok(t.as_str().to_string()),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            _ => return Err(("protocol", "expected a text frame".into())),
        }
    }
}

async fn handshake(ws: &mut Ws, cfg: &ServerConfig, backend: &dyn Backend, hub: &Hub, challenge: &str) -> Result<Authed, HandshakeError> {
    let text = next_text(ws).await?;
    let msg: Value = serde_json::from_str(&text).map_err(|_| ("protocol", "invalid json".to_string()))?;
    let kind = msg.get("t").and_then(Value::as_str).unwrap_or("");
    if kind != "pair" && kind != "auth" {
        return Err(("protocol", "expected pair or auth".into()));
    }
    let pk_str = msg.get("pk").and_then(Value::as_str).ok_or(("protocol", "missing pk".to_string()))?;
    let peer = parse_pk(pk_str).map_err(|e| ("bad_box", e))?;
    let sealed: Sealed = msg
        .get("box")
        .cloned()
        .and_then(|b| serde_json::from_value(b).ok())
        .ok_or(("protocol", "missing box".to_string()))?;
    let body = cfg.keypair.open_json(&peer, &sealed).map_err(|e| ("bad_box", e))?;
    if body.get("challenge").and_then(Value::as_str) != Some(challenge) {
        return Err(("bad_challenge", "challenge does not match this connection".into()));
    }
    let now = now_ms();
    let pk_b64 = b64(&peer);
    if kind == "pair" {
        let code = body.get("code").and_then(Value::as_str).unwrap_or("");
        hub.take_pairing(code).map_err(|c| (c, if c == "code_expired" { "pairing code expired" } else { "unknown pairing code" }.to_string()))?;
        let name: String = body.get("name").and_then(Value::as_str).unwrap_or("Phone").trim().chars().take(64).collect();
        let name = if name.is_empty() { "Phone".to_string() } else { name };
        let device = hub.mutate_devices(backend, |list| {
            // Re-pairing the same phone keeps one record (and its id).
            let id = list
                .iter()
                .find(|d| d.public_key == pk_b64)
                .map(|d| d.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            list.retain(|d| d.id != id);
            let device = Device { id, name, public_key: pk_b64.clone(), push_token: None, paired_at: now, last_seen_at: now };
            list.push(device.clone());
            device
        });
        Ok(Authed { device, peer })
    } else {
        let device = hub.mutate_devices(backend, |list| {
            list.iter_mut().find(|d| d.public_key == pk_b64).map(|d| {
                d.last_seen_at = now;
                d.clone()
            })
        });
        device
            .map(|device| Authed { device, peer })
            .ok_or(("unknown_device", "this phone is not paired (or was revoked)".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio_tungstenite::MaybeTlsStream;

    #[derive(Default)]
    struct Fake {
        devices: Mutex<Vec<Device>>,
    }
    impl Backend for Fake {
        fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
            match method {
                "snapshot" => Ok(json!({ "repos": [], "workspaces": [], "summaries": [] })),
                "echo" => Ok(params),
                _ => Err("unknown method".into()),
            }
        }
        fn devices(&self) -> Vec<Device> {
            self.devices.lock().unwrap().clone()
        }
        fn save_devices(&self, d: &[Device]) {
            *self.devices.lock().unwrap() = d.to_vec();
        }
    }

    struct Rig {
        server: RunningServer,
        backend: Arc<Fake>,
        hub: Arc<Hub>,
        orbit: Keypair,
    }

    async fn rig() -> Rig {
        let orbit = Keypair::generate();
        let backend = Arc::new(Fake::default());
        let hub = Arc::new(Hub::new());
        let cfg = ServerConfig {
            keypair: orbit.clone(),
            name: "test-box".into(),
            version: "9.9.9".into(),
            bind: "127.0.0.1".parse().unwrap(),
            port: 0,
        };
        let server = start(cfg, backend.clone(), hub.clone()).await.unwrap();
        Rig { server, backend, hub, orbit }
    }

    type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

    async fn connect(r: &Rig, path: &str) -> Result<Client, tokio_tungstenite::tungstenite::Error> {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{}{}", r.server.addr, path)).await?;
        Ok(ws)
    }

    async fn recv_json(ws: &mut Client) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timed out").expect("closed").expect("ws error") {
                Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
                Message::Ping(_) | Message::Pong(_) => {}
                other => panic!("unexpected frame {other:?}"),
            }
        }
    }

    async fn hello(ws: &mut Client) -> (Value, [u8; 32]) {
        let h = recv_json(ws).await;
        assert_eq!(h["t"], "hello");
        assert_eq!(h["v"], 1);
        assert_eq!(h["name"], "test-box");
        let pk = parse_pk(h["pk"].as_str().unwrap()).unwrap();
        (h, pk)
    }

    async fn send(ws: &mut Client, v: Value) {
        ws.send(Message::text(v.to_string())).await.unwrap();
    }

    fn pair_msg(dev: &Keypair, orbit_pk: &[u8; 32], code: &str, challenge: &str) -> Value {
        let body = json!({ "code": code, "name": "Test phone", "challenge": challenge });
        json!({ "t": "pair", "pk": b64(&dev.public()), "box": dev.seal_json(orbit_pk, &body) })
    }

    fn auth_msg(dev: &Keypair, orbit_pk: &[u8; 32], challenge: &str) -> Value {
        json!({ "t": "auth", "pk": b64(&dev.public()), "box": dev.seal_json(orbit_pk, &json!({ "challenge": challenge })) })
    }

    /// Opens a connection and answers with `make(hello_challenge)`; returns the first reply.
    async fn attempt(r: &Rig, dev: &Keypair, make: impl FnOnce(&Keypair, &[u8; 32], &str) -> Value) -> Value {
        let mut ws = connect(r, "/v1").await.unwrap();
        let (h, opk) = hello(&mut ws).await;
        send(&mut ws, make(dev, &opk, h["challenge"].as_str().unwrap())).await;
        recv_json(&mut ws).await
    }

    fn assert_err(v: &Value, code: &str) {
        assert_eq!(v["t"], "error", "{v}");
        assert_eq!(v["code"], code, "{v}");
    }

    /// Pairs a fresh device and returns it with an open, ready socket.
    async fn paired(r: &Rig) -> (Keypair, Client, String) {
        let dev = Keypair::generate();
        let (code, _) = r.hub.new_pairing();
        let mut ws = connect(r, "/v1").await.unwrap();
        let (h, opk) = hello(&mut ws).await;
        send(&mut ws, pair_msg(&dev, &opk, &code, h["challenge"].as_str().unwrap())).await;
        let ready = recv_json(&mut ws).await;
        assert_eq!(ready["t"], "ready", "{ready}");
        let sealed: Sealed = serde_json::from_value(ready["box"].clone()).unwrap();
        let body = dev.open_json(&opk, &sealed).unwrap();
        assert_eq!(body["orbit"]["name"], "test-box");
        assert_eq!(body["orbit"]["version"], "9.9.9");
        (dev, ws, body["deviceId"].as_str().unwrap().to_string())
    }

    #[tokio::test]
    async fn pairs_then_reconnects_with_auth_and_calls_rpc() {
        let r = rig().await;
        let (dev, ws, id) = paired(&r).await;
        drop(ws);
        let saved = r.backend.devices();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id, id);
        assert_eq!(saved[0].name, "Test phone");
        assert_eq!(saved[0].public_key, b64(&dev.public()));

        let mut ws = connect(&r, "/v1").await.unwrap();
        let (h, opk) = hello(&mut ws).await;
        assert_eq!(opk, r.orbit.public());
        send(&mut ws, auth_msg(&dev, &opk, h["challenge"].as_str().unwrap())).await;
        let ready = recv_json(&mut ws).await;
        assert_eq!(ready["t"], "ready");

        // RPC round trip over the box.
        let call = |id: u64, method: &str, params: Value| {
            let sealed = dev.seal_json(&opk, &json!({ "t": "rpc", "id": id, "method": method, "params": params }));
            json!({ "t": "box", "n": sealed.n, "c": sealed.c })
        };
        send(&mut ws, call(1, "snapshot", json!({}))).await;
        send(&mut ws, call(2, "nope", json!({}))).await;
        send(&mut ws, call(3, "registerPush", json!({ "token": "ExponentPushToken[abc]" }))).await;
        let mut got: HashMap<u64, Value> = HashMap::new();
        for _ in 0..3 {
            let f = recv_json(&mut ws).await;
            assert_eq!(f["t"], "box");
            let m = dev.open_json(&opk, &Sealed { n: f["n"].as_str().unwrap().into(), c: f["c"].as_str().unwrap().into() }).unwrap();
            got.insert(m["id"].as_u64().unwrap(), m);
        }
        assert_eq!(got[&1]["ok"], true);
        assert!(got[&1]["result"]["repos"].is_array());
        assert_eq!(got[&2]["ok"], false);
        assert_eq!(got[&2]["error"], "unknown method");
        assert_eq!(got[&3]["ok"], true);
        assert_eq!(r.backend.devices()[0].push_token.as_deref(), Some("ExponentPushToken[abc]"));
        assert!(r.backend.devices()[0].last_seen_at >= saved[0].last_seen_at);
    }

    #[tokio::test]
    async fn rejects_bad_expired_and_replayed_codes() {
        let r = rig().await;
        let dev = Keypair::generate();

        // No code issued at all.
        let e = attempt(&r, &dev, |d, o, c| pair_msg(d, o, "whatever", c)).await;
        assert_err(&e, "bad_code");

        // Wrong code while one is active; the active one survives the failed attempt.
        let (code, _) = r.hub.new_pairing();
        let e = attempt(&r, &dev, |d, o, c| pair_msg(d, o, "wrong", c)).await;
        assert_err(&e, "bad_code");

        // The right code works once...
        let ok = attempt(&r, &dev, |d, o, c| pair_msg(d, o, &code, c)).await;
        assert_eq!(ok["t"], "ready");
        // ...and is single use.
        let e = attempt(&r, &Keypair::generate(), |d, o, c| pair_msg(d, o, &code, c)).await;
        assert_err(&e, "bad_code");

        // A newer QR replaces the older code.
        let (old, _) = r.hub.new_pairing();
        let (new, _) = r.hub.new_pairing();
        let e = attempt(&r, &Keypair::generate(), |d, o, c| pair_msg(d, o, &old, c)).await;
        assert_err(&e, "bad_code");
        let ok = attempt(&r, &Keypair::generate(), |d, o, c| pair_msg(d, o, &new, c)).await;
        assert_eq!(ok["t"], "ready");

        // Expired.
        let (stale, _) = r.hub.new_pairing_ttl(Duration::from_millis(0));
        let e = attempt(&r, &Keypair::generate(), |d, o, c| pair_msg(d, o, &stale, c)).await;
        assert_err(&e, "code_expired");
    }

    #[tokio::test]
    async fn rejects_unknown_device_bad_challenge_bad_box_and_protocol() {
        let r = rig().await;

        let e = attempt(&r, &Keypair::generate(), |d, o, c| auth_msg(d, o, c)).await;
        assert_err(&e, "unknown_device");

        // Replayed challenge: a valid auth for a paired device, but sealed for another connection's challenge.
        let (dev, ws, _) = paired(&r).await;
        drop(ws);
        let mut first = connect(&r, "/v1").await.unwrap();
        let (h1, opk) = hello(&mut first).await;
        let captured = auth_msg(&dev, &opk, h1["challenge"].as_str().unwrap());
        drop(first);
        let e = attempt(&r, &dev, |_, _, _| captured).await;
        assert_err(&e, "bad_challenge");

        // Box sealed to the wrong key.
        let e = attempt(&r, &dev, |d, _o, c| auth_msg(d, &Keypair::generate().public(), c)).await;
        assert_err(&e, "bad_box");

        // Garbage and wrong message types.
        let mut ws = connect(&r, "/v1").await.unwrap();
        hello(&mut ws).await;
        send(&mut ws, json!({ "t": "rpc", "id": 1 })).await;
        assert_err(&recv_json(&mut ws).await, "protocol");

        let mut ws = connect(&r, "/v1").await.unwrap();
        hello(&mut ws).await;
        ws.send(Message::text("not json")).await.unwrap();
        assert_err(&recv_json(&mut ws).await, "protocol");

        // Plaintext after ready is a protocol error.
        let (_dev, mut ws, _) = paired(&r).await;
        send(&mut ws, json!({ "t": "rpc", "id": 1, "method": "snapshot" })).await;
        assert_err(&recv_json(&mut ws).await, "protocol");
    }

    #[tokio::test]
    async fn wrong_path_is_refused() {
        let r = rig().await;
        assert!(connect(&r, "/other").await.is_err());
    }

    #[tokio::test]
    async fn broadcast_reaches_paired_sockets_and_revoke_closes_them() {
        let r = rig().await;
        let (dev, mut ws, id) = paired(&r).await;
        let opk = r.orbit.public();
        r.hub.publish(json!({ "t": "event", "workspaceId": "w1", "seq": null, "ts": 1, "event": { "type": "textDelta", "text": "hi" } }));
        let f = recv_json(&mut ws).await;
        let m = dev.open_json(&opk, &Sealed { n: f["n"].as_str().unwrap().into(), c: f["c"].as_str().unwrap().into() }).unwrap();
        assert_eq!(m["t"], "event");
        assert_eq!(m["seq"], Value::Null);
        assert_eq!(m["event"]["text"], "hi");

        // Revoking another device leaves this socket alone; revoking this one closes it.
        r.hub.revoke("someone-else");
        r.hub.revoke(&id);
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("socket should close") {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    }

    #[tokio::test]
    async fn stopping_the_server_closes_live_sockets() {
        // Stopping the server closes live sockets.
        let r = rig().await;
        let (_dev, mut ws, _) = paired(&r).await;
        r.server.stop();
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("socket should close") {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    }
}
