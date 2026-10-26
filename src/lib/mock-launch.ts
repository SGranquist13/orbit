// Launch-video seed for the browser mock: open http://localhost:1420/?seed=launch.
// A believable fleet across three repos, a transcript and diff per workspace, and a PR whose
// checks go red -> green after /shipkit:fix-ci. The default mock (and its tests) never load this.
import type { AgentEvent, FileChange, Issue, Related, PrStatus, Repo, StoredEvent, Summary, Workspace } from "./ipc";

export const LAUNCH = typeof location !== "undefined" && new URLSearchParams(location.search).get("seed") === "launch";
// `&ws=<id>` opens that workspace (for screenshots); the store restores the last selected one on init.
if (LAUNCH) {
  const ws = new URLSearchParams(location.search).get("ws");
  if (ws) localStorage.setItem("selectedWorkspace", ws);
}

type Emit = (workspaceId: string, event: AgentEvent) => void;
type Ws = (id: string, repoId: string, name: string, agent: "claude" | "codex", status: Workspace["status"]) => Workspace;
type Sum = (id: string, ageMin: number, p: Partial<Summary>) => Summary;

const now = Date.now();
const min = 60_000;
const hour = 3_600_000;

const REPOS: Repo[] = [
  { id: "r1", name: "relay", path: "C:/code/relay", baseBranch: "main" },
  { id: "r2", name: "marketing-site", path: "C:/code/marketing-site", baseBranch: "main" },
  { id: "r3", name: "api-gateway", path: "C:/code/api-gateway", baseBranch: "main" },
];

// [id, repo, name, agent, status, profile, issue, ageMin, seenSeq]
const FLEET: [string, string, string, "claude" | "codex", Workspace["status"], string | null, number | null, number, number][] = [
  ["w1", "r1", "Onboarding crash", "claude", "idle", "shipkit:builder", 398, 2, 40],
  ["w2", "r1", "Idempotent webhooks", "codex", "done", null, 377, 4, 6],
  ["w3", "r1", "Split auth module", "claude", "idle", "shipkit:planner", null, 11, 5],
  ["w4", "r2", "Homepage hero", "claude", "error", "shipkit:debugger", null, 26, 3],
  ["w5", "r1", "Invoice tables", "claude", "running", null, null, 0, 20],
  ["w6", "r3", "Rate-limit API", "codex", "running", null, null, 0, 21],
  ["w7", "r1", "CSV billing export", "claude", "idle", null, 391, 48, 30],
  ["w8", "r1", "Dark mode flash", "codex", "running", null, 412, 0, 12],
];

const SUMMARIES: Record<string, Partial<Summary>> = {
  w1: { lastSeq: 40, lastTurnSeq: 40, lastAssistantText: "Draft PR #827 is open. One check is red: test (ubuntu).", lastUserText: "/shipkit:ship mention the slug fallback" },
  w2: { lastSeq: 12, lastTurnSeq: 12, lastAssistantText: "Retries now back off exponentially and duplicate deliveries are ignored by event id. 9 new tests pass.", lastUserText: "Make the Stripe webhook handler idempotent" },
  w3: { lastSeq: 9, lastTurnSeq: 9, lastAssistantText: "The plan splits auth into session.ts and token.ts in four steps, each shippable on its own.\n\nShould the legacy cookie path keep working until v3, or can it go now?", lastUserText: "Plan splitting the auth flow" },
  w4: { lastSeq: 8, lastTurnSeq: 8, lastTurnError: "Build failed: cannot resolve ./hero.png", lastAssistantText: "hero.png is imported but was never committed.", lastUserText: "Refresh the homepage hero" },
  w5: { lastSeq: 20, lastTurnSeq: 18, lastAssistantText: "Backfilling 3 of 5 invoice tables…", lastUserText: "Move invoices to the new tables, with a backfill" },
  w6: { lastSeq: 21, lastTurnSeq: 19, lastAssistantText: "Adding a token bucket per API key in middleware/ratelimit.go", lastUserText: "Rate-limit the public API per key" },
  w7: { lastSeq: 30, lastTurnSeq: 30, lastAssistantText: "PR #823 is approved and green. Ready to merge.", lastUserText: "Export billing history as CSV" },
  w8: { lastSeq: 12, lastTurnSeq: 10, lastAssistantText: "Inlining the theme script before first paint", lastUserText: "Fix #412: dark mode flashes white" },
};

const CHANGES: Record<string, FileChange[]> = {
  w1: [
    { path: "src/onboarding/submit.ts", additions: 18, deletions: 4, untracked: false },
    { path: "src/onboarding/submit.test.ts", additions: 46, deletions: 0, untracked: true },
    { path: "src/lib/slug.ts", additions: 3, deletions: 1, untracked: false },
  ],
  w2: [
    { path: "src/billing/webhook.ts", additions: 64, deletions: 21, untracked: false },
    { path: "src/billing/retry.ts", additions: 38, deletions: 0, untracked: true },
    { path: "src/billing/webhook.test.ts", additions: 112, deletions: 6, untracked: false },
    { path: "src/db/migrations/0042_webhook_events.sql", additions: 14, deletions: 0, untracked: true },
  ],
  w3: [],
  w4: [
    { path: "src/components/Hero.astro", additions: 41, deletions: 33, untracked: false },
    { path: "src/styles/hero.css", additions: 22, deletions: 9, untracked: false },
  ],
  w5: [
    { path: "src/db/schema.ts", additions: 57, deletions: 12, untracked: false },
    { path: "src/db/migrations/0043_invoices.sql", additions: 88, deletions: 0, untracked: true },
    { path: "scripts/backfill-invoices.ts", additions: 74, deletions: 0, untracked: true },
  ],
  w6: [
    { path: "middleware/ratelimit.go", additions: 96, deletions: 0, untracked: true },
    { path: "middleware/ratelimit_test.go", additions: 131, deletions: 0, untracked: true },
    { path: "cmd/gateway/main.go", additions: 6, deletions: 2, untracked: false },
  ],
  w7: [
    { path: "src/billing/export.ts", additions: 52, deletions: 0, untracked: true },
    { path: "src/routes/billing/history.tsx", additions: 19, deletions: 3, untracked: false },
    { path: "src/billing/export.test.ts", additions: 61, deletions: 0, untracked: true },
  ],
  w8: [
    { path: "index.html", additions: 9, deletions: 0, untracked: false },
    { path: "src/lib/theme.ts", additions: 12, deletions: 15, untracked: false },
  ],
};

const PRS: Record<string, PrStatus> = {
  w1: {
    number: 827, title: "fix(onboarding): handle empty org name", url: "https://github.com/acme/relay/pull/827", state: "OPEN",
    isDraft: true, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
    checks: { passed: 6, failed: 1, pending: 0, failing: ["test (ubuntu)"] },
  },
  w2: {
    number: 829, title: "feat(billing): idempotent Stripe webhooks with backoff", url: "https://github.com/acme/relay/pull/829", state: "OPEN",
    isDraft: true, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
    checks: { passed: 5, failed: 0, pending: 2, failing: [] },
  },
  w7: {
    number: 823, title: "feat(billing): export history as CSV", url: "https://github.com/acme/relay/pull/823", state: "OPEN",
    isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED",
    checks: { passed: 7, failed: 0, pending: 0, failing: [] },
  },
};

const SUGGESTIONS: Record<string, string[]> = {
  w1: ["Fix the failing test and push", "Show me the failing assertion", "Mark the PR ready for review"],
  w2: ["Ship it as a draft PR", "Add a test for out-of-order events", "Review this with Codex"],
  w3: ["Keep the cookie path until v3", "Drop it now and add a migration note", "Build this plan"],
  w4: ["Use the gradient and drop the image", "Regenerate hero.png from the Figma export", "Show me the build log"],
  w7: ["Merge it", "Add a row limit for huge exports", "Write release notes"],
};

const ISSUES: Issue[] = [
  ["Dark mode flashes white on first paint", 412, ["bug", "ui"], "ada", 2, 3],
  ["Support SSO login via SAML", 409, ["feature", "auth", "enterprise"], "grace", 20, 11],
  ["Invite links expire after one hour instead of seven days", 405, ["bug", "p1"], "ken", 26, 4],
  ["Onboarding crashes when the org name is empty", 398, ["bug", "p1"], "linus", 30, 5],
  ["Export billing history as CSV", 391, ["feature", "billing"], "ada", 96, 2],
  ["Search results ignore the archived filter", 386, ["bug"], "barbara", 120, 1],
  ["Webhook retries should back off exponentially", 377, ["enhancement", "billing"], "margaret", 200, 2],
  ["Docs: document the self-hosting env vars", 352, ["documentation", "good first issue"], "dennis", 600, 1],
].map(([title, number, labels, author, h, comments]) => ({
  number: number as number, title: title as string, labels: labels as string[], author: author as string, comments: comments as number,
  state: "OPEN", url: `https://github.com/acme/relay/issues/${number}`, updatedAt: new Date(now - (h as number) * hour).toISOString(),
}));

// Transcripts. w1 keeps the default mock's onboarding transcript, which already reads well.
let seq = 1000;
const ev = (event: AgentEvent, ageMin = 0): StoredEvent => ({ seq: ++seq, ts: now - ageMin * min, event });
const tool = (id: string, name: string, input: unknown, output: string, isError = false): StoredEvent[] => [
  ev({ type: "toolCall", id, name, input }), ev({ type: "toolResult", id, output, isError }),
];
const done = (ms: number, cost: number | null): StoredEvent => ev({ type: "turnCompleted", durationMs: ms, costUsd: cost, isError: false, error: null });

const TRANSCRIPTS: Record<string, StoredEvent[]> = {
  w2: [
    ev({ type: "userMessage", text: "Make the Stripe webhook handler idempotent. Retries should back off exponentially. Add tests for duplicate delivery." }, 30),
    ev({ type: "message", text: "I'll read the handler and the retry path, then store processed event ids so a redelivery is a no-op." }),
    ...tool("c1", "Read", { file_path: "src/billing/webhook.ts" }, "…"),
    ...tool("c2", "Grep", { pattern: "retryWebhook" }, "src/billing/webhook.ts:88\nsrc/jobs/queue.ts:31"),
    ...tool("c3", "Edit", { file_path: "src/billing/webhook.ts" }, "ok"),
    ...tool("c4", "Write", { file_path: "src/billing/retry.ts" }, "ok"),
    ...tool("c5", "Bash", { command: "bun test src/billing" }, "41 pass, 0 fail"),
    ev({ type: "message", text: "Done.\n\n- Processed event ids go in `webhook_events`; a duplicate delivery returns 200 without side effects\n- Retries back off at 2s, 4s, 8s, up to 5 attempts\n- 9 new tests cover duplicates, out-of-order delivery and retry limits\n\nAll 41 billing tests pass." }),
    done(212000, null),
  ],
  w3: [
    ev({ type: "userMessage", text: "Plan splitting the auth flow into session and token modules. Don't change anything yet." }, 60),
    ev({ type: "message", text: "Reading the auth code to see what depends on what. I'm read-only in this profile." }),
    ...tool("p1", "Glob", { pattern: "src/auth/**" }, "src/auth/index.ts\nsrc/auth/cookies.ts\nsrc/auth/refresh.ts\nsrc/auth/middleware.ts"),
    ...tool("p2", "Read", { file_path: "src/auth/index.ts" }, "…"),
    ...tool("p3", "Grep", { pattern: "from \"@/auth\"" }, "23 files"),
    ev({ type: "message", text: "**Plan: split auth into session and token**\n\n1. Extract `token.ts` (sign, verify, refresh). No behaviour change.\n2. Extract `session.ts` on top of it; `index.ts` re-exports both.\n3. Move the 23 importers to the new paths, one PR per area.\n4. Delete the re-exports.\n\nEach step ships on its own and keeps tests green.\n\nShould the legacy cookie path keep working until v3, or can it go now?" }),
    done(96000, 0.31),
  ],
  w4: [
    ev({ type: "userMessage", text: "Refresh the homepage hero with the new illustration and tighter copy." }, 200),
    ...tool("h1", "Edit", { file_path: "src/components/Hero.astro" }, "ok"),
    ...tool("h2", "Bash", { command: "npm run build" }, "error: Could not resolve \"./hero.png\" from src/components/Hero.astro", true),
    ev({ type: "message", text: "The build fails because `hero.png` is imported but was never committed. I can regenerate it from the Figma export or drop the image and use the gradient." }),
    ev({ type: "turnCompleted", durationMs: 81000, costUsd: 0.18, isError: true, error: "Build failed: cannot resolve ./hero.png" }),
  ],
  w5: [
    ev({ type: "userMessage", text: "Move invoices to the new tables, with a backfill script and a migration." }, 14),
    ev({ type: "message", text: "Writing the migration first, then a resumable backfill that runs in batches of 5,000." }),
    ...tool("m1", "Read", { file_path: "src/db/schema.ts" }, "…"),
    ...tool("m2", "Write", { file_path: "src/db/migrations/0043_invoices.sql" }, "ok"),
    ...tool("m3", "Write", { file_path: "scripts/backfill-invoices.ts" }, "ok"),
    ...tool("m4", "Bash", { command: "bun run db:migrate --dry-run" }, "0043_invoices.sql: 3 tables, 2 indexes"),
    ev({ type: "turnStarted" }),
  ],
  w6: [
    ev({ type: "userMessage", text: "Rate-limit the public API per key. 600 requests a minute, burst of 100. Return 429 with Retry-After." }, 9),
    ev({ type: "message", text: "Adding a token bucket per API key in middleware, with tests for burst and refill." }),
    ...tool("g1", "Read", { file_path: "cmd/gateway/main.go" }, "…"),
    ...tool("g2", "Write", { file_path: "middleware/ratelimit.go" }, "ok"),
    ...tool("g3", "Bash", { command: "go test ./middleware/..." }, "ok  	gateway/middleware	0.412s"),
    ev({ type: "turnStarted" }),
  ],
  w7: [
    ev({ type: "userMessage", text: "Export billing history as CSV from the billing page. Stream it so big accounts don't time out." }, 2900),
    ...tool("x1", "Write", { file_path: "src/billing/export.ts" }, "ok"),
    ...tool("x2", "Bash", { command: "bun test src/billing/export" }, "6 pass, 0 fail"),
    ev({ type: "message", text: "The export streams rows in pages of 1,000, so memory stays flat. Added a Download CSV button to Billing history." }),
    done(143000, 0.27),
    ev({ type: "userMessage", text: "", skill: "shipkit:ship" }, 2800),
    ...tool("x3", "Bash", { command: "gh pr create --draft" }, "https://github.com/acme/relay/pull/823"),
    ev({ type: "message", text: "PR #823 is approved and green. Ready to merge." }),
    done(38000, 0.04),
  ],
  w8: [
    ev({ type: "userMessage", text: "Fix #412: dark mode flashes white on first paint." }, 5),
    ...tool("d1", "Read", { file_path: "src/lib/theme.ts" }, "…"),
    ev({ type: "message", text: "The theme is applied after hydration, so the first paint uses the light default. Inlining the theme script before first paint." }),
    ev({ type: "turnStarted" }),
  ],
};

/** Replace the default mock data in place with the launch fleet. */
export function applyLaunchSeed(d: {
  ws: Ws; sum: Sum; repos: Repo[]; workspaces: Workspace[]; summaries: Summary[]; issues: Issue[]; suggested: Related[];
}) {
  d.repos.splice(0, d.repos.length, ...REPOS);
  d.workspaces.splice(0, d.workspaces.length, ...FLEET.map(([id, repo, name, agent, status, profile, issue, age, seen]) => {
    const w = d.ws(id, repo, name, agent, status);
    return { ...w, profile, issueNumber: issue, seenSeq: seen, createdAt: now - (age + 30) * min, updatedAt: now - age * min };
  }));
  d.summaries.splice(0, d.summaries.length, ...FLEET.map(([id, , , , , , , age]) => d.sum(id, age, SUMMARIES[id])));
  d.issues.splice(0, d.issues.length, ...ISSUES);
}

/** Teammate labels in the sidebar, applied after the default mock assigns its own by index. */
export function launchTeammates(workspaces: Workspace[]) {
  const by: Record<string, string> = { w2: "builder", w4: "debugger", w6: "builder" };
  for (const w of workspaces) w.teammate = by[w.id] ?? null;
}

export const launchEvents = (id: string, fallback: StoredEvent[]) => (id === "w1" ? fallback : TRANSCRIPTS[id] ?? []);
export const launchChanges = (id: string) => CHANGES[id] ?? [];
export const launchPr = (id: string) => PRS[id] ?? null;
export const launchSuggestions = (id: string) => SUGGESTIONS[id] ?? ["Run the full test suite", "Show me the diff", "Ship it"];

type Script = { tools: [string, unknown, string][]; reply: string; after?: () => void };

let heroId: string | null = null;
export const launchSetHero = (id: string) => { heroId = id; };
// The launch film's hero task: issue #405 started from the backlog, shipped, fixed in CI, merged.
const HERO_PR = 831;
const ISSUE_NAMES: Record<number, string> = { 405: "Invite link expiry" };
export const launchIssueName = (n: number | null | undefined, title: string) => (n != null && ISSUE_NAMES[n]) || title;
export function launchMerge(id: string) { if (PRS[id]) PRS[id] = { ...PRS[id], state: "MERGED" }; }

/** What a turn does, keyed off the message (and the workspace). Anything unmatched gets a short generic turn. */
function script(text: string, id: string): Script {
  if (/shipkit:ship/.test(text) && !PRS[id]) return {
    tools: [
      ["Bash", { command: "git push -u origin HEAD" }, "branch you/invite-link-expiry set up to track origin"],
      ["Bash", { command: "gh pr create --draft --fill" }, `https://github.com/acme/relay/pull/${HERO_PR}`],
    ],
    reply: `Opened draft PR #${HERO_PR}: fix(invites): links last seven days. CI is running.`,
    after: () => {
      PRS[id] = {
        number: HERO_PR, title: "fix(invites): links last seven days", url: `https://github.com/acme/relay/pull/${HERO_PR}`, state: "OPEN",
        isDraft: true, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
        checks: { passed: 6, failed: 1, pending: 0, failing: ["test (ubuntu)"] },
      };
    },
  };
  if (/fix-ci|fix the failing/i.test(text) && PRS[id]?.number === HERO_PR) return {
    tools: [
      ["Bash", { command: "gh run view --log-failed" }, "invites.test.ts:31  expected 3600000 to be 604800000"],
      ["Edit", { file_path: "src/invites/invites.test.ts" }, "ok"],
      ["Bash", { command: "bun test src/invites && git push" }, "12 pass, 0 fail"],
    ],
    reply: "An old test still asserted the one-hour expiry. Updated it to seven days and pushed. All 7 checks pass.",
    after: () => { PRS[id] = { ...PRS[id], isDraft: false, checks: { passed: 7, failed: 0, pending: 0, failing: [] } }; },
  };
  if (/fix-ci|fix the failing/i.test(text)) return {
    tools: [
      ["Bash", { command: "gh run view --log-failed" }, "submit.test.ts: expected \"\" to be \"org-3f9a\""],
      ["Edit", { file_path: "src/onboarding/submit.test.ts" }, "ok"],
      ["Bash", { command: "bun test src/onboarding && git push" }, "7 pass, 0 fail"],
    ],
    reply: "The test still expected the old slug for an empty name. Updated it to the generated fallback and pushed. All 7 checks pass.",
    after: () => { if (PRS.w1) PRS.w1 = { ...PRS.w1, isDraft: false, checks: { passed: 7, failed: 0, pending: 0, failing: [] } }; },
  };
  if (/saml|sso/i.test(text)) return {
    tools: [
      ["Glob", { pattern: "src/auth/**" }, "src/auth/index.ts\nsrc/auth/session.ts\nsrc/auth/providers/google.ts"],
      ["Read", { file_path: "src/auth/providers/google.ts" }, "…"],
      ["Write", { file_path: "src/auth/providers/saml.ts" }, "ok"],
    ],
    reply: "Adding SAML as a provider next to Google, behind the `sso` flag, so orgs can switch it on one at a time.",
  };
  if (/invite/i.test(text)) return {
    tools: [
      ["Grep", { pattern: "INVITE_TTL" }, "src/invites/create.ts:4:const INVITE_TTL = 60 * 60 * 1000;"],
      ["Read", { file_path: "src/invites/create.ts" }, "…"],
      ["Edit", { file_path: "src/invites/create.ts" }, "ok"],
      ["Write", { file_path: "src/invites/expiry.test.ts" }, "ok"],
      ["Bash", { command: "bun test src/invites" }, "12 pass, 0 fail"],
    ],
    reply: "Found it: `INVITE_TTL` is one hour in milliseconds, not seven days. Fixed it and added a test for expiry. All 12 invite tests pass.",
    after: () => { CHANGES[heroId ?? ""] = [
      { path: "src/invites/create.ts", additions: 2, deletions: 1, untracked: false },
      { path: "src/invites/expiry.test.ts", additions: 38, deletions: 0, untracked: true },
    ]; },
  };
  if (/cookie|v3/i.test(text)) return {
    tools: [["Write", { file_path: "src/auth/token.ts" }, "ok"], ["Bash", { command: "bun test src/auth" }, "22 pass, 0 fail"]],
    reply: "Keeping the cookie path until v3. Step 1 is done: `token.ts` is extracted and all 22 auth tests pass.",
  };
  return {
    tools: [["Bash", { command: "bun test" }, "214 pass, 0 fail"]],
    reply: "Done. The full suite passes.",
  };
}

/** Stream a scripted turn: tool calls, then a typed reply, with workspace status updates. */
export function launchSend(id: string, text: string, emit: Emit, setStatus: (id: string, s: Workspace["status"]) => void, skill?: string) {
  const s = script(`${skill ?? ""} ${text}`, id);
  const at = (ms: number, f: () => void) => setTimeout(f, ms);
  emit(id, skill ? { type: "userMessage", text, skill } : { type: "userMessage", text });
  emit(id, { type: "turnStarted" });
  setStatus(id, "running");
  let t = 400;
  s.tools.forEach(([name, input, output], k) => {
    const tid = `${id}-${Date.now()}-${k}`;
    at(t, () => emit(id, { type: "toolCall", id: tid, name, input }));
    at(t + 450, () => emit(id, { type: "toolResult", id: tid, output, isError: false }));
    t += 700;
  });
  const words = s.reply.split(" ");
  words.forEach((w, i) => at(t + i * 60, () => emit(id, { type: "textDelta", text: (i ? " " : "") + w })));
  const end = t + words.length * 60 + 200;
  at(end, () => {
    s.after?.();
    emit(id, { type: "message", text: s.reply });
    emit(id, { type: "turnCompleted", durationMs: end, costUsd: 0.06, isError: false, error: null });
    setStatus(id, "idle");
  });
}
