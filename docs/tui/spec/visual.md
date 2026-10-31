# Visual spec

Measurements are in terminal cells. "W×H" is the terminal size. All colours are `theme::Theme` fields.

## 1. Theme tokens

Values are the desktop's (`src/index.css`). `bg` is **not painted** by default: the TUI uses the terminal's own background (`Color::Reset`) so it sits naturally in any terminal; `raised`, `panel` and `hover` are painted. `--paint-bg` (or `ORBIT_TUI_PAINT_BG=1`) paints `bg` too, which the in-app pane uses.

| Token | Void (dark) | Paper (light) | 256 (dark / light) | ANSI-16 (dark / light) | Used for |
|---|---|---|---|---|---|
| `bg` | `#050506` | `#f3f3f1` | 232 / 255 | Reset / Reset | base (normally not painted) |
| `panel` | `#0b0b0d` | `#eaeae7` | 233 / 254 | Reset / Reset | overlays, popups |
| `raised` | `#121215` | `#fbfbfa` | 234 / 231 | Reset (+ bar only) | your messages, input |
| `hover` | `#19191d` | `#e0e0dc` | 235 / 253 | Reverse | selected row |
| `line` | `#1f1f24` | `#d4d4cf` | 236 / 252 | DarkGray | rail divider |
| `lineStrong` | `#34343b` | `#111113` | 238 / 233 | Gray | overlay borders, message bar |
| `fg` | `#ececef` | `#111113` | 255 / 233 | Reset | body text |
| `dim` | `#a2a2aa` | `#46464c` | 248 / 238 | Gray | secondary text |
| `mute` | `#63636c` | `#84848a` | 241 / 245 | DarkGray | hints, tool lines, labels |
| `run` | `#f2b53a` | `#b57900` | 214 / 136 | Yellow | working |
| `ok` | `#3fd88a` | `#0b8a4a` | 78 / 29 | Green | done, additions |
| `bad` | `#ff5468` | `#d4183c` | 203 / 161 | Red | error, deletions |
| `warn` | `#f2b53a` | `#b57900` | 214 / 136 | Yellow | needs sync, stale |
| `info` | `#72a2ff` | `#2a55e8` | 111 / 26 | Blue | asked you |
| `merged` | `#b28cff` | `#7440e6` | 141 / 98 | Magenta | merged |

**Theme selection:** `--theme void|paper|auto` (default `auto`). `auto` queries the terminal background with OSC 11 (100 ms timeout) and picks Paper when its luminance > 0.5, else Void; `COLORFGBG` is a fallback; Void if both fail.
**Colour depth:** truecolor when `COLORTERM` is `truecolor`/`24bit` or `WT_SESSION` is set (Windows Terminal) or `TERM_PROGRAM` is `vscode`/`iTerm.app`/`WezTerm`; 256 when `TERM` contains `256color`; else ANSI-16. `--color truecolor|256|16` overrides. `NO_COLOR` set → ANSI-16 with only Bold/Dim/Reverse (no hues).

Text styles: **bold** only for the workspace name in the header and the selected item's name; never for body text. No italics except markdown emphasis. No underline except markdown links.

## 2. Glyphs

`glyphs.rs` holds two sets; `--ascii` (or a non-UTF-8 locale on Unix) selects ASCII.

| Role | Unicode | ASCII |
|---|---|---|
| status dot | `●` | `*` |
| your-message / input bar | `▎` | `\|` |
| search tool (Grep, Glob, WebSearch) | `∗` | `*` |
| read tool (Read, ViewImage, WebFetch) | `→` | `>` |
| edit tool (Write, Edit, MultiEdit, NotebookEdit, Codex Edit) | `✎` | `~` |
| command (Bash) | `$` | `$` |
| other tool | `·` | `.` |
| tool error | `✗` | `x` |
| check pass / fail / pending | `✓` / `✗` / `·` | `v` / `x` / `.` |
| sweep frames | `▓▒░`, `▒▓▒`, `░▒▓`, `▒░▒` | `#=-`, `=#=`, `-=#`, `=-=` |
| cursor in input | terminal cursor (not drawn) | same |
| minus in counts | `−` (U+2212) | `-` |
| separator | ` · ` | ` - ` |
| overlay border | `╭╮╰╯─│` (rounded) | `+-\|` |

## 3. Frame layout

```
┌ rail (30) ┬ main (W − 31) ────────────────────────────────┐
│           │ header                       1 row             │
│           │ (blank)                      1 row             │
│           │ transcript                   flex              │
│           │ (blank)                      1 row             │
│           │ input                        1–8 rows          │
│           │ footer                       1 row             │
└───────────┴────────────────────────────────────────────────┘
```

- **Margins:** 2 cells left and right inside the main pane; 1 inside the rail. No outer border.
- **Rail:** 30 cells + a 1-cell divider (`│` in `line`). Shown when `W ≥ 100` and the rail isn't toggled off; `railSide` puts it left or right. Below 100 the rail is hidden and Ctrl+K is the way to switch.
- **Minimum size:** 60×16. Below it, render only "Orbit needs at least 60×16" centred, in `mute`.
- **Max text width:** transcript prose wraps at `min(main − 4, 100)`; code blocks and diffs use the full main width and clip (no wrap) with a `mute` `…` in the last column.

### 3.1 Header (1 row)

`<name>` (bold `fg`) ` · <agent> <model>` ` · <branch>` in `mute`, left. Right-aligned: `<tokens>  <pct>%` in `mute`, from the latest `usage` event (`formatTokens(contextTokens)`, `contextTokens / contextWindow`). If it doesn't fit, drop in this order: branch, model, percentage. Name truncates last, with `…`.
When the workspace is running, the header's left edge gets the sweep (3 cells, `run`) followed by a space before the name.

### 3.2 Transcript blocks

Blocks are separated by one blank row.

| Block | Rendering |
|---|---|
| user | Rows painted `raised` across the full main width; first cell `▎` in `lineStrong`; one space; text in `fg`, wrapped. A skill message shows `/skill-id` in `dim` before the args. Images/files: one `mute` line `+ 2 images, 1 file`. |
| assistant | Markdown (§5), flush left, `fg`. |
| tools (running or latest turn) | One row per call: glyph + space + verb (`grep`, `read`, `edit`, `run`, tool name lowercased otherwise) padded to 6 + summary (`toolSummary` port) in `mute`. Edit rows append `+n −m` (`ok`/`bad`) when the result reports counts (see behaviour.md §1.3). An error result turns the glyph `✗` `bad`. A call with no result yet and the turn running: glyph replaced by the sweep. |
| tools (folded) | One `mute` row: `∗ 5 tool calls · 2 edits` (counts by kind, edits shown only if > 0). Enter on it (when focused) expands. |
| turnEnd | One `mute` row: `● done · 38s · 12.4k tokens` (`●` in `ok`), or `● stopped` (`mute`), or `✗ <error first line>` (`bad`) followed by the rest of the error in `mute`, max 6 lines. |
| plan | `mute` row `plan · 3/5 done`. |
| sessionReset | Centred `mute` row `── new session ──`. |
| error | `bad` glyph `✗` + message in `fg`, max 6 lines. |
| live text (`textDelta` since the last persisted message) | Rendered like assistant, with the sweep after the last character while streaming. |

The transcript scrolls; by default it sticks to the bottom. Scrolling up unpins; a `mute` `↓ new` marker appears at the bottom right while unpinned and new content arrives.

### 3.3 Input

- Rows painted `raised`; `▎` in `fg` (focused) or `lineStrong` (unfocused) at column 0; text from column 2. Grows with content from 1 to 8 rows, then scrolls.
- Empty + focused: placeholder `Message <name>…` in `mute`. While the agent runs: `Message <name> (sends after this turn)…`.
- The row under the text (still `raised`) shows pinned chips: `[ship] [fix-ci] [preflight]` in `dim`, separated by one space, then right-aligned `<profile>` in `mute` (e.g. `builder`). Hidden when the input is 1 row and W < 80.

### 3.4 Footer

One row, `mute`, two spaces in from the left: hints as `key label` pairs separated by three spaces, keys in `dim`. At most 6 pairs; drop from the right when they don't fit. A transient status (e.g. "Copied", "Shipping…", an RPC error) replaces the hints for 4 s, in `fg` (error: `bad` `✗` + text).

### 3.5 Rail

```
orbit            4 running        ← "orbit" fg bold, count mute, right-aligned
                                   
needs you                          ← group label, mute
● review-copy                      ← dot coloured by reason, name fg
● ci-node-22                       
                                   
running                            
● fix-login                        ← current workspace: row painted hover, name bold
● tidy-imports                     
                                   
done                               
● readme-badge                     ← done/idle names in dim
● dark-mode                        
                                   
n new · alt+2 inbox                ← pinned to the bottom row, mute
```

Names truncate with `…` at 26 cells. Empty groups are omitted. If the list overflows, the rail scrolls to keep the selection visible; a `mute` `+3 more` row marks hidden items at the end of a group only when collapsed (not in v1).

Dot colour by reason (behaviour.md §2): error/checksFailed/checks/review → `bad`; question → `info`; needsSync/changes/stale → `warn`; done (unread) → `ok`; running → `run`; merged PR → `merged`; idle → `mute`.

### 3.6 Inbox (full screen, no rail)

```
  Inbox · 2 need you · 2 running · 2 done                                 
                                                                          
  needs you                                                               
  ● review-copy     Asked you: Keep the old headline as a subtitle?    3m      enter reply
  ● ci-node-22      Checks failed: bun run check                       12m     f fix
  …
```
Columns: 2 margin · dot (1) · space · name (16, truncated) · space · reason text (flex, truncated) · age (5, right-aligned, `timeAgo`) · 3 spaces · action hint (shown on the selected row only, `mute`, 14). The reason text is `reasonMeta(reason).label` + `: ` + detail (behaviour.md §2.3) in `dim`; selected row in `fg` on `hover`.

### 3.7 Overlays (Skills popup, Ship, Palette, New workspace, Ctrl+K switcher)

Rounded border in `lineStrong`, inside painted `panel`, 1-cell padding left/right. Title in the top border: `╭─ Ship · readme-badge ──…╮` (title `fg`, rest `lineStrong`).
- **Skills popup:** anchored above the input, left edge aligned with the input text, width `min(main − 4, 72)`, height = items (max 8) + 2. Item: `id` (fg, 28 cells) + description (`mute`). Selected item on `hover`. Bottom border carries the hint `tab complete · enter run`.
- **Palette / switcher:** centred, width `min(W − 8, 72)`, top at row 3; a filter line at the top (`> query`), then up to 12 items.
- **Ship:** centred, width `min(W − 8, 80)`, height to content (max H − 6). Layout in behaviour.md §5.
- **New workspace:** centred, width `min(W − 8, 72)`: fields Repo (picker), Task (multi-line, 3 rows), Agent · Model (picker), Profile (picker). Labels in `mute`, values in `fg`, focused field has `▎` in `fg`.

### 3.8 Review (full screen, no rail)

- Row 1: `Review · <name> · <scope label> · <n> files  +a −d · <c> commits` (title bold `fg`, rest `mute`, `+a` `ok`, `−d` `bad`).
- Left column 32 cells: files (`M`/`A`/`D`/`R` letter in `run`/`ok`/`bad`/`info`, path relative with the common prefix stripped, counts in `mute`), blank row, `commits` label, then `<sha7> <subject>` in `mute`. Accepted files move to the bottom in `mute` with `✓`.
- Divider `│` in `line`.
- Diff: hunk headers `@@ … @@` in `mute`; line-number gutter 5 cells (`mute`; old number on removed lines, new number otherwise); `-` lines `bad`, `+` lines `ok`, context `dim`. Syntax highlighting is **off** for v1 (colour is diff-only); intra-line changes not shown in v1.
- Cursor row painted `hover`. Comments render under their last line as a `raised` block indented to the code column: `✎ <text>` (glyph `mute`, text `fg`). Draft count in the footer: `2 comments · enter send`.

## 4. Motion

- One tick source: 120 ms, active only while something animates (a running workspace is visible, or a transient status is showing). No ticks when idle → no redraws.
- Sweep advances one frame per tick. Nothing else moves: no fades, no slides, no spinners elsewhere.
- `ORBIT_REDUCED_MOTION=1` or `--no-motion`: the sweep is a static `▓▒░`.

## 5. Markdown

`pulldown-cmark`, CommonMark + tables + strikethrough. Mapping:
- Paragraphs: wrapped `fg`.
- Headings: `fg` bold, no `#`; one blank row above.
- Lists: `•` (ASCII `-`) / `1.`, hanging indent 2.
- Inline code: `dim` on `raised`. Code blocks: `raised` background full width, 2-cell indent, language label right-aligned in `mute` on the first row; contents `dim`, no highlighting in v1.
- Links: text underlined, URL dropped (OSC 8 hyperlink when the terminal supports it; behind `--hyperlinks`, off by default in v1).
- Tables: aligned columns, header `dim`, separators `line`; wider than the width → render the raw source lines.
- Block quotes: `▎` in `line` + `dim` text.

## 6. Snapshot matrix

Every screen is snapshot-tested (`insta`, ratatui `TestBackend`, `Buffer` → text with a style legend) at:
- 80×24, Void, ANSI-16, rail hidden (below 100)
- 140×40, Void, truecolor, rail left
- 140×40, Paper, truecolor, rail right
plus `--ascii` at 80×24 for Chat only.
Fixtures for screens come from `crates/orbit-tui/tests/fixtures/` (a snapshot JSON + event JSONL per scenario, built from `src-tauri/tests/fixtures/*.jsonl`).
