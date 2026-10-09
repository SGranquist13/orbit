//! Expo push notifications for finished turns. Only the workspace name and a status line leave the
//! machine (never transcript content), and only when the bridge and push are both enabled.

use super::server::Device;
use crate::db::Workspace;
use serde_json::{json, Value};
use std::time::Duration;

const EXPO_URL: &str = "https://exp.host/--/api/v2/push/send";

pub fn body(token: &str, ws_id: &str, ws_name: &str, is_error: bool, error: Option<&str>) -> Value {
    let text = if is_error {
        let first = error.and_then(|e| e.lines().map(str::trim).find(|l| !l.is_empty())).unwrap_or("turn failed");
        format!("Failed: {first}")
    } else {
        "Finished — ready for you".to_string()
    };
    json!({ "to": token, "title": ws_name, "body": text, "sound": "default", "data": { "workspaceId": ws_id } })
}

/// Sends one push per device that has a token. Never blocks the caller: the POSTs run on the async runtime.
pub fn notify_turn_done(devices: Vec<Device>, ws: &Workspace, is_error: bool, error: Option<&str>) {
    let bodies: Vec<Value> = devices
        .iter()
        .filter_map(|d| d.push_token.as_deref())
        .map(|t| body(t, &ws.id, &ws.name, is_error, error))
        .collect();
    if bodies.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(10)).build() else { return };
        for b in bodies {
            if let Err(e) = client.post(EXPO_URL).json(&b).send().await {
                eprintln!("push failed: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_body_matches_spec() {
        let b = body("ExponentPushToken[x]", "w1", "Fix login", false, None);
        assert_eq!(
            b,
            json!({ "to": "ExponentPushToken[x]", "title": "Fix login", "body": "Finished — ready for you", "sound": "default", "data": { "workspaceId": "w1" } })
        );
    }

    #[test]
    fn failure_body_uses_first_line_only() {
        let b = body("t", "w1", "n", true, Some("\nboom happened\nstack trace with secrets"));
        assert_eq!(b["body"], "Failed: boom happened");
        assert_eq!(body("t", "w1", "n", true, None)["body"], "Failed: turn failed");
    }
}
