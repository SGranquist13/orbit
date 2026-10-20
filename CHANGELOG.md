# Changelog

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
