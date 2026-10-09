# Feature matrix

What you want the IDE to do, and the honest state of each feature. **Edit the Priority column freely.** Agents working on this repo: update a row whenever you build or verify a feature, and never mark something ✅ without running it in the real app.

**Status**
- ✅ **Works**: verified in the real desktop app by `bun run e2e` (real UI, real agents) or by hand.
- 🟢 **Built**: code exists and its backend is tested, but it hasn't been exercised end to end in the real app yet.
- 🟡 **Partial**: works with known gaps (see notes).
- ⬜ **Planned**: wanted, not built.
- 💭 **Idea**: not decided yet.

**Priority:** P1 = core to "drive a fleet of agents and ship", P2 = important, P3 = nice to have.

_Last verified: 2026-10-08, `bun run e2e` 15/15 twice (Claude haiku + Codex default, local repo without a remote)._

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
| Inbox: snooze a row; focus moves to the neighbouring row after dismiss | P3 | ⬜ | Small follow-ups |
| Archived workspaces list / restore | P3 | ⬜ | |
| Settings UI (branch prefix, default agent/model, worktree location) | P2 | ⬜ | Stored settings exist; no UI |
| Worktree cleanup for merged branches | P3 | ⬜ | |

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
| Per-workspace and total cost tracking | P3 | 🟡 | Per-turn cost/duration shown for Claude only |
| Full diff viewer / code review | P3 | 💭 | Deliberately deprioritised; the Changes list exists |

## Skills

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Bundled `shipkit` pack (only pack shipped with the app) | P1 | ✅ | `/shipkit:ship`, `fix-ci`, `address-comments`, `rebase`, `write-ticket`, `start-issue` |
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
| PR card: state, checks (pass/fail/pending, failing names), review decision | P1 | 🟢 | Parser unit-tested; never run against a real PR |
| Fix CI / Address comments / Rebase / Push updates buttons | P1 | 🟢 | Each runs the matching shipkit skill; Rebase verified |
| Ready for review / Squash & merge (with confirm, gated on green checks) | P1 | 🟢 | Not run against a real PR |
| `/shipkit:ship` end to end: commit, push, draft PR | P1 | 🟢 | Needs a test GitHub repo to verify |
| PR status auto-refresh while checks run | P2 | 🟢 | |
| GitHub Issues panel per repo | P1 | ⬜ | Milestone 6 |
| Start a workspace from an issue (branch `<n>-slug`, issue context, `Closes #n`) | P1 | 🟡 | Backend supports `issue_number` + context; no UI yet |
| `/shipkit:write-ticket` (notes → formatted GH issue) | P1 | 🟢 | Skill exists; not run against GitHub |
| `/shipkit:preflight`: pre-ship spot check of boundary changes; searches this repo and attached folders for consumers; Safe/Risky/Breaking report | P1 | 🟢 | Skill written and pinned by default; needs a real cross-project run |

## UI & look

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Void (dark, default) / Paper (light) themes, Ctrl+Shift+L | P1 | ✅ | Native title bar follows |
| Greyscale chrome; colour only for function (running, done, error, diff, PR state) | P1 | 🟢 | Verified in mock UI; accent switcher removed by request |
| Inter everywhere in the UI (mono only for code), bundled offline | P1 | 🟢 | Verified in mock UI |
| Dither: rules, selected-row fade, running sweeps, progress | P1 | ✅ | |
| Black-hole brand mark (sidebar logo + app icon) from `src/assets/orbit.png` | P1 | 🟢 | Icon set generated; check it in the taskbar after a build |
| Start page: black hole with a planet orbiting (passes behind the horizon) | P2 | 🟢 | Verified in mock UI; respects reduced motion |
| Native confirm dialogs (archive, merge, remove pack) | P2 | 🟢 | |
| Product name: **Orbit** | P1 | 🟢 | Crate, binary, window, identifier `dev.steven.orbit`, data dir `~/.orbit` (auto-migrates `~/.agentic-ide`) |
| Focus layout: Ship panel hidden until you click **Ship** in the header (Ctrl+.), never opens on its own; header hint shows PR # + checks dot or changed-file count | P1 | ✅ | e2e opens/closes it; verified in mock UI |
| Narrower, quieter sidebar (216px); collapses to an icon rail (Ctrl+B) | P1 | 🟢 | Verified in mock UI |
| Wider chat column (880px) and bigger composer | P1 | 🟢 | Verified in mock UI |
| Focus mode (Ctrl+\): hides sidebar and Ship panel | P2 | 🟢 | Verified in mock UI |
| Responsive layout below ~1000px | P3 | ⬜ | Partly covered by the sidebar rail |

## Platform & dev

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Windows desktop app (Tauri 2) | P1 | ✅ | Built with the VS 2022 toolchain (`bun run app`) |
| Installer (`bun run app:build`) | P2 | 🟢 | Never run |
| UI mock mode for design iteration (`bun run dev`) | P1 | ✅ | Same components as the real app; fake data |
| Real-app e2e (`bun run e2e`) | P1 | ✅ | Needs `bun run dev` running and a debug build |
| Rust unit tests incl. recorded agent fixtures | P1 | ✅ | 28 passing + 3 opt-in live tests |
| macOS / Linux | P3 | 💭 | Tauri supports them; untested |

## Mock vs real

The mock (`bun run dev` in a browser) renders the **same components** as the real app, so styling matches exactly. The differences are all in the data:
- Every mock workspace shows the same canned transcript, and the only "streaming" is a scripted sentence.
- The mock always returns an open PR with failing checks; the real app asks `gh`.
- Mock actions (send, run skill, install pack) do nothing.
