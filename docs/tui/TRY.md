# Try `orb` (MVP)

`orb` is Orbit's terminal UI. It lives in `crates/` (its own Cargo workspace; the desktop app's build is untouched).

## 1. The demo (no desktop app needed)

```powershell
cd crates
cargo run --release -- --demo
```

Use **Windows Terminal** for colour and Alt keys. The demo has eight workspaces covering every Inbox state, two of which keep working in the background, so the rail and Inbox change while you watch.

Things to try:

| Do | Keys |
|---|---|
| Move in the Inbox, open a workspace | `j` / `k`, `Enter` |
| Send a message and watch it stream | type, `Enter` (`Esc` stops the agent) |
| Skills | `/`, type to filter, `Tab` completes, `Enter` runs |
| Ship `readme-badge` to a mergeable PR, then merge | `Ctrl+S`, wait for checks, `m`, `y` |
| Ship that fails its checks | open `bump-deps`, `Ctrl+S`, then `a` ship anyway or `f` fix |
| Review `fix-login`, comment, send | `Alt+3`, `j`/`k`, `]` next file, `c` comment, `Enter` send |
| Review one commit / since the last turn | `v` (scope), or `Tab` to the list and `Enter` on a commit |
| Switch workspace | `Ctrl+K`, or `Tab` to the rail, `j`/`k`, `Enter` |
| Screens | `Alt+1` chat, `Alt+2` inbox, `Alt+3` review (or `Ctrl+X` then `1`/`2`/`3`) |
| Rail on / off, quit | `Ctrl+B`; `Ctrl+C` twice |

Flags: `--rail left|right|off`, `--theme void|paper|auto`, `--color truecolor|16`, `--no-motion`. Settings can also go in `~/.orbit/tui.json`:

```json
{ "railSide": "right", "theme": "paper", "motion": true, "pinned": ["shipkit:ship", "shipkit:fix-ci", "shipkit:preflight"] }
```

## 2. With the real app

The desktop app must be built from this branch: it now starts a local listener and writes `~/.orbit/local.json` (port and token) on every launch.

```powershell
bun run app              # terminal 1: the desktop app
cd crates
cargo run --release      # terminal 2: Inbox if something needs you, else your latest workspace
cargo run --release -- ls            # list workspaces and exit (add --json for scripts)
cargo run --release -- fix-login     # open a workspace by name or prefix
```

To put `orb` on your PATH: `cargo install --path crates/orbit-tui`, then just `orb`, `orb ls`, `orb --demo`.

If the app isn't running, `orb` says so and exits. If the app restarts while `orb` is open, the header shows `reconnecting…` and `orb` picks up the new port and token by itself.

## What to check against the real app

- `orb ls` lists the same workspaces as the desktop Inbox.
- Send, `Esc` to stop, `/` skills, `Ctrl+S` ship (checks → agent → PR → merge), Review comments (`Alt+3`, `c`, `Enter`).
- Note anything that looks off in a screen; plain-text renders of every demo screen are in `crates/orbit-tui/screens/` for comparison.

## Not in this MVP

New-workspace dialog, `@` file picker, palette (`Ctrl+P`), profile switching (`Ctrl+O`), copy (`Ctrl+Y`), `$EDITOR` (`Ctrl+E`), key help (`F1`), archive, notifications, ASCII glyphs, 256-colour tier, range comments (`V`), editing or deleting comments, markdown tables, `orb send`. See `docs/tui/spec/mvp.md`.
