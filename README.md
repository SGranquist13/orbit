# Orbit

Run a fleet of coding agents in parallel git worktrees and ship.

Orbit is a desktop IDE for people who work with Claude Code and Codex all day. Each task gets its own git worktree and branch, so many agents can work at once without stepping on each other or on your checkout. An inbox tells you which sessions need you, and when a task is done you take it from diff to pull request, CI and merge without leaving the app. It is built around shipping rather than editing: the agents write the code, Orbit keeps the fleet organised.

![Orbit](docs/screenshot.png)

**Status:** v0.1.0 · Windows 10/11 · unsigned installer. See [FEATURES.md](FEATURES.md) for what is proven in the real app and what is only built.

## Highlights

- **Fleet of workspaces.** One git worktree and branch per task, Claude Code and Codex side by side, streaming chat, interrupt, resume after restart, per-workspace profiles (Builder, Debugger, Planner, Reviewer, Shipper) with read-only profiles enforced rather than just prompted.
- **Attention inbox.** Sessions that finished, failed, asked a question or have failing checks, with suggested replies you can send in one keystroke.
- **Ship panel.** Commit, push and open a draft PR, watch checks, fix failing CI, mark ready and merge. Orbit can run your project's check command before shipping and keeps save-point commits out of the PR history.
- **GitHub issues.** Browse a repo's issues, start a workspace from one, turn rough notes into a formatted ticket.
- **Skill packs.** Install Claude-plugin-style skill packs from a git URL; `/` autocomplete and pinned skill chips. A `shipkit` pack ships with the app.
- **AI teammates and Chief.** Named teammates with their own instructions and memory take tasks and report back; Chief splits a vague request into parts for the others. Hand-off chips move work from planner to builder to reviewer.
- **Routines.** Scheduled agent runs ("every Monday at 9"), archived automatically when they find nothing to do.
- **Simplify.** A read-only pass finds cleanups in your diff and applies the low-risk ones, each in its own commit, reverting any that break the checks.

## Requirements

To run Orbit:

- Windows 10 or 11 with the WebView2 runtime (present on current Windows).
- [Claude Code](https://claude.com/claude-code) and/or the Codex CLI, installed and logged in.
- `git`.
- The GitHub CLI `gh`, logged in, for the Ship panel and Issues.

To build from source, additionally:

- [Bun](https://bun.sh)
- Rust (stable) with the MSVC target and the Visual Studio C++ build tools (Desktop development with C++, x64). Visual Studio 2022 is the tested version.

## Install

Download the installer from the [Releases](https://github.com/SGranquist13/orbit/releases) page and run it. The installer is not code-signed yet, so Windows SmartScreen may warn you: click **More info**, then **Run anyway**.

## Build from source

```
bun install
bun run app          # run the desktop app in dev mode
bun run app:build    # build the NSIS installer
```

`bun run app` and `bun run check:guards` go through `scripts/cargo.cmd` and `scripts/tauri.cmd`, which put the MSVC toolchain on PATH. They use `cl.exe` if it is already on PATH (for example in a Developer Command Prompt), otherwise the `vcvars64.bat` named by the `VCVARS` environment variable, otherwise they look for a Visual Studio install with `vswhere` (preferring VS 2022).

## Mock UI mode

```
bun install
bun run dev
```

Then open http://localhost:1420. This runs the whole UI against a fake backend with sample data, so it needs no agents, no git repositories and no accounts. It is the fastest way to look around or work on the interface.

## Where your data lives

Everything is under `~/.orbit`: the SQLite state database (`state.db`), worktrees (`worktrees/<repo>/<slug>`), installed skill packs (`packs/`) and teammate definitions (`teammates/`). Your repositories are not copied; workspaces are git worktrees of them.

## Security

- **Agents run unattended by default.** Claude runs with `bypassPermissions` and Codex with approval `never` and `danger-full-access`, inside the workspace's worktree. They can run any command your user can. To tighten this, open Settings > Agents and switch Claude to "Accept edits" and Codex to "workspace-write". Read-only profiles are always enforced regardless of these settings.
- **Skill packs are code.** A pack installed from a git URL can instruct agents that run unattended. Install packs you trust.
- **The mobile bridge is off by default.** When you turn it on (Settings > Mobile), Orbit listens on all network interfaces on the configured port; connections need a pairing code and are encrypted. Turn it off when you are not using it.
- **Local only, no telemetry.** Orbit has no analytics or crash reporting. The network traffic it generates itself is limited to: the agent CLIs it launches (Claude Code, Codex) and whatever those talk to; `git` and `gh` for GitHub; a local-model server (Ollama or an OpenAI-compatible URL) if you configure one under Settings > Models; and Expo push notifications (device name and status only) if you pair a phone.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Testing

```
bunx tsc --noEmit        # typecheck the UI
cd src-tauri && cargo test      # Rust unit tests (use scripts\cargo.cmd test to get the MSVC toolchain)
bun run check:guards     # clippy; includes the db-lock guard lint
```

The end-to-end suites (`bun run e2e`, `bun run e2e:github`) drive the real app with real agents and cost model usage, so they are maintainer-only. `e2e:github` also creates real PRs and issues; it needs `ORBIT_GH_SANDBOX` set to a private sandbox repo you own whose CI fails when a file named `FAIL` exists (the script explains how to set one up).

## Experimental

- **Local-model agents** (Ollama and similar, Settings > Models) are experimental. Utility tasks such as commit messages and suggestions can use a local model more reliably than whole agent sessions can.
- **The mobile companion app** is not released yet. The bridge in `src-tauri/src/remote/` is in the repository but there is no public app to pair with.

## Licence

[MIT](LICENSE). Bundled fonts and dependency licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). See [CHANGELOG.md](CHANGELOG.md) for release notes and [CONTRIBUTING.md](CONTRIBUTING.md) if you want to help.

The Orbit name and black-hole artwork (`src/assets/orbit.png` and the app icons made from it) are by SGranquist13.
