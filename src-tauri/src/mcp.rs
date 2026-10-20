//! Orbit-managed MCP servers. Configuration builders are pure; changes apply at session spawn.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub const KEY: &str = "mcp_servers";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub enabled: bool,
}

pub fn validate(server: &McpServer) -> anyhow::Result<()> {
    if server.name.is_empty() || !server.name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-') {
        bail!("MCP server name must match [a-z0-9_-]+");
    }
    match server.transport.as_str() {
        "stdio" if !server.command.trim().is_empty() => Ok(()),
        "http" if server.url.as_ref().is_some_and(|u| !u.trim().is_empty()) => Ok(()),
        "stdio" => bail!("stdio MCP servers need a command"),
        "http" => bail!("HTTP MCP servers need a URL"),
        _ => bail!("MCP transport must be stdio or http"),
    }
}

pub fn list(db: &crate::db::Db) -> anyhow::Result<Vec<McpServer>> {
    db.setting(KEY)?.map(|s| serde_json::from_str(&s).context("invalid saved MCP servers")).unwrap_or_else(|| Ok(vec![]))
}

pub fn save(db: &crate::db::Db, mut server: McpServer) -> anyhow::Result<McpServer> {
    validate(&server)?;
    let mut servers = list(db)?;
    if server.id.is_empty() { server.id = uuid::Uuid::new_v4().to_string(); }
    if servers.iter().any(|s| s.name == server.name && s.id != server.id) {
        bail!("An MCP server with that name already exists");
    }
    if let Some(old) = servers.iter_mut().find(|s| s.id == server.id) { *old = server.clone(); }
    else { servers.push(server.clone()); }
    db.set_setting(KEY, &serde_json::to_string(&servers)?)?;
    Ok(server)
}

pub fn delete(db: &crate::db::Db, id: &str) -> anyhow::Result<()> {
    let mut servers = list(db)?;
    servers.retain(|s| s.id != id);
    db.set_setting(KEY, &serde_json::to_string(&servers)?)
}

pub fn effective(servers: &[McpServer], disabled: &[String]) -> Vec<McpServer> {
    servers.iter().filter(|s| s.enabled && !disabled.contains(&s.id)).cloned().collect()
}

pub fn claude_config(servers: &[McpServer]) -> Value {
    let entries: BTreeMap<_, _> = servers.iter().map(|s| {
        let config = if s.transport == "http" {
            json!({"type":"http", "url":s.url, "headers":s.headers})
        } else {
            json!({"type":"stdio", "command":s.command, "args":s.args, "env":s.env})
        };
        (s.name.clone(), config)
    }).collect();
    json!({"mcpServers":entries})
}

// TOML basic strings differ from JSON for control escapes: use \uXXXX, never JSON's \b or \f.
pub fn toml_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c <= '\u{1f}' || c == '\u{7f}' => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn toml_map(map: &BTreeMap<String, String>) -> String {
    format!("{{{}}}", map.iter().map(|(k,v)| format!("{}={}", toml_string(k), toml_string(v))).collect::<Vec<_>>().join(","))
}

pub fn codex_args(servers: &[McpServer]) -> Vec<String> {
    let mut args = vec![];
    for s in servers {
        let prefix = format!("mcp_servers.{}", s.name); // validated bare TOML key
        let fields = if s.transport == "http" {
            vec![("url", toml_string(s.url.as_deref().unwrap_or_default())), ("http_headers", toml_map(&s.headers))]
        } else {
            vec![("command", toml_string(&s.command)),
                ("args", format!("[{}]", s.args.iter().map(|a| toml_string(a)).collect::<Vec<_>>().join(","))),
                ("env", toml_map(&s.env))]
        };
        for (key, value) in fields { args.extend(["-c".into(), format!("{prefix}.{key}={value}")]); }
        args.extend(["-c".into(), format!("{prefix}.enabled=true")]);
    }
    args
}

pub fn write_claude_config(home: &Path, workspace: &str, servers: &[McpServer]) -> anyhow::Result<PathBuf> {
    // Workspace IDs are normally UUIDs; keep the generated file inside the MCP directory.
    if workspace.is_empty() || !workspace.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        bail!("Invalid workspace id for MCP config");
    }
    let dir = home.join("mcp");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{workspace}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&claude_config(servers))?)?;
    Ok(path)
}

pub fn import_config(config: &Value) -> Vec<McpServer> {
    config.get("mcpServers").and_then(Value::as_object).into_iter().flatten().filter_map(|(name, value)| {
        let transport = match value.get("type").and_then(Value::as_str) {
            Some("http") => "http",
            Some("stdio") | None if value.get("command").is_some() => "stdio",
            None if value.get("url").is_some() => "http",
            _ => return None,
        };
        let mut candidate = value.clone();
        let obj = candidate.as_object_mut()?;
        obj.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
        obj.insert("name".into(), json!(name));
        obj.insert("transport".into(), json!(transport));
        obj.insert("enabled".into(), json!(true));
        let server: McpServer = serde_json::from_value(candidate).ok()?;
        validate(&server).ok()?;
        Some(server)
    }).collect()
}

pub fn import_claude() -> anyhow::Result<Vec<McpServer>> {
    let path = dirs::home_dir().ok_or_else(|| anyhow!("Home directory not found"))?.join(".claude.json");
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    Ok(import_config(&serde_json::from_str(&text)?))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo { pub name: String, pub version: String }

fn server_info(response: &Value) -> anyhow::Result<ServerInfo> {
    if response.get("id") != Some(&json!(1)) { bail!("Unexpected MCP initialize response id"); }
    if let Some(error) = response.get("error") { bail!("MCP initialize failed: {error}"); }
    let info = response.pointer("/result/serverInfo").ok_or_else(|| anyhow!("MCP response has no serverInfo"))?;
    Ok(ServerInfo {
        name: info.get("name").and_then(Value::as_str).ok_or_else(|| anyhow!("Missing MCP server name"))?.into(),
        version: info.get("version").and_then(Value::as_str).ok_or_else(|| anyhow!("Missing MCP server version"))?.into(),
    })
}

pub async fn test(server: &McpServer) -> anyhow::Result<ServerInfo> {
    validate(server)?;
    tokio::time::timeout(Duration::from_secs(10), async {
        let request = json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
            "protocolVersion":"2025-03-26", "capabilities":{}, "clientInfo":{"name":"Orbit", "version":env!("CARGO_PKG_VERSION")}
        }});
        if server.transport == "http" {
            let client = reqwest::Client::new();
            let mut post = client.post(server.url.as_deref().unwrap_or_default());
            for (key, value) in &server.headers { post = post.header(key, value); }
            let response = post.header("Accept", "application/json, text/event-stream").json(&request).send().await?.error_for_status()?;
            if response.headers().get("content-type").and_then(|h| h.to_str().ok()).is_some_and(|s| s.starts_with("text/event-stream")) {
                // Streamable HTTP may keep the SSE connection open after initialize.
                let mut response = response;
                let mut buffer = Vec::new();
                while let Some(chunk) = response.chunk().await? {
                    buffer.extend_from_slice(&chunk);
                    if buffer.len() > 1024 * 1024 { bail!("MCP response too large"); }
                    while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                        let line: Vec<_> = buffer.drain(..=end).collect();
                        let text = std::str::from_utf8(&line)?.trim();
                        if let Some(data) = text.strip_prefix("data:") {
                            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                                if value.get("id") == Some(&json!(1)) { return server_info(&value); }
                            }
                        }
                    }
                }
                bail!("MCP HTTP stream ended before initialize response");
            }
            return server_info(&response.json::<Value>().await?);
        }
        let mut cmd = crate::agent::process::command(&server.command, &server.args, &std::env::temp_dir())?;
        cmd.envs(&server.env).stderr(std::process::Stdio::null());
        let mut child = crate::agent::process::spawn(&mut cmd)?;
        let result = async {
            let mut stdin = child.stdin.take().context("MCP stdin unavailable")?;
            stdin.write_all(format!("{request}\n").as_bytes()).await?;
            stdin.flush().await?;
            let mut stdout = BufReader::new(child.stdout.take().context("MCP stdout unavailable")?).take(1024 * 1024);
            loop {
                let mut line = String::new();
                if stdout.read_line(&mut line).await? == 0 { bail!("MCP server closed stdout before initialize response (or response exceeded 1 MiB)"); }
                let value: Value = serde_json::from_str(&line).context("Invalid MCP JSON-RPC response")?;
                if value.get("id") == Some(&json!(1)) { return server_info(&value); }
            }
        }.await;
        let _ = child.kill().await;
        result
    }).await.context("MCP initialize timed out after 10 seconds")?
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn sample() -> McpServer {
        McpServer { id: "one".into(), name: "local-files".into(), transport: "stdio".into(),
            command: "C:\\Program Files\\mcp.exe".into(), args: vec!["a\"b".into(), "line\nnext".into()],
            env: BTreeMap::from([("TOKEN".into(), "x\\y".into())]), url: None, headers: BTreeMap::new(), enabled: true }
    }

    #[test]
    fn validates_transports_and_names() {
        let server = sample();
        assert!(validate(&server).is_ok());
        for name in ["", "Upper", "a.b", "a b", "a\n", "é"] {
            assert!(validate(&McpServer { name: name.into(), ..server.clone() }).is_err());
        }
        assert!(validate(&McpServer { command: " ".into(), ..server.clone() }).is_err());
        assert!(validate(&McpServer { transport: "sse".into(), ..server.clone() }).is_err());
        let http = McpServer { transport: "http".into(), ..server };
        assert!(validate(&http).is_err());
        assert!(validate(&McpServer { url: Some("https://example.com/mcp".into()), ..http }).is_ok());
    }

    #[test]
    fn config_builders_preserve_values_and_filter_by_id() {
        let stdio = sample();
        let http = McpServer { id: "two".into(), name: "remote".into(), transport: "http".into(),
            url: Some("https://example.com/mcp".into()), headers: BTreeMap::from([("X-Token".into(), "secret\"".into())]), ..stdio.clone() };
        let off = McpServer { id: "three".into(), name: "off".into(), enabled: false, ..stdio.clone() };
        let all = vec![stdio.clone(), http.clone(), off];
        assert_eq!(effective(&all, &[stdio.id.clone()]), vec![http.clone()]);
        assert_eq!(effective(&all, &[stdio.name.clone()]), vec![stdio.clone(), http.clone()]);
        assert_eq!(claude_config(&[stdio.clone(), http.clone()]), json!({"mcpServers": {
            "local-files": {"type":"stdio", "command":stdio.command, "args":stdio.args, "env":stdio.env},
            "remote": {"type":"http", "url":http.url, "headers":http.headers}
        }}));
        assert_eq!(codex_args(&[stdio, http]), vec![
            "-c", r#"mcp_servers.local-files.command="C:\\Program Files\\mcp.exe""#,
            "-c", r#"mcp_servers.local-files.args=["a\"b","line\nnext"]"#,
            "-c", r#"mcp_servers.local-files.env={"TOKEN"="x\\y"}"#,
            "-c", "mcp_servers.local-files.enabled=true",
            "-c", r#"mcp_servers.remote.url="https://example.com/mcp""#,
            "-c", r#"mcp_servers.remote.http_headers={"X-Token"="secret\""}"#,
            "-c", "mcp_servers.remote.enabled=true",
        ]);
        assert_eq!(claude_config(&[]), json!({"mcpServers":{}}));
        assert!(codex_args(&[]).is_empty());
    }

    #[test]
    fn toml_escaping_covers_control_chars_unicode_and_injection() {
        assert_eq!(toml_string("\"\\\n\r\t\0\u{8}\u{c}\u{1f}\u{7f}é🪐"),
            "\"\\\"\\\\\\n\\r\\t\\u0000\\u0008\\u000C\\u001F\\u007Fé🪐\"");
        assert_eq!(toml_string("\"]; enabled=false #"), "\"\\\"]; enabled=false #\"");
        assert_eq!(toml_map(&BTreeMap::from([("a.b\"".into(), "\n".into())])), r#"{"a.b\""="\n"}"#);
    }

    #[test]
    fn storage_upserts_rejects_duplicate_names_and_deletes() {
        let db = crate::db::Db::memory();
        assert!(list(&db).unwrap().is_empty());
        let saved = save(&db, McpServer { id: String::new(), ..sample() }).unwrap();
        assert!(!saved.id.is_empty());
        assert!(save(&db, McpServer { id: "another".into(), ..saved.clone() }).is_err());
        let changed = save(&db, McpServer { enabled: false, ..saved }).unwrap();
        assert_eq!(list(&db).unwrap(), vec![changed.clone()]);
        delete(&db, &changed.id).unwrap();
        assert!(list(&db).unwrap().is_empty());
    }

    #[test]
    fn import_reads_only_top_level_supported_valid_servers_without_saving() {
        let config = json!({"mcpServers":{
            "local": {"command":"node", "args":["server.js"], "env":{"KEY":"value"}},
            "remote": {"type":"http", "url":"https://example.com/mcp", "headers":{"Authorization":"secret"}},
            "old-sse": {"type":"sse", "url":"https://example.com/sse"},
            "Bad Name": {"command":"node"}, "invalid": {"args":[]}
        }, "projects":{"/repo":{"mcpServers":{"project-only":{"command":"node"}}}}});
        let candidates = import_config(&config);
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].name, "local");
        assert_eq!(candidates[0].env["KEY"], "value");
        assert_eq!(candidates[1].headers["Authorization"], "secret");
        assert!(candidates.iter().all(|s| !s.id.is_empty() && s.enabled));
        assert!(import_config(&json!({})).is_empty());
    }

    #[test]
    fn writes_and_replaces_workspace_config() {
        let home = tempfile::tempdir().unwrap();
        let path = write_claude_config(home.path(), "workspace-1", &[sample()]).unwrap();
        assert_eq!(path, home.path().join("mcp/workspace-1.json"));
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(), claude_config(&[sample()]));
        write_claude_config(home.path(), "workspace-1", &[]).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap(), claude_config(&[]));
        assert!(write_claude_config(home.path(), "../escape", &[]).is_err());
    }

    #[tokio::test]
    async fn http_probe_posts_initialize_with_headers_and_reads_json_or_sse() {
        use tokio::net::TcpListener;
        for sse in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server_task = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(socket);
                let mut header = String::new();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                    header.push_str(&line);
                    if line == "\r\n" { break; }
                }
                assert!(header.starts_with("POST /mcp HTTP/1.1"));
                assert!(header.to_ascii_lowercase().contains("x-test: secret\r\n"));
                let mut body = vec![0; length];
                reader.read_exact(&mut body).await.unwrap();
                let request: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(request["method"], "initialize");
                assert_eq!(request["params"]["clientInfo"]["name"], "Orbit");
                let response = json!({"jsonrpc":"2.0", "id":request["id"], "result":{"serverInfo":{"name":"fixture", "version":"1.2"}}});
                let (content_type, body) = if sse {
                    ("text/event-stream", format!("event: message\r\ndata: {response}\r\n\r\n"))
                } else { ("application/json", response.to_string()) };
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                reader.get_mut().write_all(reply.as_bytes()).await.unwrap();
                if sse { tokio::time::sleep(Duration::from_millis(500)).await; }
            });
            let server = McpServer { transport: "http".into(), url: Some(format!("http://{address}/mcp")),
                headers: BTreeMap::from([("X-Test".into(), "secret".into())]), ..sample() };
            let info = test(&server).await.unwrap();
            assert_eq!((info.name.as_str(), info.version.as_str()), ("fixture", "1.2"));
            server_task.await.unwrap();
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stdio_probe_initializes_and_reports_errors() {
        let script = r#"$r = [Console]::ReadLine() | ConvertFrom-Json; if ($r.method -ne 'initialize' -or $env:ORBIT_MCP_TEST -ne 'yes') { exit 1 }; [Console]::WriteLine('{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"fixture","version":"3"}}}'); Start-Sleep -Seconds 30"#;
        let server = McpServer { command: "powershell.exe".into(),
            args: vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script.into()],
            env: BTreeMap::from([("ORBIT_MCP_TEST".into(), "yes".into())]), ..sample() };
        let info = test(&server).await.unwrap();
        assert_eq!((info.name.as_str(), info.version.as_str()), ("fixture", "3"));
        let server = McpServer { args: vec!["-NoProfile".into(), "-Command".into(), "exit 0".into()], ..server };
        assert!(test(&server).await.unwrap_err().to_string().contains("closed stdout"));
    }

    #[test]
    fn initialize_result_and_error() {
        let info = server_info(&json!({"id":1,"result":{"serverInfo":{"name":"test","version":"2"}}})).unwrap();
        assert_eq!((info.name.as_str(), info.version.as_str()), ("test", "2"));
        assert!(server_info(&json!({"id":1,"error":{"code":-32603,"message":"failed"}})).unwrap_err().to_string().contains("failed"));
        assert!(server_info(&json!({"id":1,"result":{}})).is_err());
        assert!(server_info(&json!({"id":2,"result":{"serverInfo":{"name":"x","version":"1"}}})).is_err());
    }
}
