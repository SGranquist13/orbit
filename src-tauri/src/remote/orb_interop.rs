//! Cross-implementation check against `orb`'s real client (crates/orbit-tui).
//!
//! Starts the real local-mode bridge server whose replies are the app's own serde types (and the
//! real `review` / `fileAt` code over a temp git repo), so a renamed field on either side fails.
//! Run: `cargo test orb_interop_server -- --ignored --nocapture`, then within 120 s, in `crates/`:
//! `ORBIT_LOCAL_PORT=<port> ORBIT_LOCAL_TOKEN=<token> cargo test --test interop -- --ignored`.
//! `scripts/orb-interop.sh` does both. `ORB_INTEROP_OUT=<file>` also writes `port token` there.

use super::review::{self, Scope};
use super::server::{start, Backend, Device, Hub, Mode, ServerConfig};
use crate::agent::{AgentEvent, PlanItem, PlanStatus};
use crate::checks::{CheckKind, CheckResult};
use crate::code::fs::{file_at_sha, file_at_worktree};
use crate::db::{Repo, StoredEvent, Summary, Workspace};
use crate::gh::{Checks, PrStatus};
use crate::skills::{Skill, SkillKind};
use crate::trunk::{MergeOutcome, PrepareShip};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const TOKEN: &str = "orb-interop-token";

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().expect("git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// main: a.txt; branch: a.txt edited (turn 1), b.txt added (turn 2); worktree: c.txt untracked.
fn repo() -> (tempfile::TempDir, Vec<String>) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.email", "t@t"]);
    git(p, &["config", "user.name", "t"]);
    std::fs::write(p.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-qm", "base"]);
    git(p, &["checkout", "-qb", "feat"]);
    std::fs::write(p.join("a.txt"), "one\nTWO\nthree\n").unwrap();
    git(p, &["commit", "-qam", "wip: edit a"]);
    let t1 = git(p, &["rev-parse", "HEAD"]);
    std::fs::write(p.join("b.txt"), "new file\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-qm", "wip: add b"]);
    let t2 = git(p, &["rev-parse", "HEAD"]);
    std::fs::write(p.join("c.txt"), "untracked\n").unwrap();
    (d, vec![t1, t2])
}

fn stored(seq: i64, event: AgentEvent) -> StoredEvent {
    StoredEvent { commit_sha: None, seq, ts: 1_700_000_000_000 + seq * 1000, event }
}

struct Interop {
    hub: Arc<Hub>,
    root: PathBuf,
    turns: Vec<String>,
    events: Arc<Mutex<Vec<StoredEvent>>>,
}

impl Interop {
    fn workspace(&self) -> Workspace {
        Workspace {
            id: "w1".into(),
            repo_id: "r1".into(),
            name: "interop".into(),
            branch: "feat".into(),
            path: self.root.to_string_lossy().into_owned(),
            agent: "claude".into(),
            model: Some("sonnet".into()),
            status: "done".into(),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_005_000,
            seen_seq: 1,
            ahead: 2,
            checks_command: Some("bun run check".into()),
            sync_conflicts: vec![],
            ..Default::default()
        }
    }

    fn summary(&self) -> Summary {
        let evs = self.events.lock().unwrap();
        let last = evs.last().map(|e| e.seq).unwrap_or(0);
        Summary {
            workspace_id: "w1".into(),
            last_seq: last,
            last_activity_ts: evs.last().map(|e| e.ts).unwrap_or(0),
            last_turn_seq: last,
            last_assistant_text: Some("Done. Want me to ship it?".into()),
            last_user_text: Some("fix it".into()),
            ..Default::default()
        }
    }

    fn publish(hub: &Hub, seq: Option<i64>, event: &AgentEvent) {
        hub.publish(json!({ "t": "event", "workspaceId": "w1", "seq": seq, "ts": 1_700_000_100_000i64, "event": event }));
    }
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

impl Backend for Interop {
    fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let ws = params.get("workspaceId").and_then(Value::as_str).unwrap_or("");
        if method != "hello" && method != "snapshot" && method != "listSkills" && ws != "w1" {
            return Err("unknown workspace".into());
        }
        match method {
            "hello" => {
                Ok(json!({ "settings": { "staleDays": 7, "staleBehind": 50, "saveCommits": true }, "version": env!("CARGO_PKG_VERSION") }))
            }
            "snapshot" => ok(json!({
                "repos": [Repo { id: "r1".into(), name: "repo".into(), path: "/r".into(), base_branch: "main".into() }],
                "workspaces": [self.workspace()],
                "summaries": [self.summary()],
            })),
            "events" => {
                let since = params.get("sinceSeq").and_then(Value::as_i64).unwrap_or(0);
                let evs: Vec<StoredEvent> = self.events.lock().unwrap().iter().filter(|e| e.seq > since).cloned().collect();
                ok(evs)
            }
            "markSeen" | "dismiss" => ok(self.events.lock().unwrap().last().map(|e| e.seq).unwrap_or(0)),
            "interrupt" | "runSkill" | "sendReview" => Ok(Value::Null),
            "listSkills" => ok(vec![Skill {
                id: "shipkit:ship".into(),
                pack: "shipkit".into(),
                kind: SkillKind::Command,
                name: "ship".into(),
                description: "Commit everything, push the branch, and open (or update) a draft PR.".into(),
                argument_hint: Some("[extra notes]".into()),
                path: "/packs/shipkit/commands/ship.md".into(),
            }]),
            "prStatus" => ok(Some(PrStatus {
                number: 7,
                title: "Interop PR".into(),
                url: "https://github.com/o/r/pull/7".into(),
                state: "OPEN".into(),
                is_draft: false,
                mergeable: "MERGEABLE".into(),
                review_decision: "REVIEW_REQUIRED".into(),
                checks: Checks { passed: 2, failed: 1, pending: 0, failing: vec!["test".into()] },
            })),
            "ship" => ok(PrepareShip {
                ok: false,
                checks: Some(CheckResult {
                    ok: false,
                    kind: CheckKind::TimedOut,
                    command: "bun run check".into(),
                    output_tail: "…".into(),
                    duration_ms: 1200,
                }),
                squashed: 0,
                notes: None,
            }),
            "merge" => ok(MergeOutcome { archived: true }),
            "review" => {
                let scope = Scope::parse(params.get("scope"))?;
                ok(review::review(&self.root, "main", &scope, &self.turns, true)?)
            }
            "fileAt" => {
                let root = self.root.to_string_lossy();
                let path = params.get("path").and_then(Value::as_str).unwrap_or("");
                let r = params.get("ref").and_then(Value::as_str).unwrap_or("");
                let f = if r == "worktree" { file_at_worktree(&root, path) } else { file_at_sha(&root, path, r) };
                ok(f.map_err(|e| e.to_string())?)
            }
            "send" => {
                let text = params.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                let (hub, events) = (self.hub.clone(), self.events.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(150));
                    let script = vec![
                        (true, AgentEvent::UserMessage { text, skill: None, images: vec![], files: vec![] }),
                        (true, AgentEvent::TurnStarted),
                        (false, AgentEvent::TextDelta { text: "Hello ".into() }),
                        (true, AgentEvent::Message { text: "Hello from the real bridge".into() }),
                        (true, AgentEvent::ToolCall { id: "t1".into(), name: "Bash".into(), input: json!({ "command": "echo hi" }) }),
                        (true, AgentEvent::ToolResult { id: "t1".into(), output: "hi".into(), is_error: false, images: vec![] }),
                        (true, AgentEvent::TurnCompleted { duration_ms: Some(5), cost_usd: None, is_error: false, error: None, interrupted: false }),
                    ];
                    for (persist, ev) in script {
                        let seq = if persist {
                            let mut e = events.lock().unwrap();
                            let seq = e.last().map(|x| x.seq).unwrap_or(0) + 1;
                            e.push(stored(seq, ev.clone()));
                            Some(seq)
                        } else {
                            None
                        };
                        Interop::publish(&hub, seq, &ev);
                        std::thread::sleep(Duration::from_millis(40));
                    }
                });
                Ok(Value::Null)
            }
            other => Err(format!("unknown method {other}")),
        }
    }
    fn devices(&self) -> Vec<Device> {
        vec![]
    }
    fn save_devices(&self, _: &[Device]) {}
}

#[tokio::test]
#[ignore]
async fn orb_interop_server() {
    let (dir, turns) = repo();
    let hub = Arc::new(Hub::new());
    // Every persisted variant the TUI renders, as the app serialises it.
    let events = Arc::new(Mutex::new(vec![
        stored(1, AgentEvent::SessionStarted { session_id: "s".into(), model: Some("sonnet".into()) }),
        stored(2, AgentEvent::UserMessage { text: "fix it".into(), skill: None, images: vec![], files: vec![] }),
        stored(3, AgentEvent::TurnStarted),
        stored(
            4,
            AgentEvent::Plan {
                items: vec![PlanItem { text: "look".into(), status: PlanStatus::Done }, PlanItem { text: "fix".into(), status: PlanStatus::InProgress }],
                explanation: None,
            },
        ),
        stored(5, AgentEvent::ToolCall { id: "a".into(), name: "Edit".into(), input: json!({ "file_path": "a.txt", "old_string": "two", "new_string": "TWO" }) }),
        stored(6, AgentEvent::ToolResult { id: "a".into(), output: "ok".into(), is_error: false, images: vec![] }),
        stored(7, AgentEvent::Message { text: "Done. Want me to ship it?".into() }),
        stored(
            8,
            AgentEvent::Usage {
                input_tokens: 1000,
                output_tokens: 200,
                cache_read_tokens: 5000,
                cache_write_tokens: 50,
                context_tokens: Some(41_000),
                context_window: Some(200_000),
                cost_usd: Some(0.01),
                model: Some("sonnet".into()),
            },
        ),
        stored(9, AgentEvent::TurnCompleted { duration_ms: Some(38_000), cost_usd: Some(0.01), is_error: false, error: None, interrupted: false }),
        stored(10, AgentEvent::Error { message: "warning".into() }),
        stored(11, AgentEvent::SessionReset),
        stored(12, AgentEvent::Exited { code: Some(1), stderr: "boom".into() }),
    ]));
    let backend = Arc::new(Interop { hub: hub.clone(), root: dir.path().to_path_buf(), turns, events });
    let cfg = ServerConfig {
        keypair: super::crypto::Keypair::generate(),
        name: "orb-interop".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        bind: "127.0.0.1".parse().unwrap(),
        port: 0,
        mode: Mode::Local { token: TOKEN.into() },
    };
    let server = start(cfg, backend, hub).await.unwrap();
    let port = server.addr.port();
    println!("ORBIT_LOCAL_PORT={port} ORBIT_LOCAL_TOKEN={TOKEN}");
    if let Ok(out) = std::env::var("ORB_INTEROP_OUT") {
        std::fs::write(out, format!("{port} {TOKEN}")).unwrap();
    }
    tokio::time::sleep(Duration::from_secs(120)).await;
    server.stop();
}
