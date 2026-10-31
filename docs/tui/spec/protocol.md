# Protocol

The TUI talks to the running desktop app over the existing bridge (`src-tauri/src/remote/`), through a new **local mode**. The phone path is unchanged. All JSON is camelCase.

## 1. Local listener

- Started in `run()` setup **regardless of** `remoteEnabled`. Binds `127.0.0.1:0` (OS-assigned port). Same WebSocket path `/v1`, same `Hub`, same `Backend`.
- On start, writes `~/.orbit/local.json` (respecting `ORBIT_HOME`):
  ```json
  { "port": 51234, "token": "<b64url of 32 random bytes>", "pid": 12345, "version": "0.2.0", "protocol": 2 }
  ```
  Written atomically (temp file + rename). On Unix mode `0600`. On Windows the file inherits the user-profile ACL (no extra work). A new token on every app launch.
- On app exit the file is deleted (best effort). A stale file is detected by the client when the connection is refused.
- `ORBIT_LOCAL_TOKEN` + `ORBIT_LOCAL_PORT` environment variables override the file (used by the in-app pane, T5).

## 2. Handshake (local)

Server sends the same first frame as today, with the protocol version bumped to **2**:
```json
{ "t": "hello", "v": 2, "pk": "…", "challenge": "…", "name": "DESKTOP-1" }
```
On the **local listener only**, the client may answer with:
```json
{ "t": "local", "token": "<token>", "client": "orbit-tui/0.1.0" }
```
- Token compared in constant time (`subtle` or a manual xor-fold). Wrong token → `{ "t":"error","code":"bad_token","message":"…" }` and close.
- `t: "local"` on the phone listener → `protocol` error. `pair`/`auth` on the local listener still work (harmless; simplifies tests).
- Success → `{ "t": "ready", "orbit": { "name": "…", "version": "0.2.0" }, "protocol": 2 }` **in plaintext**.
- After `ready`, every frame on a local connection is **plaintext JSON** (no `box` wrapping). Requests: `{ "t":"rpc","id":<number>,"method":"…","params":{…} }`. Replies: `{ "t":"rpc-result","id":…,"ok":true,"result":…}` or `{"ok":false,"error":"<message>"}`. Pushes: `{ "t":"event", … }`, `{ "t":"workspace", … }`, and the new pushes in §4.
- Handshake timeout, ping interval and the "text frames only" rule are unchanged.

Implementation note: `handle_connection` gets a `Transport` enum (`Sealed { peer }` / `Plain`) so the send/receive paths stay one loop.

## 3. RPC methods

`Backend::rpc` becomes async: `fn rpc(&self, method: &str, params: Value) -> BoxFuture<'static, Result<Value, String>>` (or `async_trait`). Sync methods keep running in `spawn_blocking` inside the backend. The phone's methods are unchanged in shape. Errors are human-readable strings (they are shown to the user as-is).

Types referenced below are the existing serde types: `Workspace`, `Summary`, `Repo` (`db.rs`), `StoredEvent` (`db.rs`, includes `commitSha`), `Skill` (`skills.rs`), `Profile` (`skills::list_profiles`), `PrStatus` (`gh.rs`), `PrepareShip` (`trunk.rs`), `MergeOutcome` (`trunk.rs`), `FileChange` (`git.rs`). `orbit-proto` re-declares them as plain serde structs (it cannot depend on `src-tauri`); a round-trip test in `src-tauri` (T0.2) serialises the app's types and deserialises them with `orbit-proto`'s to keep them in sync.

### Existing (unchanged)

| Method | Params | Result |
|---|---|---|
| `snapshot` | `{}` | `{ repos: Repo[], workspaces: Workspace[], summaries: Summary[] }` |
| `events` | `{ workspaceId, sinceSeq? }` | `StoredEvent[]` (seq ascending) |
| `send` | `{ workspaceId, text }` | `null` |
| `interrupt` | `{ workspaceId }` | `null` |
| `markSeen` | `{ workspaceId }` | `number` (new seenSeq) |

### New

| Method | Params | Result | Wraps |
|---|---|---|---|
| `hello` | `{}` | `{ settings: { staleDays, staleBehind, saveCommits, deleteBranchOnMerge }, agents: { claude: {models:string[]}, codex: {models:string[]} } }` | `state.settings()`, `agent::models` |
| `createWorkspace` | `{ repoId, name, agent: "claude"\|"codex", model?, profile?, task? }` | `Workspace` | `create_workspace_inner` (other `NewWorkspaceArgs` fields default), then `send(task)` when `task` is non-empty |
| `archive` | `{ workspaceId, force?: bool }` | `null` | `archive_inner(id, remove_worktree = true, force)`; its "uncommitted changes" error is returned as-is so the TUI can offer force |
| `dismiss` | `{ workspaceId }` | `number` | `db.dismiss` |
| `listSkills` | `{ workspaceId? }` | `Skill[]` (enabled packs; shipkit first, then by pack, then name) | `list_skills` |
| `runSkill` | `{ workspaceId, skillId, args }` | `null` | `run_skill_with(id, skill, args, args)` |
| `listProfiles` | `{}` | `Profile[]` | `skills::list_profiles` |
| `switchProfile` | `{ workspaceId, profile: string\|null }` | `Workspace` | `switch_profile` |
| `compact` / `newSession` | `{ workspaceId }` | `null` | `compact_session` / `new_session` |
| `listFiles` | `{ workspaceId }` | `string[]` (forward-slash, relative, capped at 20,000) | `code::fs::code_list_files(ws.path)` |
| `prStatus` | `{ workspaceId }` | `PrStatus \| null` | the `pr_status` command body |
| `prepareShip` | `{ workspaceId, skipChecks: bool }` | `PrepareShip` | `prepare_ship_inner` |
| `ship` | `{ workspaceId, skipChecks: bool }` | `PrepareShip` | `prepare_ship_inner`; when `ok`, also `run_skill_with(id,"shipkit:ship",notes)` (mirrors `stores/app.ts` `ship`) |
| `merge` | `{ workspaceId, number }` | `MergeOutcome` | the `merge_pr` command body |
| `review` | `{ workspaceId, scope }` | `Review` (below) | `git::changes`, `pr_review::local_review` |
| `fileAt` | `{ workspaceId, path, ref }` | `{ text: string \| null, binary: bool, tooLarge: bool }` | `ref: "worktree"` → `code_read_file`; `ref: <sha>` → **new** `code::fs::file_at_sha(root, rel, sha)`: validates `^[0-9a-f]{7,40}$`, goes through `resolve_inside`, runs `git show <sha>:<rel>`; missing → `text: null`. Binary = contains NUL in the first 8 KB; > 2 MB → `tooLarge`, no text |
| `sendReview` | `{ workspaceId, comments: ReviewComment[] }` | `null` | builds the message with the same format as `reviewMessage` in `src/stores/review.ts` (ported to Rust in `review.rs`, unit-tested against the TS output), then `send` |

`scope` is `{ "kind": "base" }`, `{ "kind": "turn" }` or `{ "kind": "commit", "sha": "…" }` ([behaviour.md §4](behaviour.md)).

```ts
type Review = {
  scope: Scope;
  oldRef: string;          // sha for the old side
  newRef: string;          // sha, or "worktree"
  files: FileChange[];     // path, additions, deletions, untracked
  commits: { sha: string; subject: string; ts: number }[]; // base..HEAD, newest first, max 50
  turnAvailable: boolean;  // false when save points are off or there is < 1 turn commit
}
type ReviewComment = { path: string; startLine: number; endLine: number; side: "old" | "new"; text: string; excerpt: string };
```

Any method that takes a `workspaceId` returns the error `unknown workspace` for a missing id. Methods that change git refuse with the app's existing messages while the workspace is running (e.g. "Wait for the current turn to finish before shipping").

## 4. Pushes (server → client)

| Frame | When | Exists? |
|---|---|---|
| `{ t:"event", workspaceId, seq, ts, event: AgentEvent }` | every agent event (`seq` null for non-persistent ones: `textDelta`, `toolDraft`, `rateLimits`) | yes |
| `{ t:"workspace", workspace: Workspace }` | any workspace row update | yes |
| `{ t:"workspace-removed", workspaceId }` | archived or deleted | **new**: published where the desktop gets `workspace-archived` |
| `{ t:"summary", summary: Summary }` | after an event is persisted | **new**: lets the TUI keep attention current without refetching `snapshot` |

`Hub::has_listeners()` already gates publishing, so these cost nothing when no client is connected.

## 5. Client library (`orbit-proto::client`)

```rust
pub struct Client { /* … */ }
impl Client {
    pub async fn connect_local(cfg: LocalConfig) -> Result<(Client, mpsc::Receiver<Push>), ConnectError>;
    pub async fn rpc<P: Serialize, R: DeserializeOwned>(&self, method: &str, params: P) -> Result<R, RpcError>;
}
pub enum Push { Event(EventPush), Workspace(Workspace), WorkspaceRemoved(String), Summary(Summary), Disconnected, Reconnected }
pub fn read_local_config() -> Result<LocalConfig, ConfigError>; // env vars first, then ~/.orbit/local.json
```

- Request ids are a per-connection `u64` counter. A pending request fails with `RpcError::Disconnected` if the socket drops.
- Reconnect: on drop, `Push::Disconnected`, then retry with backoff 250 ms → 500 → 1 s → 2 s → 4 s (cap), re-reading `local.json` each time (the app may have restarted with a new port and token). On success, `Push::Reconnected`; the TUI then refetches `snapshot` and the open workspace's `events` since its last seq.
- `ConnectError::NotRunning` when the file is missing or the connection is refused; `ConnectError::BadToken`; `ConnectError::Version { server, client }` when the server's `v` is below 2.

## 6. Protocol docs

`ide_mobile/docs/protocol.md` is the published contract. T0.2 adds a "Local clients (protocol 2)" section mirroring §1–§4 and notes that v2 is additive for phones (they ignore unknown pushes). Then `npm run interop` in `ide_mobile` must still pass.
