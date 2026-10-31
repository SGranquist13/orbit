//! Local-mode client for the desktop app's bridge (protocol.md §1, §2, §5).
//!
//! `connect_local` performs the `local` handshake and returns a cheap, cloneable `Client` plus a
//! receiver of server pushes. A background task owns the socket: it routes `rpc-result` frames to
//! their callers and, when the socket drops, fails pending calls, sends `Push::Disconnected`,
//! reconnects with backoff (re-reading `local.json`, the app may have restarted) and then sends
//! `Push::Reconnected`.

use crate::types::Push;
use futures_util::{SinkExt, StreamExt};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub const PROTOCOL: u32 = 2;
pub const CLIENT_NAME: &str = concat!("orbit-tui/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalConfig {
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub protocol: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// No `local.json` (the app isn't running, or is older than the local listener).
    Missing(PathBuf),
    Invalid(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Missing(p) => write!(f, "{} not found", p.display()),
            ConfigError::Invalid(e) => write!(f, "local.json is invalid: {e}"),
        }
    }
}

/// `ORBIT_HOME`, else `~/.orbit` (same rule as the app).
pub fn orbit_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("ORBIT_HOME") {
        return Some(PathBuf::from(h));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".orbit"))
}

/// Environment (`ORBIT_LOCAL_PORT` + `ORBIT_LOCAL_TOKEN`) first, then `<orbit home>/local.json`.
pub fn read_local_config() -> Result<LocalConfig, ConfigError> {
    if let (Ok(port), Ok(token)) = (std::env::var("ORBIT_LOCAL_PORT"), std::env::var("ORBIT_LOCAL_TOKEN")) {
        let port = port.parse().map_err(|_| ConfigError::Invalid("ORBIT_LOCAL_PORT is not a port".into()))?;
        return Ok(LocalConfig { port, token, pid: None, version: None, protocol: None });
    }
    let path = orbit_home().ok_or_else(|| ConfigError::Invalid("no home folder".into()))?.join("local.json");
    let raw = std::fs::read_to_string(&path).map_err(|_| ConfigError::Missing(path.clone()))?;
    serde_json::from_str(&raw).map_err(|e| ConfigError::Invalid(e.to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    NotRunning,
    BadToken,
    Version { server: u32, client: u32 },
    Protocol(String),
}

impl fmt::Display for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConnectError::NotRunning => write!(f, "Orbit isn't running"),
            ConnectError::BadToken => write!(f, "Orbit refused the local token (restart orb)"),
            ConnectError::Version { server, client } => {
                write!(f, "Orbit speaks protocol {server}, orb needs {client}: update the desktop app")
            }
            ConnectError::Protocol(m) => write!(f, "{m}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    Disconnected,
    /// The server's human-readable error.
    Server(String),
    Decode(String),
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::Disconnected => write!(f, "Not connected"),
            RpcError::Server(m) => write!(f, "{m}"),
            RpcError::Decode(m) => write!(f, "Unexpected reply: {m}"),
        }
    }
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Reply = oneshot::Sender<Result<Value, RpcError>>;

#[derive(Clone)]
pub struct Client {
    tx: mpsc::UnboundedSender<(String, Value, Reply)>,
    /// What the server said in `ready`.
    pub server_name: String,
    pub server_version: String,
}

impl Client {
    pub async fn connect_local(cfg: LocalConfig) -> Result<(Client, mpsc::Receiver<Push>), ConnectError> {
        let (ws, name, version) = handshake(&cfg).await?;
        let (tx, rx) = mpsc::unbounded_channel();
        let (push_tx, push_rx) = mpsc::channel(1024);
        tokio::spawn(run(ws, rx, push_tx));
        Ok((Client { tx, server_name: name, server_version: version }, push_rx))
    }

    pub async fn rpc_value(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let (reply, wait) = oneshot::channel();
        self.tx.send((method.to_string(), params, reply)).map_err(|_| RpcError::Disconnected)?;
        wait.await.map_err(|_| RpcError::Disconnected)?
    }

    pub async fn rpc<P: Serialize, R: DeserializeOwned>(&self, method: &str, params: P) -> Result<R, RpcError> {
        let params = serde_json::to_value(params).map_err(|e| RpcError::Decode(e.to_string()))?;
        let v = self.rpc_value(method, params).await?;
        serde_json::from_value(v).map_err(|e| RpcError::Decode(e.to_string()))
    }
}

async fn next_json(ws: &mut Ws) -> Option<Value> {
    loop {
        match ws.next().await? {
            Ok(Message::Text(t)) => return serde_json::from_str(&t).ok(),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => continue,
        }
    }
}

async fn handshake(cfg: &LocalConfig) -> Result<(Ws, String, String), ConnectError> {
    let url = format!("ws://127.0.0.1:{}/v1", cfg.port);
    let connect = tokio_tungstenite::connect_async(url);
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(5), connect)
        .await
        .map_err(|_| ConnectError::NotRunning)?
        .map_err(|_| ConnectError::NotRunning)?;
    let hello = tokio::time::timeout(Duration::from_secs(5), next_json(&mut ws))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| ConnectError::Protocol("no hello from Orbit".into()))?;
    let v = hello.get("v").and_then(Value::as_u64).unwrap_or(0) as u32;
    if v < PROTOCOL {
        return Err(ConnectError::Version { server: v, client: PROTOCOL });
    }
    let frame = json!({ "t": "local", "token": cfg.token, "client": CLIENT_NAME });
    ws.send(Message::Text(frame.to_string())).await.map_err(|e| ConnectError::Protocol(e.to_string()))?;
    let ready = tokio::time::timeout(Duration::from_secs(5), next_json(&mut ws))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| ConnectError::Protocol("Orbit closed the connection".into()))?;
    match ready.get("t").and_then(Value::as_str) {
        Some("ready") => {
            let name = ready.pointer("/orbit/name").and_then(Value::as_str).unwrap_or("Orbit").to_string();
            let version = ready.pointer("/orbit/version").and_then(Value::as_str).unwrap_or("").to_string();
            Ok((ws, name, version))
        }
        Some("error") if ready.get("code").and_then(Value::as_str) == Some("bad_token") => Err(ConnectError::BadToken),
        _ => Err(ConnectError::Protocol(
            ready.get("message").and_then(Value::as_str).unwrap_or("handshake failed").to_string(),
        )),
    }
}

/// Owns the socket; reconnects forever until every `Client` clone is dropped.
async fn run(mut ws: Ws, mut rx: mpsc::UnboundedReceiver<(String, Value, Reply)>, push: mpsc::Sender<Push>) {
    let mut next_id: u64 = 0;
    loop {
        let mut pending: HashMap<u64, Reply> = HashMap::new();
        let closed_by_client = loop {
            tokio::select! {
                req = rx.recv() => {
                    let Some((method, params, reply)) = req else { break true };
                    next_id += 1;
                    let frame = json!({ "t": "rpc", "id": next_id, "method": method, "params": params });
                    if ws.send(Message::Text(frame.to_string())).await.is_err() {
                        let _ = reply.send(Err(RpcError::Disconnected));
                        break false;
                    }
                    pending.insert(next_id, reply);
                }
                msg = next_json(&mut ws) => {
                    let Some(v) = msg else { break false };
                    if v.get("t").and_then(Value::as_str) == Some("rpc-result") {
                        let id = v.get("id").and_then(Value::as_u64).unwrap_or(0);
                        if let Some(reply) = pending.remove(&id) {
                            let res = if v.get("ok").and_then(Value::as_bool) == Some(true) {
                                Ok(v.get("result").cloned().unwrap_or(Value::Null))
                            } else {
                                Err(RpcError::Server(v.get("error").and_then(Value::as_str).unwrap_or("request failed").to_string()))
                            };
                            let _ = reply.send(res);
                        }
                    } else if let Some(p) = Push::from_frame(&v) {
                        let _ = push.send(p).await;
                    }
                }
            }
        };
        for (_, reply) in pending.drain() {
            let _ = reply.send(Err(RpcError::Disconnected));
        }
        if closed_by_client {
            let _ = ws.close(None).await;
            return;
        }
        let _ = push.send(Push::Disconnected).await;
        let mut delay = Duration::from_millis(250);
        ws = loop {
            tokio::time::sleep(delay).await;
            // Requests made while disconnected fail at once instead of hanging.
            while let Ok((_, _, reply)) = rx.try_recv() {
                let _ = reply.send(Err(RpcError::Disconnected));
            }
            if rx.is_closed() {
                return;
            }
            if let Ok(cfg) = read_local_config() {
                if let Ok((ws, _, _)) = handshake(&cfg).await {
                    break ws;
                }
            }
            delay = (delay * 2).min(Duration::from_secs(4));
        };
        let _ = push.send(Push::Reconnected).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// A tiny fake of the app's local listener: hello → local → ready, then echoes `rpc` and pushes.
    async fn fake_server(token: &'static str, v: u32) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
                    let hello = json!({"t":"hello","v":v,"pk":"x","challenge":"c","name":"T"});
                    ws.send(Message::Text(hello.to_string())).await.unwrap();
                    let Some(Ok(Message::Text(t))) = ws.next().await else { return };
                    let m: Value = serde_json::from_str(&t).unwrap();
                    if m["token"] != token {
                        let e = json!({"t":"error","code":"bad_token","message":"bad"});
                        let _ = ws.send(Message::Text(e.to_string())).await;
                        return;
                    }
                    let r = json!({"t":"ready","orbit":{"name":"T","version":"0.2.0"},"protocol":2});
                    ws.send(Message::Text(r.to_string())).await.unwrap();
                    while let Some(Ok(Message::Text(t))) = ws.next().await {
                        let m: Value = serde_json::from_str(&t).unwrap();
                        let push = json!({"t":"workspace","workspace":{"id":"w1","name":"a"}});
                        ws.send(Message::Text(push.to_string())).await.unwrap();
                        let reply = if m["method"] == "fail" {
                            json!({"t":"rpc-result","id":m["id"],"ok":false,"error":"nope"})
                        } else {
                            json!({"t":"rpc-result","id":m["id"],"ok":true,"result":m["params"]})
                        };
                        ws.send(Message::Text(reply.to_string())).await.unwrap();
                    }
                });
            }
        });
        port
    }

    fn cfg(port: u16, token: &str) -> LocalConfig {
        LocalConfig { port, token: token.into(), pid: None, version: None, protocol: Some(2) }
    }

    #[tokio::test]
    async fn rpc_and_push_round_trip() {
        let port = fake_server("tok", 2).await;
        let (c, mut pushes) = Client::connect_local(cfg(port, "tok")).await.unwrap();
        assert_eq!(c.server_version, "0.2.0");
        let r: Value = c.rpc("echo", json!({"a":1})).await.unwrap();
        assert_eq!(r, json!({"a":1}));
        assert_eq!(c.rpc_value("fail", json!({})).await, Err(RpcError::Server("nope".into())));
        assert!(matches!(pushes.recv().await, Some(Push::Workspace(w)) if w.id == "w1"));
    }

    #[tokio::test]
    async fn bad_token_and_old_server() {
        let port = fake_server("tok", 2).await;
        assert_eq!(Client::connect_local(cfg(port, "wrong")).await.err(), Some(ConnectError::BadToken));
        let port = fake_server("tok", 1).await;
        assert_eq!(
            Client::connect_local(cfg(port, "tok")).await.err(),
            Some(ConnectError::Version { server: 1, client: 2 })
        );
    }

    #[tokio::test]
    async fn refused_is_not_running() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert_eq!(Client::connect_local(cfg(port, "x")).await.err(), Some(ConnectError::NotRunning));
    }
}
