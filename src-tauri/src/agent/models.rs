//! Agent model discovery. Catalog failures are logged and cached as usable fallbacks.
use super::{process, AgentKind};
use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, process::Stdio, sync::OnceLock, time::Duration};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, Lines};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub is_default: bool,
    pub efforts: Vec<String>,
}

pub fn fallback(agent: AgentKind) -> Vec<ModelInfo> {
    let entries: &[(&str, &str)] = match agent {
        // `claude --help` has no catalog command; only use the supported aliases.
        AgentKind::Claude => &[("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")],
        AgentKind::Codex => &[
            ("gpt-6.1-sol", "gpt-6.1-sol"), ("gpt-6-astra", "gpt-6-astra"),
            ("gpt-6-sol", "gpt-6-sol"), ("gpt-6-luna", "gpt-6-luna"), ("gpt-5.6-sol", "gpt-5.6-sol"),
        ],
    };
    entries.iter().map(|(id, label)| ModelInfo {
        id: (*id).into(), label: (*label).into(), is_default: false, efforts: vec![],
    }).collect()
}

/// Pure normalization of a ModelListResponse result (not the JSON-RPC envelope).
pub fn parse_model_list(json: &Value) -> Vec<ModelInfo> {
    let Some(data) = json["data"].as_array() else { return vec![] };
    let mut seen = HashSet::new();
    data.iter().filter_map(|m| {
        if m["hidden"] == true { return None; }
        let id = m["id"].as_str().filter(|id| !id.trim().is_empty())?;
        if !seen.insert(id) { return None; }
        let label = m["displayName"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or(id);
        let efforts = m["supportedReasoningEfforts"].as_array().into_iter().flatten()
            .filter_map(|e| e["reasoningEffort"].as_str().map(str::to_owned)).collect();
        Some(ModelInfo { id: id.into(), label: label.into(), is_default: m["isDefault"] == true, efforts })
    }).collect()
}

pub async fn list(agent: AgentKind, refresh: bool) -> Vec<ModelInfo> {
    static CACHE: OnceLock<[Mutex<Option<Vec<ModelInfo>>>; 2]> = OnceLock::new();
    let caches = CACHE.get_or_init(|| [Mutex::new(None), Mutex::new(None)]);
    let index = match agent { AgentKind::Claude => 0, AgentKind::Codex => 1 };
    // Serialize refreshes and initial loads for this agent; the other agent stays independent.
    let mut cache = caches[index].lock().await;
    if !refresh {
        if let Some(models) = cache.as_ref() { return models.clone(); }
    }
    let models = match agent {
        AgentKind::Claude => fallback(agent),
        AgentKind::Codex => match tokio::time::timeout(Duration::from_secs(10), discover_codex()).await {
            Ok(Ok(models)) => models,
            result => {
                eprintln!("[orbit] model/list failed; using Codex fallback: {result:?}");
                fallback(agent)
            }
        },
    };
    *cache = Some(models.clone());
    models
}

async fn request<W: AsyncWrite + Unpin, R: AsyncBufRead + Unpin>(stdin: &mut W, lines: &mut Lines<R>, id: u64, method: &str, params: Value) -> anyhow::Result<Value> {
    stdin.write_all(format!("{}\n", json!({ "id": id, "method": method, "params": params })).as_bytes()).await?;
    stdin.flush().await?;
    while let Some(line) = lines.next_line().await? {
        let message: Value = serde_json::from_str(&line).context("invalid app-server JSON")?;
        if message["id"] != id || message.get("method").is_some() { continue; }
        if let Some(error) = message.get("error") { return Err(anyhow!("{method}: {error}")); }
        return message.get("result").cloned().context("missing JSON-RPC result");
    }
    Err(anyhow!("app-server exited during {method}"))
}

async fn discover_codex() -> anyhow::Result<Vec<ModelInfo>> {
    // Identity probes are synchronous; keep them off the async executor and inside the timeout.
    tokio::task::spawn_blocking(|| process::resolve("codex")).await??;
    let mut command = process::command("codex", &["app-server".into()], &std::env::temp_dir())?;
    command.stderr(Stdio::null());
    // command() enables kill_on_drop, windowless spawning and host env scrubbing.
    let mut child = process::spawn(&mut command)?;
    let mut stdin = child.stdin.take().context("app-server stdin")?;
    let mut lines = BufReader::new(child.stdout.take().context("app-server stdout")?).lines();
    let result = read_catalog(&mut stdin, &mut lines).await;
    // No workspace/thread is created. Reap this short-lived child on success and protocol errors.
    drop(stdin);
    let _ = child.kill().await;
    result
}

async fn read_catalog<W: AsyncWrite + Unpin, R: AsyncBufRead + Unpin>(stdin: &mut W, lines: &mut Lines<R>) -> anyhow::Result<Vec<ModelInfo>> {
    request(stdin, lines, 1, "initialize", json!({
        "clientInfo": { "name": "orbit", "title": "Orbit", "version": env!("CARGO_PKG_VERSION") },
        "capabilities": null,
    })).await?;
    stdin.write_all(b"{\"method\":\"initialized\"}\n").await?;
    let mut cursor: Option<String> = None;
    let mut cursors = HashSet::new();
    let mut models = vec![];
    let mut seen = HashSet::new();
    let mut id = 2;
    loop {
        let page = request(stdin, lines, id, "model/list", json!({
            "cursor": cursor, "limit": 100, "includeHidden": false,
        })).await?;
        if !page["data"].is_array() { return Err(anyhow!("model/list missing data array")); }
        models.extend(parse_model_list(&page).into_iter().filter(|m| seen.insert(m.id.clone())));
        cursor = match &page["nextCursor"] {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            _ => return Err(anyhow!("invalid model/list nextCursor")),
        };
        let Some(next) = cursor.as_ref() else { break };
        if !cursors.insert(next.clone()) { return Err(anyhow!("model/list repeated cursor")); }
        id += 1;
    }
    if models.is_empty() { return Err(anyhow!("model/list returned no visible models")); }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_catalog() {
        let fixture: Value = serde_json::from_str(include_str!("../../tests/fixtures/codex-model-list.json")).unwrap();
        let models = parse_model_list(&fixture);
        assert!(!models.is_empty());
        for model in &models {
            let raw = fixture["data"].as_array().unwrap().iter().find(|m| m["id"] == model.id).unwrap();
            assert_eq!(model.label, raw["displayName"].as_str().unwrap());
            assert_eq!(model.is_default, raw["isDefault"] == true);
            assert_ne!(raw["hidden"], true);
            assert_eq!(model.efforts, raw["supportedReasoningEfforts"].as_array().unwrap().iter()
                .map(|e| e["reasoningEffort"].as_str().unwrap().to_owned()).collect::<Vec<_>>());
        }
        assert_eq!(models.len(), fixture["data"].as_array().unwrap().iter().filter(|m| m["hidden"] != true).count());
    }

    #[test]
    fn hides_deduplicates_and_handles_missing_optional_metadata() {
        let models = parse_model_list(&json!({ "data": [
            { "id": "hidden", "hidden": true }, { "id": "" }, {},
            { "id": "visible", "displayName": "Friendly", "isDefault": true,
              "supportedReasoningEfforts": [{ "reasoningEffort": "high" }] },
            { "id": "visible" }, { "id": "minimal" },
        ] }));
        assert_eq!(models, vec![
            ModelInfo { id: "visible".into(), label: "Friendly".into(), is_default: true, efforts: vec!["high".into()] },
            ModelInfo { id: "minimal".into(), label: "minimal".into(), is_default: false, efforts: vec![] },
        ]);
        assert!(parse_model_list(&json!({ "error": "bad" })).is_empty());
        assert_eq!(serde_json::to_value(&models[0]).unwrap()["isDefault"], true);
    }

    #[tokio::test]
    async fn paginates_and_ignores_notifications() {
        let (client, server) = tokio::io::duplex(16_384);
        let (reader, mut writer) = tokio::io::split(client);
        let server = tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(server);
            let mut lines = BufReader::new(reader).lines();
            let init: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(init["method"], "initialize");
            writer.write_all(b"{\"id\":1,\"result\":{}}\n").await.unwrap();
            let initialized: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(initialized["method"], "initialized");
            for (id, cursor, data, next) in [
                (2, Value::Null, json!([{ "id": "first" }, { "id": "hidden", "hidden": true }]), json!("page-2")),
                (3, json!("page-2"), json!([{ "id": "first" }, { "id": "second" }]), Value::Null),
            ] {
                let req: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                assert_eq!(req["method"], "model/list");
                assert_eq!(req["params"]["cursor"], cursor);
                assert_eq!(req["params"]["includeHidden"], false);
                writer.write_all(b"{\"method\":\"notification\",\"params\":{}}\n").await.unwrap();
                let response = json!({ "id": id, "result": { "data": data, "nextCursor": next } });
                writer.write_all(format!("{response}\n").as_bytes()).await.unwrap();
            }
        });
        let models = read_catalog(&mut writer, &mut BufReader::new(reader).lines()).await.unwrap();
        server.await.unwrap();
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["first", "second"]);
    }

    #[tokio::test]
    async fn invalid_empty_and_repeated_cursor_catalogs_fail() {
        for pages in [
            vec![json!({ "data": [], "nextCursor": null })],
            vec![json!({ "data": "invalid", "nextCursor": null })],
            vec![json!({ "data": [{ "id": "hidden", "hidden": true }], "nextCursor": null })],
            vec![json!({ "data": [{ "id": "one" }], "nextCursor": 7 })],
            vec![json!({ "data": [{ "id": "one" }], "nextCursor": "same" }),
                 json!({ "data": [{ "id": "two" }], "nextCursor": "same" })],
        ] {
            let mut responses = "{\"id\":1,\"result\":{}}\n".to_string();
            for (i, page) in pages.into_iter().enumerate() {
                responses.push_str(&format!("{}\n", json!({ "id": i + 2, "result": page })));
            }
            let mut writer = tokio::io::sink();
            let mut lines = BufReader::new(responses.as_bytes()).lines();
            assert!(read_catalog(&mut writer, &mut lines).await.is_err());
        }
    }

    #[tokio::test]
    async fn rpc_errors_and_early_exit_fail_instead_of_hanging() {
        for response in ["{\"id\":2,\"error\":{\"message\":\"unavailable\"}}\n", ""] {
            let mut writer = tokio::io::sink();
            let mut lines = BufReader::new(response.as_bytes()).lines();
            assert!(request(&mut writer, &mut lines, 2, "model/list", json!({})).await.is_err());
        }
    }

    #[tokio::test]
    #[ignore] // Opt-in: local authenticated Codex CLI, no inference turn.
    async fn live_codex_catalog() {
        let models = tokio::time::timeout(Duration::from_secs(10), discover_codex()).await.unwrap().unwrap();
        assert!(!models.is_empty());
    }
}
