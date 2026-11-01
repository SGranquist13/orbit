//! Every action in one place: the Ctrl+P palette lists them (only the ones that apply right now,
//! each with its shortcut), keys call the same `run`, and `?` shows the bindings per screen.
//! Also the New workspace dialog.

use crate::app::{
    self, go_chat, go_inbox, go_review, open_ws, run_skill, start_ship, App, Cmd, ConfirmAction, Focus, Overlay,
    Screen, Side, Tag,
};
use crate::theme::{Theme, Variant};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use orbit_proto::Status;
use serde_json::json;

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    GoChat,
    GoInbox,
    GoReview,
    Switcher,
    NewWorkspace,
    Ship,
    Stop,
    RunSkill(String),
    SkillPopup,
    FixCi,
    AddressComments,
    OpenPr,
    PickProfile,
    CycleProfile,
    SetProfile(Option<String>),
    Compact,
    NewSession,
    Dismiss(String),
    Archive(String),
    Open(String),
    ReviewSend,
    ReviewScope,
    ToggleRail,
    RailSide(Side),
    Theme(Variant),
    ToggleMotion,
    Help,
    Redraw,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteMode {
    Commands,
    Profiles,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub label: String,
    pub detail: String,
    pub key: &'static str,
    pub action: Action,
    /// Marks the current choice (profiles).
    pub current: bool,
}

fn item(label: impl Into<String>, key: &'static str, action: Action) -> Item {
    Item { label: label.into(), detail: String::new(), key, action, current: false }
}

/// The palette's entries for the current state, in display order.
pub fn items(app: &App, mode: PaletteMode, query: &str) -> Vec<Item> {
    let all = match mode {
        PaletteMode::Commands => commands(app, !query.is_empty()),
        PaletteMode::Profiles => profiles(app),
    };
    rank(all, query)
}

fn commands(app: &App, searching: bool) -> Vec<Item> {
    let mut v = Vec::new();
    let ws = app.cur_ws();
    let running = ws.is_some_and(|w| w.status == Status::Running);
    let pr_open = ws.and_then(|w| app.prs.get(&w.id)).is_some_and(|p| p.state == "OPEN");
    if app.screen == Screen::Review {
        let n = app.review.as_ref().and_then(|r| app.drafts.get(&r.ws)).map(|d| d.len()).unwrap_or(0);
        if n > 0 {
            v.push(item(
                format!("Send {n} review comment{}", if n == 1 { "" } else { "s" }),
                "enter",
                Action::ReviewSend,
            ));
        }
        v.push(item("Change review scope", "v", Action::ReviewScope));
    }
    if !app.repos.is_empty() {
        v.push(item("New workspace…", "ctrl+n", Action::NewWorkspace));
    }
    if let Some(w) = ws {
        if running {
            v.push(item(format!("Stop {}", w.name), "esc", Action::Stop));
        } else {
            v.push(item("Ship: checks, push, pull request", "ctrl+s", Action::Ship));
        }
        if pr_open {
            v.push(item("Fix CI", "", Action::FixCi));
            v.push(item("Address review comments", "", Action::AddressComments));
            v.push(item("Open the pull request in the browser", "", Action::OpenPr));
        }
        if app.screen != Screen::Review {
            v.push(item("Review changes", "alt+3", Action::GoReview));
        }
    }
    if app.screen != Screen::Inbox {
        v.push(item("Go to Inbox", "alt+2", Action::GoInbox));
    }
    if app.screen != Screen::Chat && ws.is_some() {
        v.push(item("Go to Chat", "alt+1", Action::GoChat));
    }
    v.push(item("Switch workspace…", "ctrl+k", Action::Switcher));
    if let Some(w) = ws {
        let profile = profile_name(app, w.profile.as_deref());
        let mut it = item("Switch profile…", "ctrl+o", Action::PickProfile);
        it.detail = profile;
        v.push(it);
        // Skills by name only while searching; otherwise one entry that opens the `/` popup.
        if searching {
            for s in &app.skills {
                let mut it = item(format!("/{}", s.id), "", Action::RunSkill(s.id.clone()));
                it.detail = s.description.clone();
                v.push(it);
            }
        } else if !app.skills.is_empty() {
            v.push(item("Run a skill…", "/", Action::SkillPopup));
        }
        v.push(item("Compact context", "", Action::Compact));
        v.push(item("Start a new session", "", Action::NewSession));
        if app.reason(w).is_some() {
            v.push(item("Dismiss from the Inbox", "d", Action::Dismiss(w.id.clone())));
        }
        v.push(item(format!("Archive {}…", w.name), "x", Action::Archive(w.id.clone())));
    }
    v.push(item(if app.rail_shown { "Hide the rail" } else { "Show the rail" }, "ctrl+b", Action::ToggleRail));
    let other = if app.cfg.rail_side == Side::Left { Side::Right } else { Side::Left };
    v.push(item(
        if other == Side::Right { "Move the rail to the right" } else { "Move the rail to the left" },
        "",
        Action::RailSide(other),
    ));
    let theme = if app.theme.variant == Variant::Void { Variant::Paper } else { Variant::Void };
    v.push(item(
        if theme == Variant::Paper { "Theme: Paper (light)" } else { "Theme: Void (dark)" },
        "",
        Action::Theme(theme),
    ));
    v.push(item(if app.cfg.motion { "Turn animation off" } else { "Turn animation on" }, "", Action::ToggleMotion));
    v.push(item("Keyboard shortcuts", "?", Action::Help));
    v.push(item("Redraw the screen", "ctrl+l", Action::Redraw));
    v.push(item("Quit orb", "ctrl+c ×2", Action::Quit));
    if searching {
        for r in app.fleet() {
            if Some(&r.id) == app.current.as_ref() {
                continue;
            }
            if let Some(w) = app.ws(&r.id) {
                let mut it = item(format!("Open {}", w.name), "", Action::Open(w.id.clone()));
                it.detail = app.row_detail(&r);
                v.push(it);
            }
        }
    }
    v
}

pub fn profile_name(app: &App, id: Option<&str>) -> String {
    match id {
        None => "Builder".into(),
        Some(id) => app.profiles.iter().find(|p| p.id == id).map(|p| p.name.clone()).unwrap_or_else(|| {
            let short = id.rsplit(':').next().unwrap_or(id);
            let mut c = short.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        }),
    }
}

/// Builder (no profile) first, then the app's profiles (its own "builder" entry is the same role).
fn profile_choices(app: &App) -> Vec<(Option<String>, String, String)> {
    let mut v = vec![(None, "Builder".to_string(), "Default generalist: implements the task end to end.".to_string())];
    for p in &app.profiles {
        if p.id.ends_with(":builder") {
            if !p.description.is_empty() {
                v[0].2 = p.description.clone();
            }
            continue;
        }
        v.push((Some(p.id.clone()), p.name.clone(), p.description.clone()));
    }
    v
}

fn profiles(app: &App) -> Vec<Item> {
    let cur = app.cur_ws().and_then(|w| w.profile.clone());
    profile_choices(app)
        .into_iter()
        .map(|(id, name, desc)| Item {
            current: id == cur,
            label: name,
            detail: desc,
            key: "",
            action: Action::SetProfile(id),
        })
        .collect()
}

/// Word-start matches first, then substrings, then loose subsequences; stable otherwise.
fn rank(items: Vec<Item>, query: &str) -> Vec<Item> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return items;
    }
    let mut scored: Vec<(usize, usize, Item)> = items
        .into_iter()
        .enumerate()
        .filter_map(|(i, it)| {
            // Skills score on their own name: "/shipkit:fix-ci" is "fix-ci" (every one shares the pack).
            let full = it.label.to_lowercase();
            let l = match full.strip_prefix('/') {
                Some(rest) => rest.rsplit(':').next().unwrap_or(rest).to_string(),
                None => full,
            };
            let score = if l.starts_with(&q) {
                0
            } else if l.split([' ', '/', ':', '-']).any(|w| w.starts_with(&q)) {
                1
            } else if l.contains(&q) {
                2
            } else if it.detail.to_lowercase().contains(&q) {
                4
            } else if app::subsequence(&l, &q).is_some() {
                3
            } else {
                return None;
            };
            Some((score, i, it))
        })
        .collect();
    scored.sort_by_key(|s| (s.0, s.1));
    scored.into_iter().map(|s| s.2).collect()
}

/// Does what an action says. Keys and the palette both end up here.
pub fn run(app: &mut App, a: Action) -> Vec<Cmd> {
    app.overlay = None;
    let cur = app.current.clone();
    let rpc = |tag: Tag, method: &'static str, params: serde_json::Value| Cmd::Rpc { tag, method, params };
    match a {
        Action::GoChat => go_chat(app),
        Action::GoInbox => go_inbox(app),
        Action::GoReview => go_review(app),
        Action::Switcher => {
            app.overlay = Some(Overlay::Switcher { query: String::new(), sel: 0 });
            vec![]
        }
        Action::NewWorkspace => {
            open_new_workspace(app);
            vec![]
        }
        Action::Ship => start_ship(app),
        Action::Stop => match cur {
            Some(id) if app.is_running(&id) => {
                app.flash("Stopping…");
                vec![rpc(Tag::Fire, "interrupt", json!({ "workspaceId": id }))]
            }
            _ => vec![],
        },
        Action::RunSkill(s) => match cur {
            Some(id) => {
                app.screen = Screen::Chat;
                run_skill(app, &id, &s, "")
            }
            None => vec![],
        },
        Action::SkillPopup => {
            if cur.is_some() {
                app.screen = Screen::Chat;
                app.focus = Focus::Input;
                app.input = "/".into();
                app.cursor = 1;
                app.skills_closed = false;
                app.skills_sel = 0;
            }
            vec![]
        }
        Action::FixCi => cur.map(|id| run_skill(app, &id, "shipkit:fix-ci", "")).unwrap_or_default(),
        Action::AddressComments => {
            cur.map(|id| run_skill(app, &id, "shipkit:address-comments", "")).unwrap_or_default()
        }
        Action::OpenPr => {
            cur.and_then(|id| app.prs.get(&id)).map(|p| vec![Cmd::Open(p.url.clone())]).unwrap_or_default()
        }
        Action::PickProfile => {
            if cur.is_some() {
                app.overlay = Some(Overlay::Palette { query: String::new(), sel: 0, mode: PaletteMode::Profiles });
            }
            vec![]
        }
        Action::CycleProfile => {
            let Some(w) = app.cur_ws() else { return vec![] };
            let choices = profile_choices(app);
            let i = choices.iter().position(|c| c.0 == w.profile).unwrap_or(0);
            let next = choices[(i + 1) % choices.len()].0.clone();
            run(app, Action::SetProfile(next))
        }
        Action::SetProfile(p) => {
            let Some(id) = cur else { return vec![] };
            if app.is_running(&id) {
                app.error("Wait for the current turn to finish before switching profile");
                return vec![];
            }
            app.flash(format!("Profile: {}", profile_name(app, p.as_deref())));
            vec![rpc(Tag::Profile(id.clone()), "switchProfile", json!({ "workspaceId": id, "profile": p }))]
        }
        Action::Compact => match cur {
            Some(id) => {
                app.flash("Compacting the context…");
                vec![rpc(Tag::Fire, "compact", json!({ "workspaceId": id }))]
            }
            None => vec![],
        },
        Action::NewSession => match cur {
            Some(id) => {
                app.flash("New session: the agent starts fresh");
                vec![rpc(Tag::Fire, "newSession", json!({ "workspaceId": id }))]
            }
            None => vec![],
        },
        Action::Dismiss(id) => vec![rpc(Tag::Dismiss(id.clone()), "dismiss", json!({ "workspaceId": id }))],
        Action::Archive(id) => {
            let name = app.ws(&id).map(|w| w.name.clone()).unwrap_or_default();
            app.overlay = Some(Overlay::Confirm {
                prompt: format!("Archive {name}? Its worktree is removed."),
                action: ConfirmAction::Archive { ws: id, force: false },
            });
            vec![]
        }
        Action::Open(id) => open_ws(app, &id),
        Action::ReviewSend => {
            app.screen = Screen::Review;
            app::review_send(app)
        }
        Action::ReviewScope => app::review_key(app, KeyEvent::new(KeyCode::Char('v'), KeyModifiers::NONE)),
        Action::ToggleRail => {
            app.rail_shown = !app.rail_shown;
            if !app.rail_shown && app.focus == Focus::Rail {
                app.focus = Focus::Input;
            }
            vec![]
        }
        Action::RailSide(side) => {
            app.cfg.rail_side = side;
            app.rail_shown = true;
            vec![Cmd::Save(json!({ "railSide": if side == Side::Left { "left" } else { "right" } }))]
        }
        Action::Theme(v) => {
            app.theme = Theme::new(v, app.theme.depth);
            vec![Cmd::Save(json!({ "theme": if v == Variant::Paper { "paper" } else { "void" } }))]
        }
        Action::ToggleMotion => {
            app.cfg.motion = !app.cfg.motion;
            vec![Cmd::Save(json!({ "motion": app.cfg.motion }))]
        }
        Action::Help => {
            app.overlay = Some(Overlay::Help);
            vec![]
        }
        Action::Redraw => vec![Cmd::Redraw],
        Action::Quit => vec![Cmd::Quit],
    }
}

/// Keys inside the palette.
pub fn palette_key(app: &mut App, k: KeyEvent, mut query: String, mut sel: usize, mode: PaletteMode) -> Vec<Cmd> {
    let n = items(app, mode, &query).len();
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    match k.code {
        KeyCode::Esc => {
            // From the profile list, Esc goes back to the commands.
            app.overlay = (mode == PaletteMode::Profiles).then(|| Overlay::Palette {
                query: String::new(),
                sel: 0,
                mode: PaletteMode::Commands,
            });
            return vec![];
        }
        KeyCode::Enter => {
            let Some(it) = items(app, mode, &query).into_iter().nth(sel) else { return vec![] };
            return run(app, it.action);
        }
        KeyCode::Up => sel = sel.saturating_sub(1),
        KeyCode::Down => sel = (sel + 1).min(n.saturating_sub(1)),
        KeyCode::Char('p') if ctrl => sel = sel.saturating_sub(1),
        KeyCode::Char('n') if ctrl => sel = (sel + 1).min(n.saturating_sub(1)),
        KeyCode::Char('u') if ctrl => {
            query.clear();
            sel = 0;
        }
        KeyCode::Backspace => {
            query.pop();
            sel = 0;
        }
        KeyCode::Char(c) if !k.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            query.push(c);
            sel = 0;
        }
        _ => {}
    }
    app.overlay = Some(Overlay::Palette { query, sel, mode });
    vec![]
}

/// The bindings `?` shows, for the screen and focus you're on.
pub fn help(app: &App) -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
    let global = (
        "everywhere",
        vec![
            ("ctrl+p", "all actions"),
            ("ctrl+k", "switch workspace"),
            ("ctrl+n", "new workspace"),
            ("alt+1 / 2 / 3", "chat · inbox · review"),
            ("ctrl+x then 1-3, s, r, q", "same, when Alt doesn't work"),
            ("ctrl+b", "show / hide the rail"),
            ("ctrl+c ×2", "quit"),
        ],
    );
    let screen = match app.screen {
        Screen::Chat => (
            "chat",
            vec![
                ("enter", "send"),
                ("alt+enter, ctrl+j", "new line"),
                ("esc", "stop the agent"),
                ("↑ / ↓", "previous / next message"),
                ("/", "skills"),
                ("pgup / pgdn", "scroll"),
                ("ctrl+s", "ship"),
                ("ctrl+o", "next profile"),
                ("tab", "focus input → rail → transcript"),
                ("j / k, enter", "rail & transcript: move, open / expand"),
                ("d, x", "rail: dismiss, archive"),
            ],
        ),
        Screen::Inbox => (
            "inbox",
            vec![
                ("j / k", "move"),
                ("enter, r", "open / reply"),
                ("1 2 3", "suggested replies"),
                ("f", "fix (checks, CI, conflicts)"),
                ("s", "ship"),
                ("c", "address PR comments"),
                ("d", "dismiss"),
                ("x", "archive"),
                ("esc", "back"),
            ],
        ),
        Screen::Review => (
            "review",
            vec![
                ("j / k, J / K", "line, half page"),
                ("] / [", "next / previous file"),
                ("n / p", "next / previous hunk"),
                ("c", "comment on the line"),
                ("a", "accept the file"),
                ("v", "scope: base → last turn → commit"),
                ("tab", "files ↔ diff"),
                ("enter", "send comments to the agent"),
                ("esc", "back"),
            ],
        ),
    };
    vec![screen, global]
}

// ---- New workspace

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NewWs {
    pub repo: usize,
    pub task: String,
    pub agent: usize,
    pub model: usize,
    pub profile: usize,
    pub field: usize,
    pub busy: bool,
}

pub const AGENTS: [&str; 2] = ["claude", "codex"];
pub const FIELDS: [&str; 5] = ["Repo", "Task", "Agent", "Model", "Profile"];

pub fn models(app: &App, agent: usize) -> Vec<String> {
    let m = if agent == 0 { &app.agents.claude.models } else { &app.agents.codex.models };
    if m.is_empty() {
        vec!["default".into()]
    } else {
        m.clone()
    }
}

pub fn profile_labels(app: &App) -> Vec<(Option<String>, String)> {
    profile_choices(app).into_iter().map(|(id, name, _)| (id, name)).collect()
}

/// Defaults: the current workspace's repo and agent, else the most recently active repo.
fn open_new_workspace(app: &mut App) {
    if app.repos.is_empty() {
        app.error("No repositories yet: add one in the Orbit app first");
        return;
    }
    let cur = app.cur_ws().cloned().or_else(|| {
        app.workspaces.iter().max_by_key(|w| app.summaries.get(&w.id).map(|s| s.last_activity_ts).unwrap_or(0)).cloned()
    });
    let repo = cur.as_ref().and_then(|w| app.repos.iter().position(|r| r.id == w.repo_id)).unwrap_or(0);
    let agent = cur.as_ref().map(|w| usize::from(w.agent == "codex")).unwrap_or(0);
    app.screen = if app.screen == Screen::Review { Screen::Chat } else { app.screen };
    app.overlay = Some(Overlay::NewWorkspace(NewWs { repo, agent, field: 1, ..Default::default() }));
}

/// Roughly how the app names it: lowercase words joined by `-`.
pub fn slug(name: &str) -> String {
    name.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join("-")
}

/// Workspace name from the task: its first six words (the app slugifies and dedupes it).
pub fn name_from_task(task: &str) -> String {
    task.split_whitespace().take(6).collect::<Vec<_>>().join(" ")
}

pub fn new_workspace_key(app: &mut App, k: KeyEvent, mut d: NewWs) -> Vec<Cmd> {
    if d.busy {
        if k.code == KeyCode::Esc {
            app.overlay = None;
        }
        return vec![];
    }
    let m = k.modifiers;
    let picker_len = |app: &App, d: &NewWs| match d.field {
        0 => app.repos.len(),
        2 => AGENTS.len(),
        3 => models(app, d.agent).len(),
        4 => profile_labels(app).len(),
        _ => 0,
    };
    let create = |app: &mut App, d: &mut NewWs| -> Vec<Cmd> {
        let task = d.task.trim().to_string();
        if task.is_empty() {
            d.field = 1;
            app.error("Write the task first");
            return vec![];
        }
        let Some(repo) = app.repos.get(d.repo) else { return vec![] };
        let models = models(app, d.agent);
        let model = models.get(d.model).filter(|m| *m != "default").cloned();
        let profile = profile_labels(app).get(d.profile).and_then(|p| p.0.clone());
        d.busy = true;
        vec![Cmd::Rpc {
            tag: Tag::Create,
            method: "createWorkspace",
            params: json!({
                "repoId": repo.id,
                "name": name_from_task(&task),
                "agent": AGENTS[d.agent],
                "model": model,
                "profile": profile,
                "task": task,
            }),
        }]
    };
    let mut out = vec![];
    match k.code {
        KeyCode::Esc => {
            app.overlay = None;
            return vec![];
        }
        KeyCode::Enter if m.contains(KeyModifiers::CONTROL) => out = create(app, &mut d),
        KeyCode::Char('s') if m.contains(KeyModifiers::CONTROL) => out = create(app, &mut d),
        KeyCode::Enter if d.field == 1 && m.intersects(KeyModifiers::ALT | KeyModifiers::SHIFT) => d.task.push('\n'),
        KeyCode::Char('j') if d.field == 1 && m.contains(KeyModifiers::CONTROL) => d.task.push('\n'),
        KeyCode::Enter if d.field == FIELDS.len() - 1 => out = create(app, &mut d),
        KeyCode::Enter | KeyCode::Tab | KeyCode::Down => d.field = (d.field + 1).min(FIELDS.len() - 1),
        KeyCode::BackTab | KeyCode::Up => d.field = d.field.saturating_sub(1),
        KeyCode::Left | KeyCode::Right if d.field != 1 => {
            let n = picker_len(app, &d).max(1);
            let step = if k.code == KeyCode::Right { 1 } else { n - 1 };
            match d.field {
                0 => d.repo = (d.repo + step) % n,
                2 => {
                    d.agent = (d.agent + step) % n;
                    d.model = 0;
                }
                3 => d.model = (d.model + step) % n,
                4 => d.profile = (d.profile + step) % n,
                _ => {}
            }
        }
        KeyCode::Backspace if d.field == 1 => {
            d.task.pop();
        }
        KeyCode::Char(c) if d.field == 1 && !m.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => d.task.push(c),
        // On a picker, typing jumps to the task.
        KeyCode::Char(c) if !m.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) && c != ' ' => {
            d.field = 1;
            d.task.push(c);
        }
        _ => {}
    }
    app.overlay = Some(Overlay::NewWorkspace(d));
    out
}

/// What the Inbox's archive / dismiss keys and the rail call.
pub fn archive_prompt_after_error(app: &mut App, id: &str, err: &str) -> bool {
    if !err.starts_with("Uncommitted changes") {
        return false;
    }
    let name = app.ws(id).map(|w| w.name.clone()).unwrap_or_default();
    let files = err.trim_start_matches("Uncommitted changes:").trim();
    let files = crate::text::truncate(files, 60);
    app.overlay = Some(Overlay::Confirm {
        prompt: format!("{name} has uncommitted changes:\n{files}\nArchive anyway and delete them?"),
        action: ConfirmAction::Archive { ws: id.to_string(), force: true },
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranking() {
        let items = vec![
            item("New workspace…", "", Action::NewWorkspace),
            item("Go to Inbox", "", Action::GoInbox),
            item("Switch workspace…", "", Action::Switcher),
            item("/shipkit:fix-ci", "", Action::FixCi),
        ];
        let labels = |q: &str| rank(items.clone(), q).into_iter().map(|i| i.label).collect::<Vec<_>>();
        assert_eq!(labels("work"), vec!["New workspace…", "Switch workspace…"]);
        assert_eq!(labels("inbox"), vec!["Go to Inbox"]);
        assert_eq!(labels("fix"), vec!["/shipkit:fix-ci"]);
        assert_eq!(labels("nw")[0], "New workspace…");
        assert!(labels("zzz").is_empty());
    }

    #[test]
    fn names() {
        assert_eq!(name_from_task("  Fix the flaky login test on CI please now"), "Fix the flaky login test on");
    }
}
