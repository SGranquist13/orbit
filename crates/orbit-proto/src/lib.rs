//! Wire types and the local client for Orbit's bridge (docs/tui/spec/protocol.md).
//! `src-tauri` does not depend on this crate (MVP); it mirrors the app's serde shapes.

pub mod client;
pub mod types;

pub use client::{read_local_config, Client, ConfigError, ConnectError, LocalConfig, RpcError};
pub use types::*;
