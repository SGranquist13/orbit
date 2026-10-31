//! Inbox: full screen, grouped, one key per resolution (visual.md §3.6).

use super::{fill, put, tone_color};
use crate::app::App;
use crate::attention::{self, Group, Reason};
use crate::glyphs;
use crate::text::{pad, pad_left, truncate, width};
use orbit_proto::Status;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Span;

fn action_hint(app: &App, id: &str, reason: Option<Reason>) -> &'static str {
    let has_pr = app.prs.get(id).is_some_and(|p| p.state == "OPEN");
    match reason {
        Some(Reason::Question) => "enter reply",
        Some(Reason::ChecksFailed) => "f fix",
        Some(Reason::Checks) => "f fix CI",
        Some(Reason::NeedsSync) => "f resolve",
        Some(Reason::Changes) => "c comments",
        Some(Reason::Error) => "enter open",
        Some(Reason::Done) if !has_pr && app.ws(id).is_some_and(|w| w.ahead > 0) => "s ship",
        _ if app.prs.get(id).is_some_and(|p| p.state == "MERGED") => "enter open",
        _ if has_pr => "s ship",
        _ if app.ws(id).is_some_and(|w| w.ahead > 0 && w.status != Status::Running) => "s ship",
        _ => "enter open",
    }
}

pub fn render(buf: &mut Buffer, area: Rect, app: &App) {
    let t = &app.theme;
    let x = area.x + 2;
    let w = area.width.saturating_sub(4) as usize;
    let (need, run, done) = app.counts();
    let need_label = if need == 1 { "needs you" } else { "need you" };
    put(
        buf,
        x,
        area.y,
        w,
        &[
            Span::styled("Inbox", t.bold()),
            Span::styled(format!("{s}{need} {need_label}{s}{run} running{s}{done} done", s = glyphs::SEP), t.mute()),
        ],
    );
    let fleet = app.fleet();
    if fleet.is_empty() {
        buf.set_string(x, area.y + 2, "Nothing here yet. Start a workspace in Orbit.", t.mute());
        return;
    }
    // Column widths: dot 1 · name 16 · reason flex · age 5 · 3 · hint 14.
    let name_w = 16;
    let hint_w = 14;
    let age_w = 5;
    let reason_w = w.saturating_sub(2 + name_w + 1 + age_w + 3 + hint_w);
    let mut lines: Vec<(Option<usize>, Option<Group>, bool)> = Vec::new(); // (row, label, suggestions)
    let mut last = None;
    for (i, r) in fleet.iter().enumerate() {
        if last != Some(r.group) {
            if last.is_some() {
                lines.push((None, None, false));
            }
            lines.push((None, Some(r.group), false));
            last = Some(r.group);
        }
        lines.push((Some(i), None, false));
        if i == app.inbox_sel && !app.suggestions(r).is_empty() {
            lines.push((Some(i), None, true));
        }
    }
    let top = area.y + 2;
    let h = area.height.saturating_sub(2) as usize;
    let sel_line = lines.iter().position(|l| l.0 == Some(app.inbox_sel) && !l.2).unwrap_or(0);
    let skip = (sel_line + 2).saturating_sub(h);
    for (n, (row, label, sugg)) in lines.iter().skip(skip).take(h).enumerate() {
        let y = top + n as u16;
        if let Some(g) = label {
            buf.set_string(x, y, g.label(), t.mute());
            continue;
        }
        let Some(i) = row else { continue };
        let r = &fleet[*i];
        let Some(ws) = app.ws(&r.id) else { continue };
        let sel = *i == app.inbox_sel;
        if *sugg {
            let mut spans = vec![Span::raw(" ".repeat(2 + name_w + 1))];
            for (k, s) in app.suggestions(r).iter().enumerate() {
                if k > 0 {
                    spans.push(Span::raw("   "));
                }
                spans.push(Span::styled(format!("{}", k + 1), t.dim()));
                spans.push(Span::styled(format!(" {}", s.label()), t.mute()));
            }
            fill(buf, Rect { x: area.x, y, width: area.width, height: 1 }, t.sel());
            put(buf, x, y, w, &spans);
            continue;
        }
        if sel {
            fill(buf, Rect { x: area.x, y, width: area.width, height: 1 }, t.sel());
        }
        let detail = app.row_detail(r);
        let ts = app.summaries.get(&ws.id).map(|s| s.last_activity_ts).unwrap_or(ws.updated_at);
        let age = if ws.status == Status::Running { String::new() } else { attention::time_ago(ts, app.now) };
        let name_style = if sel {
            t.bold()
        } else if r.group == Group::Done {
            t.dim()
        } else {
            t.fg()
        };
        let mut spans = vec![
            Span::styled(glyphs::DOT, Style::new().fg(tone_color(t, r.tone))),
            Span::raw(" "),
            Span::styled(pad(&ws.name, name_w), name_style),
            Span::raw(" "),
            Span::styled(pad(&detail, reason_w), if sel { t.fg() } else { t.dim() }),
            Span::styled(pad_left(&age, age_w), t.mute()),
        ];
        if sel {
            spans.push(Span::raw("   "));
            spans.push(Span::styled(truncate(action_hint(app, &ws.id, r.reason), hint_w), t.mute()));
        }
        let _ = width("");
        put(buf, x, y, w, &spans);
    }
}
