# Contributing

Thanks for looking. Orbit is a personal project that is now public; issues and focused pull requests are welcome.

## Prerequisites

- [Bun](https://bun.sh)
- Rust (stable, MSVC) and the Visual Studio C++ build tools (x64). Visual Studio 2022 is the tested version; `scripts/cargo.cmd` and `scripts/tauri.cmd` find it (or use `VCVARS` / an existing `cl.exe`).
- `git`, and for the Ship/Issues features `gh`. Claude Code and/or Codex only if you want to run real agents.

## Working on the UI without agents

```
bun install
bun run dev      # http://localhost:1420, fake backend in src/lib/mock.ts
```

Most UI work can be done and checked here. Run the real app with `bun run app`.

## Checks before a pull request

```
bunx tsc --noEmit
scripts\cargo.cmd test        # or `cargo test` in src-tauri with the MSVC toolchain on PATH
bun run check:guards          # clippy, including the db-lock reentrancy lint
```

The e2e suites (`bun run e2e`, `bun run e2e:github`) use real agents and cost model usage; they are maintainer-only. If you change a user-facing feature, describe how you checked it.

## Using AI coding agents
If you use coding agents, [CLAUDE.md](CLAUDE.md) is the project brief written for them (architecture, known traps, conventions), and its "Working with Codex" section explains how to hand work to Codex. Agents' changes go through the same checks and e2e as yours.

## Commits

Use conventional commit messages (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`), one logical change per commit.

## Conventions

- **Colour is reserved for function.** The chrome is greyscale (dark "Void", light "Paper"); hue only means something: working, done, error, warning, merged. No decorative colour (AI teammate avatars are the one exception).
- **All UI text is Inter.** JetBrains Mono only for literal code. Restrained weights, small radii, 1.5px borders.
- Use theme tokens (`bg-panel`, `text-mute`, `border-line-strong`, ...), never raw hex in components.
- Every new action gets a command palette entry; frequent ones get a shortcut.
- Every behaviour should be adjustable in Settings; no dead toggles.
- `src/lib/ipc.ts` mirrors the Rust types (serde camelCase); keep them in sync.
- Agent output is normalised into `AgentEvent` in Rust; the UI never sees agent-specific shapes. Parsers are tested against recorded fixtures in `src-tauri/tests/fixtures`: record a real stream first, then fix the parser.
- Never call a helper that locks `db()` while already holding it (`std::sync::Mutex` is not reentrant); `bun run check:guards` catches the common forms.
- Update [FEATURES.md](FEATURES.md) when you build or verify a feature: new features start as Preview and become Available once they work end to end in the real app.

More background is in [CLAUDE.md](CLAUDE.md), which doubles as the architecture notes.
