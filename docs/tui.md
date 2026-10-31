# Orbit TUI: implementation plan

`orbit` is a terminal interface to Orbit: simple, clean, and recognisably Orbit. It is a client of the running desktop app, so the workspaces, events and settings are the ones the desktop and the phone see. The same binary runs inside the desktop app as a "Terminal UI" pane.

Status: **design agreed; build spec in [`tui/spec/`](tui/spec/README.md)** (protocol, visual, keys, behaviour, task briefs). The look is set by the animated mockup in [`docs/tui/mockup.html`](tui/mockup.html) (open it in a browser; the screen buttons and Replay drive it). The mockup is the reference for layout and feel, not a pixel spec, and it has known small rendering bugs.

## Principles

- **Clean first.** Few screens, few keys, generous whitespace. A feature makes it in only when it earns its place; anything else stays in the desktop app.
- **Orbit's own look.** Void/Paper greyscale, colour only for meaning (`run`, `ok`, `bad`, `warn`, `info`, `merged`), dither for motion, no box-drawing clutter.
- **Keyboard first.** Every action is on a key or in the Ctrl+P palette; the footer always shows the keys that matter right now.
- **One Orbit.** No agent logic in the TUI. It renders state and calls the app.

## Screens

| Screen | Key | Layout | Purpose |
|---|---|---|---|
| **Chat** | Alt+1 | rail + main | Talk to one workspace: header, transcript, input. |
| **Inbox** | Alt+2 | full screen | Every session grouped needs you / running / done, with its reason and the one key that resolves it. |
| **Review** | Alt+3 | full screen | Files and save-point commits on the left, diff on the right, line comments sent to the agent. |
| **Skills** | `/` | popup over Chat | Skill autocomplete (shipkit first, then installed packs) and pinned chips. |
| **Ship** | Ctrl+S | overlay over Chat | Checks → squash → push → PR, then live PR checks and merge. |
| **Palette** | Ctrl+P | overlay | Every action, using the command ids in `src/lib/keybindings.ts`. |
| **New workspace** | `n` | dialog | Repo, task, agent/model, profile. |

**Fleet rail.** On Chat (and its overlays) a 30-column rail lists the workspaces grouped needs you / running / done, with a status dot each. Left by default, `railSide: left | right` in TUI settings, hidden under ~100 columns. Tab focuses it; j/k + Enter switch. The Inbox has no rail, because it shows the same list at full size.

### Look

- **Header:** workspace name (bold), agent and model, branch; tokens and context % right-aligned (`AgentEvent::Usage`).
- **Your messages and the input:** a raised (`raised`) block with a thin left bar. Agent prose sits flush on `bg`.
- **Tool calls:** one dim line each with a glyph (`∗` search, `→` read, `✎` edit with `+n −m`, `$` command). Once the turn moves on they fold to one summary line; Enter expands.
- **Working:** the dither sweep `▓▒░` in `run` colour beside a short status ("running tests · 12s"). No other animation, and none at all with `ORBIT_REDUCED_MOTION=1`.
- **Overlays and popups:** the only places with borders (`line-strong`), on `panel`.
- **Footer:** at most about six dim key hints for the current screen.
- **Colour:** truecolor from the Void/Paper tokens (theme follows `settings.theme`, overridable with `--theme`); 256-colour fallback; an ANSI-16 theme for basic terminals; `NO_COLOR` respected.

### Keys (v1)

Global: Alt+1/2/3 screens, Ctrl+P palette, Ctrl+N or `n` (outside the input) new workspace, Ctrl+C twice quits.
Chat: Enter send, Shift+Enter newline, Esc stop the agent (or close a popup), Tab rail focus, `/` skills, `@` files, Ctrl+S ship, Ctrl+K workspace switcher.
Inbox: j/k, Enter open, `s` ship, `f` fix CI, `c` address comments, `x` archive, `d` dismiss, Esc back.
Review: j/k line, `]`/`[` file, `c` comment, `a` accept file, `v` scope (vs base · since last turn · one commit), Enter send comments, Esc back.
Ship: `m` merge, `f` fix CI, `c` address comments, `o` open on GitHub, Esc close.

## Architecture

```
crates/orbit-tui  (bin: orbit)  ratatui + crossterm
  └─ crates/orbit-proto  wire types, framing, client
        │  WebSocket on 127.0.0.1, local token
        ▼
src-tauri  remote/server.rs (Hub, Backend)  →  remote/mod.rs OrbitBackend  →  send / db / git / trunk / pr_review
```

### Workspace and crates
- Add a root `Cargo.toml` workspace with members `src-tauri`, `crates/orbit-proto`, `crates/orbit-tui`. Shared `target/`. `scripts/cargo.cmd` keeps working from the root.
- **`orbit-proto`:** the request/response/event types now inlined in `remote/server.rs` and `ide_mobile/docs/protocol.md`, plus a tokio client (`connect`, `rpc`, event stream, reconnect with backoff). `src-tauri` depends on it, so server and clients share one definition.
- **`orbit-tui`:** the binary. Modules: `app` (model + `update`), `msg`, `view/` (one file per screen + `rail`, `header`, `footer`, `markdown`, `diff`), `theme`, `keys`, `transcript` (fold events into blocks, a port of `src/lib/transcript.ts`), `attention` (port of `src/lib/attention.ts`), `client` (bridge task feeding `Msg`s).

### Local mode on the bridge
- Today the bridge runs only when Settings > Mobile is on, binds `0.0.0.0`, and every client goes through pairing and `crypto_box`. Add a **local listener** that always runs: `127.0.0.1` on an OS-assigned port, written with a random token to `~/.orbit/local.json` (`{port, token, pid}`, user-only permissions, rewritten on each launch). It shares the `Hub` and `Backend` with the phone server.
- Local clients send `{"type":"hello","token":…}` and skip pairing and encryption (loopback only). The token check is constant-time; the phone path is unchanged.
- `orbit` reads `local.json`; if the app isn't running it says so and prints how to start it. (Starting the app for you is a later option.)

### RPC surface
`Backend::rpc` is synchronous today; make it async (`async_trait` or a boxed future) since most new methods are. Existing: `snapshot`, `events`, `send`, `interrupt`, `markSeen`. New, each a thin wrapper over existing code:

| Method | Wraps |
|---|---|
| `createWorkspace` | `create_workspace_inner` |
| `archive`, `dismiss` | `archive_inner`, `db.dismiss` |
| `listSkills`, `runSkill` | `skills::list_skills`, `run_skill_with` |
| `switchProfile`, `listProfiles` | `switch_profile`, `skills::list_profiles` |
| `compact`, `newSession` | `compact_session`, `new_session` |
| `listFiles` | `code::fs` list files (for `@`) |
| `review` | `pr_review::local_review` (files + merge base), scope `base` / `turn` / `commit:<sha>` |
| `fileAt` | `code_file_at` / `code_read_file` (old and new sides) |
| `prepareShip`, `prStatus`, `merge` | `trunk::prepare_ship_inner`, `gh.rs` |
| `settings` | read-only `get_settings` (theme, keybindings) |

Events: the hub already broadcasts agent events and workspace updates; add `workspace-archived` and `teammate-changed` passthroughs only when a screen needs them.

The contract change goes into `ide_mobile/docs/protocol.md` first (bump the protocol version, additive only), then both sides, then `npm run interop` in `ide_mobile`.

### Inside the TUI
- Elm loop: `Msg` from keys, bridge events, a 120 ms tick (only while something animates) and resize. `update(&mut App, Msg) -> Vec<Cmd>` is pure; `Cmd`s (rpc calls) run on the tokio side and come back as `Msg`s.
- Render only on change. Transcript blocks are cached per workspace and rebuilt incrementally as events arrive (`sinceSeq`).
- Markdown with `pulldown-cmark`; code and diffs highlighted with `syntect` using a theme built from the tokens. The line diff is computed in Rust (`similar`) from the two file versions.
- Input: `tui-textarea`, with history per workspace.

## Milestones

Each milestone is a branch from `next`, merged back after its checks pass, with a "Preview:" line in `CHANGELOG.md`.

- **T0 Foundations.** Cargo workspace; `orbit-proto` extracted and used by `src-tauri` (no behaviour change: `cargo test`, `npm run interop` and the e2e mobile-free steps stay green); local listener + `local.json`; async `Backend::rpc`; `orbit ls` prints workspaces as plain text. *Done when* `orbit ls` lists the running app's workspaces.
- **T1 Chat.** Theme module and tokens; header, transcript (prose, tool lines and groups, markdown, code), input, send, Esc to stop, usage in the header, dither sweep; `orbit [workspace]` opens one. *Done when* a whole conversation can be held from the terminal while the desktop mirrors it.
- **T2 Fleet.** Rail (left/right, auto-hide), Ctrl+K switcher, Inbox screen with its keys, new workspace dialog, terminal bell / OSC 9 when a session needs you.
- **T3 Skills and Ship.** `/` popup and pinned chips, `@` files, Tab profile switch, palette, Ship overlay with live PR checks and merge.
- **T4 Review.** Review screen: file list, commits, diff, scopes, line comments sent as one message, accept file.
- **T5 In the app.** "Terminal UI" nav item and palette entry: a full-pane xterm.js PTY running the bundled `orbit`, token passed as `ORBIT_LOCAL_TOKEN`. Installer ships `orbit.exe` and offers to add it to PATH.
- **Later.** Headless mode (`orbit-core` extracted so agents run without the desktop app), GitHub PR review from the Review screen, teammates.

## Testing

- **Unit:** `update` transitions, transcript folding (against `src-tauri/tests/fixtures/*.jsonl`), attention port, key dispatch, diff building.
- **Snapshots:** `insta` + ratatui `TestBackend`: every screen at 80×24 and 140×40, Void and ANSI-16, rail left and right.
- **Protocol:** `orbit-proto` client against the real bridge server in `cargo test`, local token accepted and rejected.
- **e2e:** a `tui` step in `scripts/e2e.mjs` runs `orbit` in a PTY (answering `ESC[6n` with `ESC[1;1R`) against the real app: one haiku one-liner, checking the reply appears in the TUI screen and in the desktop transcript. T4 adds a review-comment step.
- **Showcase:** VHS tapes in `docs/tui/` render GIFs for the README and release notes.

## Decisions still open

- **Name on PATH:** `orbit` may collide with other tools; check before T5 (fallback `orbit-tui`, or `orb`).
- **Local socket vs loopback WebSocket:** v1 uses loopback WebSocket (one server); revisit if port or firewall issues show up on Windows.
- **Start screen:** Chat on the most recent workspace, or the Inbox when something needs you (leaning Inbox-when-needed).
- **Skill list:** shipkit only by default or all packs (leaning all, shipkit first).
