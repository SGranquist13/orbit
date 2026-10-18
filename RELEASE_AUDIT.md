# Orbit 0.1.0 release audit

Started 2026-10-17. Target: public, open-source **v0.1.0** on GitHub (Windows 10/11).
**Nothing in this file has been fixed yet.** Review it, then approve, and all fixes happen in one pass.

Severity: **blocker** = must fix before 0.1.0 · **major** = fix, or hide the feature for 0.1 · **minor** · **polish**. Size: S / M / L.

## Summary

_Draft. Filled in when the e2e runs finish._

| | blocker | major | minor | polish |
|---|---|---|---|---|
| Release / open source (R) | 3 | 7 | 9 | 2 |
| Backend (B) | 0 | 6 | 4 | 3 |
| UI (U) | 0 | 5 | 7 | 4 |
| Build / quality (Q) | 0 | 0 | 2 | 1 |
| e2e (E) | _pending_ | | | |

## Baseline (2026-10-17, tree at `173d0ec`)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | ✅ pass |
| `cargo test` (`scripts/cargo.cmd test`) | ✅ 168 pass, 0 fail, 8 ignored (opt-in live) |
| `bun run check:guards` (clippy) | ✅ pass, 13 style warnings |
| `bun run build` (Vite) | ✅ pass; main chunk 738 kB (218 kB gzip) |
| `bun run e2e` | _pending_ |
| `bun run e2e:github` | _pending_ |
| `bun run app:build` (installer) | _pending_ |
| Fresh-clone build | _pending_ |

## Findings

### R: Release and open source

| ID | Sev | What's wrong | Evidence | Suggested fix | Size |
|---|---|---|---|---|---|
| R1 | blocker | No LICENSE. Public code without one is "all rights reserved". No `license` field in package.json / Cargo.toml | repo root | Add MIT (deps are MIT/Apache/ISC/OFL, only transitive MPL-2.0, compatible); set `license` fields | S |
| R2 | blocker | No README, CHANGELOG or CI. Nobody has an entry point | repo root | README (see "README must cover" below), CHANGELOG 0.1.0, GitHub Actions: tsc + vite build, cargo test + clippy on windows-latest | M |
| R3 | blocker | Brand mark `src/assets/orbit.png` (source of all icons) has no recorded origin | FEATURES.md:140 | **You** confirm you own it (or replace it / credit its licence) | S |
| R4 | major | No git remote and no GitHub release yet | `git remote -v` empty | Create the public repo, push, and publish a release with the installer attached | S |
| R5 | major | Installer is unsigned and has no `bundle.windows` block, so it triggers a SmartScreen warning; `targets: "all"` | tauri.conf.json | Document "More info → Run anyway" in README; set targets `["nsis"]` (or nsis+msi); signing later | S |
| R6 | major | `scripts/cargo.cmd` / `tauri.cmd` hard-code the VS 2022 Community vcvars path; `app`, `app:build`, `check:guards` depend on them | scripts/cargo.cmd:3-4, tauri.cmd:3-4 | Find vcvars via `vswhere`, skip if `cl.exe` already on PATH, document `VCVARS` | S |
| R7 | major | Bun required but undocumented (`beforeDevCommand` etc.) | tauri.conf.json, bun.lock | README prerequisites | S |
| R8 | major | `e2e:github` defaults to your private sandbox `SGranquist13/orbit-e2e-sandbox` | scripts/e2e-github.mjs:3,13 | Require `ORBIT_GH_SANDBOX`, document how to create a sandbox | S |
| R9 | major | CLAUDE.md has machine/owner-specific notes (VS 2026 "here", your nvm firewall rules, home `codex` npm package, "How the user likes to work") | CLAUDE.md | Decide if it ships; if so trim those lines; add a short CONTRIBUTING.md either way | M |
| R10 | major | Mobile bridge depends on the unpublished `../ide_mobile` repo (protocol spec lives only there) | remote/mod.rs:1-2, server.rs, CLAUDE.md, PLANNING.md | Publish ide_mobile, or copy `protocol.md` into `docs/`, or label the mobile bridge "companion app not yet released" (see hide list) | M |
| R11 | major | Cargo.toml `authors = ["you"]` (scaffold leftover); no `repository`/`license`/`homepage` in Cargo.toml or package.json | src-tauri/Cargo.toml:5 | Fill in metadata | S |
| R12 | minor | Bundle identifier `dev.steven.orbit` is personal and **can't change after release** without orphaning user data | tauri.conf.json:4 | Decide now (e.g. `io.github.sgranquist13.orbit`) | S |
| R13 | minor | No bundle `publisher`/`copyright`/`shortDescription`; `csp: null` | tauri.conf.json | Fill in; set a restrictive CSP (see B7) | S |
| R14 | minor | Mock data and a unit test show your name/paths (`C:/Users/steven`, `steven/` prefix, "Steven's iPhone") | src/lib/mock.ts (many), mock-launch.ts:234, settings.rs:414 | Neutral values (`you/`, "Alex's iPhone") | S |
| R15 | minor | OFL fonts (Inter, JetBrains Mono) bundled without their licence text | node_modules/@fontsource-variable/*/LICENSE | THIRD_PARTY_NOTICES.md + include in installer or About | S |
| R16 | minor | Cargo licence scan only covered locally cached crates | ~/.cargo/registry | `cargo deny check licenses` in CI; generate notices with `cargo about` | S |
| R17 | minor | FEATURES.md / PLANNING.md are internal working docs (fine to publish; no secrets) but reference ide_mobile | FEATURES.md, PLANNING.md | Light pass; maybe move PLANNING.md to `docs/` | S |
| R18 | minor | e2e not runnable by contributors (needs logins, sandbox, model spend) | scripts/e2e*.mjs | README: maintainer-only; contributors run tsc + cargo test | S |
| R19 | minor | Untracked `.e2e-run-*.log` in repo root contain local paths (gitignored, harmless if pushed via git) | repo root | Delete locally | S |
| R20 | minor | Agents run unattended by default and the bridge opens a LAN port when enabled: needs to be stated | CLAUDE.md conventions | README Security section + SECURITY.md | S |
| R21 | polish | No CONTRIBUTING / issue templates | — | Minimal CONTRIBUTING.md | S |
| R22 | polish | Check that the name "Orbit" doesn't clash with a well-known dev tool before announcing | — | Quick search; maybe "Orbit IDE" in titles | S |

Secrets scan: **clean**: working tree and all 84 commits; no tokens, keys or `.env` files; commit email is the GitHub noreply address. Nothing to rotate.

### B: Backend robustness (Rust)

| ID | Sev | What's wrong | Evidence | Suggested fix | Size |
|---|---|---|---|---|---|
| B1 | major | **Archive destroys uncommitted work**: `git worktree remove --force` with no dirty check (only cleanup/detach check `is_clean`) | lib.rs:981-995, git.rs:128-131 | Refuse on dirty tree unless confirmed "discard changes"; drop `--force` by default | S |
| B2 | major | Archive fails when the worktree folder was already deleted by hand, so the workspace can never be archived | lib.rs:988-996 (trunk.rs:481 guards it, this path doesn't) | Skip removal if missing; `git worktree prune` | S |
| B3 | major | Missing `gh`/binary errors are unreadable: `err()` uses `e.to_string()`, which drops anyhow context, so users see the command line, not "gh not installed" | git.rs:19, lib.rs:37-39 | `format!("{e:#}")`; map `NotFound` to "`gh` is not installed (cli.github.com)" | S |
| B4 | major | No git installed → `add_repo` says "not a git repository" | lib.rs:345 | Probe `git --version` first | S |
| B5 | major | Startup failures are fatal and silent (can't create `~/.orbit`, corrupt/newer `state.db`): no window, no message | lib.rs:1187, 1296-1299, 1323 | Native error dialog with path + reason; move a corrupt db aside | M |
| B6 | major | Poisoned-mutex cascade: `db()` / `sessions` / `role_notices` use `.lock().expect/unwrap`; one panic bricks every command until restart | lib.rs:52-54 + ~15 sites | `unwrap_or_else(\|p\| p.into_inner())` helper (as `trunk::lock` does) | S |
| B7 | minor | `get_setting`/`set_setting` accept any key from the webview, including `remote_keypair`; with `csp: null` an XSS in rendered markdown could read the phone-bridge key | lib.rs:1175-1182 | Allowlist keys (block `remote_*`); set CSP | S |
| B8 | minor | Undo last turn = `reset --hard HEAD~1` also discards edits made since the save point | trunk.rs:226-237 | Confirm text says so, or stash first | S |
| B9 | minor | Pack install: no `--` before URL in `git clone`; packs run under unattended agents (code execution by design) | skills.rs:118-129 | Add `--`; warning text in install dialog | S |
| B10 | minor | Bridge binds 0.0.0.0, not configurable (off by default, pairing-gated) | remote/mod.rs:211 | Explain in Settings > Mobile; optional bind choice | S |
| B11 | polish | `add_repo` / `attach_folder` are sync commands that spawn git on the main thread | lib.rs:344-359, 595-601 | Make async + `spawn_blocking` | S |
| B12 | polish | A few `expect`s on invariants | teammates.rs:766, settings.rs:297, skills.rs:100 | Optional `ok_or_else` | S |
| B13 | polish | If `claude` is missing, utility calls (names, suggestions) fail silently | llm.rs:92-139 | Show once in Settings > Agents banner | S |

Checked and OK: no shell injection (all git/gh via `Command::args`; branch names are slugified), no db-guard reentrancy, no lock held across `.await`, no hard-coded personal paths in runtime code.

### U: UI

| ID | Sev | What's wrong | Evidence | Suggested fix | Size |
|---|---|---|---|---|---|
| U1 | major | Global shortcut handler ignores Shift/Alt: **Ctrl+Shift+I opens the Inbox and DevTools at the same time**, and Ctrl+Shift+K/B/N/,/. fire the plain-Ctrl actions | src/App.tsx:38-84 | Require `!shiftKey && !altKey` on unshifted bindings | S |
| U2 | major | Shortcuts reference omits Ctrl+Shift+E (Routines) and Ctrl+Shift+T (Teammates) | settings/sections.tsx:51-65 vs App.tsx:50-57 | Add rows | S |
| U3 | major | If loading a transcript fails, chat spins forever with no error and no retry | stores/app.ts:250, Chat.tsx:89,320 | catch → error state + Retry | S |
| U4 | major | Ship has no in-flight guard: double-click runs checks twice and can start two `shipkit:ship` turns; no "Running checks…" feedback | RightPanel.tsx:132,211; stores/app.ts:454-466 | Per-workspace `shipping` flag, disable + spinner | S |
| U5 | major | No palette entry for Archive workspace (convention: every action has one) | Palette.tsx | Add with the same confirm flow | S |
| U6 | minor | `getSettings` failure swallowed; Settings shows defaults and a later save could overwrite real values | stores/app.ts:239 | Error state on the Settings page | S |
| U7 | minor | `init()` marks initialized before its awaits, so a failed startup load can never retry | stores/app.ts:221-223 | Set after success | S |
| U8 | minor | Interrupt (Esc / stop button) failures are unhandled rejections with no UI error | Chat.tsx:785,861 | Route through store + setError | S |
| U9 | minor | Settings > Mobile swallows bridge errors (port in use / firewall) and shows "No phones paired yet" | settings/Mobile.tsx:61-62 | Show the error | S |
| U10 | minor | Palette missing: Stop agent, Toggle theme, Open teammates, Archived workspaces, Clean up merged worktrees | Palette.tsx | Add entries | S |
| U11 | minor | Ship panel actions (Ship, Mark ready, Merge, Fix CI, Address comments) not in palette | Palette.tsx, RightPanel.tsx | Add, gated on PR state | M |
| U12 | minor | Six IPC wrappers/commands with no UI caller (`getSetting`, `setSetting`, `getTeammate`, `stopSession`, `workspaceSummary`, `workspaceUsage`) | ipc.ts ~621-738 | Remove or mark as used by mobile/e2e | S |
| U13 | polish | `window.__ORBIT_AUTOCONFIRM__` (e2e hook) honoured in release builds | lib/confirm.ts:6-8 | Only in dev/debug builds | S |
| U14 | polish | Mock chunk (65 kB) shipped in the release bundle (unreachable in Tauri) | main.tsx:9-11 | Gate on `import.meta.env.DEV` | S |
| U15 | polish | Two different "am I in Tauri" checks (`__TAURI_INTERNALS__` vs `isTauri`) | main.tsx:9, confirm.ts:8, theme.ts:30 | One `isTauri()` helper | S |
| U16 | polish | Stale comment on palette scope ("Ctrl Shift T") | Palette.tsx:19 | Fix comment | S |

Checked and OK: 93/93 IPC commands registered; every setting exposed and read (no dead toggles); no raw hex outside avatars, `font-mono` only on code, no stray console.log/TODO/lorem; mock not reachable in the Tauri build.

### Q: Build and quality

| ID | Sev | What's wrong | Evidence | Suggested fix | Size |
|---|---|---|---|---|---|
| Q1 | minor | Main JS chunk 738 kB (Vite >500 kB warning) | `bun run build` | Lazy-load Settings / Teammates / Routines views | S |
| Q2 | minor | `plugin-dialog` dynamically imported in confirm.ts but statically elsewhere (ineffective split) | Vite INEFFECTIVE_DYNAMIC_IMPORT | Pick one | S |
| Q3 | polish | 13 clippy style warnings (too many args ×3, large Err variant, …) | `check:guards` | Clean up opportunistically | S |

### E: Real-app e2e

_Pending: `bun run e2e`, `bun run e2e:github`, then new steps for 🟢 features._

## Hide for 0.1 (proposed)

Instead of fixing, ship these behind a flag or labelled "experimental" in the UI and README:
- Local-model **agents** (`local:<model>` in New workspace). Small models can't complete tool calls; meters are wrong.
- Mobile companion (Settings > Mobile) until `ide_mobile` is published (R10).
- Editable attached folders shipped as linked PRs across repos (needs a second sandbox to verify).

## Feature coverage

_Filled in after e2e: every FEATURES.md row → ✅ verified now / ✗ broken / ⚠ unverifiable + why._

## Manual checks for you (~20 min, real app)

- [ ] Add repository via the native folder picker
- [ ] Native confirm dialogs: archive, merge, remove pack
- [ ] OS notification when a turn finishes with the window unfocused
- [ ] App icon in the taskbar and the installer
- [ ] Start-page animation
- [ ] Pair a phone, revoke it, receive a real push (only if mobile ships in 0.1)
- [ ] Install the built installer on a clean Windows user profile, launch, add a repo, run one turn, uninstall

## README must cover

- What Orbit is (tagline: "run a fleet of coding agents in parallel worktrees and ship"), screenshot/GIF, status "v0.1.0, Windows 10/11, unsigned"
- Runtime prerequisites: Claude Code and/or Codex CLI (logged in), git, `gh` (for Ship/Issues), WebView2
- Build prerequisites: Bun, Rust (MSVC), VS 2022 Build Tools C++ workload, `VCVARS`
- Quick start: `bun install`, `bun run dev` (mock UI, no agents needed), `bun run app`, `bun run app:build`
- Where data lives (`~/.orbit`), and that nothing leaves the machine except via the agent CLIs / optional Ollama
- Security: unattended agents by default and how to tighten it; mobile bridge off by default; how to report issues
- Feature overview → FEATURES.md (what's real-app verified)
- Testing for contributors; e2e is maintainer-only
- Licence, third-party notices, SmartScreen note
