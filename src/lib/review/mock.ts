// Mock backend for the Review view (pr_review_* / local_review). Browser-only, like ../mock.ts.
import type { LocalReview, NewPrComment, PrDetail, PrFile, PrRef, PrThread, ReviewQueueItem, ReviewVerdict } from "../ipc";

const VIEWER = "you";
const hour = 3_600_000;
const iso = (agoHours: number) => new Date(Date.now() - agoHours * hour).toISOString();
const avatar = (login: string) => (login === "ghost" ? "" : `https://avatars.githubusercontent.com/${login}?s=64`);

const BASE = "mb0000000000000000000000000000000000base";

const sessionOld = `export interface Session {
  token: string;
  user: { id: string; name: string };
  expiresAt: number;
}

const SESSION_KEY = "superset.session";

/** Restore a session from storage. */
export async function restoreSession(): Promise<Session | null> {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  return JSON.parse(raw);
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY);
}
`;
const sessionNew = `import { refresh } from "./refresh";

export interface Session {
  token: string;
  user: { id: string; name: string };
  expiresAt: number;
}

const SESSION_KEY = "superset.session";
const LEEWAY_MS = 30_000;

/** Restore a session only while its token remains valid, refreshing it when it is about to expire. */
export async function restoreSession(): Promise<Session | null> {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  const session: Session = JSON.parse(raw);
  if (session.expiresAt < Date.now()) {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
  if (session.expiresAt - Date.now() < LEEWAY_MS) return refresh(session);
  return session;
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY);
  void fetch("/api/session", { method: "DELETE" });
}
`;
const refreshNew = `import type { Session } from "./session";

/** Exchange a session that is about to expire for a fresh one. */
export async function refresh(session: Session): Promise<Session | null> {
  const res = await fetch("/api/session/refresh", {
    method: "POST",
    headers: { Authorization: \`Bearer \${session.token}\` },
  });
  if (!res.ok) return null;
  return res.json();
}
`;
const tokenOld = `// Legacy token helpers, superseded by session.ts.
export function readToken(): string | null {
  return localStorage.getItem("token");
}
`;
const authDocOld = `# Auth

Sessions last 24 hours.
`;
const authDocNew = `# Authentication

Sessions last 24 hours and refresh automatically in their last 30 seconds.
Signing out also revokes the session on the server.
`;

interface MockPr {
  detail: PrDetail;
  /** text per `${sha}:${path}` */
  blobs: Map<string, string | null>;
  staleOnce?: boolean;
}

function file(path: string, status: PrFile["status"], additions: number, deletions: number, previousPath: string | null = null): PrFile {
  return { path, previousPath, additions, deletions, status, viewed: false };
}

function thread(id: string, path: string, side: "old" | "new", line: number | null, comments: [string, string, number][], extra: Partial<PrThread> = {}): PrThread {
  return {
    id, path, side, line, startLine: null, originalLine: line ?? 9, isResolved: false, isOutdated: line === null, canResolve: true,
    comments: comments.map(([author, body, ago], i) => ({ id: Number(id.replace(/\D/g, "")) * 10 + i, author, avatarUrl: avatar(author), body, createdAt: iso(ago), isMine: author === VIEWER })),
    ...extra,
  };
}

function basePr(repo: string, number: number, title: string, author: string, head: string, files: PrFile[]): PrDetail {
  return {
    id: `PR_${number}`, repo, number, title, body: "", url: `https://github.com/${repo}/pull/${number}`,
    author, authorAvatarUrl: avatar(author), state: "OPEN", isDraft: false, viewerLogin: VIEWER, viewerDidAuthor: author === VIEWER,
    headRef: "", baseRef: "main", headSha: head, mergeBaseSha: BASE, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE",
    checks: { passed: 4, failed: 0, pending: 0, failing: [] }, createdAt: iso(30), updatedAt: iso(2), files, threads: [], reviews: [], comments: [],
  };
}

function seed(): Map<string, MockPr> {
  const prs = new Map<string, MockPr>();
  const head842 = "h842aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const d842 = basePr("acme/superset", 842, "Refresh sessions before they expire and revoke on sign-out", "dana", head842, [
    file("src/auth/session.ts", "modified", 8, 1),
    file("src/auth/refresh.ts", "added", 11, 0),
    file("docs/AUTH.md", "renamed", 3, 2, "docs/auth.md"),
    file("src/legacy/token.ts", "removed", 0, 4),
    file("assets/logo.png", "modified", 0, 0),
  ]);
  d842.headRef = "dana/session-refresh";
  d842.body = "Sessions now refresh in their last 30 seconds instead of silently expiring mid-request.\n\n- `restoreSession` refreshes inside a leeway window\n- `signOut` revokes the session on the server\n- removes the unused legacy token helpers\n\nCloses #811.";
  d842.checks = { passed: 3, failed: 0, pending: 1, failing: [] };
  d842.threads = [
    thread("T1", "src/auth/session.ts", "new", 13, [["mira", "Should `LEEWAY_MS` come from config? Mobile clients have slower refreshes.", 20], ["dana", "Good call, but I'd keep it a constant until we have a second caller.", 18]]),
    thread("T2", "src/auth/session.ts", "new", 27, [["mira", "This fire-and-forget `fetch` swallows errors. Is that intended?", 19]]),
    thread("T3", "src/auth/refresh.ts", "new", 8, [["mira", "Nit: return `null` on network errors too.", 21], ["dana", "Done.", 17]], { isResolved: true }),
    thread("T4", "src/auth/session.ts", "new", null, [["ghost", "This used to log the session.", 40]]),
    thread("T5", "src/auth/session.ts", "old", 13, [["mira", "Was there a reason this never validated `expiresAt`?", 22]], { startLine: 11 }),
  ];
  d842.reviews = [
    { id: "R1", author: "mira", avatarUrl: avatar("mira"), state: "COMMENTED", body: "Looks close. A couple of questions inline.", submittedAt: iso(19) },
  ];
  d842.comments = [
    { id: 9001, author: "dana", avatarUrl: avatar("dana"), body: "@you could you take a look when you have a minute? This unblocks the mobile release.", createdAt: iso(16) },
  ];
  const b842 = new Map<string, string | null>([
    [`${BASE}:src/auth/session.ts`, sessionOld],
    [`${head842}:src/auth/session.ts`, sessionNew],
    [`${head842}:src/auth/refresh.ts`, refreshNew],
    [`${BASE}:docs/auth.md`, authDocOld],
    [`${head842}:docs/AUTH.md`, authDocNew],
    [`${BASE}:src/legacy/token.ts`, tokenOld],
    [`${BASE}:assets/logo.png`, null],
    [`${head842}:assets/logo.png`, null],
  ]);
  prs.set("acme/superset#842", { detail: d842, blobs: b842 });

  const head839 = "h839bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const d839 = basePr("acme/superset", 839, "Docs: explain the session lifetime", VIEWER, head839, [file("README.md", "modified", 1, 1)]);
  d839.headRef = "you/docs-sessions";
  d839.body = "Small README fix.";
  d839.reviewDecision = "";
  prs.set("acme/superset#839", {
    detail: d839,
    blobs: new Map([
      [`${BASE}:README.md`, "# Superset\n\n## Authentication\n\nSessions expire after 12 hours.\n"],
      [`${head839}:README.md`, "# Superset\n\n## Authentication\n\nSessions expire after 24 hours.\n"],
    ]),
  });

  // A large PR: 40 generated files, and its head moves once on submit (exercises the stale path).
  const head845 = "h845cccccccccccccccccccccccccccccccccccc";
  const big = Array.from({ length: 40 }, (_, i) => `packages/icons/src/icon-${String(i + 1).padStart(2, "0")}.ts`);
  const d845 = basePr("acme/design-system", 845, "Generate icon components from the SVG sources", "lee", head845, big.map((p) => file(p, "modified", 6, 3)));
  d845.headRef = "lee/icons-codegen";
  d845.body = "Regenerated with `bun run icons`. No hand edits.";
  d845.checks = { passed: 2, failed: 1, pending: 0, failing: ["visual-regression"] };
  const b845 = new Map<string, string | null>();
  big.forEach((p, i) => {
    const name = `Icon${i + 1}`;
    b845.set(`${BASE}:${p}`, `// generated\nexport const ${name} = {\n  size: 24,\n  path: "M0 0h24v24H0z",\n  viewBox: "0 0 24 24",\n};\n`);
    b845.set(`${head845}:${p}`, `// generated by scripts/icons.ts, do not edit\nimport { icon } from "../icon";\n\nexport const ${name} = icon({\n  size: 24,\n  path: "M${i} 0h24v24H${i}z",\n  viewBox: "0 0 24 24",\n  title: "${name}",\n});\n`);
  });
  prs.set("acme/design-system#845", { detail: d845, blobs: b845, staleOnce: true });
  return prs;
}

const prs = seed();
const queue: ReviewQueueItem[] = [
  { repo: "acme/superset", number: 842, title: prs.get("acme/superset#842")!.detail.title, url: "https://github.com/acme/superset/pull/842", author: "dana", updatedAt: iso(2), isDraft: false, reviewDecision: "REVIEW_REQUIRED", sources: ["requested", "involves"] },
  { repo: "acme/design-system", number: 845, title: prs.get("acme/design-system#845")!.detail.title, url: "https://github.com/acme/design-system/pull/845", author: "lee", updatedAt: iso(5), isDraft: false, reviewDecision: "REVIEW_REQUIRED", sources: ["requested"] },
  { repo: "acme/superset", number: 839, title: prs.get("acme/superset#839")!.detail.title, url: "https://github.com/acme/superset/pull/839", author: VIEWER, updatedAt: iso(9), isDraft: false, reviewDecision: "", sources: ["mine"] },
  { repo: "acme/superset", number: 828, title: "WIP: move auth to a worker", url: "https://github.com/acme/superset/pull/828", author: VIEWER, updatedAt: iso(70), isDraft: true, reviewDecision: "", sources: ["mine"] },
];

let nextId = 100;
const key = (repo: string, number: number) => `${repo}#${number}`;
const get = (repo: string, number: number) => {
  const pr = prs.get(key(repo, number));
  if (!pr) throw "Repository or PR not found (or you don't have access)";
  return pr;
};
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function addThread(pr: MockPr, c: NewPrComment) {
  const id = ++nextId;
  pr.detail.threads.push({
    id: `T${id}`, path: c.path, side: c.side, line: c.line, startLine: c.startLine, originalLine: c.line, isResolved: false, isOutdated: false, canResolve: true,
    comments: [{ id, author: VIEWER, avatarUrl: "", body: c.body, createdAt: new Date().toISOString(), isMine: true }],
  });
}

export function parseRefMock(input: string, defaultRepo: string | null): PrRef {
  const s = input.trim();
  const url = s.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (url) return { repo: url[1], number: Number(url[2]) };
  const full = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (full) return { repo: full[1], number: Number(full[2]) };
  const bare = s.match(/^#?(\d+)$/);
  if (bare) {
    if (!defaultRepo) throw `Pick a repository for #${bare[1]}`;
    return { repo: defaultRepo, number: Number(bare[1]) };
  }
  throw "Not a PR link or number";
}

export async function mockReviewCommand(cmd: string, args: unknown, workspacePath: (id: string) => string | null): Promise<unknown> {
  const a = (args ?? {}) as {
    repo: string; number: number; sha: string; path: string; input: string; repoId: string | null; commitId: string; event: ReviewVerdict;
    body: string; comments: NewPrComment[]; comment: NewPrComment; commentId: number; threadId: string; resolved: boolean; prId: string; viewed: boolean; workspaceId: string;
  };
  switch (cmd) {
    case "pr_review_queue":
      await wait(400);
      return clone(queue);
    case "pr_review_parse_ref":
      return parseRefMock(a.input, a.repoId === "r1" ? "acme/superset" : null);
    case "pr_review_detail":
      await wait(300);
      return clone(get(a.repo, a.number).detail);
    case "pr_review_file": {
      await wait(80);
      const pr = [...prs.values()].find((p) => p.detail.repo === a.repo && p.blobs.has(`${a.sha}:${a.path}`));
      return pr?.blobs.get(`${a.sha}:${a.path}`) ?? null;
    }
    case "pr_review_submit": {
      await wait(500);
      const pr = get(a.repo, a.number);
      if (pr.staleOnce) {
        pr.staleOnce = false;
        throw "stale: the PR changed since you loaded it; reload to review the new commits";
      }
      if (a.event !== "APPROVE" && !a.body.trim() && !a.comments.length) throw "Write a summary or add a comment first";
      if (a.event !== "COMMENT" && pr.detail.viewerDidAuthor) throw "You can't approve or request changes on your own pull request";
      for (const c of a.comments) addThread(pr, c);
      pr.detail.reviews.push({
        id: `R${++nextId}`, author: VIEWER, avatarUrl: "", body: a.body, submittedAt: new Date().toISOString(),
        state: a.event === "APPROVE" ? "APPROVED" : a.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
      });
      if (a.event === "APPROVE") pr.detail.reviewDecision = "APPROVED";
      if (a.event === "REQUEST_CHANGES") pr.detail.reviewDecision = "CHANGES_REQUESTED";
      return null;
    }
    case "pr_review_comment":
      await wait();
      addThread(get(a.repo, a.number), a.comment);
      return null;
    case "pr_review_reply": {
      await wait();
      const t = get(a.repo, a.number).detail.threads.find((x) => x.comments.some((c) => c.id === a.commentId));
      if (!t) throw "Comment not found";
      t.comments.push({ id: ++nextId, author: VIEWER, avatarUrl: "", body: a.body, createdAt: new Date().toISOString(), isMine: true });
      return null;
    }
    case "pr_review_resolve": {
      await wait(150);
      for (const pr of prs.values()) for (const t of pr.detail.threads) if (t.id === a.threadId) t.isResolved = a.resolved;
      return null;
    }
    case "pr_review_viewed": {
      for (const pr of prs.values()) if (pr.detail.id === a.prId) for (const f of pr.detail.files) if (f.path === a.path) f.viewed = a.viewed;
      return null;
    }
    case "pr_review_issue_comment": {
      await wait();
      get(a.repo, a.number).detail.comments.push({ id: ++nextId, author: VIEWER, avatarUrl: "", body: a.body, createdAt: new Date().toISOString() });
      return null;
    }
    case "local_review": {
      const root = workspacePath(a.workspaceId);
      if (!root) throw "Workspace not found";
      // Matches the code mock's seeded HEAD/base revisions (src/lib/code/mock.ts).
      const review: LocalReview = {
        workspaceId: a.workspaceId, root, baseSha: "base0001", headSha: "head0001", dirty: true,
        files: [
          { path: "README.md", additions: 3, deletions: 3, untracked: false },
          { path: "src/main.ts", additions: 1, deletions: 2, untracked: false },
          { path: "src/components/Login.tsx", additions: 13, deletions: 0, untracked: true },
        ],
      };
      return review;
    }
  }
  return null;
}
