//! Colour tokens (visual.md §1). The only place colours are defined.

use ratatui::style::{Color, Modifier, Style};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Void,
    Paper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    TrueColor,
    Ansi16,
    /// `NO_COLOR`: ANSI-16 shapes with only Bold/Dim/Reverse.
    NoColor,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Theme {
    pub variant: Variant,
    pub depth: Depth,
    pub bg: Color,
    pub panel: Color,
    pub raised: Color,
    pub hover: Color,
    pub line: Color,
    pub line_strong: Color,
    pub fg: Color,
    pub dim: Color,
    pub mute: Color,
    pub run: Color,
    pub ok: Color,
    pub bad: Color,
    pub warn: Color,
    pub info: Color,
    pub merged: Color,
}

const fn rgb(v: u32) -> Color {
    Color::Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)
}

impl Theme {
    pub fn new(variant: Variant, depth: Depth) -> Theme {
        match depth {
            Depth::TrueColor => {
                let v = |dark: u32, light: u32| rgb(if variant == Variant::Void { dark } else { light });
                Theme {
                    variant,
                    depth,
                    bg: v(0x050506, 0xf3f3f1),
                    panel: v(0x0b0b0d, 0xeaeae7),
                    raised: v(0x121215, 0xfbfbfa),
                    hover: v(0x19191d, 0xe0e0dc),
                    line: v(0x1f1f24, 0xd4d4cf),
                    line_strong: v(0x34343b, 0x111113),
                    fg: v(0xececef, 0x111113),
                    dim: v(0xa2a2aa, 0x46464c),
                    mute: v(0x63636c, 0x84848a),
                    run: v(0xf2b53a, 0xb57900),
                    ok: v(0x3fd88a, 0x0b8a4a),
                    bad: v(0xff5468, 0xd4183c),
                    warn: v(0xf2b53a, 0xb57900),
                    info: v(0x72a2ff, 0x2a55e8),
                    merged: v(0xb28cff, 0x7440e6),
                }
            }
            Depth::Ansi16 => Theme {
                variant,
                depth,
                bg: Color::Reset,
                panel: Color::Reset,
                raised: Color::Reset,
                hover: Color::Reset,
                line: Color::DarkGray,
                line_strong: Color::Gray,
                fg: Color::Reset,
                dim: Color::Gray,
                mute: Color::DarkGray,
                run: Color::Yellow,
                ok: Color::Green,
                bad: Color::Red,
                warn: Color::Yellow,
                info: Color::Blue,
                merged: Color::Magenta,
            },
            Depth::NoColor => Theme {
                variant,
                depth,
                bg: Color::Reset,
                panel: Color::Reset,
                raised: Color::Reset,
                hover: Color::Reset,
                line: Color::Reset,
                line_strong: Color::Reset,
                fg: Color::Reset,
                dim: Color::Reset,
                mute: Color::Reset,
                run: Color::Reset,
                ok: Color::Reset,
                bad: Color::Reset,
                warn: Color::Reset,
                info: Color::Reset,
                merged: Color::Reset,
            },
        }
    }

    /// Picks the depth from the environment (visual.md §1).
    pub fn detect_depth() -> Depth {
        if std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) {
            return Depth::NoColor;
        }
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        let ct = env("COLORTERM");
        let tp = env("TERM_PROGRAM");
        if ct == "truecolor"
            || ct == "24bit"
            || std::env::var_os("WT_SESSION").is_some()
            || matches!(tp.as_str(), "vscode" | "iTerm.app" | "WezTerm" | "ghostty")
        {
            Depth::TrueColor
        } else {
            Depth::Ansi16
        }
    }

    /// `COLORFGBG` ("15;0" = light text on dark) as the auto fallback; Void otherwise.
    pub fn detect_variant() -> Variant {
        if let Ok(v) = std::env::var("COLORFGBG") {
            if let Some(bg) = v.rsplit(';').next().and_then(|b| b.parse::<u8>().ok()) {
                if bg == 7 || bg == 15 {
                    return Variant::Paper;
                }
            }
        }
        Variant::Void
    }

    fn mono(&self) -> bool {
        self.depth == Depth::NoColor
    }
    pub fn fg(&self) -> Style {
        Style::new().fg(self.fg)
    }
    pub fn dim(&self) -> Style {
        Style::new().fg(self.dim)
    }
    pub fn mute(&self) -> Style {
        if self.mono() {
            Style::new().add_modifier(Modifier::DIM)
        } else {
            Style::new().fg(self.mute)
        }
    }
    pub fn hue(&self, c: Color) -> Style {
        Style::new().fg(c)
    }
    pub fn bold(&self) -> Style {
        self.fg().add_modifier(Modifier::BOLD)
    }
    /// Your messages and the input. ANSI-16 has no fill: only the bar marks the block.
    pub fn raised_bg(&self) -> Style {
        Style::new().bg(self.raised)
    }
    pub fn panel_bg(&self) -> Style {
        Style::new().bg(self.panel)
    }
    /// The selected row: `hover` fill, or reverse video without truecolor.
    pub fn sel(&self) -> Style {
        match self.depth {
            Depth::TrueColor => Style::new().bg(self.hover),
            _ => Style::new().add_modifier(Modifier::REVERSED),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        let t = Theme::new(Variant::Void, Depth::TrueColor);
        assert_eq!(t.run, Color::Rgb(0xf2, 0xb5, 0x3a));
        let p = Theme::new(Variant::Paper, Depth::TrueColor);
        assert_eq!(p.fg, Color::Rgb(0x11, 0x11, 0x13));
        let a = Theme::new(Variant::Void, Depth::Ansi16);
        assert_eq!(a.raised, Color::Reset);
        assert!(a.sel().add_modifier.contains(Modifier::REVERSED));
    }
}
