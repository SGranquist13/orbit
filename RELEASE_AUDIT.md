# Orbit 0.1.0 release audit

Run 2026-10-17 → 2026-10-18 (overnight). Target: public, open-source **v0.1.0** on GitHub (Windows 10/11).
Everything is on local `main`. **Nothing has been pushed.**

## Verdict

**Ready to release after your morning review and the four decisions below.**
- Both real-app suites pass on the fixed tree.
- All code findings are fixed.
- Release docs, licence and CI config are in place.
- The installer builds.

What's left is your judgement (logo rights, identifier, publishing), a 20-minute manual check, and a screenshot for the README.

## Results on the final tree

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | ✅ pass |
| `cargo test` | ✅ 175 pass, 0 fail, 8 ignored (opt-in live); was 168 before the audit |
| `bun run check:guards` (clippy) | ✅ pass, **0 warnings** (was 13) |
| `bun run build` | ✅ main chunk **381 kB** (was 738 kB); views lazy-loaded; mock not in production bundle |
| `bun run e2e` (real app, Claude haiku + Codex) | ✅ **23/23** (run 3), no React errors in the page log |
| `bun run e2e:github` (real PRs/CI/issues in the sandbox) | ✅ **7/7** (run 5); first full run since 2026-10-09 |
| `bun run app:build` | ✅ `src-tauri/target/release/bundle/nsis/Orbit_0.1.0_x64-setup.exe` (5.85 MiB, unsigned) |
| CI workflow (`.github/workflows/ci.yml`) | ⚠ written, **never run** (no remote yet) |
| Fresh-clone build | ⚠ not done (dropped to conserve usage; the CI workflow does this on first push) |

## Decisions for you (morning)

1. **Logo (R3, blocker):** confirm you own `src/assets/orbit.png`, the source of every app icon. If it's AI-generated or stock, check its terms or replace it.
2. **Bundle identifier (R12):** `dev.steven.orbit` is personal. It **can't change after release** without orphaning users' WebView2 data. Suggest `io.github.sgranquist13.orbit`. I left it alone.
3. **CLAUDE.md (R9):** it ships in the public repo as-is. It's useful to contributors, but it has machine-specific notes (VS 2026 here, your nvm firewall rules, home `codex` npm package, "How the user likes to work"). Trim those, or keep them. I did not edit it.
4. **Publishing (R4):** create the public GitHub repo `SGranquist13/orbit` (README/package.json already point there), push, let CI run once, then publish a release with the installer attached. Check that CI goes green before you announce.

Also before announcing: add `docs/screenshot.png` (the README references it). `bun run dev` then `?seed=launch` gives the launch-video fleet.

## Manual checks (~20 min, real app or installed build)

- [ ] Install `Orbit_0.1.0_x64-setup.exe` on a clean Windows user profile. Check the SmartScreen "More info → Run anyway" flow, launch, add a repo, run one turn, then uninstall.
- [ ] Add repository via the native folder picker
- [ ] Native confirms: archive (try it on a workspace **with uncommitted changes**; you should get a second "Discard uncommitted changes?" prompt), merge, remove pack
- [ ] OS notification when a turn finishes with the window unfocused
- [ ] Taskbar / installer icon; start-page animation
- [ ] Mobile pair + revoke + push, only if you decide to advertise it (it is labelled "companion app not yet released")

## What was fixed overnight

Each item has a commit on `main`. The merges are `d969fb9` (backend), `79e1b19` (UI) and `7cce24f` (docs/packaging), followed by follow-up fixes.

### Bugs found by the e2e runs
| | Finding | Fix |
|---|---|---|
| E1 | **Regression introduced by the audit's own U7 fix:** under React StrictMode `init()` ran twice and registered the agent-event listener twice. Every live event was appended twice, causing duplicate React keys and turn ends counted twice, so a Ship turn looked finished while it was still creating the PR. | `6a27737`: one init in flight (promise guard), still retries after a failure |
| E2 | Bundled teammates you'd messaged (Chief) vanished from the Teammates list, so you couldn't reach their thread | `45b9a62`: list starters with thread activity |
| E3 | Sidebar shortcut chips ("Ctrl Shift T") wrapped onto two lines next to a badge; the active skill chip's ⚡ icon was invisible (accent on accent) | small UI fix commit |
| E4 | e2e drift from the 2026-10-17 UI work: skill chips now open a preview, the packs button was renamed, a harness `waitFor` was missing `return`, and the merge step didn't expect the after-merge auto-archive | test fixes; the merge step now also **proves after-merge auto-archive** in the real app |

### Backend (B), all fixed except B13
- **B1:** archive no longer destroys uncommitted work. The backend refuses a dirty worktree with "Uncommitted changes: …", and the UI asks before discarding (force).
- **B2:** archive tolerates a worktree folder that's already gone (`git worktree prune`).
- **B3/B4:** readable errors. anyhow context is kept (`{e:#}`). A missing git/gh/claude/codex gives "`<tool>` is not installed or not on PATH" with an install hint, and `add_repo` says "Git is not installed".
- **B5:** startup failures show a native error dialog with the path and reason. A corrupt `state.db` is moved to `state.db.corrupt-<ts>` and recreated.
- **B6:** poison-tolerant locks (`relock`) for the db, sessions and role notices.
- **B7:** `get_setting`/`set_setting` allowlisted; the `remote_*` secrets are no longer reachable from the webview.
- **B8:** the Undo confirm text says it discards uncommitted edits.
- **B9:** `git clone … -- <url>`.
- **B10:** Settings > Mobile says it listens on all interfaces.
- **B11:** `add_repo` / `attach_folder` are async (spawn_blocking).
- **B12:** the remaining `expect`s now return errors.
- **Q3:** 0 clippy warnings.
- **B13 not changed:** Settings > Agents already shows "Not found on PATH".

### UI (U), all fixed
- **U1:** Ctrl+Shift+I no longer opens the Inbox alongside DevTools. Shift and Alt are matched explicitly.
- **U2:** the shortcuts reference lists Ctrl+Shift+E and Ctrl+Shift+T.
- **U3 / U6 / U7 / U8 / U9:** error and retry states for transcript load, settings load and startup. Interrupt failures show a toast, and bridge errors show in Settings > Mobile.
- **U4:** Ship has an in-flight guard and shows "Running checks…".
- **U5 / U10 / U11:** palette entries for Archive, Stop agent, Toggle theme, Open teammates, Archived workspaces, Clean up merged worktrees, Ship / Fix CI / Rebase / Address comments / Mark ready / Merge.
- **U12:** removed dead IPC wrappers.
- **U13:** the e2e autoconfirm hook works only in dev.
- **U14 / U15:** mock gated to dev; one `isTauri()` helper.
- **Q1 / Q2:** lazy-loaded views; consistent dialog import.
- **Labels:** experimental labels on `local:` agent models, and a "companion app not yet released" note in Settings > Mobile.

### Release / open source (R)
- **R1:** MIT LICENSE; licence, author and repository metadata in package.json and Cargo.toml (`authors` was the scaffold's `"you"`).
- **R2:** README.md, CHANGELOG.md (0.1.0), `.github/workflows/ci.yml` (tsc + vite build on ubuntu; cargo test + clippy on windows).
- **R5 / R13:** NSIS-only bundle with publisher, copyright, descriptions and category. CSP still `null` (see Open).
- **R6:** `scripts/vcvars.cmd` finds the MSVC toolchain itself: `cl.exe` already on PATH, then `VCVARS`, then vswhere (VS 2022 preferred), then the old path.
- **R7 / R18 / R20:** README covers the prerequisites, the SmartScreen warning, Security, and that e2e is maintainer-only.
- **R8:** `e2e:github` uses your sandbox only when `gh` is logged in as you; anyone else must set `ORBIT_GH_SANDBOX`.
- **R14:** neutral names in the mock and tests (no `steven/`, no "Steven's iPhone").
- **R15 / R21:** THIRD_PARTY_NOTICES.md (OFL fonts), SECURITY.md, CONTRIBUTING.md.
- **R19:** `.gitignore` covers `.e2e-run-*.log` and `.claude/*.lock`.
- **Secrets scan: clean** across the working tree and all history; the commit email is the GitHub noreply address.

## Open (not fixed, by choice)

| ID | Sev | Item | Why open |
|---|---|---|---|
| R3, R4, R9, R12 | blocker/major | Logo rights, publishing, CLAUDE.md, identifier | Your decisions (above) |
| R10 | major | Mobile bridge depends on the unpublished `ide_mobile` repo | Labelled "not yet released" in the app; publish `ide_mobile` or copy `docs/protocol.md` later |
| R13b | minor | No Content-Security-Policy (`csp: null`) | Needs a careful policy plus a full e2e run; B7 already closed the main secret-exposure path. Good first post-release hardening |
| R16 | minor | Cargo licence scan covered only locally cached crates | Add `cargo deny check licenses` to CI |
| R22 | polish | Check that "Orbit" doesn't clash with a well-known dev tool before you announce | Quick search |
| T1 | minor | e2e logs React errors but doesn't fail on them; E1 slipped through the main suite this way | Make the harness fail on "same key" and similar page errors |
| T2 | minor | About 45 🟢 features are still unverified in the real app (Settings round-trips, Compact / New session, archive restore, cleanup, pack install, Codex steer, owned routines, scheduler tick, New ticket, Address comments) | Writing those e2e steps was dropped tonight to conserve usage; FEATURES.md lists each |
| — | polish | Routines shortcut failed once in a full run and never again in four runs (a diagnostic line stays in the step) | Probably timing; watch for it |

## Hide / label for 0.1
- Local-model **agents** are labelled "(experimental)" in New workspace.
- The mobile companion is labelled "not yet released" in Settings > Mobile.
- Linked PRs across repos (editable attachments shipped together) are still 🟡. Don't advertise them.

## Announcement notes (facts you can use)
- A Windows desktop app that runs a fleet of Claude Code and Codex agents in parallel git worktrees, with an attention inbox, Ship → PR → CI → merge, GitHub Issues, skill packs, AI teammates with a "Chief" planner, scheduled routines, and a Simplify pass.
- It is tested end to end against the real app: 23 scenarios with real agents, plus 7 against real GitHub PRs, CI and issues.
- Rust core (Tauri 2) with 175 unit tests; React 19 UI. MIT licensed. 5.9 MB installer.
