# Orbit TUI spec

The build spec for `orbit`, the terminal UI. [`../../tui.md`](../../tui.md) is the overview; [`../mockup.html`](../mockup.html) is the visual reference. Where this spec and the mockup disagree, **this spec wins**.

| File | What it fixes |
|---|---|
| [protocol.md](protocol.md) | Local transport, handshake, every RPC and event, exact JSON. |
| [visual.md](visual.md) | Tokens and colour fallbacks, glyphs, layout in columns per screen, truncation, motion. |
| [keys.md](keys.md) | Every binding per screen, terminal compatibility, focus model. |
| [behaviour.md](behaviour.md) | Transcript folding, attention and grouping, Review scopes and comments, Ship flow, reconnect, errors. |
| [tasks/](tasks/) | One brief per implementation task, in dependency order. |

## Rules for implementers

These apply to every task. A task brief can add to them, never relax them.

1. **Stay in scope.** Touch only the files the brief lists. If something outside it must change, stop and report instead of changing it.
2. **No agent logic in the TUI.** It renders state and calls RPCs. Anything that decides git, ship or agent behaviour lives in `src-tauri` and is reached through [protocol.md](protocol.md).
3. **Pure core.** `update(&mut App, Msg) -> Vec<Cmd>` and every `view::*` function are pure and deterministic (no clock, no I/O; time comes in through `Msg::Tick(now_ms)`). Snapshot tests depend on it.
4. **Tokens only.** Colours come from `theme::Theme` fields, never literal `Color::Rgb` outside `theme.rs`. Glyphs come from `glyphs.rs`.
5. **Types from `orbit-proto`.** The TUI never defines its own copy of a wire type.
6. **Repo conventions apply** (see `CLAUDE.md`): no `db()` lock inside an expression that already holds one; run `bun run check:guards` after touching `src-tauri`; serde is camelCase; `ipc.ts` mirrors any Rust type the desktop UI also uses.
7. **Done means:** `cargo test -p <crate>` passes, `cargo clippy -p <crate> -- -D warnings` is clean, `cargo fmt --check` passes, new snapshots are reviewed (not blindly accepted), and the brief's checklist is ticked in the PR description.
8. **Don't commit** from a Codex sandbox; Claude-run tasks commit on their task branch with a `tui:` prefix.

## Where things build

- `crates/orbit-proto` and `crates/orbit-tui` build and test on Linux, macOS and Windows with plain `cargo`.
- `src-tauri` tasks (marked **[app]**) need the Windows toolchain (`scripts/cargo.cmd`) to be verified for real. On Linux they can be compile-checked after installing the Tauri system deps (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libssl-dev`); unit tests that don't need a window run there too.
- Real-app e2e (`bun run e2e`) runs only on the maintainer's machine.

## Status

Spec version 1 (2026-10-31). Decisions still waiting on the maintainer are listed at the end of [keys.md](keys.md) and [behaviour.md](behaviour.md) under "Open"; tasks that depend on one say so.
