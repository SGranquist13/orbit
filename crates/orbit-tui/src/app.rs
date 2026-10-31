//! The Elm-style core: `App` holds all state, `update(&mut App, Msg) -> Vec<Cmd>` is pure and
//! deterministic (time arrives as `Msg::Tick(now_ms)`), and the runtime executes the `Cmd`s.

use crate::attention::{self, Group, Reason, Suggestion, Tone};
use crate::diff::{self, Row};
use crate::text::{first_line, plain};
use crate::theme::Theme;
use crate::transcript::{self, Block};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use orbit_proto::{
    AgentEvent, CheckResult, FileAt, HelloSettings, MergeOutcome, PrStatus, PrepareShip, Push, Repo, Review,
    ReviewComment, Scope, Skill, Snapshot, Status, StoredEvent, Summary, Workspace,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

pub const MIN_W: u16 = 60;
pub const MIN_H: u16 = 16;
pub const RAIL_W: u16 = 30;
const HISTORY: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub rail_side: Side,
    pub rail_on: bool,
    pub motion: bool,
    pub pinned: Vec<String>,
    pub demo: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            rail_side: Side::Left,
            rail_on: true,
            motion: true,
            pinned: vec!["shipkit:ship".into(), "shipkit:fix-ci".into(), "shipkit:preflight".into()],
            demo: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Chat,
    Inbox,
    Review,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Input,
    Rail,
    Transcript,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileSide {
    Old,
    New,
}

/// Which request a reply belongs to.
#[derive(Debug, Clone, PartialEq)]
pub enum Tag {
    Hello,
    Snapshot,
    Skills,
    Events {
        ws: String,
        since: Option<i64>,
    },
    Send {
        ws: String,
        text: String,
    },
    MarkSeen(String),
    Dismiss(String),
    PrStatus(String),
    Ship(String),
    Merge(String),
    Review(String),
    FileAt {
        ws: String,
        path: String,
        side: FileSide,
    },
    SendReview {
        ws: String,
        count: usize,
    },
    /// Fire and forget: only an error is shown.
    Fire,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Cmd {
    Rpc { tag: Tag, method: &'static str, params: Value },
    Open(String),
    Redraw,
    Quit,
}

fn rpc(tag: Tag, method: &'static str, params: Value) -> Cmd {
    Cmd::Rpc { tag, method, params }
}

#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)]
pub enum Msg {
    Key(KeyEvent),
    Paste(String),
    Resize(u16, u16),
    Tick(i64),
    /// Mouse wheel: negative scrolls up.
    Scroll(i32),
    Push(Push),
    Rpc(Tag, Result<Value, String>),
}

/// Events and derived state of an opened workspace.
#[derive(Debug, Clone, Default)]
pub struct WsData {
    pub events: Vec<StoredEvent>,
    pub blocks: Vec<Block>,
    /// `textDelta`s since the last persisted message.
    pub live: String,
    pub last_seq: i64,
    pub loaded: bool,
    pub turn_started: Option<i64>,
}

impl WsData {
    fn refold(&mut self) {
        self.blocks = transcript::fold(&self.events);
    }
    /// Latest `(contextTokens, contextWindow)`.
    pub fn context(&self) -> Option<(u64, Option<u64>)> {
        self.events.iter().rev().find_map(|e| match &e.event {
            AgentEvent::Usage { context_tokens: Some(c), context_window, .. } => Some((*c, *context_window)),
            _ => None,
        })
    }
    /// "grep login" from the newest tool call, for the running detail.
    pub fn last_tool(&self) -> Option<String> {
        self.blocks.iter().rev().find_map(|b| match b {
            Block::Tools { calls, .. } => calls.last().map(|c| {
                let s = transcript::tool_summary(&c.name, &c.input);
                format!("{} {}", transcript::tool_verb(&c.name), first_line(&s)).trim_end().to_string()
            }),
            Block::User { .. } => Some(String::new()),
            _ => None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ShipPhase {
    Gate,
    GateFailed,
    Agent,
    WaitPr,
    Pr,
    Merging,
    Merged { archived: bool },
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct ShipState {
    pub phase: ShipPhase,
    pub checks: Option<CheckResult>,
    pub squashed: u32,
    pub last_tool: Option<String>,
    pub poll_at: i64,
    pub poll_until: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConfirmAction {
    Merge { ws: String, number: i64 },
    SendReview(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Overlay {
    Ship,
    Switcher { query: String, sel: usize },
    Confirm { prompt: String, action: ConfirmAction },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    File(String),
    Commit(usize),
}

#[derive(Debug, Clone, Default)]
pub struct ReviewState {
    pub ws: String,
    pub scope: Option<Scope>,
    pub data: Option<Review>,
    pub loading: bool,
    pub list_sel: usize,
    pub focus_list: bool,
    pub accepted: Vec<String>,
    pub file: Option<String>,
    pub sides: HashMap<String, (Option<FileAt>, Option<FileAt>)>,
    pub rows: Vec<Row>,
    pub cursor: usize,
    pub commenting: Option<String>,
}

impl ReviewState {
    /// Files (accepted last), then commits.
    pub fn entries(&self) -> Vec<Entry> {
        let Some(d) = &self.data else { return vec![] };
        let mut out: Vec<Entry> =
            d.files.iter().filter(|f| !self.accepted.contains(&f.path)).map(|f| Entry::File(f.path.clone())).collect();
        out.extend(
            self.accepted.iter().filter(|p| d.files.iter().any(|f| &f.path == *p)).map(|p| Entry::File(p.clone())),
        );
        out.extend((0..d.commits.len()).map(Entry::Commit));
        out
    }
    pub fn file_count(&self) -> usize {
        self.data.as_ref().map(|d| d.files.len()).unwrap_or(0)
    }
}

#[derive(Debug, Clone)]
pub struct Flash {
    pub text: String,
    pub error: bool,
    pub until: i64,
}

/// One workspace as listed in the rail and the Inbox.
#[derive(Debug, Clone)]
pub struct FleetRow {
    pub id: String,
    pub group: Group,
    pub reason: Option<Reason>,
    pub tone: Tone,
}

#[derive(Debug, Clone)]
pub struct App {
    pub cfg: Config,
    pub theme: Theme,
    pub now: i64,
    pub tick: u64,
    pub size: (u16, u16),
    pub connected: bool,
    pub started: bool,
    pub open_target: Option<String>,

    pub repos: Vec<Repo>,
    pub workspaces: Vec<Workspace>,
    pub summaries: HashMap<String, Summary>,
    pub settings: HelloSettings,
    pub prs: HashMap<String, PrStatus>,
    pub skills: Vec<Skill>,
    pub data: HashMap<String, WsData>,
    pub recent: Vec<String>,

    pub current: Option<String>,
    pub screen: Screen,
    pub prev_screen: Screen,
    pub focus: Focus,
    pub rail_shown: bool,
    pub rail_sel: usize,
    pub inbox_sel: usize,

    pub input: String,
    pub cursor: usize,
    pub history: HashMap<String, Vec<String>>,
    pub hist_pos: Option<usize>,
    pub drafts_in: HashMap<String, String>,
    pub pending: HashMap<String, String>,
    pub skills_sel: usize,
    pub skills_closed: bool,

    pub scroll: usize,
    pub new_below: bool,
    pub tsel: usize,
    pub expanded: HashMap<String, bool>,

    pub overlay: Option<Overlay>,
    pub ship: HashMap<String, ShipState>,
    pub review: Option<ReviewState>,
    pub drafts: HashMap<String, Vec<ReviewComment>>,

    pub status: Option<Flash>,
    pub quit_armed: i64,
    pub chord: i64,
    pub snapshot_due: Option<i64>,
    pub pr_next: i64,
    pub pr_queue: VecDeque<String>,
    pub pr_inflight: HashSet<String>,
}

impl App {
    pub fn new(cfg: Config, theme: Theme, now: i64) -> App {
        App {
            rail_shown: cfg.rail_on,
            cfg,
            theme,
            now,
            tick: 0,
            size: (120, 36),
            connected: true,
            started: false,
            open_target: None,
            repos: vec![],
            workspaces: vec![],
            summaries: HashMap::new(),
            settings: HelloSettings::default(),
            prs: HashMap::new(),
            skills: vec![],
            data: HashMap::new(),
            recent: vec![],
            current: None,
            screen: Screen::Chat,
            prev_screen: Screen::Chat,
            focus: Focus::Input,
            rail_sel: 0,
            inbox_sel: 0,
            input: String::new(),
            cursor: 0,
            history: HashMap::new(),
            hist_pos: None,
            drafts_in: HashMap::new(),
            pending: HashMap::new(),
            skills_sel: 0,
            skills_closed: false,
            scroll: 0,
            new_below: false,
            tsel: 0,
            expanded: HashMap::new(),
            overlay: None,
            ship: HashMap::new(),
            review: None,
            drafts: HashMap::new(),
            status: None,
            quit_armed: 0,
            chord: 0,
            snapshot_due: None,
            pr_next: 0,
            pr_queue: VecDeque::new(),
            pr_inflight: HashSet::new(),
        }
    }

    /// The requests to make at startup.
    pub fn init(&self) -> Vec<Cmd> {
        vec![
            rpc(Tag::Hello, "hello", json!({})),
            rpc(Tag::Snapshot, "snapshot", json!({})),
            rpc(Tag::Skills, "listSkills", json!({})),
        ]
    }

    pub fn ws(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == id)
    }
    pub fn cur_ws(&self) -> Option<&Workspace> {
        self.current.as_deref().and_then(|id| self.ws(id))
    }
    pub fn repo_of(&self, ws: &Workspace) -> Option<&Repo> {
        self.repos.iter().find(|r| r.id == ws.repo_id)
    }
    pub fn base_branch(&self, ws: &Workspace) -> String {
        self.repo_of(ws).map(|r| r.base_branch.clone()).unwrap_or_else(|| "main".into())
    }
    pub fn is_running(&self, id: &str) -> bool {
        self.ws(id).is_some_and(|w| w.status == Status::Running)
    }

    pub fn reason(&self, ws: &Workspace) -> Option<Reason> {
        attention::attention_reason(ws, self.summaries.get(&ws.id), self.prs.get(&ws.id), &self.settings, self.now)
    }

    /// Every workspace grouped (needs you, running, done), newest activity first.
    pub fn fleet(&self) -> Vec<FleetRow> {
        let mut rows: Vec<(FleetRow, i64)> = self
            .workspaces
            .iter()
            .map(|w| {
                let reason = self.reason(w);
                let activity = self.summaries.get(&w.id).map(|s| s.last_activity_ts).unwrap_or(w.updated_at);
                (
                    FleetRow {
                        id: w.id.clone(),
                        group: attention::group(w, reason),
                        reason,
                        tone: attention::tone(w, reason, self.prs.get(&w.id)),
                    },
                    activity,
                )
            })
            .collect();
        rows.sort_by(|(a, ta), (b, tb)| a.group.cmp(&b.group).then(tb.cmp(ta)).then(a.id.cmp(&b.id)));
        rows.into_iter().map(|(r, _)| r).collect()
    }

    pub fn counts(&self) -> (usize, usize, usize) {
        let f = self.fleet();
        let n = |g| f.iter().filter(|r| r.group == g).count();
        (n(Group::NeedsYou), n(Group::Running), n(Group::Done))
    }

    /// The detail shown for a row in the Inbox.
    pub fn row_detail(&self, row: &FleetRow) -> String {
        let Some(ws) = self.ws(&row.id) else { return String::new() };
        let s = self.summaries.get(&ws.id);
        match row.reason {
            Some(r) => {
                let d = attention::detail(r, ws, s, self.prs.get(&ws.id), &self.settings, self.now);
                if d.is_empty() {
                    attention::label(r).to_string()
                } else {
                    format!("{}: {}", attention::label(r), plain(&d))
                }
            }
            None if ws.status == Status::Running => {
                let tool = self.data.get(&ws.id).and_then(|d| d.last_tool()).filter(|t| !t.is_empty());
                let since = self.data.get(&ws.id).and_then(|d| d.turn_started);
                let mut t = tool.map(|t| capitalize(&t)).unwrap_or_else(|| "Thinking".into());
                if let Some(since) = since {
                    t.push_str(&format!(" · {}", transcript::format_duration((self.now - since).max(0) as u64)));
                }
                t
            }
            None => match self.prs.get(&ws.id) {
                Some(p) if p.state == "MERGED" => format!("Merged #{}", p.number),
                Some(p) if p.state == "OPEN" => format!("PR #{} open · {}", p.number, first_line(&p.title)),
                _ => s
                    .and_then(|s| s.last_assistant_text.as_deref())
                    .map(|t| plain(first_line(t)))
                    .unwrap_or_else(|| "Idle".into()),
            },
        }
    }

    pub fn suggestions(&self, row: &FleetRow) -> Vec<Suggestion> {
        let (Some(r), Some(ws)) = (row.reason, self.ws(&row.id)) else { return vec![] };
        let has_pr = self.prs.get(&ws.id).is_some_and(|p| p.state == "OPEN");
        attention::rule_suggestions(r, ws, has_pr, &self.base_branch(ws))
    }

    pub fn rail_visible(&self) -> bool {
        self.rail_shown && self.size.0 >= 100 && self.screen == Screen::Chat
    }

    /// Something on screen moves: tick fast.
    pub fn animating(&self) -> bool {
        let running_visible =
            self.workspaces.iter().any(|w| w.status == Status::Running) && (self.screen != Screen::Review);
        running_visible
            || self.status.is_some()
            || self.quit_armed > self.now
            || self.chord > self.now
            || self.snapshot_due.is_some()
            || self.ship.values().any(|s| matches!(s.phase, ShipPhase::WaitPr | ShipPhase::Pr | ShipPhase::Gate))
    }

    pub fn flash(&mut self, text: impl Into<String>) {
        self.status = Some(Flash { text: text.into(), error: false, until: self.now + 4000 });
    }
    pub fn error(&mut self, text: impl Into<String>) {
        self.status = Some(Flash { text: text.into(), error: true, until: self.now + 4000 });
    }

    /// Skills matching the input's `/query`, best first (subsequence, by match start then length).
    pub fn skill_matches(&self) -> Vec<&Skill> {
        let Some(q) = self.skill_query() else { return vec![] };
        let q = q.to_lowercase();
        let mut hits: Vec<(usize, usize, usize, &Skill)> = self
            .skills
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let short = s.id.rsplit(':').next().unwrap_or(&s.id).to_lowercase();
                let start =
                    subsequence(&short, &q).or_else(|| subsequence(&s.id.to_lowercase(), &q).map(|p| p + 100))?;
                Some((start, s.id.len(), i, s))
            })
            .collect();
        if q.is_empty() {
            return self.skills.iter().collect();
        }
        hits.sort_by_key(|h| (h.0, h.1, h.2));
        hits.into_iter().map(|h| h.3).collect()
    }

    /// `Some(query)` while the input is `/query` (before any space) and the popup isn't closed.
    pub fn skill_query(&self) -> Option<&str> {
        if self.skills_closed || self.focus != Focus::Input || self.screen != Screen::Chat {
            return None;
        }
        let rest = self.input.strip_prefix('/')?;
        if rest.contains(char::is_whitespace) {
            return None;
        }
        Some(rest)
    }

    pub fn switcher_matches(&self, query: &str) -> Vec<FleetRow> {
        let q = query.to_lowercase();
        let mut hits: Vec<(usize, usize, FleetRow)> = self
            .fleet()
            .into_iter()
            .enumerate()
            .filter_map(|(i, r)| {
                let name = self.ws(&r.id)?.name.to_lowercase();
                // Substring matches first (by position), then looser subsequence matches.
                let rank = name.find(&q).or_else(|| subsequence(&name, &q).map(|p| p + 1000))?;
                Some((rank, i, r))
            })
            .collect();
        hits.sort_by_key(|h| (h.0, h.1));
        hits.into_iter().map(|h| h.2).collect()
    }

    /// Whether a tools block is shown expanded.
    pub fn tools_expanded(&self, data: &WsData, idx: usize) -> bool {
        let Some(b) = data.blocks.get(idx) else { return false };
        if let Some(e) = self.expanded.get(b.key()) {
            return *e;
        }
        // The latest group stays open until the next user message.
        let last_tools = data.blocks.iter().rposition(|b| matches!(b, Block::Tools { .. }));
        last_tools == Some(idx) && !data.blocks[idx..].iter().any(|b| matches!(b, Block::User { .. }))
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// Position of the first matched char if `q` is a subsequence of `s`.
pub fn subsequence(s: &str, q: &str) -> Option<usize> {
    if q.is_empty() {
        return Some(0);
    }
    let mut qi = q.chars().peekable();
    let mut start = None;
    for (i, c) in s.chars().enumerate() {
        if qi.peek() == Some(&c) {
            start.get_or_insert(i);
            qi.next();
            if qi.peek().is_none() {
                return start;
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------
// update

pub fn update(app: &mut App, msg: Msg) -> Vec<Cmd> {
    match msg {
        Msg::Tick(now) => tick(app, now),
        Msg::Resize(w, h) => {
            app.size = (w, h);
            if !app.rail_visible() && app.focus == Focus::Rail {
                app.focus = Focus::Input;
            }
            vec![]
        }
        Msg::Scroll(d) => {
            match app.screen {
                Screen::Chat => scroll_by(app, -d),
                Screen::Review => review_move(app, d as i64),
                Screen::Inbox => move_inbox(app, d.signum() as i64),
            }
            vec![]
        }
        Msg::Paste(s) => {
            paste(app, &s);
            vec![]
        }
        Msg::Key(k) => {
            if k.kind == KeyEventKind::Release {
                return vec![];
            }
            key(app, k)
        }
        Msg::Push(p) => push(app, p),
        Msg::Rpc(tag, res) => reply(app, tag, res),
    }
}

fn tick(app: &mut App, now: i64) -> Vec<Cmd> {
    app.now = now;
    if app.cfg.motion {
        app.tick = app.tick.wrapping_add(1);
    }
    let mut out = vec![];
    if app.status.as_ref().is_some_and(|s| s.until <= now) {
        app.status = None;
    }
    if app.snapshot_due.is_some_and(|t| t <= now) {
        app.snapshot_due = None;
        out.push(rpc(Tag::Snapshot, "snapshot", json!({})));
    }
    // Ship: poll the PR until it exists, then while the overlay is open.
    let overlay_ws = (app.overlay == Some(Overlay::Ship)).then(|| app.current.clone()).flatten();
    for (id, s) in app.ship.iter_mut() {
        let due = s.poll_at > 0 && s.poll_at <= now;
        let waiting = s.phase == ShipPhase::WaitPr && now <= s.poll_until;
        let watching = s.phase == ShipPhase::Pr && overlay_ws.as_deref() == Some(id.as_str());
        if due && (waiting || watching) {
            s.poll_at = now + if waiting { 5000 } else { 15000 };
            out.push(rpc(Tag::PrStatus(id.clone()), "prStatus", json!({ "workspaceId": id })));
        } else if due && s.phase == ShipPhase::WaitPr {
            s.phase = ShipPhase::Failed("No pull request appeared after 2 minutes".into());
            s.poll_at = 0;
        }
    }
    out.extend(pump_prs(app));
    out
}

/// Background PR status: Inbox every 60 s, otherwise every 5 min; at most 4 in flight.
fn pump_prs(app: &mut App) -> Vec<Cmd> {
    let mut out = vec![];
    if app.started && app.now >= app.pr_next {
        app.pr_next = app.now + if app.screen == Screen::Inbox { 60_000 } else { 300_000 };
        for w in &app.workspaces {
            if (w.ahead > 0 || w.issue_number.is_some()) && !app.pr_queue.contains(&w.id) {
                app.pr_queue.push_back(w.id.clone());
            }
        }
    }
    while app.pr_inflight.len() < 4 {
        let Some(id) = app.pr_queue.pop_front() else { break };
        if app.pr_inflight.insert(id.clone()) {
            out.push(rpc(Tag::PrStatus(id.clone()), "prStatus", json!({ "workspaceId": id })));
        }
    }
    out
}

/// Running workspaces' events are loaded too, so the rail and Inbox can say what they're doing.
fn load_running(app: &mut App) -> Vec<Cmd> {
    let mut out = vec![];
    let running: Vec<String> =
        app.workspaces.iter().filter(|w| w.status == Status::Running).map(|w| w.id.clone()).collect();
    for id in running {
        if !app.data.contains_key(&id) {
            app.data.insert(id.clone(), WsData::default());
            out.push(rpc(Tag::Events { ws: id.clone(), since: None }, "events", json!({ "workspaceId": id })));
        }
    }
    out
}

fn schedule_snapshot(app: &mut App) {
    if app.snapshot_due.is_none() {
        app.snapshot_due = Some(app.now + 300);
    }
}

fn push(app: &mut App, p: Push) -> Vec<Cmd> {
    let mut out = vec![];
    match p {
        Push::Event(e) => {
            let ws = e.workspace_id.clone();
            let is_current = app.current.as_deref() == Some(ws.as_str());
            match &e.event {
                AgentEvent::TurnCompleted { .. } | AgentEvent::UserMessage { .. } => schedule_snapshot(app),
                _ => {}
            }
            if let AgentEvent::ToolCall { name, input, .. } = &e.event {
                if let Some(s) = app.ship.get_mut(&ws) {
                    let sum = transcript::tool_summary(name, input);
                    s.last_tool = Some(format!("{} {}", transcript::tool_verb(name), first_line(&sum)));
                }
            }
            if let AgentEvent::TurnCompleted { is_error, error, interrupted, .. } = &e.event {
                if let Some(s) = app.ship.get_mut(&ws) {
                    if s.phase == ShipPhase::Agent {
                        if *is_error || *interrupted {
                            let why =
                                if *interrupted { "Stopped".to_string() } else { error.clone().unwrap_or_default() };
                            s.phase = ShipPhase::Failed(first_line(&why).to_string());
                        } else {
                            s.phase = ShipPhase::WaitPr;
                            s.poll_at = app.now;
                            s.poll_until = app.now + 120_000;
                        }
                    }
                }
                if is_current && app.screen == Screen::Chat {
                    out.push(rpc(Tag::MarkSeen(ws.clone()), "markSeen", json!({ "workspaceId": ws })));
                }
            }
            let Some(d) = app.data.get_mut(&ws) else { return out };
            if !d.loaded {
                return out;
            }
            match e.seq {
                None => {
                    if let AgentEvent::TextDelta { text } = &e.event {
                        d.live.push_str(text);
                    }
                }
                Some(seq) if seq <= d.last_seq => {}
                Some(seq) if seq > d.last_seq + 1 => {
                    let since = d.last_seq;
                    out.push(rpc(
                        Tag::Events { ws: ws.clone(), since: Some(since) },
                        "events",
                        json!({ "workspaceId": ws, "sinceSeq": since }),
                    ));
                }
                Some(seq) => {
                    apply_event(app, &ws, StoredEvent { commit_sha: None, seq, ts: e.ts, event: e.event });
                }
            }
        }
        Push::Workspace(w) => {
            let running = w.status == Status::Running;
            match app.workspaces.iter_mut().find(|x| x.id == w.id) {
                Some(x) => *x = w,
                None => app.workspaces.push(w),
            }
            if running {
                out.extend(load_running(app));
            }
            schedule_snapshot(app);
        }
        Push::WorkspaceRemoved(id) => {
            app.workspaces.retain(|w| w.id != id);
            app.data.remove(&id);
        }
        Push::Summary(s) => {
            app.summaries.insert(s.workspace_id.clone(), s);
        }
        Push::Disconnected => app.connected = false,
        Push::Reconnected => {
            app.connected = true;
            out.push(rpc(Tag::Snapshot, "snapshot", json!({})));
            if let Some(id) = app.current.clone() {
                let since = app.data.get(&id).map(|d| d.last_seq).unwrap_or(0);
                out.push(rpc(
                    Tag::Events { ws: id.clone(), since: Some(since) },
                    "events",
                    json!({ "workspaceId": id, "sinceSeq": since }),
                ));
            }
        }
    }
    out
}

fn apply_event(app: &mut App, ws: &str, e: StoredEvent) {
    let is_current = app.current.as_deref() == Some(ws);
    let Some(d) = app.data.get_mut(ws) else { return };
    match &e.event {
        AgentEvent::Message { .. } | AgentEvent::ToolCall { .. } | AgentEvent::TurnCompleted { .. } => d.live.clear(),
        _ => {}
    }
    match &e.event {
        AgentEvent::TurnStarted => d.turn_started = Some(e.ts),
        AgentEvent::TurnCompleted { .. } => d.turn_started = None,
        AgentEvent::UserMessage { .. } => {
            app.pending.remove(ws);
        }
        _ => {}
    }
    d.last_seq = d.last_seq.max(e.seq);
    d.events.push(e);
    d.refold();
    if is_current && app.scroll > 0 {
        app.new_below = true;
    }
}

fn reply(app: &mut App, tag: Tag, res: Result<Value, String>) -> Vec<Cmd> {
    let mut out = vec![];
    let res = match res {
        Ok(v) => v,
        Err(e) => {
            match &tag {
                Tag::Send { ws, text } => {
                    app.pending.remove(ws);
                    if app.current.as_deref() == Some(ws.as_str()) && app.input.is_empty() {
                        app.input = text.clone();
                        app.cursor = app.input.len();
                    }
                }
                Tag::PrStatus(id) => {
                    app.pr_inflight.remove(id);
                    return out; // silent
                }
                Tag::Ship(id) => {
                    if let Some(s) = app.ship.get_mut(id) {
                        s.phase = ShipPhase::Failed(e.clone());
                    }
                }
                Tag::Merge(id) => {
                    if let Some(s) = app.ship.get_mut(id) {
                        s.phase = ShipPhase::Pr;
                    }
                }
                Tag::Review(_) => {
                    if let Some(r) = app.review.as_mut() {
                        r.loading = false;
                    }
                }
                _ => {}
            }
            app.error(e);
            return out;
        }
    };
    match tag {
        Tag::Hello => {
            if let Some(s) = res.get("settings").and_then(|s| from(s.clone()).ok()) {
                app.settings = s;
            }
        }
        Tag::Snapshot => {
            if let Ok(s) = from::<Snapshot>(res) {
                app.repos = s.repos;
                app.workspaces = s.workspaces;
                app.summaries = s.summaries.into_iter().map(|s| (s.workspace_id.clone(), s)).collect();
                if let Some(c) = &app.current {
                    if app.ws(c).is_none() {
                        app.current = None;
                    }
                }
                out.extend(load_running(app));
                if !app.started {
                    app.started = true;
                    out.extend(start_screen(app));
                    out.extend(pump_prs(app));
                }
            }
        }
        Tag::Skills => app.skills = from(res).unwrap_or_default(),
        Tag::Events { ws, since } => {
            let running = app.is_running(&ws);
            let now = app.now;
            let events: Vec<StoredEvent> = from(res).unwrap_or_default();
            let d = app.data.entry(ws.clone()).or_default();
            if since.is_none() {
                d.events.clear();
                d.last_seq = 0;
            }
            for e in events {
                if e.seq > d.last_seq {
                    d.last_seq = e.seq;
                    match &e.event {
                        AgentEvent::TurnStarted => d.turn_started = Some(e.ts),
                        AgentEvent::TurnCompleted { .. } => d.turn_started = None,
                        AgentEvent::Message { .. } => d.live.clear(),
                        _ => {}
                    }
                    d.events.push(e);
                }
            }
            d.loaded = true;
            d.refold();
            if running && d.turn_started.is_none() {
                d.turn_started = Some(now);
            }
        }
        Tag::Send { .. } | Tag::Fire => {}
        Tag::MarkSeen(ref id) | Tag::Dismiss(ref id) => {
            let n = res.as_i64().unwrap_or(0);
            let is_seen = matches!(tag, Tag::MarkSeen(_));
            if let Some(w) = app.workspaces.iter_mut().find(|w| &w.id == id) {
                if is_seen {
                    w.seen_seq = w.seen_seq.max(n);
                } else {
                    w.dismissed_seq = w.dismissed_seq.max(n);
                }
            }
        }
        Tag::PrStatus(id) => {
            app.pr_inflight.remove(&id);
            match from::<Option<PrStatus>>(res).ok().flatten() {
                Some(p) => {
                    if let Some(s) = app.ship.get_mut(&id) {
                        if s.phase == ShipPhase::WaitPr {
                            s.phase = ShipPhase::Pr;
                            s.poll_at = app.now + 15_000;
                        }
                    }
                    app.prs.insert(id, p);
                }
                None => {
                    app.prs.remove(&id);
                }
            }
        }
        Tag::Ship(id) => {
            let r: PrepareShip = from(res).unwrap_or_default();
            if let Some(s) = app.ship.get_mut(&id) {
                s.squashed = r.squashed;
                s.checks = r.checks;
                s.phase = if r.ok { ShipPhase::Agent } else { ShipPhase::GateFailed };
            }
        }
        Tag::Merge(id) => {
            let r: MergeOutcome = from(res).unwrap_or_default();
            if let Some(s) = app.ship.get_mut(&id) {
                s.phase = ShipPhase::Merged { archived: r.archived };
            }
            if let Some(p) = app.prs.get_mut(&id) {
                p.state = "MERGED".into();
            }
            app.flash(if r.archived { "Merged · archived" } else { "Merged" });
            out.push(rpc(Tag::Snapshot, "snapshot", json!({})));
        }
        Tag::Review(id) => {
            if let Some(r) = app.review.as_mut().filter(|r| r.ws == id) {
                r.loading = false;
                match from::<Review>(res) {
                    Ok(d) => {
                        r.scope = Some(d.scope.clone());
                        r.data = Some(d);
                        r.focus_list = false;
                        r.sides.clear();
                        r.list_sel = 0;
                        r.rows.clear();
                        r.file = None;
                        r.cursor = 0;
                        out.extend(review_select(app));
                    }
                    Err(e) => app.error(format!("Unexpected review: {e}")),
                }
            }
        }
        Tag::FileAt { ws, path, side } => {
            if let Some(r) = app.review.as_mut().filter(|r| r.ws == ws) {
                let f: FileAt = from(res).unwrap_or_default();
                let e = r.sides.entry(path.clone()).or_default();
                match side {
                    FileSide::Old => e.0 = Some(f),
                    FileSide::New => e.1 = Some(f),
                }
                if r.file.as_deref() == Some(path.as_str()) {
                    rebuild_rows(r);
                }
            }
        }
        Tag::SendReview { ws, count } => {
            app.drafts.remove(&ws);
            let name = app.ws(&ws).map(|w| w.name.clone()).unwrap_or_default();
            app.flash(format!("{count} comment{} sent to {name}", if count == 1 { "" } else { "s" }));
            app.screen = Screen::Chat;
            app.review = None;
        }
    }
    out
}

/// Inbox when something needs you, else Chat on the most recent workspace.
fn start_screen(app: &mut App) -> Vec<Cmd> {
    if let Some(t) = app.open_target.take() {
        let hit = app
            .workspaces
            .iter()
            .find(|w| w.name == t)
            .or_else(|| {
                let m: Vec<_> =
                    app.workspaces.iter().filter(|w| w.name.starts_with(&t) || w.id.starts_with(&t)).collect();
                (m.len() == 1).then(|| m[0])
            })
            .map(|w| w.id.clone());
        match hit {
            Some(id) => return open_ws(app, &id),
            None => app.error(format!("No workspace matches \"{t}\"")),
        }
    }
    let fleet = app.fleet();
    if fleet.iter().any(|r| r.group == Group::NeedsYou) {
        app.screen = Screen::Inbox;
        app.inbox_sel = 0;
        return vec![];
    }
    let recent = app
        .workspaces
        .iter()
        .max_by_key(|w| app.summaries.get(&w.id).map(|s| s.last_activity_ts).unwrap_or(w.updated_at))
        .map(|w| w.id.clone());
    match recent {
        Some(id) => open_ws(app, &id),
        None => vec![],
    }
}

/// Opens a workspace in Chat: loads its events once, marks it seen.
pub fn open_ws(app: &mut App, id: &str) -> Vec<Cmd> {
    let mut out = vec![];
    if app.current.as_deref() != Some(id) {
        if let Some(prev) = app.current.clone() {
            app.drafts_in.insert(prev, std::mem::take(&mut app.input));
        }
        app.input = app.drafts_in.remove(id).unwrap_or_default();
        app.cursor = app.input.len();
        app.hist_pos = None;
        app.scroll = 0;
        app.new_below = false;
        app.tsel = usize::MAX;
    }
    app.current = Some(id.to_string());
    app.screen = Screen::Chat;
    app.focus = Focus::Input;
    app.skills_closed = false;
    app.recent.retain(|r| r != id);
    app.recent.insert(0, id.to_string());
    // Keep the 4 most recently opened workspaces' events in memory.
    for old in app.recent.split_off(4.min(app.recent.len())) {
        if !app.is_running(&old) {
            app.data.remove(&old);
        }
    }
    let d = app.data.entry(id.to_string()).or_default();
    if !d.loaded {
        out.push(rpc(Tag::Events { ws: id.into(), since: None }, "events", json!({ "workspaceId": id })));
    }
    out.push(rpc(Tag::MarkSeen(id.into()), "markSeen", json!({ "workspaceId": id })));
    if let Some(pos) = app.fleet().iter().position(|r| r.id == id) {
        app.rail_sel = pos;
    }
    out
}

// ---------------------------------------------------------------------------------------------
// keys

fn is_char(k: &KeyEvent, c: char) -> bool {
    k.code == KeyCode::Char(c) && !k.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
}
fn ctrl(k: &KeyEvent, c: char) -> bool {
    k.code == KeyCode::Char(c) && k.modifiers.contains(KeyModifiers::CONTROL)
}
fn alt(k: &KeyEvent, c: char) -> bool {
    k.code == KeyCode::Char(c) && k.modifiers.contains(KeyModifiers::ALT)
}

fn key(app: &mut App, k: KeyEvent) -> Vec<Cmd> {
    // Ctrl+C: clear the input, else arm, then quit.
    if ctrl(&k, 'c') {
        if app.screen == Screen::Chat && !app.input.is_empty() && app.overlay.is_none() {
            app.input.clear();
            app.cursor = 0;
            return vec![];
        }
        if app.quit_armed > app.now {
            return vec![Cmd::Quit];
        }
        app.quit_armed = app.now + 2000;
        return vec![];
    }
    if app.size.0 < MIN_W || app.size.1 < MIN_H {
        return vec![];
    }
    // Ctrl+X chord.
    if app.chord > app.now {
        app.chord = 0;
        return match k.code {
            KeyCode::Char('1') => go_chat(app),
            KeyCode::Char('2') => go_inbox(app),
            KeyCode::Char('3') | KeyCode::Char('r') => go_review(app),
            KeyCode::Char('s') => start_ship(app),
            KeyCode::Char('q') => vec![Cmd::Quit],
            _ => vec![],
        };
    }
    if ctrl(&k, 'x') {
        app.chord = app.now + 1500;
        return vec![];
    }
    if alt(&k, '1') {
        return go_chat(app);
    }
    if alt(&k, '2') {
        return go_inbox(app);
    }
    if alt(&k, '3') {
        return go_review(app);
    }
    if ctrl(&k, 'l') {
        return vec![Cmd::Redraw];
    }
    // Overlays.
    match app.overlay.clone() {
        Some(Overlay::Confirm { action, .. }) => return confirm_key(app, k, action),
        Some(Overlay::Switcher { query, sel }) => return switcher_key(app, k, query, sel),
        Some(Overlay::Ship) => return ship_key(app, k),
        None => {}
    }
    if ctrl(&k, 'k') {
        app.overlay = Some(Overlay::Switcher { query: String::new(), sel: 0 });
        return vec![];
    }
    if ctrl(&k, 'b') {
        app.rail_shown = !app.rail_shown;
        if !app.rail_shown && app.focus == Focus::Rail {
            app.focus = Focus::Input;
        }
        return vec![];
    }
    match app.screen {
        Screen::Chat => chat_key(app, k),
        Screen::Inbox => inbox_key(app, k),
        Screen::Review => review_key(app, k),
    }
}

fn go_chat(app: &mut App) -> Vec<Cmd> {
    app.overlay = None;
    match app.current.clone() {
        Some(id) => open_ws(app, &id),
        None => {
            app.screen = Screen::Chat;
            vec![]
        }
    }
}

fn go_inbox(app: &mut App) -> Vec<Cmd> {
    app.overlay = None;
    if app.screen != Screen::Inbox {
        app.prev_screen = app.screen;
    }
    app.screen = Screen::Inbox;
    if let Some(c) = &app.current {
        if let Some(i) = app.fleet().iter().position(|r| &r.id == c) {
            app.inbox_sel = app.inbox_sel.min(app.fleet().len().saturating_sub(1));
            let _ = i;
        }
    }
    app.pr_next = app.now; // refresh PRs when the Inbox opens
    vec![]
}

fn go_review(app: &mut App) -> Vec<Cmd> {
    app.overlay = None;
    let Some(id) = app.current.clone() else {
        app.error("Open a workspace first");
        return vec![];
    };
    if app.screen != Screen::Review {
        app.prev_screen = app.screen;
    }
    app.screen = Screen::Review;
    let keep = app.review.as_ref().is_some_and(|r| r.ws == id && r.data.is_some());
    if keep {
        return vec![];
    }
    app.review = Some(ReviewState { ws: id.clone(), loading: true, focus_list: false, ..Default::default() });
    vec![rpc(Tag::Review(id.clone()), "review", json!({ "workspaceId": id, "scope": Scope::Base }))]
}

fn start_ship(app: &mut App) -> Vec<Cmd> {
    let Some(id) = app.current.clone() else {
        app.error("Open a workspace first");
        return vec![];
    };
    app.screen = Screen::Chat;
    app.overlay = Some(Overlay::Ship);
    let busy = app.ship.get(&id).is_some_and(|s| {
        matches!(s.phase, ShipPhase::Gate | ShipPhase::Agent | ShipPhase::WaitPr | ShipPhase::Merging)
    });
    if busy {
        return vec![];
    }
    if app.is_running(&id) {
        app.ship.remove(&id);
        app.error("Wait for the current turn to finish before shipping");
        app.overlay = None;
        return vec![];
    }
    ship_gate(app, &id, false)
}

fn ship_gate(app: &mut App, id: &str, skip: bool) -> Vec<Cmd> {
    app.ship.insert(
        id.to_string(),
        ShipState { phase: ShipPhase::Gate, checks: None, squashed: 0, last_tool: None, poll_at: 0, poll_until: 0 },
    );
    vec![rpc(Tag::Ship(id.into()), "ship", json!({ "workspaceId": id, "skipChecks": skip }))]
}

fn run_skill(app: &mut App, id: &str, skill: &str, args: &str) -> Vec<Cmd> {
    app.flash(format!("Running /{skill}"));
    vec![rpc(Tag::Fire, "runSkill", json!({ "workspaceId": id, "skillId": skill, "args": args }))]
}

fn send_text(app: &mut App, id: &str, text: String) -> Vec<Cmd> {
    if !app.connected {
        app.error("Not connected");
        return vec![];
    }
    let h = app.history.entry(id.to_string()).or_default();
    h.retain(|x| x != &text);
    h.push(text.clone());
    if h.len() > HISTORY {
        h.remove(0);
    }
    app.pending.insert(id.to_string(), text.clone());
    app.scroll = 0;
    vec![rpc(Tag::Send { ws: id.into(), text: text.clone() }, "send", json!({ "workspaceId": id, "text": text }))]
}

fn confirm_key(app: &mut App, k: KeyEvent, action: ConfirmAction) -> Vec<Cmd> {
    let yes = is_char(&k, 'y') || k.code == KeyCode::Enter;
    if !(yes || is_char(&k, 'n') || k.code == KeyCode::Esc) {
        return vec![];
    }
    app.overlay = None;
    if !yes {
        if matches!(action, ConfirmAction::Merge { .. }) {
            app.overlay = Some(Overlay::Ship);
        }
        return vec![];
    }
    match action {
        ConfirmAction::Merge { ws, number } => {
            app.overlay = Some(Overlay::Ship);
            if let Some(s) = app.ship.get_mut(&ws) {
                s.phase = ShipPhase::Merging;
            }
            vec![rpc(Tag::Merge(ws.clone()), "merge", json!({ "workspaceId": ws, "number": number }))]
        }
        ConfirmAction::SendReview(ws) => {
            let comments = app.drafts.get(&ws).cloned().unwrap_or_default();
            let count = comments.len();
            vec![rpc(
                Tag::SendReview { ws: ws.clone(), count },
                "sendReview",
                json!({ "workspaceId": ws, "comments": comments }),
            )]
        }
    }
}

fn switcher_key(app: &mut App, k: KeyEvent, mut query: String, mut sel: usize) -> Vec<Cmd> {
    let n = app.switcher_matches(&query).len();
    match k.code {
        KeyCode::Esc => {
            app.overlay = None;
            return vec![];
        }
        KeyCode::Enter => {
            app.overlay = None;
            if let Some(r) = app.switcher_matches(&query).get(sel) {
                let id = r.id.clone();
                return open_ws(app, &id);
            }
            return vec![];
        }
        KeyCode::Up => sel = sel.saturating_sub(1),
        KeyCode::Down => sel = (sel + 1).min(n.saturating_sub(1)),
        KeyCode::Char('p') if k.modifiers.contains(KeyModifiers::CONTROL) => sel = sel.saturating_sub(1),
        KeyCode::Char('n') if k.modifiers.contains(KeyModifiers::CONTROL) => sel = (sel + 1).min(n.saturating_sub(1)),
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
    app.overlay = Some(Overlay::Switcher { query, sel });
    vec![]
}

fn ship_key(app: &mut App, k: KeyEvent) -> Vec<Cmd> {
    let Some(id) = app.current.clone() else {
        app.overlay = None;
        return vec![];
    };
    let phase = app.ship.get(&id).map(|s| s.phase.clone());
    let pr = app.prs.get(&id).cloned();
    if k.code == KeyCode::Esc {
        app.overlay = None;
        return vec![];
    }
    if is_char(&k, 'a') && phase == Some(ShipPhase::GateFailed) {
        return ship_gate(app, &id, true);
    }
    if is_char(&k, 'f') {
        if phase == Some(ShipPhase::GateFailed) {
            let ws = app.ws(&id).cloned().unwrap_or_default();
            let mut ws = ws;
            if let Some(c) = app.ship.get(&id).and_then(|s| s.checks.clone()) {
                ws.checks_command = Some(c.command);
                ws.checks_output = Some(c.output_tail);
            }
            app.overlay = None;
            app.ship.remove(&id);
            return send_text(app, &id, attention::fix_checks_prompt(&ws));
        }
        if pr.is_some() {
            app.overlay = None;
            return run_skill(app, &id, "shipkit:fix-ci", "");
        }
    }
    if is_char(&k, 'c') && pr.is_some() {
        app.overlay = None;
        return run_skill(app, &id, "shipkit:address-comments", "");
    }
    if is_char(&k, 'o') {
        if let Some(p) = &pr {
            return vec![Cmd::Open(p.url.clone())];
        }
    }
    if is_char(&k, 'r') {
        return vec![rpc(Tag::PrStatus(id.clone()), "prStatus", json!({ "workspaceId": id }))];
    }
    if is_char(&k, 'm') {
        match &pr {
            Some(p) if p.state == "OPEN" && p.mergeable == "MERGEABLE" && p.checks.failed == 0 => {
                let base = app.cur_ws().map(|w| app.base_branch(w)).unwrap_or_else(|| "main".into());
                app.ship.entry(id.clone()).or_insert(ShipState {
                    phase: ShipPhase::Pr,
                    checks: None,
                    squashed: 0,
                    last_tool: None,
                    poll_at: 0,
                    poll_until: 0,
                });
                app.overlay = Some(Overlay::Confirm {
                    prompt: format!("Merge #{} into {base}?", p.number),
                    action: ConfirmAction::Merge { ws: id, number: p.number },
                });
            }
            Some(_) => app.error("The pull request can't be merged yet"),
            None => {}
        }
    }
    vec![]
}

// ---- chat

fn chat_key(app: &mut App, k: KeyEvent) -> Vec<Cmd> {
    if k.code == KeyCode::Tab || k.code == KeyCode::BackTab {
        if app.skill_query().is_some() && k.code == KeyCode::Tab {
            if let Some(s) = app.skill_matches().get(app.skills_sel).map(|s| s.id.clone()) {
                app.input = format!("/{s} ");
                app.cursor = app.input.len();
            }
            return vec![];
        }
        let order: Vec<Focus> = if app.rail_visible() {
            vec![Focus::Input, Focus::Rail, Focus::Transcript]
        } else {
            vec![Focus::Input, Focus::Transcript]
        };
        let i = order.iter().position(|f| *f == app.focus).unwrap_or(0);
        let n = order.len();
        app.focus = if k.code == KeyCode::Tab { order[(i + 1) % n] } else { order[(i + n - 1) % n] };
        if app.focus == Focus::Rail {
            if let Some(c) = &app.current {
                app.rail_sel = app.fleet().iter().position(|r| &r.id == c).unwrap_or(0);
            }
        }
        if app.focus == Focus::Transcript {
            let n = app.current.as_ref().and_then(|c| app.data.get(c)).map(|d| d.blocks.len()).unwrap_or(0);
            app.tsel = n.saturating_sub(1);
        }
        return vec![];
    }
    if ctrl(&k, 's') {
        return start_ship(app);
    }
    if ctrl(&k, 'r') {
        return go_review(app);
    }
    match k.code {
        KeyCode::PageUp => {
            scroll_by(app, (app.size.1 / 2) as i32);
            return vec![];
        }
        KeyCode::PageDown => {
            scroll_by(app, -((app.size.1 / 2) as i32));
            return vec![];
        }
        _ => {}
    }
    match app.focus {
        Focus::Input => input_key(app, k),
        Focus::Rail => rail_key(app, k),
        Focus::Transcript => transcript_key(app, k),
    }
}

fn scroll_by(app: &mut App, up: i32) {
    if up >= 0 {
        app.scroll = app.scroll.saturating_add(up as usize);
    } else {
        app.scroll = app.scroll.saturating_sub((-up) as usize);
    }
    if app.scroll == 0 {
        app.new_below = false;
    }
}

fn rail_key(app: &mut App, k: KeyEvent) -> Vec<Cmd> {
    let n = app.fleet().len();
    match k.code {
        KeyCode::Char('j') | KeyCode::Down => app.rail_sel = (app.rail_sel + 1).min(n.saturating_sub(1)),
        KeyCode::Char('k') | KeyCode::Up => app.rail_sel = app.rail_sel.saturating_sub(1),
        KeyCode::Enter => {
            if let Some(r) = app.fleet().get(app.rail_sel) {
                let id = r.id.clone();
                return open_ws(app, &id);
            }
        }
        KeyCode::Char('d') => {
            if let Some(r) = app.fleet().get(app.rail_sel) {
                let id = r.id.clone();
                return vec![rpc(Tag::Dismiss(id.clone()), "dismiss", json!({ "workspaceId": id }))];
            }
        }
        KeyCode::Esc => app.focus = Focus::Input,
        _ => {}
    }
    vec![]
}

fn transcript_key(app: &mut App, k: KeyEvent) -> Vec<Cmd> {
    let Some(id) = app.current.clone() else { return vec![] };
    let n = app.data.get(&id).map(|d| d.blocks.len()).unwrap_or(0);
    if app.tsel >= n {
        app.tsel = n.saturating_sub(1);
    }
    match k.code {
        KeyCode::Char('j') | KeyCode::Down => app.tsel = (app.tsel + 1).min(n.saturating_sub(1)),
        KeyCode::Char('k') | KeyCode::Up => app.tsel = app.tsel.saturating_sub(1),
        KeyCode::Char('g') => app.tsel = 0,
        KeyCode::Char('G') => app.tsel = n.saturating_sub(1),
        KeyCode::Enter => {
            let Some(d) = app.data.get(&id) else { return vec![] };
            if let Some(b @ Block::Tools { .. }) = d.blocks.get(app.tsel) {
                let open = app.tools_expanded(d, app.tsel);
                app.expanded.insert(b.key().to_string(), !open);
            }
        }
        KeyCode::Esc => app.focus = Focus::Input,
        _ => {}
    }
    vec![]
}

fn line_bounds(s: &str, cursor: usize) -> (usize, usize) {
    let start = s[..cursor].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let end = s[cursor..].find('\n').map(|i| cursor + i).unwrap_or(s.len());
    (start, end)
}

fn prev_char(s: &str, i: usize) -> usize {
    s[..i].char_indices().next_back().map(|(p, _)| p).unwrap_or(0)
}
fn next_char(s: &str, i: usize) -> usize {
    s[i..].chars().next().map(|c| i + c.len_utf8()).unwrap_or(i)
}

fn insert(app: &mut App, s: &str) {
    app.input.insert_str(app.cursor, s);
    app.cursor += s.len();
    app.hist_pos = None;
    app.skills_sel = 0;
    if !app.input.starts_with('/') {
        app.skills_closed = false;
    }
}

fn paste(app: &mut App, s: &str) {
    let s = s.replace("\r\n", "\n").replace('\r', "\n");
    if let Some(r) = app.review.as_mut().filter(|_| app.screen == Screen::Review) {
        if let Some(c) = r.commenting.as_mut() {
            c.push_str(&s.replace('\n', " "));
        }
        return;
    }
    if let Some(Overlay::Switcher { query, .. }) = app.overlay.as_mut() {
        query.push_str(s.lines().next().unwrap_or(""));
        return;
    }
    if app.screen == Screen::Chat {
        app.focus = Focus::Input;
        insert(app, &s);
    }
}

fn input_key(app: &mut App, k: KeyEvent) -> Vec<Cmd> {
    let Some(id) = app.current.clone() else {
        return vec![];
    };
    let popup = app.skill_query().is_some();
    let m = k.modifiers;
    match k.code {
        KeyCode::Esc => {
            if popup {
                app.skills_closed = true;
            } else if app.is_running(&id) {
                app.flash("Stopping…");
                return vec![rpc(Tag::Fire, "interrupt", json!({ "workspaceId": id }))];
            }
        }
        KeyCode::Enter if m.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT) => insert(app, "\n"),
        KeyCode::Char('j') if m.contains(KeyModifiers::CONTROL) => insert(app, "\n"),
        KeyCode::Enter => {
            let text = app.input.trim().to_string();
            if text.is_empty() {
                return vec![];
            }
            if let Some(rest) = text.strip_prefix('/') {
                let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
                let chosen = if popup {
                    app.skill_matches().get(app.skills_sel).map(|s| s.id.clone())
                } else {
                    app.skills
                        .iter()
                        .find(|s| s.id == name || s.id.rsplit(':').next() == Some(name))
                        .map(|s| s.id.clone())
                };
                if let Some(skill) = chosen {
                    app.input.clear();
                    app.cursor = 0;
                    let h = app.history.entry(id.clone()).or_default();
                    h.push(text.clone());
                    return run_skill(app, &id, &skill, args.trim());
                }
            }
            app.input.clear();
            app.cursor = 0;
            return send_text(app, &id, text);
        }
        KeyCode::Up if popup => app.skills_sel = app.skills_sel.saturating_sub(1),
        KeyCode::Down if popup => {
            app.skills_sel = (app.skills_sel + 1).min(app.skill_matches().len().saturating_sub(1))
        }
        KeyCode::Char('p') if popup && m.contains(KeyModifiers::CONTROL) => {
            app.skills_sel = app.skills_sel.saturating_sub(1)
        }
        KeyCode::Char('n') if popup && m.contains(KeyModifiers::CONTROL) => {
            app.skills_sel = (app.skills_sel + 1).min(app.skill_matches().len().saturating_sub(1))
        }
        KeyCode::Up => {
            let (start, _) = line_bounds(&app.input, app.cursor);
            if start == 0 {
                history(app, &id, -1);
            } else {
                let col = app.input[start..app.cursor].chars().count();
                let (ps, pe) = line_bounds(&app.input, start - 1);
                app.cursor = app.input[ps..pe].char_indices().nth(col).map(|(i, _)| ps + i).unwrap_or(pe);
            }
        }
        KeyCode::Down => {
            let (start, end) = line_bounds(&app.input, app.cursor);
            if end == app.input.len() {
                history(app, &id, 1);
            } else {
                let col = app.input[start..app.cursor].chars().count();
                let (ns, ne) = line_bounds(&app.input, end + 1);
                app.cursor = app.input[ns..ne].char_indices().nth(col).map(|(i, _)| ns + i).unwrap_or(ne);
            }
        }
        KeyCode::Left => app.cursor = prev_char(&app.input, app.cursor),
        KeyCode::Right => app.cursor = next_char(&app.input, app.cursor),
        KeyCode::Home => app.cursor = line_bounds(&app.input, app.cursor).0,
        KeyCode::End => app.cursor = line_bounds(&app.input, app.cursor).1,
        KeyCode::Backspace => {
            if app.cursor > 0 {
                let p = prev_char(&app.input, app.cursor);
                app.input.replace_range(p..app.cursor, "");
                app.cursor = p;
                app.skills_sel = 0;
            }
        }
        KeyCode::Delete => {
            let n = next_char(&app.input, app.cursor);
            app.input.replace_range(app.cursor..n, "");
        }
        KeyCode::Char('u') if m.contains(KeyModifiers::CONTROL) => {
            let (start, _) = line_bounds(&app.input, app.cursor);
            app.input.replace_range(start..app.cursor, "");
            app.cursor = start;
        }
        KeyCode::Char('w') if m.contains(KeyModifiers::CONTROL) => {
            let before = &app.input[..app.cursor];
            let trimmed = before.trim_end();
            let start = trimmed.rfind(char::is_whitespace).map(|i| i + 1).unwrap_or(0);
            app.input.replace_range(start..app.cursor, "");
            app.cursor = start;
        }
        KeyCode::Char(c) if !m.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            let mut b = [0; 4];
            insert(app, c.encode_utf8(&mut b));
        }
        _ => {}
    }
    vec![]
}

fn history(app: &mut App, id: &str, dir: i32) {
    let h = app.history.get(id).cloned().unwrap_or_default();
    if h.is_empty() {
        return;
    }
    let pos = match (app.hist_pos, dir) {
        (None, -1) => Some(h.len() - 1),
        (None, _) => None,
        (Some(p), -1) => Some(p.saturating_sub(1)),
        (Some(p), _) if p + 1 < h.len() => Some(p + 1),
        (Some(_), _) => None,
    };
    app.hist_pos = pos;
    app.input = pos.map(|p| h[p].clone()).unwrap_or_default();
    app.cursor = app.input.len();
}

// ---- inbox

fn move_inbox(app: &mut App, d: i64) {
    let n = app.fleet().len() as i64;
    app.inbox_sel = (app.inbox_sel as i64 + d).clamp(0, (n - 1).max(0)) as usize;
}

fn inbox_key(app: &mut App, k: KeyEvent) -> Vec<Cmd> {
    let fleet = app.fleet();
    let row = fleet.get(app.inbox_sel).cloned();
    match k.code {
        KeyCode::Char('j') | KeyCode::Down => move_inbox(app, 1),
        KeyCode::Char('k') | KeyCode::Up => move_inbox(app, -1),
        KeyCode::Esc if app.current.is_some() => {
            let prev = if app.prev_screen == Screen::Inbox { Screen::Chat } else { app.prev_screen };
            if prev == Screen::Review {
                return go_review(app);
            }
            return go_chat(app);
        }
        _ => {}
    }
    let Some(row) = row else { return vec![] };
    let id = row.id.clone();
    let ws = app.ws(&id).cloned().unwrap_or_default();
    match k.code {
        KeyCode::Enter | KeyCode::Char('r') => return open_ws(app, &id),
        KeyCode::Char('s') => {
            let mut out = open_ws(app, &id);
            out.extend(start_ship(app));
            return out;
        }
        KeyCode::Char('f') => match row.reason {
            Some(Reason::ChecksFailed) => {
                let mut out = open_ws(app, &id);
                out.extend(send_text(app, &id, attention::fix_checks_prompt(&ws)));
                return out;
            }
            Some(Reason::Checks) => {
                let mut out = open_ws(app, &id);
                out.extend(run_skill(app, &id, "shipkit:fix-ci", ""));
                return out;
            }
            Some(Reason::NeedsSync) => {
                let base = app.base_branch(&ws);
                let mut out = open_ws(app, &id);
                out.extend(send_text(app, &id, attention::resolve_conflicts_prompt(&ws, &base)));
                return out;
            }
            _ => app.error("Nothing to fix here"),
        },
        KeyCode::Char('c') => {
            if app.prs.get(&id).is_some_and(|p| p.state == "OPEN") {
                let mut out = open_ws(app, &id);
                out.extend(run_skill(app, &id, "shipkit:address-comments", ""));
                return out;
            }
            app.error("No open pull request");
        }
        KeyCode::Char('d') => return vec![rpc(Tag::Dismiss(id.clone()), "dismiss", json!({ "workspaceId": id }))],
        KeyCode::Char(c @ '1'..='3') if !k.modifiers.contains(KeyModifiers::ALT) => {
            let sug = app.suggestions(&row);
            let Some(s) = sug.get((c as u8 - b'1') as usize).cloned() else { return vec![] };
            let mut out = open_ws(app, &id);
            match s {
                Suggestion::Text { text, .. } => out.extend(send_text(app, &id, text)),
                Suggestion::Skill { skill_id, .. } => out.extend(run_skill(app, &id, &skill_id, "")),
                Suggestion::Ship { anyway, .. } => {
                    app.overlay = Some(Overlay::Ship);
                    out.extend(ship_gate(app, &id, anyway));
                }
            }
            return out;
        }
        _ => {}
    }
    vec![]
}

// ---- review

fn review_select(app: &mut App) -> Vec<Cmd> {
    let Some(r) = app.review.as_mut() else { return vec![] };
    let entries = r.entries();
    let Some(Entry::File(path)) = entries.get(r.list_sel).cloned() else { return vec![] };
    if r.file.as_deref() == Some(path.as_str()) {
        return vec![];
    }
    r.file = Some(path.clone());
    r.cursor = 0;
    r.commenting = None;
    rebuild_rows(r);
    if r.sides.contains_key(&path) {
        return vec![];
    }
    let Some(d) = &r.data else { return vec![] };
    let ws = r.ws.clone();
    let mut out = vec![];
    for (side, rf) in [(FileSide::Old, d.old_ref.clone()), (FileSide::New, d.new_ref.clone())] {
        out.push(rpc(
            Tag::FileAt { ws: ws.clone(), path: path.clone(), side },
            "fileAt",
            json!({ "workspaceId": ws, "path": path, "ref": rf }),
        ));
    }
    r.sides.insert(path, (None, None));
    out
}

fn rebuild_rows(r: &mut ReviewState) {
    r.rows.clear();
    let Some(path) = &r.file else { return };
    let Some((Some(old), Some(new))) = r.sides.get(path) else { return };
    if old.binary || new.binary {
        r.rows = vec![Row::Note("Binary file".into())];
    } else if old.too_large || new.too_large {
        r.rows = vec![Row::Note("File too large to show (> 2 MB)".into())];
    } else {
        let a = old.text.as_deref().unwrap_or("");
        let b = new.text.as_deref().unwrap_or("");
        r.rows = diff::diff(a, b);
        if r.rows.is_empty() {
            r.rows = vec![Row::Note("No changes".into())];
        }
    }
    // Start on the first changed line.
    r.cursor =
        r.rows.iter().position(|x| matches!(x, Row::Line { kind: diff::Kind::Add | diff::Kind::Del, .. })).unwrap_or(0);
}

fn review_move(app: &mut App, d: i64) {
    let Some(r) = app.review.as_mut() else { return };
    if r.focus_list {
        let n = r.entries().len() as i64;
        r.list_sel = (r.list_sel as i64 + d).clamp(0, (n - 1).max(0)) as usize;
    } else {
        let n = r.rows.len() as i64;
        r.cursor = (r.cursor as i64 + d).clamp(0, (n - 1).max(0)) as usize;
    }
}

fn review_scope(app: &mut App, scope: Scope) -> Vec<Cmd> {
    let Some(r) = app.review.as_mut() else { return vec![] };
    r.scope = Some(scope.clone());
    r.loading = true;
    r.accepted.clear();
    let ws = r.ws.clone();
    vec![rpc(Tag::Review(ws.clone()), "review", json!({ "workspaceId": ws, "scope": scope }))]
}

fn review_key(app: &mut App, k: KeyEvent) -> Vec<Cmd> {
    let Some(r) = app.review.as_mut() else {
        app.screen = Screen::Chat;
        return vec![];
    };
    // The one-line comment input.
    if let Some(text) = r.commenting.as_mut() {
        match k.code {
            KeyCode::Esc => r.commenting = None,
            KeyCode::Backspace => {
                text.pop();
            }
            KeyCode::Enter => {
                let text = std::mem::take(text);
                r.commenting = None;
                if text.trim().is_empty() {
                    return vec![];
                }
                if let (Some(path), Some(row)) = (r.file.clone(), r.rows.get(r.cursor)) {
                    if let (Some((line, side)), Row::Line { text: src, .. }) = (row.anchor(), row) {
                        let c = ReviewComment {
                            path,
                            start_line: line,
                            end_line: line,
                            side: side.into(),
                            text: text.trim().into(),
                            excerpt: src.clone(),
                        };
                        let ws = r.ws.clone();
                        app.drafts.entry(ws).or_default().push(c);
                    }
                }
            }
            KeyCode::Char(c) if !k.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => text.push(c),
            _ => {}
        }
        return vec![];
    }
    let half = (app.size.1 / 2) as i64;
    match k.code {
        KeyCode::Esc => {
            return if app.prev_screen == Screen::Inbox { go_inbox(app) } else { go_chat(app) };
        }
        KeyCode::Tab | KeyCode::BackTab => {
            r.focus_list = !r.focus_list;
            if r.focus_list {
                let entries = r.entries();
                if let Some(p) = &r.file {
                    r.list_sel = entries.iter().position(|e| e == &Entry::File(p.clone())).unwrap_or(0);
                }
            }
            return vec![];
        }
        KeyCode::Char('j') | KeyCode::Down => review_move(app, 1),
        KeyCode::Char('k') | KeyCode::Up => review_move(app, -1),
        KeyCode::Char('J') | KeyCode::PageDown => review_move(app, half),
        KeyCode::Char('K') | KeyCode::PageUp => review_move(app, -half),
        KeyCode::Char(']') | KeyCode::Char('[') => {
            let fwd = k.code == KeyCode::Char(']');
            let files = r.entries().iter().filter(|e| matches!(e, Entry::File(_))).count();
            if files > 0 {
                let cur = r.list_sel.min(files - 1);
                r.list_sel = if fwd { (cur + 1) % files } else { (cur + files - 1) % files };
                return review_select(app);
            }
            return vec![];
        }
        KeyCode::Char('n') | KeyCode::Char('p') => {
            let fwd = k.code == KeyCode::Char('n');
            let hunks: Vec<usize> =
                r.rows.iter().enumerate().filter(|(_, x)| matches!(x, Row::Hunk(_))).map(|(i, _)| i + 1).collect();
            let next = if fwd {
                hunks.iter().find(|&&h| h > r.cursor).copied()
            } else {
                hunks.iter().rev().find(|&&h| h < r.cursor).copied()
            };
            if let Some(h) = next {
                r.cursor = h.min(r.rows.len().saturating_sub(1));
            }
            return vec![];
        }
        KeyCode::Char('c') => {
            if matches!(r.scope, Some(Scope::Commit { .. })) {
                app.error("A single commit is read-only");
            } else if r.rows.get(r.cursor).and_then(|x| x.anchor()).is_some() {
                r.commenting = Some(String::new());
            }
            return vec![];
        }
        KeyCode::Char('a') => {
            if let Some(p) = r.file.clone() {
                if r.accepted.contains(&p) {
                    r.accepted.retain(|x| x != &p);
                } else {
                    r.accepted.push(p);
                    let files = r.file_count();
                    // Move on to the next unaccepted file.
                    r.list_sel = 0;
                    if r.accepted.len() < files {
                        r.file = None;
                        return review_select(app);
                    }
                }
            }
            return vec![];
        }
        KeyCode::Char('v') => {
            let has_turn = r.data.as_ref().is_some_and(|d| d.turn_available);
            let next = match r.scope {
                Some(Scope::Base) if has_turn => Some(Scope::Turn),
                Some(Scope::Base) | Some(Scope::Turn) => None,
                _ => Some(Scope::Base),
            };
            match next {
                Some(s) => return review_scope(app, s),
                None => {
                    // Pick a commit from the list.
                    let files = r.entries().iter().filter(|e| matches!(e, Entry::File(_))).count();
                    if r.data.as_ref().is_some_and(|d| !d.commits.is_empty()) {
                        r.focus_list = true;
                        r.list_sel = files;
                        app.flash("Pick a commit · enter");
                    } else {
                        return review_scope(app, Scope::Base);
                    }
                }
            }
            return vec![];
        }
        KeyCode::Enter => {
            if r.focus_list {
                match r.entries().get(r.list_sel).cloned() {
                    Some(Entry::Commit(i)) => {
                        let sha = r.data.as_ref().map(|d| d.commits[i].sha.clone()).unwrap_or_default();
                        return review_scope(app, Scope::Commit { sha });
                    }
                    Some(Entry::File(_)) => {
                        r.focus_list = false;
                        return review_select(app);
                    }
                    None => {}
                }
                return vec![];
            }
            let ws = r.ws.clone();
            let n = app.drafts.get(&ws).map(|d| d.len()).unwrap_or(0);
            if n == 0 {
                app.error("No comments to send · c to comment");
                return vec![];
            }
            let name = app.ws(&ws).map(|w| w.name.clone()).unwrap_or_default();
            app.overlay = Some(Overlay::Confirm {
                prompt: format!("Send {n} comment{} to {name}?", if n == 1 { "" } else { "s" }),
                action: ConfirmAction::SendReview(ws),
            });
            return vec![];
        }
        _ => {}
    }
    // Moving in the list opens the file under the selection.
    if app.review.as_ref().is_some_and(|r| r.focus_list) {
        return review_select(app);
    }
    vec![]
}

fn from<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, serde_json::Error> {
    serde_json::from_value(v)
}
