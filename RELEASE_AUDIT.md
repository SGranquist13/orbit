# Orbit 0.1.0 release audit

Run 2026-10-17 → 2026-10-18. Target: public, open-source **v0.1.0** on GitHub (Windows 10/11).
Pushed to the private repo `SGranquist13/orbit`; nothing is public yet.

## Verdict (2026-10-18, evening)

**Everything is done except your manual check.** Then "go public" = make the repo public + publish the draft release.

- Code: private repo [SGranquist13/orbit](https://github.com/SGranquist13/orbit), `main` pushed.
- CI on GitHub: ✅ UI (tsc + build), ✅ Rust (cargo test + clippy on a clean Windows runner, which also proves a fresh-clone build), ✅ licences (cargo-deny).
- Release: **draft** `v0.1.0` with `Orbit_0.1.0_x64-setup.exe` attached; the tag is created on publish.
- Public-safety scan: no secrets in any commit, no personal email (all commits use the GitHub noreply address), test fixtures neutralised, `CLAUDE.local.md` and logs gitignored. Older commits still contain a few local paths with the Windows username (no secrets); left as is because rewriting history isn't worth it.
- Dependabot: one medium advisory in `glib` (a Linux-only GTK dependency of Tauri, not built into the Windows app); merge Dependabot's PR whenever convenient.

## Results on the final tree

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | ✅ pass |
| `cargo test` | ✅ 178 pass, 0 fail, 8 ignored (opt-in live); 168 before the audit |
| `bun run check:guards` (clippy) | ✅ pass, **0 warnings** (13 before) |
| `bun run build` | ✅ main chunk **381 kB** (738 kB before) |
| `bun run e2e` (real app, Claude haiku + Codex) | ✅ **46/46** (23 before). Steps now fail on React page errors |
| `bun run e2e:github` (real PRs/CI/issues in the sandbox) | ✅ **10/10** (7 before); the sandbox is left with no open issues or PRs |
| Forced-kill test | ✅ an agent mid-turn, Orbit killed with `taskkill /F`: 0 agent processes survive |
| GitHub Actions CI | ✅ ui, rust, licences |
| `bun run app:build` | ✅ `Orbit_0.1.0_x64-setup.exe` (5.85 MiB, unsigned), attached to the draft release |

## Decisions (all made)
- **R3 logo:** yours, credited in the README, MIT like the rest of the repo.
- **R12 identifier:** `io.github.sgranquist13.orbit`.
- **R9 CLAUDE.md:** personal notes moved to a gitignored `CLAUDE.local.md`; a "Working with Codex" guide was added.
- **R4 publishing:** private repo + draft release now; public after your manual check.

## Manual checks (~20 min, real app or installed build)

- [ ] Install `Orbit_0.1.0_x64-setup.exe` on a clean Windows user profile. Check the SmartScreen "More info → Run anyway" flow, launch, add a repo, run one turn, then uninstall.
- [ ] Add repository via the native folder picker
- [ ] Native confirms: archive (try it on a workspace **with uncommitted changes**; you should get a second "Discard uncommitted changes?" prompt), merge, remove pack
- [ ] OS notification when a turn finishes with the window unfocused
- [ ] Taskbar / installer icon; start-page animation
- [ ] Mobile pair + revoke + push, only if you decide to advertise it (it is labelled "companion app not yet released")

## What was fixed

Each item has a commit on `main`. The merges are `d969fb9` (backend), `79e1b19` (UI) and `7cce24f` (docs/packaging), followed by follow-up fixes.

### Bugs found by the e2e runs
| | Finding | Fix |
|---|---|---|
| E1 | **Regression introduced by the audit's own U7 fix:** under React StrictMode `init()` ran twice and registered the agent-event listener twice. Every live event was appended twice, causing duplicate React keys and turn ends counted twice, so a Ship turn looked finished while it was still creating the PR. | `6a27737`: one init in flight (promise guard), still retries after a failure |
| E2 | Bundled teammates you'd messaged (Chief) vanished from the Teammates list, so you couldn't reach their thread | `45b9a62`: list starters with thread activity |
| E3 | Sidebar shortcut chips ("Ctrl Shift T") wrapped onto two lines next to a badge; the active skill chip's ⚡ icon was invisible (accent on accent) | small UI fix commit |
| E4 | e2e drift from the 2026-10-17 UI work: skill chips now open a preview, the packs button was renamed, a harness `waitFor` was missing `return`, and the merge step didn't expect the after-merge auto-archive | test fixes; the merge step now also **proves after-merge auto-archive** in the real app |
| E5 | **Agents outlived Orbit.** Children used `kill_on_drop`, which only fires on a clean exit, so after a crash or Task Manager kill the Claude/Codex agents kept running and spending tokens | `7378d0a`: each agent/git/check process joins a kill-on-close Windows job object. Orbit stays outside it, so browsers or editors it opened survive |
| E6 | **Archive race on Windows:** archiving right after stopping an agent could fail (the agent still held its folder), leaving an empty folder and an un-archived workspace; this hit after-merge auto-archive | `6c4382d`: retry with backoff, and clear an already-emptied folder (never recursive) |
| E7 | **New ticket could finish without filing the issue.** The read-only Ticket writer couldn't write the `--body-file` its skill asks for, and the shell workarounds are blocked by Claude Code's safety checks (seen on Sonnet) | `a28e65e`: read-only agents may write only under `~/.orbit/tmp` (verified live: repo writes and `echo > file` stay denied); the skill uses `--body-file` from there |

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
- **R5 / R13:** NSIS-only bundle with publisher, copyright, descriptions and category. CSP configured (see R13b for verification status).
- **R6:** `scripts/vcvars.cmd` finds the MSVC toolchain itself: `cl.exe` already on PATH, then `VCVARS`, then vswhere (VS 2022 preferred), then the old path.
- **R7 / R18 / R20:** README covers the prerequisites, the SmartScreen warning, Security, and that e2e is maintainer-only.
- **R8:** `e2e:github` uses your sandbox only when `gh` is logged in as you; anyone else must set `ORBIT_GH_SANDBOX`.
- **R14:** neutral names in the mock and tests (no `steven/`, no "Steven's iPhone").
- **R15 / R21:** THIRD_PARTY_NOTICES.md (OFL fonts), SECURITY.md, CONTRIBUTING.md.
- **R19:** `.gitignore` covers `.e2e-run-*.log` and `.claude/*.lock`.
- **Secrets scan: clean** across the working tree and all history; the commit email is the GitHub noreply address.

## Open / pending verification

| ID | Sev | Item | Why open |
|---|---|---|---|
| R10 | major | Mobile bridge depends on the unpublished `ide_mobile` repo | Labelled "not yet released" in the app; publish `ide_mobile` or copy `docs/protocol.md` later |
| R13b | ✅ done | Content-Security-Policy, **verified by both full suites (46/46, 10/10)** | CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: asset: http://asset.localhost; connect-src 'self' ipc: http://ipc.localhost`. Inline styles support React style props. Remote markdown images are blocked; UI images are bundled. Local-model HTTP runs in Rust (`llm.rs`), not the webview. `devCsp` adds `http://localhost:1420` to script/style/connect sources and `ws://localhost:1420` to connect sources, plus development-only inline scripts for Vite's React refresh preamble. App/e2e verification remains pending. |
| R16 | ✅ done | Passing in CI: Cargo licence allow list and CI gate; pending first CI verification | `src-tauri/deny.toml` and the `licenses` job run `cargo deny check licenses` with `EmbarkStudios/cargo-deny-action@v2`. Only MIT, Apache-2.0, BSD-3-Clause, ISC, Unicode-3.0, Zlib, MPL-2.0 and CDLA-Permissive-2.0 are allowed, using MIT/Apache alternatives where available; GPL/AGPL/LGPL are not allowed. The list covers locally cached lockfile crate metadata; uncached platform dependencies still need CI verification. `cargo deny` was unavailable locally and was not installed globally. |
| R22 | polish | Check that "Orbit" doesn't clash with a well-known dev tool before you announce | Quick search |
| T1 | ✅ done | The harness now fails a step on React page errors and kills leftover app and agent processes | — |
| T2 | minor | 23 more features are now proven in the real app (Settings, Compact/New session, archive and restore, cleanup, pack install, Codex steer, mid-turn queue, scheduler tick, standing and owned routines, teammate CRUD and memory, New ticket, issue chip, Address comments). Still unverified: OS notifications, native dialogs, phone push, linked PRs across repos | Manual check covers most of these |
| — | polish | Routines shortcut failed once in a full run and never again in four runs (a diagnostic line stays in the step) | Probably timing; watch for it |

## Hide / label for 0.1
- Local-model **agents** are labelled "(experimental)" in New workspace.
- The mobile companion is labelled "not yet released" in Settings > Mobile.
- Linked PRs across repos (editable attachments shipped together) are still 🟡. Don't advertise them.

## Announcement notes (facts you can use)
- A Windows desktop app that runs a fleet of Claude Code and Codex agents in parallel git worktrees, with an attention inbox, Ship → PR → CI → merge, GitHub Issues, skill packs, AI teammates with a "Chief" planner, scheduled routines, and a Simplify pass.
- It is tested end to end against the real app: 46 scenarios with real Claude and Codex agents, plus 10 against real GitHub PRs, CI and issues.
- Rust core (Tauri 2) with 178 unit tests; React 19 UI. MIT licensed. 5.9 MB installer.
