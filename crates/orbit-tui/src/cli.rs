//! Command line (behaviour.md §7) and `~/.orbit/tui.json`.

use crate::app::{update, App, Config, Msg, Side, Tag};
use crate::attention::{self, Group};
use crate::backend::Backend;
use crate::theme::{Depth, Theme, Variant};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Args {
    pub demo: bool,
    pub ls: bool,
    pub doctor: bool,
    pub json: bool,
    pub help: bool,
    pub version: bool,
    pub workspace: Option<String>,
    pub theme: Option<String>,
    pub color: Option<String>,
    pub rail: Option<String>,
    pub no_motion: bool,
}

pub const HELP: &str = "orb: Orbit's terminal UI

usage:
  orb                    Inbox when something needs you, else your latest workspace
  orb <workspace>        open a workspace (name, or a unique prefix of its name or id)
  orb ls [--json]        list workspaces and exit
  orb doctor             check the connection to Orbit and every read-only request, then exit
  orb --demo             try it with built-in fake data (no desktop app needed)

flags:
  --theme void|paper|auto   colours (default auto)
  --color truecolor|16      colour depth (default: detected; NO_COLOR forces plain)
  --rail left|right|off     fleet rail position
  --no-motion               static sweep instead of the animation
  -h, --help | -V, --version

keys: alt+1 chat · alt+2 inbox · alt+3 review · ctrl+s ship · / skills · ctrl+k switch
      ctrl+x then 1/2/3/s/r/q when alt doesn't reach the app · ctrl+c twice quits";

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = args.into_iter();
    while let Some(s) = it.next() {
        let mut val = |name: &str| it.next().ok_or(format!("{name} needs a value"));
        match s.as_str() {
            "--demo" => a.demo = true,
            "--json" => a.json = true,
            "-h" | "--help" => a.help = true,
            "-V" | "--version" => a.version = true,
            "--no-motion" => a.no_motion = true,
            "--theme" => a.theme = Some(val("--theme")?),
            "--color" => a.color = Some(val("--color")?),
            "--rail" => a.rail = Some(val("--rail")?),
            "ls" if a.workspace.is_none() && !a.ls && !a.doctor => a.ls = true,
            "doctor" if a.workspace.is_none() && !a.ls && !a.doctor => a.doctor = true,
            f if f.starts_with('-') => return Err(format!("unknown flag {f}")),
            w if a.workspace.is_none() && !a.ls && !a.doctor => a.workspace = Some(w.to_string()),
            other => return Err(format!("unexpected argument {other}")),
        }
    }
    if let Some(t) = &a.theme {
        if !matches!(t.as_str(), "void" | "paper" | "auto") {
            return Err("--theme is void, paper or auto".into());
        }
    }
    if let Some(r) = &a.rail {
        if !matches!(r.as_str(), "left" | "right" | "off") {
            return Err("--rail is left, right or off".into());
        }
    }
    Ok(a)
}

/// `~/.orbit/tui.json`, all keys optional.
pub fn load_settings() -> Value {
    orbit_proto::client::orbit_home()
        .and_then(|h| std::fs::read_to_string(h.join("tui.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}))
}

pub fn config(args: &Args, file: &Value) -> (Config, Theme) {
    let mut cfg = Config { demo: args.demo, ..Config::default() };
    let rail = args.rail.clone().or_else(|| file.get("railSide").and_then(Value::as_str).map(str::to_string));
    match rail.as_deref() {
        Some("right") => cfg.rail_side = Side::Right,
        Some("off") => cfg.rail_on = false,
        _ => {}
    }
    let motion_env = std::env::var("ORBIT_REDUCED_MOTION").is_ok_and(|v| v == "1");
    cfg.motion = !(args.no_motion || motion_env) && file.get("motion").and_then(Value::as_bool).unwrap_or(true);
    if let Some(p) = file.get("pinned").and_then(Value::as_array) {
        cfg.pinned = p.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    }
    let theme = args.theme.clone().or_else(|| file.get("theme").and_then(Value::as_str).map(str::to_string));
    let variant = match theme.as_deref() {
        Some("paper") => Variant::Paper,
        Some("void") => Variant::Void,
        _ => Theme::detect_variant(),
    };
    let depth = match args.color.as_deref() {
        Some("truecolor") | Some("24bit") => Depth::TrueColor,
        Some("16") => Depth::Ansi16,
        Some("none") => Depth::NoColor,
        _ => Theme::detect_depth(),
    };
    (cfg, Theme::new(variant, depth))
}

/// `orb ls`: one line per workspace, grouped like the rail.
pub async fn ls(backend: &dyn Backend, json_out: bool, now: i64) -> Result<String, String> {
    let (cfg, theme) = (Config::default(), Theme::new(Variant::Void, Depth::NoColor));
    let mut app = App::new(cfg, theme, now);
    app.started = true; // no start screen
    let hello = backend.rpc("hello", json!({})).await?;
    update(&mut app, Msg::Rpc(Tag::Hello, Ok(hello)));
    let snap = backend.rpc("snapshot", json!({})).await?;
    update(&mut app, Msg::Rpc(Tag::Snapshot, Ok(snap)));
    // PR state feeds "Checks failing" / "Changes requested"; failures are silent, as in the UI.
    let candidates: Vec<String> =
        app.workspaces.iter().filter(|w| w.ahead > 0 || w.issue_number.is_some()).map(|w| w.id.clone()).collect();
    for id in candidates {
        let res = backend.rpc("prStatus", json!({ "workspaceId": id })).await;
        update(&mut app, Msg::Rpc(Tag::PrStatus(id), res));
    }
    let fleet = app.fleet();
    let repo = |id: &str| app.repos.iter().find(|r| r.id == id).map(|r| r.name.clone()).unwrap_or_default();
    if json_out {
        let rows: Vec<Value> = fleet
            .iter()
            .filter_map(|r| app.ws(&r.id).map(|w| (r, w)))
            .map(|(r, w)| {
                json!({
                    "id": w.id,
                    "name": w.name,
                    "repo": repo(&w.repo_id),
                    "status": w.status,
                    "group": match r.group { Group::NeedsYou => "needsYou", Group::Running => "running", Group::Done => "done" },
                    "reason": r.reason.map(attention::label),
                })
            })
            .collect();
        return Ok(serde_json::to_string_pretty(&json!({ "workspaces": rows })).unwrap_or_default());
    }
    let name_w = fleet.iter().filter_map(|r| app.ws(&r.id)).map(|w| w.name.chars().count()).max().unwrap_or(4).max(4);
    let mut out = String::new();
    let mut last = None;
    for r in &fleet {
        let Some(w) = app.ws(&r.id) else { continue };
        if last != Some(r.group) {
            if last.is_some() {
                out.push('\n');
            }
            out.push_str(r.group.label());
            out.push('\n');
            last = Some(r.group);
        }
        let status =
            serde_json::to_value(w.status).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        let reason = r.reason.map(attention::label).unwrap_or("");
        let line = format!("● {:<name_w$}  {:<7}  {:<12}  {reason}", w.name, status, repo(&w.repo_id));
        out.push_str(line.trim_end());
        out.push('\n');
    }
    if fleet.is_empty() {
        out.push_str("No workspaces.\n");
    }
    Ok(out)
}

/// Event types the app sends today; anything else means the app is newer than this `orb`.
const KNOWN_EVENTS: &[&str] = &[
    "sessionStarted",
    "userMessage",
    "turnStarted",
    "plan",
    "textDelta",
    "message",
    "toolCall",
    "toolDraft",
    "toolResult",
    "turnCompleted",
    "usage",
    "sessionReset",
    "error",
    "exited",
    "rateLimits",
];

/// One `orb doctor` line.
pub fn check_line(ok: bool, what: &str, detail: &str) -> String {
    format!("{} {:<11} {detail}", if ok { "✓" } else { "✗" }, what)
}

async fn typed<T: serde::de::DeserializeOwned>(b: &dyn Backend, method: &str, params: Value) -> Result<T, String> {
    let v = b.rpc(method, params).await?;
    serde_json::from_value(v)
        .map_err(|e| format!("reply doesn't match what orb expects ({e}); update orb and the app together"))
}

/// `orb doctor` after the connection is up: every read-only request the UI makes, decoded the same
/// way. Returns the report and whether everything passed. Never sends, ships or merges.
pub async fn doctor(b: &dyn Backend) -> (String, bool) {
    use orbit_proto::{FileAt, Hello, PrStatus, Review, Scope, Skill, Snapshot, StoredEvent};
    let mut out = Vec::new();
    let mut all = true;
    let mut line = |ok: bool, what: &str, detail: String| {
        all &= ok;
        out.push(check_line(ok, what, &detail));
    };
    match typed::<Hello>(b, "hello", json!({})).await {
        Ok(h) => line(
            true,
            "hello",
            format!(
                "Orbit {} · stale after {} days or {} behind · save points {}",
                if h.version.is_empty() { "?" } else { &h.version },
                h.settings.stale_days,
                h.settings.stale_behind,
                if h.settings.save_commits { "on" } else { "off" }
            ),
        ),
        Err(e) => line(false, "hello", e),
    }
    let snap = match typed::<Snapshot>(b, "snapshot", json!({})).await {
        Ok(s) => {
            line(true, "snapshot", format!("{} workspaces in {} repos", s.workspaces.len(), s.repos.len()));
            s
        }
        Err(e) => {
            line(false, "snapshot", e);
            return (out.join("\n"), false);
        }
    };
    match typed::<Vec<Skill>>(b, "listSkills", json!({})).await {
        Ok(s) => {
            let first = s.first().map(|s| s.id.clone()).unwrap_or_else(|| "none".into());
            line(!s.is_empty(), "listSkills", format!("{} skills, first {first}", s.len()))
        }
        Err(e) => line(false, "listSkills", e),
    }
    let ts = |w: &orbit_proto::Workspace| {
        snap.summaries.iter().find(|s| s.workspace_id == w.id).map(|s| s.last_activity_ts).unwrap_or(w.updated_at)
    };
    let Some(ws) = snap.workspaces.iter().max_by_key(|w| ts(w)) else {
        line(true, "events", "no workspaces yet: create one in Orbit to check the rest".into());
        return (out.join("\n"), all);
    };
    let id = json!({ "workspaceId": ws.id });
    match b.rpc("events", id.clone()).await {
        Ok(raw) => {
            let unknown: Vec<String> = raw
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|e| e.pointer("/event/type").and_then(Value::as_str))
                        .filter(|t| !KNOWN_EVENTS.contains(t))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            match serde_json::from_value::<Vec<StoredEvent>>(raw) {
                Ok(evs) if unknown.is_empty() => {
                    line(true, "events", format!("{}: {} events, all understood", ws.name, evs.len()))
                }
                Ok(evs) => line(
                    true,
                    "events",
                    format!("{}: {} events; ignoring newer kinds {:?}", ws.name, evs.len(), unknown),
                ),
                Err(e) => line(false, "events", format!("{}: {e}", ws.name)),
            }
        }
        Err(e) => line(false, "events", e),
    }
    match typed::<Option<PrStatus>>(b, "prStatus", id.clone()).await {
        Ok(Some(p)) => line(true, "prStatus", format!("{}: #{} {}", ws.name, p.number, p.state.to_lowercase())),
        Ok(None) => line(true, "prStatus", format!("{}: no pull request", ws.name)),
        Err(e) => line(false, "prStatus", e),
    }
    match typed::<Review>(b, "review", json!({ "workspaceId": ws.id, "scope": Scope::Base })).await {
        Ok(r) => {
            line(true, "review", format!("{}: {} files, {} commits vs base", ws.name, r.files.len(), r.commits.len()));
            if let Some(f) = r.files.first() {
                let mut ok = true;
                let mut why = String::new();
                for rf in [&r.old_ref, &r.new_ref] {
                    if let Err(e) =
                        typed::<FileAt>(b, "fileAt", json!({ "workspaceId": ws.id, "path": f.path, "ref": rf })).await
                    {
                        ok = false;
                        why = e;
                    }
                }
                line(ok, "fileAt", if ok { format!("{} (both sides)", f.path) } else { why });
            }
        }
        Err(e) => line(false, "review", e),
    }
    (out.join("\n"), all)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Result<Args, String> {
        parse(s.split_whitespace().map(String::from))
    }

    #[test]
    fn parses() {
        assert!(p("--demo").unwrap().demo);
        let a = p("ls --json").unwrap();
        assert!(a.ls && a.json);
        assert_eq!(p("fix-login --rail right").unwrap().workspace.as_deref(), Some("fix-login"));
        assert!(p("--rail up").is_err());
        assert!(p("--bogus").is_err());
        assert!(p("a b").is_err());
        assert!(p("doctor").unwrap().doctor);
    }

    #[test]
    fn file_settings_apply_and_flags_win() {
        let file = json!({"railSide":"right","motion":false,"pinned":["shipkit:ship"],"theme":"paper"});
        let (c, t) = config(&p("").unwrap(), &file);
        assert_eq!(c.rail_side, Side::Right);
        assert!(!c.motion);
        assert_eq!(c.pinned, vec!["shipkit:ship"]);
        assert_eq!(t.variant, Variant::Paper);
        let (c, t) = config(&p("--rail off --theme void").unwrap(), &file);
        assert!(!c.rail_on);
        assert_eq!(t.variant, Variant::Void);
    }
}

#[cfg(test)]
mod doctor_tests {
    #[tokio::test]
    async fn demo_passes() {
        let demo = crate::demo::DemoBackend::new(1_793_455_200_000, false);
        let (report, ok) = super::doctor(&demo).await;
        assert!(ok, "{report}");
        assert!(report.contains("✓ snapshot    8 workspaces in 2 repos"), "{report}");
        assert!(report.contains("✓ fileAt"), "{report}");
    }
}

/// Merges `patch` into `~/.orbit/tui.json`, keeping keys it doesn't know (keys.md §6).
pub fn save_settings(patch: &Value) {
    let Some(home) = orbit_proto::client::orbit_home() else { return };
    let path = home.join("tui.json");
    let mut cur = load_settings();
    if let (Some(cur), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            cur.insert(k.clone(), v.clone());
        }
    }
    let _ = std::fs::create_dir_all(&home);
    if let Ok(s) = serde_json::to_string_pretty(&cur) {
        let _ = std::fs::write(path, s + "\n");
    }
}
