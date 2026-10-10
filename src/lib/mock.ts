// Browser-only mock backend: `bun run dev` + open http://localhost:1420 to iterate on UI
// without building the Rust app. Never loaded inside Tauri.
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { previewTimes } from "./routines";
import type { AgentEvent, Attachment, CleanupCandidate, EnvironmentInfo, FileChange, Issue, Pack, Profile, PrStatus, Related, Repo, RemoteDevice, Routine, RoutineInput, RoutineRun, Settings, Skill, StoredEvent, Summary, UsageReport, UsageTotals, Workspace, WorkspaceUsage } from "./ipc";

const now = Date.now();
const repos: Repo[] = [
  { id: "r1", name: "superset", path: "C:/code/superset", baseBranch: "main" },
  { id: "r2", name: "marketing-site", path: "C:/code/marketing-site", baseBranch: "main" },
];

const ws = (id: string, repoId: string, name: string, agent: "claude" | "codex", status: Workspace["status"]): Workspace => ({
  id,
  repoId,
  name,
  branch: `steven/${name.toLowerCase().replace(/\W+/g, "-")}`,
  path: `C:/Users/steven/.orbit/worktrees/${id}`,
  agent,
  model: agent === "claude" ? "opus" : null,
  status,
  agentSessionId: null,
  issueNumber: null,
  createdAt: now,
  updatedAt: now,
  seenSeq: 0,
  dismissedSeq: 0,
  profile: null,
  snoozedUntil: 0,
  checksFailed: false,
  checksCommand: null,
  checksOutput: null,
  syncConflicts: [],
  behind: 0,
  ahead: 0,
  routineId: null,
});

const workspaces: Workspace[] = [
  ws("w1", "r1", "Fix onboarding crash", "claude", "running"),
  ws("w2", "r1", "Billing webhooks", "codex", "done"),
  ws("w3", "r1", "Refactor auth flow", "claude", "idle"),
  ws("w4", "r2", "Refresh homepage hero", "claude", "error"),
  ws("w5", "r1", "Migrate billing schema", "claude", "idle"),
  ws("w6", "r2", "Try new pricing layout", "codex", "idle"),
];

// w1 running (seen), w2 finished unseen, w3 asked a question unseen, w4 failed unseen, w1's PR has failing checks.
const seenSeq: Record<string, number> = { w1: 40, w2: 6, w3: 5, w4: 3 };
workspaces[1].profile = "shipkit:reviewer";
workspaces[2].profile = "shipkit:planner";
workspaces[3].profile = "shipkit:debugger";
workspaces[0].issueNumber = 398;
for (const w of workspaces) w.seenSeq = seenSeq[w.id] ?? 0;
// Trunk handling: w2's ship gate failed, w5's auto-sync hit conflicts, w6 is old and far behind base.
Object.assign(workspaces[1], {
  checksFailed: true,
  checksCommand: "bun run typecheck",
  checksOutput: "src/billing/webhook.ts(42,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\n1 error",
});
Object.assign(workspaces[4], { behind: 4, ahead: 3, syncConflicts: ["src/db/schema.ts", "src/billing/invoice.ts"] });
Object.assign(workspaces[5], { behind: 23, ahead: 1, createdAt: now - 5 * 86_400_000 });
workspaces[4].seenSeq = 20;
workspaces[5].seenSeq = 21;

const min = 60_000;
const sum = (id: string, ageMin: number, p: Partial<Summary>): Summary => ({
  workspaceId: id,
  lastSeq: 0,
  lastActivityTs: now - ageMin * min,
  lastTurnSeq: 0,
  lastTurnError: null,
  lastTurnInterrupted: false,
  lastAssistantText: null,
  lastUserText: null,
  routineName: null,
  ...p,
});
const summaries: Summary[] = [
  sum("w1", 0, { lastSeq: 40, lastTurnSeq: 30, lastAssistantText: "Pushed the branch. Opening a draft PR with the template now.", lastUserText: "/shipkit:ship mention the slug fallback" }),
  sum("w2", 4, { lastSeq: 12, lastTurnSeq: 12, lastAssistantText: "Webhook retries now back off exponentially and the handler is idempotent. Added tests for duplicate delivery.", lastUserText: "Make the Stripe webhook handler idempotent" }),
  sum("w3", 55, { lastSeq: 9, lastTurnSeq: 9, lastAssistantText: "I can split the auth flow into session and token modules.\n\nDo you want me to keep the legacy cookie path working during the migration?", lastUserText: "Refactor the auth flow" }),
  sum("w5", 70, { lastSeq: 20, lastTurnSeq: 20, lastAssistantText: "Schema migration written and tested locally.", lastUserText: "Migrate the billing schema to the new invoice tables" }),
  sum("w6", 600, { lastSeq: 21, lastTurnSeq: 21, lastAssistantText: "Pricing layout prototype is ready for a look.", lastUserText: "Try a three-column pricing layout" }),
  sum("w4", 190, { lastSeq: 8, lastTurnSeq: 8, lastTurnError: "Build failed: cannot resolve ./hero.png", lastAssistantText: "The hero image import is missing from the repo.", lastUserText: "Refresh the homepage hero" }),
];

let seq = 0;
const e = (event: AgentEvent): StoredEvent => ({ seq: ++seq, ts: now, event });
const transcript: StoredEvent[] = [
  e({ type: "userMessage", text: "The onboarding flow crashes when the org name is empty. Find the cause and fix it, with a test." }),
  e({ type: "message", text: "I'll trace the onboarding submit path and find where an empty org name blows up." }),
  e({ type: "toolCall", id: "t1", name: "Grep", input: { pattern: "createOrganization" } }),
  e({ type: "toolResult", id: "t1", output: "src/onboarding/submit.ts:42\nsrc/api/org.ts:17", isError: false }),
  e({ type: "toolCall", id: "t2", name: "Read", input: { file_path: "src/onboarding/submit.ts" } }),
  e({ type: "toolResult", id: "t2", output: "…", isError: false }),
  e({ type: "toolCall", id: "t3", name: "Bash", input: { command: "bun test src/onboarding" } }),
  e({ type: "toolResult", id: "t3", output: "1 fail: slugify(undefined)", isError: true }),
  e({
    type: "message",
    text: "Found it: `slugify(org.name)` runs before validation, so an empty name reaches `name.trim()` as `undefined`.\n\n**Fix**\n- Validate the org name before slugging\n- Fall back to a generated slug\n- Added `submit.test.ts` covering the empty case",
  }),
  e({ type: "toolCall", id: "t4", name: "Edit", input: { file_path: "src/onboarding/submit.ts" } }),
  e({ type: "toolResult", id: "t4", output: "ok", isError: false }),
  e({
    type: "usage", inputTokens: 38, outputTokens: 3400, cacheReadTokens: 252_000, cacheWriteTokens: 16_000,
    contextTokens: 170_000, contextWindow: 200_000, costUsd: 0.214, model: "claude-opus-4",
  }),
  e({ type: "turnCompleted", durationMs: 74000, costUsd: 0.214, isError: false, error: null }),
  e({ type: "userMessage", text: "mention the slug fallback", skill: "shipkit:ship" }),
  e({ type: "toolCall", id: "t5", name: "Bash", input: { command: "git push -u origin HEAD" } }),
];

const changes: FileChange[] = [
  { path: "src/onboarding/submit.ts", additions: 18, deletions: 4, untracked: false },
  { path: "src/onboarding/submit.test.ts", additions: 46, deletions: 0, untracked: true },
  { path: "src/lib/slug.ts", additions: 3, deletions: 1, untracked: false },
];

const packs: Pack[] = [
  { name: "shipkit", plugin: "shipkit", description: "Ship work from an Orbit workspace.", path: "", source: null, builtin: true, enabled: true, skillCount: 0, commandCount: 6 },
  { name: "team-skills", plugin: "team", description: "Example user-installed pack (mock data).", path: "", source: "https://github.com/example/team-skills.git", builtin: false, enabled: true, skillCount: 2, commandCount: 1 },
];
const sk = (id: string, kind: Skill["kind"], description: string, argumentHint: string | null = null): Skill => ({
  id, kind, description, argumentHint, pack: id.split(":")[0], name: id.split(":")[1], path: "",
});
const skills: Skill[] = [
  sk("shipkit:ship", "command", "Commit everything, push the branch, and open (or update) a draft PR.", "[notes]"),
  sk("shipkit:fix-ci", "command", "Find failing CI checks on this branch's PR, fix them, and push."),
  sk("shipkit:address-comments", "command", "Address unresolved review comments on this branch's PR and push the fixes."),
  sk("shipkit:rebase", "command", "Rebase this branch onto the latest base branch, resolve conflicts, and push."),
  sk("shipkit:write-ticket", "command", "Turn rough notes into a well-formed GitHub issue and file it.", "<notes>"),
  sk("team:build-fix", "command", "Detect the build system and incrementally fix build/type errors."),
  sk("team:tdd", "skill", "Test-driven development: write failing tests first, then implement."),
  sk("team:release-notes", "skill", "Draft release notes from merged PRs since the last tag."),
];
const prof = (name: string, description: string, p: Partial<Profile> = {}): Profile => ({
  id: `shipkit:${name}`, pack: "shipkit", description, model: null, agent: null, readonly: false, skills: [], instructions: "", path: "",
  name: (name[0].toUpperCase() + name.slice(1)).replace("-", " "), ...p,
});
const profiles: Profile[] = [
  prof("builder", "Default generalist. Implements the task end to end with tests and a short summary."),
  prof("debugger", "Reproduces the bug, finds the root cause, and makes the smallest correct fix with a regression test."),
  prof("planner", "Read-only. Explores the code and writes an implementation plan; changes nothing.", { readonly: true }),
  prof("reviewer", "Read-only adversarial pre-ship review by a second model. Findings ranked by severity.", { agent: "codex", readonly: true }),
  prof("shipper", "Gets the branch green, reviewed, and merged with minimal new code.", {
    skills: ["shipkit:preflight", "shipkit:ship", "shipkit:fix-ci", "shipkit:address-comments", "shipkit:rebase"],
  }),
  prof("ticket-writer", "Read-only. Turns rough notes into well-formed GitHub issues, checking the code first.", {
    readonly: true, skills: ["shipkit:write-ticket"],
  }),
];
const pr: PrStatus = {
  number: 827, title: "fix(onboarding): handle empty org name", url: "https://github.com/o/r/pull/827", state: "OPEN",
  isDraft: false, mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED",
  checks: { passed: 5, failed: 1, pending: 1, failing: ["test (ubuntu)"] },
};

const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
const issue = (number: number, title: string, labels: string[], author: string, hoursAgo: number, comments: number): Issue => ({
  number, title, labels, author, comments, state: "OPEN", url: `https://github.com/acme/superset/issues/${number}`, updatedAt: ago(hoursAgo),
});
const issues: Issue[] = [
  issue(412, "Dark mode flashes white on first paint", ["bug", "ui"], "ada", 2, 3),
  issue(409, "Support SSO login via SAML", ["feature", "auth", "enterprise"], "grace", 20, 11),
  issue(398, "Onboarding crashes when the org name is empty", ["bug", "p1"], "linus", 30, 5),
  issue(391, "Export billing history as CSV", ["feature"], "ada", 96, 0),
  issue(377, "Webhook retries should back off exponentially", ["enhancement", "billing"], "margaret", 200, 2),
  issue(352, "Docs: document the self-hosting env vars", ["documentation", "good first issue"], "dennis", 600, 1),
];

const attachments: Attachment[] = [
  { id: "a1", workspaceId: "w1", path: "C:/code/shared-ui", name: "shared-ui", editable: false, worktreePath: null, branch: null },
  {
    id: "a2", workspaceId: "w1", path: "C:/code/api", name: "api", editable: true,
    worktreePath: "C:/Users/steven/.orbit/worktrees/api/fix-onboarding-crash-5c2a", branch: "steven/fix-onboarding-crash-5c2a",
  },
];
const suggested: Related[] = [
  { path: "C:/code/design-tokens", name: "design-tokens", relation: "dependency", evidence: 'package.json depends on "@acme/design-tokens"' },
  { path: "C:/code/mobile-app", name: "mobile-app", relation: "dependent", evidence: 'package.json depends on "@acme/superset"' },
];
const relatedDefaults: Record<string, string[]> = { r1: ["C:/code/shared-ui"] };

const totals = (inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number, turns: number): UsageTotals => ({
  inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, turns,
});
// w1 sits at 85% of its window (warn state); w2 is Codex (no cost); w4 has never reported usage.
const usageByWs: Record<string, WorkspaceUsage> = {
  w1: { workspaceId: "w1", total: totals(180, 21_400, 1_450_000, 96_000, 1.42, 7), session: totals(180, 21_400, 1_450_000, 96_000, 1.42, 7), contextTokens: 170_000, contextWindow: 200_000, model: "claude-opus-4" },
  w2: { workspaceId: "w2", total: totals(61_000, 9_800, 410_000, 0, 0, 4), session: totals(61_000, 9_800, 410_000, 0, 0, 4), contextTokens: 98_000, contextWindow: 258_400, model: "gpt-6.1-sol" },
  w3: { workspaceId: "w3", total: totals(90, 6_100, 380_000, 41_000, 0.61, 3), session: totals(90, 6_100, 380_000, 41_000, 0.61, 3), contextTokens: 44_000, contextWindow: 200_000, model: "claude-opus-4" },
};
const sumTokens = (t: UsageTotals) => t.inputTokens + t.outputTokens + t.cacheWriteTokens;

function mockReport(sinceMs: number | null): UsageReport {
  const span = sinceMs === null ? 1 : Math.min(1, Math.max(0.1, (now - sinceMs) / (30 * 86_400_000)) * 3);
  const scale = (t: UsageTotals): UsageTotals => totals(
    Math.round(t.inputTokens * span), Math.round(t.outputTokens * span), Math.round(t.cacheReadTokens * span),
    Math.round(t.cacheWriteTokens * span), t.costUsd * span, Math.max(1, Math.round(t.turns * span)),
  );
  const rows = Object.values(usageByWs).map((u) => {
    const w = workspaces.find((x) => x.id === u.workspaceId)!;
    return { workspaceId: w.id, name: w.name, agent: w.agent, total: scale(u.total), contextTokens: u.contextTokens, contextWindow: u.contextWindow };
  });
  const sum = (list: UsageTotals[]) => list.reduce((a, t) => totals(
    a.inputTokens + t.inputTokens, a.outputTokens + t.outputTokens, a.cacheReadTokens + t.cacheReadTokens,
    a.cacheWriteTokens + t.cacheWriteTokens, a.costUsd + t.costUsd, a.turns + t.turns,
  ), totals(0, 0, 0, 0, 0, 0));
  const agents = (["claude", "codex"] as const).map((agent) => ({ agent, total: sum(rows.filter((r) => r.agent === agent).map((r) => r.total)) }));
  const shape = [0.2, 0.5, 0.9, 0.3, 0, 0, 0.6, 1, 0.7, 0.4, 0.85, 0.5, 0.35, 0.8];
  const grand = sumTokens(sum(Object.values(usageByWs).map((u) => u.total)));
  const byDay = shape.map((f, i) => {
    const d = new Date(now - (13 - i) * 86_400_000);
    return { day: d.toISOString().slice(0, 10), tokens: Math.round((grand / 7) * f), costUsd: Math.round(f * 20) / 10 };
  });
  return { totals: sum(rows.map((r) => r.total)), byWorkspace: rows.sort((a, b) => sumTokens(b.total) - sumTokens(a.total)), byAgent: agents, byDay };
}

function emitAgentEvent(workspaceId: string, event: AgentEvent) {
  void emit("agent-event", { workspaceId, seq: ++seq, ts: Date.now(), event });
}

/** Compaction drops the context to a summary; the mock reports it as a quick turn. */
function mockCompact(id: string) {
  emitAgentEvent(id, { type: "userMessage", text: "/compact" });
  emitAgentEvent(id, { type: "turnStarted" });
  setTimeout(() => {
    const u = usageByWs[id];
    emitAgentEvent(id, {
      type: "usage", inputTokens: 12, outputTokens: 1800, cacheReadTokens: 160_000, cacheWriteTokens: 3_000,
      contextTokens: 9_000, contextWindow: u?.contextWindow ?? 200_000, costUsd: u?.total.costUsd ? 0.09 : null, model: u?.model ?? "claude-opus-4",
    });
    emitAgentEvent(id, { type: "turnCompleted", durationMs: 9000, costUsd: u?.total.costUsd ? 0.09 : null, isError: false, error: null });
    if (u) {
      u.contextTokens = 9_000;
      u.total = totals(u.total.inputTokens + 12, u.total.outputTokens + 1800, u.total.cacheReadTokens + 160_000, u.total.cacheWriteTokens + 3_000, u.total.costUsd + 0.09, u.total.turns + 1);
      u.session = u.total;
    }
  }, 900);
}

let remoteDevices: RemoteDevice[] = [
  { id: "dev-1", name: "Steven's iPhone", publicKey: "mock", pushToken: "ExponentPushToken[mock]", pairedAt: Date.now() - 3 * 86_400_000, lastSeenAt: Date.now() - 4 * 60_000 },
];

/** A fake, non-scannable QR-like grid so the pairing panel has something to show in the mock. */
function mockQr(): string {
  const n = 25;
  let cells = "";
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const finder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
      const on = finder ? x % 6 === 0 || y % 6 === 0 || ((x % 7) > 1 && (x % 7) < 5 && (y % 7) > 1 && (y % 7) < 5) : ((x * 7 + y * 13 + x * y) % 5 < 2);
      if (on) cells += `<rect x="${x + 2}" y="${y + 2}" width="1" height="1"/>`;
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${cells}</g></svg>`;
}

let settings: Settings = {
  branchPrefix: "steven/",
  defaultAgent: "claude",
  defaultModelClaude: "",
  defaultModelCodex: "",
  notifications: true,
  notifyOnlyUnfocused: true,
  claudePermissionMode: "bypassPermissions",
  codexSandbox: "danger-full-access",
  extraModelsClaude: [],
  extraModelsCodex: [],
  mergeMethod: "squash",
  deleteBranchOnMerge: false,
  aiSuggestions: true,
  suggestionModel: "haiku",
  saveCommits: true,
  squashWip: true,
  checksMode: "block",
  syncMode: "auto",
  syncIntervalMinutes: 10,
  staleDays: 3,
  staleBehind: 20,
  archiveOnMerge: true,
  deleteLocalBranch: true,
  localProvider: "ollama",
  localUrl: "",
  localApiKey: "",
  localTimeoutSecs: 60,
  localDefaultModel: "",
  modelSuggestions: "default",
  modelWorkspaceName: "off",
  modelCommitMessage: "default",
  modelRoutineSummary: "default",
  modelPrDescription: "default",
  localAgents: false,
  remoteEnabled: false,
  remotePort: 47821,
  remotePush: true,
  routineConcurrency: 2,
};
const MOCK_LOCAL_MODELS = [
  { name: "llama3.2:3b", sizeBytes: 2_019_393_189, family: "llama", parameterSize: "3.2B", quantization: "Q4_K_M" },
  { name: "qwen2.5-coder:7b", sizeBytes: 4_683_087_332, family: "qwen2", parameterSize: "7.6B", quantization: "Q4_K_M" },
  { name: "gpt-oss:20b", sizeBytes: 13_780_173_839, family: "gptoss", parameterSize: "20.9B", quantization: "MXFP4" },
];
const ENUMS: Record<string, string[]> = {
  localProvider: ["ollama", "openai"],
  claudePermissionMode: ["bypassPermissions", "acceptEdits"],
  codexSandbox: ["danger-full-access", "workspace-write"],
  mergeMethod: ["squash", "merge", "rebase"],
  suggestionModel: ["haiku", "sonnet"],
  defaultAgent: ["claude", "codex"],
  checksMode: ["off", "warn", "block"],
  syncMode: ["off", "suggest", "auto"],
};
const checkOverrides: Record<string, string | null> = {};
let pins = ["shipkit:ship", "shipkit:fix-ci", "shipkit:address-comments", "shipkit:rebase"];
const environment: EnvironmentInfo = {
  claude: { path: "C:\\Users\\steven\\AppData\\Roaming\\npm\\claude.cmd", version: "2.1.4", ok: true },
  // Codex is missing here so the red state is visible.
  codex: { path: null, version: null, loggedIn: false },
  gh: { path: "C:\\Program Files\\GitHub CLI\\gh.exe", version: "2.62.0", user: "steven", scopes: ["gist", "read:org", "repo"] },
  git: { path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.47.1.windows.1" },
  orbitHome: "C:\\Users\\steven\\.orbit",
  dbSizeBytes: 1_482_752,
  worktreeCount: 7,
};
const archived: Workspace[] = [
  { ...ws("a1", "r1", "Add CSV export", "claude", "done"), branch: "steven/add-csv-export-1a2b", updatedAt: now - 3 * 86_400_000 },
  { ...ws("a2", "r2", "Fix footer links", "codex", "idle"), branch: "steven/fix-footer-links-9c4d", updatedAt: now - 9 * 86_400_000 },
];
let cleanup: CleanupCandidate[] = [
  { workspaceId: "w3", name: "Refactor auth flow", branch: "steven/refactor-auth-flow", reason: "PR #801 merged" },
];

// ---- routines: a recurring triage, a nightly check that found nothing, a failing weekly one, a finished one-off
const hr = 3_600_000;
const day = 24 * hr;
const atToday = (h: number, m = 0) => {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const nextAt = (r: Routine) => previewTimes(r.schedule, 1)[0] ?? null;
const rt = (id: string, repoId: string, name: string, schedule: Routine["schedule"], text: string, p: Partial<Routine> = {}): Routine => {
  const r: Routine = {
    id, repoId, name, schedule, action: { kind: "prompt", text }, agent: "claude", model: null, profile: null, mode: "fresh",
    standingWorkspaceId: null, enabled: true, createdAt: now - 20 * day, lastRunAt: null, nextRunAt: null, lastStatus: null, ...p,
  };
  r.nextRunAt = r.enabled ? nextAt(r) : null;
  return r;
};
let routines: Routine[] = [
  rt("rt1", "r1", "Triage new issues", { kind: "weekdays", time: "09:00" }, "Look at the GitHub issues opened since yesterday, label them, and flag duplicates. Don't change code.", {
    lastRunAt: atToday(9), lastStatus: "done",
  }),
  rt("rt2", "r1", "Nightly checks", { kind: "daily", time: "02:00" }, "Run the project's checks and fix anything failing. Open a draft PR if something changed.", {
    lastRunAt: atToday(2), lastStatus: "quiet",
  }),
  rt("rt3", "r2", "Friday dependency check", { kind: "weekly", weekday: 5, time: "16:00" }, "/team:build-fix", {
    action: { kind: "skill", skillId: "team:build-fix", args: "" }, lastRunAt: now - 3 * day, lastStatus: "error",
  }),
  rt("rt4", "r2", "Ship the hero update", { kind: "once", at: new Date(now - day).toISOString().slice(0, 16) }, "Finish the homepage hero and open a draft PR.", {
    enabled: false, mode: "standing", standingWorkspaceId: "w4", lastRunAt: now - day, lastStatus: "done",
  }),
];
const run = (id: string, routineId: string, ageMin: number, status: RoutineRun["status"], summary: string | null, workspaceId: string | null = null): RoutineRun => ({
  id, routineId, workspaceId, startedAt: now - ageMin * min, finishedAt: status === "running" ? null : now - ageMin * min + 4 * min, status, summary,
});
let routineRuns: RoutineRun[] = [
  run("ru1", "rt1", 60, "done", "Labelled 4 new issues (2 bug, 1 feature, 1 docs). #412 duplicates #398. Nothing needs a human today.", "w2"),
  run("ru2", "rt1", 60 + 24 * 60, "quiet", "No new issues since yesterday."),
  run("ru3", "rt1", 60 + 48 * 60, "done", "Triaged 7 issues; #391 and #377 look like quick wins.", "w3"),
  run("ru4", "rt2", 9 * 60, "quiet", "All checks pass; nothing to fix."),
  run("ru5", "rt2", 33 * 60, "skipped", "The previous run was still going"),
  run("ru6", "rt3", 3 * 24 * 60, "error", "Build failed: cannot resolve ./hero.png", "w4"),
  run("ru7", "rt4", 24 * 60, "done", "Hero updated; opened draft PR #31.", "w4"),
];

function saveMockRoutine(input: RoutineInput): Routine {
  if (input.action.kind === "prompt" && !input.action.text.trim()) throw "write the message to send";
  const first = input.action.kind === "prompt" ? input.action.text.trim().split("\n")[0] : `/${input.action.skillId}`;
  const name = input.name.trim() || (first.length > 48 ? `${first.slice(0, 47)}…` : first) || "Routine";
  const times = previewTimes(input.schedule, 1);
  if (input.enabled && !times.length) throw input.schedule.kind === "once" ? "that time has already passed" : "this schedule never fires";
  const existing = routines.find((r) => r.id === input.id);
  const r: Routine = {
    id: existing?.id ?? `rt${routines.length + 1}-${Date.now() % 10000}`,
    repoId: input.repoId, name, schedule: input.schedule, action: input.action, agent: input.agent, model: input.model ?? null,
    profile: input.profile ?? null, mode: input.mode, standingWorkspaceId: input.standingWorkspaceId ?? existing?.standingWorkspaceId ?? null,
    enabled: input.enabled, createdAt: existing?.createdAt ?? Date.now(), lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: input.enabled ? (times[0] ?? null) : null, lastStatus: existing?.lastStatus ?? null,
  };
  routines = existing ? routines.map((x) => (x.id === r.id ? r : x)) : [...routines, r];
  return r;
}

/** A manual run: appears as running, then finishes with a summary a couple of seconds later. */
function mockRunNow(id: string): RoutineRun {
  const r = routines.find((x) => x.id === id)!;
  const started: RoutineRun = { id: `ru-${Date.now()}`, routineId: id, workspaceId: null, startedAt: Date.now(), finishedAt: null, status: "running", summary: null };
  routineRuns.unshift(started);
  r.lastStatus = "running";
  r.lastRunAt = started.startedAt;
  setTimeout(() => {
    started.status = "done";
    started.finishedAt = Date.now();
    started.summary = "Finished. Nothing needed changing.";
    r.lastStatus = "done";
    void emit("routines-changed");
  }, 2000);
  return { ...started };
}

export function installMockBackend() {
  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as { id?: string; workspaceId?: string; repoId?: string; path?: string; editable?: boolean; enabled?: boolean };
      const id = a.id ?? "";
      switch (cmd) {
        case "list_repos":
          return repos;
        case "list_workspaces":
          return [...workspaces];
        case "load_events":
          return transcript;
        case "workspace_changes":
          return changes;
        case "list_packs":
          return packs;
        case "list_skills":
          return skills;
        case "list_profiles":
          return profiles;
        case "set_workspace_profile": {
          const w = workspaces.find((x) => x.id === id)!;
          w.profile = (args as { profile: string }).profile;
          return { ...w };
        }
        case "list_issues":
          // r2 stands in for a repo without a GitHub remote.
          if (a.repoId === "r2") throw "No GitHub remote found for this repo";
          await new Promise((r) => setTimeout(r, 300));
          return issues;
        case "issue_url":
          return `https://github.com/acme/superset/issues/${workspaces.find((x) => x.id === a.workspaceId)?.issueNumber ?? 0}`;
        case "create_workspace":
        case "start_issue": {
          const n = args as { repoId: string; name?: string; title?: string; agent: "claude" | "codex"; number?: number; issueNumber?: number; profile?: string | null };
          const w = ws(`w${workspaces.length + 1}`, n.repoId, n.title ?? n.name ?? "New workspace", n.agent, cmd === "start_issue" ? "running" : "idle");
          w.issueNumber = n.number ?? n.issueNumber ?? null;
          w.profile = n.profile ?? null;
          workspaces.unshift(w);
          return { ...w };
        }
        case "snooze_workspace": {
          const w = workspaces.find((x) => x.id === id)!;
          w.snoozedUntil = (args as { until: number }).until;
          return { ...w };
        }
        case "all_workspace_usage":
          return Object.values(usageByWs);
        case "workspace_usage":
          return usageByWs[id] ?? null;
        case "usage_report":
          return mockReport((args as { sinceMs: number | null }).sinceMs);
        case "compact_session":
          mockCompact(id);
          return null;
        case "new_session": {
          const u = usageByWs[id];
          if (u) {
            u.session = totals(0, 0, 0, 0, 0, 0);
            u.contextTokens = null;
          }
          emitAgentEvent(id, { type: "sessionReset" });
          return null;
        }
        case "get_pins":
          return pins;
        case "set_pins":
          pins = (args as { pins: string[] }).pins;
          return null;
        case "remote_status":
          return {
            running: settings.remoteEnabled,
            port: settings.remotePort,
            addresses: ["100.101.102.103", "192.168.1.42"],
            error: null,
          };
        case "remote_pairing": {
          const uri = `orbit://pair?v=1&pk=mockpublickey&code=mockcode${Date.now() % 10000}&port=${settings.remotePort}&hosts=100.101.102.103,192.168.1.42&name=MOCK-PC`;
          return { uri, svg: mockQr(), expiresAt: Date.now() + 5 * 60_000 };
        }
        case "remote_devices":
          return remoteDevices.map((d) => ({ ...d }));
        case "remote_revoke":
          remoteDevices = remoteDevices.filter((d) => d.id !== id);
          return null;
        case "local_models_status":
          await new Promise((r) => setTimeout(r, 250));
          return {
            ollama: { running: true, version: "0.16.1", url: "http://localhost:11434", models: MOCK_LOCAL_MODELS },
            openaiCompat: { reachable: false, url: "http://localhost:1234", models: [] },
            lastErrors: {},
          };
        case "test_local_model": {
          await new Promise((r) => setTimeout(r, 900));
          return { ok: true, latencyMs: 912, output: '{"reply":"pong"}', error: null };
        }
        case "get_settings":
          return settings;
        case "update_settings": {
          const patch = (args as { patch: Partial<Settings> }).patch;
          for (const [k, v] of Object.entries(patch)) {
            if (ENUMS[k] && !ENUMS[k].includes(v as string)) throw `invalid ${k} "${v}"`;
          }
          settings = { ...settings, ...patch };
          if (patch.branchPrefix !== undefined) {
            const p = patch.branchPrefix.trim().replace(/[^A-Za-z0-9/_-]/g, "-").replace(/^[/-]+|[/-]+$/g, "");
            settings.branchPrefix = p ? `${p}/` : "";
          }
          return settings;
        }
        case "environment_info":
          await new Promise((r) => setTimeout(r, 400));
          return environment;
        case "list_archived_workspaces":
          return archived;
        case "restore_workspace": {
          const i = archived.findIndex((x) => x.id === id);
          const [w] = archived.splice(i, 1);
          workspaces.unshift(w);
          environment.worktreeCount += 1;
          return { ...w };
        }
        case "cleanup_merged_worktrees": {
          await new Promise((r) => setTimeout(r, 500));
          const list = cleanup;
          if (!(args as { dryRun: boolean }).dryRun) {
            for (const c of list) {
              const i = workspaces.findIndex((x) => x.id === c.workspaceId);
              if (i >= 0) archived.unshift(...workspaces.splice(i, 1));
            }
            environment.worktreeCount -= list.length;
            cleanup = [];
          }
          return list;
        }
        case "get_check_command":
          return { detected: a.repoId === "r1" ? "bun run typecheck" : null, override: checkOverrides[a.repoId!] ?? null };
        case "set_check_command":
          checkOverrides[a.repoId!] = (args as { cmd: string | null }).cmd;
          return null;
        case "run_checks":
          return { ok: true, command: "bun run typecheck", outputTail: "", durationMs: 1800 };
        case "prepare_ship": {
          const w = workspaces.find((x) => x.id === a.workspaceId);
          const skip = (args as { skipChecks?: boolean }).skipChecks;
          if (w?.checksFailed && !skip) {
            const checks = { ok: false, command: w.checksCommand ?? "bun run typecheck", outputTail: w.checksOutput ?? "", durationMs: 2100 };
            return settings.checksMode === "block" ? { ok: false, checks, squashed: 0 } : { ok: true, checks, squashed: 2 };
          }
          if (w && skip) w.checksFailed = false;
          return { ok: true, checks: null, squashed: 2 };
        }
        case "undo_last_turn":
          return null;
        case "workspace_overlaps":
          return [{ a: "w1", b: "w3", files: ["src/auth/session.ts", "src/lib/slug.ts"] }];
        case "sync_now": {
          const w = workspaces.find((x) => x.id === a.workspaceId)!;
          w.behind = 0;
          w.syncConflicts = [];
          return { ...w };
        }
        case "merge_pr":
          return { archived: settings.archiveOnMerge };
        case "pr_status":
          return id === "w1" ? pr : null;
        case "workspace_summaries":
          return summaries;
        case "workspace_summary":
          return summaries.find((x) => x.workspaceId === id);
        case "mark_seen": {
          const last = summaries.find((x) => x.workspaceId === id)?.lastSeq ?? 0;
          const w = workspaces.find((x) => x.id === id);
          if (w) w.seenSeq = last;
          return last;
        }
        case "dismiss_workspace": {
          const last = summaries.find((x) => x.workspaceId === id)?.lastSeq ?? 0;
          const w = workspaces.find((x) => x.id === id);
          if (w) w.dismissedSeq = last;
          return last;
        }
        case "list_attachments":
          return attachments.filter((x) => x.workspaceId === a.workspaceId);
        case "attach_folder": {
          let att = attachments.find((x) => x.workspaceId === a.workspaceId && x.path === a.path);
          if (!att) {
            att = { id: `a${attachments.length + 1}`, workspaceId: a.workspaceId!, path: a.path!, name: a.path!.split(/[\\/]/).pop()!, editable: false, worktreePath: null, branch: null };
            attachments.push(att);
          }
          return att;
        }
        case "detach_folder":
          attachments.splice(attachments.findIndex((x) => x.id === id), 1);
          return null;
        case "set_attachment_editable": {
          const att = attachments.find((x) => x.id === id)!;
          att.editable = !!a.editable;
          if (att.editable && !att.worktreePath) {
            att.worktreePath = `C:/Users/steven/.orbit/worktrees/${att.name}/${att.workspaceId}-5c2a`;
            att.branch = `steven/${att.name}-5c2a`;
          }
          return att;
        }
        case "discover_related":
          return a.workspaceId === "w1" ? suggested.filter((r) => !attachments.some((x) => x.workspaceId === "w1" && x.path === r.path)) : [];
        case "get_related_defaults":
          return relatedDefaults[a.repoId!] ?? [];
        case "set_related_default": {
          const list = (relatedDefaults[a.repoId!] ??= []).filter((p) => p !== a.path);
          relatedDefaults[a.repoId!] = a.enabled ? [...list, a.path!] : list;
          return null;
        }
        case "list_routines":
          return routines.map((r) => ({ ...r }));
        case "save_routine":
          return saveMockRoutine((args as { input: RoutineInput }).input);
        case "delete_routine":
          routines = routines.filter((r) => r.id !== id);
          routineRuns = routineRuns.filter((r) => r.routineId !== id);
          return null;
        case "set_routine_enabled": {
          const r = routines.find((x) => x.id === id)!;
          const enabled = !!(args as { enabled: boolean }).enabled;
          const next = enabled ? previewTimes(r.schedule, 1)[0] : undefined;
          if (enabled && !next) throw "that time has already passed; edit the routine to pick a new one";
          r.enabled = enabled;
          r.nextRunAt = next ?? null;
          return { ...r };
        }
        case "run_routine_now":
          return mockRunNow(id);
        case "routine_runs":
          return routineRuns.filter((r) => r.routineId === (args as { routineId: string }).routineId).slice(0, (args as { limit?: number }).limit ?? 20);
        case "preview_schedule": {
          const a2 = args as { schedule: Routine["schedule"]; count?: number };
          return previewTimes(a2.schedule, a2.count ?? 3);
        }
        case "suggest_prompts":
          await new Promise((r) => setTimeout(r, 1200));
          return ["Add a regression test for this", "Show me the diff before continuing", "Run the full test suite"];
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  // Simulate a streaming reply on the running workspace.
  const words = "Pushed the branch. Opening a draft PR with the template now…".split(" ");
  words.forEach((w, i) =>
    setTimeout(
      () => void emit("agent-event", { workspaceId: "w1", seq: null, ts: now, event: { type: "textDelta", text: (i ? " " : "") + w } }),
      1500 + i * 120,
    ),
  );
}
