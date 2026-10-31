//! Glyphs (visual.md §2). Unicode only in the MVP (the ASCII set comes later).

pub const DOT: &str = "●";
pub const BAR: &str = "▎";
pub const SEARCH: &str = "∗";
pub const READ: &str = "→";
pub const EDIT: &str = "✎";
pub const CMD: &str = "$";
pub const OTHER: &str = "·";
pub const ERR: &str = "✗";
pub const PASS: &str = "✓";
pub const PENDING: &str = "·";
pub const MINUS: &str = "−";
pub const SEP: &str = " · ";
pub const ELLIPSIS: &str = "…";
pub const SWEEP: [&str; 4] = ["▓▒░", "▒▓▒", "░▒▓", "▒░▒"];
pub const BULLET: &str = "•";
pub const BORDER: ratatui::symbols::border::Set = ratatui::symbols::border::ROUNDED;

/// The sweep frame for a tick; static when motion is off.
pub fn sweep(tick: u64, motion: bool) -> &'static str {
    if motion {
        SWEEP[(tick % 4) as usize]
    } else {
        SWEEP[0]
    }
}
