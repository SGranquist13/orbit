//! Line diff for the Review screen (behaviour.md §4.1): Myers, 3 lines of context, hunks merged
//! when they are at most 6 lines apart.

use similar::{ChangeTag, TextDiff};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    Hunk(String),
    Line { kind: Kind, old: Option<u32>, new: Option<u32>, text: String },
    Note(String),
}

impl Row {
    /// The document line a comment on this row refers to, and its side.
    pub fn anchor(&self) -> Option<(u32, &'static str)> {
        match self {
            Row::Line { kind: Kind::Del, old: Some(n), .. } => Some((*n, "old")),
            Row::Line { new: Some(n), .. } => Some((*n, "new")),
            _ => None,
        }
    }
}

pub const MAX_LINES: usize = 5000;

pub fn diff(old: &str, new: &str) -> Vec<Row> {
    let d = TextDiff::configure().algorithm(similar::Algorithm::Myers).diff_lines(old, new);
    let mut rows = Vec::new();
    for group in d.grouped_ops(3) {
        let (Some(first), Some(last)) = (group.first(), group.last()) else { continue };
        let o = first.old_range().start;
        let n = first.new_range().start;
        let ol = last.old_range().end - o;
        let nl = last.new_range().end - n;
        rows.push(Row::Hunk(format!("@@ -{},{} +{},{} @@", o + 1, ol, n + 1, nl)));
        for op in &group {
            for ch in d.iter_changes(op) {
                let kind = match ch.tag() {
                    ChangeTag::Equal => Kind::Context,
                    ChangeTag::Insert => Kind::Add,
                    ChangeTag::Delete => Kind::Del,
                };
                let text = ch.value().trim_end_matches(['\n', '\r']).to_string();
                rows.push(Row::Line {
                    kind,
                    old: ch.old_index().map(|i| i as u32 + 1),
                    new: ch.new_index().map(|i| i as u32 + 1),
                    text,
                });
            }
        }
    }
    let lines = rows.iter().filter(|r| matches!(r, Row::Line { .. })).count();
    if lines > MAX_LINES {
        let mut kept = 0;
        rows.retain(|r| {
            if matches!(r, Row::Line { .. }) {
                kept += 1;
            }
            kept <= MAX_LINES
        });
        rows.push(Row::Note(format!("… {} more lines", lines - MAX_LINES)));
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunks_and_numbers() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\n";
        let new = "a\nb\nC\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\nnew\n";
        let rows = diff(old, new);
        let hunks: Vec<_> =
            rows.iter().filter_map(|r| if let Row::Hunk(h) = r { Some(h.clone()) } else { None }).collect();
        assert_eq!(hunks, vec!["@@ -1,6 +1,6 @@", "@@ -12,3 +12,4 @@"]);
        assert!(rows.contains(&Row::Line { kind: Kind::Del, old: Some(3), new: None, text: "c".into() }));
        assert!(rows.contains(&Row::Line { kind: Kind::Add, old: None, new: Some(3), text: "C".into() }));
        assert_eq!(rows.last().unwrap().anchor(), Some((15, "new")));
    }

    #[test]
    fn close_hunks_merge() {
        let old = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
        let hunks = |new: &str| diff(old, new).iter().filter(|r| matches!(r, Row::Hunk(_))).count();
        assert_eq!(hunks("x\n2\n3\n4\n5\n6\n7\ny\n9\n"), 1, "6 lines apart merge");
        assert_eq!(hunks("x\n2\n3\n4\n5\n6\n7\n8\ny\n"), 2, "7 lines apart stay separate");
    }

    #[test]
    fn new_file() {
        let rows = diff("", "one\ntwo\n");
        assert_eq!(rows[0], Row::Hunk("@@ -1,0 +1,2 @@".into()));
        assert_eq!(rows.len(), 3);
    }
}
