//! Chat: fleet rail, header, transcript, input (visual.md §3.1–§3.5).

use super::{fill, put, put_line, split_row, tone_color, trunc_span};
use crate::app::{App, Focus, WsData};
use crate::attention::Group;
use crate::glyphs;
use crate::markdown;
use crate::text::{first_line, truncate, width, wrap};
use crate::theme::Theme;
use crate::transcript::{self, Block, ToolKind};
use orbit_proto::Status;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};

pub fn rail(buf: &mut Buffer, area: Rect, app: &App) {
    let t = &app.theme;
    let x = area.x + 1;
    let w = area.width.saturating_sub(2) as usize;
    let (_, running, _) = app.counts();
    let right = if running > 0 { vec![Span::styled(format!("{running} running"), t.mute())] } else { vec![] };
    split_row(buf, x, area.y, w, &[Span::styled("orbit", t.bold())], &right);

    let fleet = app.fleet();
    // Rows: (label | workspace index)
    let mut rows: Vec<Option<usize>> = Vec::new();
    let mut labels: Vec<Option<Group>> = Vec::new();
    let mut last: Option<Group> = None;
    for (i, r) in fleet.iter().enumerate() {
        if last != Some(r.group) {
            if last.is_some() {
                rows.push(None);
                labels.push(None);
            }
            rows.push(None);
            labels.push(Some(r.group));
            last = Some(r.group);
        }
        rows.push(Some(i));
        labels.push(None);
    }
    let top = area.y + 2;
    let avail = area.height.saturating_sub(2) as usize;
    // Keep the selection visible.
    let sel = if app.focus == Focus::Rail { Some(app.rail_sel) } else { None };
    let sel_row = sel.and_then(|s| rows.iter().position(|r| *r == Some(s))).unwrap_or(0);
    let skip = (sel_row + 1).saturating_sub(avail);
    for (n, (row, label)) in rows.iter().zip(labels.iter()).skip(skip).take(avail).enumerate() {
        let y = top + n as u16;
        if let Some(g) = label {
            buf.set_string(x, y, g.label(), t.mute());
        }
        let Some(i) = row else { continue };
        let r = &fleet[*i];
        let Some(ws) = app.ws(&r.id) else { continue };
        let is_cur = app.current.as_deref() == Some(r.id.as_str());
        let is_sel = sel == Some(*i);
        let name_style = if is_cur || is_sel {
            t.bold()
        } else if r.group == Group::Done && r.reason.is_none() {
            t.dim()
        } else {
            t.fg()
        };
        let spans = vec![
            Span::styled(glyphs::DOT, Style::new().fg(tone_color(t, r.tone))),
            Span::raw(" "),
            trunc_span(&ws.name, 26, name_style),
        ];
        if is_sel || (is_cur && sel.is_none()) {
            fill(buf, Rect { x: area.x, y, width: area.width, height: 1 }, t.sel());
        }
        put(buf, x, y, w, &spans);
    }
    if fleet.is_empty() {
        buf.set_string(x, top, "no workspaces", t.mute());
    }
}

pub fn main(buf: &mut Buffer, area: Rect, app: &App) {
    let t = &app.theme;
    let Some(ws) = app.cur_ws() else {
        let msg = if app.started {
            "No workspace open. alt+2 for the Inbox, ctrl+k to switch."
        } else {
            "Connecting to Orbit…"
        };
        let y = area.y + area.height / 2;
        let x = area.x + area.width.saturating_sub(width(msg) as u16) / 2;
        buf.set_stringn(x, y, msg, area.width as usize, t.mute());
        return;
    };
    let empty = WsData::default();
    let data = app.data.get(&ws.id).unwrap_or(&empty);
    let running = ws.status == Status::Running;
    let x = area.x + 2;
    let cw = area.width.saturating_sub(4) as usize;

    // Header.
    let mut left = Vec::new();
    if running {
        left.push(Span::styled(glyphs::sweep(app.tick, app.cfg.motion), t.hue(t.run)));
        left.push(Span::raw(" "));
    }
    left.push(Span::styled(ws.name.clone(), t.bold()));
    let model = ws.model.clone().unwrap_or_default();
    let agent_model = if model.is_empty() { ws.agent.clone() } else { format!("{} {}", ws.agent, model) };
    let mut right = Vec::new();
    if !app.connected {
        right.push(Span::styled(format!("{} reconnecting…", glyphs::DOT), t.hue(t.warn)));
    } else if let Some((tokens, window)) = data.context() {
        right.push(Span::styled(transcript::format_tokens(tokens), t.mute()));
        if let Some(w) = window.filter(|w| *w > 0) {
            right.push(Span::styled(format!("  {}%", tokens * 100 / w), t.mute()));
        }
    }
    let rw: usize = right.iter().map(|s| width(&s.content)).sum();
    let room = cw.saturating_sub(rw + 2);
    let base: usize = left.iter().map(|s| width(&s.content)).sum();
    // Drop branch, then model, as room runs out.
    let full = format!("{}{}{}{}", glyphs::SEP, agent_model, glyphs::SEP, ws.branch);
    let mid = format!("{}{}", glyphs::SEP, agent_model);
    let short = format!("{}{}", glyphs::SEP, ws.agent);
    for cand in [full, mid, short] {
        if base + width(&cand) <= room {
            left.push(Span::styled(cand, t.mute()));
            break;
        }
    }
    split_row(buf, x, area.y, cw, &left, &right);

    // Input (bottom), then transcript in between.
    let (input_lines, chips) = input_rows(app, ws.name.as_str(), running, cw);
    let input_h = (input_lines.len() + usize::from(chips.is_some())) as u16;
    let input_y = area.y + area.height - input_h;
    let ia = Rect { x: area.x, y: input_y, width: area.width, height: input_h };
    fill(buf, ia, t.raised_bg());
    let bar_style = if app.focus == Focus::Input { t.fg() } else { Style::new().fg(t.line_strong) };
    for (i, l) in input_lines.iter().enumerate() {
        let y = input_y + i as u16;
        buf.set_string(area.x, y, glyphs::BAR, bar_style.patch(t.raised_bg()));
        put_line(buf, x, y, cw, l);
    }
    if let Some(chips) = chips {
        let y = input_y + input_lines.len() as u16;
        buf.set_string(area.x, y, glyphs::BAR, bar_style.patch(t.raised_bg()));
        split_row(buf, x, y, cw, &chips.0, &chips.1);
    }

    let tr = Rect { x: area.x, y: area.y + 2, width: area.width, height: input_y.saturating_sub(area.y + 3) };
    transcript_area(buf, tr, app, data, running);
}

type Chips = (Vec<Span<'static>>, Vec<Span<'static>>);

/// The input's text rows (styled, cursor drawn by the terminal) and the chips row.
fn input_rows(app: &App, name: &str, running: bool, cw: usize) -> (Vec<Line<'static>>, Option<Chips>) {
    let t = &app.theme;
    let bg = t.raised_bg();
    let mut lines: Vec<Line> = if app.input.is_empty() {
        let ph =
            if running { format!("Message {name} (sends after this turn)…") } else { format!("Message {name}…") };
        vec![Line::from(Span::styled(truncate(&ph, cw), t.mute().patch(bg)))]
    } else {
        wrap(&app.input, cw).into_iter().map(|l| Line::from(Span::styled(l, t.fg().patch(bg)))).collect()
    };
    if lines.len() > 8 {
        // Scroll to keep the cursor's line visible.
        let before = wrap(&app.input[..app.cursor.min(app.input.len())], cw).len();
        let start = before.saturating_sub(8).min(lines.len() - 8);
        lines = lines[start..start + 8].to_vec();
    }
    let show_chips = lines.len() > 1 || app.size.0 >= 80;
    let chips = show_chips.then(|| {
        let mut l = Vec::new();
        for (i, p) in app.cfg.pinned.iter().enumerate() {
            if i > 0 {
                l.push(Span::styled(" ", bg));
            }
            let short = p.rsplit(':').next().unwrap_or(p);
            l.push(Span::styled(format!("[{short}]"), t.dim().patch(bg)));
        }
        let profile = app
            .cur_ws()
            .and_then(|w| w.profile.clone())
            .map(|p| p.rsplit(':').next().unwrap_or(&p).to_string())
            .unwrap_or_else(|| "builder".into());
        (l, vec![Span::styled(profile, t.mute().patch(bg))])
    });
    (lines, chips)
}

/// Where the terminal cursor goes for the input (x, y), if it's focused.
pub fn cursor_pos(app: &App, area: Rect) -> Option<(u16, u16)> {
    if app.focus != Focus::Input || app.cur_ws().is_none() || app.overlay.is_some() {
        return None;
    }
    let cw = area.width.saturating_sub(4) as usize;
    let running = app.cur_ws().is_some_and(|w| w.status == Status::Running);
    let name = app.cur_ws().map(|w| w.name.clone()).unwrap_or_default();
    let (lines, chips) = input_rows(app, &name, running, cw);
    let input_h = (lines.len() + usize::from(chips.is_some())) as u16;
    let y0 = (area.y + area.height).saturating_sub(input_h);
    let before = wrap(&app.input[..app.cursor.min(app.input.len())], cw);
    // Same scroll as `input_rows` when the input is taller than 8 rows.
    let total = if app.input.is_empty() { 1 } else { wrap(&app.input, cw).len() };
    let start = if total > 8 { before.len().saturating_sub(8).min(total - 8) } else { 0 };
    let row = before.len().saturating_sub(1).saturating_sub(start).min(lines.len().saturating_sub(1));
    let col = before.last().map(|l| width(l)).unwrap_or(0);
    Some((area.x + 2 + col.min(cw) as u16, y0 + row as u16))
}

/// One rendered transcript row, with the block it belongs to.
struct Row {
    line: Line<'static>,
    raised: bool,
    block: Option<usize>,
}

fn transcript_area(buf: &mut Buffer, area: Rect, app: &App, data: &WsData, running: bool) {
    let t = &app.theme;
    let rows = transcript_rows(app, data, running, area.width as usize);
    let h = area.height as usize;
    let total = rows.len();
    // Bottom-pinned unless scrolled; the focused block stays in view.
    let mut end = total.saturating_sub(app.scroll.min(total.saturating_sub(h)));
    if app.focus == Focus::Transcript {
        if let Some(first) = rows.iter().position(|r| r.block == Some(app.tsel)) {
            let last = rows.iter().rposition(|r| r.block == Some(app.tsel)).unwrap_or(first);
            if last + 1 > end {
                end = last + 1;
            }
            if first < end.saturating_sub(h) {
                end = (first + h).min(total);
            }
        }
    }
    let start = end.saturating_sub(h);
    for (i, r) in rows[start..end].iter().enumerate() {
        let y = area.y + i as u16;
        if r.raised {
            fill(buf, Rect { x: area.x, y, width: area.width, height: 1 }, t.raised_bg());
        }
        put_line(buf, area.x, y, area.width as usize, &r.line);
        if app.focus == Focus::Transcript && r.block == Some(app.tsel) && !r.raised {
            buf.set_string(area.x, y, glyphs::BAR, t.dim());
        }
    }
    if app.new_below && app.scroll > 0 {
        let label = "↓ new";
        buf.set_string(area.x + area.width - 2 - width(label) as u16, area.y + area.height - 1, label, t.mute());
    }
}

fn transcript_rows(app: &App, data: &WsData, running: bool, full: usize) -> Vec<Row> {
    let t = &app.theme;
    let cw = full.saturating_sub(4);
    let prose = cw.min(100);
    let mut out: Vec<Row> = Vec::new();
    let pad = |spans: Vec<Span<'static>>| {
        let mut v = vec![Span::raw("  ")];
        v.extend(spans);
        Line::from(v)
    };
    let gap = |out: &mut Vec<Row>| {
        if !out.is_empty() {
            out.push(Row { line: Line::default(), raised: false, block: None });
        }
    };
    if !data.loaded {
        out.push(Row { line: pad(vec![Span::styled("Loading…", t.mute())]), raised: false, block: None });
        return out;
    }
    let sweep = glyphs::sweep(app.tick, app.cfg.motion);
    let last_turn_running = running;
    for (bi, b) in data.blocks.iter().enumerate() {
        gap(&mut out);
        let row = |line| Row { line, raised: false, block: Some(bi) };
        match b {
            Block::User { text, skill, images, files, .. } => {
                user_rows(t, &mut out, text, skill.as_deref(), *images, *files, cw, Some(bi), false)
            }
            Block::Assistant { text, .. } => {
                for l in markdown::render(text, t, prose, cw) {
                    out.push(row(pad(l.spans)));
                }
            }
            Block::Tools { calls, .. } => {
                if app.tools_expanded(data, bi) {
                    for c in calls {
                        let pending = c.output.is_none() && last_turn_running;
                        out.push(row(pad(tool_row(t, c, pending, sweep, cw))));
                    }
                } else {
                    out.push(row(pad(vec![
                        Span::styled(glyphs::SEARCH, t.mute()),
                        Span::styled(format!(" {}", transcript::folded_label(calls)), t.mute()),
                    ])));
                }
            }
            Block::TurnEnd { duration_ms, tokens, error, interrupted, .. } => {
                if let Some(e) = error {
                    out.push(row(pad(vec![
                        Span::styled(glyphs::ERR, t.hue(t.bad)),
                        Span::styled(format!(" {}", truncate(first_line(e), cw - 2)), t.hue(t.bad)),
                    ])));
                    for l in e.trim().lines().skip(1).take(6) {
                        out.push(row(pad(vec![Span::styled(truncate(l, cw), t.mute())])));
                    }
                } else if *interrupted {
                    out.push(row(pad(vec![Span::styled(format!("{} stopped", glyphs::DOT), t.mute())])));
                } else {
                    let mut s = String::from(" done");
                    if let Some(d) = duration_ms {
                        s.push_str(&format!("{}{}", glyphs::SEP, transcript::format_duration(*d)));
                    }
                    if let Some(n) = tokens {
                        s.push_str(&format!("{}{} tokens", glyphs::SEP, transcript::format_tokens(*n)));
                    }
                    out.push(row(pad(vec![Span::styled(glyphs::DOT, t.hue(t.ok)), Span::styled(s, t.mute())])));
                }
            }
            Block::Plan { done, total, .. } => {
                out.push(row(pad(vec![Span::styled(format!("plan{}{done}/{total} done", glyphs::SEP), t.mute())])));
            }
            Block::SessionReset { .. } => {
                let label = "── new session ──";
                let lead = cw.saturating_sub(width(label)) / 2;
                out.push(row(pad(vec![Span::styled(format!("{}{label}", " ".repeat(lead)), t.mute())])));
            }
            Block::Error { message, .. } => {
                let mut lines = message.trim().lines();
                let first = lines.next().unwrap_or("");
                out.push(row(pad(vec![
                    Span::styled(glyphs::ERR, t.hue(t.bad)),
                    Span::styled(format!(" {}", truncate(first, cw - 2)), t.fg()),
                ])));
                for l in lines.take(5) {
                    out.push(row(pad(vec![Span::styled(format!("  {}", truncate(l, cw - 2)), t.mute())])));
                }
            }
        }
    }
    if let Some(p) = app.current.as_ref().and_then(|c| app.pending.get(c)) {
        gap(&mut out);
        user_rows(t, &mut out, p, None, 0, 0, cw, None, true);
    }
    if !data.live.is_empty() {
        gap(&mut out);
        let mut lines = markdown::render(&data.live, t, prose, cw);
        if let Some(last) = lines.last_mut() {
            last.spans.push(Span::raw(" "));
            last.spans.push(Span::styled(sweep, t.hue(t.run)));
        }
        for l in lines {
            out.push(Row { line: pad(l.spans), raised: false, block: None });
        }
    } else if running && !pending_tool(data) {
        gap(&mut out);
        let mut label = String::from(" thinking");
        if let Some(since) = data.turn_started {
            label.push_str(&format!("{}{}", glyphs::SEP, transcript::format_duration((app.now - since).max(0) as u64)));
        }
        out.push(Row {
            line: pad(vec![Span::styled(sweep, t.hue(t.run)), Span::styled(label, t.mute())]),
            raised: false,
            block: None,
        });
    }
    if out.is_empty() {
        out.push(Row {
            line: pad(vec![Span::styled("No messages yet. Say what to build.", t.mute())]),
            raised: false,
            block: None,
        });
    }
    out
}

/// The latest tool call is still waiting for its result (its row already shows the sweep).
fn pending_tool(data: &WsData) -> bool {
    matches!(data.blocks.last(), Some(Block::Tools { calls, .. }) if calls.last().is_some_and(|c| c.output.is_none()))
}

#[allow(clippy::too_many_arguments)]
fn user_rows(
    t: &Theme,
    out: &mut Vec<Row>,
    text: &str,
    skill: Option<&str>,
    images: usize,
    files: usize,
    cw: usize,
    block: Option<usize>,
    pending: bool,
) {
    let bg = t.raised_bg();
    let bar = Span::styled(glyphs::BAR, Style::new().fg(t.line_strong).patch(bg));
    let text_style = if pending { t.mute() } else { t.fg() }.patch(bg);
    let mut body = text.trim().to_string();
    let mut first_prefix = String::new();
    if let Some(s) = skill {
        first_prefix = format!("/{s} ");
        // The message text of a skill run starts with the skill invocation; show the args only.
        if let Some(rest) = body.strip_prefix(&format!("/{s}")) {
            body = rest.trim().to_string();
        }
    }
    let lines = wrap(&format!("{first_prefix}{body}"), cw);
    for (i, l) in lines.iter().enumerate() {
        let mut spans = vec![bar.clone(), Span::styled(" ", bg)];
        if i == 0 && !first_prefix.is_empty() && l.starts_with(&first_prefix) {
            spans.push(Span::styled(first_prefix.clone(), t.dim().patch(bg)));
            spans.push(Span::styled(l[first_prefix.len()..].to_string(), text_style));
        } else {
            spans.push(Span::styled(l.clone(), text_style));
        }
        out.push(Row { line: Line::from(spans), raised: true, block });
    }
    if images + files > 0 {
        let mut parts = vec![];
        if images > 0 {
            parts.push(format!("{images} image{}", if images == 1 { "" } else { "s" }));
        }
        if files > 0 {
            parts.push(format!("{files} file{}", if files == 1 { "" } else { "s" }));
        }
        out.push(Row {
            line: Line::from(vec![
                bar.clone(),
                Span::styled(" ", bg),
                Span::styled(format!("+ {}", parts.join(", ")), t.mute().patch(bg)),
            ]),
            raised: true,
            block,
        });
    }
}

fn tool_row(t: &Theme, c: &transcript::ToolCall, pending: bool, sweep: &str, cw: usize) -> Vec<Span<'static>> {
    let glyph = match transcript::tool_kind(&c.name) {
        ToolKind::Search => glyphs::SEARCH,
        ToolKind::Read => glyphs::READ,
        ToolKind::Edit => glyphs::EDIT,
        ToolKind::Command => glyphs::CMD,
        ToolKind::Other => glyphs::OTHER,
    };
    let mut spans = Vec::new();
    if c.is_error {
        spans.push(Span::styled(glyphs::ERR, t.hue(t.bad)));
    } else if pending {
        // One cell of the sweep keeps the column aligned.
        let ch: String = sweep.chars().next().map(String::from).unwrap_or_default();
        spans.push(Span::styled(ch, t.hue(t.run)));
    } else {
        spans.push(Span::styled(glyph, t.mute()));
    }
    let verb = transcript::tool_verb(&c.name);
    spans.push(Span::styled(format!(" {:<6}", verb), t.mute()));
    let summary = first_line(&transcript::tool_summary(&c.name, &c.input)).to_string();
    let counts = transcript::edit_counts(&c.name, &c.input).filter(|_| !c.is_error);
    let cw_counts = counts.map(|(a, d)| width(&format!("  +{a} {}{d}", glyphs::MINUS))).unwrap_or(0);
    let room = cw.saturating_sub(2 + 6 + 1 + cw_counts);
    spans.push(Span::styled(truncate(&summary, room), t.mute()));
    if let Some((a, d)) = counts {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(format!("+{a}"), t.hue(t.ok)));
        if d > 0 {
            spans.push(Span::raw(" "));
            spans.push(Span::styled(format!("{}{d}", glyphs::MINUS), t.hue(t.bad)));
        }
    }
    spans
}
