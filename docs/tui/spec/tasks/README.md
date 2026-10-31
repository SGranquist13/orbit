# Tasks

One brief per task. Each is sized for one agent session and lands as one PR into the `tui` integration branch (from `next`). Do them in order within a milestone; a task may start once everything in **Depends** has merged.

| Task | Milestone | Where | Depends | Agent fit |
|---|---|---|---|---|
| [T0.1](T0.1-proto-crate.md) Cargo workspace + `orbit-proto` types | T0 | Linux | — | Sonnet / Codex |
| [T0.2](T0.2-local-listener.md) Local listener, async backend, pushes | T0 | **[app]** | T0.1 | Sonnet + maintainer verify |
| [T0.3](T0.3-client-and-ls.md) Client, `orbit ls` / `orbit send` | T0 | Linux | T0.1 (T0.2 for live check) | Sonnet / Codex |
| [T1.1](T1.1-tui-skeleton.md) App loop, theme, glyphs, snapshot harness | T1 | Linux | T0.3 | Sonnet |
| [T1.2](T1.2-transcript.md) Transcript fold + markdown + block rendering | T1 | Linux | T1.1 | Sonnet / Codex |
| [T1.3](T1.3-chat.md) Chat screen: header, input, footer, send/stop | T1 | Linux | T1.2 | Sonnet |
| [T2.1](T2.1-attention-rail.md) Attention port, rail, switcher | T2 | Linux | T1.3 | Sonnet / Codex |
| [T2.2](T2.2-inbox.md) Inbox screen + actions + notifications | T2 | Linux | T2.1, T3.0 | Sonnet |
| [T2.3](T2.3-new-workspace.md) New workspace dialog, start screen | T2 | Linux | T2.1, T3.0 | Sonnet |
| [T3.0](T3.0-app-rpcs.md) App RPCs: workspaces, skills, profiles, files, ship, PR | T2/T3 | **[app]** | T0.2 | Sonnet + maintainer verify |
| [T3.1](T3.1-skills-files-palette.md) Skills popup, `@` files, palette, profile cycle | T3 | Linux | T1.3, T3.0 | Sonnet |
| [T3.2](T3.2-ship.md) Ship overlay | T3 | Linux | T3.1 | Sonnet |
| [T4.0](T4.0-review-rpcs.md) App RPCs: review, fileAt, sendReview | T4 | **[app]** | T0.2 | Sonnet / Codex + maintainer verify |
| [T4.1](T4.1-review-screen.md) Review screen | T4 | Linux | T4.0, T2.1 | Sonnet |
| [T5.1](T5.1-in-app-pane.md) In-app Terminal UI pane + installer | T5 | **[app]** | T3.2 | Claude (UI taste) |
| [T9.1](T9.1-e2e.md) e2e steps per milestone | each | **[app]** | per milestone | Claude |

**Every task's PR description** copies its "Done when" list and ticks it. The orchestrator reviews against [../README.md](../README.md) rules, the brief, and the spec files it cites.
