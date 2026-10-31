//! Markdown → styled lines (visual.md §5). Paragraphs, headings, lists, inline code, code
//! blocks, emphasis, links and quotes. Tables render as their source text in v1.

use crate::glyphs;
use crate::text::{truncate, width};
use crate::theme::Theme;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_segmentation::UnicodeSegmentation;

/// Wraps styled runs greedily at word boundaries. `first` / `rest` are the line prefixes.
pub fn wrap_spans(
    runs: &[(String, Style)],
    max: usize,
    first: Vec<Span<'static>>,
    rest: Vec<Span<'static>>,
) -> Vec<Line<'static>> {
    let pw = |p: &Vec<Span<'static>>| p.iter().map(|s| width(&s.content)).sum::<usize>();
    let mut lines = Vec::new();
    let mut cur: Vec<Span<'static>> = first.clone();
    let mut cw = pw(&first);
    let mut avail = max.saturating_sub(cw).max(1);
    let mut used = 0usize;
    let flush = |cur: &mut Vec<Span<'static>>, lines: &mut Vec<Line<'static>>| {
        // Drop trailing spaces.
        while let Some(last) = cur.last() {
            let t = last.content.trim_end().to_string();
            if t.is_empty() && cur.len() > 1 {
                cur.pop();
            } else {
                if let Some(l) = cur.last_mut() {
                    l.content = t.into();
                }
                break;
            }
        }
        lines.push(Line::from(std::mem::take(cur)));
    };
    for (text, style) in runs {
        for (i, seg) in text.split('\n').enumerate() {
            if i > 0 {
                flush(&mut cur, &mut lines);
                cur = rest.clone();
                cw = pw(&rest);
                avail = max.saturating_sub(cw).max(1);
                used = 0;
            }
            for word in seg.split_word_bounds() {
                let ww = width(word);
                if used + ww > avail && used > 0 {
                    flush(&mut cur, &mut lines);
                    cur = rest.clone();
                    cw = pw(&rest);
                    avail = max.saturating_sub(cw).max(1);
                    used = 0;
                    if word.trim().is_empty() {
                        continue;
                    }
                }
                if ww > avail {
                    // A word longer than the line: hard-split it.
                    let mut chunk = String::new();
                    for g in word.graphemes(true) {
                        if used + width(g) > avail {
                            cur.push(Span::styled(std::mem::take(&mut chunk), *style));
                            flush(&mut cur, &mut lines);
                            cur = rest.clone();
                            used = 0;
                        }
                        chunk.push_str(g);
                        used += width(g);
                    }
                    cur.push(Span::styled(chunk, *style));
                    continue;
                }
                cur.push(Span::styled(word.to_string(), *style));
                used += ww;
            }
        }
    }
    let _ = cw;
    if cur.iter().any(|s| !s.content.trim().is_empty()) || lines.is_empty() {
        flush(&mut cur, &mut lines);
    }
    lines
}

struct Ctx<'a> {
    t: &'a Theme,
    prose: usize,
    full: usize,
    out: Vec<Line<'static>>,
    runs: Vec<(String, Style)>,
    styles: Vec<Style>,
    /// List stack: `Some(n)` ordered with the next number, `None` bulleted.
    lists: Vec<Option<u64>>,
    item_first: bool,
    quote: usize,
    heading: bool,
    code: Option<(String, String)>,
}

impl Ctx<'_> {
    fn style(&self) -> Style {
        *self.styles.last().unwrap_or(&self.t.fg())
    }
    fn gap(&mut self) {
        if !self.out.is_empty() && self.out.last().is_some_and(|l| !l.spans.is_empty()) {
            self.out.push(Line::default());
        }
    }
    fn prefixes(&mut self) -> (Vec<Span<'static>>, Vec<Span<'static>>) {
        let mut first = Vec::new();
        let mut rest = Vec::new();
        for _ in 0..self.quote {
            first.push(Span::styled(format!("{} ", glyphs::BAR), Style::new().fg(self.t.line)));
            rest.push(Span::styled(format!("{} ", glyphs::BAR), Style::new().fg(self.t.line)));
        }
        let depth = self.lists.len();
        if depth > 0 {
            let indent = "  ".repeat(depth - 1);
            let marker = match self.lists.last().copied().flatten() {
                Some(n) => format!("{n}. "),
                None => format!("{} ", glyphs::BULLET),
            };
            let mw = width(&marker);
            if self.item_first {
                first.push(Span::styled(format!("{indent}{marker}"), self.t.dim()));
                self.item_first = false;
            } else {
                first.push(Span::raw(format!("{indent}{}", " ".repeat(mw))));
            }
            rest.push(Span::raw(format!("{indent}{}", " ".repeat(mw))));
        }
        (first, rest)
    }
    fn flush_runs(&mut self) {
        if self.runs.iter().all(|(s, _)| s.trim().is_empty()) {
            self.runs.clear();
            return;
        }
        let (first, rest) = self.prefixes();
        let runs = std::mem::take(&mut self.runs);
        let lines = wrap_spans(&runs, self.prose, first, rest);
        self.out.extend(lines);
    }
    fn code_block(&mut self, lang: &str, body: &str) {
        let t = self.t;
        let bg = t.raised_bg();
        let w = self.full.max(8);
        let body = body.strip_suffix('\n').unwrap_or(body);
        for (i, line) in body.split('\n').enumerate() {
            let line = line.replace('\t', "    ");
            let label = if i == 0 && !lang.is_empty() { format!(" {lang} ") } else { String::new() };
            let room = w.saturating_sub(2 + width(&label));
            let shown = if width(&line) > room { truncate(&line, room) } else { line.clone() };
            let pad = room.saturating_sub(width(&shown));
            let mut spans = vec![Span::styled("  ", bg), Span::styled(shown, t.dim().patch(bg))];
            spans.push(Span::styled(" ".repeat(pad), bg));
            if !label.is_empty() {
                spans.push(Span::styled(label, t.mute().patch(bg)));
            }
            self.out.push(Line::from(spans));
        }
    }
}

/// Renders `src` with prose wrapped at `prose` cells and code blocks `full` cells wide.
pub fn render(src: &str, t: &Theme, prose: usize, full: usize) -> Vec<Line<'static>> {
    let mut c = Ctx {
        t,
        prose,
        full,
        out: Vec::new(),
        runs: Vec::new(),
        styles: vec![t.fg()],
        lists: Vec::new(),
        item_first: false,
        quote: 0,
        heading: false,
        code: None,
    };
    let opts = Options::ENABLE_STRIKETHROUGH;
    for ev in Parser::new_ext(src, opts) {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {
                    if c.lists.is_empty() {
                        c.gap();
                    }
                }
                Tag::Heading { .. } => {
                    c.gap();
                    c.heading = true;
                    c.styles.push(t.fg().add_modifier(Modifier::BOLD));
                }
                Tag::BlockQuote(_) => {
                    c.gap();
                    c.quote += 1;
                    c.styles.push(t.dim());
                }
                Tag::CodeBlock(kind) => {
                    c.flush_runs();
                    c.gap();
                    let lang = match kind {
                        CodeBlockKind::Fenced(l) => l.split([',', ' ']).next().unwrap_or("").to_string(),
                        CodeBlockKind::Indented => String::new(),
                    };
                    c.code = Some((lang, String::new()));
                }
                Tag::List(start) => {
                    c.flush_runs();
                    if c.lists.is_empty() {
                        c.gap();
                    }
                    c.lists.push(start);
                }
                Tag::Item => {
                    c.flush_runs();
                    c.item_first = true;
                }
                Tag::Emphasis => c.styles.push(c.style().add_modifier(Modifier::ITALIC)),
                Tag::Strong => c.styles.push(c.style()),
                Tag::Strikethrough => c.styles.push(c.style().add_modifier(Modifier::CROSSED_OUT)),
                Tag::Link { .. } => c.styles.push(c.style().add_modifier(Modifier::UNDERLINED)),
                _ => {}
            },
            Event::End(end) => match end {
                TagEnd::Paragraph => c.flush_runs(),
                TagEnd::Heading(_) => {
                    c.flush_runs();
                    c.heading = false;
                    c.styles.pop();
                }
                TagEnd::BlockQuote(_) => {
                    c.flush_runs();
                    c.quote -= 1;
                    c.styles.pop();
                }
                TagEnd::CodeBlock => {
                    if let Some((lang, body)) = c.code.take() {
                        c.code_block(&lang, &body);
                    }
                }
                TagEnd::List(_) => {
                    c.flush_runs();
                    c.lists.pop();
                }
                TagEnd::Item => {
                    c.flush_runs();
                    if let Some(Some(n)) = c.lists.last_mut() {
                        *n += 1;
                    }
                }
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => {
                    c.styles.pop();
                }
                _ => {}
            },
            Event::Text(s) => {
                if let Some((_, body)) = c.code.as_mut() {
                    body.push_str(&s);
                } else {
                    let st = c.style();
                    c.runs.push((s.to_string(), st));
                }
            }
            Event::Code(s) => {
                let st = t.dim().patch(t.raised_bg());
                c.runs.push((s.to_string(), st));
            }
            Event::SoftBreak => {
                let st = c.style();
                c.runs.push((" ".into(), st));
            }
            Event::HardBreak => {
                let st = c.style();
                c.runs.push(("\n".into(), st));
            }
            Event::Rule => {
                c.flush_runs();
                c.gap();
                c.out.push(Line::styled("─".repeat(prose.min(40)), Style::new().fg(t.line)));
            }
            Event::Html(s) | Event::InlineHtml(s) => {
                let st = c.style();
                c.runs.push((s.to_string(), st));
            }
            _ => {}
        }
    }
    c.flush_runs();
    while c.out.last().is_some_and(|l| l.spans.is_empty()) {
        c.out.pop();
    }
    c.out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{Depth, Variant};

    fn plain(lines: &[Line]) -> Vec<String> {
        lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>().trim_end().to_string())
            .collect()
    }

    #[test]
    fn renders_blocks() {
        let t = Theme::new(Variant::Void, Depth::TrueColor);
        let md = "# Plan\n\nThe test raced the `session` cookie.\n\n- one\n- two words here\n\n1. first\n2. second\n\n```ts\nawait x();\n```\n\n> quoted";
        let out = plain(&render(md, &t, 20, 30));
        assert_eq!(
            out,
            vec![
                "Plan",
                "",
                "The test raced the",
                "session cookie.",
                "",
                "• one",
                "• two words here",
                "",
                "1. first",
                "2. second",
                "",
                "  await x();               ts",
                "",
                "▎ quoted",
            ]
        );
    }

    #[test]
    fn nested_list_hangs() {
        let t = Theme::new(Variant::Void, Depth::TrueColor);
        let out = plain(&render("- alpha beta gamma delta\n  - inner", &t, 14, 14));
        assert_eq!(out, vec!["• alpha beta", "  gamma delta", "  • inner"]);
    }
}
