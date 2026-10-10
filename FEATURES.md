# Feature matrix

What you want the IDE to do, and the honest state of each feature. **Edit the Priority column freely.** Agents working on this repo: update a row whenever you build or verify a feature, and never mark something ✅ without running it in the real app.

**Status**
- ✅ **Works**: verified in the real desktop app by `bun run e2e` (real UI, real agents) or by hand.
- 🟢 **Built**: code exists and its backend is tested, but it hasn't been exercised end to end in the real app yet.
- 🟡 **Partial**: works with known gaps (see notes).
- ⬜ **Planned**: wanted, not built.
- 💭 **Idea**: not decided yet.

**Priority:** P1 = core to "drive a fleet of agents and ship", P2 = important, P3 = nice to have.

_Last verified: 2026-10-09: `bun run e2e` 16/16 (local, Claude haiku + Codex) and `bun run e2e:github` against a private sandbox repo (real PRs, CI, issues)._

## Real vs mock: verification ledger (2026-10-09)

**Totals:** 100 features: ✅ 49 · 🟢 36 · 🟡 5 · ⬜ 7 · 💭 3.

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
| Command palette (jump to workspace, run skill, actions) | P1 | ✅ | Ctrl+K |
| Ctrl+1–9 to jump to a workspace | P2 | 🟢 | |
| Archive workspace (removes worktree, keeps branch) | P2 | 🟢 | Uses a native confirm dialog, which e2e can't click |
| Add repository via folder picker | P1 | 🟡 | Backend verified; e2e calls it directly because the native picker can't be automated |
| **Attention inbox** (Ctrl+I): sessions that finished, failed, asked you something, or have failing checks / requested changes | P1 | ✅ | e2e: a workspace finishing in the background appears as Finished |
| Inbox: rule suggestions + AI suggestions (one-shot Haiku, no tools, ~$0.0002) sent with one click or a number key | P1 | ✅ | e2e: real Haiku suggestions load; key 3 sends one; the row leaves, then returns when done |
| Inbox: inline reply, Open (Enter), Dismiss (E; comes back on new activity), j/k navigation | P1 | ✅ | Dismiss + keys verified in e2e |
| Inbox "All" tab: every workspace and what it is doing (replaces the planned fleet board) | P1 | 🟢 | Verified in mock UI |
| Seen/dismissed state persisted across restarts | P1 | 🟢 | Unit-tested (`db::tests`) |
| Inbox: snooze a row (S = 1 hour, or menu: tomorrow 9:00, next week); snoozed rows show in All | P3 | ✅ | e2e `inbox-snooze`: snoozed row leaves Needs you, unsnoozed it returns |
| Inbox: focus stays on the same index (next row) after dismiss / snooze / send | P3 | 🟢 | Mock UI only |
| Archived workspaces list / restore (Settings > Data); recreates the worktree on the existing branch if it was removed | P3 | 🟢 | Verified in mock UI; restore logic is Rust, not yet run against a real repo |
| **Settings page** (gear in sidebar, Ctrl+, , palette "Open settings"; Esc returns): left section nav, every change saves instantly with a "Saved" tick | P2 | 🟢 | Verified in mock UI. Typed settings blob in `settings.rs` (`get_settings` / `update_settings`), legacy keys still read |
| Settings: general (theme, branch prefix with live example, default agent + per-agent model, notifications and only-when-unfocused) | P2 | 🟢 | Verified in mock UI; prefix, notifications and defaults are wired to workspace creation, `notify_turn_done`, New workspace / Issues / New ticket |
| Settings: agent safety (Claude permission mode, Codex sandbox, extra model ids) and tool diagnostics (`environment_info`, Re-check) | P2 | 🟢 | Verified in mock UI; modes go through `SessionConfig` (args unit-tested), idle sessions restart on change; read-only profiles stay enforced |
| Settings: GitHub merge method and delete remote branch after merge | P2 | 🟢 | Verified in mock UI; `gh pr merge --<method>` args unit-tested, remote ref deleted via `gh api` |
| Settings: skills and profiles overview, pinned-skill reorder / unpin, inbox AI suggestions on/off + model, shortcuts reference, data folder, about | P2 | 🟢 | Verified in mock UI; suggestions off skips the Haiku call entirely |
| Worktree cleanup for merged branches (Settings > Data: dry-run list, confirm, archives and removes clean worktrees, keeps branches) | P3 | 🟢 | Verified in mock UI; git/gh detection (`branch --merged`, PR MERGED) not yet run against a real repo |

## Agents & chat

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Claude Code via stream-json (streaming, tool calls) | P1 | ✅ | |
| Codex via app-server | P1 | ✅ | |
| Streaming text with caret, "Thinking" indicator | P1 | ✅ | |
| Tool calls folded into "N tool calls" groups, expandable with output | P1 | ✅ | |
| Follow-up messages in the same session | P1 | ✅ | |
| Interrupt with Esc / stop button | P1 | ✅ | Shown as "Interrupted", workspace goes idle, no error |
| Resume sessions after app restart | P1 | ✅ | e2e restarts the app and the agent remembers context |
| Steer Codex mid-turn (`turn/steer`) | P2 | 🟢 | Implemented, not exercised |
| Claude: messages sent mid-turn get queued | P2 | 🟢 | Claude CLI queues them; not exercised |
| Model picker per workspace | P2 | 🟡 | Works (haiku in e2e), but the model lists are hardcoded |
| Load model lists from the CLIs (`codex model/list`) | P3 | ⬜ | |
| Change agent/model on an existing workspace | P3 | ⬜ | |
| Workspace context in system prompt (branch, base, issue) | P1 | ✅ | Verified in a live Claude session |
| **Workspace profiles**: Builder, Debugger, Planner, Reviewer, Shipper, Ticket writer (`shipkit/agents/*.md`, Claude agent format; any pack can add more) | P1 | ✅ | e2e: a Planner workspace refuses to create a file; after switching to Builder it creates it |
| Read-only profiles enforced, not just prompted (Claude: default permission mode + strict tool allowlist, which also blocks Bash writes; Codex: read-only sandbox) | P1 | ✅ | Verified live against the Claude CLI and in e2e |
| Profile picker in New workspace (always starts at Builder), switcher in the composer footer and palette; per-profile skill chips | P1 | ✅ | Switch verified in e2e |
| Switching profile mid-session tells the agent its role changed (one-shot hand-over note) | P1 | ✅ | Without it the resumed agent kept its old role |
| Inbox: "Build this plan" hand-off when a Planner finishes | P2 | 🟢 | Unit logic only |
| Host env scrubbing (launching from inside Claude Code) | P1 | ✅ | |
| Approve or deny tool calls interactively | P3 | 💭 | Agents currently run unattended in worktrees |
| Image / file attachments in the composer | P3 | ⬜ | |
| Per-workspace and total cost tracking | P3 | 🟢 | Per-turn `tok · $` line, per-workspace and overall totals. Claude parser fixture-tested; Codex has tokens only (plan billing, no cost). Verified in mock |
| Context-window meter in the composer footer | P2 | 🟢 | Bar + `% · used / window`, warn at 70%, bad at 90%; click for the session's tokens and cost. Claude and Codex parsers fixture-tested (`codex_usage_turn.jsonl` recorded from codex-cli 0.162); verified in mock |
| Compact context / New session | P2 | 🟢 | Popover buttons and palette entries. Claude sends `/compact`; Codex `thread/compact/start`; New session clears the stored session id and adds a divider. Verified in mock, not against real agents |
| Usage report (Settings > Usage) | P3 | 🟢 | Today/7d/30d/All totals, 14-day chart, by workspace and agent. `UsageSection` is ready to mount; aggregation unit-tested; verified in mock |
| Full diff viewer / code review | P3 | 💭 | Deliberately deprioritised; the Changes list exists |

## Skills

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Bundled `shipkit` pack (only pack shipped with the app) | P1 | ✅ | `/shipkit:ship`, `preflight`, `fix-ci`, `address-comments`, `rebase`, `write-ticket`, `start-issue`, plus 6 profiles |
| `/` autocomplete across enabled packs, Tab to complete | P1 | ✅ | |
| Pinned skills as one-click chips above the composer | P1 | ✅ | e2e runs `rebase` via its chip |
| Pin / unpin skills | P1 | 🟢 | Skill packs dialog |
| Skills in the command palette | P2 | 🟢 | |
| Claude runs pack skills natively (`--plugin-dir`, `/<plugin>:<name>`) | P1 | ✅ | |
| Codex runs pack skills (inlined by the IDE) | P1 | 🟢 | Codex ignores skills it didn't discover itself, so the IDE inlines them; unit-tested |
| Install any skill pack by git URL | P2 | 🟢 | Indexer verified on a 387-skill pack; install not exercised in the real app |
| Enable / disable / update / remove packs | P2 | 🟢 | |
| Per-workspace pack toggles | P3 | ⬜ | Currently global |
| Repo-local `.claude/skills` & `.claude/commands` in autocomplete | P3 | ⬜ | Claude already loads them natively when typed |
| **Attach folders** to a workspace (header chips, + Attach, palette); read-only by default; agents can read them (Claude `--add-dir`, Codex via context) | P1 | ✅ | e2e: Claude reads a marker word from an attached folder |
| Make an attached folder editable: own worktree + branch, shipped alongside (`ship.md` step 5) | P1 | 🟡 | e2e: worktree created, non-git refused, clean detach removes it; shipping it not yet run |
| Related-project discovery (package.json / Cargo.toml / pyproject / go.mod, both directions) with one-click attach | P1 | ✅ | e2e: sibling consumer discovered as a dependent |
| Per-repo "always attach" folders | P2 | 🟢 | Verified in mock UI |
| User-installed Claude plugins (e.g. `codex@openai-codex`: `/codex:review`, `/codex:rescue`) usable in Claude workspaces | P2 | 🟢 | Workspace agents load user plugins; typing `/codex:review` passes through. Not run inside the IDE yet |
| User-installed Claude plugins listed in `/` autocomplete and as pinnable chips | P2 | ⬜ | Read from Claude's `system/init` `slash_commands` |

## Shipping & GitHub

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Ship panel: "no PR yet" state + Ship button | P1 | ✅ | |
| PR card: state, checks (pass/fail/pending, failing names), review decision | P1 | ✅ | GitHub e2e: draft PR card, green checks dot (third-party checks like CodeRabbit handled) |
| Fix CI / Address comments / Rebase / Push updates buttons | P1 | 🟡 | Fix CI verified on real GitHub (from the inbox); Address comments not yet exercised |
| Ready for review / Squash & merge (with confirm, gated on green checks) | P1 | ✅ | GitHub e2e: draft → ready → squash-merged through the panel buttons |
| `/shipkit:ship` end to end: commit, push, draft PR | P1 | ✅ | GitHub e2e (~20s on haiku) |
| `/shipkit:fix-ci`: syncs the branch, reads failing logs, fixes, pushes | P1 | ✅ | GitHub e2e: a teammate's stray commit breaks CI; one click on Fix CI in the inbox turns it green |
| PR status auto-refresh while checks run | P2 | 🟢 | |
| GitHub Issues panel per repo (Ctrl+Shift+G): search, labels, comment count, j/k, Start (Enter) / Plan (P) | P1 | ✅ | GitHub e2e lists real issues and starts/plans from them |
| New ticket dialog (notes → Ticket writer workspace running `/shipkit:write-ticket`) | P1 | 🟢 | Mock only |
| Start a workspace from an issue (branch `<n>-slug`, issue context, `Closes #n`); Start runs `/shipkit:start-issue`, Plan asks a read-only Planner for a plan | P1 | ✅ | GitHub e2e: Start → implemented + shipped PR with `Closes #n`; Plan → plan written, zero file changes |
| `#n` chip in the workspace header opens the linked issue (`issue_url` via `gh issue view`) | P2 | 🟢 | Not run against real GitHub |
| `/shipkit:write-ticket` (notes → formatted GH issue) | P1 | ✅ | GitHub e2e files a real issue |
| `/shipkit:preflight`: pre-ship spot check of boundary changes; searches this repo and attached folders for consumers; Safe/Risky/Breaking report | P1 | ✅ | e2e: renaming an export is reported Breaking with the consumer's file:line and an alias fix (even on haiku) |

## UI & look

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Void (dark, default) / Paper (light) themes, Ctrl+Shift+L | P1 | ✅ | Native title bar follows |
| Greyscale chrome; colour only for function (running, done, error, diff, PR state) | P1 | ✅ | Seen in real-app e2e screenshots; accent switcher removed by request |
| Inter everywhere in the UI (mono only for code), bundled offline | P1 | ✅ | Seen in real-app e2e screenshots |
| Dither: rules, selected-row fade, running sweeps, progress | P1 | ✅ | |
| Black-hole brand mark (sidebar logo + app icon) from `src/assets/orbit.png` | P1 | 🟢 | Icon set generated; check it in the taskbar after a build |
| Start page: black hole with a planet orbiting (passes behind the horizon) | P2 | 🟢 | Verified in mock UI; respects reduced motion |
| Native confirm dialogs (archive, merge, remove pack) | P2 | 🟢 | |
| Product name: **Orbit** | P1 | ✅ | Crate, binary, window, identifier `dev.steven.orbit`, data dir `~/.orbit` (auto-migrates `~/.agentic-ide`) |
| Focus layout: Ship panel hidden until you click **Ship** in the header (Ctrl+.), never opens on its own; header hint shows PR # + checks dot or changed-file count | P1 | ✅ | e2e opens/closes it; verified in mock UI |
| Narrower, quieter sidebar (216px); collapses to an icon rail (Ctrl+B) | P1 | 🟡 | Slim sidebar seen in the real app; collapse-to-rail only checked in mock |
| Wider chat column (880px) and bigger composer | P1 | ✅ | Seen in real-app e2e screenshots |
| Focus mode (Ctrl+\): hides sidebar and Ship panel | P2 | 🟢 | Verified in mock UI |
| Responsive layout below ~1000px | P3 | ⬜ | Partly covered by the sidebar rail |

## Platform & dev

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Windows desktop app (Tauri 2) | P1 | ✅ | Built with the VS 2022 toolchain (`bun run app`) |
| Installer (`bun run app:build`) | P2 | 🟢 | Never run |
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
| Routines: a chat message on a schedule (once, hourly, daily, weekdays, weekly; cron under Advanced), fresh or standing workspace, Routines view from a sidebar button (Ctrl+Shift+E), clock button in the composer to schedule the current message, Run now, history; runs only while Orbit is open, missed runs catch up once on launch; clean no-op runs archive themselves | P2 | 🟢 | Built 2026-10-10. 15 Rust unit tests (schedule maths incl. DST gap/fold, due-run planning, quiet decision, DB round trip) and the mock UI (view, editor, chat popover) are verified. **Real-app e2e step `routines` is written but not run yet**; untested in the real app: the scheduler tick, a real unattended run, quiet auto-archive, notification deferral, the standing-workspace path, skills as the action. Phone push for non-quiet runs goes through the normal turn path (deferred until the quiet check). Templates (3) live in `src/lib/routines.ts`; a Weekly simplify template comes with Simplify |
| Per-repo check command (auto-detected, overridable) run by Orbit itself | P1 | ⬜ | Shared by the ship gate and Simplify |
| Save-point commits by Orbit after each turn with changes; unpushed `wip:` commits squashed before Ship; Undo last turn | P1 | ⬜ | |
| Ship gate: Orbit runs checks before Ship; failing → inbox "Checks failed" with Fix / Ship anyway | P1 | ⬜ | |
| Auto-sync idle, clean workspaces onto `origin/<base>`; conflicts → inbox "Needs sync" with agent resolve | P1 | ⬜ | Never while the agent is running |
| Overlap detection between live workspaces; after a merge, overlapping workspaces sync first | P2 | ⬜ | |
| After merge: auto archive + remove worktree + delete branch; long-lived/far-behind branches surface in the inbox | P2 | ⬜ | |
| Simplify button: read-only find pass → candidate list → apply one at a time, Orbit checks + commits `refactor:` or reverts | P2 | ⬜ | |

## Mock vs real

The mock (`bun run dev` in a browser) renders the **same components** as the real app, so styling matches exactly. The differences are all in the data:
- Every mock workspace shows the same canned transcript, and the only "streaming" is a scripted sentence.
- The mock always returns an open PR with failing checks; the real app asks `gh`.
- Mock actions (send, run skill, install pack) do nothing.
