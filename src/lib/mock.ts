import { mockCodeCommand, simulateCodeTurn } from "./code/mock";
import { mockReviewCommand } from "./review/mock";
import { BUILTIN_MODELS } from "./settings";
// Browser-only mock backend: `bun run dev` + open http://localhost:1420 to iterate on UI
// without building the Rust app. Never loaded inside Tauri.
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { previewTimes } from "./routines";
import { LAUNCH, applyLaunchSeed, launchIssueName, launchMerge, launchSetHero, launchTeammates, launchChanges, launchEvents, launchPr, launchSend, launchSuggestions } from "./mock-launch";
import type { VoiceModel, VoiceModelId, VoiceResult, RepoScripts, WorkspaceRunStatus, AgentEvent, Attachment, FileRef, ImageRef, HandoffChip, PartState, PlanPart, PlanView, Teammate, TeammateInput, TeammateMessage, TeammateTask, TeammateView, CleanupCandidate, EnvironmentInfo, FileChange, Issue, Pack, PrStatus, Profile, Related, RemoteDevice, Repo, Routine, RoutineInput, RoutineRun, Settings, SimplifyCandidate, SimplifyRow, SimplifyState, Skill, StoredEvent, Summary, UsageReport, UsageTotals, Workspace, WorkspaceUsage, McpServer, Review, AttemptGroup, StartAttemptsArgs } from "./ipc";

const mockReviews = new Map<string, Review>();
function fakeReview(workspaceId: string): Review {
  return {
    workspaceId, prNumber: 827, headSha: "abc123mockhead", createdAt: Date.now(),
    summary: "Found one bug, one risk, and one small cleanup.",
    findings: [
      { path: "src/auth/session.ts", line: 24, severity: "bug", title: "Handle expired sessions", body: "An expired session currently passes the guard and fails on the next request." },
      { path: "src/lib/slug.ts", line: 12, severity: "risk", title: "Keep the fallback unique", body: "Two empty names produce the same slug and may overwrite an existing entry." },
      { path: "src/lib/slug.ts", line: 18, severity: "nit", title: "Name the fallback", body: "A named constant would explain the fallback value." },
    ],
  };
}

const repoScripts: Record<string, RepoScripts> = { r1: { setupScript: "bun install", runScript: "bun run dev -- --port $PORT", copyGlobs: [".env*"] } };
const workspaceRuns: Record<string, WorkspaceRunStatus> = {};
const now = Date.now();
const repos: Repo[] = [
  { id: "r1", name: "superset", path: "C:/code/superset", baseBranch: "main" },
  { id: "r2", name: "marketing-site", path: "C:/code/marketing-site", baseBranch: "main" },
];

const ws = (id: string, repoId: string, name: string, agent: "claude" | "codex", status: Workspace["status"]): Workspace => ({
  id,
  repoId,
  name,
  branch: `you/${name.toLowerCase().replace(/\W+/g, "-")}`,
  path: `C:/Users/you/.orbit/worktrees/${id}`,
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
  disabledPacks: [],
  disabledMcpServers: [],
  snoozedUntil: 0,
  checksFailed: false,
  checksCommand: null,
  checksOutput: null,
  syncConflicts: [],
  behind: 0,
  ahead: 0,
  routineId: null,
  attemptGroup: null,
  teammate: null,
});

const workspaces: Workspace[] = [
  ws("w1", "r1", "Fix onboarding crash", "claude", "running"),
  ws("w2", "r1", "Billing webhooks", "codex", "done"),
  ws("w3", "r1", "Refactor auth flow", "claude", "idle"),
  ws("w4", "r2", "Refresh homepage hero", "claude", "error"),
  ws("w5", "r1", "Migrate billing schema", "claude", "idle"),
  ws("w6", "r2", "Try new pricing layout", "codex", "idle"),
];

// A completed Best of N group is available through attempt_group("attempt-demo").
const attemptGroups: AttemptGroup[] = [{
  id: "attempt-demo", prompt: "Add retry handling", repoId: "r1", createdAt: now - 600_000,
  status: "running", winnerWorkspaceId: null,
  workspaceIds: ["attempt-a", "attempt-b", "attempt-c"],
  attempts: ["attempt-a", "attempt-b", "attempt-c"].map((id, i) => {
    const w = ws(id, "r1", `add-retry-handling · ${"ABC"[i]}`, i === 1 ? "codex" : "claude", "done");
    w.attemptGroup = "attempt-demo";
    w.branch = `you/add-retry-handling-${"abc"[i]}`;
    workspaces.push(w);
    return { workspaceId: id, finished: true, durationMs: 60_000 + i * 10_000, costUsd: 0.1 + i * 0.05,
      summary: { checks: i === 2 ? "fail" : "pass", filesChanged: i + 1, additions: 12 + i * 8, deletions: 3 + i, durationMs: 60_000 + i * 10_000, costUsd: 0.1 + i * 0.05 } };
  }),
}];

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

// Images and files saved through the mock `save_image` / `save_file`, keyed by their fake path.
const svgUrl = (label: string, a: string, b: string) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><text x="160" y="108" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#fff">${label}</text></svg>`,
  );
const mockImages = new Map<string, string>([
  ["C:/mock/images/crash.svg", svgUrl("crash screenshot", "#555", "#222")],
  ["C:/mock/images/signup.svg", svgUrl("signup form", "#777", "#333")],
]);
let mockImageSeq = 0;
let mockFileSeq = 0;

let seq = 0;
const e = (event: AgentEvent): StoredEvent => ({ seq: ++seq, ts: now, event });
const transcript: StoredEvent[] = [
  e({
    type: "userMessage",
    text: "The onboarding flow crashes when the org name is empty. Find the cause and fix it, with a test.",
    images: [{ path: "C:/mock/images/crash.svg", mediaType: "image/svg+xml" }],
    files: [{ path: "C:/mock/files/1/report.pdf", name: "report.pdf", mediaType: "application/pdf", size: 482_300 }],
  }),
  e({ type: "message", text: "I'll trace the onboarding submit path and find where an empty org name blows up." }),
  e({ type: "toolCall", id: "t1", name: "Grep", input: { pattern: "createOrganization" } }),
  e({ type: "toolResult", id: "t1", output: "src/onboarding/submit.ts:42\nsrc/api/org.ts:17", isError: false }),
  e({ type: "toolCall", id: "t2", name: "Read", input: { file_path: "src/onboarding/submit.ts" } }),
  e({ type: "toolResult", id: "t2", output: "…", isError: false, images: [{ path: "C:/mock/images/signup.svg", mediaType: "image/svg+xml" }] }),
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

const mcpServers: McpServer[] = [
  { id: "mcp-files", name: "files", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:/code"], env: {}, url: null, headers: {}, enabled: true },
  { id: "mcp-docs", name: "docs", transport: "http", command: "", args: [], env: {}, url: "https://example.com/mcp", headers: {}, enabled: true },
];

function validateMcpServer(server: McpServer) {
  if (!/^[a-z0-9_-]+$/.test(server.name)) throw "MCP server name must match [a-z0-9_-]+";
  if (server.transport === "stdio" && !server.command.trim()) throw "stdio MCP servers need a command";
  if (server.transport === "http" && !server.url?.trim()) throw "HTTP MCP servers need a URL";
  if (!["stdio", "http"].includes(server.transport)) throw "MCP transport must be stdio or http";
}

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
    worktreePath: "C:/Users/you/.orbit/worktrees/api/fix-onboarding-crash-5c2a", branch: "you/fix-onboarding-crash-5c2a",
  },
];
const suggested: Related[] = [
  { path: "C:/code/design-tokens", name: "design-tokens", relation: "dependency", evidence: 'package.json depends on "@acme/design-tokens"' },
  { path: "C:/code/mobile-app", name: "mobile-app", relation: "dependent", evidence: 'package.json depends on "@acme/superset"' },
];
const relatedDefaults: Record<string, string[]> = { r1: ["C:/code/shared-ui"] };
if (LAUNCH) applyLaunchSeed({ ws, sum, repos, workspaces, summaries, issues, suggested });

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

function setLaunchStatus(id: string, status: Workspace["status"]) {
  const w = workspaces.find((x) => x.id === id);
  if (w) { w.status = status; void emit("workspace", { ...w }); }
}

/** A short fake setup log for a new workspace, so the mock shows the chat's setup row. */
function mockSetup(workspaceId: string) {
  const lines = ["$ bun install", "Resolving dependencies", "Installed 412 packages in 1.8s", "Copied .env.local"];
  const send = (status: string, line?: string) => void emit("workspace-setup", { workspaceId, status, ...(line ? { line } : {}) });
  setTimeout(() => send("running"), 50);
  lines.forEach((l, i) => setTimeout(() => send("running", l), 300 + i * 500));
  setTimeout(() => send("done"), 300 + lines.length * 500);
}
const latestPlans = new Map<string, Extract<AgentEvent, { type: "plan" }> | null>();
const planTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
const mockPlan = (done: number): Extract<AgentEvent, { type: "plan" }> => ({
  type: "plan", explanation: "Working through the requested change.",
  items: ["Inspect the code", "Make the change", "Check the result", "Summarize the work"].map((text, i) => ({
    text, status: i < done ? "done" : i === done ? "inProgress" : "pending",
  })),
});

function emitAgentEvent(workspaceId: string, event: AgentEvent) {
  if (event.type === "turnStarted" || event.type === "sessionReset" || event.type === "turnCompleted" || event.type === "exited") {
    for (const timer of planTimers.get(workspaceId) ?? []) clearTimeout(timer);
    planTimers.delete(workspaceId);
  }
  if (event.type === "turnStarted" || event.type === "sessionReset") latestPlans.set(workspaceId, null);
  if (event.type === "plan") latestPlans.set(workspaceId, event);
  if (event.type === "turnCompleted" && !event.isError && !event.interrupted && latestPlans.get(workspaceId)) emitAgentEvent(workspaceId, mockPlan(4));
  void emit("agent-event", { workspaceId, seq: ++seq, ts: Date.now(), event });
  if (event.type === "turnStarted") {
    emitAgentEvent(workspaceId, mockPlan(0));
    planTimers.set(workspaceId, [1, 2, 3].map((done) => setTimeout(() => emitAgentEvent(workspaceId, mockPlan(done)), done * 150)));
  }
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
  { id: "dev-1", name: "Alex's iPhone", publicKey: "mock", pushToken: "ExponentPushToken[mock]", pairedAt: Date.now() - 3 * 86_400_000, lastSeenAt: Date.now() - 4 * 60_000 },
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
  branchPrefix: "you/",
  defaultAgent: "claude",
  defaultModelClaude: "",
  defaultModelCodex: "",
  defaultProfile: "",
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
  commitMessages: "prompt",
  checksMode: "block",
  checkTimeoutMinutes: 10,
  setupTimeoutMinutes: 10,
  installBeforeChecks: true,
  syncMode: "auto",
  reviewOnShip: "off",
  reviewModel: "sonnet",
  reviewMaxFindings: 8,
  simplifyModel: "sonnet",
  simplifyMaxCandidates: 12,
  simplifyLowRiskButton: true,
  editorFontSize: 13,
  editorTabSize: 2,
  keybindings: {},
  editorWordWrap: false,
  editorAutosave: "off",
  editorFollowAgent: true,
  editorLiveTyping: "stream",
  terminalShell: "",
  editorCommand: null,
  reviewDiffLayout: "unified",
  reviewContextLines: 3,
  reviewWrapLines: false,
  reviewQueueSources: ["requested", "mine"],
  reviewMarkViewedOnNext: false,
  reviewHideWhitespace: false,
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
  modelTeammateReport: "default",
  modelChiefPlan: "default",
  modelVoiceTidy: "off",
  voiceModel: "base.en",
  voiceDevice: "",
  voiceAutoSend: false,
  voiceSilenceMs: 1500,
  voiceTtsEngine: "kokoro",
  voiceKokoroVoice: "af_heart",
  voiceBargeIn: true,
  voiceMinSpeechMs: 400,
  voiceReadAloud: "handsfree",
  voiceTtsVoice: "",
  voiceTtsRate: 1,
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
  commitMessages: ["prompt", "model"],
  syncMode: ["off", "suggest", "auto"],
  reviewOnShip: ["off", "draft", "post"],
  reviewModel: ["haiku", "sonnet", "opus"],
  simplifyModel: ["haiku", "sonnet", "opus"],
};
const checkOverrides: Record<string, string | null> = {};
let pins = ["shipkit:ship", "shipkit:fix-ci", "shipkit:address-comments", "shipkit:rebase"];
const environment: EnvironmentInfo = {
  claude: { path: "C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd", version: "2.1.4", ok: true },
  // Codex is missing here so the red state is visible.
  codex: { path: null, version: null, loggedIn: false },
  gh: { path: "C:\\Program Files\\GitHub CLI\\gh.exe", version: "2.62.0", user: "you", scopes: ["gist", "read:org", "repo"] },
  git: { path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.47.1.windows.1" },
  orbitHome: "C:\\Users\\you\\.orbit",
  dbSizeBytes: 1_482_752,
  worktreeCount: 7,
};
const archived: Workspace[] = [
  { ...ws("a1", "r1", "Add CSV export", "claude", "done"), branch: "you/add-csv-export-1a2b", updatedAt: now - 3 * 86_400_000 },
  { ...ws("a2", "r2", "Fix footer links", "codex", "idle"), branch: "you/fix-footer-links-9c4d", updatedAt: now - 9 * 86_400_000 },
];
let cleanup: CleanupCandidate[] = [
  { workspaceId: "w3", name: "Refactor auth flow", branch: "you/refactor-auth-flow", reason: "PR #801 merged" },
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
    standingWorkspaceId: null, enabled: true, createdAt: now - 20 * day, lastRunAt: null, nextRunAt: null, lastStatus: null, teammate: null, ...p,
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
  rt("rt5", "r1", "Weekly simplify", { kind: "weekly", weekday: 5, time: "16:00" }, "", {
    action: { kind: "simplify" }, lastRunAt: now - 6 * day, lastStatus: "done",
  }),
  rt("rt6", "r1", "Dependency bump check", { kind: "weekly", weekday: 1, time: "08:00" }, "Check for outdated dependencies and open a draft PR with the safe bumps. Note anything risky in the PR description.", {
    teammate: "builder", model: "sonnet", lastRunAt: now - 2 * day, lastStatus: "done",
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
  run("ru8", "rt5", 6 * 24 * 60, "done", "Simplified 3 spots in the slug and session code and opened draft PR #34. One candidate was skipped because the checks failed.", "w2"),
  run("ru9", "rt5", 13 * 24 * 60, "quiet", "Looked at 4 files changed in the last 7 days and found 2 candidates (0 low-risk)."),
  run("ru10", "rt6", 2 * 24 * 60, "done", "Bumped 5 dev dependencies; 2 majors left for you. Draft PR #422.", "w6"),
];

function saveMockRoutine(input: RoutineInput): Routine {
  if (input.action.kind === "prompt" && !input.action.text.trim()) throw "write the message to send";
  const first = input.action.kind === "prompt" ? input.action.text.trim().split("\n")[0] : input.action.kind === "simplify" ? "Simplify recent changes" : `/${input.action.skillId}`;
  const name = input.name.trim() || (first.length > 48 ? `${first.slice(0, 47)}…` : first) || "Routine";
  const times = previewTimes(input.schedule, 1);
  if (input.enabled && !times.length) throw input.schedule.kind === "once" ? "that time has already passed" : "this schedule never fires";
  const existing = routines.find((r) => r.id === input.id);
  const r: Routine = {
    id: existing?.id ?? `rt${routines.length + 1}-${Date.now() % 10000}`,
    repoId: input.repoId, name, schedule: input.schedule, action: input.action, agent: input.agent, model: input.model ?? null,
    profile: input.profile ?? null, mode: input.mode, standingWorkspaceId: input.standingWorkspaceId ?? existing?.standingWorkspaceId ?? null,
    enabled: input.enabled, createdAt: existing?.createdAt ?? Date.now(), lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: input.enabled ? (times[0] ?? null) : null, lastStatus: existing?.lastStatus ?? null, teammate: input.teammate || null,
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

// ---- Teammates (mirrors src-tauri/src/teammates.rs: definitions, threads, tasks, delegation) ----

const tm = (slug: string, name: string, avatar: string, description: string, agent: "claude" | "codex", model: string | null, profile: string | null, instructions: string): Teammate => ({
  slug, name, avatar, description, agent, model, profile, repos: [], readonly: null, instructions, bundled: true, overridden: false,
});
const STARTERS: Teammate[] = [
  tm("chief", "Chief", "portrait:architect", "Takes a vague request, splits it into parts and hands each to the right teammate.", "claude", "sonnet", "shipkit:planner",
    "You are the coordinator. You never write code yourself. Split a request into the smallest set of parts your teammates can do, and write each brief so it stands alone."),
  tm("builder", "Builder", "portrait:coder", "Implements a task end to end in its own workspace, with tests, and leaves a draft PR.", "claude", "sonnet", "shipkit:builder",
    "You implement what you are handed: read the code, make a focused change that matches the project's conventions, add or adjust tests, and run the checks.\nStop at a draft pull request. Never merge. If the request is ambiguous in a way that changes the design, ask one short question first."),
  tm("debugger", "Debugger", "portrait:qa", "Reproduces a bug, finds the root cause, and fixes it with a regression test.", "claude", "sonnet", "shipkit:debugger",
    "You fix reported problems at the root. Reproduce first, explain the cause with evidence, then make the smallest correct fix with a regression test.\nStop at a draft pull request. Never merge."),
  tm("planner", "Planner", "portrait:planner", "Explores the code and writes an implementation plan. Changes nothing.", "claude", "opus", "shipkit:planner",
    "You explore and plan; you never change anything. Answer with a plan someone else can build from."),
  tm("reviewer", "Reviewer", "portrait:reviewer", "Read-only review of a branch or PR by a second model, findings ranked by severity.", "codex", null, "shipkit:reviewer",
    "You review changes adversarially and read-only. Rank findings by severity and point at the exact files and lines."),
  tm("shipper", "Shipper", "portrait:devops", "Gets a branch green and into a draft PR: checks, rebase, CI fixes, review comments.", "claude", "sonnet", "shipkit:shipper",
    "You get a branch shippable with as little new code as possible. Stop at a draft pull request. Never merge."),
  tm("ticket-writer", "Ticket writer", "portrait:documentation", "Turns rough notes into well-formed GitHub issues after checking the code. Read-only.", "claude", "sonnet", "shipkit:ticket-writer",
    "You turn rough notes, bug reports and ideas into well-formed GitHub issues. Never edit code."),
];
let customTeammates: Teammate[] = [
  { ...tm("docs-helper", "Docs helper", "portrait:documentation", "Keeps the README and guides in step with the code.", "claude", "haiku", "shipkit:builder", "Update docs to match what the code now does. Keep edits small and link the code you checked."), bundled: false, repos: ["marketing-site"] },
  { ...tm("release-notes", "Release notes", "portrait:communicator", "Drafts release notes from merged PRs since the last tag.", "claude", "haiku", "shipkit:builder", "Summarise merged PRs by theme. Never edit code."), bundled: false },
  { ...tm("legacy", "Old timer", "portrait:mentor", "Shares context and helps teammates work through unfamiliar code.", "claude", "haiku", "shipkit:builder", "Answer briefly."), bundled: false },
];
const STARTER_DEFAULTS = STARTERS.map((s) => ({ ...s }));
const overridden = new Set<string>();
let tmThreads: Record<string, TeammateMessage[]> = {};
let tmTasks: TeammateTask[] = [];
let tmPlans: MockPlan[] = [];
const tmSeen: Record<string, number> = {};
const tmMemory: Record<string, string> = {
  builder: "# Memory\n- Prefers small PRs, one concern each.\n- Run `bun run typecheck` before opening a PR.\n- Auth code lives in src/auth; the legacy cookie path must keep working.\n",
};

let tmId = 0;
const tmMsg = (slug: string, ageMin: number, p: Partial<TeammateMessage> & Pick<TeammateMessage, "role" | "kind" | "text">): TeammateMessage => ({
  id: `tm${++tmId}`, slug, ts: now - ageMin * min, workspaceId: null, status: null, files: null, meta: null, ...p,
});
const tmTask = (slug: string, workspaceId: string, status: TeammateTask["status"], ageMin: number, summary: string | null = null): TeammateTask => ({
  id: `tk${++tmId}`, slug, workspaceId, repoId: "r1", status, createdAt: now - ageMin * min, finishedAt: status === "done" || status === "error" ? now - (ageMin - 5) * min : null, summary,
  parentTaskId: null, originKind: null, originRef: null, handoffs: [], handedTo: [],
});

interface MockPlan {
  id: string;
  slug: string;
  repoId: string;
  request: string;
  summary: string;
  status: PlanView["status"];
  createdAt: number;
  parts: PlanPart[];
}

function seedTeammates() {
  // Builder: finished one task yesterday, is working on w1 now.
  tmThreads.builder = [
    tmMsg("builder", 1500, { role: "user", kind: "message", text: "Make the Stripe webhook handler idempotent", workspaceId: "w2" }),
    tmMsg("builder", 1499, { role: "teammate", kind: "task_started", text: "Billing webhooks", workspaceId: "w2", status: "running" }),
    tmMsg("builder", 1470, { role: "teammate", kind: "task_report", text: "Webhook retries now back off exponentially and the handler is idempotent. Draft PR #412 is open with tests for duplicate delivery.", workspaceId: "w2", status: "done", files: 6 }),
    tmMsg("builder", 12, { role: "user", kind: "message", text: "The onboarding flow crashes when the org name is empty. Find the cause and fix it, with a test.", workspaceId: "w1" }),
    tmMsg("builder", 12, { role: "teammate", kind: "task_started", text: "Fix onboarding crash", workspaceId: "w1", status: "running" }),
  ];
  tmTasks.push(tmTask("builder", "w2", "done", 1500, "Idempotent webhook handler; draft PR #412."), tmTask("builder", "w1", "running", 12));
  workspaces[0].teammate = "builder";
  workspaces[1].teammate = "builder";
  // A scheduled run: the routine "Dependency bump check" started this task two days ago.
  tmThreads.builder.splice(
    0, 0,
    tmMsg("builder", 2880, { role: "system", kind: "brief", text: "Check for outdated dependencies and open a draft PR with the safe bumps. Note anything risky in the PR description.", workspaceId: "w6", meta: "routine" }),
    tmMsg("builder", 2880, { role: "teammate", kind: "task_started", text: "Dependency bump check", workspaceId: "w6", status: "running" }),
    tmMsg("builder", 2870, { role: "teammate", kind: "task_report", text: "Bumped 5 dev dependencies; 2 majors left for you. Draft PR #422.", workspaceId: "w6", status: "done", files: 2 }),
  );
  const bumpTask = tmTask("builder", "w6", "done", 2880, "Bumped 5 dev dependencies; 2 majors left for you. Draft PR #422.");
  Object.assign(bumpTask, { originKind: "routine", originRef: "Dependency bump check" });
  tmTasks.push(bumpTask);
  workspaces[5].teammate = "builder";
  // Debugger: asked a question and waits.
  tmThreads.debugger = [
    tmMsg("debugger", 190, { role: "user", kind: "message", text: "Refresh the homepage hero crashes the build", workspaceId: "w4" }),
    tmMsg("debugger", 190, { role: "teammate", kind: "task_started", text: "Refresh homepage hero", workspaceId: "w4", status: "running" }),
    tmMsg("debugger", 180, { role: "teammate", kind: "task_report", text: "The build fails because hero.png is imported but was never committed.\n\nShould I regenerate it from the Figma export, or drop the image and use the gradient?", workspaceId: "w4", status: "waiting", files: 1 }),
  ];
  tmTasks.push(tmTask("debugger", "w4", "waiting", 190, "hero.png is missing."));
  workspaces[3].teammate = "debugger";
  // Reviewer: finished, report unseen.
  tmThreads.reviewer = [
    tmMsg("reviewer", 40, { role: "user", kind: "message", text: "Review the refactor/auth-flow branch", workspaceId: "w3" }),
    tmMsg("reviewer", 40, { role: "teammate", kind: "task_started", text: "Review the refactor/auth-flow branch", workspaceId: "w3", status: "running" }),
    tmMsg("reviewer", 31, { role: "teammate", kind: "task_report", text: "Two findings. High: refreshSession can double-submit when the token expires mid-request (src/auth/session.ts:61). Low: the new cookie helper has no test for the legacy path.", workspaceId: "w3", status: "done", files: 0 }),
  ];
  tmTasks.push(tmTask("reviewer", "w3", "done", 40, "Two findings."));
  workspaces[2].teammate = "reviewer";
  tmSeen.builder = now;
  tmSeen.debugger = now - 300 * min;
  tmSeen.reviewer = now - 60 * min;
  // Planner and the rest start with empty threads.
  tmThreads.planner = [
    tmMsg("planner", 3000, { role: "user", kind: "message", text: "Plan the invoice table migration" }),
    tmMsg("planner", 2990, { role: "system", kind: "error", text: "No repository is added yet, so there was nothing to plan against." }),
  ];
  tmSeen.planner = now;
  seedChief();
}

/** Chief: a running plan (one part done, one running, one waiting on both) and a fresh one waiting for Start. */
function seedChief() {
  const builderDone = tmTasks.find((k) => k.slug === "builder" && k.workspaceId === "w2")!;
  workspaces[4].teammate = "planner";
  workspaces[4].status = "running";
  const plannerTask = tmTask("planner", "w5", "running", 9);
  tmTasks.push(plannerTask);
  tmThreads.planner.push(
    tmMsg("planner", 9, { role: "system", kind: "brief", text: "Write the rollout checklist for the billing webhook change: what to deploy first, what to watch, how to roll back.", workspaceId: "w5", meta: "chief" }),
    tmMsg("planner", 9, { role: "teammate", kind: "task_started", text: "Plan the rollout checklist", workspaceId: "w5", status: "running" }),
  );
  const plan1: MockPlan = {
    id: "plan1", slug: "chief", repoId: "r1", status: "running", createdAt: now - 30 * min,
    request: "Make the billing webhook change safe to ship: idempotent handler, a rollout checklist, and a review before it goes out.",
    summary: "Three parts: Builder makes the handler idempotent while Planner drafts the rollout checklist in parallel; Reviewer checks the branch once both are done.",
    parts: [
      { teammate: "builder", title: "Make the webhook handler idempotent", brief: "Make the Stripe webhook handler idempotent, with tests for duplicate delivery. Open a draft PR.", dependsOn: [], taskId: builderDone.id, failed: null },
      { teammate: "planner", title: "Plan the rollout checklist", brief: "Write the rollout checklist for the billing webhook change.", dependsOn: [], taskId: plannerTask.id, failed: null },
      { teammate: "reviewer", title: "Review the combined branch", brief: "Review the idempotency change and check the rollout checklist covers its risks.", dependsOn: [0, 1], taskId: null, failed: null },
    ],
  };
  Object.assign(builderDone, { originKind: "chief", originRef: "chief", parentTaskId: "plan1" });
  Object.assign(plannerTask, { originKind: "chief", originRef: "chief", parentTaskId: "plan1" });
  const plan2: MockPlan = {
    id: "plan2", slug: "chief", repoId: "r2", status: "proposed", createdAt: now - 2 * min,
    request: "Refresh the homepage: new hero, updated pricing copy, and tidy the footer links.",
    summary: "Two independent parts that can run side by side, then a review of both branches.",
    parts: [
      { teammate: "builder", title: "New hero and pricing copy", brief: "Replace the homepage hero and update the pricing copy to match the new plan names.", dependsOn: [], taskId: null, failed: null },
      { teammate: "debugger", title: "Fix the broken footer links", brief: "Find and fix the broken links in the footer, with a link-check test.", dependsOn: [], taskId: null, failed: null },
      { teammate: "reviewer", title: "Review both changes", brief: "Review both branches for regressions in layout and links.", dependsOn: [0, 1], taskId: null, failed: null },
    ],
  };
  tmPlans = [plan1, plan2];
  tmThreads.chief = [
    tmMsg("chief", 31, { role: "user", kind: "message", text: plan1.request }),
    tmMsg("chief", 30, { role: "teammate", kind: "plan", text: `Plan: ${plan1.request}`, meta: "plan1" }),
    tmMsg("chief", 3, { role: "user", kind: "message", text: plan2.request }),
    tmMsg("chief", 2, { role: "teammate", kind: "plan", text: `Plan: ${plan2.request}`, meta: "plan2" }),
  ];
  tmSeen.chief = now;
}

function tmDefs(): Teammate[] {
  return [...STARTERS, ...customTeammates];
}

function tmView(t: Teammate): TeammateView {
  const thread = tmThreads[t.slug] ?? [];
  const tasks = tmTasks.filter((k) => k.slug === t.slug);
  const open = tasks.filter((k) => k.status === "running" || k.status === "waiting");
  const lastReport = Math.max(0, ...thread.filter((m) => m.kind === "task_report" || m.kind === "error").map((m) => m.ts));
  const unseen = lastReport > (tmSeen[t.slug] ?? 0);
  let status: TeammateView["status"] = open.some((k) => k.status === "running") ? "working" : open.length || unseen ? "needsYou" : "idle";
  if (t.slug === "chief") {
    const live = tmPlans.map(planView);
    const needs = live.some((p) => p.status === "proposed" || (p.status === "running" && p.views.some((v) => v.state === "failed" || v.state === "waiting")));
    const working = live.some((p) => p.status === "planning" || (p.status === "running" && p.views.some((v) => v.state === "running" || v.state === "pending")));
    status = needs ? "needsYou" : working ? "working" : unseen ? "needsYou" : "idle";
  }
  return { ...t, overridden: overridden.has(t.slug), status, lastMessage: thread[thread.length - 1] ?? null, openTasks: open.length, unseen };
}

function tmPost(slug: string, m: Omit<TeammateMessage, "id" | "slug" | "ts" | "workspaceId" | "status" | "files" | "meta"> & Partial<TeammateMessage>) {
  (tmThreads[slug] ??= []).push({ id: `tm${++tmId}`, slug, ts: Date.now(), workspaceId: null, status: null, files: null, meta: null, ...m });
}

function planView(p: MockPlan): PlanView {
  const views = p.parts.map((part) => {
    const task = tmTasks.find((k) => k.id === part.taskId);
    const state: PartState = part.failed ? "failed" : !task ? "pending" : task.status === "running" ? "running" : task.status === "waiting" ? "waiting" : task.status === "done" ? "done" : "failed";
    return { ...part, state, summary: task?.summary ?? part.failed, workspaceId: task?.workspaceId ?? null };
  });
  return { ...p, parts: p.parts.map((x) => ({ ...x })), views };
}

/** The role a teammate plays: its profile's name, else its slug. */
const tmRole = (slug: string) => (tmDefs().find((x) => x.slug === slug)?.profile ?? "").split(":").pop() || slug;

/** Mirror of handoff::default_chips. */
function tmChips(t: TeammateTask): HandoffChip[] {
  if (t.status !== "done") return [];
  const role = tmRole(t.slug);
  const text = t.summary ?? "";
  const team = tmDefs().filter((x) => x.slug !== t.slug && x.slug !== "chief");
  const find = (r: string) => team.find((x) => x.slug === r) ?? team.find((x) => tmRole(x.slug) === r);
  const want: [string, string][] = [];
  if (role === "planner") want.push(["builder", "Hand to {}"]);
  else if (role === "builder" || role === "debugger") want.push(["reviewer", "Ask {} to check"]);
  else if (role === "reviewer" && !/no findings|no issues|looks good|lgtm|nothing to fix/i.test(text)) want.push(["builder", "Hand fixes to {}"]);
  if (role !== "shipper" && role !== "ticket-writer" && /\/pull\/|pr #\d|pull request #\d/i.test(text)) want.push(["shipper", "Hand to {}"]);
  const chips: HandoffChip[] = [];
  for (const [r, label] of want) {
    const c = find(r);
    if (c && !chips.some((x) => x.to === c.slug)) chips.push({ to: c.slug, label: label.replace("{}", c.name) });
  }
  return chips.slice(0, 3);
}

function tmTaskRows(slug: string): TeammateTask[] {
  return tmTasks
    .filter((k) => k.slug === slug)
    .map((k) => {
      const handedTo = tmTasks.filter((c) => c.parentTaskId === k.id && c.originKind === "handoff").map((c) => c.slug);
      return { ...k, handoffs: tmChips(k).filter((c) => !handedTo.includes(c.to)), handedTo };
    })
    .reverse();
}

const tmReportFor = (slug: string): string => {
  const role = tmRole(slug);
  if (role === "reviewer") return "Two findings. High: refreshSession can double-submit when the token expires mid-request (src/auth/session.ts:61). Low: the new cookie helper has no test for the legacy path.";
  if (role === "planner") return "Plan ready: three steps in order (schema, handler, backfill), with the risks and one open question about retention.";
  if (role === "shipper") return "Checks are green and the branch is rebased. Draft PR #431 is open.";
  return "Done. The change is on its own branch with tests, and draft PR #430 is open for you to look at.";
};

/** Mock of the report model: finishes the turn a couple of seconds later; a message ending in "?" is answered with a question. */
function tmFinishLater(task: TeammateTask, text: string) {
  setTimeout(() => {
    const w = workspaces.find((x) => x.id === task.workspaceId);
    const asks = /\bwhich\b|\bor\b.*\?$/i.test(text) && text.trim().endsWith("?");
    task.status = asks ? "waiting" : "done";
    task.finishedAt = asks ? null : Date.now();
    const report = asks ? "I found two ways to do this and they differ in what they break.\n\nWhich one do you want?" : tmReportFor(task.slug);
    task.summary = report;
    if (w) { w.status = "done"; void emit("workspace", { ...w }); }
    tmPost(task.slug, { role: "teammate", kind: "task_report", workspaceId: task.workspaceId, status: task.status, files: 3, text: report });
    void emit("teammate-changed", task.slug);
    if (task.originKind === "chief" && task.parentTaskId) mockAdvance(task.parentTaskId);
  }, 2200);
}

interface Origin { kind: "chief" | "handoff" | "routine"; ref: string; parent: string | null }

/** Creates a task's workspace, posts its thread entries and (mock) finishes it a moment later. */
function tmStartTask(t: Teammate, repo: { id: string }, text: string, opts: { user: boolean; name?: string; origin?: Origin }) {
  const name = opts.name ?? text.split("\n")[0].slice(0, 60);
  const w = ws(`w${workspaces.length + 1}`, repo.id, name, t.agent, "running");
  w.teammate = t.slug;
  w.profile = t.profile;
  workspaces.unshift(w);
  void emit("workspace", { ...w });
  const task = tmTask(t.slug, w.id, "running", 0);
  task.repoId = repo.id;
  if (opts.origin) Object.assign(task, { originKind: opts.origin.kind, originRef: opts.origin.ref, parentTaskId: opts.origin.parent });
  tmTasks.push(task);
  if (opts.user) tmPost(t.slug, { role: "user", kind: "message", text, workspaceId: w.id });
  else tmPost(t.slug, { role: "system", kind: "brief", text, workspaceId: w.id, meta: opts.origin?.kind ?? null });
  tmPost(t.slug, { role: "teammate", kind: "task_started", text: name, workspaceId: w.id, status: "running" });
  tmFinishLater(task, text);
  void emit("teammate-changed", t.slug);
  return { task, w };
}

function mockAdvance(planId: string) {
  const plan = tmPlans.find((p) => p.id === planId);
  if (!plan || plan.status !== "running") return;
  const view = planView(plan);
  view.views.forEach((v, i) => {
    if (v.state !== "pending" || !v.dependsOn.every((d) => view.views[d].state === "done")) return;
    const t = tmDefs().find((x) => x.slug === v.teammate)!;
    const repo = repos.find((r) => r.id === plan.repoId)!;
    const earlier = v.dependsOn.map((d) => `- ${view.views[d].title}: ${view.views[d].summary}`).join("\n");
    const brief = earlier ? `${v.brief}\n\nEarlier parts of this plan are done. Build on them:\n${earlier}` : v.brief;
    const { task } = tmStartTask(t, repo, brief, { user: false, name: v.title, origin: { kind: "chief", ref: "chief", parent: plan.id } });
    plan.parts[i].taskId = task.id;
  });
  const after = planView(plan);
  if (after.views.every((v) => v.state === "done")) {
    plan.status = "done";
    tmPost("chief", {
      role: "teammate", kind: "task_report", status: "done", meta: plan.id,
      text: `${plan.summary}\n\nAll parts are done:\n${after.views.map((v) => `- ${v.title} (${v.teammate}): ${v.summary}`).join("\n")}`,
    });
  }
  void emit("teammate-changed", "chief");
}

function tmChiefSend(a: { text: string; repoId: string | null }) {
  const t = tmDefs().find((x) => x.slug === "chief")!;
  const pool = repos.filter((r) => !t.repos.length || t.repos.some((x) => x === r.id || x.toLowerCase() === r.name.toLowerCase()));
  const repo = a.repoId ? pool.find((r) => r.id === a.repoId) : pool.length === 1 ? pool[0] : undefined;
  if (!repo) throw pool.length ? "Pick a repository for this task" : "Add a repository first";
  const text = a.text.trim();
  const plan: MockPlan = { id: `plan${tmPlans.length + 1}-${Date.now() % 10000}`, slug: "chief", repoId: repo.id, request: text, summary: "", status: "planning", createdAt: Date.now(), parts: [] };
  tmPlans.push(plan);
  tmPost("chief", { role: "user", kind: "message", text });
  tmPost("chief", { role: "teammate", kind: "plan", text: `Plan: ${text.slice(0, 80)}`, meta: plan.id });
  setTimeout(() => {
    plan.status = "proposed";
    plan.summary = "Planner looks at the approach first, Builder implements it, and Reviewer checks the result.";
    plan.parts = [
      { teammate: "planner", title: "Plan the approach", brief: `Explore the code and plan: ${text}`, dependsOn: [], taskId: null, failed: null },
      { teammate: "builder", title: "Implement it", brief: `Implement the plan for: ${text}`, dependsOn: [0], taskId: null, failed: null },
      { teammate: "reviewer", title: "Review the result", brief: "Review the branch for correctness and missing tests.", dependsOn: [1], taskId: null, failed: null },
    ];
    void emit("teammate-changed", "chief");
  }, 1500);
  void emit("teammate-changed", "chief");
  return { workspaceId: null, newTask: true };
}

function tmSend(a: { slug: string; text: string; repoId: string | null; newTask: boolean | null }) {
  const t = tmDefs().find((x) => x.slug === a.slug);
  if (!t) throw `No teammate \`${a.slug}\``;
  const text = a.text.trim();
  if (!text) throw "Write a message first";
  if (a.slug === "chief") return tmChiefSend({ text, repoId: a.repoId });
  const open = tmTasks.find((k) => k.slug === a.slug && (k.status === "running" || k.status === "waiting") && workspaces.some((w) => w.id === k.workspaceId));
  if (open && a.newTask !== true) {
    tmPost(a.slug, { role: "user", kind: "message", text, workspaceId: open.workspaceId });
    open.status = "running";
    const w = workspaces.find((x) => x.id === open.workspaceId)!;
    w.status = "running";
    void emit("workspace", { ...w });
    tmFinishLater(open, text);
    void emit("teammate-changed", a.slug);
    return { workspaceId: open.workspaceId, newTask: false };
  }
  const pool = repos.filter((r) => !t.repos.length || t.repos.some((x) => x === r.id || x.toLowerCase() === r.name.toLowerCase()));
  const repo = a.repoId ? pool.find((r) => r.id === a.repoId) : pool.length === 1 ? pool[0] : undefined;
  if (!repo) throw pool.length ? "Pick a repository for this task" : "None of this teammate's repositories are added to Orbit";
  const { w } = tmStartTask(t, repo, text, { user: true });
  return { workspaceId: w.id, newTask: true };
}

function tmHandoff(a: { fromTaskId: string; toSlug: string; note: string | null }) {
  const src = tmTasks.find((k) => k.id === a.fromTaskId);
  if (!src) throw "That task no longer exists";
  if (src.status === "running") throw "Wait for the task to finish before handing it on";
  const to = tmDefs().find((x) => x.slug === a.toSlug);
  if (!to || to.slug === "chief") throw "Chief plans work; hand a result to a teammate that does it";
  if (to.slug === src.slug) throw "A teammate can't hand work to itself";
  const from = tmDefs().find((x) => x.slug === src.slug)!;
  const w0 = workspaces.find((x) => x.id === src.workspaceId);
  const repo = repos.find((r) => r.id === src.repoId) ?? repos[0];
  const job = tmRole(to.slug) === "reviewer" ? "Review the changes on that branch. You are read-only: report findings ranked by severity."
    : tmRole(to.slug) === "shipper" ? "Get that branch shippable: run the checks, rebase on the base branch, and open or update the draft pull request. Never merge."
    : tmRole(to.slug) === "builder" && tmRole(from.slug) === "reviewer" ? "Fix the findings above on this branch, highest severity first."
    : "Continue from their report.";
  const brief = `${from.name} handed this to you. Their report:\n\n${src.summary ?? "Finished."}\n\nBranch: ${w0?.branch ?? "unknown"}\nChanged files (3): src/auth/session.ts, src/auth/cookie.ts, src/auth/session.test.ts\n\nYour job: ${job}${a.note?.trim() ? `\n\nFrom the user: ${a.note.trim()}` : ""}`;
  const { w } = tmStartTask(to, repo, brief, { user: false, name: `${to.name}: ${w0?.name ?? "handed task"}`, origin: { kind: "handoff", ref: src.slug, parent: src.id } });
  tmPost(src.slug, { role: "system", kind: "handoff", text: `Handed to ${to.name}`, workspaceId: w.id, meta: to.slug });
  void emit("teammate-changed", src.slug);
  return { workspaceId: w.id, newTask: true };
}

function tmSave(input: TeammateInput): TeammateView {
  if (!input.name.trim()) throw "A teammate needs a name";
  let slug = input.slug ?? "";
  if (!slug) {
    const base = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "task";
    slug = base;
    for (let n = 2; tmDefs().some((x) => x.slug === slug); n++) slug = `${base}-${n}`;
  }
  const bundled = STARTERS.some((s) => s.slug === slug);
  const t: Teammate = {
    slug, name: input.name.trim(), avatar: input.avatar.trim() || input.name.trim()[0].toUpperCase(), description: input.description.trim(), agent: input.agent,
    model: input.model || null, profile: input.profile || null, repos: input.repos, readonly: input.readonly ?? null, instructions: input.instructions.trim(), bundled, overridden: bundled,
  };
  if (bundled) {
    STARTERS[STARTERS.findIndex((s) => s.slug === slug)] = t;
    overridden.add(slug);
  } else {
    customTeammates = customTeammates.some((x) => x.slug === slug) ? customTeammates.map((x) => (x.slug === slug ? t : x)) : [...customTeammates, t];
  }
  void emit("teammate-changed", slug);
  return tmView(t);
}

seedTeammates();

// ---- Simplify (mirrors src-tauri/src/simplify.rs closely enough to show the whole flow) ----

const simplifyStates: Record<string, SimplifyState> = {};
const mockSimplifyCancelled = new Set<string>();
const mockSimplifyFinding = new Set<string>();

function mockSimplify(workspaceId: string): SimplifyState {
  return (simplifyStates[workspaceId] ??= {
    workspaceId, phase: "idle", candidates: [], rows: [], error: null, scopeFiles: 0, scopeNote: null, checkCommand: null, cancelled: false,
  });
}

function setMockSimplify(st: SimplifyState) {
  simplifyStates[st.workspaceId] = st;
  void emit("simplify", st);
}

const mockCandidates: SimplifyCandidate[] = [
  { id: "c1", file: "src/auth/session.ts", startLine: 42, endLine: 88, signal: "nesting", title: "Flatten refreshSession with early returns", risk: "low",
    rationale: "Five levels of nested ifs hide the one path that matters; the error cases sit at the bottom, far from the checks that cause them.",
    proposedChange: "Invert each condition into a guard clause that returns (or throws) early, keeping the same checks in the same order." },
  { id: "c2", file: "src/lib/slug.ts", startLine: 10, endLine: 31, signal: "duplication", title: "Share one trimDashes helper", risk: "low",
    rationale: "slugify and branchName both strip leading and trailing dashes with the same three-line loop.",
    proposedChange: "Extract trimDashes(s) in slug.ts and call it from both; no change to their outputs." },
  { id: "c3", file: "src/components/Sidebar.tsx", startLine: 120, endLine: 141, signal: "nestedTernary", title: "Replace nested ternary in statusLabel", risk: "medium",
    rationale: "A three-way nested ternary picks the label, and a fourth case was bolted on last week.",
    proposedChange: "Use a lookup object keyed by status, keeping the existing fallback label." },
  { id: "c4", file: "src/lib/api.ts", startLine: 5, endLine: 19, signal: "needlessWrapper", title: "Drop the fetchJson wrapper around fetch", risk: "medium",
    rationale: "fetchJson only forwards its arguments and parses JSON; both callers could use the shared client directly.",
    proposedChange: "Inline the two call sites and delete the wrapper, preserving their error handling." },
  { id: "c5", file: "src/stores/app.ts", startLine: 300, endLine: 352, signal: "booleanFlags", title: "Split select(id, quiet) into two functions", risk: "high",
    rationale: "The quiet flag switches off half the body; callers pass literals.",
    proposedChange: "Create selectQuietly() for the quiet path and have select() call shared helpers." },
];

function mockSimplifyFind(workspaceId: string): SimplifyState {
  const finding: SimplifyState = { ...mockSimplify(workspaceId), phase: "finding", candidates: [], rows: [], error: null, cancelled: false };
  setMockSimplify(finding);
  mockSimplifyFinding.add(workspaceId);
  setTimeout(() => {
    if (!mockSimplifyFinding.delete(workspaceId) || mockSimplify(workspaceId).phase !== "finding") return;
    // The second workspace in the mock has nothing to simplify, so that state can be seen too.
    const empty = workspaceId === "w2";
    const candidates = empty ? [] : mockCandidates;
    setMockSimplify({
      ...mockSimplify(workspaceId),
      phase: "ready",
      candidates,
      rows: candidates.map((c) => ({ candidateId: c.id, status: "queued", detail: null, commit: null, linesRemoved: 0, unchecked: false })),
      scopeFiles: empty ? 2 : 7,
      scopeNote: null,
      checkCommand: workspaceId === "w3" ? null : "bun run typecheck",
    });
  }, 2200);
  return finding;
}

function mockSimplifyApply(workspaceId: string, ids: string[]): SimplifyState {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const start: SimplifyState = { ...mockSimplify(workspaceId), phase: "applying", cancelled: false };
  mockSimplifyCancelled.delete(workspaceId);
  const ordered = start.candidates.filter((c) => ids.includes(c.id)).map((c) => c.id);
  start.rows = start.rows.map((r) => (ordered.includes(r.candidateId) ? { ...r, status: "queued", detail: null, commit: null, linesRemoved: 0, unchecked: false } : r));
  setMockSimplify(start);
  void (async () => {
    const patch = (cid: string, p: Partial<SimplifyRow>) => {
      const cur = mockSimplify(workspaceId);
      setMockSimplify({ ...cur, rows: cur.rows.map((r) => (r.candidateId === cid ? { ...r, ...p } : r)) });
    };
    let n = 0;
    for (const cid of ordered) {
      const title = mockSimplify(workspaceId).candidates.find((c) => c.id === cid)!.title;
      if (mockSimplifyCancelled.delete(workspaceId)) {
        patch(cid, { status: "skipped", detail: "cancelled" });
        setMockSimplify({ ...mockSimplify(workspaceId), cancelled: true });
        continue;
      }
      patch(cid, { status: "editing" });
      emitAgentEvent(workspaceId, { type: "userMessage", text: `Simplify: ${title}` });
      emitAgentEvent(workspaceId, { type: "turnStarted" });
      await wait(1100);
      emitAgentEvent(workspaceId, { type: "turnCompleted", durationMs: 1100, costUsd: 0.02, isError: false, error: null });
      patch(cid, { status: "checking" });
      await wait(900);
      n += 1;
      const checked = mockSimplify(workspaceId).checkCommand !== null;
      if (cid === "c3") patch(cid, { status: "skipped", detail: "checks failed\nsrc/components/Sidebar.tsx(131,9): error TS2322: Type 'string | undefined' is not assignable to type 'string'." });
      else if (cid === "c4") patch(cid, { status: "skipped", detail: "touched tests (src/lib/api.test.ts)" });
      else if (cid === "c5") patch(cid, { status: "noop", detail: "the agent made no change" });
      else patch(cid, { status: "applied", commit: (0xa1b2c3 + n * 0x1357).toString(16).padStart(7, "0"), linesRemoved: 6 + n * 3, unchecked: !checked });
    }
    setMockSimplify({ ...mockSimplify(workspaceId), phase: "done" });
  })();
  return start;
}

const rewoundMockEvents = new Map<string, StoredEvent[]>();

function mockTurnPoints(id: string) {
  const rows = rewoundMockEvents.get(id) ?? (LAUNCH ? launchEvents(id, transcript) : transcript);
  let userTextPreview = "";
  let turnIndex = 0;
  return rows.flatMap((r) => {
    if (r.event.type === "userMessage") userTextPreview = r.event.text.replace(/\s+/g, " ").slice(0, 160);
    if (r.event.type !== "turnCompleted") return [];
    return [{ seq: r.seq, turnIndex: ++turnIndex, sha: r.commitSha ?? r.seq.toString(16).padStart(40, "0"), userTextPreview }];
  });
}

// ── Voice (mock): model downloads, canned transcripts. Capture and speech run in the page, not here. ──
const voiceModels: VoiceModel[] = [
  { id: "tiny.en", kind: "stt", sizeBytes: 77_704_715, installed: false },
  { id: "base.en", kind: "stt", sizeBytes: 147_964_211, installed: false },
  { id: "small.en", kind: "stt", sizeBytes: 487_614_201, installed: false },
  { id: "kokoro", kind: "tts", sizeBytes: 102_639_022, installed: false },
];
const MOCK_TRANSCRIPTS = [
  "Add a loading spinner to the sidebar while workspaces load",
  "Um so like fix the flaky test in the routines file",
  "Rename the helper in the lib folder and update its callers",
];
let voiceUtterance = 0;
const voiceSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** voice_transcribe: audio is base64 of f32 samples; under half a second is "not a message" like the real filter. */
async function mockTranscribe(workspaceId: string, audio: string, mode: "dictate" | "handsfree"): Promise<VoiceResult> {
  const model = voiceModels.find((x) => x.id === settings.voiceModel);
  if (!model?.installed) throw `no model: download ${settings.voiceModel} in Settings > Voice`;
  await voiceSleep(600);
  const samples = Math.floor((audio.length * 3) / 4 / 4);
  if (samples < 8000) return { workspaceId, text: "", raw: "Thank you.", dropped: true };
  const raw = MOCK_TRANSCRIPTS[voiceUtterance++ % MOCK_TRANSCRIPTS.length];
  const text = mode === "dictate" && settings.modelVoiceTidy !== "off" ? raw.replace(/^Um so like /, "").replace(/^./, (c) => c.toUpperCase()) : raw;
  return { workspaceId, text, raw, dropped: false };
}
async function mockVoiceDownload(id: VoiceModelId) {
  const m = voiceModels.find((x) => x.id === id);
  if (!m) throw `unknown model ${id}`;
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    await voiceSleep(100);
    if (i === steps) m.installed = true;
    void emit("voice-download", { id, received: Math.round((m.sizeBytes * i) / steps), total: m.sizeBytes, ...(i === steps ? { done: true } : {}) });
  }
}

export function installMockBackend() {
  if (LAUNCH) launchTeammates(workspaces);
  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as { id?: string; slug?: string; workspaceId?: string; repoId?: string; path?: string; editable?: boolean; enabled?: boolean };
      const id = a.id ?? "";
      // Code filesystem and the tiny PTY shell share the same per-root mock trees.
      if (cmd.startsWith("code_") || cmd.startsWith("pty_")) return mockCodeCommand(cmd, args);
      if (cmd.startsWith("pr_review_") || cmd.startsWith("local_review")) return mockReviewCommand(cmd, args, {
        workspacePath: (id) => workspaces.find((w) => w.id === id)?.path ?? null,
        createWorkspace: (repoId, name, branch) => {
          const w = ws(`w${workspaces.length + 1}`, repoId, name, settings.defaultAgent, "idle");
          w.branch = branch;
          workspaces.unshift(w);
          void emit("workspace", { ...w });
          return { ...w };
        },
      });
      switch (cmd) {
        case "attempt_group": {
          const group = attemptGroups.find((g) => g.id === id);
          if (!group) throw new Error("Unknown attempt group");
          return structuredClone(group);
        }
        case "start_attempts": {
          const input = args as unknown as StartAttemptsArgs;
          if (input.attempts.length < 2 || input.attempts.length > 4 || !input.prompt.trim()) throw new Error("x4 attempts and a prompt");
          if (!repos.some((r) => r.id === input.repoId) || input.attempts.some((a) => a.agent !== "claude" && a.agent !== "codex")) throw new Error("Unknown repository or agent");
          const group: AttemptGroup = { id: `attempt-${Date.now()}`, prompt: input.prompt, repoId: input.repoId, createdAt: Date.now(), status: "running", winnerWorkspaceId: null, workspaceIds: [], attempts: [] };
          input.attempts.forEach((a, i) => {
            const w = ws(`${group.id}-${i}`, input.repoId, `${input.prompt.slice(0, 40)} - ${"ABCD"[i]}`, a.agent, "done");
            w.model = a.model ?? null;
            w.profile = input.profile ?? null;
            w.attemptGroup = group.id;
            w.branch += `-${"abcd"[i]}`;
            workspaces.push(w);
            group.workspaceIds.push(w.id);
            group.attempts.push({ workspaceId: w.id, finished: true, durationMs: 45_000, costUsd: 0.12, summary: { checks: "pass", filesChanged: i + 1, additions: 10 + i, deletions: i, durationMs: 45_000, costUsd: 0.12 } });
            void emit("workspace", { ...w });
          });
          attemptGroups.push(group);
          void emit("attempts", structuredClone(group));
          return structuredClone(group);
        }
        case "compare_attempts": {
          const { aWs, bWs, path } = args as { aWs: string; bWs: string; path?: string };
          const first = workspaces.find((w) => w.id === aWs);
          const second = workspaces.find((w) => w.id === bWs);
          if (!first || !second || first.repoId !== second.repoId) throw new Error("Attempts must belong to the same repository");
          return aWs === bWs ? "" : `diff --git a/${path ?? "src/retry.ts"} b/${path ?? "src/retry.ts"}\n--- a/${path ?? "src/retry.ts"}\n+++ b/${path ?? "src/retry.ts"}\n@@ -1 +1 @@\n-const retries = 2;\n+const retries = 3;`;
        }
        case "pick_attempt":
        case "cancel_attempts": {
          const { groupId, workspaceId } = args as { groupId: string; workspaceId?: string };
          const group = attemptGroups.find((g) => g.id === groupId);
          if (!group) throw new Error("Unknown attempt group");
          const winner = cmd === "pick_attempt" ? workspaceId ?? null : null;
          if (cmd === "pick_attempt" && (!winner || !group.workspaceIds.includes(winner))) throw new Error("Workspace is not in this attempt group");
          if (group.status !== "running" && !(group.status === "picked" && group.winnerWorkspaceId === winner) && !(group.status === "cancelled" && !winner)) throw new Error("Attempt group is already closed");
          group.status = winner ? "picked" : "cancelled";
          group.winnerWorkspaceId = winner;
          for (const workspace of group.workspaceIds.filter((w) => w !== winner)) {
            const index = workspaces.findIndex((w) => w.id === workspace);
            if (index >= 0) archived.push(...workspaces.splice(index, 1));
            void emit("workspace-archived", workspace);
          }
          void emit("attempts", structuredClone(group));
          return structuredClone(group);
        }
        case "list_repos":
          return repos;
        case "list_workspaces":
          return [...workspaces];
        case "load_events":
          return rewoundMockEvents.get(id) ?? (LAUNCH ? launchEvents(id, transcript) : transcript);
        case "latest_plan": {
          const workspaceId = a.workspaceId ?? "";
          if (latestPlans.has(workspaceId)) return latestPlans.get(workspaceId);
          const history = rewoundMockEvents.get(workspaceId) ?? (LAUNCH ? launchEvents(workspaceId, transcript) : transcript);
          for (const { event } of [...history].reverse()) {
            if (event.type === "plan") return event;
            if (event.type === "sessionReset" || event.type === "turnStarted") break;
          }
          return null;
        }
        case "workspace_turn_points":
          return mockTurnPoints(a.workspaceId ?? "");
        case "rewind_preview":
        case "rewind_workspace":
        case "branch_from_turn": {
          const n = args as { workspaceId: string; seq: number; name?: string };
          const source = workspaces.find((w) => w.id === n.workspaceId);
          const points = mockTurnPoints(n.workspaceId);
          const target = points.find((p) => p.seq === n.seq);
          if (!source || !target) throw new Error("This turn has no saved checkpoint");
          if (cmd === "rewind_preview") return { target, files: [], droppedTurns: points.filter((p) => p.seq > n.seq) };
          if (cmd === "branch_from_turn") {
            const branch = ws(`w${workspaces.length + 1}`, source.repoId, n.name ?? `${source.name} from turn ${target.turnIndex}`, source.agent, "idle");
            workspaces.unshift(branch);
            return { ...branch };
          }
          if (source.status === "running") throw new Error("Stop the workspace before rewinding it");
          const rows = rewoundMockEvents.get(source.id) ?? (LAUNCH ? launchEvents(source.id, transcript) : transcript);
          rewoundMockEvents.set(source.id, rows.filter((r) => r.seq <= n.seq));
          source.agentSessionId = null;
          source.status = "idle";
          void emit("workspace", { ...source });
          return { ...source };
        }
        case "workspace_changes":
          return LAUNCH ? launchChanges(id) : changes;
        case "interrupt": {
          const workspace = workspaces.find((w) => w.id === id);
          if (workspace) { workspace.status = "idle"; void emit("workspace", { ...workspace }); }
          emitAgentEvent(id, { type: "turnCompleted", durationMs: null, costUsd: null, isError: false, error: null, interrupted: true });
          return null;
        }
        case "save_image": {
          const { data, mediaType } = args as { data: string; mediaType: string };
          const path = `C:/mock/images/${++mockImageSeq}.${mediaType.split("/")[1] ?? "png"}`;
          mockImages.set(path, `data:${mediaType};base64,${data}`);
          return { path, mediaType };
        }
        case "save_file": {
          const { name, mediaType, data } = args as { name: string; mediaType: string; data: string };
          return { path: `C:/mock/files/${++mockFileSeq}/${name}`, name, mediaType, size: Math.floor((data.length * 3) / 4) };
        }
        case "read_image": {
          const src = mockImages.get((args as { path: string }).path);
          if (!src) throw new Error("image not found");
          return src;
        }
        case "send_message":
          if (LAUNCH) launchSend(id, (args as { text: string }).text, emitAgentEvent, setLaunchStatus);
          else {
            const m = args as { text: string; images?: ImageRef[]; files?: FileRef[] };
            emitAgentEvent(id, { type: "userMessage", text: m.text, ...(m.images ? { images: m.images } : {}), ...(m.files ? { files: m.files } : {}) });
            if (id === "w1") window.dispatchEvent(new CustomEvent("orbit-simulate-agent-edit"));
            else {
              setLaunchStatus(id, "running");
              emitAgentEvent(id, { type: "turnStarted" });
              setTimeout(() => {
                emitAgentEvent(id, { type: "message", text: "I reviewed the selected lines. This is a mock reply; connect an agent in the desktop app for a real response." });
                emitAgentEvent(id, { type: "turnCompleted", durationMs: 800, costUsd: null, isError: false, error: null });
                setLaunchStatus(id, "idle");
              }, 800);
            }
          }
          return null;
        case "run_skill": {
          const skill = skills.find((s) => s.id === (args as { skillId: string }).skillId);
          const w = workspaces.find((x) => x.id === id);
          if (!skill || !packs.some((p) => p.name === skill.pack && p.enabled) || w?.disabledPacks.includes(skill.pack)) {
            throw "Skill is unavailable: it was not found or its pack is disabled globally or in this workspace";
          }
          if (LAUNCH) launchSend(id, (args as { args: string }).args, emitAgentEvent, setLaunchStatus, (args as { skillId: string }).skillId);
          return null;
        }
        case "list_mcp_servers":
          return structuredClone(mcpServers);
        case "save_mcp_server": {
          const server = structuredClone((args as { server: McpServer }).server);
          validateMcpServer(server);
          server.id ||= crypto.randomUUID();
          if (mcpServers.some((s) => s.name === server.name && s.id !== server.id)) throw "An MCP server with that name already exists";
          const index = mcpServers.findIndex((s) => s.id === server.id);
          if (index < 0) mcpServers.push(server); else mcpServers[index] = server;
          return structuredClone(server);
        }
        case "delete_mcp_server": {
          const index = mcpServers.findIndex((s) => s.id === id);
          if (index >= 0) mcpServers.splice(index, 1);
          return;
        }
        case "test_mcp_server": {
          const server = (args as { server: McpServer }).server;
          validateMcpServer(server);
          return { name: server.name, version: "1.0.0-mock" };
        }
        case "import_claude_mcp":
          return structuredClone(mcpServers).map((s) => ({ ...s, id: crypto.randomUUID() }));
        case "set_workspace_mcp_servers": {
          const w = workspaces.find((x) => x.id === id);
          if (!w) throw "Workspace not found";
          w.disabledMcpServers = [...new Set((args as { disabled: string[] }).disabled)].sort();
          void emit("workspace", { ...w });
          return { ...w };
        }
        case "list_packs":
          return packs;
        case "set_pack_enabled": {
          const { name, enabled } = args as { name: string; enabled: boolean };
          const pack = packs.find((p) => p.name === name);
          if (pack) pack.enabled = enabled;
          return null;
        }
        case "list_skills":
          return skills.filter((s) => packs.some((p) => p.name === s.pack && p.enabled));
        case "list_teammates":
          return tmDefs().map(tmView);
        case "get_teammate":
          return tmView(tmDefs().find((x) => x.slug === a.slug)!);
        case "save_teammate":
          return tmSave((args as { input: TeammateInput }).input);
        case "delete_teammate": {
          const slug = a.slug!;
          const si = STARTERS.findIndex((s) => s.slug === slug);
          if (si >= 0) {
            if (!overridden.delete(slug)) throw "This starter teammate is already at its default";
            STARTERS[si] = { ...STARTER_DEFAULTS[si] };
          } else {
            customTeammates = customTeammates.filter((x) => x.slug !== slug);
            delete tmThreads[slug];
            tmTasks = tmTasks.filter((k) => k.slug !== slug);
          }
          void emit("teammate-changed", slug);
          return null;
        }
        case "teammate_thread":
          return (tmThreads[a.slug!] ?? []).slice(-((args as { limit?: number }).limit ?? 200));
        case "teammate_tasks":
          return tmTaskRows(a.slug!);
        case "teammate_plans":
          return tmPlans.filter((p) => p.slug === a.slug).map(planView);
        case "chief_plan_start": {
          const plan = tmPlans.find((p) => p.id === (args as { planId: string }).planId);
          if (!plan || plan.status !== "proposed") throw "This plan isn't waiting to be started";
          plan.status = "running";
          mockAdvance(plan.id);
          return null;
        }
        case "chief_plan_edit": {
          const { planId, plan: edit } = args as { planId: string; plan: { summary: string; parts: { teammate: string; title: string; brief: string; dependsOn: number[] }[] } };
          const plan = tmPlans.find((p) => p.id === planId);
          if (!plan || plan.status !== "proposed") throw "Only a plan that hasn't started can be edited";
          const parts = edit.parts.filter((p) => p.brief.trim() && tmDefs().some((x) => x.slug === p.teammate));
          if (!parts.length) throw "Chief couldn't match this request to any of your teammates";
          plan.summary = edit.summary;
          plan.parts = parts.map((p) => ({ ...p, title: p.title.trim() || p.brief.slice(0, 60), dependsOn: p.dependsOn.filter((d) => d < parts.length), taskId: null, failed: null }));
          void emit("teammate-changed", "chief");
          return null;
        }
        case "chief_plan_cancel": {
          const plan = tmPlans.find((p) => p.id === (args as { planId: string }).planId);
          if (plan && plan.status !== "done") plan.status = "cancelled";
          void emit("teammate-changed", "chief");
          return null;
        }
        case "teammate_handoff":
          return tmHandoff(args as { fromTaskId: string; toSlug: string; note: string | null });
        case "teammate_send":
          return tmSend(args as { slug: string; text: string; repoId: string | null; newTask: boolean | null });
        case "teammate_mark_seen":
          tmSeen[a.slug!] = Date.now();
          void emit("teammate-changed", a.slug!);
          return null;
        case "teammate_memory":
          return tmMemory[a.slug!] ?? "";
        case "set_teammate_memory":
          tmMemory[a.slug!] = (args as { text: string }).text;
          return null;
        case "list_profiles": {
          const w = workspaces.find((x) => x.id === (args as { workspaceId?: string }).workspaceId);
          return profiles.filter((p) => packs.some((pack) => pack.name === p.pack && pack.enabled) && !w?.disabledPacks.includes(p.pack));
        }
        case "set_workspace_packs": {
          const w = workspaces.find((x) => x.id === id);
          if (!w) throw "Workspace not found";
          w.disabledPacks = [...new Set((args as { disabled: string[] }).disabled)].sort();
          void emit("workspace", { ...w });
          return { ...w };
        }
        case "set_workspace_profile": {
          const w = workspaces.find((x) => x.id === id)!;
          w.profile = (args as { profile: string | null }).profile || null;
          return { ...w };
        }
        case "list_issues":
          // r2 stands in for a repo without a GitHub remote.
          if (a.repoId === "r2") throw "No GitHub remote found for this repo";
          await new Promise((r) => setTimeout(r, 300));
          return issues;
        case "issue_url":
          return `https://github.com/acme/${LAUNCH ? "relay" : "superset"}/issues/${workspaces.find((x) => x.id === a.workspaceId)?.issueNumber ?? 0}`;
        case "create_workspace":
        case "start_issue": {
          const n = args as { repoId: string; name?: string; title?: string; agent: "claude" | "codex"; number?: number; issueNumber?: number; profile?: string | null };
          const issueNo = n.number ?? n.issueNumber ?? null;
          const w = ws(`w${workspaces.length + 1}`, n.repoId, LAUNCH && n.title ? launchIssueName(issueNo, n.title) : n.title ?? n.name ?? "New workspace", n.agent, cmd === "start_issue" ? "running" : "idle");
          if (LAUNCH && cmd === "start_issue") launchSetHero(w.id);
          w.issueNumber = n.number ?? n.issueNumber ?? null;
          w.profile = n.profile ?? null;
          if (LAUNCH) {
            const p = args as { prompt?: string | null; title?: string };
            const text = p.prompt?.trim() || (p.title ? `Fix #${w.issueNumber}: ${p.title}` : "");
            if (!w.name.trim() && text) w.name = text.split(/\s+/).slice(0, 4).join(" ");
            if (text) { w.status = "running"; setTimeout(() => launchSend(w.id, text, emitAgentEvent, setLaunchStatus), 300); }
          }
          workspaces.unshift(w);
          mockSetup(w.id);
          return { ...w };
        }
        case "snooze_workspace": {
          const w = workspaces.find((x) => x.id === id)!;
          w.snoozedUntil = (args as { until: number }).until;
          return { ...w };
        }
        case "get_rate_limits":
          return [
            { agent: "claude", windows: [
              { kind: "fiveHour", usedPercent: 62, resetsAt: Math.floor(now / 1000) + 7200 },
              { kind: "weekly", usedPercent: 31, resetsAt: Math.floor(now / 1000) + 259200 },
            ], status: "allowed" },
            { agent: "codex", windows: [
              { kind: "fiveHour", usedPercent: 88, resetsAt: Math.floor(now / 1000) + 3600 },
            ], status: null },
          ];
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
        case "rename_workspace": {
          const w = workspaces.find((x) => x.id === a.id);
          if (w) w.name = (args as { name: string }).name;
          return null;
        }
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
        case "agent_models": {
          const { agent } = args as { agent: "claude" | "codex" };
          return BUILTIN_MODELS[agent].map((id) => ({
            id, label: agent === "claude" ? id[0].toUpperCase() + id.slice(1) : id,
            isDefault: false, efforts: [],
          }));
        }
        case "list_editors":
          return [
            { id: "code", name: "VS Code", command: "code" },
            { id: "cursor", name: "Cursor", command: "cursor" },
          ];
        case "open_in_editor":
          return;
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
        case "get_repo_scripts":
          return repoScripts[a.repoId!] ?? { setupScript: null, runScript: null, copyGlobs: [] };
        case "set_repo_scripts":
          repoScripts[a.repoId!] = (args as { scripts: RepoScripts }).scripts;
          return null;
        case "start_run": {
          if (!repoScripts[workspaces.find((x) => x.id === a.workspaceId)?.repoId ?? ""]?.runScript) throw "This repository has no run script";
          workspaceRuns[a.workspaceId!] = { status: "running", port: 4173 };
          void emit("workspace-run", { workspaceId: a.workspaceId, status: "running", line: "$ bun run dev -- --port 4173" });
          setTimeout(() => void emit("workspace-run", { workspaceId: a.workspaceId, status: "running", line: "ready on http://localhost:4173" }), 400);
          return 4173;
        }
        case "stop_run":
          workspaceRuns[a.workspaceId!] = { status: "stopped", port: 4173 };
          void emit("workspace-run", { workspaceId: a.workspaceId, status: "stopped" });
          return null;
        case "run_status":
          return workspaceRuns[a.workspaceId!] ?? { status: "stopped", port: null };
        case "get_check_command":
          return { detected: a.repoId === "r1" ? "bun run typecheck" : null, override: checkOverrides[a.repoId!] ?? null };
        case "set_check_command":
          checkOverrides[a.repoId!] = (args as { cmd: string | null }).cmd;
          return null;
        case "run_checks":
          return { ok: true, kind: "pass", command: "bun run typecheck", outputTail: "", durationMs: 1800 };
        case "prepare_ship": {
          const w = workspaces.find((x) => x.id === a.workspaceId);
          const skip = (args as { skipChecks?: boolean }).skipChecks;
          if (w?.checksFailed && !skip) {
            const checks = { ok: false, kind: "fail", command: w.checksCommand ?? "bun run typecheck", outputTail: w.checksOutput ?? "", durationMs: 2100 };
            return settings.checksMode === "block" ? { ok: false, checks, squashed: 0, notes: null } : { ok: true, checks, squashed: 2, notes: null };
          }
          if (w && skip) w.checksFailed = false;
          return { ok: true, checks: null, squashed: 2, notes: null };
        }
        case "undo_last_turn":
          return null;
        case "workspace_overlaps":
          return [{ a: "w1", b: "w3", files: ["src/auth/session.ts", "src/lib/slug.ts"] }];
        case "run_review": {
          const workspaceId = a.workspaceId!;
          void emit("review", { workspaceId, status: "running" });
          const review = mockReviews.get(workspaceId) ?? fakeReview(workspaceId);
          mockReviews.set(workspaceId, review);
          void emit("review", { workspaceId, status: "done", review });
          return review;
        }
        case "latest_review":
          return mockReviews.get(a.workspaceId!) ?? null;
        case "post_review":
          if (!mockReviews.has(a.workspaceId!)) throw new Error("No review to post");
          return null;
        case "send_findings_to_agent": {
          const { workspaceId, indices } = args as { workspaceId: string; indices: number[] };
          const review = mockReviews.get(workspaceId);
          if (!review || !indices.length) throw new Error("Select review findings first");
          const findings = [...new Set(indices)].map((i) => {
            const finding = review.findings[i];
            if (!finding) throw new Error("Invalid finding index");
            return `${finding.path}:${finding.line}  -  ${finding.title}\n${finding.body}`;
          });
          const text = `Please address these review findings:\n\n${findings.join("\n\n")}`;
          if (LAUNCH) launchSend(workspaceId, text, emitAgentEvent, setLaunchStatus);
          else emitAgentEvent(workspaceId, { type: "userMessage", text });
          return null;
        }
        case "simplify_state":
          return mockSimplify(a.workspaceId!);
        case "simplify_find":
          return mockSimplifyFind(a.workspaceId!);
        case "simplify_apply":
          return mockSimplifyApply(a.workspaceId!, (args as { candidateIds: string[] }).candidateIds);
        case "simplify_cancel": {
          const st = mockSimplify(a.workspaceId!);
          mockSimplifyCancelled.add(st.workspaceId);
          if (st.phase === "finding") setMockSimplify({ ...st, phase: "idle" });
          return mockSimplify(a.workspaceId!);
        }
        case "sync_now": {
          const w = workspaces.find((x) => x.id === a.workspaceId)!;
          w.behind = 0;
          w.syncConflicts = [];
          return { ...w };
        }
        case "merge_pr":
          if (LAUNCH) { launchMerge(id); return { archived: false }; }
          return { archived: settings.archiveOnMerge };
        case "pr_status":
          if (LAUNCH) return launchPr(id);
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
            att.worktreePath = `C:/Users/you/.orbit/worktrees/${att.name}/${att.workspaceId}-5c2a`;
            att.branch = `you/${att.name}-5c2a`;
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
        case "voice_models":
          return voiceModels.map((m) => ({ ...m }));
        case "voice_download":
          await mockVoiceDownload(id as VoiceModelId);
          return null;
        case "voice_delete_model": {
          const m = voiceModels.find((x) => x.id === id);
          if (m) m.installed = false;
          return null;
        }
        case "voice_transcribe": {
          const v = args as { workspaceId: string; audio: string; mode: "dictate" | "handsfree" };
          return mockTranscribe(v.workspaceId, v.audio, v.mode);
        }
        case "voice_file":
          // The mock has no synthesis model: report "not downloaded" until the fake download finishes, then
          // hand back junk the engine rejects, so read-aloud falls back to the system voice either way.
          if (!voiceModels.find((x) => x.id === "kokoro")?.installed) throw "no model: kokoro is not downloaded";
          return new ArrayBuffer(8);
        case "suggest_prompts":
          await new Promise((r) => setTimeout(r, 1200));
          if (LAUNCH) return launchSuggestions(id);
          return ["Add a regression test for this", "Show me the diff before continuing", "Run the full test suite"];
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  let liveTurn = false;
  const simulate = async (force = false) => {
    if (liveTurn || LAUNCH) return;
    const { useCode } = await import("../stores/code");
    const workspace = workspaces.find((w) => w.id === "w1");
    if (force && workspace) {
      await useCode.getState().openRoot(workspace.path, { workspaceId: workspace.id });
      useCode.getState().setMode(workspace.path.replaceAll("\\", "/"), "watch");
      const { useApp } = await import("../stores/app");
      useApp.setState({ view: "code" });
    }
    const root = useCode.getState().roots.find((r) => r.workspaceId === "w1" || r.path === workspace?.path);
    if (!root || !workspace) return;
    liveTurn = true;
    workspace.status = "running";
    await emit("workspace", { ...workspace });
    try {
      await simulateCodeTurn(root.path, (event) => emitAgentEvent("w1", event), () => workspace.status !== "running");
      if (workspace.status === "running") { workspace.status = "idle"; await emit("workspace", { ...workspace }); }
    } finally { liveTurn = false; }
  };
  if (!LAUNCH) {
    window.addEventListener("orbit-simulate-agent-edit", () => void simulate(true));
    setInterval(() => void simulate(), 12000);
  }
  // Simulate a streaming reply on the running workspace.
  const words = "Pushed the branch. Opening a draft PR with the template now…".split(" ");
  if (!LAUNCH) words.forEach((w, i) =>
    setTimeout(
      () => void emit("agent-event", { workspaceId: "w1", seq: null, ts: now, event: { type: "textDelta", text: (i ? " " : "") + w } }),
      1500 + i * 120,
    ),
  );
}

