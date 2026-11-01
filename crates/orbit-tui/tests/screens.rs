//! Plain-text renders of every demo screen at 120×36 (plus a narrow one), driven through the real
//! `update` loop against `DemoBackend`. Each render is compared with `screens/<name>.txt`; set
//! `ORB_UPDATE_SCREENS=1` to rewrite them after reviewing the change.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use orbit_tui::app::{update, App, Cmd, Config, Msg, Screen, Side};
use orbit_tui::backend::Backend;
use orbit_tui::demo::DemoBackend;
use orbit_tui::theme::{Depth, Theme, Variant};
use orbit_tui::view;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;

/// 2026-10-31 14:00 UTC, fixed so ages and durations are stable.
const NOW: i64 = 1_793_455_200_000;

struct H {
    app: App,
    demo: DemoBackend,
    pushes: mpsc::Receiver<orbit_proto::Push>,
    clock: i64,
}

impl H {
    async fn new(w: u16, h: u16, side: Side) -> H {
        let demo = DemoBackend::new(NOW, false);
        let pushes = demo.subscribe();
        let cfg = Config { rail_side: side, motion: false, ..Config::default() };
        let mut app = App::new(cfg, Theme::new(Variant::Void, Depth::TrueColor), NOW);
        app.size = (w, h);
        let mut h = H { app, demo, pushes, clock: NOW };
        let init = h.app.init();
        h.run(init).await;
        h
    }

    async fn run(&mut self, mut cmds: Vec<Cmd>) {
        loop {
            while let Ok(p) = self.pushes.try_recv() {
                cmds.extend(update(&mut self.app, Msg::Push(p)));
            }
            let Some(c) = cmds.pop() else { break };
            if let Cmd::Rpc { tag, method, params } = c {
                let res = self.demo.rpc(method, params).await;
                let more = update(&mut self.app, Msg::Rpc(tag, res));
                cmds.extend(more);
            }
        }
    }

    async fn msg(&mut self, m: Msg) {
        let c = update(&mut self.app, m);
        self.run(c).await;
    }

    async fn key(&mut self, code: KeyCode, mods: KeyModifiers) {
        self.msg(Msg::Key(KeyEvent::new(code, mods))).await;
    }
    async fn ch(&mut self, c: char) {
        self.key(KeyCode::Char(c), KeyModifiers::NONE).await;
    }
    async fn typed(&mut self, s: &str) {
        for c in s.chars() {
            self.ch(c).await;
        }
    }
    async fn ctrl(&mut self, c: char) {
        self.key(KeyCode::Char(c), KeyModifiers::CONTROL).await;
    }
    async fn alt(&mut self, c: char) {
        self.key(KeyCode::Char(c), KeyModifiers::ALT).await;
    }

    /// Lets the demo's scripts run for `ms` of (paused) time, then ticks the app.
    async fn wait(&mut self, ms: u64) {
        let mut left = ms;
        while left > 0 {
            let step = left.min(300);
            tokio::time::sleep(Duration::from_millis(step)).await;
            self.clock += step as i64;
            left -= step;
            self.msg(Msg::Tick(self.clock)).await;
        }
    }

    async fn open(&mut self, name: &str) {
        let id = self.app.workspaces.iter().find(|w| w.name == name).map(|w| w.id.clone()).unwrap();
        let c = orbit_tui::app::open_ws(&mut self.app, &id);
        self.run(c).await;
    }

    fn text(&self) -> String {
        let (w, h) = self.app.size;
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        view::render(&mut buf, area, &self.app);
        let mut out = String::new();
        for y in 0..h {
            let mut line = String::new();
            for x in 0..w {
                line.push_str(buf[(x, y)].symbol());
            }
            out.push_str(line.trim_end());
            out.push('\n');
        }
        out
    }

    fn snap(&self, name: &str) {
        let got = self.text();
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("screens").join(format!("{name}.txt"));
        if std::env::var("ORB_UPDATE_SCREENS").is_ok() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &got).unwrap();
            return;
        }
        let want = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(want == got, "screen {name} changed (ORB_UPDATE_SCREENS=1 to accept):\n{got}");
    }
}

#[tokio::test(start_paused = true)]
async fn inbox_is_the_start_screen() {
    let mut h = H::new(120, 36, Side::Left).await;
    assert_eq!(h.app.screen, Screen::Inbox);
    h.snap("01-inbox");
    let at = h.app.fleet().iter().position(|r| h.app.ws(&r.id).unwrap().name == "api-retry").unwrap();
    for _ in 0..at {
        h.ch('j').await;
    }
    h.snap("02-inbox-selected-error");
    let t = h.text();
    assert!(t.contains("Failed: API Error: 529 overloaded"), "{t}");
    assert!(t.contains("1 Try that again"), "{t}");
}

#[tokio::test(start_paused = true)]
async fn chat_running_rail_left() {
    let mut h = H::new(120, 36, Side::Left).await;
    h.open("fix-login").await;
    h.snap("03-chat-running");
    let t = h.text();
    assert!(t.contains("make the login test stop flaking"));
    assert!(t.contains("needs you") && t.contains("running") && t.contains("done"));
}

#[tokio::test(start_paused = true)]
async fn chat_finished_rail_right() {
    let mut h = H::new(120, 36, Side::Right).await;
    h.open("readme-badge").await;
    h.snap("04-chat-finished-rail-right");
}

#[tokio::test(start_paused = true)]
async fn chat_narrow_hides_rail() {
    let mut h = H::new(80, 24, Side::Left).await;
    h.open("review-copy").await;
    assert!(!h.app.rail_visible());
    h.snap("05-chat-80x24");
}

#[tokio::test(start_paused = true)]
async fn streaming_turn() {
    let mut h = H::new(120, 36, Side::Left).await;
    h.open("readme-badge").await;
    h.typed("tighten the badge alt text").await;
    h.snap("06-chat-typing");
    h.key(KeyCode::Enter, KeyModifiers::NONE).await;
    h.wait(1500).await;
    h.snap("07-chat-streaming");
    h.wait(20_000).await;
    h.snap("08-chat-turn-done");
    assert!(h.text().contains("Want me to ship it?"));
}

#[tokio::test(start_paused = true)]
async fn skills_popup() {
    let mut h = H::new(120, 36, Side::Left).await;
    h.open("readme-badge").await;
    h.ch('/').await;
    h.snap("09-skills");
    h.typed("fix").await;
    h.snap("10-skills-filtered");
    h.key(KeyCode::Tab, KeyModifiers::NONE).await;
    assert_eq!(h.app.input, "/shipkit:fix-ci ");
}

#[tokio::test(start_paused = true)]
async fn ship_flow_to_merge() {
    let mut h = H::new(120, 36, Side::Left).await;
    h.open("readme-badge").await;
    // Snapshot before the gate's reply arrives: checks are still running.
    let pending = update(&mut h.app, Msg::Key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL)));
    h.snap("11-ship-gate");
    h.run(pending).await;
    h.wait(4000).await;
    h.snap("12-ship-agent");
    h.wait(4000).await;
    h.snap("13-ship-pr-pending");
    h.wait(20_000).await;
    h.snap("14-ship-ready");
    assert!(h.text().contains("Ready to merge."));
    h.ch('m').await;
    h.snap("15-ship-confirm-merge");
    h.ch('y').await;
    h.wait(1000).await;
    h.snap("16-ship-merged");
}

#[tokio::test(start_paused = true)]
async fn ship_gate_fails() {
    let mut h = H::new(120, 36, Side::Left).await;
    h.open("bump-deps").await;
    h.ctrl('s').await;
    h.wait(2000).await;
    h.snap("17-ship-checks-failed");
    assert!(h.text().contains("a ship anyway"));
}

#[tokio::test(start_paused = true)]
async fn review_with_comment() {
    let mut h = H::new(120, 36, Side::Left).await;
    h.open("fix-login").await;
    h.alt('3').await;
    assert_eq!(h.app.screen, Screen::Review);
    h.snap("18-review");
    h.ch(']').await;
    for _ in 0..6 {
        h.ch('j').await;
    }
    h.ch('c').await;
    h.typed("Use the existing waitFor helper here instead of a new API.").await;
    h.key(KeyCode::Enter, KeyModifiers::NONE).await;
    h.snap("19-review-comment");
    h.key(KeyCode::Tab, KeyModifiers::NONE).await;
    for _ in 0..4 {
        h.ch('j').await;
    }
    h.key(KeyCode::Enter, KeyModifiers::NONE).await;
    h.snap("20-review-commit-scope");
    h.ch('v').await;
    h.key(KeyCode::Enter, KeyModifiers::NONE).await;
    assert!(matches!(h.app.overlay, Some(orbit_tui::app::Overlay::Confirm { .. })));
    h.snap("21-review-confirm-send");
    h.ch('y').await;
    assert_eq!(h.app.screen, Screen::Chat);
}

#[tokio::test(start_paused = true)]
async fn switcher_and_transcript_focus() {
    let mut h = H::new(120, 36, Side::Left).await;
    h.open("fix-login").await;
    h.ctrl('k').await;
    h.typed("de").await;
    h.snap("22-switcher");
    h.key(KeyCode::Esc, KeyModifiers::NONE).await;
    h.key(KeyCode::Tab, KeyModifiers::NONE).await;
    h.key(KeyCode::Tab, KeyModifiers::NONE).await;
    // From the last block up to the first (folded) tool group, and expand it.
    for _ in 0..4 {
        h.ch('k').await;
    }
    h.key(KeyCode::Enter, KeyModifiers::NONE).await;
    h.snap("23-chat-transcript-focus");
    assert!(h.text().contains("→ read  login.test.ts"), "{}", h.text());
}

#[tokio::test(start_paused = true)]
async fn too_small() {
    let h = H::new(50, 12, Side::Left).await;
    assert!(h.text().contains("Orbit needs at least 60×16"));
}

/// Every screen also renders in Paper, ANSI-16 and NO_COLOR; only truecolor may emit RGB.
#[tokio::test(start_paused = true)]
async fn themes_and_depths() {
    use ratatui::style::Color;
    for (variant, depth) in [
        (Variant::Paper, Depth::TrueColor),
        (Variant::Void, Depth::Ansi16),
        (Variant::Paper, Depth::Ansi16),
        (Variant::Void, Depth::NoColor),
    ] {
        let mut h = H::new(120, 36, Side::Right).await;
        h.app.theme = Theme::new(variant, depth);
        let mut screens = Vec::new();
        let mut grab = |h: &H| {
            let area = Rect::new(0, 0, 120, 36);
            let mut buf = Buffer::empty(area);
            view::render(&mut buf, area, &h.app);
            screens.push(buf);
        };
        grab(&h);
        h.open("fix-login").await;
        grab(&h);
        h.ch('/').await;
        grab(&h);
        h.key(KeyCode::Esc, KeyModifiers::NONE).await;
        h.alt('3').await;
        grab(&h);
        for buf in &screens {
            let rgb = buf.content.iter().any(|c| matches!(c.fg, Color::Rgb(..)) || matches!(c.bg, Color::Rgb(..)));
            assert_eq!(rgb, depth == Depth::TrueColor, "{variant:?} {depth:?}");
            if depth == Depth::NoColor {
                assert!(buf.content.iter().all(|c| c.fg == Color::Reset && c.bg == Color::Reset));
            }
        }
    }
}
