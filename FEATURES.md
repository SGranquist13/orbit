# Features & roadmap

What Orbit does today and where it's heading. For how features were designed, and ideas still being explored, see [PLANNING.md](PLANNING.md).

**Status**
- ✅ **Available**: shipped and verified end to end in the real app.
- 🧪 **Preview**: built and usable, still being validated before it's marked available.
- 🗺️ **Planned**: on the roadmap.
- 💭 **Exploring**: an idea we're considering.

## Roadmap

**Next**
- Per-repo setup and run scripts, with `.env` and other ignored files copied into new worktrees
- Claude and Codex plan limits (5-hour and weekly windows) in Usage
- MCP servers added once for both agents
- Comment on diff lines and send them to the agent
- Rewind a workspace to any earlier turn
- Linked pull requests across repositories (ship an attached project's changes alongside the main PR)
- Your installed Claude plugins in `/` autocomplete and as pinnable chips
- Teammates and archived workspaces mirrored to the phone app
- Public release of the iPhone companion app

**Later**
- Change the agent or model of an existing workspace
- Repo-local `.claude/skills` and `.claude/commands` in autocomplete
- Responsive layout for narrow windows
- Setup options (attach folders) right in the New workspace dialog

**Exploring**
- Approving or denying tool calls interactively
- A full code-review view
- macOS and Linux builds

## Fleet & workspaces

| Feature | Status | Notes |
|---|---|---|
| One git worktree + branch per task | ✅ | Agents never touch your main checkout |
| New workspace dialog (prompt, repo, agent, model, profile); the agent starts at once | ✅ | Ctrl+N, Ctrl+Enter |
| Create a workspace without a task | 🧪 | Empty prompt = **Create** (idle worktree, composer focused); optional name |
| Open a workspace in VS Code, Cursor, Zed, Windsurf or JetBrains | 🧪 | Header button and palette; pick the editor in Settings > Editor |
| Many workspaces running in parallel, Claude and Codex side by side | ✅ | |
| Sidebar: repos → workspaces with status, diff stats and agent icon | ✅ | Collapses to an icon rail (Ctrl+B) |
| Rename a workspace; right-click menu (rename, reveal in Explorer, archive) | 🧪 | |
| Unread marker when a background workspace finishes | 🧪 | |
| OS notification when an agent finishes or fails | 🧪 | Only when the window is unfocused (configurable) |
| Command palette: jump to a workspace, run a skill, any action | ✅ | Ctrl+Shift+P / F1 |
| Ctrl+1–9 to jump to a workspace | ✅ | |
| Archive a workspace (removes the worktree, keeps the branch) and restore it later | ✅ | Restore recreates the worktree if needed |
| Add a repository with the folder picker | ✅ | |
| **Attention inbox** (Alt+1): what finished, failed, asked you something, or has failing checks / requested changes | ✅ | |
| Inbox suggestions: instant rule-based ones plus AI suggestions, sent with one click or a number key | ✅ | |
| Inbox: inline reply, open, dismiss (returns on new activity), snooze, j/k navigation | ✅ | |
| Inbox "All" tab: every workspace and what it's doing | 🧪 | |
| Clean up worktrees of merged branches (Settings > Data, with a dry run) | ✅ | |

## Agents & chat

| Feature | Status | Notes |
|---|---|---|
| Claude Code and Codex, streamed live (text, thinking, tool calls) | ✅ | Tool calls fold into expandable groups |
| Follow-ups, interrupt (Esc), resume after restart | ✅ | |
| **Images and file attachments**: paste, drop or attach images and files; images go to the agent natively, files as paths it reads with its own tools | ✅ | Thumbnails, file chips and a lightbox in the chat |
| Images from the agent (a screenshot it reads, Codex image view / generation, markdown images) shown in the chat | 🧪 | |
| Steer Codex mid-turn; Claude queues messages sent mid-turn | ✅ | |
| Model picker per workspace | ✅ | |
| Model lists from the agent CLIs | ✅ | Codex catalog, Claude aliases, custom model ids; refresh in Settings > Agents or the palette |
| Workspace context in the agent's system prompt (branch, base, linked issue) | ✅ | |
| **Profiles**: Builder, Debugger, Planner, Reviewer, Shipper, Ticket writer | ✅ | Switch mid-session; the agent is told its new role |
| Roles are optional: no role by default, "+ Add role" in New workspace, a default role in Settings > General, "No role" in the chat footer | 🧪 | |
| Read-only profiles enforced by the agent's sandbox and tool allowlist, not just by the prompt | ✅ | |
| "Build this plan" from the inbox when a Planner finishes | 🧪 | |
| Agents and the commands they start stop with Orbit, even after a crash | 🧪 | |
| Context-window meter, per-turn tokens and cost, Usage report | ✅ | Codex shows tokens (plan billing) |
| Compact context / New session | ✅ | |
| Safe launch from inside another Claude Code session (host environment scrubbed) | ✅ | |

## Skills

| Feature | Status | Notes |
|---|---|---|
| Bundled **shipkit** pack: ship, preflight, fix-ci, address-comments, rebase, write-ticket, start-issue | ✅ | |
| `/` autocomplete across enabled packs | ✅ | Tab to complete |
| Pinned skills as one-click chips, with a preview before they run | ✅ | Pin and unpin in the Skill packs dialog |
| Skills in the command palette | ✅ | |
| Claude runs pack skills natively; Orbit inlines them for Codex | ✅ | |
| Install any skill pack by git URL; enable, disable, update, remove | ✅ | |
| Per-workspace skill pack toggles | 🧪 | Turn off globally enabled packs for a workspace; skills and profiles follow the workspace selection |
| **Attach folders** to a workspace so agents can read related projects | ✅ | Read-only by default |
| Make an attached project editable (its own worktree and branch) | ✅ | Shipping it as a linked PR is on the roadmap |
| Related-project discovery (package.json, Cargo.toml, pyproject, go.mod) with one-click attach | ✅ | |
| Per-repo "always attach" folders | ✅ | |
| Your installed Claude plugins work inside Claude workspaces | 🧪 | e.g. `/codex:review` |

## Shipping & GitHub

| Feature | Status | Notes |
|---|---|---|
| Ship panel (Ctrl+Shift+G): PR state, checks, review decision | ✅ | Opens only when you ask for it |
| One-click Ship: commit, push, draft PR | ✅ | |
| Fix CI, Address comments, Rebase, Push updates | ✅ | Fix CI also one click from the inbox |
| Ready for review and merge, gated on green checks | ✅ | Merge method and branch deletion in Settings > Git |
| Live PR status while checks run | 🧪 | |
| GitHub Issues panel (Alt+5): search, labels, Start or Plan from an issue | ✅ | Branch `<n>-slug`, `Closes #n` in the PR |
| New ticket: rough notes → a well-formed GitHub issue | ✅ | |
| `#n` chip in the header opens the linked issue | ✅ | |
| **Preflight**: checks boundary changes against consumers in this repo and attached projects (Safe / Risky / Breaking) | ✅ | |

## Routines, git flow & simplify

| Feature | Status | Notes |
|---|---|---|
| **Routines** (Alt+3): a message on a schedule (once, hourly, daily, weekdays, weekly, or cron), in a fresh or standing workspace | ✅ | Run now, history; runs while Orbit is open, missed runs catch up once; no-op runs tidy themselves away |
| Weekly Simplify routine (opens a `refactor/` draft PR) | 🧪 | |
| Save points after every turn with changes, squashed before Ship; Undo last turn | ✅ | |
| Per-repo check command, auto-detected or set by you | ✅ | Timeout and one-time dependency install |
| Ship gate: checks run before Ship (Off / Warn / Block) with "Ship anyway" | ✅ | |
| After merge: archive, remove the worktree, delete the branch | ✅ | Each step is a setting |
| Auto-sync idle workspaces onto the latest base; conflicts land in the inbox | 🧪 | Never while an agent is running |
| Overlap detection between live workspaces | 🧪 | |
| **Simplify** button: find simplifications, apply them one at a time; Orbit runs the checks and commits or reverts each | ✅ | |
| AI-written save-point messages and PR descriptions | 🧪 | Settings > Models |

## Local models

| Feature | Status | Notes |
|---|---|---|
| Point Orbit's small utility calls (suggestions, names, commit messages, summaries, PR drafts) at Ollama or any OpenAI-compatible server | 🧪 | Per task, with automatic fallback to Claude |
| Settings > Models: connection status, installed models, Test, per-task choice | 🧪 | |
| Workspace names from the first prompt | 🧪 | Off by default |
| Run an agent on a local model (experimental) | 🧪 | Best with larger, tool-capable models |

## AI teammates

| Feature | Status | Notes |
|---|---|---|
| **Teammates** (Alt+4): named agents you hand tasks to in a chat thread; each creates its own workspaces and reports back | ✅ | Stops at a draft PR |
| Starter team (Chief, Builder, Debugger, Planner, Reviewer, Shipper, Ticket writer) and your own custom teammates | ✅ | Saved as markdown files you can edit |
| Teammate memory: a notes file it reads and adds to | ✅ | Editable in the teammate's Memory tab |
| **Chief**: splits a request into parts for the team, runs them in order, sends one combined report | ✅ | Edit or cancel the plan before it starts |
| Hand-off chips on a report (Planner → Builder, Builder → Reviewer, …) plus "Hand to…" | ✅ | |
| Teammate-owned routines | ✅ | |
| Avatars: colourful blob faces with shapes, expressions and accessories | 🧪 | |

## Code view: built-in editor

| Feature | Status | Notes |
|---|---|---|
| **Code view** (Alt+2): explorer, tabs, CodeMirror editor themed for Void and Paper, quick open (Ctrl+P), find/replace, go to line | ✅ | Opens any repo, workspace or folder |
| Integrated terminal (several tabs) | ✅ | Ctrl+` |
| Project search with regex, case, whole word and globs | ✅ | Ctrl+Shift+F |
| Git gutter and side-by-side diff (vs HEAD / vs base) | ✅ | |
| **Watch mode**: follow the agent as it edits, with change flashes, gutter marks and a per-turn activity timeline | ✅ | Read-only while the agent runs |
| Live typing: see the agent's edits stream in as they are written | 🧪 | |
| "Watch an agent" picker on any folder | 🧪 | |
| Manual mode: edit by hand; agent changes never overwrite unsaved work silently | 🧪 | Reload · Keep mine · Compare |
| Ask about a selection (Ctrl+I) | ✅ | Sends the lines + your question to the workspace's agent |
| Open in Code from the chat header, Ship panel and palette | ✅ | |
| Settings > Editor: font size, tabs, word wrap, autosave, follow the agent, terminal shell | 🧪 | |

## Look & feel

| Feature | Status | Notes |
|---|---|---|
| Void (dark) and Paper (light) themes | ✅ | Ctrl+K Ctrl+T |
| Greyscale interface; colour only carries meaning (running, done, error, diff, PR state) | ✅ | |
| Inter for the interface, JetBrains Mono for code, bundled offline | ✅ | |
| Focus layout: Ship panel on demand, wide chat column | ✅ | |
| Focus mode: hide everything but the chat | ✅ | Ctrl+K Z |
| **VS Code keybindings everywhere**, rebindable in Settings > Keyboard shortcuts (record keys and chords, conflicts, reset) | 🧪 | |
| Black-hole brand mark and animated start page | ✅ | |

## Phone companion

| Feature | Status | Notes |
|---|---|---|
| Encrypted bridge to the iPhone app: pair with a QR code, follow every workspace live, send and stop from your phone | 🧪 | The phone app isn't publicly released yet |
| Settings > Mobile: allow connections, pairing, paired phones | 🧪 | |
| Push notification when a turn finishes (name and status only) | 🧪 | |

## Platform

| Feature | Status | Notes |
|---|---|---|
| Windows 10/11 desktop app (Tauri 2) with installer | ✅ | Latest: v0.2.0 ([changelog](CHANGELOG.md)) |
| Content-security-policy in every build | ✅ | |
| Continuous integration (licence checks, typecheck, Rust tests and lints) | ✅ | |
| Tested with an end-to-end suite that drives the real app with real agents and real GitHub | ✅ | |
