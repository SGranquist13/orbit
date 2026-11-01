//! Random key presses, pastes, scrolls, resizes and clock ticks through the real `update` loop and
//! renderer against the demo backend. Nothing may panic, at any terminal size. Deterministic:
//! a failure prints its seed and step. `ORB_FUZZ_RUNS=<n>` runs more seeds.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use orbit_tui::app::{update, App, Cmd, Config, Msg};
use orbit_tui::backend::Backend;
use orbit_tui::demo::DemoBackend;
use orbit_tui::theme::{Depth, Theme, Variant};
use orbit_tui::view;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use std::time::Duration;

const NOW: i64 = 1_793_455_200_000;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn random_msg(r: &mut Rng) -> Msg {
    let k = |code, mods| Msg::Key(KeyEvent::new(code, mods));
    let none = KeyModifiers::NONE;
    let ctrl = KeyModifiers::CONTROL;
    let alt = KeyModifiers::ALT;
    let chars = "abcdefghijklmnopqrstuvwxyz jkJKgGnpvacxdfsrm123?/[]@-é💥\t";
    match r.below(100) {
        0..=34 => {
            let c = chars.chars().nth(r.below(chars.chars().count() as u64) as usize).unwrap();
            k(KeyCode::Char(c), none)
        }
        35..=59 => {
            let codes = [
                KeyCode::Enter,
                KeyCode::Esc,
                KeyCode::Tab,
                KeyCode::BackTab,
                KeyCode::Backspace,
                KeyCode::Delete,
                KeyCode::Up,
                KeyCode::Down,
                KeyCode::Left,
                KeyCode::Right,
                KeyCode::Home,
                KeyCode::End,
                KeyCode::PageUp,
                KeyCode::PageDown,
                KeyCode::F(1),
            ];
            k(codes[r.below(codes.len() as u64) as usize], none)
        }
        60..=74 => {
            let c = "pknsrobxlcjuw".chars().nth(r.below(13) as usize).unwrap();
            k(KeyCode::Char(c), ctrl)
        }
        75..=79 => k(KeyCode::Char("1233".chars().nth(r.below(4) as usize).unwrap()), alt),
        80..=81 => k(KeyCode::Enter, alt),
        82..=83 => Msg::Paste(["hello\nworld", "", "a\r\nb", "x".repeat(300).as_str()][r.below(4) as usize].into()),
        84..=85 => Msg::Scroll(r.below(13) as i32 - 6),
        86..=88 => {
            // Mostly realistic sizes, sometimes tiny or huge.
            let w = [20, 59, 60, 80, 99, 100, 120, 200][r.below(8) as usize];
            let h = [5, 15, 16, 24, 36, 60][r.below(6) as usize];
            Msg::Resize(w, h)
        }
        _ => Msg::Tick(0), // filled with the clock by the driver
    }
}

async fn run_seed(seed: u64, steps: usize) {
    let mut r = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let demo = DemoBackend::new(NOW, true);
    let mut pushes = demo.subscribe();
    let depth = [Depth::TrueColor, Depth::Ansi16, Depth::NoColor][(seed % 3) as usize];
    let variant = if seed.is_multiple_of(2) { Variant::Void } else { Variant::Paper };
    let mut app = App::new(Config { demo: true, ..Config::default() }, Theme::new(variant, depth), NOW);
    app.size = (120, 36);
    let mut clock = NOW;
    let mut cmds = app.init();
    for step in 0..steps {
        // Run pending commands and pushes (bounded, so a feedback loop shows up as a failure).
        for _ in 0..200 {
            while let Ok(p) = pushes.try_recv() {
                cmds.extend(update(&mut app, Msg::Push(p)));
            }
            let Some(c) = cmds.pop() else { break };
            if let Cmd::Rpc { tag, method, params } = c {
                let res = demo.rpc(method, params).await;
                cmds.extend(update(&mut app, Msg::Rpc(tag, res)));
            }
        }
        let mut m = random_msg(&mut r);
        if let Msg::Tick(_) = m {
            let ms = [50, 120, 1000, 5000][r.below(4) as usize];
            tokio::time::sleep(Duration::from_millis(ms)).await;
            clock += ms as i64;
            m = Msg::Tick(clock);
        }
        if let Msg::Resize(w, h) = m {
            app.size = (w, h);
        }
        cmds.extend(update(&mut app, m));
        let (w, h) = app.size;
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        view::render(&mut buf, area, &app);
        if let Some((x, y)) = view::cursor(area, &app) {
            assert!(x < w && y < h, "seed {seed} step {step}: cursor ({x},{y}) outside {w}x{h}");
        }
        if cmds.contains(&Cmd::Quit) {
            cmds.retain(|c| *c != Cmd::Quit);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn random_input_never_panics() {
    let runs: u64 = std::env::var("ORB_FUZZ_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(40);
    for seed in 1..=runs {
        let res = tokio::spawn(run_seed(seed, 400)).await;
        if let Err(e) = res {
            panic!("seed {seed} panicked: {e}");
        }
    }
}
