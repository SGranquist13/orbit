//! Width-aware string helpers (terminal cells, not bytes).

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub fn width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

/// Cuts `s` to `max` cells, ending in `…` when it had to cut.
pub fn truncate(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0;
    for g in s.graphemes(true) {
        let gw = width(g);
        if w + gw > max - 1 {
            break;
        }
        out.push_str(g);
        w += gw;
    }
    out.push('…');
    out
}

/// Pads (or truncates) to exactly `n` cells.
pub fn pad(s: &str, n: usize) -> String {
    let t = truncate(s, n);
    let w = width(&t);
    format!("{t}{}", " ".repeat(n.saturating_sub(w)))
}

pub fn pad_left(s: &str, n: usize) -> String {
    let t = truncate(s, n);
    let w = width(&t);
    format!("{}{t}", " ".repeat(n.saturating_sub(w)))
}

/// Greedy word wrap to `max` cells; words longer than a line are split. Keeps explicit newlines.
pub fn wrap(s: &str, max: usize) -> Vec<String> {
    let max = max.max(1);
    let mut out = Vec::new();
    for para in s.split('\n') {
        let mut line = String::new();
        let mut lw = 0;
        for word in para.split_word_bounds() {
            let ww = width(word);
            if lw + ww > max && lw > 0 {
                out.push(line.trim_end().to_string());
                line = String::new();
                lw = 0;
                if word.trim().is_empty() {
                    continue;
                }
            }
            if ww > max {
                for g in word.graphemes(true) {
                    let gw = width(g);
                    if lw + gw > max {
                        out.push(std::mem::take(&mut line));
                        lw = 0;
                    }
                    line.push_str(g);
                    lw += gw;
                }
                continue;
            }
            line.push_str(word);
            lw += ww;
        }
        out.push(line.trim_end().to_string());
    }
    out
}

/// Markdown emphasis and code marks removed, for one-line summaries.
pub fn plain(s: &str) -> String {
    let t = s.trim_start_matches(['#', '>', ' ']);
    let t = t.strip_prefix("- ").unwrap_or(t);
    t.chars().filter(|c| !matches!(c, '`' | '*')).collect()
}

pub fn first_line(s: &str) -> &str {
    s.trim().lines().next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_and_pads() {
        assert_eq!(truncate("review-copy", 8), "review-…");
        assert_eq!(truncate("abc", 3), "abc");
        assert_eq!(pad("ab", 4), "ab  ");
        assert_eq!(pad_left("5m", 4), "  5m");
    }

    #[test]
    fn wraps_words() {
        assert_eq!(wrap("the quick brown fox", 9), vec!["the quick", "brown fox"]);
        assert_eq!(wrap("a\nb", 10), vec!["a", "b"]);
        assert_eq!(wrap("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
    }
}
