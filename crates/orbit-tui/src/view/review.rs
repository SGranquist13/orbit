//! Review: files + commits on the left, unified diff on the right (visual.md §3.8).

use super::{fill, put};
use crate::app::{App, Entry};
use crate::diff::{Kind, Row};
use crate::glyphs;
use crate::text::{pad, pad_left, truncate, width};
use orbit_proto::Scope;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Span;

const LIST_W: u16 = 32;

/// The shared directory prefix of all paths (to strip in the list).
fn common_prefix(paths: &[&str]) -> usize {
    let Some(first) = paths.first() else { return 0 };
    if paths.len() < 2 {
        return first.rfind('/').map(|i| i + 1).unwrap_or(0);
    }
    let mut n = first.len();
    for p in &paths[1..] {
        n = n.min(first.bytes().zip(p.bytes()).take_while(|(a, b)| a == b).count());
    }
    first[..n].rfind('/').map(|i| i + 1).unwrap_or(0)
}

pub fn render(buf: &mut Buffer, area: Rect, app: &App) {
    let t = &app.theme;
    let x = area.x + 2;
    let w = area.width.saturating_sub(4) as usize;
    let Some(r) = &app.review else { return };
    let name = app.ws(&r.ws).map(|w| w.name.clone()).unwrap_or_default();
    let base = app.ws(&r.ws).map(|w| app.base_branch(w)).unwrap_or_else(|| "main".into());
    let scope_label = match &r.scope {
        Some(Scope::Base) | None => format!("vs {base}"),
        Some(Scope::Turn) => "since last turn".into(),
        Some(Scope::Commit { sha }) => format!("commit {}", &sha[..sha.len().min(7)]),
    };
    let mut head = vec![
        Span::styled("Review", t.bold()),
        Span::styled(format!("{}{name}{}", glyphs::SEP, glyphs::SEP), t.mute()),
        Span::styled(scope_label, t.fg()),
    ];
    if let Some(d) = &r.data {
        let adds: u32 = d.files.iter().map(|f| f.additions).sum();
        let dels: u32 = d.files.iter().map(|f| f.deletions).sum();
        let n = d.files.len();
        head.push(Span::styled(format!("{}{n} file{}  ", glyphs::SEP, if n == 1 { "" } else { "s" }), t.mute()));
        head.push(Span::styled(format!("+{adds}"), t.hue(t.ok)));
        if dels > 0 {
            head.push(Span::raw(" "));
            head.push(Span::styled(format!("{}{dels}", glyphs::MINUS), t.hue(t.bad)));
        }
        let c = d.commits.len();
        head.push(Span::styled(format!("{}{c} commit{}", glyphs::SEP, if c == 1 { "" } else { "s" }), t.mute()));
    }
    put(buf, x, area.y, w, &head);

    let body = Rect { x, y: area.y + 2, width: w as u16, height: area.height.saturating_sub(2) };
    if r.loading && r.data.is_none() {
        buf.set_string(x, body.y, "Loading changes…", t.mute());
        return;
    }
    let Some(d) = &r.data else { return };
    if d.files.is_empty() {
        buf.set_string(x, body.y, "No changes in this scope. v to switch scope.", t.mute());
    }

    // Left column.
    let entries = r.entries();
    let paths: Vec<&str> = d.files.iter().map(|f| f.path.as_str()).collect();
    let strip = common_prefix(&paths);
    let lw = (LIST_W - 2) as usize;
    let mut y = body.y;
    let mut commits_label = false;
    let skip = (r.list_sel + 4).saturating_sub(body.height as usize);
    for (i, e) in entries.iter().enumerate().skip(skip) {
        if y >= body.y + body.height {
            break;
        }
        let sel = r.focus_list && i == r.list_sel;
        match e {
            Entry::File(path) => {
                let Some(f) = d.files.iter().find(|f| &f.path == path) else { continue };
                let accepted = r.accepted.contains(path);
                let open = r.file.as_deref() == Some(path.as_str());
                // FileChange has no status: untracked or a missing old side is an add, a missing new side a delete.
                let sides = r.sides.get(path);
                let missing = |s: Option<&Option<orbit_proto::FileAt>>| {
                    s.and_then(|f| f.as_ref()).is_some_and(|f| f.text.is_none() && !f.binary && !f.too_large)
                };
                let (letter, color) = if f.untracked || missing(sides.map(|s| &s.0)) {
                    ("A", t.ok)
                } else if missing(sides.map(|s| &s.1)) {
                    ("D", t.bad)
                } else {
                    ("M", t.run)
                };
                let counts = if f.deletions > 0 {
                    format!("+{} {}{}", f.additions, glyphs::MINUS, f.deletions)
                } else {
                    format!("+{}", f.additions)
                };
                let name_w = lw.saturating_sub(2 + width(&counts) + 1);
                let rel = &path[strip.min(path.len())..];
                let mut spans = if accepted {
                    vec![Span::styled(glyphs::PASS, t.mute()), Span::raw(" "), Span::styled(pad(rel, name_w), t.mute())]
                } else {
                    vec![
                        Span::styled(letter, Style::new().fg(color)),
                        Span::raw(" "),
                        Span::styled(pad(rel, name_w), if open { t.bold() } else { t.dim() }),
                    ]
                };
                spans.push(Span::styled(format!(" {counts}"), t.mute()));
                if sel || (open && !r.focus_list) {
                    fill(buf, Rect { x: area.x, y, width: LIST_W + 1, height: 1 }, t.sel());
                }
                put(buf, x, y, lw, &spans);
                y += 1;
            }
            Entry::Commit(ci) => {
                if !commits_label {
                    commits_label = true;
                    y += 1;
                    if y >= body.y + body.height {
                        break;
                    }
                    buf.set_string(x, y, "commits", t.mute());
                    y += 1;
                    if y >= body.y + body.height {
                        break;
                    }
                }
                let c = &d.commits[*ci];
                let cur = matches!(&r.scope, Some(Scope::Commit { sha }) if sha == &c.sha);
                if sel || cur {
                    fill(buf, Rect { x: area.x, y, width: LIST_W + 1, height: 1 }, t.sel());
                }
                let spans = [
                    Span::styled(c.sha.chars().take(7).collect::<String>(), t.mute()),
                    Span::styled(
                        format!(" {}", truncate(&c.subject, lw.saturating_sub(8))),
                        if cur { t.fg() } else { t.mute() },
                    ),
                ];
                put(buf, x, y, lw, &spans);
                y += 1;
            }
        }
    }

    // Divider.
    let dx = x + LIST_W;
    for yy in body.y..body.y + body.height {
        buf.set_string(dx, yy, "│", Style::new().fg(t.line));
    }

    // Diff.
    let dxx = dx + 2;
    let dw = (x + w as u16).saturating_sub(dxx) as usize;
    let h = body.height as usize;
    if r.file.is_none() {
        return;
    }
    if r.rows.is_empty() {
        buf.set_string(dxx, body.y, "Loading…", t.mute());
        return;
    }
    let comments: Vec<_> = app
        .drafts
        .get(&r.ws)
        .map(|v| v.iter().filter(|c| Some(&c.path) == r.file.as_ref()).collect())
        .unwrap_or_default();
    // Build display rows: (row index or None for comment/input rows, spans, painted)
    struct Disp {
        row: Option<usize>,
        spans: Vec<Span<'static>>,
        raised: bool,
    }
    let mut disp: Vec<Disp> = Vec::new();
    let code_w = dw.saturating_sub(6);
    for (i, row) in r.rows.iter().enumerate() {
        let spans = match row {
            Row::Hunk(h) => vec![Span::styled(h.clone(), t.mute())],
            Row::Note(n) => vec![Span::styled(n.clone(), t.mute())],
            Row::Line { kind, old, new, text } => {
                let n = if *kind == Kind::Del { old } else { new };
                let num = n.map(|n| n.to_string()).unwrap_or_default();
                let (sign, style) = match kind {
                    Kind::Add => ("+", t.hue(t.ok)),
                    Kind::Del => ("-", t.hue(t.bad)),
                    Kind::Context => (" ", t.dim()),
                };
                let text = text.replace('\t', "    ");
                let shown = if width(&text) + 1 > code_w { truncate(&text, code_w.saturating_sub(1)) } else { text };
                vec![
                    Span::styled(pad_left(&num, 4), t.mute()),
                    Span::raw(" "),
                    Span::styled(format!("{sign}{shown}"), style),
                ]
            }
        };
        disp.push(Disp { row: Some(i), spans, raised: false });
        if let Some((line, side)) = row.anchor() {
            for c in comments.iter().filter(|c| c.end_line == line && c.side == side) {
                disp.push(Disp {
                    row: None,
                    spans: vec![
                        Span::raw("     "),
                        Span::styled(format!("{} ", glyphs::EDIT), t.mute().patch(t.raised_bg())),
                        Span::styled(truncate(&c.text, code_w.saturating_sub(2)), t.fg().patch(t.raised_bg())),
                    ],
                    raised: true,
                });
            }
            if i == r.cursor {
                if let Some(text) = &r.commenting {
                    disp.push(Disp {
                        row: None,
                        spans: vec![
                            Span::raw("     "),
                            Span::styled(format!("{} ", glyphs::EDIT), t.fg().patch(t.raised_bg())),
                            Span::styled(text.clone(), t.fg().patch(t.raised_bg())),
                            Span::styled(" ", Style::new().bg(t.fg)),
                        ],
                        raised: true,
                    });
                }
            }
        }
    }
    let cur_at = disp.iter().position(|d| d.row == Some(r.cursor)).unwrap_or(0);
    // Keep a little context above the cursor.
    let start = if cur_at + 3 >= h { (cur_at + 4).saturating_sub(h).min(disp.len().saturating_sub(h)) } else { 0 };
    let start = if cur_at < start + 2 { cur_at.saturating_sub(2) } else { start };
    for (n, dsp) in disp.iter().skip(start).take(h).enumerate() {
        let yy = body.y + n as u16;
        let rect = Rect { x: dxx, y: yy, width: dw as u16, height: 1 };
        if dsp.raised {
            fill(buf, Rect { x: dxx + 5, width: (dw as u16).saturating_sub(5), ..rect }, t.raised_bg());
        } else if dsp.row == Some(r.cursor) && !r.focus_list {
            fill(buf, Rect { x: dx + 1, width: rect.width + 1, ..rect }, t.sel());
        }
        put(buf, dxx, yy, dw, &dsp.spans);
    }
}
