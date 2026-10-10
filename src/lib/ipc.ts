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
  localAgents: boolean;
  remoteEnabled: boolean;
  remotePort: number;
  remotePush: boolean;
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
  claude: { path: string | null; version: string | null; ok: boolean };
  codex: { path: string | null; version: string | null; loggedIn: boolean };
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

export const api = {
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
  mergePr: (id: string, number: number) => invoke<void>("merge_pr", { id, number }),
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
};
