//! Rust port of `reviewMessage` in `src/stores/review.ts`: local review comments become one chat
//! message for the workspace's agent. Keep the two byte-identical (the golden tests below were
//! produced by the TS function).

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub path: String,
    pub start_line: u64,
    pub end_line: u64,
    /// `"old"` (removed line, base side) or `"new"`.
    pub side: String,
    pub text: String,
    pub excerpt: String,
}

/// A fence one backtick longer than the longest backtick run in `text`, at least three.
fn fence(text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat(3.max(if longest > 0 { longest + 1 } else { 0 }))
}

/// One message for all comments, in the order given.
pub fn review_message(comments: &[ReviewComment]) -> String {
    let items: Vec<String> = comments
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let mut range = if c.start_line == c.end_line { c.start_line.to_string() } else { format!("{}-{}", c.start_line, c.end_line) };
            if c.side == "old" {
                range.push_str(" (removed, base side)");
            }
            let f = fence(&c.excerpt);
            format!("{}. `{}:{range}`\n{f}\n{}\n{f}\n{}", i + 1, c.path, c.excerpt.trim_end_matches('\n'), c.text.trim())
        })
        .collect();
    format!("Review comments on your changes:\n\n{}", items.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(path: &str, start: u64, end: u64, side: &str, text: &str, excerpt: &str) -> ReviewComment {
        ReviewComment { path: path.into(), start_line: start, end_line: end, side: side.into(), text: text.into(), excerpt: excerpt.into() }
    }

    // Goldens: output of the TS `reviewMessage` for the same inputs (generated with bun).
    #[test]
    fn single_comment_matches_ts() {
        let got = review_message(&[c("src/a.rs", 3, 3, "new", "  rename this  \n", "let x = 1;\n\n")]);
        assert_eq!(got, "Review comments on your changes:\n\n1. `src/a.rs:3`\n```\nlet x = 1;\n```\nrename this");
    }

    #[test]
    fn ranges_old_side_fences_and_empty_match_ts() {
        let got = review_message(&[
            c("src/a.rs", 10, 12, "old", "why removed?", "fn a() {\n  b()\n}"),
            c("docs/r.md", 1, 1, "new", "fence", "use ```rust and `x` and ````\n"),
            c("b.ts", 5, 5, "new", "", ""),
        ]);
        assert_eq!(
            got,
            "Review comments on your changes:\n\n1. `src/a.rs:10-12 (removed, base side)`\n```\nfn a() {\n  b()\n}\n```\nwhy removed?\n\n2. `docs/r.md:1`\n`````\nuse ```rust and `x` and ````\n`````\nfence\n\n3. `b.ts:5`\n```\n\n```\n"
        );
    }

    #[test]
    fn fence_lengths() {
        assert_eq!(fence(""), "```");
        assert_eq!(fence("a `b` c"), "```");
        assert_eq!(fence("``"), "```");
        assert_eq!(fence("```"), "````");
        assert_eq!(fence("x ```` y ``"), "`````");
    }
}
