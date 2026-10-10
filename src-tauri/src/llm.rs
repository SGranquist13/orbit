//! Utility model calls: the short, structured, behind-the-scenes prompts around the coding agents
//! (inbox suggestions, workspace names, commit messages, routine summaries, PR drafts).
//! Every one goes through [`complete_json`], so each task can be pointed at Claude (the default),
//! a local Ollama model, or any OpenAI-compatible server (LM Studio, llama.cpp, vLLM) in Settings.
//! Never call `claude -p` directly for utility work. Coding turns do not come through here.

use crate::settings::{Settings, DEFAULT_OLLAMA_URL, DEFAULT_OPENAI_URL};
use crate::{agent, Inner};
use anyhow::{anyhow, bail, Context};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The last three are called by the git-flow and Routines features, which land separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Task {
    Suggestions,
    WorkspaceName,
    CommitMessage,
    RoutineSummary,
    PrDescription,
}

impl Task {
    /// Optional tasks are simply skipped when their backend fails; required ones fall back to Claude.
    pub fn optional(self) -> bool {
        matches!(self, Task::Suggestions | Task::WorkspaceName)
    }

    /// The task's setting: "default" | "off" | "local:<model>".
    fn setting(self, s: &Settings) -> &str {
        match self {
            Task::Suggestions => &s.model_suggestions,
            Task::WorkspaceName => &s.model_workspace_name,
            Task::CommitMessage => &s.model_commit_message,
            Task::RoutineSummary => &s.model_routine_summary,
            Task::PrDescription => &s.model_pr_description,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Backend {
    Claude { model: String },
    Ollama { url: String, model: String },
    OpenAiCompat { url: String, model: String, api_key: Option<String> },
}

impl Backend {
    /// Key for [`last_errors`] and the status UI.
    fn name(&self) -> &'static str {
        match self {
            Backend::Claude { .. } => "claude",
            Backend::Ollama { .. } => "ollama",
            Backend::OpenAiCompat { .. } => "openaiCompat",
        }
    }
}

/// Where a task goes: `primary`, then `fallback` if it fails. `None` from [`plan`] means Off.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub primary: Backend,
    pub fallback: Option<Backend>,
}

pub fn plan(s: &Settings, task: Task) -> Option<Plan> {
    let claude = Backend::Claude { model: s.suggestion_model.clone() };
    match task.setting(s) {
        "off" if task.optional() => None,
        v if v.starts_with("local:") => {
            let model = v["local:".len()..].to_string();
            let url = s.local_base_url();
            let primary = if s.local_provider == "openai" {
                Backend::OpenAiCompat { url, model, api_key: Some(s.local_api_key.clone()).filter(|k| !k.is_empty()) }
            } else {
                Backend::Ollama { url, model }
            };
            Some(Plan { primary, fallback: (!task.optional()).then_some(claude) })
        }
        _ => Some(Plan { primary: claude, fallback: None }),
    }
}

static LAST_ERRORS: OnceLock<Mutex<HashMap<&'static str, String>>> = OnceLock::new();

fn errors() -> std::sync::MutexGuard<'static, HashMap<&'static str, String>> {
    LAST_ERRORS.get_or_init(Default::default).lock().unwrap()
}

/// The most recent failure per backend (`claude`, `ollama`, `openaiCompat`); cleared on its next success.
pub fn last_errors() -> HashMap<String, String> {
    errors().iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// Runs one utility prompt and returns a JSON object matching `schema`, or `None` if the task is Off.
///
/// `system` is optional guidance ("" for none); `prompt` is the task input; `schema` is a JSON
/// Schema object whose top level is an object (the backends enforce it where they can, and the
/// reply is checked for the `required` keys either way). A local backend that errors, times out or
/// returns bad JSON is recorded in [`last_errors`] and then replaced by Claude for required tasks,
/// or yields `Ok(None)` for optional ones. Only a failing Claude call returns `Err`.
///
/// How callers use each task (schemas are suggestions; any object schema works):
/// - `Suggestions`: `{"suggestions": string[<=3]}`; optional.
/// - `WorkspaceName`: `{"name": string}` (<= 5 words); optional, off by default.
/// - `CommitMessage`: `{"subject": string, "body": string}`; required, so `Ok(Some(_))` always (or `Err`).
/// - `RoutineSummary`: `{"summary": string, "nothingToDo": boolean}`; required.
/// - `PrDescription`: `{"title": string, "body": string}`; required.
pub async fn complete_json(state: &Inner, task: Task, system: &str, prompt: &str, schema: &Value) -> anyhow::Result<Option<Value>> {
    let settings = state.settings();
    let Some(plan) = plan(&settings, task) else { return Ok(None) };
    let timeout = Duration::from_secs(settings.local_timeout_secs);
    match run(&state.home, &plan.primary, system, prompt, schema, timeout).await {
        Ok(v) => Ok(Some(v)),
        Err(e) => match plan.fallback {
            Some(fallback) => run(&state.home, &fallback, system, prompt, schema, timeout).await.map(Some),
            None if matches!(plan.primary, Backend::Claude { .. }) => Err(e),
            None => Ok(None),
        },
    }
}

/// One call to one backend, recording the outcome for the status UI.
async fn run(home: &std::path::Path, backend: &Backend, system: &str, prompt: &str, schema: &Value, timeout: Duration) -> anyhow::Result<Value> {
    let result = match backend {
        Backend::Claude { model } => claude_call(home, model, system, prompt, schema).await,
        Backend::Ollama { url, model } => http_call(&ollama_request(url, model, system, prompt, schema), timeout, parse_ollama).await,
        Backend::OpenAiCompat { url, model, api_key } => {
            http_call(&openai_request(url, model, api_key.as_deref(), system, prompt, schema), timeout, parse_openai).await
        }
    }
    .and_then(|v| check_required(v, schema));
    match &result {
        Ok(_) => {
            errors().remove(backend.name());
        }
        // Messages never contain request headers, so the API key can't leak here.
        Err(e) => {
            errors().insert(backend.name(), format!("{e:#}"));
        }
    }
    result
}

/// The Claude CLI one-shot: no tools, no user plugins or hooks, so it is fast, cheap and side-effect free.
async fn claude_call(home: &std::path::Path, model: &str, system: &str, prompt: &str, schema: &Value) -> anyhow::Result<Value> {
    let mut args: Vec<String> = [
        "-p", "--model", model, "--output-format", "json", "--no-session-persistence",
        "--setting-sources", "local", "--tools", "", "--json-schema", &schema.to_string(),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if !system.trim().is_empty() {
        args.extend(["--append-system-prompt".into(), system.to_string()]);
    }
    args.push(prompt.to_string());
    let mut cmd = agent::process::command("claude", &args, home)?;
    cmd.stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(45), cmd.output())
        .await
        .map_err(|_| anyhow!("claude timed out"))??;
    parse_claude(&out.stdout)
}

fn parse_claude(stdout: &[u8]) -> anyhow::Result<Value> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| anyhow!("claude: unreadable response"))?;
    let out = v["structured_output"].clone();
    if out.is_object() { Ok(out) } else { bail!("claude: no structured output") }
}

/// A request ready to send; separate from sending so tests can inspect it.
#[derive(Debug, Clone, PartialEq)]
pub struct HttpRequest {
    pub url: String,
    pub bearer: Option<String>,
    pub body: Value,
}

fn messages(system: &str, prompt: &str) -> Vec<Value> {
    let mut m = vec![];
    if !system.trim().is_empty() {
        m.push(json!({ "role": "system", "content": system }));
    }
    m.push(json!({ "role": "user", "content": prompt }));
    m
}

pub fn ollama_request(url: &str, model: &str, system: &str, prompt: &str, schema: &Value) -> HttpRequest {
    HttpRequest {
        url: format!("{url}/api/chat"),
        bearer: None,
        body: json!({
            "model": model,
            "stream": false,
            "messages": messages(system, prompt),
            // Constrains decoding to the schema (Ollama structured outputs).
            "format": schema,
            "options": { "temperature": 0.2 },
            // Keep the model resident so the next utility call skips the cold load.
            "keep_alive": "10m",
        }),
    }
}

pub fn openai_request(url: &str, model: &str, api_key: Option<&str>, system: &str, prompt: &str, schema: &Value) -> HttpRequest {
    HttpRequest {
        url: format!("{url}/v1/chat/completions"),
        bearer: api_key.filter(|k| !k.is_empty()).map(String::from),
        body: json!({
            "model": model,
            "stream": false,
            "temperature": 0.2,
            "messages": messages(system, prompt),
            "response_format": { "type": "json_schema", "json_schema": { "name": "result", "strict": true, "schema": schema } },
        }),
    }
}

async fn http_call(req: &HttpRequest, timeout: Duration, parse: fn(&Value) -> anyhow::Result<Value>) -> anyhow::Result<Value> {
    let mut builder = client(timeout)?.post(&req.url).json(&req.body);
    if let Some(key) = &req.bearer {
        builder = builder.bearer_auth(key);
    }
    let resp = builder.send().await.map_err(|e| if e.is_timeout() { anyhow!("timed out after {}s", timeout.as_secs()) } else { anyhow!("not reachable at {} ({})", host_of(&req.url), e.without_url()) })?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|_| anyhow!("unreadable response (HTTP {status})"))?;
    if !status.is_success() {
        bail!("HTTP {status}: {}", error_text(&body));
    }
    parse(&body)
}

/// Local servers never go through a system proxy.
fn client(timeout: Duration) -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder().timeout(timeout).no_proxy().build().context("http client")
}

fn host_of(url: &str) -> &str {
    url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or(url)
}

fn error_text(body: &Value) -> String {
    let e = &body["error"];
    e.as_str().or_else(|| e["message"].as_str()).unwrap_or("request failed").chars().take(200).collect()
}

pub fn parse_ollama(body: &Value) -> anyhow::Result<Value> {
    if let Some(e) = body["error"].as_str() {
        bail!("{e}");
    }
    json_object(body["message"]["content"].as_str().ok_or_else(|| anyhow!("no message content"))?)
}

pub fn parse_openai(body: &Value) -> anyhow::Result<Value> {
    if body["error"].is_object() || body["error"].is_string() {
        bail!("{}", error_text(body));
    }
    json_object(body["choices"][0]["message"]["content"].as_str().ok_or_else(|| anyhow!("no message content"))?)
}

/// Parses model text as a JSON object, tolerating a Markdown code fence around it.
pub fn json_object(text: &str) -> anyhow::Result<Value> {
    let t = text.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t).trim();
    match serde_json::from_str::<Value>(t) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => bail!("model returned JSON that is not an object"),
        Err(_) => bail!("model returned invalid JSON"),
    }
}

/// Every key in the schema's top-level `required` list must be present.
fn check_required(v: Value, schema: &Value) -> anyhow::Result<Value> {
    for key in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if v.get(key).is_none() {
            bail!("reply is missing \"{key}\"");
        }
    }
    Ok(v)
}

// ---- status + test (Settings > Models) -------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub name: String,
    pub size_bytes: u64,
    pub family: String,
    pub parameter_size: String,
    pub quantization: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub running: bool,
    pub version: Option<String>,
    pub url: String,
    pub models: Vec<LocalModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiStatus {
    pub reachable: bool,
    pub url: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub ollama: OllamaStatus,
    pub openai_compat: OpenAiStatus,
    pub last_errors: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub output: Option<String>,
    pub error: Option<String>,
}

/// Parses `/api/tags`. Cloud-hosted entries (`:cloud` / `-cloud`) are left out: they run remotely,
/// which would defeat "local = private".
pub fn parse_ollama_tags(body: &Value) -> Vec<LocalModel> {
    let mut out: Vec<LocalModel> = body["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let name = m["name"].as_str().or_else(|| m["model"].as_str())?.to_string();
            if name.ends_with(":cloud") || name.ends_with("-cloud") || m["remote_host"].is_string() {
                return None;
            }
            let d = &m["details"];
            Some(LocalModel {
                name,
                size_bytes: m["size"].as_u64().unwrap_or(0),
                family: d["family"].as_str().unwrap_or("").into(),
                parameter_size: d["parameter_size"].as_str().unwrap_or("").into(),
                quantization: d["quantization_level"].as_str().unwrap_or("").into(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.size_bytes.cmp(&b.size_bytes).then(a.name.cmp(&b.name)));
    out
}

pub fn parse_openai_models(body: &Value) -> Vec<String> {
    body["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(String::from)).collect()
}

async fn get_json(url: &str, bearer: Option<&str>) -> Option<Value> {
    let mut b = client(Duration::from_millis(2500)).ok()?.get(url);
    if let Some(k) = bearer.filter(|k| !k.is_empty()) {
        b = b.bearer_auth(k);
    }
    let resp = b.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

/// Probes both server kinds: the selected provider at the configured URL, the other at its default.
pub async fn status(s: &Settings) -> LocalStatus {
    let openai = s.local_provider == "openai";
    let ollama_url = if openai { DEFAULT_OLLAMA_URL.to_string() } else { s.local_base_url() };
    let openai_url = if openai { s.local_base_url() } else { DEFAULT_OPENAI_URL.to_string() };
    let key = Some(s.local_api_key.as_str()).filter(|_| openai);
    let (version_url, tags_url, models_url) =
        (format!("{ollama_url}/api/version"), format!("{ollama_url}/api/tags"), format!("{openai_url}/v1/models"));
    let (version, tags, models) = tokio::join!(get_json(&version_url, None), get_json(&tags_url, None), get_json(&models_url, key));
    LocalStatus {
        ollama: OllamaStatus {
            running: version.is_some(),
            version: version.and_then(|v| v["version"].as_str().map(String::from)),
            models: tags.as_ref().map(parse_ollama_tags).unwrap_or_default(),
            url: ollama_url,
        },
        openai_compat: OpenAiStatus {
            reachable: models.is_some(),
            models: models.as_ref().map(parse_openai_models).unwrap_or_default(),
            url: openai_url,
        },
        last_errors: last_errors(),
    }
}

/// A tiny JSON round-trip against one local backend. The timeout is generous because the first
/// call after install loads the model into memory, which can take a while.
pub async fn test_model(s: &Settings, backend: &str, model: &str) -> anyhow::Result<TestResult> {
    let url = |default: &str, selected: &str| if s.local_provider == selected { s.local_base_url() } else { default.to_string() };
    let target = match backend {
        "ollama" => Backend::Ollama { url: url(DEFAULT_OLLAMA_URL, "ollama"), model: model.into() },
        "openaiCompat" => Backend::OpenAiCompat {
            url: url(DEFAULT_OPENAI_URL, "openai"),
            model: model.into(),
            api_key: Some(s.local_api_key.clone()).filter(|k| !k.is_empty()),
        },
        other => bail!("unknown backend \"{other}\""),
    };
    let schema = json!({ "type": "object", "properties": { "reply": { "type": "string" } }, "required": ["reply"] });
    let started = Instant::now();
    let timeout = Duration::from_secs(s.local_timeout_secs.max(120));
    let res = run(&std::env::temp_dir(), &target, "", "Reply with the JSON object {\"reply\": \"pong\"}.", &schema, timeout).await;
    let latency_ms = started.elapsed().as_millis() as u64;
    Ok(match res {
        Ok(v) => TestResult { ok: true, latency_ms, output: Some(v.to_string()), error: None },
        Err(e) => TestResult { ok: false, latency_ms, output: None, error: Some(format!("{e:#}")) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        json!({ "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] })
    }

    #[test]
    fn plan_follows_task_settings() {
        let mut s = Settings::default();
        // Defaults: Claude everywhere except workspace names, which are off.
        assert_eq!(plan(&s, Task::Suggestions), Some(Plan { primary: Backend::Claude { model: "haiku".into() }, fallback: None }));
        assert_eq!(plan(&s, Task::WorkspaceName), None);
        s.model_suggestions = "off".into();
        assert_eq!(plan(&s, Task::Suggestions), None);
        // Local on a required task falls back to Claude; on an optional one it doesn't.
        s.model_commit_message = "local:qwen3:4b".into();
        s.model_workspace_name = "local:llama3.2:3b".into();
        let p = plan(&s, Task::CommitMessage).unwrap();
        assert_eq!(p.primary, Backend::Ollama { url: "http://localhost:11434".into(), model: "qwen3:4b".into() });
        assert_eq!(p.fallback, Some(Backend::Claude { model: "haiku".into() }));
        assert_eq!(plan(&s, Task::WorkspaceName).unwrap().fallback, None);
        // OpenAI-compatible provider carries the key.
        s.local_provider = "openai".into();
        s.local_api_key = "sk-test".into();
        s.suggestion_model = "sonnet".into();
        let p = plan(&s, Task::CommitMessage).unwrap();
        assert_eq!(
            p.primary,
            Backend::OpenAiCompat { url: "http://localhost:1234".into(), model: "qwen3:4b".into(), api_key: Some("sk-test".into()) }
        );
        assert_eq!(p.fallback, Some(Backend::Claude { model: "sonnet".into() }));
    }

    #[test]
    fn ollama_request_shape() {
        let r = ollama_request("http://localhost:11434", "llama3.2:3b", "Be brief.", "Name this.", &schema());
        assert_eq!(r.url, "http://localhost:11434/api/chat");
        assert_eq!(r.body["model"], "llama3.2:3b");
        assert_eq!(r.body["stream"], false);
        assert_eq!(r.body["format"], schema());
        assert_eq!(r.body["messages"][0], json!({ "role": "system", "content": "Be brief." }));
        assert_eq!(r.body["messages"][1]["role"], "user");
        assert!(r.body["options"]["temperature"].as_f64().unwrap() <= 0.3);
        // No system message when none is given.
        assert_eq!(ollama_request("u", "m", "  ", "p", &schema()).body["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn openai_request_shape() {
        let r = openai_request("http://localhost:1234", "qwen", Some("k"), "", "hi", &schema());
        assert_eq!(r.url, "http://localhost:1234/v1/chat/completions");
        assert_eq!(r.bearer.as_deref(), Some("k"));
        assert_eq!(r.body["response_format"]["type"], "json_schema");
        assert_eq!(r.body["response_format"]["json_schema"]["schema"], schema());
        assert_eq!(openai_request("u", "m", Some(""), "", "p", &schema()).bearer, None);
    }

    #[test]
    fn parses_ollama_and_openai_replies() {
        let ok = json!({ "message": { "role": "assistant", "content": "{\"name\": \"Login Fixer\"}" }, "done": true });
        assert_eq!(parse_ollama(&ok).unwrap(), json!({ "name": "Login Fixer" }));
        assert!(parse_ollama(&json!({ "error": "model 'x' not found" })).unwrap_err().to_string().contains("not found"));
        assert!(parse_ollama(&json!({ "message": { "content": "sure! here you go" } })).is_err());
        assert!(parse_ollama(&json!({ "message": { "content": "[1,2]" } })).is_err());
        let oa = json!({ "choices": [{ "message": { "content": "```json\n{\"name\":\"x\"}\n```" } }] });
        assert_eq!(parse_openai(&oa).unwrap(), json!({ "name": "x" }));
        assert!(parse_openai(&json!({ "error": { "message": "bad key" } })).unwrap_err().to_string().contains("bad key"));
        assert!(parse_openai(&json!({ "choices": [] })).is_err());
    }

    #[test]
    fn required_keys_are_enforced() {
        assert!(check_required(json!({ "name": "a" }), &schema()).is_ok());
        assert!(check_required(json!({ "other": 1 }), &schema()).is_err());
    }

    #[test]
    fn parses_claude_structured_output() {
        let ok = br#"{"type":"result","structured_output":{"suggestions":["a"]}}"#;
        assert_eq!(parse_claude(ok).unwrap(), json!({ "suggestions": ["a"] }));
        assert!(parse_claude(br#"{"type":"result","result":"text"}"#).is_err());
        assert!(parse_claude(b"nope").is_err());
    }

    #[test]
    fn parses_tags_and_models() {
        let tags = json!({ "models": [
            { "name": "qwen2.5-coder:7b", "size": 4_683_087_332u64, "details": { "family": "qwen2", "parameter_size": "7.6B", "quantization_level": "Q4_K_M" } },
            { "name": "llama3.2:3b", "size": 2_019_393_189u64, "details": { "family": "llama", "parameter_size": "3.2B", "quantization_level": "Q4_K_M" } },
            { "name": "minimax-m2.5:cloud", "details": {} },
        ]});
        let m = parse_ollama_tags(&tags);
        assert_eq!(m.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["llama3.2:3b", "qwen2.5-coder:7b"]);
        assert_eq!((m[0].parameter_size.as_str(), m[0].quantization.as_str()), ("3.2B", "Q4_K_M"));
        assert_eq!(parse_openai_models(&json!({ "data": [{ "id": "a" }, { "id": "b" }] })), ["a", "b"]);
        assert!(parse_ollama_tags(&json!({})).is_empty());
    }

    /// Live: needs Ollama running with a model pulled. `ORBIT_TEST_OLLAMA_MODEL` picks it (default llama3.2:3b).
    /// Run with `-- --include-ignored`.
    #[tokio::test]
    #[ignore = "needs a running Ollama"]
    async fn live_ollama_round_trip() {
        let model = std::env::var("ORBIT_TEST_OLLAMA_MODEL").unwrap_or_else(|_| "llama3.2:3b".into());
        let started = Instant::now();
        let req = ollama_request(DEFAULT_OLLAMA_URL, &model, "", "Give a 3 word name for: fix login bug", &schema());
        let v = http_call(&req, Duration::from_secs(120), parse_ollama).await.expect("ollama reply");
        println!("live ollama {model}: {v} in {:?}", started.elapsed());
        assert!(v["name"].as_str().is_some_and(|n| !n.is_empty()));
        let status = status(&Settings::default()).await;
        assert!(status.ollama.running && status.ollama.models.iter().any(|m| m.name == model));
    }
}
