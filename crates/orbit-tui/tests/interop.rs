//! Against the app's real bridge server (src-tauri `orb_interop_server`), not a fake: every RPC
//! the TUI uses must decode into `orbit-proto`'s types, and a streamed turn must reach the
//! transcript through the real `update` loop. Ignored by default; `scripts/orb-interop.sh` runs it.

use orbit_proto::*;
use orbit_tui::app::{update, App, Config, Msg, Tag};
use orbit_tui::backend::{Backend, LiveBackend};
use orbit_tui::theme::{Depth, Theme, Variant};
use orbit_tui::transcript::{fold, Block};
use serde_json::{json, Value};
use std::time::Duration;

async fn call<T: serde::de::DeserializeOwned>(b: &LiveBackend, method: &str, params: Value) -> T {
    let v = b.rpc(method, params.clone()).await.unwrap_or_else(|e| panic!("{method} {params}: {e}"));
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{method} reply doesn't match orbit-proto: {e}\n{v}"))
}

#[tokio::test]
#[ignore]
async fn against_the_real_bridge() {
    let cfg = read_local_config().expect("set ORBIT_LOCAL_PORT and ORBIT_LOCAL_TOKEN (see scripts/orb-interop.sh)");
    let (client, pushes) = Client::connect_local(cfg).await.expect("connect");
    assert!(!client.server_version.is_empty());
    let b = LiveBackend::new(client, pushes);
    let mut pushes = b.subscribe();
    let w = json!({ "workspaceId": "w1" });

    let hello: Hello = call(&b, "hello", json!({})).await;
    assert_eq!(hello.settings.stale_days, 7);
    let snap: Snapshot = call(&b, "snapshot", json!({})).await;
    assert_eq!(snap.workspaces[0].name, "interop");
    assert_eq!(snap.workspaces[0].status, Status::Done);
    assert_eq!(snap.workspaces[0].ahead, 2);
    assert_eq!(snap.repos[0].base_branch, "main");

    // Every persisted event kind decodes (none falls into `Other`) and folds.
    let events: Vec<StoredEvent> = call(&b, "events", w.clone()).await;
    assert_eq!(events.len(), 12);
    let others: Vec<_> = events.iter().filter(|e| e.event == AgentEvent::Other).collect();
    assert!(others.is_empty(), "event kinds orb doesn't know: {others:?}");
    let blocks = fold(&events);
    assert!(matches!(
        blocks.iter().find(|b| matches!(b, Block::TurnEnd { .. })),
        Some(Block::TurnEnd { tokens: Some(1250), .. })
    ));
    assert!(blocks.iter().any(|b| matches!(b, Block::Plan { done: 1, total: 2, .. })));
    assert!(blocks.iter().any(|b| matches!(b, Block::Error { message, .. } if message.contains("code 1"))));

    let skills: Vec<Skill> = call(&b, "listSkills", w.clone()).await;
    assert_eq!(skills[0].kind, "command");
    let pr: Option<PrStatus> = call(&b, "prStatus", w.clone()).await;
    assert_eq!(pr.unwrap().checks.failing, vec!["test"]);
    let ship: PrepareShip = call(&b, "ship", json!({ "workspaceId": "w1", "skipChecks": false })).await;
    assert_eq!(ship.checks.unwrap().kind, "timedOut");
    let merged: MergeOutcome = call(&b, "merge", json!({ "workspaceId": "w1", "number": 7 })).await;
    assert!(merged.archived);
    let _: i64 = call(&b, "markSeen", w.clone()).await;
    let _: i64 = call(&b, "dismiss", w.clone()).await;

    // Review: the app's real scope code over a temp repo.
    let base: Review = call(&b, "review", json!({ "workspaceId": "w1", "scope": Scope::Base })).await;
    let paths: Vec<&str> = base.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths.len(), 3, "{paths:?}");
    assert!(base.files.iter().any(|f| f.path == "c.txt" && f.untracked));
    assert_eq!(base.commits.len(), 2);
    assert!(base.commits[0].ts > 1_000_000_000_000, "ts is milliseconds");
    assert!(base.turn_available);
    let old: FileAt = call(&b, "fileAt", json!({ "workspaceId": "w1", "path": "a.txt", "ref": base.old_ref })).await;
    assert_eq!(old.text.as_deref(), Some("one\ntwo\nthree\n"));
    let new: FileAt = call(&b, "fileAt", json!({ "workspaceId": "w1", "path": "a.txt", "ref": base.new_ref })).await;
    assert_eq!(new.text.as_deref(), Some("one\nTWO\nthree\n"));
    let missing: FileAt =
        call(&b, "fileAt", json!({ "workspaceId": "w1", "path": "b.txt", "ref": base.old_ref })).await;
    assert_eq!(missing.text, None);
    let turn: Review = call(&b, "review", json!({ "workspaceId": "w1", "scope": Scope::Turn })).await;
    assert!(turn.files.iter().any(|f| f.path == "b.txt"));
    let sha = base.commits[0].sha.clone();
    let one: Review =
        call(&b, "review", json!({ "workspaceId": "w1", "scope": Scope::Commit { sha: sha.clone() } })).await;
    assert_eq!(one.scope, Scope::Commit { sha });
    assert_eq!(one.files.len(), 1);
    let c = ReviewComment {
        path: "a.txt".into(),
        start_line: 2,
        end_line: 2,
        side: "new".into(),
        text: "why?".into(),
        excerpt: "TWO".into(),
    };
    let _: Value = call(&b, "sendReview", json!({ "workspaceId": "w1", "comments": [c] })).await;
    let err = b.rpc("events", json!({ "workspaceId": "nope" })).await.unwrap_err();
    assert_eq!(err, "unknown workspace");

    // Palette / New workspace / archive / profiles.
    assert!(!hello.agents.claude.models.is_empty(), "hello.agents: {:?}", hello.agents);
    let profiles: Vec<Profile> = call(&b, "listProfiles", json!({})).await;
    assert!(profiles.iter().any(|p| p.readonly && !p.name.is_empty()));
    let created: Workspace = call(
        &b,
        "createWorkspace",
        json!({ "repoId": "r1", "name": "Try the palette", "agent": "claude", "model": null, "profile": null, "task": "" }),
    )
    .await;
    assert!(!created.id.is_empty() && !created.branch.is_empty());
    let switched: Workspace =
        call(&b, "switchProfile", json!({ "workspaceId": "w1", "profile": profiles[0].id.clone() })).await;
    assert_eq!(switched.profile.as_deref(), Some(profiles[0].id.as_str()));
    let _: Value = call(&b, "compact", w.clone()).await;
    let _: Value = call(&b, "newSession", w.clone()).await;
    let files: Vec<String> = call(&b, "listFiles", w.clone()).await;
    assert!(files.contains(&"a.txt".to_string()));
    // Archive: the first try reports uncommitted changes the way the TUI expects, then force.
    let err = b.rpc("archive", json!({ "workspaceId": "w1", "force": false })).await.unwrap_err();
    assert!(err.starts_with("Uncommitted changes"), "{err}");
    let mut app = App::new(Config::default(), Theme::new(Variant::Void, Depth::TrueColor), 0);
    update(&mut app, Msg::Rpc(Tag::Snapshot, Ok(serde_json::to_value(&snap).unwrap())));
    update(&mut app, Msg::Rpc(Tag::Archive { ws: "w1".into(), force: false }, Err(err)));
    assert!(matches!(app.overlay, Some(orbit_tui::app::Overlay::Confirm { .. })), "force confirm");

    // A streamed turn, through the TUI's own update loop.
    let cmds = orbit_tui::app::open_ws(&mut app, "w1");
    assert!(!cmds.is_empty());
    update(
        &mut app,
        Msg::Rpc(Tag::Events { ws: "w1".into(), since: None }, Ok(serde_json::to_value(&events).unwrap())),
    );
    let _: Value = call(&b, "send", json!({ "workspaceId": "w1", "text": "hi there" })).await;
    let mut saw_delta = false;
    let done = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(p) = pushes.recv().await {
            if let Push::Event(e) = &p {
                saw_delta |= matches!(e.event, AgentEvent::TextDelta { .. });
                let end = matches!(e.event, AgentEvent::TurnCompleted { .. });
                update(&mut app, Msg::Push(p));
                if end {
                    return;
                }
            }
        }
    })
    .await;
    assert!(done.is_ok(), "no turnCompleted push");
    assert!(saw_delta);
    let d = &app.data["w1"];
    assert!(d.live.is_empty());
    assert!(d
        .blocks
        .iter()
        .any(|b| matches!(b, Block::Assistant { text, .. } if text == "Hello from the real bridge")));
    assert!(d.blocks.iter().any(|b| matches!(b, Block::User { text, .. } if text == "hi there")));

    // `orb ls` over the same connection.
    let out = orbit_tui::cli::ls(&b, false, 1_700_000_200_000).await.unwrap();
    assert!(out.contains("interop"), "{out}");

    // Forced archive: `null`, and a workspace-removed push the TUI applies.
    let _: Value = call(&b, "archive", json!({ "workspaceId": "w1", "force": true })).await;
    let removed = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(p) = pushes.recv().await {
            if let Push::WorkspaceRemoved(id) = &p {
                let id = id.clone();
                update(&mut app, Msg::Push(p));
                return id;
            }
        }
        String::new()
    })
    .await
    .expect("workspace-removed push");
    assert_eq!(removed, "w1");
    assert!(app.ws("w1").is_none());
}
