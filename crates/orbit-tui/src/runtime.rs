//! The impure shell: terminal setup/restore, the event loop, and running `Cmd`s against the backend.

use crate::app::{update, App, Cmd, Msg};
use crate::backend::Backend;
use crate::view;
use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    KeyboardEnhancementFlags, MouseEventKind, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn restore() {
    let mut out = io::stdout();
    let _ = execute!(out, PopKeyboardEnhancementFlags);
    let _ = execute!(out, DisableMouseCapture, DisableBracketedPaste, LeaveAlternateScreen, crossterm::cursor::Show);
    let _ = terminal::disable_raw_mode();
}

fn setup() -> io::Result<Terminal<CrosstermBackend<Stdout>>> {
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        hook(info);
    }));
    terminal::enable_raw_mode()?;
    let mut out = io::stdout();
    execute!(out, EnterAlternateScreen, EnableBracketedPaste, EnableMouseCapture)?;
    if terminal::supports_keyboard_enhancement().unwrap_or(false) {
        let _ = execute!(
            out,
            PushKeyboardEnhancementFlags(
                KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
            )
        );
    }
    Terminal::new(CrosstermBackend::new(out))
}

fn open_url(url: &str) {
    #[cfg(windows)]
    let r = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    let _ = r;
}

pub async fn run(backend: Arc<dyn Backend>, mut app: App) -> io::Result<()> {
    // Set the terminal up before anything reads input: the keyboard-enhancement probe reads
    // the terminal's reply, and a concurrent reader would steal it (and early keys).
    let mut term = setup()?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();

    // Terminal input on its own thread (crossterm's read is blocking).
    let input_tx = tx.clone();
    std::thread::spawn(move || loop {
        let msg = match event::read() {
            Ok(Event::Key(k)) => Msg::Key(k),
            Ok(Event::Paste(s)) => Msg::Paste(s),
            Ok(Event::Resize(w, h)) => Msg::Resize(w, h),
            Ok(Event::Mouse(m)) => match m.kind {
                MouseEventKind::ScrollUp => Msg::Scroll(-3),
                MouseEventKind::ScrollDown => Msg::Scroll(3),
                _ => continue,
            },
            Ok(_) => continue,
            Err(_) => break,
        };
        if input_tx.send(msg).is_err() {
            break;
        }
    });

    // Server pushes.
    let mut pushes = backend.subscribe();
    let push_tx = tx.clone();
    tokio::spawn(async move {
        while let Some(p) = pushes.recv().await {
            if push_tx.send(Msg::Push(p)).is_err() {
                break;
            }
        }
    });

    let size = term.size()?;
    app.size = (size.width, size.height);
    app.now = now_ms();
    let init = app.init();
    exec(&backend, &tx, init);

    let result = async {
        let mut dirty = true;
        loop {
            if dirty {
                term.draw(|f| {
                    view::draw(f, &app);
                    if let Some(pos) = view::cursor(f.area(), &app) {
                        f.set_cursor_position(pos);
                    }
                })?;
            }
            let wait = if app.animating() { 120 } else { 1000 };
            let msg = tokio::select! {
                m = rx.recv() => match m { Some(m) => m, None => break },
                _ = tokio::time::sleep(Duration::from_millis(wait)) => Msg::Tick(now_ms()),
            };
            let animating = app.animating();
            let is_tick = matches!(msg, Msg::Tick(_));
            if !is_tick {
                // Keep the clock current for key handling (Ctrl+C twice, chords).
                app.now = now_ms();
            }
            let before_min = app.now / 60_000;
            let cmds = update(&mut app, msg);
            // Idle ticks only redraw when something visible changed (a running sweep, a minute boundary).
            dirty = !is_tick || animating || app.animating() || before_min != app.now / 60_000 || !cmds.is_empty();
            for c in &cmds {
                match c {
                    Cmd::Quit => return Ok::<(), io::Error>(()),
                    Cmd::Redraw => term.clear()?,
                    Cmd::Open(url) => open_url(url),
                    Cmd::Save(patch) => {
                        if !app.cfg.demo {
                            crate::cli::save_settings(patch);
                        }
                    }
                    Cmd::Rpc { .. } => {}
                }
            }
            exec(&backend, &tx, cmds);
        }
        Ok(())
    }
    .await;
    restore();
    result
}

fn exec(backend: &Arc<dyn Backend>, tx: &mpsc::UnboundedSender<Msg>, cmds: Vec<Cmd>) {
    for c in cmds {
        if let Cmd::Rpc { tag, method, params } = c {
            let b = backend.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let res = b.rpc(method, params).await;
                let _ = tx.send(Msg::Rpc(tag, res));
            });
        }
    }
}
