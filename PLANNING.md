# Orbit: planning

Ideas we're exploring and the design behind what's built. Ideas start in the **Inbox**, get shaped in **Shaping**, and once agreed join the roadmap in [FEATURES.md](FEATURES.md). The **Design notes** record how each built feature was decided.

## Inbox

Ideas being considered, unsorted.

- **Teammates on the phone.** Teammate threads and status in the iPhone app, alongside workspaces, with the option to message a teammate from the phone.
- **Live removal on the phone.** When a workspace is archived (by you, or a routine tidying up after itself), it disappears from the phone right away.
- **Smarter New workspace dialog.** Attach folders from the dialog itself, choose which action (Create or Start) is the default, tidy up workspaces that were created but never started.
- **Event-triggered routines.** Run a routine when checks fail, a labelled issue arrives, or the base branch moves.
- **Stacked branches.** Split a large change into a stack of small PRs; release helpers (version bump, tag, changelog).
- **Teammate tools beyond code.** Per-teammate MCP connectors.
- **Profiles → Modes?** Profiles work like the "modes" in other agent tools; the name may change to match.
- **Kanban board.** Workspaces as cards in To do → Running → Review → Done, drag a card to start it.
- **Start a task from Slack or Linear.** Mention Orbit where the work arrives; a workspace starts and reports back there.
- **Spec-driven mode.** Requirements → design → tasks documents, then the agent works through the tasks.
- **Remote and sandboxed workspaces.** Run a workspace on a devbox or in a container, same UI.
- **Approvals inbox.** Risky actions you define (force push, `rm -rf`, writes outside the worktree, network calls) pause the agent and land in the inbox with Allow, Deny and Always allow.
- **Budgets.** A token, cost or time cap per workspace or per day; at the cap the agent pauses and the inbox asks whether to continue.
- **Stuck detector.** Flag a workspace that loops (same tool call, same failing test, no file progress) and offer Interrupt, "try another approach" or Compact.
- **Repo memory.** A shared notes file per repo that every agent reads; Orbit proposes entries when a turn learns something and you approve them.
- **Session hand-off summary.** When context runs high or you start a new session, Orbit writes a brief (goal, decisions, files touched, what's left) and seeds the next session with it.
- **Search all transcripts.** Find which agent touched a file or where a decision was made, across every workspace.
- **Test-first gate.** The agent writes a failing test before touching source; Orbit checks it failed first and passes after.
- **Auto-address review comments.** A teammate picks up new PR comments, fixes them, replies and resolves the thread; you see a summary.
- **Release helper.** Version bump, changelog from merged PRs and tag, as a skill and panel.
- **Maintenance routines.** Bundled templates for dependency audits, unused-dependency cleanup and flaky-test hunting that open draft PRs.
- **Time-travel scrubber.** Drag through a workspace's turns and the editor shows each file as it was after that turn.
- **Share a run.** Export a workspace as a self-contained HTML replay (transcript, diffs, timeline).
- **Voice and clipboard intake.** Dictate a task, or paste a stack trace or screenshot and start a Debugger on it with the repo guessed.
- **Task templates and backlog.** Saved prompts with blanks, and a per-repo list of someday tasks that a routine picks up when the fleet is idle.
- **Live preview per workspace.** The worktree's dev server beside the chat, with a screenshot after each turn.
- **Checks after every turn.** Run the tests related to changed files after each turn and feed failures straight back to the agent.
- **Pair mode.** A cheap read-only agent watches another's edits live and leaves short warnings in the margin.
- **Conflict forecast and workspace dependencies.** Show which files two live workspaces both touch and suggest a merge order; "start B when A merges".
- **Bulk actions.** Rebase, ship, archive or message several workspaces at once.
- **Prompt analytics, postmortems and a weekly digest.** Which prompts, profiles and models lead to merged PRs; one-click "why did this run go wrong"; a Monday summary of what merged, what's stuck and where tokens went.
- **Orbit as an MCP server.** List workspaces, read status and send messages to Orbit from any Claude session or tool.

## Shaping

Ideas being worked through: the problem, a sketch, open questions.

### Worktree setup, run and env files (in progress)
A new worktree is bare: no dependencies, no `.env`, no dev server. Per repo: a **setup script** run when a worktree is created (output shown in the chat, timeout, never blocks the first message forever), a **run script** started from a Run button on a free port (`$PORT` / `$ORBIT_PORT`), and **copy globs** for ignored files (`.env*`) copied from the main checkout. Settings > Repos.

### Open in editor (in progress)
One button (header, palette) opens the workspace's worktree in VS Code, Cursor, Zed or JetBrains; detected on PATH, overridable as a command in Settings.

### Plan limits (in progress)
Show the Claude and Codex plan windows (5-hour, weekly) with used share and reset time in Settings > Usage, and a quiet warning near the limit, from the rate-limit information both CLIs already report.

### Terminal UI
Some people live in the terminal. `orbit` is a simple, clean terminal interface to the running app with Orbit's own look: Chat with a fleet rail, a full-screen Inbox, Review (diff + line comments to the agent), skills and Ship. Rust (ratatui), talking to the app over the bridge in a local loopback mode; the same binary runs in an in-app "Terminal UI" pane. Design agreed: plan in [docs/tui.md](docs/tui.md), mockup in [docs/tui/mockup.html](docs/tui/mockup.html).

### Next up
- **MCP servers for both agents:** add a server once, Claude and Codex both get it; per-workspace toggles like skill packs.
- **Comment on the diff:** comments on lines in the Code view diff and Ship panel go to the agent as one message.
- **Rewind to any turn:** reset code and conversation to any earlier turn, or branch a new workspace from there.
- **Automatic review on Ship:** a read-only Reviewer posts inline findings on the PR.
- **Best of N:** one prompt, several attempts side by side, keep the best.

## Design notes

### 15. Review: careful review of agent work and pull requests

Agents produce a lot of change; reviewing it well should be as comfortable as chatting. A dedicated Review view (Alt+6) puts everything that needs your eyes in one queue and gives each change a calm, file-by-file read.

- **Two sources, one place.** Local workspaces with pending changes (their worktree against the base branch, including uncommitted and new files), and GitHub pull requests: your review requests and your own PRs, plus any PR opened by link or number. No AI in the first version: this is the human's review.
- **Local review talks to the agent.** Comments (on any line, a range, or a removed line) collect as drafts and go to the workspace's agent as one message, the same drafts the Code view's diff uses. "Mark reviewed" remembers the state, so the queue shows when the agent changes it again.
- **GitHub review without the website.** Inline comments on either side, multi-line ranges, `suggestion` blocks, replies, resolve/unresolve, files marked viewed (synced), and submit Comment / Approve / Request changes. Drafts are kept locally until you submit them as one review; "Add single comment" posts at once. If new commits land while you review, Orbit refuses to submit against the old head and offers a reload.
- **The diff.** Unified or split, syntax-highlighted with the Code view's parsers, word-level highlights inside changed lines, unchanged runs collapsed (context lines are a setting), keyboard `[` `]` for files and `V` for viewed.
- **Closing the gaps with GitHub and editors.** Hide whitespace; only what changed since your last review, or one commit; image diffs and rendered Markdown/SVG; the pending review lives on GitHub (so it is on github.com too); Open in Code at the current line (a PR is checked out into a workspace first: same-repo PRs on their own branch so pushes update the PR, forks on a local `pr/<n>-…` branch); reviewers, ready for review and merge from the PR header.
- **Later.** Review requests in the inbox, an AI pre-review whose comments you keep or drop, and sending a PR's review comments to an agent in its checked-out workspace.

### 14. Voice: talk to your agents

Speak instead of type, in any workspace chat, without sending audio anywhere.

- **Dictation.** A mic button in the composer and a rebindable shortcut (Ctrl+Shift+Space: tap to toggle, hold to talk). What you say is inserted at the cursor, so it adds to a draft instead of replacing it; it works mid-run for steering. Auto-send is a setting, off by default.
- **On-device recognition.** Whisper (whisper.cpp) runs inside Orbit. Pick tiny, base (default) or small in Settings > Voice and download it once. The workspace's repo, branch, file names and skill ids prime the recogniser, so code words come through.
- **Tidy-up.** An optional pass turns rambling speech into a clean prompt: filler gone, punctuation fixed, "chat dot tsx" becomes `Chat.tsx`. It is a utility task like the others in Settings > Models (Claude, a local model, or off); if it fails, your words go through as spoken.
- **Read aloud.** A speaker button on each reply, and a setting to read replies automatically (off / hands-free only / always), with your choice of Windows voice and speed. Code blocks are summarised, not spelled out.
- **Hands-free.** Talk, pause, and it sends; the reply is read back; then it listens again. The mic is closed while Orbit speaks. Esc, the shortcut or typing ends it; saying "stop" interrupts the agent.

### 13. VS Code keybindings, rebindable

The whole app follows VS Code's default shortcuts, so muscle memory carries over; Orbit-only views use keys VS Code doesn't.

- **Ctrl+K is the chord prefix** (Ctrl+K S save all, Ctrl+K Ctrl+T theme). While a chord is pending, the status line says so; Esc cancels. **Ctrl+I asks the agent about the selection** (VS Code's inline chat key). **Command palette: Ctrl+Shift+P or F1.**
- **Everything is rebindable.** Settings > Keyboard shortcuts is a VS Code-style editor: search, record a key or chord, see conflicts, reset, remove. Every binding in the app, including the editor's text commands, comes from one registry (`src/lib/keybindings.ts`).
- **The agent strip shows on every folder:** a plain folder gets a "Watch an agent" picker there, so the live view is easy to find.

Default map (Orbit-only commands marked *):

| Command | Key |
|---|---|
| Command palette | Ctrl+Shift+P, F1 |
| Quick open file (opens the Code view if needed) | Ctrl+P |
| Code view + focus explorer* | Ctrl+Shift+E |
| Toggle sidebar (Orbit sidebar; in the Code view, the explorer) | Ctrl+B |
| Toggle Activity column (secondary side bar) | Ctrl+Alt+B |
| Ship panel* (VS Code's source control key) | Ctrl+Shift+G |
| Inbox* / Code* / Routines* / Teammates* / Issues* | Alt+1 / Alt+2 / Alt+3 / Alt+4 / Alt+5 |
| New workspace* (outside the Code view) | Ctrl+N |
| Jump to the nth workspace* (outside the Code view) | Ctrl+1…9 |
| Settings | Ctrl+, |
| Keyboard shortcuts | Ctrl+K Ctrl+S |
| Switch theme | Ctrl+K Ctrl+T |
| Focus mode* | Ctrl+K Z (VS Code's Zen mode) |
| Open workspace chat* (VS Code's chat key) | Ctrl+Alt+I |
| Ask the agent about the selection* | Ctrl+I |
| New file / Open folder (Code view) | Ctrl+N / Ctrl+K Ctrl+O |
| Save / Save all | Ctrl+S / Ctrl+K S |
| Close tab / Close all / Reopen closed tab | Ctrl+W (Ctrl+F4) / Ctrl+K Ctrl+W / Ctrl+Shift+T |
| Next / previous tab | Ctrl+Tab, Ctrl+PageDown / Ctrl+Shift+Tab, Ctrl+PageUp |
| Toggle terminal / New terminal / Toggle panel | Ctrl+\` / Ctrl+Shift+\` / Ctrl+J |
| Search in files | Ctrl+Shift+F |
| Find / Replace / Go to line / Next, previous match | Ctrl+F / Ctrl+H / Ctrl+G / F3, Shift+F3 |
| Toggle comment / Block comment | Ctrl+/ / Shift+Alt+A |
| Move line / Copy line / Delete line | Alt+↑↓ / Shift+Alt+↑↓ / Ctrl+Shift+K |
| Insert line below / above | Ctrl+Enter / Ctrl+Shift+Enter |
| Select line / Next occurrence / All occurrences | Ctrl+L / Ctrl+D / Ctrl+Shift+L |
| Add cursor above / below / Undo cursor | Ctrl+Alt+↑ / Ctrl+Alt+↓ / Ctrl+U |
| Indent / Outdent / Jump to bracket | Ctrl+] / Ctrl+[ / Ctrl+Shift+\\ |
| Fold / Unfold / Fold all / Unfold all | Ctrl+Shift+[ / Ctrl+Shift+] / Ctrl+K Ctrl+0 / Ctrl+K Ctrl+J |
| Toggle word wrap / Trigger suggest | Alt+Z / Ctrl+Space |
| Watch / Manual*, Toggle diff* | no default (palette, rebindable) |

Ctrl+Shift+I stays free: it opens the WebView2 developer tools.

### 12. Orbit Code: a built-in editor with a live view of the agent

An editor inside Orbit for working by hand and, above all, for **watching the agent change your files**.

- **Engine:** Orbit's own editor shell on CodeMirror 6, which handles the text editing while Orbit owns the shell and the look.
- **Placement:** a global **Code** view that opens any folder: a repo, any workspace's worktree, or anything else.
- **Watch mode:** while a workspace's agent runs, the editor follows it to each file it touches, streams its edits in as they are written, flashes the changed lines and keeps an activity timeline per turn. Buffers are read-only while the agent works.
- **Manual mode:** a normal editor. Agent changes reload clean buffers silently; a buffer with unsaved edits offers Reload · Keep mine · Compare, and saves check the file on disk first, so nothing is overwritten silently.
- **Ask about a selection:** send the selected lines plus a question to the folder's workspace agent, or start a new workspace with them.
- **Core:** file tree, tabs, autosave, quick open, find/replace, project search, integrated terminal, git gutter and diffs vs HEAD or base, Settings > Editor.

### 11. Create a workspace without a task

The New workspace prompt is optional: leave it empty and **Create** gives you an idle worktree with the composer focused, ready to attach folders or pick a profile first; type a task and **Start** runs it as before. An optional name field overrides the automatic name.

### 10. AI teammates

Hand a task to a named teammate, the way you would to a coworker, and get finished work back.

- **A teammate** is a name, avatar, instructions, default agent and model, permissions (read-only enforced where set), skills, the repos it may work in, its own memory file and its own routines. Teammates are markdown files, so they're easy to edit and share.
- **One thread per teammate** in the Teammates view. You message the teammate; it creates the workspaces it needs and reports back in the thread with links and a result. You can always open those workspaces yourself.
- **Status like a person:** working, needs you, or idle, feeding the inbox.
- **Starter team:** Builder, Debugger, Planner, Reviewer, Shipper, Ticket writer, and **Chief**, who splits a vague request into parts for the others, runs them in dependency order and sends one combined report.
- **Hand-offs:** a finished report offers the natural next step (Planner → Builder, Builder → Reviewer, Reviewer → Builder for fixes, any PR → Shipper) plus "Hand to…".
- **Autonomy:** teammates stop at a draft PR; merging stays with you.
- **Avatars** are the one place Orbit uses colour for personality; status always lives in the dots.
- **Profiles stay** as the per-workspace mode; a teammate can use a profile for its workspaces.

### 9. Local models for utility tasks

Orbit makes small behind-the-scenes model calls: inbox suggestions, workspace names, commit messages, routine summaries, PR description drafts. Each can be pointed at a local model (Ollama or any OpenAI-compatible server), so those calls can be free, private and offline.

- **Claude and Codex stay the coding agents.** Local models are a utility option, where a small model does well.
- **One API for every utility call** (`llm.rs`), so each task can be pointed anywhere in Settings > Models: Default, a local model, or Off. "Use local for all" is one click.
- **Always falls back:** if the local server is down or replies badly, Orbit uses the default (or skips optional calls) and shows a quiet status in Settings, never an error in the chat.
- **Experimental:** run an agent itself on a local model. Both CLIs can talk to a local server, so this reuses the existing adapters.

### 8. Simplify

Agents iterate fast and leave residue: duplicated helpers, dead branches, deep nesting. Simplify cleans it up without changing behaviour.

1. **Scope:** the workspace's changes against base.
2. **Find:** a read-only pass returns a structured list of candidates (file, lines, signal, proposed change, risk).
3. **Review:** pick which to apply, or "Apply all low-risk".
4. **Apply one at a time:** an edit per candidate, then Orbit runs the repo's checks. Pass: Orbit commits it as `refactor: …`. Fail, or the edit touched tests: Orbit reverts it and says why. Behaviour preservation is checked by Orbit, not promised by the agent.
5. **Entry points:** the Simplify button beside Ship, the palette, and as a routine (e.g. weekly over the week's changes, opening its own `refactor/` PR).

Inspired by [addyosmani/agent-skills: code-simplification](https://github.com/addyosmani/agent-skills/blob/main/skills/code-simplification/SKILL.md).

### 7. Trunk-based git handling

Not a feature with its own button: it's how Orbit handles branches, commits and merges under the hood, so branches stay fresh, merges stay small and leftovers get cleaned up. Deterministic git code does the work; an agent is only asked where judgement is needed.

- **Save points:** after every turn that changed files, Orbit commits (`wip:`), so any turn can be undone. At Ship they're squashed into clean commits.
- **Stay close to base:** idle, clean workspaces are rebased onto the latest base. A clean rebase is silent; a conflict is aborted and lands in the inbox with one click to let the agent resolve it. Never while an agent is running.
- **Merge order:** Orbit knows every live workspace's changes; after a merge, overlapping workspaces sync first, so conflicts surface one at a time.
- **Checks before push:** Orbit runs the repo's check command itself (auto-detected, overridable) and holds a failing branch back, with "Ship anyway" when you need it.
- **Short-lived branches:** after merge Orbit archives the workspace, removes the worktree and deletes the branch. Long-lived or far-behind branches show up in the inbox.

Every part of this can be adjusted in Settings > Git. Inspired by [addyosmani/agent-skills: git-workflow-and-versioning](https://github.com/addyosmani/agent-skills/blob/main/skills/git-workflow-and-versioning/SKILL.md).

### 6. Routines

Work that runs on a schedule without you starting it: "every weekday at 9: triage new issues", "every Friday: simplify this week's changes".

- **A routine** is a name, repo, schedule, action (a message, a skill, or Simplify), agent or teammate, and where it runs: a **fresh workspace** each run (for jobs that produce a PR) or **one standing workspace** (for running notes).
- **Schedules:** once, hourly, daily, weekdays, weekly, with cron under Advanced.
- **Runs while Orbit is open;** a missed run catches up once on launch.
- **Results land in the inbox** like any finished turn; runs with nothing to do archive themselves.
- **Guardrails:** a concurrency cap, and routines may open a draft PR but never merge.

### 5. Multi-folder sessions

Attach related projects to a workspace so the agent can read them, for example to check who consumes an API before changing it.

- **Read-only by default;** make a folder editable and it gets its own worktree and branch, shipped alongside.
- **Discovery:** Orbit finds related projects (package.json, Cargo.toml, pyproject, go.mod, in both directions) and suggests attaching them.
- **Per-repo defaults:** folders a repo always attaches.
- Claude gets each folder via `--add-dir`; Codex through its instructions; both see the folders and their role in the workspace context.

### 4. Preflight

`/shipkit:preflight` checks a change from both sides before shipping, because when you work across many projects it's easy to break one without noticing. It finds what changed at the boundaries (exports, APIs, CLI flags, config, schemas, versions), searches this repo and every attached folder for consumers, and reports each change as **Safe / Risky / Breaking** with file:line evidence and a suggested fix. Advisory: it reports, it doesn't block.

### 3. Profiles

A profile is a mode for a whole workspace session: instructions, agent and model, skills and pinned chips, and permissions (read-only enforced where set). Profiles use the standard Claude agent file format, so any skill pack can add its own. Starters: **Builder** (default), **Debugger**, **Planner** (read-only), **Reviewer** (read-only), **Shipper**, **Ticket writer**. Pick one in New workspace or switch mid-session; the agent is told its new role.

### 2. Attention inbox

With many agents running, you shouldn't have to click through workspaces to see who needs you. The inbox lists every session that finished, failed, asked a question, or has failing checks or requested changes, with a snippet of the agent's last message. Each row offers rule-based suggestions instantly and AI suggestions underneath; one click (or a number key) sends one. Reply inline, open, dismiss or snooze; keyboard-first (j/k, Enter, 1–3). An **All** tab shows what every workspace is doing.

### 1. Focus on the conversation

Orbit is built for fast iteration, so the chat gets the space. The Ship panel stays hidden until you click **Ship** (the button carries a PR number and checks dot), the sidebar is slim and collapses to an icon rail, the chat column is wide, and focus mode hides everything but the conversation.

## Parked

Ideas set aside, with the reason.

_(none)_
