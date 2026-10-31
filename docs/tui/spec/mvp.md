# MVP cut

The first testable release of `orb`. Scope is what the maintainer asked for: **clean UI, fleet rail (left/right), full-screen Inbox, skills + shipping, built-in diff review.** Everything else in the spec waits. Where this file and the other spec files differ, **this file wins for the MVP**.

## In

| Area | MVP |
|---|---|
| Binary | `orb`; `orb` (TUI), `orb <workspace>`, `orb ls [--json]`, `orb --demo`, flags `--theme void\|paper\|auto`, `--rail left\|right\|off`, `--no-motion` |
| Chat | header, transcript (all block kinds, folded tool groups, markdown: paragraphs, headings, lists, inline code, code blocks), live text, input (multi-line, history), send, Esc stop, scroll |
| Rail | groups needs you / running / done, dot colours, current row, left/right (`--rail`, `tui.json`), Tab focus, j/k + Enter, auto-hide < 100 cols, Ctrl+B toggle |
| Inbox | full screen, grouped, reason + detail, age, keys Enter / f / s / c / d / 1-3 / Esc |
| Skills | `/` popup (all enabled packs, shipkit first), filter, Tab complete, Enter run, pinned chips (display only) |
| Ship | Ctrl+S overlay: gate → agent shipping → PR → checks counts → merge; ship anyway; fix CI; address comments |
| Review | Alt+3 / Ctrl+R: files + commits, unified diff, scopes base / turn / commit, `c` comment (single line), `Enter` send, `a` accept |
| Keys | Alt+1/2/3, Ctrl+X prefix (1/2/3/s/r/q), Ctrl+C twice quits, Ctrl+K switcher |
| Theme | Void/Paper, truecolor + ANSI-16 fallback (`NO_COLOR` → 16), Unicode glyphs |
| Demo | `orb --demo`: in-process fake backend with 6 workspaces and a scripted turn that streams, so the design can be tried without the app |

## Out (later)

New workspace dialog, `@` files, palette (Ctrl+P), profile switching, Ctrl+E/Ctrl+Y, F1 help, archive, notifications (bell/OSC 9), ASCII glyph set, 256-colour tier, range comments (`V`), comment edit/delete, hyperlinks, tables in markdown, in-app pane (T5), installer, e2e steps, `orb send`.

## Structure (deviations from tasks/)

- **No root Cargo workspace.** `crates/` is its own workspace (`crates/Cargo.toml`, members `orbit-proto`, `orbit-tui`, own `Cargo.lock`, own `target/`). `src-tauri` is untouched as a build unit, so the app, its lockfile and the release workflow are unaffected.
- **`src-tauri` does not depend on `orbit-proto`** in the MVP. The server keeps building JSON with `serde_json`; `orbit-proto` mirrors the shapes.
- **`Backend::rpc` stays synchronous.** New async-backed methods run `tauri::async_runtime::block_on(…)` (they already execute inside `spawn_blocking`).
- **No new pushes.** The TUI refetches `snapshot` (debounced 300 ms) on any `workspace` push and on `turnCompleted` / `userMessage` events.

## App-side RPCs (local listener, plaintext frames, protocol 2)

Existing: `snapshot`, `events`, `send`, `interrupt`, `markSeen`.
New: `hello`, `dismiss`, `listSkills`, `runSkill`, `prStatus`, `ship`, `merge`, `review`, `fileAt`, `sendReview`. Shapes exactly as [protocol.md](protocol.md) §3, with `hello` returning `{ settings: { staleDays, staleBehind, saveCommits }, version }`.

## TUI client abstraction

```rust
#[async_trait] trait Backend: Send + Sync {
  async fn rpc(&self, method: &str, params: Value) -> Result<Value, String>;
  fn subscribe(&self) -> mpsc::Receiver<Push>;
}
```
Implemented by `LiveBackend` (WebSocket, local mode) and `DemoBackend` (in memory). The app only talks to `dyn Backend`.

## Done when

- `cd crates && cargo test && cargo clippy -- -D warnings` clean on Linux.
- `orb --demo` runs and every MVP screen works with the fake data.
- `src-tauri`: `cargo test remote` passes and clippy is clean (compile-checked on Linux; the maintainer verifies on Windows).
- With the real app: `orb ls` lists workspaces; `orb` opens the Inbox or Chat; send, stop, skill, ship, review comments work.
