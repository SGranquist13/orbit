# Orbit: planning

Working notes for features we're thinking about. **Nothing here gets built until it's agreed.** Ideas start in the Inbox, get shaped together, and once decided move to [FEATURES.md](FEATURES.md) as ⬜ planned (that file tracks what's built).

## Inbox

Raw ideas, as they come. Unsorted, unfiltered.

_(empty: ideas 6–8 moved straight to Shaping)_

## Shaping

Ideas we're actively working through: the problem, a rough sketch, open questions.

### 6. Routines (scheduled prompts)

**Want:** Prompts that run on a schedule or trigger without you starting them, e.g. "every weekday at 9: triage new issues", "nightly: run the test suite and fix anything flaky", "every Friday: simplification pass on this week's changes" (#8).

**Problem:** Orbit only acts when you type. Recurring chores (triage, dependency bumps, CI babysitting, cleanup) need you to remember them, open a workspace and paste the same prompt.

**Sketch:**
- **A routine** = name + repo + schedule + prompt (or a skill, e.g. `/shipkit:fix-ci`) + agent/profile + **where it runs**:
  - *fresh workspace each run* (new worktree + branch, named `<routine>-<date>`): for jobs that produce a PR;
  - *one standing workspace* reused every run: for running logs / triage notes.
- **Schedule:** simple presets (hourly, daily at HH:MM, weekdays, weekly on X) with cron underneath; plus event triggers later (PR checks failed, new issue labelled X, branch merged).
- **Runs land in the attention inbox (#2)** as a normal workspace with reason "Routine finished" / "Routine failed", so nothing new to learn. Quiet runs ("nothing to do") auto-archive.
- **Routines page** (palette + Settings-style list): enable/pause, next run time, last run status, "Run now", run history linking to each workspace.
- **Runs in the app process** (a scheduler tick in Rust alongside the session manager, schedule stored in SQLite). Missed runs while Orbit was closed: run once on launch, don't replay every miss.
- **Guardrails:** max concurrent routine runs, per-routine budget cap (tokens via `usage.rs`), and routines never merge on their own: they stop at a draft PR.
- **Phone:** routine results push to the mobile app like any finished turn.

**Open questions (proposed defaults in brackets):**
- Only while Orbit is open, or a background service / OS scheduled task that launches it? [only while open, run missed on launch]
- Fresh workspace per run or standing workspace? [per-routine choice, default fresh]
- Time triggers only for v1, or event triggers too? [time only; events next]
- Ship a few starter routines in shipkit (issue triage, nightly CI check, weekly simplify, stale-branch sweep)? [yes, disabled by default]
- Should a routine be allowed to auto-ship (push + draft PR), or only commit locally? [draft PR allowed, never merge]

### 7. Trunk-based worktree flow

Source: [addyosmani/agent-skills: git-workflow-and-versioning](https://github.com/addyosmani/agent-skills/blob/main/skills/git-workflow-and-versioning/SKILL.md). Core ideas: `main` always deployable; short-lived branches (merge within 1–3 days); atomic commits each tested ("save points"); separate refactors from features; ~100 lines per change, split above ~1000; a change summary with "didn't touch" and "concerns"; one worktree per parallel agent.

**What Orbit already does:** one worktree + branch per workspace, branched from fresh `origin/<base>`; conventional commits in `ship`; `rebase` skill; merged-worktree cleanup.

**Gaps (where Orbit could actively enforce the flow):**
- **Branch age and drift.** Nothing tells you a workspace has lived 5 days or is 40 commits behind base. Show age + behind/ahead on the sidebar row (colour only when it matters: `warn` past N days or N commits behind), and add an inbox reason "Drifting from base" with a "Rebase" suggestion.
- **Auto-sync with base.** Optionally rebase idle, clean workspaces onto base when base moves (or when another Orbit workspace merges), so conflicts show up early and small. Fits a routine (#6).
- **Cross-workspace conflict warning.** Several agents in parallel worktrees touching the same files is the main merge pain (`mock.ts`, `Palette.tsx`). Orbit sees every worktree's diff, so it can flag "ws A and ws B both edit `Palette.tsx`" before either ships, and suggest merging the smaller one first.
- **Save-point commits.** Have agents commit after each verified slice instead of one big commit at Ship time (workspace context instruction, maybe a Builder-profile rule). The transcript could show commits as markers, and "Undo to last save point" = `git reset --hard` to the previous agent commit (confirm first).
- **Change size nudge.** Diff stats are already known: warn when a workspace passes ~400 changed lines ("consider splitting"), and offer a `/shipkit:split` skill that splits work into stacked branches/PRs (refactor vs feature).
- **Change summary in PRs.** Extend `ship`'s PR template with *Didn't touch (intentionally)* and *Concerns* sections.
- **Merge method.** Our default is squash; the skill argues for keeping clean incremental commits. With save-point commits, rebase-merge keeps the narrative. Revisit the default.
- **Release & versioning (later):** a `/shipkit:release` skill (semver bump from conventional commits, tag, curated changelog entry). Probably its own idea.

**Open questions (proposed defaults in brackets):**
- How opinionated? Nudges and inbox reasons only, or enforce (e.g. block Ship over a size limit)? [nudges only, matches preflight being advisory]
- Drift thresholds? [warn at 3 days or 20 commits behind]
- Auto-rebase idle workspaces automatically, or only suggest? [suggest; auto via an opt-in routine]
- Save-point commits by default for every profile, or Builder/Debugger only? [all editing profiles]
- Default merge method: keep squash or switch to rebase? [keep squash until save-point commits land, then revisit]
- Is "trunking" also meant as stacked PRs (branch on top of another workspace's branch)? That's a bigger feature: worth its own item?

### 8. Simplification pass

Source: [addyosmani/agent-skills: code-simplification](https://github.com/addyosmani/agent-skills/blob/main/skills/code-simplification/SKILL.md). Core ideas: preserve behaviour exactly (tests pass unmodified); follow project conventions (CLAUDE.md, neighbouring code); clarity over cleverness, not fewer lines; scope to what changed; understand before touching (Chesterton's fence, git blame); one simplification at a time, test, commit; refactors go in separate commits/PRs from features.

**Problem:** Agents iterate fast and leave residue: duplicated helpers, dead branches, over-nested logic, inconsistent patterns across parallel workspaces. Nothing in the flow cleans it up before shipping.

**Sketch:**
- **`/shipkit:simplify` skill** (bundled), adapted from the source: scope = the workspace's diff against base by default (or a path/arg); checklist of concrete signals (nesting ≥3, functions >50 lines, nested ternaries, boolean flag params, duplicated 5+ lines, dead code, wrapper-adds-nothing); each change tested and committed separately as `refactor:`; ends with a before/after summary and anything flagged-but-not-changed.
- **Simplifier profile** (#3): Builder-like, but instructed never to change behaviour or tests; could run on the other agent for a second pair of eyes.
- **Where it shows up:**
  - a pinned chip / button next to Preflight in the Ship panel ("Simplify before shipping");
  - an inbox suggestion when a turn finishes with a large diff;
  - a weekly routine (#6) over the last week's merged changes on base, opening a separate `refactor/` PR.
- **Keep it separate from feature work:** when run in a feature workspace, its commits stay `refactor:` so they can be reviewed or reverted on their own; optionally it opens its own branch/PR (ties to #7's split idea).

**Open questions (proposed defaults in brackets):**
- Skill only, or skill + profile? [skill first; profile if it drifts]
- Same PR as the feature (separate commits) or its own PR? [same PR, separate `refactor:` commits; own PR when run as a routine]
- Advisory (report only, you approve) or apply directly? [apply, since every step is tested and committed and easy to revert]
- Run it automatically before Ship, or only on click? [only on click, like preflight]
- Should it also target the user's own codebase-wide cleanup (not just the diff)? [diff-scoped by default; a path argument widens it]

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
- **#1 Focus on the main workspace**: built (Ship button + hidden panel, slimmer collapsible sidebar, wider chat, focus mode).

## Parked

Ideas we've set aside, with the reason, so we don't relitigate them.

_(empty)_
