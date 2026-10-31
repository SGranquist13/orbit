//! Overlays: Skills popup, Ship, the Ctrl+K switcher and confirmations (visual.md §3.7).

use super::{chat, fill, put, split_row, tone_color};
use crate::app::{App, Overlay, ShipPhase, Side, RAIL_W};
use crate::glyphs;
use crate::text::{pad, truncate, width};
use crate::theme::Theme;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Span;

/// The main pane's rectangle in Chat (without the rail).
fn main_rect(area: Rect, app: &App) -> Rect {
    let body = Rect { height: area.height - 1, ..area };
    if !app.rail_visible() {
        return body;
    }
    match app.cfg.rail_side {
        Side::Left => Rect { x: body.x + RAIL_W + 1, width: body.width - RAIL_W - 1, ..body },
        Side::Right => Rect { width: body.width - RAIL_W - 1, ..body },
    }
}

pub fn cursor(area: Rect, app: &App) -> Option<(u16, u16)> {
    if app.screen != crate::app::Screen::Chat {
        return None;
    }
    chat::cursor_pos(app, main_rect(area, app))
}

/// A bordered box on `panel` with a title in the top border and an optional hint in the bottom one.
/// Clears the rows a box sits on (plus one above and below) across `pane`, so the text underneath
/// doesn't crowd its border.
fn halo(buf: &mut Buffer, r: Rect, pane: Rect, below: bool) {
    let y0 = r.y.saturating_sub(1).max(pane.y);
    let y1 = (r.y + r.height + u16::from(below)).min(pane.y + pane.height);
    fill(buf, Rect { x: pane.x, y: y0, width: pane.width, height: y1 - y0 }, Style::reset());
}

fn frame(buf: &mut Buffer, r: Rect, t: &Theme, title: &[Span], hint: &str) {
    fill(buf, r, t.panel_bg());
    let b = glyphs::BORDER;
    let st = Style::new().fg(t.line_strong).patch(t.panel_bg());
    let right = r.x + r.width - 1;
    let bottom = r.y + r.height - 1;
    for x in r.x + 1..right {
        buf.set_string(x, r.y, b.horizontal_top, st);
        buf.set_string(x, bottom, b.horizontal_bottom, st);
    }
    for y in r.y + 1..bottom {
        buf.set_string(r.x, y, b.vertical_left, st);
        buf.set_string(right, y, b.vertical_right, st);
    }
    buf.set_string(r.x, r.y, b.top_left, st);
    buf.set_string(right, r.y, b.top_right, st);
    buf.set_string(r.x, bottom, b.bottom_left, st);
    buf.set_string(right, bottom, b.bottom_right, st);
    if !title.is_empty() {
        let mut spans = vec![Span::styled(" ", st)];
        spans.extend(title.iter().map(|s| Span::styled(s.content.clone(), s.style.patch(t.panel_bg()))));
        spans.push(Span::styled(" ", st));
        put(buf, r.x + 2, r.y, r.width.saturating_sub(4) as usize, &spans);
    }
    if !hint.is_empty() {
        let s = format!(" {hint} ");
        let w = width(&s) as u16;
        if w + 4 < r.width {
            buf.set_string(r.x + r.width - 2 - w, bottom, &s, t.mute().patch(t.panel_bg()));
        }
    }
}

pub fn render(buf: &mut Buffer, full: Rect, app: &App) {
    let t = &app.theme;
    if app.skill_query().is_some() && app.overlay.is_none() {
        skills(buf, full, app);
    }
    // Boxes centre on the main pane, so the rail stays readable beside them.
    let area = if app.screen == crate::app::Screen::Chat {
        Rect { height: full.height, ..main_rect(full, app) }
    } else {
        full
    };
    match &app.overlay {
        None => {}
        Some(Overlay::Ship) => ship(buf, area, app),
        Some(Overlay::Switcher { query, sel }) => {
            let w = (area.width.saturating_sub(8)).min(72);
            let items = app.switcher_matches(query);
            let shown = items.len().min(12);
            let h = shown as u16 + 4;
            let r = Rect { x: area.x + (area.width - w) / 2, y: area.y + 3, width: w, height: h.min(area.height - 4) };
            halo(buf, r, area, true);
            frame(buf, r, t, &[Span::styled("Switch workspace", t.fg())], "enter open · esc close");
            let iw = (w - 4) as usize;
            put(buf, r.x + 2, r.y + 1, iw, &[Span::styled("> ", t.mute()), Span::styled(query.clone(), t.fg())]);
            let skip = (*sel + 1).saturating_sub(shown);
            for (i, row) in items.iter().enumerate().skip(skip).take(shown) {
                let y = r.y + 2 + (i - skip) as u16;
                let Some(ws) = app.ws(&row.id) else { continue };
                if i == *sel {
                    fill(buf, Rect { x: r.x + 1, y, width: w - 2, height: 1 }, t.sel());
                }
                let detail = app.row_detail(row);
                let spans = [
                    Span::styled(glyphs::DOT, Style::new().fg(tone_color(t, row.tone))),
                    Span::raw(" "),
                    Span::styled(pad(&ws.name, 22), if i == *sel { t.bold() } else { t.fg() }),
                    Span::styled(truncate(&detail, iw.saturating_sub(25)), t.mute()),
                ];
                put(buf, r.x + 2, y, iw, &spans);
            }
            if items.is_empty() {
                buf.set_string(r.x + 2, r.y + 2, "No matches", t.mute().patch(t.panel_bg()));
            }
        }
        Some(Overlay::Confirm { prompt, action }) => {
            let over_ship = matches!(action, crate::app::ConfirmAction::Merge { .. });
            if over_ship {
                ship(buf, area, app);
            }
            let w = (width(prompt) as u16 + 8).clamp(36, area.width.saturating_sub(8));
            let r = Rect { x: area.x + (area.width - w) / 2, y: area.y + area.height / 2 - 2, width: w, height: 3 };
            if !over_ship {
                halo(buf, r, area, true);
            }
            frame(buf, r, t, &[], "y yes · n no");
            put(buf, r.x + 2, r.y + 1, (w - 4) as usize, &[Span::styled(prompt.clone(), t.fg())]);
        }
    }
}

fn skills(buf: &mut Buffer, area: Rect, app: &App) {
    let t = &app.theme;
    let main = main_rect(area, app);
    let items = app.skill_matches();
    let shown = items.len().clamp(1, 8);
    let w = main.width.saturating_sub(4).min(72);
    let h = shown as u16 + 2;
    // Anchored just above the input (input = 1 text row + chips row, at the bottom of main).
    let input_rows = if app.size.0 >= 80 { 2 } else { 1 };
    let bottom = main.y + main.height - input_rows;
    let r = Rect { x: main.x + 2, y: bottom.saturating_sub(h), width: w, height: h };
    let packs: Vec<&str> = {
        let mut p: Vec<&str> = app.skills.iter().map(|s| s.pack.as_str()).collect();
        p.dedup();
        p
    };
    let title = format!("skills{}{}", glyphs::SEP, packs.join(", "));
    halo(buf, r, Rect { height: main.height - input_rows, ..main }, false);
    frame(buf, r, t, &[Span::styled(title, t.mute())], "tab complete · enter run");
    let iw = (w - 4) as usize;
    let skip = (app.skills_sel + 1).saturating_sub(shown);
    for (i, s) in items.iter().enumerate().skip(skip).take(shown) {
        let y = r.y + 1 + (i - skip) as u16;
        let sel = i == app.skills_sel;
        if sel {
            fill(buf, Rect { x: r.x + 1, y, width: w - 2, height: 1 }, t.sel());
        }
        let id_style = if sel { t.bold() } else { t.fg() };
        put(
            buf,
            r.x + 2,
            y,
            iw,
            &[
                Span::styled(pad(&s.id, 28), id_style),
                Span::styled(truncate(&s.description, iw.saturating_sub(28)), t.mute()),
            ],
        );
    }
    if items.is_empty() {
        buf.set_string(r.x + 2, r.y + 1, "No matching skills", t.mute().patch(t.panel_bg()));
    }
}

fn ship(buf: &mut Buffer, area: Rect, app: &App) {
    let t = &app.theme;
    let Some(ws) = app.cur_ws() else { return };
    let st = app.ship.get(&ws.id);
    let pr = app.prs.get(&ws.id);
    let base = app.base_branch(ws);
    let w = area.width.saturating_sub(8).min(80);
    let iw = (w - 4) as usize;
    let sweep = glyphs::sweep(app.tick, app.cfg.motion);

    // Content rows first, then size the box to them.
    let mut rows: Vec<Vec<Span<'static>>> = vec![vec![]];
    let phase = st.map(|s| s.phase.clone()).unwrap_or(if pr.is_some() { ShipPhase::Pr } else { ShipPhase::Gate });
    let order = |p: &ShipPhase| match p {
        ShipPhase::Gate | ShipPhase::GateFailed => 0,
        ShipPhase::Agent => 2,
        ShipPhase::WaitPr => 3,
        ShipPhase::Failed(_) => 2,
        _ => 4,
    };
    let at = order(&phase);
    let mark = |i: usize, failed: bool| -> Span<'static> {
        if failed {
            Span::styled(format!("{}  ", glyphs::ERR), t.hue(t.bad))
        } else if i < at {
            Span::styled(format!("{}  ", glyphs::PASS), t.hue(t.ok))
        } else if i == at && !matches!(phase, ShipPhase::GateFailed | ShipPhase::Failed(_)) {
            Span::styled(sweep.to_string(), t.hue(t.run))
        } else {
            Span::styled(format!("{}  ", glyphs::PENDING), t.mute())
        }
    };
    let checks = st.and_then(|s| s.checks.clone());
    let check_detail = match &checks {
        Some(c) if c.ok => c.command.clone(),
        Some(c) => format!("{} · {}", c.command, if c.kind == "timedOut" { "timed out" } else { "failed" }),
        None if at > 0 => "skipped".into(),
        None => "running checks…".into(),
    };
    let squash_detail = match st.map(|s| s.squashed) {
        _ if at < 1 => String::new(),
        Some(0) | None => "nothing to squash".into(),
        Some(n) => format!("{n} save point{} → 1 commit", if n == 1 { "" } else { "s" }),
    };
    let agent_detail = match &phase {
        ShipPhase::Agent => st.and_then(|s| s.last_tool.clone()).unwrap_or_else(|| "/shipkit:ship".into()),
        ShipPhase::Failed(e) => e.clone(),
        _ if at > 2 => "pushed".into(),
        _ => String::new(),
    };
    let pr_detail = match (&phase, pr) {
        (ShipPhase::WaitPr, _) => "waiting for the pull request…".into(),
        (_, Some(p)) => format!("#{} {}", p.number, p.title),
        _ => String::new(),
    };
    let failed_gate = phase == ShipPhase::GateFailed;
    let failed_agent = matches!(phase, ShipPhase::Failed(_));
    let steps: [(&str, String, bool, usize); 4] = [
        ("Checks", check_detail, failed_gate, 0),
        ("Squash save points", squash_detail, false, 1),
        ("Ship (agent)", agent_detail, failed_agent, 2),
        ("Pull request", pr_detail, false, 3),
    ];
    for (label, detail, failed, i) in steps {
        let active = i <= at || failed;
        let mut m = mark(i, failed);
        if i == 1 && at == 0 {
            m = Span::styled(format!("{}  ", glyphs::PENDING), t.mute());
        }
        rows.push(vec![
            m,
            Span::raw(" "),
            Span::styled(pad(label, 20), if active { t.fg() } else { t.mute() }),
            Span::styled(truncate(&detail, iw.saturating_sub(24)), t.mute()),
        ]);
    }
    rows.push(vec![]);
    let mut hint = "esc close".to_string();
    match &phase {
        ShipPhase::GateFailed => {
            if let Some(c) = &checks {
                let lines: Vec<&str> = c.output_tail.lines().collect();
                for l in lines.iter().skip(lines.len().saturating_sub(12)) {
                    rows.push(vec![Span::styled(format!("    {}", truncate(l, iw - 4)), t.dim())]);
                }
                rows.push(vec![]);
            }
            rows.push(vec![
                Span::styled(format!("{} ", glyphs::ERR), t.hue(t.bad)),
                Span::styled("Checks failed.", t.fg()),
            ]);
            hint = "a ship anyway · f fix · esc close".into();
        }
        ShipPhase::Failed(_) => {
            rows.push(vec![
                Span::styled(format!("{} ", glyphs::ERR), t.hue(t.bad)),
                Span::styled("Ship stopped.", t.fg()),
            ]);
        }
        ShipPhase::Merged { archived } => {
            let p = pr.map(|p| format!("#{} ", p.number)).unwrap_or_default();
            rows.push(vec![
                Span::styled(format!("{} ", glyphs::DOT), t.hue(t.merged)),
                Span::styled(format!("Merged {p}into {base}"), t.fg()),
                Span::styled(if *archived { " · workspace archived" } else { "" }.to_string(), t.mute()),
            ]);
        }
        _ => {}
    }
    if let (Some(p), true) = (pr, matches!(phase, ShipPhase::Pr | ShipPhase::Merging)) {
        let mut state = match p.state.as_str() {
            "OPEN" if p.is_draft => "draft".to_string(),
            s => s.to_lowercase(),
        };
        match p.review_decision.as_str() {
            "APPROVED" => state.push_str(" · approved"),
            "CHANGES_REQUESTED" => state.push_str(" · changes requested"),
            "REVIEW_REQUIRED" => state.push_str(" · review required"),
            _ => {}
        }
        rows.push(vec![
            Span::styled(format!("pull request #{}", p.number), t.mute()),
            Span::styled(format!("{}{state}", glyphs::SEP), t.mute()),
        ]);
        let c = &p.checks;
        rows.push(vec![
            Span::styled(glyphs::PASS, t.hue(t.ok)),
            Span::styled(format!(" {} passed   ", c.passed), t.dim()),
            Span::styled(glyphs::ERR, if c.failed > 0 { t.hue(t.bad) } else { t.mute() }),
            Span::styled(format!(" {} failed   ", c.failed), t.dim()),
            Span::styled(glyphs::PENDING, t.mute()),
            Span::styled(format!(" {} pending", c.pending), t.dim()),
        ]);
        for name in c.failing.iter().take(4) {
            rows.push(vec![Span::styled(format!("  {} {}", glyphs::ERR, truncate(name, iw - 4)), t.hue(t.bad))]);
        }
        rows.push(vec![]);
        let mergeable = p.state == "OPEN" && p.mergeable == "MERGEABLE" && c.failed == 0;
        if phase == ShipPhase::Merging {
            rows.push(vec![Span::styled(sweep.to_string(), t.hue(t.run)), Span::styled(" Merging…", t.fg())]);
        } else if mergeable && c.pending == 0 {
            rows.push(vec![Span::styled("Ready to merge.", t.hue(t.ok))]);
        } else if c.failed > 0 {
            rows.push(vec![Span::styled("Checks are failing.", t.hue(t.bad))]);
        } else if c.pending > 0 {
            rows.push(vec![Span::styled("Waiting for checks…", t.mute())]);
        } else if p.mergeable == "CONFLICTING" {
            rows.push(vec![Span::styled("Conflicts with the base branch.", t.hue(t.warn))]);
        }
        hint = if mergeable {
            "m merge · f fix CI · c comments · o open · esc"
        } else {
            "f fix CI · c comments · o open · r refresh · esc"
        }
        .into();
    }
    while rows.last().is_some_and(|r| r.is_empty()) {
        rows.pop();
    }
    rows.push(vec![]);
    let h = (rows.len() as u16 + 2).min(area.height.saturating_sub(6));
    let r =
        Rect { x: area.x + (area.width - w) / 2, y: area.y + (area.height.saturating_sub(h)) / 3, width: w, height: h };
    let title = [Span::styled("Ship", t.fg()), Span::styled(format!("{}{} → {base}", glyphs::SEP, ws.name), t.mute())];
    halo(buf, r, area, true);
    frame(buf, r, t, &title, &hint);
    for (i, row) in rows.iter().take((h - 2) as usize).enumerate() {
        let spans: Vec<Span> =
            row.iter().map(|s| Span::styled(s.content.clone(), s.style.patch(t.panel_bg()))).collect();
        split_row(buf, r.x + 2, r.y + 1 + i as u16, iw, &spans, &[]);
    }
}
