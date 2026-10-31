# Keys

## 1. Terminal setup

- Raw mode + alternate screen + bracketed paste + mouse capture (scroll wheel only; clicks focus rail rows and transcript blocks; drag-select is left to the terminal by holding Shift, which most terminals honour).
- Request the kitty keyboard protocol with `PushKeyboardEnhancementFlags(DISAMBIGUATE_ESCAPE_CODES | REPORT_ALTERNATE_KEYS)` when `supports_keyboard_enhancement()` is true; pop it on exit. This is what makes Shift+Enter and Ctrl+Enter distinguishable on terminals that support it (kitty, WezTerm, foot, Ghostty, iTerm2 ≥ 3.5, recent Windows Terminal via win32-input-mode in crossterm).
- Raw mode disables XON/XOFF, so **Ctrl+S and Ctrl+Q reach the app** (verified on Windows console and Unix ttys under crossterm). Still, every Ctrl binding has a palette entry.
- Restore the terminal on panic (panic hook) and on SIGINT/SIGTERM/console close.
- Esc ambiguity: with the kitty protocol Esc is immediate; without it, crossterm's parser already resolves Esc vs Alt-prefix; no extra delay is added.

## 2. Focus model

One focused region at a time: `Input`, `Transcript`, `Rail`, or the top overlay. Chat opens with `Input` focused.
- Tab cycles `Input → Rail → Transcript → Input` (skips Rail when hidden). Shift+Tab reverses. Inside a popup, Tab is the popup's own (complete).
- When `Input` is focused, printable keys type. Single-letter commands (`n`, `j`, `x`…) work only in `Rail`, `Transcript`, Inbox and Review.
- Esc: closes the top overlay; else, in Rail/Transcript returns focus to Input; else (in Input) interrupts a running agent; else does nothing. Esc never quits.

## 3. Bindings

`Alt+` keys also accept Esc-then-key when the terminal sends Alt as an Esc prefix. macOS Terminal and iTerm need "Use Option as Meta"; the fallback for them is the `Ctrl+X` prefix (§4).

### Global (any screen, unless an overlay with a text field is open)

| Key | Action |
|---|---|
| Alt+1 / Ctrl+X 1 | Chat |
| Alt+2 / Ctrl+X 2 | Inbox |
| Alt+3 / Ctrl+X 3 | Review (current workspace) |
| Ctrl+P | Palette |
| Ctrl+K | Workspace switcher |
| Ctrl+N | New workspace |
| Ctrl+B | Toggle rail (shown/hidden; session-only) |
| Ctrl+L | Redraw |
| Ctrl+C | Input non-empty: clear it. Otherwise: show "Press Ctrl+C again to quit" for 2 s; a second Ctrl+C within that window quits. |
| F1 / `?` (outside text) | Key help overlay (this table, for the current screen) |

### Chat — Input focused

| Key | Action |
|---|---|
| Enter | Send (queued after the turn if running, as the desktop does) |
| Shift+Enter, Alt+Enter, Ctrl+J | New line (Shift+Enter needs the kitty protocol; the other two always work) |
| Esc | Interrupt the running agent (else nothing) |
| Up / Down | On the first / last line: previous / next sent message (per-workspace history, 50 entries); otherwise move the cursor |
| PgUp / PgDn | Scroll the transcript half a page |
| `/` at start of input | Skills popup |
| `@` after start or whitespace | File picker popup |
| Ctrl+S | Ship (opens the Ship overlay and starts the gate) |
| Ctrl+R | Review (same as Alt+3) |
| Ctrl+O | Cycle profile (builder → each profile → builder) |
| Ctrl+Y | Copy the last assistant message (OSC 52) |
| Ctrl+E | Open the input in `$VISUAL`/`$EDITOR` (Windows: `notepad` if unset); on save, text replaces the input |

### Chat — Rail focused

| Key | Action |
|---|---|
| j / k, Down / Up | Move |
| Enter | Open workspace (focus returns to Input) |
| n | New workspace |
| x | Archive (confirm overlay; "uncommitted changes" error → second confirm with force) |
| d | Dismiss from needs-you |
| Esc / Tab | Back to Input |

### Chat — Transcript focused

| Key | Action |
|---|---|
| j / k | Move between blocks |
| g / G | First / last block |
| Enter | Expand / fold a tools block; on a code block, copy it (OSC 52) |
| y | Copy the selected block's text |
| Esc | Back to Input |

### Popups (skills, files, palette, switcher)

| Key | Action |
|---|---|
| typing | Filter (subsequence, case-insensitive, ranked by match start then length) |
| Up / Down, Ctrl+P / Ctrl+N | Move |
| Tab | Complete into the input (skills, files) |
| Enter | Skills: run it now with any typed args. Files: insert the path. Palette/switcher: do it. |
| Esc | Close |

### Inbox

| Key | Action |
|---|---|
| j / k | Move |
| Enter | Open in Chat |
| s | Ship (opens Chat with the Ship overlay) |
| f | Fix: `checksFailed` → send `fixChecksPrompt`; `checks` → run `shipkit:fix-ci`; `needsSync` → send `resolveConflictsPrompt` |
| c | Address comments (`shipkit:address-comments`) |
| r | Reply: open Chat with the input focused |
| 1 / 2 / 3 | Run the row's rule suggestion 1–3 (`ruleSuggestions`; shown on the selected row) |
| x | Archive |
| d | Dismiss |
| Esc | Back to the previous screen |

### Review

| Key | Action |
|---|---|
| j / k, Down / Up | Line |
| J / K, PgDn / PgUp | Half page |
| ] / [ | Next / previous file |
| n / p | Next / previous hunk |
| Tab | Focus file list ↔ diff |
| c | Comment on the cursor line (opens a one-line input under it; Enter saves, Esc cancels) |
| V | Start/extend a line range, then `c` comments on the range |
| e / Delete | Edit / delete the comment under the cursor |
| a | Accept file (moves it to the bottom, `✓`; session-only) |
| v | Cycle scope: base → since last turn → (pick commit from the list with Enter) |
| Enter | Send all draft comments (confirm when > 0) |
| Esc | Back (drafts are kept per workspace for the session) |

### Ship overlay

| Key | Action |
|---|---|
| m | Merge (only when the PR is open and mergeable; confirm) |
| f | Fix CI (`shipkit:fix-ci`) |
| c | Address comments |
| a | Ship anyway (only after checks failed) |
| o | Open the PR in the browser |
| r | Refresh PR status |
| Esc | Close (ship keeps running) |

## 4. Ctrl+X prefix

Ctrl+X starts a 1.5 s chord; the footer shows `ctrl+x …`. Then `1`/`2`/`3` (screens), `n` (new), `s` (ship), `r` (review), `p` (palette), `q` (quit). Any other key cancels. This exists so everything works on terminals where Alt is unusable.

## 5. Palette commands

Every action above, named as in the desktop where one exists (ids from `src/lib/keybindings.ts` where they match, e.g. `workspace.new`, `view.inbox`), plus: Toggle rail side, Theme: Void / Paper / Auto, Compact context, New session, Copy last message, Open worktree in file manager, Quit.

## 6. Settings file

`~/.orbit/tui.json` (created on first change, never required):
```json
{ "railSide": "left", "theme": "auto", "motion": true, "ascii": false, "pinned": ["shipkit:ship", "shipkit:fix-ci", "shipkit:preflight"] }
```
Unknown keys are kept on write. Command-line flags override it for the session.

## Open

- **K1.** Are Alt+1/2/3 acceptable as primary screen keys, with Ctrl+X as the universal fallback? (Recommended yes.)
- **K2.** Ctrl+S for Ship: fine in raw mode, but some users expect "save". Keep? (Recommended keep.)
- **K3.** Pinned chips: separate TUI list (above) or read the desktop's pinned skills? The desktop keeps them in localStorage, so sharing would need a new setting. (Recommended separate for v1.)
