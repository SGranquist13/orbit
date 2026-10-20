# Changelog

## Unreleased

## 0.2.0 - 2026-10-20

Two headline features: a built-in code editor that lets you watch agents work, and images and files in chat.

### Code view (Alt+2)
- A built-in editor on CodeMirror 6: explorer, tabs, quick open (Ctrl+P), find and replace, go to line, themed for Void and Paper. Opens any repo, workspace or folder.
- Integrated terminal with several tabs (Ctrl+\`), project search with regex, case, whole-word and glob filters (Ctrl+Shift+F), git gutter, and side-by-side diffs against HEAD or the base branch.
- **Watch mode** follows the agent as it edits, with change flashes, gutter marks and a per-turn activity timeline; the editor is read-only while the agent runs.
- Ask about a selection (Ctrl+I) sends the lines and your question to the workspace's agent; Open in Code from the chat header, Ship panel and palette.
- Preview: live typing (the agent's edits stream in as they are written), a "Watch an agent" picker on any folder, Manual mode that never overwrites unsaved work silently (Reload, Keep mine, Compare), and Settings > Editor.

### Images and files in chat
- Paste, drop or attach images and files in the composer. Images go to Claude and Codex natively; files are passed as paths the agent reads with its own tools. Thumbnails, file chips and a lightbox in the chat.
- Preview: images from the agent (screenshots it reads, Codex image view and generation, markdown images) shown in the chat.

### Agents and skills
- Model lists come from the agent CLIs (Codex's model catalog, Claude's aliases) plus custom model ids; refresh in Settings > Agents or the palette.
- Preview: per-workspace skill pack toggles.

### Look and feel
- Preview: VS Code keybindings everywhere (Ctrl+K chords included), rebindable in Settings > Keyboard shortcuts with key recording, conflict detection and reset.

### Fixes
- Cancelling "discard uncommitted changes" when archiving no longer shows an error.
- An agent's atomic file replace no longer shows up as a deleted file in the Code view.

## 0.1.0 - 2026-10-18

First public release. Windows 10/11, unsigned installer. Features below are the ones verified in the real app (see [FEATURES.md](FEATURES.md) for everything available, in preview and on the roadmap).

### Workspaces and agents
- One git worktree and branch per task; many workspaces running in parallel.
- Claude Code (stream-json) and Codex (app-server) with streaming text, collapsible tool-call groups, follow-ups, interrupt, and resume after restart.
- Workspace profiles (Builder, Debugger, Planner, Reviewer, Shipper, Ticket writer) with enforced read-only modes and a hand-over note when the role changes.
- Attached folders and related-project discovery.
- Command palette (Ctrl+K).

### Attention inbox
- Sessions that finished, failed, asked a question or have failing checks; rule-based and AI reply suggestions; inline reply, dismiss, snooze, keyboard navigation.

### Shipping and GitHub
- Ship panel: draft PR, checks, ready for review, squash and merge, Fix CI.
- Checks run by Orbit before shipping, save-point commits after each turn, and squashing of work-in-progress commits.
- Issues panel, start a workspace from an issue, `write-ticket` and `preflight` skills.

### Skills
- Bundled `shipkit` pack; install packs by git URL; `/` autocomplete; pinned skill chips; native Claude skill support.

### Teammates, routines, Simplify
- AI teammates with memory, Chief task planning, and hand-off chips between teammates.
- Routines (scheduled agent runs).
- Simplify: read-only find pass plus automatic application of low-risk cleanups.

### Look and platform
- Dark (Void) and light (Paper) greyscale themes with Inter and JetBrains Mono bundled offline.
- Tauri 2 desktop app with an NSIS installer; mock UI mode (`bun run dev`) for development without agents.

### Known limitations
- The installer is not code-signed; SmartScreen will warn.
- Local-model agents and the mobile bridge are experimental; the mobile companion app is not released.
