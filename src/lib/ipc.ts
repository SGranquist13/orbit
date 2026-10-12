// Typed wrappers over the Rust commands and events in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AgentKind = "claude" | "codex";
export type WorkspaceStatus = "idle" | "running" | "done" | "error";

export interface Repo {
  id: string;
  name: string;
  path: string;
  baseBranch: string;
}

export interface Workspace {
  id: string;
  repoId: string;
  name: string;
  branch: string;
  path: string;
  agent: AgentKind;
  model: string | null;
  status: WorkspaceStatus;
  agentSessionId: string | null;
  issueNumber: number | null;
  createdAt: number;
  updatedAt: number;
  seenSeq: number;
  dismissedSeq: number;
  /** Profile id (`<plugin>:<name>`); null = Builder. */
  profile: string | null;
  /** Hidden from the inbox until this time (ms epoch); 0 = not snoozed. */
  snoozedUntil: number;
  /** The last Ship gate / check run failed (cleared by a pass or a new message). */
  checksFailed: boolean;
  checksCommand: string | null;
  checksOutput: string | null;
  /** Files that conflicted when Orbit last tried to rebase onto base. */
  syncConflicts: string[];
  /** Commits on base this branch lacks / has on top. */
  behind: number;
  ahead: number;
  /** The routine that started this workspace, if any. */
  routineId: string | null;
  /** Slug of the teammate that created this workspace, if any. */
  teammate: string | null;
}

/** Result of a check run (src-tauri/src/checks.rs). */
export interface CheckResult {
  ok: boolean;
  /** `installFailed` = the dependency install broke (not a code failure); `timedOut` = killed at the limit. */
  kind: "pass" | "fail" | "timedOut" | "installFailed";
  command: string;
  outputTail: string;
  durationMs: number;
}

export interface CheckCommandInfo {
  detected: string | null;
  override: string | null;
}

/** Simplify (src-tauri/src/simplify.rs). */
export type SimplifySignal =
  | "nesting"
  | "longFunction"
  | "nestedTernary"
  | "booleanFlags"
  | "duplication"
  | "deadCode"
  | "needlessWrapper"
  | "naming"
  | "other";
export type SimplifyRisk = "low" | "medium" | "high";

export interface SimplifyCandidate {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  signal: SimplifySignal;
  title: string;
  rationale: string;
  proposedChange: string;
  risk: SimplifyRisk;
}

export type SimplifyPhase = "idle" | "finding" | "ready" | "applying" | "done";
export type SimplifyRowStatus = "queued" | "editing" | "checking" | "applied" | "skipped" | "noop";

export interface SimplifyRow {
  candidateId: string;
  status: SimplifyRowStatus;
  /** Why it was skipped, or the check output tail. */
  detail: string | null;
  /** Short hash of the `refactor:` commit when applied. */
  commit: string | null;
  /** Deleted minus added lines (negative when the code grew). */
  linesRemoved: number;
  /** Applied with no check command to vouch for it. */
  unchecked: boolean;
}

/** In-memory per workspace; lost when Orbit restarts. */
export interface SimplifyState {
  workspaceId: string;
  phase: SimplifyPhase;
  candidates: SimplifyCandidate[];
  rows: SimplifyRow[];
  error: string | null;
  scopeFiles: number;
  scopeNote: string | null;
  checkCommand: string | null;
  cancelled: boolean;
}

export interface PrepareShip {
  ok: boolean;
  checks: CheckResult | null;
  squashed: number;
  /** A PR title and body Orbit drafted with a local model; pass it to `shipkit:ship` as its notes. */
  notes: string | null;
}

export interface Overlap {
  a: string;
  b: string;
  files: string[];
}

export type AgentEvent =
  | { type: "sessionStarted"; sessionId: string; model: string | null }
  | { type: "userMessage"; text: string; skill?: string }
  | { type: "turnStarted" }
  | { type: "textDelta"; text: string }
  | { type: "message"; text: string }
  | { type: "toolCall"; id: string; name: string; input: unknown }
  | { type: "toolResult"; id: string; output: string; isError: boolean }
  | { type: "turnCompleted"; durationMs: number | null; costUsd: number | null; isError: boolean; error: string | null; interrupted?: boolean }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      /** Current context size, not the turn total. */
      contextTokens: number | null;
      contextWindow: number | null;
      costUsd: number | null;
      model: string | null;
    }
  | { type: "sessionReset" }
  | { type: "error"; message: string }
  | { type: "exited"; code: number | null; stderr: string };

export interface StoredEvent {
  seq: number;
  ts: number;
  event: AgentEvent;
}

export interface AgentEventPayload {
  workspaceId: string;
  seq: number | null;
  ts: number;
  event: AgentEvent;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  untracked: boolean;
}

export interface Pack {
  name: string;
  plugin: string;
  description: string | null;
  path: string;
  source: string | null;
  builtin: boolean;
  enabled: boolean;
  skillCount: number;
  commandCount: number;
}

export interface Skill {
  id: string;
  pack: string;
  kind: "command" | "skill";
  name: string;
  description: string;
  argumentHint: string | null;
  path: string;
}

/** A workspace role ("coworker"): instructions, optional agent/model preference, read-only flag, pinned skills. */
export interface Profile {
  id: string;
  pack: string;
  name: string;
  description: string;
  model: string | null;
  agent: AgentKind | null;
  readonly: boolean;
  skills: string[];
  instructions: string;
  path: string;
}

export const DEFAULT_PROFILE = "shipkit:builder";

/** The workspace's active profile: its stored one, else (or if it vanished) Builder. */
export function activeProfile(profiles: Profile[], ws: Pick<Workspace, "profile">): Profile | undefined {
  return profiles.find((p) => p.id === ws.profile) ?? profiles.find((p) => p.id === DEFAULT_PROFILE);
}

export interface PrStatus {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  checks: { passed: number; failed: number; pending: number; failing: string[] };
}

/** An open GitHub issue (from `gh issue list`). `updatedAt` is an ISO timestamp. */
export interface Issue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  author: string;
  updatedAt: string;
  comments: number;
}

export interface StartIssueArgs {
  repoId: string;
  number: number;
  title: string;
  profile?: string | null;
  agent: AgentKind;
  model?: string | null;
}

/** Another project folder attached to a workspace; editable ones live in their own worktree. */
export interface Attachment {
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  editable: boolean;
  worktreePath: string | null;
  branch: string | null;
}

/** A project found by manifest scanning that uses ("dependent") or is used by ("dependency") the repo. */
export interface Related {
  path: string;
  name: string;
  relation: "dependent" | "dependency";
  evidence: string;
}

/** Per-workspace digest of the event log, used by the attention inbox. */
export interface Summary {
  workspaceId: string;
  lastSeq: number;
  lastActivityTs: number;
  lastTurnSeq: number;
  lastTurnError: string | null;
  lastTurnInterrupted: boolean;
  lastAssistantText: string | null;
  lastUserText: string | null;
  /** Name of the routine that started this workspace, if any. */
  routineName: string | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
}

/** Token/cost digest of one workspace: lifetime, since the last "New session", and live context. */
export interface WorkspaceUsage {
  workspaceId: string;
  total: UsageTotals;
  session: UsageTotals;
  contextTokens: number | null;
  contextWindow: number | null;
  model: string | null;
}

export interface UsageReport {
  totals: UsageTotals;
  byWorkspace: {
    workspaceId: string;
    name: string;
    agent: AgentKind;
    total: UsageTotals;
    contextTokens: number | null;
    contextWindow: number | null;
  }[];
  byAgent: { agent: AgentKind; total: UsageTotals }[];
  /** Last 14 local days, oldest first. */
  byDay: { day: string; tokens: number; costUsd: number }[];
}

export interface CreateWorkspaceArgs {
  repoId: string;
  name: string;
  agent: AgentKind;
  model?: string | null;
  prompt?: string | null;
  issueNumber?: number | null;
  profile?: string | null;
}

export interface Settings {
  branchPrefix: string;
  defaultAgent: AgentKind;
  defaultModelClaude: string;
  defaultModelCodex: string;
  notifications: boolean;
  notifyOnlyUnfocused: boolean;
  claudePermissionMode: "bypassPermissions" | "acceptEdits";
  codexSandbox: "danger-full-access" | "workspace-write";
  extraModelsClaude: string[];
  extraModelsCodex: string[];
  mergeMethod: "squash" | "merge" | "rebase";
  deleteBranchOnMerge: boolean;
  aiSuggestions: boolean;
  suggestionModel: "haiku" | "sonnet";
  // git handling
  saveCommits: boolean;
  squashWip: boolean;
  commitMessages: "prompt" | "model";
  checksMode: "off" | "warn" | "block";
  checkTimeoutMinutes: number;
  installBeforeChecks: boolean;
  syncMode: "off" | "suggest" | "auto";
  simplifyModel: "haiku" | "sonnet" | "opus";
  simplifyMaxCandidates: number;
  simplifyLowRiskButton: boolean;
  syncIntervalMinutes: number;
  staleDays: number;
  staleBehind: number;
  archiveOnMerge: boolean;
  deleteLocalBranch: boolean;
  localProvider: "ollama" | "openai";
  /** Empty = the provider's default URL. */
  localUrl: string;
  localApiKey: string;
  localTimeoutSecs: number;
  localDefaultModel: string;
  /** Per-task model: "default" | "off" | "local:<model>". */
  modelSuggestions: string;
  modelWorkspaceName: string;
  modelCommitMessage: string;
  modelRoutineSummary: string;
  modelPrDescription: string;
  modelTeammateReport: string;
  localAgents: boolean;
  remoteEnabled: boolean;
  remotePort: number;
  remotePush: boolean;
  /** Max routine runs going at once (1-8). */
  routineConcurrency: number;
}

/** `llm.rs`: local model servers for utility tasks. */
export interface LocalModel {
  name: string;
  sizeBytes: number;
  family: string;
  parameterSize: string;
  quantization: string;
}

export interface LocalStatus {
  ollama: { running: boolean; version: string | null; url: string; models: LocalModel[] };
  openaiCompat: { reachable: boolean; url: string; models: string[] };
  /** Last failure per backend (`claude`, `ollama`, `openaiCompat`), cleared on its next success. */
  lastErrors: Record<string, string>;
}

export interface LocalTestResult {
  ok: boolean;
  latencyMs: number;
  output: string | null;
  error: string | null;
}

/** Mobile bridge (src-tauri/src/remote/). */
export interface RemoteStatus {
  running: boolean;
  port: number;
  addresses: string[];
  error?: string | null;
}

export interface RemotePairing {
  uri: string;
  /** QR code as an SVG string (black on white). */
  svg: string;
  expiresAt: number;
}

export interface RemoteDevice {
  id: string;
  name: string;
  publicKey: string;
  pushToken: string | null;
  pairedAt: number;
  lastSeenAt: number;
}

/** Output of `environment_info`: each tool is probed independently, so any may be missing. */
export interface EnvironmentInfo {
  claude: { path: string | null; version: string | null; ok: boolean; error?: string | null };
  codex: { path: string | null; version: string | null; loggedIn: boolean; error?: string | null };
  gh: { path: string | null; version: string | null; user: string | null; scopes: string[] };
  git: { path: string | null; version: string | null };
  orbitHome: string;
  dbSizeBytes: number;
  worktreeCount: number;
}

export interface CleanupCandidate {
  workspaceId: string;
  name: string;
  branch: string;
  reason: string;
}

/** Local wall-clock times. `weekday` 0-6 with 0 = Sunday; `at` is "YYYY-MM-DDTHH:MM" for `once`. */
export interface Schedule {
  kind: "once" | "hourly" | "daily" | "weekdays" | "weekly" | "cron";
  time?: string | null;
  weekday?: number | null;
  cron?: string | null;
  at?: string | null;
}

export type RoutineAction = { kind: "prompt"; text: string } | { kind: "skill"; skillId: string; args: string } | { kind: "simplify" };
export type RoutineMode = "fresh" | "standing";
export type RunStatus = "running" | "done" | "error" | "quiet" | "skipped";

/** A message that runs on a schedule (src-tauri/src/routines.rs). */
export interface Routine {
  id: string;
  repoId: string;
  name: string;
  schedule: Schedule;
  action: RoutineAction;
  agent: AgentKind;
  model: string | null;
  profile: string | null;
  mode: RoutineMode;
  standingWorkspaceId: string | null;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: RunStatus | null;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  workspaceId: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  summary: string | null;
}

export interface RoutineInput {
  id?: string | null;
  repoId: string;
  /** Blank = the first line of the prompt. */
  name: string;
  schedule: Schedule;
  action: RoutineAction;
  agent: AgentKind;
  model?: string | null;
  profile?: string | null;
  mode: RoutineMode;
  /** Bind a standing routine to an existing workspace (scheduling from the chat). */
  standingWorkspaceId?: string | null;
  enabled: boolean;
}

/** A named coworker you hand tasks to (src-tauri/src/teammates.rs). */
export interface Teammate {
  slug: string;
  name: string;
  /** One glyph/letter, or the name of a known icon (see `Avatar`). */
  avatar: string;
  description: string;
  agent: AgentKind;
  model: string | null;
  /** Profile id for the workspaces it creates. */
  profile: string | null;
  /** Repo ids or names it may work in; empty = any. */
  repos: string[];
  /** null = follow the profile. */
  readonly: boolean | null;
  instructions: string;
  /** Has a starter definition shipped with Orbit. */
  bundled: boolean;
  /** A custom file replaces the starter definition. */
  overridden: boolean;
}

export type TeammateStatus = "working" | "needsYou" | "idle";
export type TeammateTaskStatus = "running" | "done" | "error" | "waiting";

export interface TeammateMessage {
  id: string;
  slug: string;
  ts: number;
  role: "user" | "teammate" | "system";
  text: string;
  workspaceId: string | null;
  kind: "message" | "task_started" | "task_report" | "error";
  /** Task status when a started/report card was posted. */
  status: TeammateTaskStatus | null;
  /** Files changed in the task workspace when a report was posted. */
  files: number | null;
}

export interface TeammateTask {
  id: string;
  slug: string;
  workspaceId: string;
  repoId: string;
  status: TeammateTaskStatus;
  createdAt: number;
  finishedAt: number | null;
  summary: string | null;
}

/** A teammate plus what the sidebar needs: status, last message, unseen report. */
export interface TeammateView extends Teammate {
  status: TeammateStatus;
  lastMessage: TeammateMessage | null;
  openTasks: number;
  unseen: boolean;
}

export interface TeammateInput {
  /** Set when editing; absent for a new teammate. */
  slug?: string | null;
  name: string;
  avatar: string;
  description: string;
  agent: AgentKind;
  model?: string | null;
  profile?: string | null;
  repos: string[];
  readonly?: boolean | null;
  instructions: string;
}

export const api = {
  listTeammates: () => invoke<TeammateView[]>("list_teammates"),
  getTeammate: (slug: string) => invoke<TeammateView>("get_teammate", { slug }),
  saveTeammate: (input: TeammateInput) => invoke<TeammateView>("save_teammate", { input }),
  /** Deletes a custom teammate, or resets an overridden starter one to its default. */
  deleteTeammate: (slug: string) => invoke<void>("delete_teammate", { slug }),
  teammateThread: (slug: string, limit = 200) => invoke<TeammateMessage[]>("teammate_thread", { slug, limit }),
  teammateTasks: (slug: string) => invoke<TeammateTask[]>("teammate_tasks", { slug }),
  /** `newTask`: true forces a new task; omitted continues the open one if there is one. Rejects "Pick a repository…" when it can't choose. */
  teammateSend: (slug: string, text: string, repoId?: string | null, newTask?: boolean | null) =>
    invoke<{ workspaceId: string; newTask: boolean }>("teammate_send", { slug, text, repoId: repoId ?? null, newTask: newTask ?? null }),
  teammateMarkSeen: (slug: string) => invoke<void>("teammate_mark_seen", { slug }),
  teammateMemory: (slug: string) => invoke<string>("teammate_memory", { slug }),
  setTeammateMemory: (slug: string, text: string) => invoke<void>("set_teammate_memory", { slug, text }),
  listRoutines: () => invoke<Routine[]>("list_routines"),
  saveRoutine: (input: RoutineInput) => invoke<Routine>("save_routine", { input }),
  deleteRoutine: (id: string) => invoke<void>("delete_routine", { id }),
  setRoutineEnabled: (id: string, enabled: boolean) => invoke<Routine>("set_routine_enabled", { id, enabled }),
  runRoutineNow: (id: string) => invoke<RoutineRun>("run_routine_now", { id }),
  routineRuns: (routineId: string, limit = 12) => invoke<RoutineRun[]>("routine_runs", { routineId, limit }),
  /** Next fire times (ms epoch) for the editor preview; rejects on an invalid schedule. */
  previewSchedule: (schedule: Schedule, count = 3) => invoke<number[]>("preview_schedule", { schedule, count }),
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: Partial<Settings>) => invoke<Settings>("update_settings", { patch }),
  localModelsStatus: () => invoke<LocalStatus>("local_models_status"),
  testLocalModel: (backend: "ollama" | "openaiCompat", model: string) => invoke<LocalTestResult>("test_local_model", { backend, model }),
  remoteStatus: () => invoke<RemoteStatus>("remote_status"),
  remotePairing: () => invoke<RemotePairing>("remote_pairing"),
  remoteDevices: () => invoke<RemoteDevice[]>("remote_devices"),
  remoteRevoke: (id: string) => invoke<void>("remote_revoke", { id }),
  environmentInfo: () => invoke<EnvironmentInfo>("environment_info"),
  listArchivedWorkspaces: () => invoke<Workspace[]>("list_archived_workspaces"),
  restoreWorkspace: (id: string) => invoke<Workspace>("restore_workspace", { id }),
  cleanupMergedWorktrees: (dryRun: boolean) => invoke<CleanupCandidate[]>("cleanup_merged_worktrees", { dryRun }),
  listRepos: () => invoke<Repo[]>("list_repos"),
  addRepo: (path: string) => invoke<Repo>("add_repo", { path }),
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  createWorkspace: (args: CreateWorkspaceArgs) => invoke<Workspace>("create_workspace", { ...args }),
  sendMessage: (id: string, text: string) => invoke<void>("send_message", { id, text }),
  interrupt: (id: string) => invoke<void>("interrupt", { id }),
  stopSession: (id: string) => invoke<void>("stop_session", { id }),
  /** Summarise the conversation to free context (`/compact`). */
  compactSession: (id: string) => invoke<void>("compact_session", { id }),
  /** Fresh agent session in the same worktree; the old context is dropped. */
  newSession: (id: string) => invoke<void>("new_session", { id }),
  workspaceUsage: (id: string) => invoke<WorkspaceUsage>("workspace_usage", { id }),
  allWorkspaceUsage: () => invoke<WorkspaceUsage[]>("all_workspace_usage"),
  usageReport: (sinceMs: number | null) => invoke<UsageReport>("usage_report", { sinceMs }),
  loadEvents: (id: string) => invoke<StoredEvent[]>("load_events", { id }),
  workspaceChanges: (id: string) => invoke<FileChange[]>("workspace_changes", { id }),
  archiveWorkspace: (id: string, removeWorktree: boolean) =>
    invoke<void>("archive_workspace", { id, removeWorktree }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  runSkill: (id: string, skillId: string, args: string) => invoke<void>("run_skill", { id, skillId, args }),
  getPins: () => invoke<string[]>("get_pins"),
  setPins: (pins: string[]) => invoke<void>("set_pins", { pins }),
  listPacks: () => invoke<Pack[]>("list_packs"),
  listSkills: () => invoke<Skill[]>("list_skills"),
  listProfiles: () => invoke<Profile[]>("list_profiles"),
  setWorkspaceProfile: (id: string, profile: string) => invoke<Workspace>("set_workspace_profile", { id, profile }),
  installPack: (url: string) => invoke<Pack>("install_pack", { url }),
  updatePack: (name: string) => invoke<void>("update_pack", { name }),
  removePack: (name: string) => invoke<void>("remove_pack", { name }),
  setPackEnabled: (name: string, enabled: boolean) => invoke<void>("set_pack_enabled", { name, enabled }),
  prStatus: (id: string) => invoke<PrStatus | null>("pr_status", { id }),
  /** `archived`: Orbit also archived the workspace and removed its worktree. */
  mergePr: (id: string, number: number) => invoke<{ archived: boolean }>("merge_pr", { id, number }),
  getCheckCommand: (repoId: string) => invoke<CheckCommandInfo>("get_check_command", { repoId }),
  setCheckCommand: (repoId: string, cmd: string | null) => invoke<void>("set_check_command", { repoId, cmd }),
  runChecks: (workspaceId: string) => invoke<CheckResult>("run_checks", { workspaceId }),
  /** The Ship gate: checks per `checksMode`, then squash save points. Run `shipkit:ship` only when `ok`. */
  prepareShip: (workspaceId: string, skipChecks = false) => invoke<PrepareShip>("prepare_ship", { workspaceId, skipChecks }),
  simplifyState: (workspaceId: string) => invoke<SimplifyState>("simplify_state", { workspaceId }),
  /** Starts the read-only analysis; progress and the result arrive as `simplify` events. */
  simplifyFind: (workspaceId: string) => invoke<SimplifyState>("simplify_find", { workspaceId }),
  simplifyApply: (workspaceId: string, candidateIds: string[]) =>
    invoke<SimplifyState>("simplify_apply", { workspaceId, candidateIds }),
  simplifyCancel: (workspaceId: string) => invoke<SimplifyState>("simplify_cancel", { workspaceId }),
  undoLastTurn: (workspaceId: string) => invoke<void>("undo_last_turn", { workspaceId }),
  workspaceOverlaps: () => invoke<Overlap[]>("workspace_overlaps"),
  syncNow: (workspaceId: string) => invoke<Workspace>("sync_now", { workspaceId }),
  markPrReady: (id: string, number: number) => invoke<void>("mark_pr_ready", { id, number }),
  listAttachments: (workspaceId: string) => invoke<Attachment[]>("list_attachments", { workspaceId }),
  attachFolder: (workspaceId: string, path: string) => invoke<Attachment>("attach_folder", { workspaceId, path }),
  detachFolder: (id: string) => invoke<void>("detach_folder", { id }),
  setAttachmentEditable: (id: string, editable: boolean) =>
    invoke<Attachment>("set_attachment_editable", { id, editable }),
  discoverRelated: (workspaceId: string) => invoke<Related[]>("discover_related", { workspaceId }),
  getRelatedDefaults: (repoId: string) => invoke<string[]>("get_related_defaults", { repoId }),
  setRelatedDefault: (repoId: string, path: string, enabled: boolean) =>
    invoke<void>("set_related_default", { repoId, path, enabled }),
  workspaceSummaries: () => invoke<Summary[]>("workspace_summaries"),
  workspaceSummary: (id: string) => invoke<Summary>("workspace_summary", { id }),
  markSeen: (id: string) => invoke<number>("mark_seen", { id }),
  dismissWorkspace: (id: string) => invoke<number>("dismiss_workspace", { id }),
  /** Hide a workspace from the inbox until `until` (ms epoch); 0 clears the snooze. */
  snoozeWorkspace: (id: string, until: number) => invoke<Workspace>("snooze_workspace", { id, until }),
  /** Rejects with "No GitHub remote…" when the repo isn't on GitHub. */
  listIssues: (repoId: string) => invoke<Issue[]>("list_issues", { repoId }),
  startIssue: (args: StartIssueArgs) => invoke<Workspace>("start_issue", { ...args }),
  issueUrl: (workspaceId: string) => invoke<string>("issue_url", { workspaceId }),
  /** AI-generated follow-ups; slow (3-5s) and may reject. */
  suggestPrompts: (id: string, reason: string, offered: string[] = []) =>
    invoke<string[]>("suggest_prompts", { id, reason, offered }),
};

export const events = {
  onAgentEvent: (cb: (p: AgentEventPayload) => void): Promise<UnlistenFn> =>
    listen<AgentEventPayload>("agent-event", (e) => cb(e.payload)),
  onWorkspace: (cb: (w: Workspace) => void): Promise<UnlistenFn> =>
    listen<Workspace>("workspace", (e) => cb(e.payload)),
  /** The backend archived a workspace itself (a quiet routine run). */
  onWorkspaceArchived: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("workspace-archived", (e) => cb(e.payload)),
  /** Routines or their runs changed (a run started or finished, a one-off switched itself off). */
  onRoutinesChanged: (cb: () => void): Promise<UnlistenFn> => listen("routines-changed", () => cb()),
  /** A teammate's definition, thread or tasks changed. */
  onTeammateChanged: (cb: (slug: string) => void): Promise<UnlistenFn> => listen<string>("teammate-changed", (e) => cb(e.payload)),
  onSimplify: (cb: (s: SimplifyState) => void): Promise<UnlistenFn> =>
    listen<SimplifyState>("simplify", (e) => cb(e.payload)),
};
