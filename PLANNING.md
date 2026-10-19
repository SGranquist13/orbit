# Orbit: planning

Working notes for features we're thinking about. **Nothing here gets built until it's agreed.** Ideas start in the Inbox, get shaped together, and once decided move to [FEATURES.md](FEATURES.md) as ⬜ planned (that file tracks what's built).

## Inbox

Raw ideas, as they come. Unsorted, unfiltered.

- Phone mirror of teammates: threads (and the teammate status) should reach `ide_mobile` like workspaces do. Needs a protocol change in `ide_mobile/docs/protocol.md` first (a `teammates` snapshot plus `teammate-message` / `teammate-status` pushes, and a `teammate_send` RPC). Note `Workspace` now serializes a new `teammate` field (additive, the phone ignores it).
- Phone mirror: a workspace that Orbit archives itself (a quiet routine run) or the user archives never reaches the phone as gone, because `Workspace` has no archived flag and the protocol has no "workspace removed" message; it only disappears at the next `snapshot`. Needs a protocol change in `ide_mobile/docs/protocol.md` first (e.g. `{"t":"workspace-removed","workspaceId"}`), then `remote::publish_*` from `archive_inner`.

## Shaping

### 12. Orbit Code: a built-in IDE with a live view of the agent (decided 2026-10-18, building)

An almost-complete IDE inside Orbit for building and playing by hand, and above all a **live view of the agent changing your files**.

- **Engine:** our own IDE shell on CodeMirror 6 (CM6 does the text-editing core; Orbit owns the shell and the look). Monaco rejected: looks like VS Code. A from-scratch text engine rejected: months before it beats a textarea.
- **Placement:** a global **Code** view (nav item, Ctrl+Shift+O) that opens any folder: a repo, any workspace's worktree, or any folder ("Open any worktree").
- **Watch mode** (a workspace folder while its agent runs): the editor follows the agent, opens the file it touches, reloads as it changes, flashes the changed lines, shows "Editing path" and an activity timeline per turn. Buffers are read-only while it runs.
- **Manual mode:** a normal IDE. Agent changes reload clean buffers silently; dirty buffers get "Changed on disk: Reload · Compare · Keep mine"; saves check mtime so an agent edit is never overwritten silently.
- **Ask about selection (Ctrl+K):** send the selected lines plus a question to the folder's workspace agent (or a new workspace).
- **Core:** file tree (create/rename/delete to recycle bin), tabs, save/autosave, quick open, find/replace, project search, integrated terminal (xterm + portable-pty), git gutter and diff vs HEAD/base, Settings > Editor.
- Rust `src-tauri/src/code/` (fs with a path guard, watcher, search, pty); UI `src/components/code/`, store `src/stores/code.ts`; IPC contract `codeApi` / `ptyApi` / `codeEvents` in `ipc.ts`.

### 11. Create a workspace without a task (built, mock-verified)
The New workspace dialog's prompt is optional: empty = **Create** (worktree + branch, agent idle, composer focused, Attach / profile available), text = **Start** as before. Optional name field (kept over the auto-namer). Backend needed no change (`create_workspace` already takes an optional prompt). Later: setup controls (attach folders) inside the dialog, a Settings default for which action is primary, cleanup of idle never-started workspaces, "not started" label in sidebar/inbox.

Ideas we're actively working through: the problem, a rough sketch, open questions.

### 10. AI teammates (standalone feature)

**Decided (2026-10-12):** build it with the proposed defaults (Teammates section above the repo list; stop at a draft PR; hand-offs via Chief or explicit chips; custom teammates from the UI, saved as files). Phase 1: teammates, threads, delegation, memory, custom teammates. Phase 2: Chief splitting work, hand-off chips, teammate routines. **Phase 2 built 2026-10-12 (all 🟢, see FEATURES.md):** Chief plans via a utility model call and runs the plan; hand-off chips by role plus a picker; routines can be owned by a teammate (Owner picker, clock button in the thread).

**Want (user's idea):** hand a task to a dedicated agent, a coworker, and get finished work back. Reference: Grok Bot (2026-10-12 screenshot): a sidebar of named teammates (Chief, Sales Outbound, Inbox Manager, ...), each with an avatar, last-message preview and time; you message one, it works with its tools and comes back with "Done".

**Standalone, not a replacement for profiles.** Profiles stay as the per-workspace mode (see below). A teammate is a separate thing: a persistent, named identity you delegate to, which can itself use a profile/role for its workspaces.

**Sketch (Orbit's version, coding-focused):**
- **A teammate** = name + avatar (greyscale glyph; colour only for status) + instructions + default agent/model + permissions (read-only enforced where set) + skills/packs + repos it may work in + **its own memory** (a notes file it reads and appends to) + **its own routines** (#6).
- **One thread per teammate** in a Teammates section of the sidebar: "Reviewer: 2 PRs reviewed, 1 needs you". You message the teammate; for each task it **creates the workspaces itself** (worktree + branch, as today) and reports back in its thread with links. You can still open those workspaces.
- **Status like a person:** working on X / waiting for you / done, feeding the attention inbox (#2) and the phone.
- **Starter team:** Builder, Debugger, Planner, Reviewer, Shipper, Ticket writer, plus a **Chief** that takes a vague request, splits it and hands parts to the others (the orchestrator pattern used in this repo).
- **Hand-offs:** Planner finishes → "hand to Builder" chip; Builder ships → Reviewer gets a review task.
- **Tools beyond code (later):** per-teammate MCP connectors; browser/computer use is a separate, bigger step.

**Open questions (proposed defaults in brackets):**
- Where in the UI? [a Teammates section above the repo list, plus a palette "Ask a teammate..."]
- Memory: per teammate, or per teammate x repo? [per teammate, with a repo section; user-editable]
- Can teammates message each other directly, or only via you / Chief? [via Chief or explicit hand-off chips in v1]
- Autonomy: ship PRs alone, or stop at "ready for you"? [stop at a draft PR, as routines do]
- Custom teammates from the UI (name, avatar, instructions, model)? [yes; saved in the same agent file format]

**Profiles stay** (user, 2026-10-12): they are the per-workspace mode, like Cline's / Roo's modes and similar features in other harnesses. Possibly rename them to **Modes** to match that convention (note: Claude Code also uses "mode" for permission modes, which Orbit shows in Settings > Agents). Undecided.

### 6. Routines (scheduled runs)

**Decided (2026-10-10):** a built-in app feature, not a skill: a **Routines button in the sidebar** opens the Routines view; the scheduler runs in the Rust core.

**Want:** Work that runs on a schedule without you starting it, e.g. "every weekday at 9: triage new issues", "nightly: run the checks and fix anything broken", "every Friday: simplify this week's changes" (#8).

**Problem:** Orbit only acts when you type. Recurring chores (triage, dependency bumps, CI babysitting, cleanup) depend on you remembering them, opening a workspace and pasting the same prompt.

**Sketch:**
- **A routine** = name + repo + schedule + action + agent/profile + **where it runs**:
  - *action*: a free prompt, or one of Orbit's built-in actions (Simplify #8, Sync with base #7, Fix CI, Clean up merged worktrees);
  - *fresh workspace each run* (new worktree + branch, named `<routine>-<date>`): for jobs that produce a PR;
  - *one standing workspace* reused every run: for running logs / triage notes.
- **Schedule:** presets (hourly, daily at HH:MM, weekdays, weekly on X) with cron underneath. Event triggers later (checks failed, new issue labelled X, base moved).
- **Scheduler in the Rust core** (`routines.rs`: a tick task beside the session manager; routines + run history in SQLite). Missed runs while Orbit was closed: run once on launch, never replay every miss.
- **Runs land in the attention inbox (#2)** as a normal workspace with reason "Routine finished" / "Routine failed". Runs with nothing to do archive themselves.
- **Routines view**, opened from its sidebar button (next to the inbox, with a small count of active routines; also in the palette): New routine, enable/pause, next run, last status, Run now, history linking to each run's workspace. Built-in templates (issue triage, nightly checks, weekly simplify, stale-branch sweep), off by default.
- **Guardrails:** max concurrent routine runs, per-routine token budget (`usage.rs`), and routines can open a draft PR but never merge.
- **Phone:** routine results reach the mobile app like any finished turn.

**Open questions (proposed defaults in brackets):**
- Only while Orbit is open, or a background service / OS scheduled task that launches it? [only while open; missed runs catch up on launch]
- Fresh workspace per run or standing workspace? [per-routine choice, default fresh]
- Time triggers only for v1, or event triggers too? [time only; events next]
- Can a routine push + open a draft PR, or only commit locally? [draft PR allowed, never merge]

### 7. Trunk-based git handling (general application logic)

Source: [addyosmani/agent-skills: git-workflow-and-versioning](https://github.com/addyosmani/agent-skills/blob/main/skills/git-workflow-and-versioning/SKILL.md). Core ideas: `main` always deployable; short-lived branches (merge within 1–3 days); atomic, tested commits as "save points"; refactors separate from features; one worktree per parallel agent.

**Decided (2026-10-10):** not a feature with its own button or view. It's how Orbit handles worktrees, branches, commits and merges under the hood (`git.rs`, a new `trunk.rs`), applied to every workspace. Deterministic git code does the work; an agent is only pulled in where judgement is needed (resolving a conflict, writing a commit message). You mostly shouldn't notice it, except that branches stay fresh, merges stay small and leftovers get cleaned up.

**What Orbit already does:** one worktree + branch per workspace from fresh `origin/<base>`; merged-worktree cleanup (manual, Settings > Data). Rebasing and commit discipline currently live in shipkit prompts (`rebase`, `ship`), so they're up to the agent.

**Behaviour:**
- **Save points.** After every agent turn that changed files, Orbit commits the worktree itself (`wip:` commit). This makes any turn revertible and means work is never only on disk. At Ship, Orbit squashes the `wip:` commits into one or a few conventional commits (agent-written messages), so history stays clean without trusting the agent to commit.
- **Stay close to base.** Orbit fetches periodically and rebases idle, clean workspaces onto `origin/<base>` when base moves (immediately after another Orbit workspace merges). Clean rebase: silent. Conflict: Orbit aborts and the workspace lands in the inbox ("Needs sync: conflicts in X, Y") with one click to let the agent resolve them; Orbit re-runs checks afterwards.
- **Merge order.** Orbit knows every live worktree's diff, so before shipping it checks for overlap with other workspaces (`git merge-tree` dry-run). After a merge, every overlapping workspace is synced next, so conflicts surface one at a time and small.
- **Checks before push.** Orbit runs the repo's check command itself (auto-detected per repo from `package.json` / `Cargo.toml`, overridable in Settings) and won't push a failing branch; the workspace goes to the inbox with "Checks failed".
- **Short-lived branches.** After merge Orbit archives the workspace, removes the worktree and deletes the branch automatically (today's manual cleanup becomes the default). Branches open for a long time or far behind base surface in the inbox, not as new chrome.
- **Shipkit's `rebase` and `ship` prompts** shrink to just the judgement parts (conflict resolution, commit/PR text) or are retired.
- **Later, own item:** stacked branches / splitting large changes; releases (semver bump, tag, changelog).

**Open questions (proposed defaults in brackets):**
- `wip:` save-point commits on every turn: always, or a setting? [always; squashed at Ship]
- Auto-rebase idle workspaces silently, or ask first? [silent when clean; inbox when conflicting]
- Never rebase a workspace while its agent is running? [yes: only idle + clean worktrees]
- Hard block on failing checks, or allow an override? [block, with "Ship anyway" in the inbox row]
- "Long-lived" threshold for the inbox? [3 days or 20 commits behind]

### 8. Simplification pass (built-in action) (built, mock-verified)

Source: [addyosmani/agent-skills: code-simplification](https://github.com/addyosmani/agent-skills/blob/main/skills/code-simplification/SKILL.md). Core ideas: preserve behaviour exactly (tests pass unmodified); follow project conventions; clarity over cleverness, not fewer lines; scope to what changed; understand before touching (Chesterton's fence); one simplification at a time, tested, committed; refactors kept separate from features.

**Decided (2026-10-10):** a built-in app feature: a **Simplify button in the workspace UI** (workspace header, beside Ship). Orbit runs and polices the loop; the agent only proposes and makes edits. The prompt lives inside Orbit, not as a `/skill` the user sees or the agent can reinterpret.

**Problem:** Agents iterate fast and leave residue: duplicated helpers, dead branches, deep nesting, inconsistent patterns across parallel workspaces. Nothing in the flow cleans it up before shipping.

**Sketch (Orbit-driven loop):**
1. **Scope:** Orbit computes the workspace's diff against base (or selected files) and passes only that.
2. **Find:** a read-only agent turn (enforced, like Planner) returns a structured candidate list via JSON schema: file, lines, signal (deep nesting, long function, nested ternary, boolean flag params, duplication, dead code, needless wrapper), proposed change, risk.
3. **Review in the UI:** a Simplify panel lists the candidates; you tick which to apply (or "Apply all low-risk").
4. **Apply one at a time:** an edit turn per candidate, then **Orbit runs the repo's check command** (same one as #7). Pass: Orbit commits it as `refactor: …`. Fail, or the edit touched test files: Orbit reverts it and marks the row skipped with the reason. Behaviour preservation is checked by Orbit, not promised by the agent.
5. **Result:** a before/after summary in the panel (applied / skipped / lines removed), commits kept separate from feature commits.
- **Entry point:** the Simplify button (plus a palette entry, per convention). It can also be picked as a routine's action (#6), e.g. weekly over the last week's merged changes, opening its own `refactor/` PR.

**Open questions (proposed defaults in brackets):**
- Review the candidate list first, or apply straight away? [review first; "Apply all low-risk" for speed]
- Same PR as the feature (separate `refactor:` commits) or its own PR? [same PR when run in a feature workspace; own PR when run as a routine]
- Which agent finds vs applies? [the workspace's agent; option to let the other agent find, for a second view]
- Run automatically before Ship, or only on click? [only on click / routine]

### 9. Local models via Ollama (for utility tasks)

**Decided (2026-10-10):** build it all: utility tasks, OpenAI-compatible servers, experimental local agent.

**Want:** Let people point some of Orbit's small, behind-the-scenes model calls at a local Ollama model, if they want to. Claude / Codex stay the default and the only coding agents; nobody has to touch this.

**Position (proposed):** Ollama is **not a chat provider**. Local models are far behind frontier models at agentic coding, and most machines can't run the ones that come close. It's a **utility model** option: the short, cheap, structured calls around the agents, where a 3–8B model is good enough and "free, private, offline" is a real win.

**Where Orbit makes (or will make) utility calls:**
- Inbox prompt suggestions (today: one-shot `claude -p --model haiku`, `suggest_prompts` in `lib.rs`).
- Workspace names / branch slugs from the first prompt (today: slugify).
- Save-point and squash commit messages (#7).
- Routine run summaries and "nothing to do" detection (#6).
- _Later:_ PR description drafts, Simplify candidate triage (#8), transcript titles.

Coding turns, Simplify edits, conflict resolution and anything with tools stay on Claude / Codex.

**Sketch:**
- **`llm.rs`: one utility-call API** (`complete_json(task, prompt, schema)`) with two backends: the current Claude CLI one-shot, and Ollama over HTTP (`POST /api/chat`, `stream: false`, `format: <JSON schema>` for structured output; `GET /api/tags` to list installed models). Every utility call goes through it, so each task can be pointed anywhere.
- **Settings > Models** (new section, or part of Agents):
  - Ollama: URL (default `http://localhost:11434`), live status (connected / not running / not installed), installed models list.
  - **Per-task model**, each one Default (Claude Haiku) / Ollama: `<model>` / Off: Inbox suggestions, Workspace names, Commit messages, Routine summaries. One "Use local for all utility tasks" shortcut.
  - A note on the trade-off: local = free and private (code never leaves the machine), but slower on weak hardware and less accurate.
- **Always falls back.** If Ollama is down or returns invalid JSON, Orbit uses the default for that call (or skips it, for optional ones like suggestions) and shows a quiet status in Settings, never an error in the chat.
- **Nothing to install from Orbit.** We detect Ollama; we don't download it or pull models (link to `ollama pull <model>` with a suggested small model).

**Optional, experimental: local model as the agent.** Both CLIs can already talk to a local server: Codex has an open-source / Ollama provider mode, and Claude Code can be pointed at an Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`), which recent Ollama versions expose (both need verifying against the installed versions). So instead of a third chat provider, the New Workspace model picker could offer "Local (Ollama): `<model>`" under Codex/Claude, behind an "Experimental" toggle in Settings > Models. Low cost because it reuses the existing adapters; the quality caveat is shown where you pick it.

**Open questions (proposed defaults in brackets):**
- Utility-only, or also the experimental local-agent option? [utility first; local agent as a later, flagged follow-up]
- Which tasks get a per-task switch in v1? [suggestions, workspace names, commit messages, routine summaries]
- Default when Ollama is set up: switch everything to local automatically, or keep each task on Default until picked? [keep Default; user opts in per task or with "use local for all"]
- Other local servers (LM Studio, llama.cpp server) via an OpenAI-compatible URL? [design `llm.rs` for it, ship Ollama only]
- Suggested starter model? [a small instruct model that handles JSON well, e.g. a 3–8B Qwen/Llama; pick after testing on our real prompts]

### 1. Focus on the main workspace (chat / editor) (built)

**Decided (2026-10-08, building):** defaults accepted: fixed widths; opening Ship pushes the chat narrower; sidebar collapse state is global; the Ship button shows a small hint (PR number, checks dot).

**Problem:** The three columns compete for attention. The Ship panel (304px) and sidebar (256px) take ~40% of a 1440px window, but the centre is where all the activity happens.

**Principle (decided):** Orbit optimises for rapid, easy iteration, not for reviewing every change. Users who want line-by-line review aren't the target; change visibility is secondary.

**Proposal:**
- **Ship panel is hidden by default (decided).** No rail. A **Ship** button in the workspace header opens it; that's the moment we show the changes, PR state and checks. Closing it returns full width to the chat. The button can carry a tiny status hint (PR number, checks dot) so you don't have to open the panel to know where things stand.
- **Sidebar slims down** from 256px to ~216px, with quieter rows (smaller type, diff stats only on hover or the selected row). It can collapse to an icon rail showing just status dots (`Ctrl+B`).
- **Centre gets the space:** wider message area (760px → ~880px max), a slightly larger composer, and stronger visual weight (panels dim back to `bg-panel`, centre stays `bg-bg`).
- **Focus mode** (`Ctrl+\`) hides both side panels entirely.

**Settled:**
- The Ship panel never opens on its own; only the user's click opens it.

**Open questions (proposed defaults in brackets):**
- Drag-resizable panels, or fixed widths? [fixed, simpler]
- When the Ship panel opens: slide over the chat, or push the chat narrower? [push, so the chat and Ship stay side by side while shipping]
- Remember the sidebar collapsed/expanded state per workspace or globally? [globally]
- Should the Ship button show a status hint (PR number, checks dot), or stay a plain button? [small hint]

### 2. Attention inbox (built)

**Decided (2026-10-08):** build it, using the proposed defaults: rule suggestions instantly plus AI suggestions (one-shot Haiku, no tools) underneath; clicking a suggestion sends it immediately; the inbox replaces the planned fleet board with **Needs you / All** tabs; it takes over the main area (Ctrl+I, count badge in the sidebar); a row clears when you reply, open the workspace or dismiss it (it comes back on new activity).

**Want:** A separate view listing every session that needs you. Hovering a row can show prompt suggestions, so you can nudge an agent without going back into its workspace. _You want to build this._

**Problem:** With many agents running, you have to click through workspaces to find out which ones are waiting on you and what they need.

**Sketch:**
- **Own view**, opened from the sidebar or a shortcut (e.g. `Ctrl+I`), with a count badge in the sidebar.
- **One row per session that needs attention**, newest first: workspace name, why it's here, a one-line snippet of the agent's last message, how long it's been waiting.
- **Reasons a session lands here:**
  - finished a turn you haven't seen
  - errored or exited
  - asked you a question (last message ends in a question, or the agent used an ask-the-user tool)
  - PR checks failed / review requested / changes requested
  - _(maybe)_ idle for a long time with uncommitted work
- **Hover (or arrow-key focus) reveals 1–3 prompt suggestions** and a small reply box:
  - click a suggestion to send it straight to that session; the row leaves the inbox and the agent starts working
  - or type your own reply inline
  - examples: CI failed → "Fix CI" (`/shipkit:fix-ci`); done → "Ship it" (`/shipkit:ship`); asked a question → likely answers; errored → "Retry" / "Explain the error"
- **Row actions:** open workspace, dismiss, snooze.
- Keyboard-first: `j`/`k` to move, `1`–`3` to send a suggestion, `Enter` to open.

**Open questions:**
- **Suggestions: rules or AI?** Rules (fixed suggestions per reason) are instant and free. AI-generated (a cheap Haiku call reads the last turn and proposes next prompts) are smarter but cost a little and lag a second. Possible middle ground: rules first, AI suggestions loading in underneath.
- **Click to send immediately, or click to pre-fill the reply box** so you can tweak first?
- **Does this replace the planned "fleet board"** (grid of all running agents)? The inbox covers "what needs me"; the fleet board covers "what's everyone doing". One view with two tabs (Needs you / All) might do both.
- **Where does it live?** It could take over the centre area (like Linear's inbox), be a sidebar tab, or be a pop-over panel.
- **What clears a row:** opening the workspace, replying, or only an explicit dismiss?

### 3. Agent profiles ("coworkers") (built)

**Decided:** workspace profiles (option B). Build after the inbox.

**Want:** A small set of baked-in, very specific agent profiles for key tasks that guide the agent, similar to sub-agents. Not sure yet whether they should be dedicated agents or just targeted skill files.

**Problem:** Every workspace starts as the same generalist. For recurring jobs (fix a bug, plan a feature, review before shipping) you re-explain the same expectations each time, and the agent's behaviour varies.

**Three ways to build it:**
- **A. Skill files only.** Each "coworker" is a skill (`/shipkit:debugger`, …) you invoke on demand. Cheapest; we already have the plumbing. But it's a one-off nudge, not a mode: the agent drifts back to generalist after a turn or two.
- **B. Workspace profile (a mode).** A profile bundles: instructions (added to the system prompt), agent + model/effort, skill packs and pinned skill chips, permissions (e.g. read-only), and a starter prompt. You pick it when creating a workspace (or switch mid-session), and it stays in force the whole session.
- **C. Real sub-agents.** Profiles become Claude sub-agents (`.claude/agents/*.md`) that the main agent can delegate to (e.g. hand a review to the Reviewer). Powerful, but Claude-only, harder to follow, and the main agent decides when to use them, not you.

**Chosen: B, stored in the standard Claude agent file format** (markdown + frontmatter: `name`, `description`, `model`, `tools`). One file then works three ways: as a workspace mode (B), injected into Codex as developer instructions, and loadable as a Claude sub-agent (C) later at no extra cost. Profiles ship in shipkit and can come from any skill pack, so you can add your own.

**Starter profiles (draft):**
- **Builder**: the default generalist; implements, tests, keeps changes focused.
- **Debugger**: reproduce first, find the root cause, smallest fix, add a regression test.
- **Planner**: read-only; explores and writes a plan with steps and risks, no code changes.
- **Reviewer**: read-only; adversarial pre-ship review (could run on Codex for a second opinion).
- **Shipper**: get the branch green and merged: rebase, fix CI, address comments, ship.
- **Ticket writer**: turns rough notes into well-formed GitHub issues.

**UI sketch:** a profile picker in the New Workspace dialog (Builder by default), a small profile badge next to the agent name in the composer, and a quick switch from the palette (`Switch profile…`). Each profile can pin its own skill chips (Shipper shows Ship / Fix CI / Rebase; Planner shows none).

**Open questions:**
- **Mode (B) or on-demand helper (A/C)?** Does the profile set how the whole session behaves, or is it a coworker you call in for one job while staying in the same chat?
- **Personality:** just a mode label, or named coworkers with a distinct voice and icon?
- **Can a profile pick the agent?** e.g. Reviewer always runs on Codex for a different perspective.
- **Switching mid-session:** allowed? Claude needs a restart (with resume) to change its system prompt; Codex can switch per turn.
- **Which starter set**, and which matter most to you?
- **Tie-in with the attention inbox (#2):** suggestions could hand off between profiles, e.g. "Planner finished → start Builder with this plan".

### 4. Pre-ship spot check (baked-in skill)

**Decided (2026-10-08, building):** `/shipkit:preflight`, advisory (warns, never blocks), offered as a button next to Ship. Second-opinion on the other agent comes later with profiles.

**Want:** A shipkit skill that runs before shipping and checks the work from multiple sides, so nothing upstream or downstream breaks. People work across many projects at once, so it's easy to break another project without noticing.

**What exists today:** shipkit's `ship` runs the project's own checks; `/codex:adversarial-review` (user-installed plugin) reviews design within the current repo. Nothing checks impact on *other* projects.

**Sketch: `/shipkit:preflight`**
1. **Find what changed at the boundaries**, from the diff against the base branch: exported functions/types, public APIs and routes, CLI flags, config keys and env vars, DB schemas and migrations, event/message shapes, package versions, file formats.
2. **Look both ways:**
   - *Downstream*: who consumes this? Search this repo and every attached folder (see #5) for imports, calls, API clients, config readers.
   - *Upstream*: does this change rely on something new or different in its dependencies (a newer API, a field that may not exist)?
3. **Verify where cheap:** typecheck/build/test the affected consumers, not just this repo.
4. **Report** a short table: each boundary change → who's affected → **Safe / Risky / Breaking**, with evidence (file:line) and the suggested fix. Read-only by default: it reports, it doesn't fix (follow-up: "fix the risky ones").

**Open questions:**
- **Name:** `preflight`, `spot-check`, or `sanity-check`?
- **Wire it into Ship?** e.g. the Ship button runs preflight first and only ships if nothing is Breaking, or just offers "Preflight" next to Ship.
- **Second opinion:** optionally run the check on the other agent (Codex reviewing Claude's work, or vice versa)? Fits the Reviewer profile (#3).
- **Blocking vs advisory:** should Breaking findings stop `/shipkit:ship`, or just warn?

### 5. Multi-folder sessions (attach related projects) (built)

**Decided (2026-10-08):**
- **Read-only to start.** Attached folders are references the agent can read.
- **Promote to editable on request:** a prompt lets you allow the agent to work in an attached folder too (e.g. "Allow edits in `shared-ui`?"). Once allowed, that repo gets its own worktree + branch so edits stay isolated, and Ship covers it.
- **Auto-discover as you attach:** attaching a folder (or creating a workspace) triggers a scan for related projects (dependents/dependencies via package.json, Cargo.toml, imports) and suggests attaching them; one click to accept.

**Want:** Attach multiple folders to a session so the agent can read them. Needed for #4: to check downstream/upstream impact, the agent has to see the other projects.

**Sketch:**
- **Attach folders to a workspace**: from the workspace header ("+ Attach folder"), the New Workspace dialog, or the palette. Attached folders show as small chips under the workspace name.
- **Per-repo defaults ("related projects")**: set once per repo, e.g. "orbit always attaches `../shared-ui` and `../api`", so every new workspace in that repo gets them automatically.
- **How agents see them:**
  - Claude: `--add-dir <path>` per folder (native support).
  - Codex: listed in its developer instructions (it already has filesystem access in Orbit's unattended mode).
  - Both: the workspace context prompt lists the attached folders and their role ("consumer of this repo's API", "shared library").
- **Read-only by default.** The agent reads attached folders but only edits the workspace's own worktree.

**Open questions:**
- **Where does the "allow edits" prompt come from?** Options: you toggle it per folder chip; or the agent asks when it wants to edit (it says so, and the inbox/composer shows an "Allow edits in X" button). Decided for v1: a toggle on each folder chip (agent-initiated requests later).
- **Which folders does discovery scan?** Sibling folders of the repo, plus repos already added to Orbit? A configurable "projects root" (e.g. `C:\code`)?
- **Attach any folder, or only git repos?** Leaning: any folder for read-only; editable requires a git repo (it needs a worktree).

## Decided

Agreed ideas, each with a line on where it landed in FEATURES.md.

- **#2 Attention inbox**: built and verified (e2e 13/13). FEATURES.md: Fleet & workspaces.
- **#3 Agent profiles**: built as workspace profiles (B); e2e verified.
- **#4 Pre-ship spot check**: `/shipkit:preflight` written and pinned; needs a real cross-project run.
- **#5 Multi-folder sessions**: built; e2e verified (attach, discovery, editable worktrees).
- **#6 Routines, #7 Trunk-based git handling, #8 Simplify, #9 Local models**: decided 2026-10-10 (routines only while Orbit is open; all proposed defaults accepted) and built the same day, then connected (Simplify as a routine action, routine summaries / save-point messages / PR drafts through `llm.rs`). All 🟢: none has had a real-app e2e run yet. FEATURES.md: Routines, git flow, simplify; Local models.
- **#1 Focus on the main workspace**: built (Ship button + hidden panel, slimmer collapsible sidebar, wider chat, focus mode).
- **#12 Orbit Code**: decided 2026-10-18 (CodeMirror 6, global Code view, Watch/Manual modes); building. FEATURES.md: Code view.

## Parked

Ideas we've set aside, with the reason, so we don't relitigate them.

_(empty)_
