# Feature matrix

What you want the IDE to do, and the honest state of each feature. **Edit the Priority column freely.** Agents working on this repo: update a row whenever you build or verify a feature, and never mark something ✅ without running it in the real app.

**Status**
- ✅ **Works**: verified in the real desktop app by `bun run e2e` (real UI, real agents) or by hand.
- 🟢 **Built**: code exists and its backend is tested, but it hasn't been exercised end to end in the real app yet.
- 🟡 **Partial**: works with known gaps (see notes).
- ⬜ **Planned**: wanted, not built.
- 💭 **Idea**: not decided yet.

**Priority:** P1 = core to "drive a fleet of agents and ship", P2 = important, P3 = nice to have.

_Last verified: 2026-10-18 (later that day: `bun run e2e` 46/46 (and `e2e:github` 10/10) with ten new steps for Settings, data and sessions and twelve for packs, routines, trunk gates and teammates; earlier, the 0.1.0 release audit): `bun run e2e` 23/23 and `bun run e2e:github` 7/7 after the audit fixes; installer built. 2026-10-12: `bun run e2e` 23/23 (adds teammates, hand-offs, Chief, routines, trunk save points / ship gate, simplify, local-model suggestions (skips without Ollama)). Before that, 2026-10-09: `bun run e2e` 16/16 (local, Claude haiku + Codex) and `bun run e2e:github` against a private sandbox repo (real PRs, CI, issues)._

## Real vs mock: verification ledger (2026-10-09)

**Totals:** 123 features: ✅ 56 · 🟢 48 · 🟡 7 · ⬜ 9 · 💭 3.

**Proven in the real app (✅)** by `bun run e2e` (16 steps, real Claude + Codex, local repo) and `bun run e2e:github` (7 steps, real PRs/CI/issues in the sandbox): worktree workspaces, Claude + Codex chat, streaming, tool groups, follow-ups, interrupt, resume after restart, inbox (reasons, AI suggestions, send, dismiss, snooze), profiles with enforced read-only + switching, skills (`/` autocomplete, pinned chips, native Claude skills), attached folders + discovery, Ship → draft PR → checks → ready → merge, Fix CI from the inbox, Issues panel Start/Plan, write-ticket, preflight, themes, Inter, greyscale UI, Ship panel toggle.

**Built but only verified in the mock UI / unit tests (🟢): needs its first real-app run.** Everything added on 2026-10-09 after the last full run is in this group:
- **Settings page** (all sections), and the wiring behind it: permission mode / sandbox, merge method + delete branch, notification toggles, default agent/model, AI-suggestion toggle and model.
- **Usage**: context meter, per-turn tokens, Usage report, **Compact context** and **New session** (Claude `/compact` parsing is fixture-tested against a real recording; the buttons haven't driven a real agent).
- **Data**: archived workspaces + Restore, merged-worktree cleanup, environment diagnostics.
- Earlier leftovers: OS notifications, archive workspace, New ticket dialog, `#n` issue chip, Codex mid-turn steer, Claude mid-turn queue, "Build this plan" hand-off, install pack by URL, per-repo always-attach, user plugins in workspaces, focus mode, start-page animation, app icon in the taskbar, installer build.

**Partial (🟡):** editable attached folders (worktree verified; shipping them as linked PRs across two repos is untested and needs a second sandbox repo), Address comments button, sidebar collapse-to-rail (mock only), model lists are hardcoded, folder picker (native dialog, can't be automated).

**Next full e2e run should add steps for:** settings round-trip (change prefix → new workspace branch uses it; switch Claude to Accept edits → a Bash write is denied), compact + new session against a real Claude turn (meter drops; new session forgets context), archive → restore, cleanup dry-run on a merged branch, New ticket → issue filed, Address comments on a PR with a review comment, linked PRs with a second sandbox repo.

## Fleet & workspaces

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Workspace = git worktree + branch per task | P1 | ✅ | e2e checks that files land in the worktree, never the main checkout |
| New workspace dialog (prompt, repo, agent, model), agent starts immediately | P1 | ✅ | Ctrl+N, Ctrl+Enter |
| Many workspaces running in parallel | P1 | ✅ | Claude and Codex workspaces side by side in e2e |
| Sidebar: repos → workspaces, status, diff stats, agent icon | P1 | ✅ | |
| Unread marker when a turn finishes in a background workspace | P2 | 🟢 | Now derived from persisted seen state |
| OS notification when an agent finishes or fails (window unfocused) | P2 | 🟢 | Not verified; Windows may need notification permission |
| Command palette (jump to workspace, run skill, actions) | P1 | 🟢 | VS Code default map; one rebindable registry for app/editor/terminal, chords with status hints, Settings recorder/search/conflicts/reset, live hints and palette commands. Pure smoke suite; real-app `keybindings` e2e step added, not run. |
| Ctrl+1–9 to jump to a workspace | P2 | ✅ | **Real-app e2e 2026-10-18 (`ui-shortcuts`).** |
| Archive workspace (removes worktree, keeps branch) | P2 | ✅ | **Real-app e2e 2026-10-18 (`archive-and-restore`).** Palette path with the confirm auto-accepted (`autoConfirm`); a dirty worktree is refused ("Uncommitted changes:") unless forced. |
| Add repository via folder picker | P1 | 🟡 | Backend verified; e2e calls it directly because the native picker can't be automated |
| **Attention inbox** (Alt+1): sessions that finished, failed, asked you something, or have failing checks / requested changes | P1 | ✅ | e2e: a workspace finishing in the background appears as Finished |
| Inbox: rule suggestions + AI suggestions (one-shot Haiku, no tools, ~$0.0002) sent with one click or a number key | P1 | ✅ | e2e: real Haiku suggestions load; key 3 sends one; the row leaves, then returns when done |
| Inbox: inline reply, Open (Enter), Dismiss (E; comes back on new activity), j/k navigation | P1 | ✅ | Dismiss + keys verified in e2e |
| Inbox "All" tab: every workspace and what it is doing (replaces the planned fleet board) | P1 | 🟢 | Verified in mock UI |
| Seen/dismissed state persisted across restarts | P1 | 🟢 | Unit-tested (`db::tests`) |
| Inbox: snooze a row (S = 1 hour, or menu: tomorrow 9:00, next week); snoozed rows show in All | P3 | ✅ | e2e `inbox-snooze`: snoozed row leaves Needs you, unsnoozed it returns |
| Inbox: focus stays on the same index (next row) after dismiss / snooze / send | P3 | 🟢 | Mock UI only |
| Archived workspaces list / restore (Settings > Data); recreates the worktree on the existing branch if it was removed | P3 | ✅ | **Real-app e2e 2026-10-18 (`archive-and-restore`).** Verified in mock UI; restore logic is Rust, not yet run against a real repo |
| **Settings page** (gear in sidebar, Ctrl+, , palette "Open settings"; Esc returns): left section nav, every change saves instantly with a "Saved" tick | P2 | 🟢 | Verified in mock UI. Typed settings blob in `settings.rs` (`get_settings` / `update_settings`), legacy keys still read |
| Settings: general (theme, branch prefix with live example, default agent + per-agent model, notifications and only-when-unfocused) | P2 | ✅ | **Real-app e2e 2026-10-18 (`settings-branch-prefix`).** Verified in mock UI; prefix, notifications and defaults are wired to workspace creation, `notify_turn_done`, New workspace / Issues / New ticket |
| Settings: agent safety (Claude permission mode, Codex sandbox, extra model ids) and tool diagnostics (`environment_info`, Re-check) | P2 | ✅ | **Real-app e2e 2026-10-18 (`settings-accept-edits` + `environment-diagnostics`).** Accept edits: a `node -e` write via Bash is denied while the Write tool works. (A plain `echo > file` is auto-approved by the Claude CLI in this mode.) Diagnostics show verified Claude and Codex paths. |
| Settings: GitHub merge method and delete remote branch after merge | P2 | 🟢 | Verified in mock UI; `gh pr merge --<method>` args unit-tested, remote ref deleted via `gh api` |
| Settings: skills and profiles overview, pinned-skill reorder / unpin, inbox AI suggestions on/off + model, shortcuts reference, data folder, about | P2 | 🟢 | Verified in mock UI; suggestions off skips the Haiku call entirely |
| Worktree cleanup for merged branches (Settings > Data: dry-run list, confirm, archives and removes clean worktrees, keeps branches) | P3 | ✅ | **Real-app e2e 2026-10-18 (`cleanup-merged-dry-run`).** Verified in mock UI; git/gh detection (`branch --merged`, PR MERGED) not yet run against a real repo |

## Agents & chat

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Claude Code via stream-json (streaming, tool calls) | P1 | ✅ | |
| Codex via app-server | P1 | ✅ | Binary lookup prefers a native codex.exe (PATH, or the one behind an npm shim, then the Codex app build, then ~/.codex/.sandbox-bin, then the VS Code extension); a process that exits mid-turn ends the turn as an error |
| Streaming text with caret, "Thinking" indicator | P1 | ✅ | |
| Tool calls folded into "N tool calls" groups, expandable with output | P1 | ✅ | |
| Follow-up messages in the same session | P1 | ✅ | |
| Interrupt with Esc / stop button | P1 | ✅ | Shown as "Interrupted", workspace goes idle, no error |
| Resume sessions after app restart | P1 | ✅ | e2e restarts the app and the agent remembers context |
| Steer Codex mid-turn (`turn/steer`) | P2 | ✅ | **Real-app e2e 2026-10-18 (`codex-steer`).** Steer sent while the turn ran; the reply ended with the steered word. |
| Claude: messages sent mid-turn get queued | P2 | ✅ | **Real-app e2e 2026-10-18 (`claude-midturn-queue`).** Second message sent during a tool call; it was answered after the first. |
| Model picker per workspace | P2 | 🟡 | Works (haiku in e2e), but the model lists are hardcoded |
| Load model lists from the CLIs (`codex model/list`) | P3 | ⬜ | |
| Change agent/model on an existing workspace | P3 | ⬜ | |
| Workspace context in system prompt (branch, base, issue) | P1 | ✅ | Verified in a live Claude session |
| **Workspace profiles**: Builder, Debugger, Planner, Reviewer, Shipper, Ticket writer (`shipkit/agents/*.md`, Claude agent format; any pack can add more) | P1 | ✅ | e2e: a Planner workspace refuses to create a file; after switching to Builder it creates it |
| Read-only profiles enforced, not just prompted (Claude: default permission mode + strict tool allowlist, which also blocks Bash writes; Codex: read-only sandbox) | P1 | ✅ | Verified live against the Claude CLI and in e2e |
| Profile picker in New workspace (always starts at Builder), switcher in the composer footer and palette; per-profile skill chips | P1 | ✅ | Switch verified in e2e |
| Switching profile mid-session tells the agent its role changed (one-shot hand-over note) | P1 | ✅ | Without it the resumed agent kept its old role |
| Inbox: "Build this plan" hand-off when a Planner finishes | P2 | ✅ | **Real-app e2e 2026-10-12 (`teammates-handoff`).** Unit logic only |
| Host env scrubbing (launching from inside Claude Code) | P1 | ✅ | |
| Approve or deny tool calls interactively | P3 | 💭 | Agents currently run unattended in worktrees |
| Image / file attachments in the composer | P3 | ⬜ | |
| Per-workspace and total cost tracking | P3 | ✅ | **Real-app e2e 2026-10-18 (`context-meter-and-compact` + `usage-report`).** Per-turn `tok · $` line, per-workspace and overall totals. Claude parser fixture-tested; Codex has tokens only (plan billing, no cost). Verified in mock |
| Context-window meter in the composer footer | P2 | ✅ | **Real-app e2e 2026-10-18 (`context-meter-and-compact`).** Bar + `% · used / window`, warn at 70%, bad at 90%; click for the session's tokens and cost. Claude and Codex parsers fixture-tested (`codex_usage_turn.jsonl` recorded from codex-cli 0.162); verified in mock |
| Compact context / New session | P2 | ✅ | **Real-app e2e 2026-10-18 (`context-meter-and-compact`).** Real Claude: `/compact` shrank the context (26k to 4k tokens); New session shows the divider and the agent forgot the word. |
| Usage report (Settings > Usage) | P3 | ✅ | **Real-app e2e 2026-10-18 (`usage-report`).** Today/7d/30d/All totals, 14-day chart, by workspace and agent. `UsageSection` is ready to mount; aggregation unit-tested; verified in mock |
| Full diff viewer / code review | P3 | 💭 | Deliberately deprioritised; the Changes list exists |

## Skills

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Bundled `shipkit` pack (only pack shipped with the app) | P1 | ✅ | `/shipkit:ship`, `preflight`, `fix-ci`, `address-comments`, `rebase`, `write-ticket`, `start-issue`, plus 6 profiles |
| `/` autocomplete across enabled packs, Tab to complete | P1 | ✅ | |
| Pinned skills as one-click chips above the composer | P1 | ✅ | e2e runs `rebase` via its chip |
| Pin / unpin skills | P1 | ✅ | **Real-app e2e 2026-10-18 (`pins-and-palette-skill`).** Pin and unpin in the Skill packs dialog add and remove the composer chip. Skill packs dialog |
| Skills in the command palette | P2 | **Real-app e2e 2026-10-18 (`pins-and-palette-skill`).** Ran a pack skill from the palette on a real Claude turn. 🟢 | |
| Claude runs pack skills natively (`--plugin-dir`, `/<plugin>:<name>`) | P1 | ✅ | |
| Codex runs pack skills (inlined by the IDE) | P1 | ✅ | **Real-app e2e 2026-10-18 (`codex-inlined-skill`).** A Codex workspace ran a pack command (inlined) and answered. Codex ignores skills it didn't discover itself, so the IDE inlines them; unit-tested |
| Install any skill pack by git URL | P2 | ✅ | **Real-app e2e 2026-10-18 (`packs-install-lifecycle`).** Installed through the dialog; the e2e rewrites a fake https host to a local repo with git `insteadOf`, since install only accepts https:// or git@. Indexer verified on a 387-skill pack; install not exercised in the real app |
| Enable / disable / update / remove packs | P2 | **Real-app e2e 2026-10-18 (`packs-install-lifecycle`).** Disable removes the command from `/` autocomplete, enable restores it, update pulls a new command, remove deletes the folder. 🟢 | |
| Per-workspace pack toggles | P3 | ⬜ | Currently global |
| Repo-local `.claude/skills` & `.claude/commands` in autocomplete | P3 | ⬜ | Claude already loads them natively when typed |
| **Attach folders** to a workspace (header chips, + Attach, palette); read-only by default; agents can read them (Claude `--add-dir`, Codex via context) | P1 | ✅ | e2e: Claude reads a marker word from an attached folder |
| Make an attached folder editable: own worktree + branch, shipped alongside (`ship.md` step 5) | P1 | 🟡 | e2e: worktree created, non-git refused, clean detach removes it; shipping it not yet run. Only a repo root, or a subfolder the repo actually tracks (monorepo package; the attachment then points at that subfolder inside the new worktree), can be made editable: a folder that merely sits inside a parent repo's ignored/untracked dir is refused (`git::editable_location`, unit-tested) |
| Related-project discovery (package.json / Cargo.toml / pyproject / go.mod, both directions) with one-click attach | P1 | ✅ | e2e: sibling consumer discovered as a dependent |
| Per-repo "always attach" folders | P2 | ✅ | **Real-app e2e 2026-10-18 (`always-attach`).** A new workspace gets the folder attached; after switching it off the next one does not. Verified in mock UI |
| User-installed Claude plugins (e.g. `codex@openai-codex`: `/codex:review`, `/codex:rescue`) usable in Claude workspaces | P2 | 🟢 | Workspace agents load user plugins; typing `/codex:review` passes through. Not run inside the IDE yet |
| User-installed Claude plugins listed in `/` autocomplete and as pinnable chips | P2 | ⬜ | Read from Claude's `system/init` `slash_commands` |

## Shipping & GitHub

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Ship panel: "no PR yet" state + Ship button | P1 | ✅ | |
| PR card: state, checks (pass/fail/pending, failing names), review decision | P1 | ✅ | GitHub e2e: draft PR card, green checks dot (third-party checks like CodeRabbit handled) |
| Fix CI / Address comments / Rebase / Push updates buttons | P1 | ✅ | **Real-app e2e 2026-10-18 (`address-comments`).** Address comments proven on a real PR with a line comment: the agent pushed a fixing commit (e2e:github). Fix CI verified on real GitHub (from the inbox); Address comments not yet exercised |
| Ready for review / Squash & merge (with confirm, gated on green checks) | P1 | ✅ | GitHub e2e: draft → ready → squash-merged through the panel buttons |
| `/shipkit:ship` end to end: commit, push, draft PR | P1 | ✅ | GitHub e2e (~20s on haiku) |
| `/shipkit:fix-ci`: syncs the branch, reads failing logs, fixes, pushes | P1 | ✅ | GitHub e2e: a teammate's stray commit breaks CI; one click on Fix CI in the inbox turns it green |
| PR status auto-refresh while checks run | P2 | 🟢 | |
| GitHub Issues panel per repo (Alt+5): search, labels, comment count, j/k, Start (Enter) / Plan (P) | P1 | ✅ | GitHub e2e lists real issues and starts/plans from them |
| New ticket dialog (notes → Ticket writer workspace running `/shipkit:write-ticket`) | P1 | ✅ | **Real-app e2e 2026-10-18 (`new-ticket-dialog`).** Palette > New ticket filed a real issue in the sandbox through the Ticket writer workspace (e2e:github). Mock only |
| Start a workspace from an issue (branch `<n>-slug`, issue context, `Closes #n`); Start runs `/shipkit:start-issue`, Plan asks a read-only Planner for a plan | P1 | ✅ | GitHub e2e: Start → implemented + shipped PR with `Closes #n`; Plan → plan written, zero file changes |
| `#n` chip in the workspace header opens the linked issue (`issue_url` via `gh issue view`) | P2 | ✅ | **Real-app e2e 2026-10-18 (`issue-chip`).** The chip shows in the header and `issue_url` returns the github.com URL (the click itself opens a browser and is not exercised). Not run against real GitHub |
| `/shipkit:write-ticket` (notes → formatted GH issue) | P1 | ✅ | GitHub e2e files a real issue |
| `/shipkit:preflight`: pre-ship spot check of boundary changes; searches this repo and attached folders for consumers; Safe/Risky/Breaking report | P1 | ✅ | e2e: renaming an export is reported Breaking with the consumer's file:line and an alias fix (even on haiku) |

## UI & look

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Keyboard shortcuts and command palette (Ctrl+Shift+P / F1) | P1 | 🟢 | VS Code defaults, rebindable app/editor/terminal commands, chord status, live hints; searchable Settings recorder with conflicts, unbind and reset. Registry smoke passes; real-app `keybindings` e2e added, not run. |
| Void (dark, default) / Paper (light) themes, Ctrl+K Ctrl+T | P1 | ✅ | Native title bar follows |
| Greyscale chrome; colour only for function (running, done, error, diff, PR state) | P1 | ✅ | Seen in real-app e2e screenshots; accent switcher removed by request |
| Inter everywhere in the UI (mono only for code), bundled offline | P1 | ✅ | Seen in real-app e2e screenshots |
| Dither: rules, selected-row fade, running sweeps, progress | P1 | ✅ | |
| Black-hole brand mark (sidebar logo + app icon) from `src/assets/orbit.png` | P1 | 🟢 | Icon set generated; check it in the taskbar after a build |
| Start page: black hole with a planet orbiting (passes behind the horizon) | P2 | 🟢 | Verified in mock UI; respects reduced motion |
| Native confirm dialogs (archive, merge, remove pack) | P2 | 🟢 | |
| Product name: **Orbit** | P1 | ✅ | Crate, binary, window, identifier `io.github.sgranquist13.orbit` (was `dev.steven.orbit` until 2026-10-18), data dir `~/.orbit` (auto-migrates `~/.agentic-ide`) |
| Focus layout: Ship panel hidden until you click **Ship** in the header (Ctrl+Shift+G), never opens on its own; header hint shows PR # + checks dot or changed-file count | P1 | ✅ | e2e opens/closes it; verified in mock UI |
| Narrower, quieter sidebar (216px); collapses to an icon rail (Ctrl+B) | P1 | 🟡 | Slim sidebar seen in the real app; collapse-to-rail only checked in mock |
| Wider chat column (880px) and bigger composer | P1 | ✅ | Seen in real-app e2e screenshots |
| Focus mode (Ctrl+K Z): hides sidebar and Ship panel | P2 | ✅ | **Real-app e2e 2026-10-18 (`ui-shortcuts`).** Ctrl+K Z hides and restores the sidebar. |
| Responsive layout below ~1000px | P3 | ⬜ | Partly covered by the sidebar rail |

## Platform & dev

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Windows desktop app (Tauri 2) | P1 | ✅ | Built with the VS 2022 toolchain (`bun run app`) |
| Installer (`bun run app:build`) | P2 | 🟢 | Built 2026-10-18: NSIS `Orbit_0.1.0_x64-setup.exe` (5.85 MiB, unsigned). Not yet installed on a clean profile |
| UI mock mode for design iteration (`bun run dev`) | P1 | ✅ | Same components as the real app; fake data |
| Real-app e2e (`bun run e2e`) | P1 | ✅ | Needs `bun run dev` running and a debug build; shares `scripts/e2e-harness.mjs` |
| GitHub e2e (`bun run e2e:github`): real PRs, CI, merge, issues in a private sandbox (`ORBIT_GH_SANDBOX`) | P1 | ✅ | Opt-in; creates and closes PRs/issues in the sandbox |
| Rust unit tests incl. recorded agent fixtures | P1 | ✅ | 30 passing + 3 opt-in live tests |
| macOS / Linux | P3 | 💭 | Tauri supports them; untested |

## Mobile bridge (phone app: `ide_mobile`)

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Encrypted WebSocket bridge (`src-tauri/src/remote/`): handshake, NaCl box frames, RPC allowlist (snapshot, events, send, interrupt, markSeen, registerPush), live event + workspace mirroring | P2 | ✅ | Protocol in `ide_mobile/docs/protocol.md`. Verified 2026-10-09 by hand on an iPhone (Expo Go) against the real app: pair, inbox, send from phone, live streaming, stop. Cargo tests: fake backend + real WebSocket clients (pair, auth, bad/expired/replayed code, unknown device, revoke), tweetnacl vector; opt-in `interop_server` test runs the phone app's own client against the real server. No `scripts/e2e.mjs` step yet |
| Settings > Mobile: allow connections, port, status + addresses (Tailscale first), pairing QR with countdown, paired phones + Revoke, push toggle; palette "Pair a phone" | P2 | ✅ | Allow, status, pairing QR and paired list used for real on 2026-10-09. Revoke not yet tried in the real app |
| Push notification on finished turn (Expo; name + status only) | P3 | 🟢 | Body builder unit-tested; EAS project linked in the phone app, real delivery not yet confirmed |

## Routines, git flow, simplify (PLANNING #6–#8, decided 2026-10-10)

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Routines: a chat message on a schedule (once, hourly, daily, weekdays, weekly; cron under Advanced), fresh or standing workspace, Routines view from a sidebar button (Alt+3), clock button in the composer to schedule the current message, Run now, history; runs only while Orbit is open, missed runs catch up once on launch; clean no-op runs archive themselves | P2 | 🟡 | **Real-app e2e 2026-10-18 (`routine-scheduler-tick` / `routine-standing-workspace` / `routine-owned-by-teammate`).** Also proven: the 30 s scheduler tick runs a once routine by itself (and switches it off), a standing routine reuses one workspace across two Run nows, an owned routine becomes a Scheduled task in the teammate thread. **Real-app e2e 2026-10-12 (20/20).** Run now → quiet run → archived → listed in the view proven (`routines`); the scheduler tick, standing workspaces and the Simplify action are not exercised yet. Built 2026-10-10. 15 Rust unit tests (schedule maths incl. DST gap/fold, due-run planning, quiet decision, DB round trip) and the mock UI (view, editor, chat popover) are verified. **Real-app e2e step `routines` is written but not run yet**; untested in the real app: the scheduler tick, a real unattended run, quiet auto-archive, notification deferral, the standing-workspace path, skills as the action. Phone push for non-quiet runs goes through the normal turn path (deferred until the quiet check). Templates (4, incl. Weekly simplify) live in `src/lib/routines.ts`. Wired 2026-10-10 (integration pass, unit-tested, **not run in the real app**): a run's summary is now written by `llm::Task::RoutineSummary` (`{summary, nothingToDo}`, async after the run row is finished; the last-assistant-text summary is the fallback and the row never waits on the model; `nothingToDo` with no changed files also makes a fresh run quiet), and a **Simplify action** (editor "What": Message / Simplify recent changes; Weekly simplify = Fridays 16:00): fresh workspace on a `refactor/` branch, Find over the last 7 days of changes on base (`Scope::Since`), apply every low-risk candidate unattended, then `prepare_ship` + `shipkit:ship` so a draft PR opens; nothing found or applied = quiet. The run finishes with the ship turn (the pass's own edit turns are swallowed by `finish_turn` via a per-workspace stage). Not covered: a real unattended Simplify run end to end; the model-quiet flip can archive a run after its notification already fired; a quiet archive is not pushed to the phone (see PLANNING Inbox) |
| Per-repo check command (auto-detected, overridable) run by Orbit itself | P1 | ✅ | **Real-app e2e 2026-10-18 (`checks-autodetect`).** Auto-detect proven: `npm run test` found from package.json, passes, and blocks when the script fails. **Real-app e2e 2026-10-12 (20/20).** Override path proven (`trunk-save-points`); auto-detection not exercised in the real app. `checks.rs` (`detect` / `run`, reusable by Simplify); override per repo in Settings > Git. Rust unit-tested; real-app e2e step `trunk-save-points` written, not yet run. Hardened 2026-10-10: per-run timeout (Settings > Git, default 10 min; kills the process tree, result says timed out; unit-tested with a sleeping command) and a one-time dependency install (`bun install` / `pnpm` / `yarn --frozen-lockfile` / `npm ci`, or `npm install` when there is no lockfile) in a worktree with `package.json` but no `node_modules`, and only when package.json declares dependencies and the check command runs through npm/npx/bun/bunx/pnpm/yarn (pure decision fn unit-tested; the install itself not exercised against a real package manager). Install failures and timeouts carry their own `kind` and a last output line ("dependencies failed to install" / "timed out after N min") so the inbox doesn't read them as code failures. Not changed: sync does not re-run checks after an auto-rebase |
| Save-point commits by Orbit after each turn with changes; unpushed `wip:` commits squashed before Ship; Undo last turn | P1 | ✅ | **Real-app e2e 2026-10-18 (`undo-last-turn`).** Undo last turn also proven through the palette. **Real-app e2e 2026-10-12 (20/20).** `trunk.rs`; temp-repo unit tests for commit, squash range, undo (incl. pushed refusal). Settings: save points, squash. Palette: Undo last turn. e2e step written, not run. 2026-10-10: Settings > Git "Save-point messages" = From the prompt (default) / Written by a model: `Task::CommitMessage` over the staged stat + a capped diff (8k chars) and your message, always `wip:`-prefixed, bounded by the local timeout and falling back to the prompt message on any failure (prompt builder, message cleanup, fallback and timeout unit-tested; no live model call made) |
| Ship gate: Orbit runs checks before Ship; failing → inbox "Checks failed" with Fix / Ship anyway | P1 | ✅ | **Real-app e2e 2026-10-18 (`trunk-warn-and-ship-anyway`).** Warn mode proven: ship proceeds, the workspace is flagged, the inbox offers Ship anyway, and skipping the checks clears it. **Real-app e2e 2026-10-12 (20/20).** Block mode proven; Warn / Ship anyway not exercised. `prepare_ship` (`prepare_ship_inner`, also used by the Simplify routine; returns `notes`); with Settings > Models "PR description drafts" set to a local model, Orbit drafts the PR title/body from the diff and Ship passes it to `shipkit:ship` as its notes argument (not drafted at Default; builder unit-tested, not run live); Settings > Git: Off / Warn / Block (unit-tested gate logic). Ship panel buttons and inbox "Ship it" / "Push updates" go through it. Checks run in the worktree with a timeout (Settings > Git) |
| Auto-sync idle, clean workspaces onto `origin/<base>`; conflicts → inbox "Needs sync" with agent resolve | P1 | 🟢 | Background loop + `sync_now`; Off / Suggest only / Automatic and interval in Settings > Git; stale thresholds. Rebase conflict + abort tested on temp repos. Never while the agent is running (re-checked before rebasing). Checks are not re-run after an auto-rebase |
| Overlap detection between live workspaces; after a merge, overlapping workspaces sync first | P2 | 🟢 | Changed-file intersection (not a `merge-tree` dry run); quiet line in the Ship panel |
| After merge: auto archive + remove worktree + delete branch; long-lived/far-behind branches surface in the inbox | P2 | ✅ | **Real-app GitHub e2e 2026-10-18:** merging from the Ship panel archived the workspace. `merge_pr` returns `{ archived }`; both steps are Settings toggles; skipped when the worktree is dirty or has unpushed commits. Stale reason in the inbox |
| Simplify button (workspace header, beside Ship) + palette "Simplify changes": read-only find pass → candidate list → apply one at a time, Orbit checks + commits `refactor:` or reverts | P2 | ✅ | **Real-app e2e 2026-10-12 (20/20).** Find + apply with a passing check proven (`simplify`). `simplify.rs` + `SimplifyPanel.tsx`. Find = one-shot `claude -p` (tools limited to Read/Grep/Glob, JSON schema; always Claude, model in Settings > Git, default Sonnet) over the diff vs base, test files and lockfiles excluded. Apply = a turn on the workspace's own session per candidate (shows as "Simplify: <title>" in the chat), then Orbit reverts (`reset --hard` + `clean`) on touched test files, failing/timed-out checks or an agent error, or commits `refactor: <title>`; no change is marked no-op; no check command → applied "unchecked". Cancel reverts the step in flight. State is in memory (lost on restart). Unit-tested: test-path detection, step decision, find-output parsing, scope budget, commit/revert/no-op on temp repos, prompts. Live `#[ignore]` test: Haiku flags an over-nested function and edits nothing. Mock UI verified; real-app e2e step `simplify` written, not run. Also a routine action (2026-10-10): `Scope::Since { days }` reads what landed on base in a window (`build_scope_since`, temp-repo tested incl. a window past the first commit) and `run_unattended` finds + applies low-risk candidates without the panel (summary builder unit-tested; the unattended flow itself not run for real). Not covered: edits to inline `#[cfg(test)]` modules or test code in non-test paths are not detected; Codex workspaces apply fine but the find pass is still Claude; inbox offers a Simplify chip on finished workspaces with more than 300 changed lines |

## Local models (PLANNING #9, built 2026-10-10)

| Feature | Priority | Status | Notes |
|---|---|---|---|
| `llm.rs`: every utility model call through `llm::complete_json` (Claude CLI one-shot, Ollama `/api/chat`, OpenAI-compatible `/v1/chat/completions`), per-task fallback, last error per backend | P2 | 🟢 | Unit-tested (request building, reply parsing, planning, fallback rules). Live: `live_ollama_round_trip` passed against Ollama 0.16.1 + `llama3.2:3b` (valid JSON in ~2 s warm, ~33 s cold load). OpenAI-compatible path only unit-tested (no LM Studio here) |
| Inbox suggestions through `llm` (Claude default, local optional) | P2 | 🟢 | Claude path is the old `suggest_prompts` code moved; opt-in e2e step `local-model-suggestions` (skipped without Ollama) not run yet |
| Workspace names from the first prompt (local or Claude; off by default; only replaces the auto-derived name, never the branch/path) | P3 | 🟢 | Name cleaning + derived-name check unit-tested; not run live |
| CommitMessage / RoutineSummary / PrDescription tasks | P2 | 🟢 | All three have callers as of the 2026-10-10 integration: save points (Settings > Git, opt-in), routine summaries (every finished run), PR drafts (only for a local model). Prompt builders, reply parsing and fallbacks are unit-tested; no live model calls yet |
| Settings > Models: provider, URL, key, timeout, live status, installed models + Test, per-task model, "Use local for all", Default Claude model | P2 | 🟢 | Mock-verified; `local_models_status` / `test_local_model` commands tested only via the live test and mock |
| Experimental: run agents on local models (`local:<model>` in the New Workspace picker; Claude Code via `ANTHROPIC_BASE_URL`, Codex via `model_provider="ollama"`) | P3 | 🟡 | Live-checked: both CLIs connect and finish a turn against Ollama. Small models (3B, 7B coder) could not complete a tool call under Claude Code. Cost/context meter are wrong for local models. Spawn args/env unit-tested; not run through Orbit itself |

## AI teammates (PLANNING #10, decided 2026-10-12)

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Teammates nav item (top nav, needs-you badge, Alt+4, collapsed rail) opening a Teammates view: list of teammates (avatar, last message, time, status dot, search, "+") beside the selected thread | P1 | 🟢 | Reworked 2026-10-12 from a sidebar section; mock-verified in dark/light and collapsed. Remembers the last teammate (localStorage); palette "Ask a teammate…" and inbox rows open the view on that teammate; small label on workspace rows/headers. Status derivation is unit-tested; first real-app run is the `teammates` e2e step (updated to use the view, not rerun) |
| Teammate avatars v2 (reference-style gradient blobs: 14 shapes, 8 colours, 6 expressions, role badge, accessories; `avatar: shape:colour[:expression[:badge[:accessory]]]`, legacy values fall back to a pick from the name; picker with Shuffle in the editor; blink while working) | P2 | 🟢 | The one colour exception (`--avatar-*` tokens, both themes). Mock-verified only |
| Teammate thread: hand a task in chat; the teammate creates the workspace(s) itself and reports back with links and a result | P1 | ✅ | **Real-app e2e 2026-10-12 (21/21):** custom teammate → task in its thread → own workspace → report back (`teammates`). Rust: `teammate_send` (new task vs continue, repo choice), tables `teammate_messages` / `teammate_tasks`, `workspaces.teammate`, report on `TurnCompleted` via `llm::Task::TeammateReport` (own Settings > Models row) with the agent's last message as fallback. Delegation, repo choice, routing, report parsing/fallback and persistence are unit-tested; the UI flow only against the mock's scripted reports. Not yet run with a real agent. Teammates stop at a draft PR by instruction only (no enforcement). Phone mirroring not built |
| Teammate memory (notes file it reads and appends to, editable) | P2 | ✅ | **Real-app e2e 2026-10-18 (`teammate-memory-append`).** The teammate appended the code word to its memory file after a task. **Real-app e2e 2026-10-18 (`teammate-crud-and-memory`).** The editor Memory tab writes the notes file on disk (verified); the agent appending is still unverified. `~/.orbit/teammates/<slug>.memory.md`, last 4 KB injected into each new session's context with the instruction to append learnings; Claude gets the folder via `--add-dir`, Codex only the path (its workspace-write sandbox may refuse the write). Editable in the editor's Memory tab. Excerpt cap and context text unit-tested; the agent actually appending is unverified. Edits apply to the next session, not a running one |
| Starter team (Chief, Builder, Debugger, Planner, Reviewer, Shipper, Ticket writer) + create/edit custom teammates from the UI | P1 | ✅ | **Real-app e2e 2026-10-18 (`teammate-crud-and-memory`).** Create, edit, override a starter and reset it to default, all verified. Definitions are markdown + frontmatter (`src-tauri/shipkit/teammates/*.md`, custom ones in `~/.orbit/teammates/`); a same-slug custom file overrides a starter one and "Reset to default" deletes it. Parse/render round-trip, override and reset unit-tested; editor dialog mock-verified |
| Chief: splits a vague request into parts for other teammates; plan card with Start all / Edit / Cancel; dependent parts wait and start by themselves; combined report | P2 | ✅ | **Real-app e2e 2026-10-18 (`chief-edit-cancel`).** Edit (retarget parts) and Cancel before Start proven: nothing runs and the plan cannot be started. **Real-app e2e 2026-10-12 (23/23, `chief`):** plan → parts in dependency order → combined report. `chief.rs`. Messaging Chief runs one planning call (`llm::Task::ChiefPlan`, own Settings > Models row, Claude by default, not an agent session: it needs the request, the repo's top-level listing and the team's descriptions, not tools) and posts the plan as a card in its thread. Start creates one task per part through `teammates::start_task` (the same path as a direct message); parts with `dependsOn` start when those tasks are `done`, with the earlier summaries + branches added to their brief; the combined report is one `TeammateReport` call over the child summaries (fallback: a list). `parent_task_id` of a child is the plan id (`origin_kind` chief); child cards read "from Chief". Chief is needs-you while a plan awaits Start or a part failed/asks, working while it plans or parts run. Plan parsing (unknown slugs dropped, indices remapped, cycles rejected), scheduling, status, briefs and persistence are unit-tested; UI verified in the mock only. **e2e `chief` written (haiku planning call, then the plan is pinned to two throwaway teammates so no starter teammate runs a costly turn), never run.** Edit lets you retarget/remove parts and set dependencies. A cancelled running plan stops starting parts; running ones finish. Never merges: children stop at draft PRs by instruction only |
| Hand-off chips on a finished report: rule-based defaults by role (Planner -> Builder; Builder/Debugger -> Reviewer; Reviewer with findings -> Builder; any PR -> Shipper) plus a "Hand to…" picker | P2 | ✅ | **Real-app e2e 2026-10-12 (`teammates-handoff`).** `handoff.rs`, command `teammate_handoff(fromTaskId, toSlug, note?)`. Brief = their summary, branch, changed files, PR link and a role-specific job line. Workspace per role: Reviewer = new read-only worktree starting at the source branch's tip; Shipper (and a Builder/Debugger fixing a Reviewer's findings, which goes back to the branch that was reviewed) = the **same workspace/branch** when the agent matches (the workspace takes over the new role via the profile-switch note), else a worktree from the branch tip; everything else = a fresh worktree from base. Source thread gets "Handed to X", the target card "from <teammate>". "Findings" and "has a PR" are text heuristics on the report. Chip rules, workspace choice, brief and PR/findings detection unit-tested; the same-workspace adoption and the worktree-from-branch path have **no real-app run**. e2e `teammates-handoff` written, never run |
| Teammate routines: a routine's optional Owner; its runs are tasks in the teammate's thread marked Scheduled; clock button in the thread composer; Routines line in the header | P3 | ✅ | **Real-app e2e 2026-10-18 (`routine-owned-by-teammate`).** Run now of an owned routine created a Scheduled task in the thread and reported (clock button in the composer not clicked). `routines.teammate` column; `launch` routes an owned message routine through `teammates::start_task` (origin `routine`); the run row still finishes through `routines::finish_turn` (quiet runs archive). Only message routines can be owned (skills / Simplify can't), always a fresh workspace per run, agent/model come from the teammate; Chief can't own one. Routing + validation + DB round trip unit-tested; UI mock-verified; **no real-app run** (a scheduled owned run has not fired for real). A quiet owned run still posts its report in the thread |

## Code view: built-in IDE (PLANNING #12, built 2026-10-18)

A global **Code** view (sidebar, Ctrl+Shift+O) on CodeMirror 6 that opens any folder: a repo, any workspace's worktree, or any folder. Rust in `src-tauri/src/code/` (fs behind a path guard, watcher, search, file at a git revision, PTY); UI in `src/components/code/`, store `src/stores/code.ts`, helpers in `src/lib/code/`. Real-app e2e steps: `code-shell`, `code-panels`, `code-live` (one Haiku turn). Pure helpers are covered by `bun scripts/code-smoke.ts`, `code-panels-smoke.ts`, `code-live-smoke.ts`; the backend by 10 `code::` Rust tests (path guard incl. symlink escape, write conflict, binary/too-large, ordering + gitignore, search flags/UTF-16 columns/globs/cap/cancel, file at rev from a subfolder, a real shell echo through the PTY).

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Code shell: folder switcher (repos, workspace worktrees, recent, Open folder), explorer (create/rename/delete to recycle bin, ignored files dimmed), preview/pinned tabs, CodeMirror editor themed for Void and Paper, lazy languages, Ctrl+S / Ctrl+Shift+S, Ctrl+P quick open, find/replace, go to line | P1 | ✅ | **Real-app e2e 2026-10-18 (`code-shell`).** Open, edit, save to disk, clean-buffer reload after an outside write (native watcher), quick open, both themes. Explorer context-menu actions and Open folder are mock-verified only |
| Integrated terminal: xterm + ConPTY, several tabs, restart on exit, Ctrl+` toggle, Ctrl+Shift+C/V | P1 | ✅ | **Real-app e2e 2026-10-18 (`code-panels`).** A real pwsh echoes a command. Keystrokes typed before the shell has an id are buffered. Shell from Settings > Editor (default pwsh → powershell → cmd) |
| Project search (Ctrl+Shift+F): regex / case / whole word, include/exclude globs, grouped results, click to jump | P1 | ✅ | **Real-app e2e 2026-10-18 (`code-panels`).** Capped at 2,000 matches, skips binary and > 1 MB files, superseded searches cancel |
| Git gutter vs HEAD and side-by-side diff (vs HEAD / vs base) | P2 | ✅ | **Real-app e2e 2026-10-18 (`code-panels`).** Added-file gutter and the diff toggle. "vs base" is mock-verified only |
| **Watch mode: live view of the agent editing your files.** Follows the agent to the file it touches (preview tab), reloads as it lands, flashes the changed lines, agent gutter marks for this turn, run dots on tabs and tree, agent strip ("Editing path" / latest message, Stop), Activity timeline per turn with +/- and click-to-diff against the turn's baseline; read-only while the agent runs | P1 | ✅ | **Real-app e2e 2026-10-18 (`code-live`).** A real Haiku Edit shows in the timeline, the editor follows it, the agent gutter appears, and the per-turn diff shows before/after. Claude `Write`/`Edit`/`MultiEdit`/`NotebookEdit` and Codex `Edit` are tracked, plus watcher changes while the agent runs. Codex edits are unit-tested only |
| Manual mode: no follow; clean buffers reload silently, dirty ones get "Changed on disk by <workspace>: Reload · Keep mine · Compare"; saves check mtime | P1 | 🟢 | Mock-verified 2026-10-18 (a chosen Manual survives agent turns; banner, Compare, keep mine). The `conflict:` write path is Rust-tested; not yet driven in the real app |
| Ask about selection (Ctrl+I in the editor): send the lines + a question to the folder's workspace, or a new workspace | P2 | ✅ | **Real-app e2e 2026-10-18 (`code-live`).** Ctrl+I opens Ask in the editor, and "New workspace" prefills the dialog. Sending to the linked workspace is mock-verified |
| Open in Code entry points: chat header button, Ship panel changed files (opens with the diff), palette entries | P2 | ✅ | **Real-app e2e 2026-10-18 (`code-live`)** uses the chat header button. Ship-panel click and palette entries are mock-verified |
| Settings > Editor: font size, tab size, word wrap, autosave (off / after a pause / on focus change), follow the agent, terminal shell | P2 | 🟢 | Mock-verified; applied live through CM compartments. Autosave never saves a buffer with a disk conflict |

## Mock vs real

The mock (`bun run dev` in a browser) renders the **same components** as the real app, so styling matches exactly. The differences are all in the data:
- Every mock workspace shows the same canned transcript, and the only "streaming" is a scripted sentence.
- The mock always returns an open PR with failing checks; the real app asks `gh`.
- Mock actions (send, run skill, install pack) do nothing.
