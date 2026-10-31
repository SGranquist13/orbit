# Orbit TUI: plan

A terminal interface for Orbit: simple, clean, and recognisably Orbit. The same binary also runs inside the desktop app as a "Terminal UI" pane. Status: **shaping** (see PLANNING.md).

## Goals

- **Simple and clean first.** Few screens, few keys, lots of whitespace. A feature makes it in only when it earns its place; when in doubt, leave it to the desktop app.
- **Its own identity.** It looks like Orbit, not like another agent CLI: the same greyscale Void/Paper themes, colour only for meaning, dither for motion, the Orbit mark.
- **Fast to drive from the keyboard:** everything is reachable from the input line (`/` skills, `@` files, Ctrl+P palette).
- **One Orbit:** the TUI is a client of the running app. Workspaces, events and settings are the same ones the desktop and phone see.
- **One implementation, two ways in:** in a terminal (`orbit`) and in an app pane (a PTY running `orbit`).

Out of scope for v1: the Code view's editor, the Review view, voice, editing settings (the TUI shows a link instead).

## Architecture

```
orbit (TUI, ratatui + crossterm)          desktop app (Tauri)
  └─ orbit-proto (types, client) ──ws──▶   remote/server.rs (Hub, Backend)
                                           └─ remote/mod.rs OrbitBackend → send / db / …
```

- **Rust workspace.** Turn the repo into a Cargo workspace with three members: `src-tauri`, `crates/orbit-proto` (wire types, framing, `crypto_box` handshake, an async client) and `crates/orbit-tui` (builds to the `orbit` binary). `src-tauri` depends on `orbit-proto`, so the server and the clients can't drift apart.
- **Transport: the existing bridge, plus a local mode.** The server also listens on `127.0.0.1`, and a local client authenticates with a token from `~/.orbit/local-token` (created by the app, user-only permissions, rotated on demand). There's no QR pairing and no `crypto_box` needed on loopback. The phone path is unchanged.
- **More RPC methods.** Today the bridge has `snapshot`, `events`, `send`, `interrupt` and `markSeen`. Add these, each a thin wrapper over existing commands: `createWorkspace`, `archive`, `listSkills`, `runSkill`, `prepareShip`, `prStatus`, `diff` (from `git::changes`), `listFiles`, `setModel`, `compact`, `newSession`. The contract goes into `ide_mobile/docs/protocol.md` first (version bump), then `npm run interop`.
- **State:** an Elm-style loop with `App` (model), `update(msg)` (a pure function, unit-tested) and `view(frame)`. Bridge events, keys and ticks all become `Msg`s. Transcript folding ports `src/lib/transcript.ts` (consecutive tool calls → one group) as a pure function with tests shared against the same fixtures.

## Design language

Orbit's desktop conventions carried into the terminal. Rule of thumb: if a line doesn't help you read the conversation or act on it, it doesn't render.

```
 Fix flaky login test                                     orbit · fix-login     41.2k  18%
 ▏ make the login test stop flaking                                                        
                                                                                           
   I'll look at the test and its fixtures first.                                           
                                                                                           
   ∗ Grep "login" (12 matches)                                                             
   → Read src/auth/login.test.ts                                                           
   ✎ Edit src/auth/login.test.ts  +4 −2                                                    
                                                                                           
   The test raced the session cookie; it now waits for it.                                 
                                                                                           
   ● Done · 38s · claude sonnet                                                            
 ▏ █                                                                                       
 ▏ Build  Claude Sonnet · fix-login                                                        
  esc interrupt                                     ctrl+k workspaces  tab profile  ctrl+p  
```

- **Blocks, not boxes.** Your messages and the input sit on a slightly raised background (`panel`) with a thin left bar, which plays the role of Orbit's chat bubble. Agent text sits flush on the base background. Borders appear only on overlays (palette, pickers).
- **Tool lines are quiet:** dim text, one glyph per kind (`∗` search, `→` read, `✎` edit with `+n −m`, `$` command, `⋯` running). A group collapses to one line ("5 tool calls") once the turn moves on. Enter on a group expands it.
- **Colour tokens** map from `src/index.css`: `run` (working spinner/bar), `ok`, `bad`, `warn`, `info`, `merged`, with `accent` = bright foreground. The rest is greys. Both themes are supported: Void (dark) by default, Paper (light), and a "terminal" theme that uses only the 16 ANSI colours. True colour is detected, with a 256-colour fallback.
- **Header:** the workspace title on the left; branch, tokens and context % on the right (from `AgentEvent::Usage`, the same numbers as `ContextMeter`).
- **Footer:** at most four key hints, which change with context.
- **Motion:** a dither sweep (`░▒▓`) in `run` colour on the active line while the agent works, echoing the desktop's running sweep. No other animation.
- **Start screen:** a small 1-bit Orbit mark (half-block characters, rendered from `src/assets/orbit.png`), the version, and recent workspaces. Nothing else.
- **Markdown:** headings, lists, inline code and fenced code highlighted with `syntect` (a theme built from the tokens). Diffs use `ok`/`bad` foregrounds, never full backgrounds.

## Screens

1. **Chat** (the default): the transcript, input and footer for one workspace.
2. **Workspaces** (Ctrl+K, or a left rail when the terminal is ≥ 120 columns): repo-grouped list with status dots, the attention reason from `attention.ts` (ported), and fuzzy filtering. Enter switches; `n` opens a new workspace.
3. **New workspace:** repo picker, task prompt, agent/model and profile. Enter starts it.
4. **Palette** (Ctrl+P): every other action (ship, diff, inbox, archive…), using the same command ids as `src/lib/keybindings.ts`. Actions that need more than a line (Ship status, a diff) open as a single overlay over the chat and close with Esc.

That's the whole app: one main screen, one list, one dialog, one palette. The inbox is the top of the workspace list (needs-you first), not a separate screen.

## Milestones

Each milestone ships on its own and gets a line in `CHANGELOG.md` (as "Preview:" until it's proven in a real-app run).

- **T0 Foundations.** Cargo workspace; `orbit-proto` extracted with `src-tauri` using it (no behaviour change, the e2e stays green); local loopback mode with a token file; `orbit --version` and `orbit ls` (plain-text list, also handy for scripts). *Done when:* `orbit ls` prints the running app's workspaces.
- **T1 Chat.** Full-screen chat for one workspace (`orbit` opens the most recent one, `orbit <name>` picks one): live transcript, input with multi-line editing (`tui-textarea`), send, Esc to interrupt, header usage, markdown and code highlighting, tool groups. *Done when:* you can hold a whole conversation from the terminal while the desktop app mirrors it.
- **T2 Fleet.** Workspace list (needs-you first) and rail, new workspace, status dots, notifications (terminal bell / OSC 9 when a turn finishes in another workspace).
- **T3 Skills and actions.** `/` skill autocomplete, `@` file mentions, profile switching (Tab), the palette, and the Diff and Ship overlays.
- **T4 In-app pane.** A "Terminal UI" nav item and palette entry in the desktop app, rendered as a full-pane xterm.js running the bundled `orbit` (`ORBIT_LOCAL_TOKEN` passed in the environment). The installer ships `orbit.exe` and can optionally add it to PATH.
- **T5 Headless (later).** Extract `orbit-core` so that `orbit --headless` can run agents without the desktop app (SSH, Linux, servers). Needs its own plan.

## Testing

- **Unit:** `update()` transitions, transcript folding (against `src-tauri/tests/fixtures/*.jsonl`), the attention port and key dispatch.
- **Snapshots:** `insta` + ratatui `TestBackend` render every screen at 80×24 and 140×40, in dark and ANSI-16. These are cheap and catch layout regressions.
- **Interop:** `orbit-proto`'s client runs against the real bridge server in `cargo test` (the same style as `interop_server`).
- **e2e:** a `tui` step in `scripts/e2e.mjs` drives `orbit` through a PTY against the real app (answering ConPTY's `ESC[6n` with `ESC[1;1R`): it sends a one-line haiku prompt and checks that the reply shows up in both the TUI screen and the desktop transcript.
- **Showcase:** VHS tapes in `docs/tui/` render GIFs for the README and releases.

## Open questions

- Loopback WebSocket or a named pipe / Unix socket for local mode? (WebSocket keeps one server; a pipe avoids port conflicts.)
- Is the binary name `orbit` free enough on PATH (an npm package or other tools)? The agent-identity trap in CLAUDE.md suggests checking.
- Should `orbit` start the desktop app when it isn't running, or just say so? (v1: say so, with the command to start it.)
- Mouse support: click to focus and scroll, yes; drag-select conflicts with terminal copy, so leave it off by default.
