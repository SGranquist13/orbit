//! Pure rendering: `draw(frame, app)` reads `App` and paints. No I/O, no clock.

mod chat;
mod inbox;
mod overlay;

pub use overlay::cursor;
mod review;

use crate::app::{App, Focus, Screen, Side, MIN_H, MIN_W, RAIL_W};
use crate::attention::Tone;
use crate::glyphs;
use crate::text::{truncate, width};
use crate::theme::Theme;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::Frame;

pub fn draw(f: &mut Frame, app: &App) {
    let area = f.area();
    let buf = f.buffer_mut();
    render(buf, area, app);
}

/// Renders the whole UI into `buf` (used directly by the screen snapshots).
pub fn render(buf: &mut Buffer, area: Rect, app: &App) {
    let t = &app.theme;
    if area.width < MIN_W || area.height < MIN_H {
        let msg = format!("Orbit needs at least {MIN_W}×{MIN_H}");
        let x = area.x + area.width.saturating_sub(width(&msg) as u16) / 2;
        buf.set_stringn(x, area.y + area.height / 2, &msg, area.width as usize, t.mute());
        return;
    }
    let body = Rect { height: area.height - 1, ..area };
    let footer = Rect { y: area.y + area.height - 1, height: 1, ..area };
    match app.screen {
        Screen::Chat => {
            let main = if app.rail_visible() {
                let (rail, divider, main) = match app.cfg.rail_side {
                    Side::Left => (
                        Rect { width: RAIL_W, ..body },
                        Rect { x: body.x + RAIL_W, width: 1, ..body },
                        Rect { x: body.x + RAIL_W + 1, width: body.width - RAIL_W - 1, ..body },
                    ),
                    Side::Right => (
                        Rect { x: body.x + body.width - RAIL_W, width: RAIL_W, ..body },
                        Rect { x: body.x + body.width - RAIL_W - 1, width: 1, ..body },
                        Rect { width: body.width - RAIL_W - 1, ..body },
                    ),
                };
                chat::rail(buf, rail, app);
                for y in divider.y..divider.y + divider.height {
                    buf.set_string(divider.x, y, "│", Style::new().fg(t.line));
                }
                main
            } else {
                body
            };
            chat::main(buf, main, app);
            let fmain = Rect { x: main.x, width: main.width, ..footer };
            footer_line(buf, fmain, app);
            if app.rail_visible() {
                // The rail's own hint sits on the footer row, under the rail.
                let r = match app.cfg.rail_side {
                    Side::Left => Rect { width: RAIL_W, ..footer },
                    Side::Right => Rect { x: footer.x + footer.width - RAIL_W, width: RAIL_W, ..footer },
                };
                buf.set_string(r.x + 1, r.y, "alt+2 inbox · ctrl+k switch", t.mute());
                let d = match app.cfg.rail_side {
                    Side::Left => footer.x + RAIL_W,
                    Side::Right => footer.x + footer.width - RAIL_W - 1,
                };
                buf.set_string(d, footer.y, "│", Style::new().fg(t.line));
            }
        }
        Screen::Inbox => {
            inbox::render(buf, body, app);
            footer_line(buf, footer, app);
        }
        Screen::Review => {
            review::render(buf, body, app);
            footer_line(buf, footer, app);
        }
    }
    overlay::render(buf, area, app);
}

/// Hints (`key label` pairs) or the transient status, two cells in.
fn footer_line(buf: &mut Buffer, area: Rect, app: &App) {
    let t = &app.theme;
    let x = area.x + 2;
    let w = area.width.saturating_sub(4) as usize;
    if app.quit_armed > app.now {
        buf.set_stringn(x, area.y, "Press Ctrl+C again to quit", w, t.fg());
        return;
    }
    if app.chord > app.now {
        let hints = [("ctrl+x", "…"), ("1", "chat"), ("2", "inbox"), ("3", "review"), ("s", "ship"), ("q", "quit")];
        put(buf, x, area.y, w, &hint_spans(t, &hints, w));
        return;
    }
    if let Some(s) = &app.status {
        let spans = if s.error {
            vec![Span::styled(format!("{} ", glyphs::ERR), t.hue(t.bad)), Span::styled(s.text.clone(), t.fg())]
        } else {
            vec![Span::styled(s.text.clone(), t.fg())]
        };
        put(buf, x, area.y, w, &spans);
        return;
    }
    let running = app.current.as_deref().is_some_and(|c| app.is_running(c));
    let mut hints: Vec<(&str, &str)> = match app.screen {
        Screen::Chat => match app.focus {
            Focus::Input if app.skill_query().is_some() => {
                vec![("↑↓", "choose"), ("tab", "complete"), ("enter", "run"), ("esc", "close")]
            }
            Focus::Input => {
                let mut h = vec![("enter", "send")];
                if running {
                    h.push(("esc", "stop"));
                }
                h.extend([("/", "skills"), ("tab", "focus"), ("ctrl+s", "ship"), ("alt+3", "review")]);
                h
            }
            Focus::Rail => vec![("j/k", "move"), ("enter", "open"), ("d", "dismiss"), ("esc", "back")],
            Focus::Transcript => vec![("j/k", "move"), ("enter", "expand"), ("g/G", "first/last"), ("esc", "back")],
        },
        Screen::Inbox => {
            vec![("j/k", "move"), ("enter", "open"), ("s", "ship"), ("f", "fix"), ("d", "dismiss"), ("esc", "back")]
        }
        Screen::Review => {
            let commenting = app.review.as_ref().is_some_and(|r| r.commenting.is_some());
            if commenting {
                vec![("enter", "save"), ("esc", "cancel")]
            } else {
                vec![
                    ("j/k", "line"),
                    ("]/[", "file"),
                    ("c", "comment"),
                    ("v", "scope"),
                    ("a", "accept"),
                    ("tab", "files"),
                ]
            }
        }
    };
    if app.screen == Screen::Chat && app.current.is_none() {
        hints = vec![("alt+2", "inbox"), ("ctrl+k", "switch"), ("ctrl+c", "quit")];
    }
    let mut spans = hint_spans(t, &hints, w);
    // Review: the draft count sits at the right edge.
    if app.screen == Screen::Review {
        if let Some(r) = &app.review {
            let n = app.drafts.get(&r.ws).map(|d| d.len()).unwrap_or(0);
            if n > 0 {
                let tail = format!("{n} comment{} · enter send", if n == 1 { "" } else { "s" });
                let used: usize = spans.iter().map(|s| width(&s.content)).sum();
                let room = w.saturating_sub(used);
                if room > width(&tail) + 3 {
                    spans.push(Span::raw(" ".repeat(room - width(&tail))));
                    spans.push(Span::styled(tail, t.fg()));
                }
            }
        }
    }
    put(buf, x, area.y, w, &spans);
}

fn hint_spans(t: &Theme, hints: &[(&str, &str)], max: usize) -> Vec<Span<'static>> {
    let mut out = Vec::new();
    let mut used = 0;
    for (i, (k, l)) in hints.iter().take(6).enumerate() {
        let sep = if i == 0 { 0 } else { 3 };
        let w = sep + width(k) + 1 + width(l);
        if used + w > max {
            break;
        }
        if sep > 0 {
            out.push(Span::raw("   "));
        }
        out.push(Span::styled(k.to_string(), t.dim()));
        out.push(Span::styled(format!(" {l}"), t.mute()));
        used += w;
    }
    out
}

// ---- small paint helpers

/// Writes spans at (x, y), clipped to `max` cells. Returns the cells used.
pub fn put(buf: &mut Buffer, x: u16, y: u16, max: usize, spans: &[Span]) -> usize {
    let mut cx = x;
    let mut left = max;
    for s in spans {
        if left == 0 {
            break;
        }
        let (nx, _) = buf.set_stringn(cx, y, s.content.as_ref(), left, s.style);
        let used = (nx - cx) as usize;
        left = left.saturating_sub(used);
        cx = nx;
    }
    max - left
}

pub fn put_line(buf: &mut Buffer, x: u16, y: u16, max: usize, line: &Line) -> usize {
    let spans: Vec<Span> =
        line.spans.iter().map(|s| Span::styled(s.content.clone(), line.style.patch(s.style))).collect();
    put(buf, x, y, max, &spans)
}

pub fn fill(buf: &mut Buffer, area: Rect, style: Style) {
    for y in area.y..area.y + area.height {
        for x in area.x..area.x + area.width {
            if let Some(c) = buf.cell_mut((x, y)) {
                c.set_symbol(" ");
                c.set_style(style);
            }
        }
    }
}

/// Paints a style over cells without changing their text (e.g. the selected row).
pub fn tint(buf: &mut Buffer, area: Rect, style: Style) {
    for y in area.y..area.y + area.height {
        for x in area.x..area.x + area.width {
            if let Some(c) = buf.cell_mut((x, y)) {
                c.set_style(c.style().patch(style));
            }
        }
    }
}

pub fn tone_color(t: &Theme, tone: Tone) -> Color {
    match tone {
        Tone::Bad => t.bad,
        Tone::Info => t.info,
        Tone::Warn => t.warn,
        Tone::Ok => t.ok,
        Tone::Run => t.run,
        Tone::Merged => t.merged,
        Tone::Mute => t.mute,
    }
}

/// Left text plus right-aligned text on one row; the left side truncates first.
pub fn split_row(buf: &mut Buffer, x: u16, y: u16, w: usize, left: &[Span], right: &[Span]) {
    let rw: usize = right.iter().map(|s| width(&s.content)).sum();
    let lw = w.saturating_sub(if rw > 0 { rw + 2 } else { 0 });
    put(buf, x, y, lw, left);
    if rw > 0 && rw < w {
        put(buf, x + (w - rw) as u16, y, rw, right);
    }
}

pub fn trunc_span(s: &str, max: usize, style: Style) -> Span<'static> {
    Span::styled(truncate(s, max), style)
}
