# Try `orb` (MVP)

`orb` is Orbit's terminal UI. It lives in `crates/` (its own Cargo workspace; the desktop app's build is untouched). All commands below are for **PowerShell in Windows Terminal** (Win key, type `terminal`, Enter).

## 0. Get it

**Without installing Rust:** GitHub → this repo → **Actions** → **orb** → the latest run on `claude/gracious-feynman-qp58x3` → **Artifacts** → `orb-windows`. Unzip `orb.exe` somewhere, e.g. `$HOME\orb\orb.exe`, then:

```powershell
& "$HOME\orb\orb.exe" --demo
```

**Or build it** (needs Git, Rust and the VS C++ build tools; `winget install Git.Git`, `winget install Rustlang.Rustup`, `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`, then reopen the terminal):

```powershell
mkdir $HOME\code -Force
cd $HOME\code
git clone -b claude/gracious-feynman-qp58x3 https://github.com/sgranquist13/orbit.git
cd $HOME\code\orbit\crates
cargo run --release -- --demo
```

After the first build: `& "$HOME\code\orbit\crates\target\release\orb.exe" --demo`. To get a plain `orb` command: `cargo install --path $HOME\code\orbit\crates\orbit-tui`.

## 1. The demo (no desktop app needed)

Eight workspaces covering every Inbox state, two of which keep working in the background, so the rail and Inbox change while you watch.

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

Flags: `--rail left|right|off`, `--theme void|paper|auto`, `--color truecolor|16`, `--no-motion`. Settings can also go in `$HOME\.orbit\tui.json`:

```json
{ "railSide": "right", "theme": "paper", "motion": true, "pinned": ["shipkit:ship", "shipkit:fix-ci", "shipkit:preflight"] }
```

## 2. With the real app

The desktop app must be built from this branch: it starts a local listener and writes `$HOME\.orbit\local.json` (port + token, new on every launch). Two terminals:

```powershell
# terminal 1: the desktop app (repo root; needs Bun + the usual app toolchain)
cd $HOME\code\orbit
bun install
bun run app
```

```powershell
# terminal 2
cd $HOME\code\orbit\crates
cargo run --release -- doctor     # checks the connection and every read-only request
cargo run --release -- ls         # your workspaces, grouped like the Inbox
cargo run --release               # the UI: Inbox if something needs you, else your latest workspace
cargo run --release -- fix-login  # open a workspace by name or unique prefix
```

`orb doctor` prints one `✓` / `✗` line per step and says what to do when one fails (app not running, a stale `local.json` from an app that quit, a refused token). It never sends, ships or merges. If anything fails, its output is the thing to send back.

If Orbit restarts while `orb` is open, the header shows `reconnecting…` and `orb` reconnects by itself.

## 3. Test checklist (real app)

Use a throwaway workspace for the ones that change things.

1. `orb doctor` is all `✓`.
2. `orb ls` matches the desktop Inbox (same groups and reasons).
3. `orb`: the start screen is the Inbox if the desktop shows something needing you.
4. Open a workspace (`Enter`): the transcript matches the desktop; the desktop marks it seen.
5. Send a one-line message: it streams in `orb` and in the desktop at the same time.
6. `Esc` while it runs: the turn stops (`● stopped`).
7. `/` → pick a skill → `Enter`: it runs (shows as `/shipkit:… args` in the transcript).
8. `Ctrl+S` on a workspace with changes: checks → squash → agent ships → PR with check counts → `m` merges (only on a sandbox repo).
9. `Alt+3`: files and commits match the desktop Review; `v` switches scope; `c` comment, `Enter` sends it to the agent.
10. Quit Orbit while `orb` is open: `reconnecting…`; start Orbit again: `orb` recovers.

## 4. For developers

- `cd crates; cargo test` (unit, screen snapshots in `crates/orbit-tui/screens/`, theme/depth renders). `ORB_UPDATE_SCREENS=1 cargo test` rewrites snapshots after review.
- `scripts/orb-interop.sh` (Git Bash) runs `orb`'s client against the app's **real** bridge server with the app's own types and real review/fileAt code (`src-tauri/src/remote/orb_interop.rs`, `crates/orbit-tui/tests/interop.rs`). CI runs it on Windows (`.github/workflows/orb.yml`).

## Not in this MVP

New-workspace dialog, `@` file picker, palette (`Ctrl+P`), profile switching (`Ctrl+O`), copy (`Ctrl+Y`), `$EDITOR` (`Ctrl+E`), key help (`F1`), archive, notifications, ASCII glyphs, 256-colour tier, range comments (`V`), editing or deleting comments, markdown tables, `orb send`, auto-detecting a light terminal (use `--theme paper`). See `docs/tui/spec/mvp.md`.
