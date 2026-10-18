// The director: puts Orbit's real zustand store (and the mocked backend answers) into the exact state for time t.
// Everything here is a pure function of t; nothing reads the wall clock.
import { api, type Summary, type PlanView, type PrStatus, type StoredEvent, type TeammateMessage, type TeammateTask, type TeammateView, type Workspace } from "../src/lib/ipc";
import { useApp } from "../src/stores/app";
import { clamp, lerp, prog, easeInOut, type Aspect } from "./lib";
import { launchSuggestions } from "../src/lib/mock-launch";
import { T } from "./timeline";
import { CLICKS } from "./fx";

/** IPC answers the director controls (installed in main.tsx). Return undefined to fall through to the mock. */
export const overrides: Record<string, (args: Record<string, unknown>) => unknown> = {};

interface Base {
  workspaces: Workspace[];
  w1: StoredEvent[];
  teammates: TeammateView[];
  summaries: Record<string, Summary>;
  loadNow: number;
}
let base: Base;

// ---------------------------------------------------------------- transcript helpers

let seqN = 5000;
const ev = (event: StoredEvent["event"]): StoredEvent => ({ seq: ++seqN, ts: 1_760_000_000_000 + seqN * 1000, event });
const tool = (id: string, name: string, input: unknown, output: string, isError = false): StoredEvent[] => [
  ev({ type: "toolCall", id, name, input }),
  ev({ type: "toolResult", id, output, isError }),
];

interface Step {
  at: number;
  /** For message events: seconds to type it out. */
  dur?: number;
  events: StoredEvent[];
}

/** What a streamed transcript looks like at time t: finished events, the text being typed, and whether the turn is live. */
function streamAt(steps: Step[], t: number) {
  const events: StoredEvent[] = [];
  let live = "";
  let running = false;
  for (const s of steps) {
    if (t < s.at) break;
    const typed = s.events.length === 1 && s.events[0].event.type === "message" && s.dur;
    if (typed && t < s.at + s.dur!) {
      const text = (s.events[0].event as { text: string }).text;
      live = text.slice(0, Math.round(text.length * easeInOut(prog(t, s.at, s.at + s.dur!)) ** 1));
      running = true;
      break;
    }
    events.push(...s.events);
  }
  return { events, live, running };
}

// ---------------------------------------------------------------- scripts

const REVEAL_ORDER = ["w2", "w4", "w6", "w1", "w5", "w8", "w3", "w7"];

function w1Steps(): Step[] {
  const b = base.w1;
  const msg = (e: StoredEvent) => (e.event as { text: string }).text;
  void msg;
  return [
    { at: T.fleet + 0.25, events: [b[0]] },
    { at: T.fleet + 0.9, dur: 0.7, events: [b[1]] },
    { at: T.fleet + 1.8, events: [b[2], b[3]] },
    { at: T.fleet + 2.3, events: [b[4], b[5]] },
    { at: T.fleet + 2.8, events: [b[6], b[7]] },
    { at: T.fleet + 3.4, dur: 2.2, events: [b[8]] },
    { at: T.fleet + 5.7, events: [b[9], b[10], b[11], b[12]] },
  ];
}

const SHIP_AT = {
  fixClick: CLICKS.fixCi, tools: T.ship + 1.8, checksPending: T.ship + 2.6, reply: T.ship + 3.1, green: T.ship + 3.5,
  ready: CLICKS.ready + 0.1, merged: CLICKS.merge + 0.1, archive: CLICKS.merge + 1.4,
};

function shipTranscript(t: number) {
  const b = base.w1;
  const pre: StoredEvent[] = [
    ...b.slice(0, 13),
    b[13],
    ...tool("s1", "Bash", { command: "git push -u origin HEAD" }, "branch fix/onboarding-empty-org set up to track origin"),
    ...tool("s2", "Bash", { command: "gh pr create --draft --fill" }, "https://github.com/acme/relay/pull/827"),
    ev({ type: "message", text: "Draft PR #827 is open. One check is red: test (ubuntu)." }),
    ev({ type: "turnCompleted", durationMs: 41000, costUsd: 0.05, isError: false, error: null }),
  ];
  const fix: Step[] = [
    { at: SHIP_AT.fixClick, events: [ev({ type: "userMessage", text: "", skill: "shipkit:fix-ci" })] },
    { at: SHIP_AT.tools, events: tool("f1", "Bash", { command: "gh run view --log-failed" }, "submit.test.ts: expected \"\" to be \"org-3f9a\"") },
    { at: SHIP_AT.tools + 0.55, events: tool("f2", "Edit", { file_path: "src/onboarding/submit.test.ts" }, "ok") },
    { at: SHIP_AT.tools + 1.1, events: tool("f3", "Bash", { command: "bun test src/onboarding && git push" }, "7 pass, 0 fail") },
    { at: SHIP_AT.reply, dur: 1.2, events: [ev({ type: "message", text: "The test still expected the old slug for an empty name. Updated it to the generated fallback and pushed. All 7 checks pass." })] },
    { at: SHIP_AT.reply + 1.3, events: [ev({ type: "turnCompleted", durationMs: 52000, costUsd: 0.04, isError: false, error: null })] },
  ];
  const s = streamAt(fix, t);
  return { events: [...pre, ...s.events], live: s.live, running: s.running || (t >= SHIP_AT.fixClick && t < SHIP_AT.reply + 1.3) };
}

function w1Pr(t: number): PrStatus {
  const pr: PrStatus = {
    number: 827, title: "fix(onboarding): handle empty org name", url: "https://github.com/acme/relay/pull/827", state: "OPEN",
    isDraft: true, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
    checks: { passed: 6, failed: 1, pending: 0, failing: ["test (ubuntu)"] },
  };
  if (t >= SHIP_AT.checksPending) pr.checks = { passed: 6, failed: 0, pending: 1, failing: [] };
  if (t >= SHIP_AT.green) pr.checks = { passed: 7, failed: 0, pending: 0, failing: [] };
  if (t >= SHIP_AT.ready) pr.isDraft = false;
  if (t >= SHIP_AT.merged) pr.state = "MERGED";
  return pr;
}

// ---- teammates (scene 7)

const TM = { type: T.teammates + 0.4, typeDur: 1.2, send: T.teammates + 1.8, plan: T.teammates + 2.4, start: CLICKS.startAll, builderDone: CLICKS.startAll + 2 };
const REQUEST = "Add CSV export with tests";

function chiefPlan(t: number): PlanView | null {
  if (t < TM.send) return null;
  const parts = [
    { teammate: "planner", title: "Plan the export", brief: "Find where billing history is built and plan a streaming CSV export. Change nothing.", dependsOn: [] as number[], taskId: null, failed: null },
    { teammate: "builder", title: "Implement it, with tests", brief: "Implement the plan: a streamed CSV export of billing history, with tests. Open a draft PR.", dependsOn: [0], taskId: null, failed: null },
    { teammate: "reviewer", title: "Review the result", brief: "Review the branch for correctness and missing tests.", dependsOn: [1], taskId: null, failed: null },
  ];
  const status: PlanView["status"] = t < TM.plan ? "planning" : t < TM.start ? "proposed" : t < TM.builderDone + 1.4 ? "running" : "running";
  const plannerDone = TM.start + 0.8, builderDone = TM.start + 1.6, reviewerDone = TM.start + 2.4;
  const state = (i: number) => {
    if (status === "planning" || status === "proposed") return "pending" as const;
    const [s, e] = [[TM.start, plannerDone], [plannerDone, builderDone], [builderDone, reviewerDone]][i];
    return t < s ? ("pending" as const) : t < e ? ("running" as const) : ("done" as const);
  };
  const wsOf = ["w9", "w10", "w11"];
  const summ = ["Plan ready: stream rows in pages, add the route, test the edge cases.", "Done. Streamed export with 6 tests; draft PR #832.", "No findings. Tests cover empty history and large accounts."];
  const views = parts.map((p, i) => {
    const st = state(i);
    return { ...p, state: st, summary: st === "done" ? summ[i] : null, workspaceId: st === "pending" ? null : wsOf[i] };
  });
  const allDone = views.every((v) => v.state === "done");
  return {
    id: "vplan", slug: "chief", repoId: "r1", request: REQUEST, status: allDone ? "done" : status,
    summary: "Planner scopes it, Builder implements the export with tests, then Reviewer checks the branch.",
    createdAt: 0, parts, views: status === "planning" ? [] : views,
  };
}

function chiefThread(t: number): TeammateMessage[] {
  const m = (id: string, p: Partial<TeammateMessage>): TeammateMessage => ({ id, slug: "chief", ts: 1_760_000_000_000 + Number(id.slice(2)), role: "teammate", text: "", workspaceId: null, kind: "message", status: null, files: null, meta: null, ...p });
  const out: TeammateMessage[] = [];
  if (t >= TM.send) out.push(m("vm1", { role: "user", text: REQUEST }));
  if (t >= TM.send + 0.15) out.push(m("vm2", { kind: "plan", text: `Plan: ${REQUEST}`, meta: "vplan" }));
  return out;
}

function chiefTasks(t: number): TeammateTask[] {
  void t;
  return [];
}

function teammateList(t: number): TeammateView[] {
  const plan = chiefPlan(t);
  const work = (slug: string) => {
    if (!plan) return false;
    const i = ["planner", "builder", "reviewer"].indexOf(slug);
    return i >= 0 && plan.views[i]?.state === "running";
  };
  return base.teammates.map((x) => {
    if (x.slug === "chief") {
      const status = !plan ? "idle" : plan.status === "planning" ? "working" : plan.status === "proposed" ? "needsYou" : plan.status === "done" ? "idle" : "working";
      return { ...x, status, unseen: false, lastMessage: t >= TM.send ? chiefThread(t).slice(-1)[0] : null } as TeammateView;
    }
    return { ...x, status: work(x.slug) ? "working" : "idle", unseen: false, openTasks: 0 } as TeammateView;
  });
}

// ---------------------------------------------------------------- main entry

let lastSelected: string | null | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const set = (p: any) => useApp.setState(p);

export async function prepareDirector(_aspect: Aspect) {
  // The app lazy-loads heavy views; load them up front so a seek never lands on a Suspense fallback.
  await Promise.all([import("../src/components/Inbox"), import("../src/components/Teammates"), import("../src/components/TeammateExtras"), import("../src/components/Issues")]);
  await useApp.getState().init();
  await new Promise((r) => setTimeout(r, 300));
  const s = useApp.getState();
  base = {
    workspaces: JSON.parse(JSON.stringify(s.workspaces)),
    w1: await api.loadEvents("w1"),
    teammates: JSON.parse(JSON.stringify(await api.listTeammates())),
    summaries: JSON.parse(JSON.stringify(s.summaries)),
    loadNow: Date.now(),
  };
  const loadNow = Date.now();
  Date.now = () => loadNow + curT * 1000;
  overrides.suggest_prompts = (a) => launchSuggestions(String(a.id));
  overrides.load_events = (a) => (a.id === "w1" ? undefined : undefined);
  overrides.pr_status = (a) => (a.id === "w1" ? w1Pr(clock()) : undefined);
  overrides.list_teammates = () => teammateList(clock());
  overrides.teammate_thread = (a) => (a.slug === "chief" ? chiefThread(clock()) : undefined);
  overrides.teammate_tasks = (a) => (a.slug === "chief" ? chiefTasks(clock()) : undefined);
  overrides.teammate_plans = (a) => (a.slug === "chief" ? [chiefPlan(clock())].filter(Boolean) : undefined);
}

let curT = 0;
const clock = () => curT;

export async function direct(t: number, _aspect: Aspect) {
  curT = t;
  const st = useApp.getState();
  const wanted = viewFor(t);

  // Selection first (it kicks off async loads), then state that must win over them.
  if (wanted.selectedId !== lastSelected) {
    lastSelected = wanted.selectedId;
    if (wanted.selectedId) st.select(wanted.selectedId);
    else set({ selectedId: null });
  }

  const patch: Partial<ReturnType<typeof useApp.getState>> = {
    view: wanted.view,
    shipOpen: wanted.shipOpen,
    simplifyOpen: false,
    sidebarCollapsed: false,
    focusMode: false,
    paletteOpen: false,
    selectedId: wanted.selectedId,
    error: null,
  };
  if (wanted.workspaces) patch.workspaces = wanted.workspaces;
  if (wanted.transcripts) patch.transcripts = { ...useApp.getState().transcripts, ...wanted.transcripts };
  if (wanted.live) patch.live = { ...wanted.live };
  if (wanted.prs) patch.prs = { ...useApp.getState().prs, ...wanted.prs };
  if (wanted.summaries) patch.summaries = wanted.summaries;
  if (wanted.teammates) patch.teammates = wanted.teammates;
  if (wanted.selectedTeammate) patch.selectedTeammate = wanted.selectedTeammate;
  set(patch);
  if (wanted.view === "teammate") set((s) => ({ teammatesTick: s.teammatesTick + 1 }));
}

interface View {
  view: "workspace" | "inbox" | "teammate";
  selectedId: string | null;
  shipOpen: boolean;
  workspaces?: Workspace[];
  transcripts?: Record<string, StoredEvent[]>;
  live?: Record<string, string>;
  prs?: Record<string, PrStatus | null>;
  teammates?: TeammateView[];
  summaries?: Record<string, Summary>;
  selectedTeammate?: string;
}

function viewFor(t: number): View {
  const ws = base.workspaces;
  // Scene 3: rows appear one by one, grouped by repo.
  if (t < T.fleet) {
    const n = Math.round(prog(t, 10.0, 12.9) * REVEAL_ORDER.length);
    const shown = REVEAL_ORDER.slice(0, n);
    return { view: "workspace", selectedId: "w2", shipOpen: false, workspaces: ws.filter((w) => shown.includes(w.id)).sort((a, b) => a.repoId.localeCompare(b.repoId)) };
  }
  // Scene 4: the fleet; w1 streams a fix.
  if (t < T.inbox) {
    const s = streamAt(w1Steps(), t);
    const workspaces = ws.map((w) => (w.id === "w1" ? { ...w, status: (s.running || (t > T.fleet + 0.2 && t < T.fleet + 5.7) ? "running" : "idle") as Workspace["status"] } : w));
    return { view: "workspace", selectedId: "w1", shipOpen: false, workspaces, transcripts: { w1: s.events }, live: { w1: s.live } };
  }
  // Scene 5: the inbox.
  if (t < T.ship) {
    // Order: the question first, then the finished one. Each leaves once its suggested reply is sent.
    const ago = (m: number) => base.loadNow - m * 60_000;
    const summaries = { ...base.summaries };
    for (const [id, m] of [["w3", 0.5], ["w2", 1.5], ["w1", 2]] as const) summaries[id] = { ...summaries[id], lastActivityTs: ago(m) };
    const sent = (id: string) => (id === "w3" ? t >= CLICKS.inboxKey1 + 0.75 : id === "w2" ? t >= CLICKS.inboxKey2 + 0.75 : false);
    const workspaces = ws.map((w) => (sent(w.id) ? { ...w, status: "running" as Workspace["status"] } : w));
    return { view: "inbox", selectedId: "w1", shipOpen: false, workspaces, summaries, teammates: teammateList(0).map((x) => ({ ...x, status: "idle" as const, unseen: false })) };
  }
  // Scene 6: the Ship panel.
  if (t < T.teammates) {
    const s = shipTranscript(t);
    const archived = t >= SHIP_AT.archive;
    const workspaces = ws
      .filter((w) => !(archived && w.id === "w1"))
      .map((w) => (w.id === "w1" ? { ...w, status: (s.running ? "running" : "idle") as Workspace["status"] } : w));
    return {
      view: "workspace", selectedId: archived ? "w7" : "w1", shipOpen: true, workspaces,
      transcripts: { w1: s.events }, live: { w1: s.live }, prs: { w1: w1Pr(t) },
    };
  }
  // Scene 7: teammates.
  return { view: "teammate", selectedId: "w7", shipOpen: false, workspaces: ws, teammates: teammateList(t), selectedTeammate: "chief" };
}

// ---------------------------------------------------------------- camera

export interface Frame {
  /** The product window in stage pixels. */
  win: { x: number; y: number; w: number; h: number };
  /** The app's virtual (unscaled) size. */
  virt: { w: number; h: number };
}

export const frameFor = (aspect: Aspect): Frame =>
  aspect === "4x5"
    ? { win: { x: 36, y: 396, w: 1008, h: 918 }, virt: { w: 1000, h: 900 } }
    : { win: { x: 60, y: 36, w: 1800, h: 818 }, virt: { w: 1500, h: 680 } };

export interface Cam {
  fx: number;
  fy: number;
  s: number;
}

const mix = (a: Cam, b: Cam, x: number): Cam => ({ fx: lerp(a.fx, b.fx, x), fy: lerp(a.fy, b.fy, x), s: lerp(a.s, b.s, x) });

/** Camera keyframes per scene, in virtual app coordinates (focus point) and scale. Always clamped inside the app. */
export function cameraAt(t: number, aspect: Aspect): Cam {
  const f = frameFor(aspect);
  const raw = rawCamera(t, aspect, f);
  const hw = f.win.w / raw.s / 2, hh = f.win.h / raw.s / 2;
  return { s: raw.s, fx: clamp(raw.fx, hw, f.virt.w - hw), fy: clamp(raw.fy, hh, f.virt.h - hh) };
}

function rawCamera(t: number, aspect: Aspect, f: Frame): Cam {
  const overview: Cam = { fx: f.virt.w / 2, fy: f.virt.h / 2, s: f.win.w / f.virt.w };
  const k = (fx: number, fy: number, s: number): Cam => ({ fx, fy, s });
  const e = (a: number, b: number) => easeInOut(prog(t, a, b));
  const push = (a: Cam, b: Cam, t0: number, t1: number) => mix(a, b, e(t0, t1));
  if (aspect === "4x5") {
    const side = k(240, 300, 1.55), chat = k(560, 330, 1.4), inbox = k(620, 300, 1.12), ship = k(700, 380, 1.4), team = k(560, 330, 1.3);
    if (t < T.fleet) return push(overview, side, 9.6, 12.5);
    if (t < T.inbox) return push(side, chat, T.fleet, T.fleet + 1.4);
    if (t < T.ship) return push(chat, inbox, T.inbox - 0.3, T.inbox + 0.6);
    if (t < T.teammates) return push(inbox, ship, T.ship - 0.3, T.ship + 0.8);
    return push(ship, team, T.teammates - 0.3, T.teammates + 0.8);
  }
  const o = overview.s;
  if (t < T.fleet) return push(overview, k(560, 330, o * 1.12), 9.8, 13.9);
  if (t < T.inbox) return push(k(560, 330, o * 1.12), k(640, 330, o * 1.2), T.fleet, T.inbox);
  if (t < T.ship) return push(overview, k(750, 300, o * 1.1), T.inbox, T.ship);
  if (t < T.teammates) return push(overview, k(900, 340, o * 1.2), T.ship, T.ship + 1.2);
  return push(overview, k(750, 340, o * 1.08), T.teammates, T.teammates + 5);
}
