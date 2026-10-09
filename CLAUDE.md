# Orbit

Orbit is a personal desktop IDE for running a fleet of coding agents (Claude Code + Codex) in parallel git worktrees, focused on shipping: skills, PRs, tickets. Plan/roadmap: see "Milestones" below.

## Stack
- **Tauri 2** — Rust core in `src-tauri/`, React 19 + TypeScript + Tailwind v4 UI in `src/`.
- State: zustand (`src/stores/app.ts`). Persistence: SQLite at `~/.orbit/state.db`. Worktrees: `~/.orbit/worktrees/<repo>/<slug>`. (Pre-rename `~/.agentic-ide` is migrated on first launch.)

## Commands
- `bun run app` — run the desktop app (wraps `tauri dev` with the VS 2022 MSVC toolchain; VS 2026 here lacks x64 libs).
- `bun run dev` then open http://localhost:1420 — **UI-only mode with a mock backend** (`src/lib/mock.ts`). Fastest loop for UI work; verify visual changes here.
- `bunx tsc --noEmit` — typecheck UI.
- `bun run e2e` — drives the **real** desktop app (debug build + `bun run dev` running) via WebView2 remote debugging, with real agents in a scratch repo under `.e2e/` (isolated `ORBIT_HOME`). Add a step to `scripts/e2e.mjs` for every user-facing feature.
- **`PLANNING.md` holds feature ideas being discussed.** Record ideas there and iterate with the user; don't build them until they're agreed and moved to FEATURES.md.
- **`FEATURES.md` is the source of truth for what's built.** Update its row when you build or verify a feature; only mark ✅ after it works in the real app.
- Rust: `cmd //c "scripts\\cargo.cmd test"` (or `build`) from bash; it wraps the VS 2022 toolchain. Add `-- --include-ignored` for live tests against real agent CLIs.

## Architecture
- `src-tauri/src/agent/` — each agent CLI is driven over stdio and normalized into `AgentEvent` (`mod.rs`). **The UI never sees agent-specific shapes.**
  - `claude.rs`: `claude -p --input-format stream-json --output-format stream-json …`, one long-lived process per workspace; interrupt = stdin `control_request`.
  - `codex.rs`: `codex app-server` JSON-RPC; mid-turn messages use `turn/steer`. Protocol types: `codex app-server generate-ts --out <dir>`.
  - `process.rs`: spawns windowless children and scrubs host Claude env vars (`CLAUDECODE`, `CLAUDE_CODE_*`, …) — without this, launching from inside a Claude session breaks child auth.
- Parsers are pure functions tested against `src-tauri/tests/fixtures/*.jsonl`. When an agent's output format changes, **record a real stream into a fixture first**, then fix the parser.
- `skills.rs` — skill packs in `~/.orbit/packs/<name>` (standard Claude plugin layout; installed by git URL). Skill id = `<plugin>:<folder-or-file-stem>`; this matches what Claude registers (it ignores frontmatter `name`). Claude runs skills natively (`--plugin-dir` + `/<id> args`). Codex can't load foreign skills (its `{type:"skill"}` input only resolves skills in its own registry), so `expand()` inlines them.
- `src-tauri/shipkit/` — the bundled shipping pack (embedded via `include_str!`, rewritten to `packs/shipkit` on startup). Commands read branch/base/issue from the workspace context prompt (`workspace_context` in `lib.rs`: Claude `--append-system-prompt`, Codex `developerInstructions`), not template variables, so they stay portable markdown.
- Profiles: `shipkit/agents/*.md` (Claude agent format + Orbit keys `agent`, `readonly`, `skills`), listed by `skills::list_profiles`, appended to `workspace_context` as "Your role". Read-only is enforced, not just prompted (Claude: `--permission-mode default` + the `READONLY_ALLOW` allowlist; Codex: read-only sandbox). Switching profile queues a one-shot hand-over note (`role_notices`) for the next message.
- Attachments (`related.rs`, `attachments` table): extra folders passed to Claude as `--add-dir` and listed in the context prompt; editable ones get their own worktree.
- **Never call a helper that locks `db()` inside an expression that already holds `state.db()`.** `std::sync::Mutex` isn't reentrant, so the command deadlocks. Bind the result first.
- `gh.rs` — PR status/checks/merge via the `gh` CLI.
- `lib.rs` — Tauri commands + `on_agent_event` (persist → update status → notify → emit `agent-event` / `workspace`).
- `src/lib/ipc.ts` mirrors the Rust types; keep them in sync (serde uses camelCase).
- Attention inbox: `db.rs` keeps per-workspace `seen_seq`/`dismissed_seq` and builds `Summary` rows; `src/lib/attention.ts` (pure) decides why a workspace needs you and the rule suggestions; `suggest_prompts` in `lib.rs` adds AI suggestions via a one-shot `claude -p --model haiku --tools "" --json-schema …`.
- `src/lib/transcript.ts` folds events into render blocks (consecutive tool calls → one collapsible group).

## Conventions
- **Colour is reserved for function.** Chrome is greyscale (dark "Void" by default, light "Paper" via Ctrl+Shift+L; `data-theme` on `<html>`, `src/lib/theme.ts`). Hues only carry meaning: `run` (working), `ok` (done / additions), `bad` (error / deletions), `warn`, `info`, `merged`. `accent` is the neutral emphasis ink (white on dark), not a brand colour. Never add decorative colour.
- **All UI text is Inter** (400 body, 500 UI labels, 600 headings; `tabular-nums` for numbers). JetBrains Mono only for literal code: code blocks, inline code, tool commands/paths, tool output. Never `font-mono` on chrome (labels, chips, keys, badges). Keep weights restrained; no font-bold in UI chrome. Small radii (3–6px), 1.5px borders, hard offset shadows (`shadow-hard`, `shadow-hard-sm`).
- Use the theme tokens (`bg-panel`, `text-mute`, `border-line-strong`, `bg-run`, …), never raw hex in components.
- Dither (`src/lib/dither.tsx` + `.dither-*` utilities in `index.css`) is a 1-bit Bayer mask; colour comes from the element's background (`bg-run` for running sweeps/progress, `bg-line-strong` for rules). Use it for rules, the selected-row fade, running sweeps, and progress, never behind body text.
- Brand mark: `src/assets/orbit.png` (the user's dithered black hole). `OrbitMark` (ui.tsx) for small sizes, `OrbitHero` for the start page (planet orbiting, passes behind the horizon). `.orbit-art` blends it onto either theme. App icons: `bunx tauri icon src/assets/orbit.png -o src-tauri/icons`.
- Every new action gets a palette entry (`Palette.tsx`); frequent ones get a shortcut.
- Agents run unattended in their worktree (Claude `bypassPermissions`, Codex `never`/`danger-full-access`).

## Milestones
1. ✅ Scaffold, 2. ✅ Claude/Codex chat with streaming, interrupt, resume, 3. 🟡 Fleet (worktrees, sidebar, notifications, palette ✅; fleet board ⬜)
4. ✅ Codex adapter (model picker ✅)
5. ✅ Skill packs (install any pack by git URL, enable/update/remove; only shipkit is bundled), `/` autocomplete, pinned skill chips, palette skills, bundled `shipkit`, Ship panel (PR state, checks, fix CI / address comments / ready / merge). Next: per-workspace pack toggles.
6. ⬜ GitHub Issues panel, start-from-issue
7. ⬜ Polish: settings UI, worktree cleanup
