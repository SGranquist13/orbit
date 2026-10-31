# Behaviour

## 1. Transcript

### 1.1 Folding
`transcript::fold(&[StoredEvent]) -> Vec<Block>` is a line-for-line port of `fold` in `src/lib/transcript.ts` (same block kinds, same rules: consecutive tool calls form one group; results attach by id; `usage` feeds the next `turnEnd`; `exited` with non-zero code becomes an error). Port `toolSummary`, `formatTokens`, `formatCost`, `formatDuration`, `turnUsageTokens` too. Tests: for each `src-tauri/tests/fixtures/*.jsonl` that parses into events, the Rust fold matches a JSON golden produced from the TS `fold` (a one-off `bun` script in `crates/orbit-tui/tests/gen-goldens.ts` writes the goldens; checked in).

### 1.2 Live state
- Persisted events (`seq` non-null) append to the workspace's event list and refold incrementally (refold from the last block that can still change: the last `tools` group or later).
- `textDelta` events accumulate into `live_text` for that workspace; cleared on the next persisted `message`, `toolCall`, or `turnCompleted`.
- `toolDraft` is ignored in v1.
- Gap detection: if a pushed event's `seq` > last known seq + 1, fetch `events { sinceSeq: lastSeq }` before applying.
- When a workspace is opened: `events {}` once (full history), then pushes. Keep at most the 4 most recently opened workspaces' events in memory.

### 1.3 Edit counts
Shown on edit tool rows when computable from the call input: `Edit`: `+lines(new_string) −lines(old_string)`; `MultiEdit`: sum over `edits`; `Write`: `+lines(content)`; Codex `Edit` and others: no counts. (Approximate by design: it's what the agent asked for.)

### 1.4 Folding the tools group
The latest tools group stays expanded while its turn runs and until the next user message. Older groups render folded. User expand/fold choices are remembered per block key for the session.

### 1.5 Sending
`send` RPC. While it's in flight the input clears and the text is shown as a user block with `mute` text; the persisted `userMessage` replaces it. An RPC error restores the input and shows the error in the footer.

## 2. Attention, grouping, inbox

### 2.1 Reason
`attention::reason(ws, summary, pr, stale_limits) -> Option<Reason>` is a port of `attentionReason` in `src/lib/attention.ts` (including `asksQuestion`, `isStale`, `isSnoozed`). The `review` reason is **not** ported in v1 (needs the review findings table; pass `None`). Stale limits come from `hello.settings`. Tests: a table test per reason and priority order (there are no TS tests to port).

### 2.2 Groups
- **needs you:** `reason.is_some()`.
- **running:** `status == "running"`.
- **done:** everything else (idle, done, error that was seen, merged).
Order inside each group: `summary.lastActivityTs` descending. Snoozed workspaces are excluded from "needs you" and shown in "done".
PR status: fetched with `prStatus` for workspaces with `ahead > 0` or an issue number, at most 4 concurrent, refreshed every 60 s while the Inbox is open and every 5 min otherwise; failures are silent (no PR).

### 2.3 Reason detail text
| Reason | Detail |
|---|---|
| error | first line of `summary.lastTurnError` |
| question | last line of `summary.lastAssistantText` that ends in `?`, else its last line |
| checksFailed | `ws.checksCommand` |
| needsSync | `conflicts in <n> files` |
| checks | `<failed> of <total> checks failing` |
| changes | `changes requested on #<number>` |
| done | first line of `summary.lastAssistantText` |
| stale | `open <d> days` or `<behind> behind` |
| running (no reason) | the last tool summary or `thinking` |

### 2.4 Inbox actions
Exactly as keys.md. Opening a workspace calls `markSeen`. `d` calls `dismiss`. Rule suggestions use the ported `ruleSuggestions` (`hasPr` from PR status; `changedFiles`/`changedLines` unknown in v1 → 0, so "Ship it" only appears when the PR exists or the user ships manually); kinds: `text` → `send`, `skill` → `runSkill`, `ship` → `ship {skipChecks: anyway}`, `sync`/`simplify`/`handoff` → not offered in v1 (filtered out).

### 2.5 Notifications
When a workspace that is not the one on screen enters "needs you": ring the bell (`\x07`) and, if the terminal supports it (`TERM_PROGRAM` iTerm/WezTerm/kitty, or `WT_SESSION`), send OSC 9 `Orbit: <name> — <reason label>`. At most one per workspace per 30 s. Off with `--quiet`.

## 3. New workspace
Dialog fields: Repo (from `snapshot.repos`, default = the current workspace's repo, else the most recently used), Task (required, multi-line), Agent (`claude`/`codex`, default = current workspace's agent), Model (from `hello.agents`, default first), Profile (from `listProfiles`, default none = builder). Name = first 6 words of the task, slugified by the app. Enter on the last field or Ctrl+Enter anywhere: `createWorkspace { …, task }` → open it in Chat.

## 4. Review

### 4.1 Scopes
| Scope | Old side | New side | Available when |
|---|---|---|---|
| `base` | merge base with `origin/<base>` (`git::changes_merge_base`) | worktree (includes uncommitted and untracked) | always |
| `turn` | the `commitSha` of the **second-to-last** `turnCompleted` that has one (if only one exists: its parent `<sha>^`) | worktree | `turnAvailable` (save points on and ≥ 1 turn commit) |
| `commit` | `<sha>^` | `<sha>` | a commit picked from the list |
Server computes `files` for the scope with `git diff --numstat <old> [<new>]` (+ untracked for worktree). The client fetches both sides of a file with `fileAt` when the file is opened and diffs locally with `similar` (Myers, line mode, 3 lines context, hunks merged when ≤ 6 apart).

### 4.2 Comments
- Stored in memory per workspace id: `Vec<ReviewComment>` with `side` `old` for removed lines, `new` otherwise; `excerpt` = the commented source lines verbatim.
- Enter → confirm "Send 3 comments to <name>?" → `sendReview` → on success clear drafts and show "Sent to <name>" in the footer; then return to Chat.
- Not allowed in `commit` scope (read-only, footer says so), matching the desktop.

### 4.3 Large and binary files
`binary` → one `mute` row "Binary file". `tooLarge` → "File too large to show (> 2 MB)". Diffs over 5,000 lines show the first 5,000 and a `mute` row "… <n> more lines".

## 5. Ship

Ctrl+S (or `s` in Inbox):
1. Overlay opens with steps: `Checks` · `Squash save points` · `Ship (agent)` · `Pull request`. The first is marked running.
2. `ship { skipChecks: false }`. Result:
   - `ok: false` → Checks `✗` with `checks.command` and the last 12 lines of output in `dim`; actions `a ship anyway`, `f` (send `fixChecksPrompt`), Esc.
   - `ok: true` → Checks `✓` (or `skipped`), Squash `✓ <n> commits` (or `nothing to squash`), Ship running: the agent is now running `shipkit:ship`; the overlay shows the agent's latest tool summary live.
3. When that turn completes: `prStatus` every 5 s until a PR exists (max 2 min), then every 15 s while the overlay is open. Shows `#<n> <title>`, state, review decision, and checks (`passed`/`failed`/`pending` counts from `PrStatus.checks`; per-check names are **not** available in v1 — `PrStatus` only has counts).
4. Merge (`m`) when `state == OPEN`, `mergeable == MERGEABLE`, no failed checks: confirm → `merge` → "Merged · archived" or "Merged" per `MergeOutcome.archived`.
The overlay is a view of state kept per workspace; closing it doesn't stop anything, and reopening shows the current step.

## 6. Connection and errors
- Startup: `read_local_config` → connect → `hello` + `snapshot` in parallel → open the workspace named on the command line (`orbit <name-or-id-prefix>`), else the start screen (§7).
- App not running: print to stderr `Orbit isn't running. Start the desktop app, then run orbit again.` and exit 1 (before entering the alternate screen).
- Disconnect while running: header shows `● reconnecting…` in `warn`; input stays editable but Enter shows "Not connected" in the footer; on reconnect refetch as protocol.md §5 says.
- RPC errors: footer transient error. Never crash on a bad payload: unknown event types are ignored (serde `#[serde(other)]` variant), unknown fields are ignored.
- Logging: `ORBIT_TUI_LOG=<file>` writes `tracing` logs there; nothing is ever printed to the terminal while the UI is up.

## 7. Command line
```
orbit                      start screen (§ below)
orbit <workspace>          open a workspace (exact name, else unique prefix of name or id)
orbit ls [--json]          list workspaces: group, status, name, repo, reason; plain text, no TUI
orbit send <ws> <text>     send a message and exit
orbit --version | --help
flags: --theme, --color, --ascii, --no-motion, --quiet, --rail left|right|off, --paint-bg
```
**Start screen:** if any workspace needs you → Inbox; else Chat on the most recently active workspace; else the New workspace dialog.
`orbit ls` output columns: `<dot> <name>  <status>  <repo>  <reason label>`; `--json` prints `{ workspaces: [{ id, name, repo, status, group, reason }] }`.

## Open
- **B1.** Start screen rule above (Inbox when something needs you). OK?
- **B2.** Skill list: all enabled packs, shipkit first (as specified). OK?
- **B3. Binary name (blocks T0.3).** The desktop app's Cargo package and binary are already called `orbit` (`src-tauri/Cargo.toml`), so a TUI binary named `orbit` collides in the shared Cargo workspace (same `target/` output) and would sit next to the app's own exe. Options: (a) `orb` (recommended: short, no clash); (b) rename the app's binary (touches the installer and auto-start); (c) keep the TUI in a separate Cargo workspace. This spec writes `orbit` throughout; read it as the chosen name.
