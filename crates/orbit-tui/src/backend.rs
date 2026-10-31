//! The only thing the UI talks to: `dyn Backend`. `LiveBackend` is the desktop app over the
//! local WebSocket; `DemoBackend` (demo.rs) is an in-memory fake.

use async_trait::async_trait;
use orbit_proto::{Client, Push};
use serde_json::Value;
use std::sync::Mutex;
use tokio::sync::mpsc;

#[async_trait]
pub trait Backend: Send + Sync {
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String>;
    /// The push stream; call once.
    fn subscribe(&self) -> mpsc::Receiver<Push>;
}

pub struct LiveBackend {
    client: Client,
    pushes: Mutex<Option<mpsc::Receiver<Push>>>,
}

impl LiveBackend {
    pub fn new(client: Client, pushes: mpsc::Receiver<Push>) -> LiveBackend {
        LiveBackend { client, pushes: Mutex::new(Some(pushes)) }
    }
}

#[async_trait]
impl Backend for LiveBackend {
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        self.client.rpc_value(method, params).await.map_err(|e| e.to_string())
    }
    fn subscribe(&self) -> mpsc::Receiver<Push> {
        self.pushes.lock().ok().and_then(|mut p| p.take()).unwrap_or_else(|| mpsc::channel(1).1)
    }
}
