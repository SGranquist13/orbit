// Review view state: the queue, the open review (a local workspace or a GitHub PR), file texts and viewed marks.
// Local draft comments live in ./review (useReview, shared with the Code view); GitHub drafts are your pending review on GitHub.
import { create } from "zustand";
import { confirmAction } from "../lib/confirm";
import { codeApi, reviewApi, type FileChange, type LocalReview, type MergeMethod, type NewPrComment, type PrDetail, type PrFileStatus, type ReviewQueueItem, type ReviewVerdict, type Workspace } from "../lib/ipc";
import { useApp } from "./app";
import { useCode } from "./code";
import { ghDraftKey, type ReviewComment } from "./review";

export type ReviewTarget = { kind: "local"; workspaceId: string } | { kind: "gh"; repo: string; number: number };
export const targetKey = (t: ReviewTarget) => (t.kind === "local" ? t.workspaceId : ghDraftKey(t.repo, t.number));

export interface ReviewFile {
  path: string;
  previousPath: string | null;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  viewed: boolean;
}
export interface Opened {
  target: ReviewTarget;
  key: string;
  pr: PrDetail | null;
  local: LocalReview | null;
  files: ReviewFile[];
}
/** Which part of a PR the Files tab shows. Only "all" maps both sides onto GitHub's PR diff. */
export type Range = { kind: "all" } | { kind: "since" } | { kind: "commit"; oid: string };
export interface RangeView {
  range: Range;
  base: string;
  head: string;
  files: ReviewFile[];
  /** Where comments can go: the new side only when the range ends at the PR head, nowhere for an older commit. */
  comment: "new" | "none";
  label: string;
}

/** null text = absent on that side (added/removed) or not displayable. */
export interface Texts {
  old: string | null;
  new: string | null;
  /** Present on a side but binary or too large. */
  unreadable: boolean;
}

const VIEWED = "orbit.review.viewed";
const REVIEWED = "orbit.review.reviewed";
function read<T>(k: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? "null");
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}
function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable: marks stay in memory */
  }
}

/** A local file counts as viewed until its diff stat changes. */
const fileSig = (f: Pick<FileChange, "additions" | "deletions">) => `${f.additions}/${f.deletions}`;
/** The whole local review's state, for "new since your review". */
export const localSig = (files: FileChange[]) =>
  files
    .map((f) => `${f.path}:${fileSig(f)}`)
    .sort()
    .join("|");

function localFiles(local: LocalReview, viewed: Record<string, string>): ReviewFile[] {
  return local.files.map((f) => ({
    path: f.path,
    previousPath: null,
    status: f.untracked ? "added" : "modified",
    additions: f.additions,
    deletions: f.deletions,
    viewed: viewed[f.path] === fileSig(f),
  }));
}

const clean = (e: unknown) => String(e).replace(/^Error:\s*/, "");

interface PrReviewState {
  queue: ReviewQueueItem[] | null;
  queueError: string | null;
  queueLoading: boolean;
  opened: Opened | null;
  loading: boolean;
  error: string | null;
  file: string | null;
  tab: "files" | "conversation";
  layout: "unified" | "split" | null;
  wrap: boolean | null;
  texts: Record<string, Texts>;
  /** Local viewed marks: draft key → path → file signature. */
  localViewed: Record<string, Record<string, string>>;
  /** Local "Mark reviewed": workspace id → localSig at that moment. */
  reviewed: Record<string, string>;
  busy: "submit" | "comment" | "draft" | "checkout" | "merge" | null;
  /** Session overrides of the Settings defaults (null = use the setting). */
  hideWhitespace: boolean | null;
  /** Rendered Markdown / SVG instead of the source diff. */
  preview: boolean;
  range: Range;
  rangeView: RangeView | null;

  loadQueue: () => Promise<void>;
  open: (t: ReviewTarget) => Promise<void>;
  reload: () => Promise<void>;
  close: () => void;
  selectFile: (path: string | null) => void;
  step: (dir: 1 | -1) => void;
  setTab: (tab: "files" | "conversation") => void;
  setLayout: (layout: "unified" | "split") => void;
  setWrap: (wrap: boolean) => void;
  loadTexts: (path: string) => Promise<Texts>;
  setViewed: (path: string, viewed: boolean) => void;
  markReviewed: () => void;
  submit: (event: ReviewVerdict, body: string) => Promise<boolean>;
  postNow: (c: Omit<ReviewComment, "id" | "excerpt">) => Promise<boolean>;
  reply: (commentId: number, body: string) => Promise<boolean>;
  resolve: (threadId: string, resolved: boolean) => Promise<void>;
  converse: (body: string) => Promise<boolean>;
  setHideWhitespace: (v: boolean) => void;
  setPreview: (v: boolean) => void;
  setRange: (r: Range) => Promise<void>;
  /** GitHub-side pending review: add, edit or delete one of your unsubmitted comments. */
  draftAdd: (c: Omit<ReviewComment, "id" | "excerpt">) => Promise<boolean>;
  draftEdit: (id: string, body: string) => Promise<boolean>;
  draftDelete: (id: string) => Promise<boolean>;
  discardPending: () => Promise<boolean>;
  checkout: () => Promise<Workspace | null>;
  merge: (method: MergeMethod, deleteBranch: boolean) => Promise<boolean>;
  ready: () => Promise<boolean>;
  requestReviewers: (add: string[], remove: string[]) => Promise<boolean>;
  /** Opens the file in Orbit's Code view (the workspace's worktree; a PR is checked out first). */
  openInCode: (path: string, line?: number) => Promise<void>;
}

export const textKey = (o: Opened, path: string, rv: RangeView | null = null) =>
  o.pr
    ? `${o.key}@${rv ? `${rv.base}..${rv.head}` : o.pr.headSha}:${path}`
    : `${o.key}@${o.local?.headSha}:${localSig(o.local?.files ?? [])}:${path}`;

/** The commits a range covers: [base, head] shas plus a label; null when the range doesn't apply. */
export function rangeShas(pr: PrDetail, r: Range): { base: string; head: string; label: string } | null {
  if (r.kind === "since") {
    if (!pr.viewerLastReviewSha || pr.viewerLastReviewSha === pr.headSha) return null;
    const i = pr.commits.findIndex((c) => c.oid === pr.viewerLastReviewSha);
    const n = i < 0 ? null : pr.commits.length - 1 - i;
    return { base: pr.viewerLastReviewSha, head: pr.headSha, label: n === null ? "Since your last review" : `Since your last review (${n} commit${n === 1 ? "" : "s"})` };
  }
  if (r.kind === "commit") {
    const c = pr.commits.find((x) => x.oid === r.oid);
    if (!c?.parentOid) return null;
    return { base: c.parentOid, head: c.oid, label: `${c.oid.slice(0, 7)} ${c.message}` };
  }
  return null;
}

export const toNewComment = (c: Pick<ReviewComment, "path" | "side" | "startLine" | "endLine" | "text">): NewPrComment => ({
  path: c.path,
  side: c.side,
  line: c.endLine,
  startLine: c.startLine < c.endLine ? c.startLine : null,
  body: c.text,
});

let openSeq = 0;

export const usePrReview = create<PrReviewState>((set, get) => {
  /** Runs a GitHub write, then refetches the PR so threads and states match the server. */
  const write$ = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      await get().reload();
      return true;
    } catch (e) {
      set({ error: clean(e) });
      return false;
    }
  };

  return {
    queue: null,
    queueError: null,
    queueLoading: false,
    opened: null,
    loading: false,
    error: null,
    file: null,
    tab: "files",
    layout: null,
    wrap: null,
    texts: {},
    localViewed: read(VIEWED, {}),
    reviewed: read(REVIEWED, {}),
    busy: null,
    hideWhitespace: null,
    preview: false,
    range: { kind: "all" },
    rangeView: null,

    loadQueue: async () => {
      if (get().queueLoading) return;
      set({ queueLoading: true });
      try {
        set({ queue: await reviewApi.queue(), queueError: null });
      } catch (e) {
        set({ queueError: clean(e) });
      } finally {
        set({ queueLoading: false });
      }
    },

    open: async (t) => {
      const key = targetKey(t);
      const seq = ++openSeq;
      const same = get().opened?.key === key;
      set({ loading: true, error: null, ...(same ? {} : { opened: null, file: null, tab: "files" as const, range: { kind: "all" } as Range, rangeView: null }) });
      try {
        let opened: Opened;
        if (t.kind === "local") {
          const local = await reviewApi.local(t.workspaceId);
          opened = { target: t, key, pr: null, local, files: localFiles(local, get().localViewed[key] ?? {}) };
          useApp.setState((s) => ({ changes: { ...s.changes, [t.workspaceId]: local.files } }));
        } else {
          const pr = await reviewApi.detail(t.repo, t.number);
          opened = { target: t, key, pr, local: null, files: pr.files.map((f) => ({ ...f })) };
        }
        // A newer open() may have started meanwhile; only the latest wins.
        if (seq !== openSeq) return;
        const file = get().file && opened.files.some((f) => f.path === get().file) ? get().file : (opened.files[0]?.path ?? null);
        set({ opened, file, loading: false });
        // Keep a non-"all" range across reloads (its files are refetched against the new head).
        if (same && get().range.kind !== "all") await get().setRange(get().range);
      } catch (e) {
        if (seq === openSeq) set({ loading: false, error: clean(e) });
      }
    },

    reload: async () => {
      const o = get().opened;
      if (o) await get().open(o.target);
    },

    close: () => set({ opened: null, file: null, error: null }),

    selectFile: (path) => set({ file: path }),

    step: (dir) => {
      const { opened, file } = get();
      if (!opened?.files.length) return;
      const i = opened.files.findIndex((f) => f.path === file);
      if (dir === 1 && file && useApp.getState().settings?.reviewMarkViewedOnNext) get().setViewed(file, true);
      const next = opened.files[Math.min(opened.files.length - 1, Math.max(0, i + dir))];
      set({ file: next.path });
    },

    setTab: (tab) => set({ tab }),
    setLayout: (layout) => set({ layout }),
    setWrap: (wrap) => set({ wrap }),

    loadTexts: async (path) => {
      const o = get().opened;
      if (!o) throw new Error("No review open");
      const rv = get().rangeView;
      const k = textKey(o, path, rv);
      const cached = get().texts[k];
      if (cached) return cached;
      const f = (rv?.files ?? o.files).find((x) => x.path === path);
      if (!f) throw new Error(`${path} is not part of this review`);
      let texts: Texts;
      if (o.pr) {
        const pr = o.pr;
        const [old, neu] = await Promise.all([
          f.status === "added" ? null : reviewApi.file(pr.repo, rv?.base ?? pr.mergeBaseSha, f.previousPath ?? f.path),
          f.status === "removed" ? null : reviewApi.file(pr.repo, rv?.head ?? pr.headSha, f.path),
        ]);
        texts = { old, new: neu, unreadable: (f.status !== "added" && old === null) || (f.status !== "removed" && neu === null) };
      } else {
        const root = o.local!.root;
        const [old, disk] = await Promise.all([
          f.status === "added" ? Promise.resolve(null) : codeApi.fileAt(root, f.path, "base").catch(() => null),
          codeApi.readFile(root, f.path).catch(() => null),
        ]);
        const unreadable = !!disk && (disk.binary || disk.tooLarge);
        texts = { old, new: disk?.text ?? null, unreadable };
      }
      set((s) => ({ texts: { ...s.texts, [k]: texts } }));
      return texts;
    },

    setViewed: (path, viewed) => {
      const o = get().opened;
      if (!o) return;
      const files = o.files.map((f) => (f.path === path ? { ...f, viewed } : f));
      set({ opened: { ...o, files } });
      if (o.pr) {
        reviewApi.viewed(o.pr.id, path, viewed).catch((e) => set({ error: clean(e) }));
        return;
      }
      const f = o.local?.files.find((x) => x.path === path);
      if (!f) return;
      const marks = { ...(get().localViewed[o.key] ?? {}) };
      if (viewed) marks[path] = fileSig(f);
      else delete marks[path];
      const localViewed = { ...get().localViewed, [o.key]: marks };
      write(VIEWED, localViewed);
      set({ localViewed });
    },

    markReviewed: () => {
      const o = get().opened;
      if (!o?.local) return;
      const reviewed = { ...get().reviewed, [o.key]: localSig(o.local.files) };
      write(REVIEWED, reviewed);
      set({ reviewed });
      for (const f of o.files) if (!f.viewed) get().setViewed(f.path, true);
    },

    submit: async (event, body) => {
      const o = get().opened;
      if (!o?.pr) return false;
      const pr = o.pr;
      set({ busy: "submit", error: null });
      try {
        if (pr.pendingReview) await reviewApi.submitPending(pr.repo, pr.number, pr.headSha, pr.pendingReview.id, event, body);
        else await reviewApi.submit(pr.repo, pr.number, pr.headSha, event, body, []);
        await get().reload();
        void get().loadQueue();
        return true;
      } catch (e) {
        set({ error: clean(e) });
        return false;
      } finally {
        set({ busy: null });
      }
    },

    postNow: async (c) => {
      const o = get().opened;
      if (!o?.pr) return false;
      const pr = o.pr;
      set({ busy: "comment" });
      const ok = await write$(() => reviewApi.comment(pr.repo, pr.number, pr.headSha, toNewComment(c)));
      set({ busy: null });
      return ok;
    },

    reply: async (commentId, body) => {
      const pr = get().opened?.pr;
      return !!pr && write$(() => reviewApi.reply(pr.repo, pr.number, commentId, body));
    },

    resolve: async (threadId, resolved) => {
      const o = get().opened;
      if (!o?.pr) return;
      // Optimistic: the card collapses at once; the refetch confirms it.
      set({ opened: { ...o, pr: { ...o.pr, threads: o.pr.threads.map((t) => (t.id === threadId ? { ...t, isResolved: resolved } : t)) } } });
      await write$(() => reviewApi.resolve(threadId, resolved));
    },

    converse: async (body) => {
      const pr = get().opened?.pr;
      return !!pr && write$(() => reviewApi.issueComment(pr.repo, pr.number, body));
    },

    setHideWhitespace: (hideWhitespace) => set({ hideWhitespace }),
    setPreview: (preview) => set({ preview }),

    setRange: async (range) => {
      const pr = get().opened?.pr;
      const shas = pr ? rangeShas(pr, range) : null;
      if (!pr || !shas) return set({ range: { kind: "all" }, rangeView: null });
      set({ range, loading: true });
      try {
        const files = await reviewApi.rangeFiles(pr.repo, shas.base, shas.head);
        const viewed = new Map((get().opened?.files ?? []).map((f) => [f.path, f.viewed]));
        const rangeView: RangeView = {
          range,
          ...shas,
          files: files.map((f) => ({ ...f, viewed: viewed.get(f.path) ?? false })),
          comment: shas.head === pr.headSha ? "new" : "none",
        };
        const file = rangeView.files.some((f) => f.path === get().file) ? get().file : (rangeView.files[0]?.path ?? null);
        set({ rangeView, file, loading: false });
      } catch (e) {
        set({ range: { kind: "all" }, rangeView: null, loading: false, error: clean(e) });
      }
    },

    draftAdd: async (c) => {
      const pr = get().opened?.pr;
      if (!pr) return false;
      set({ busy: "draft" });
      const ok = await write$(() => reviewApi.draftAdd(pr.id, pr.headSha, toNewComment(c)));
      set({ busy: null });
      return ok;
    },
    draftEdit: (id, body) => write$(() => reviewApi.draftEdit(id, body)),
    draftDelete: (id) => write$(() => reviewApi.draftDelete(id)),
    discardPending: async () => {
      const pending = get().opened?.pr?.pendingReview;
      if (!pending) return false;
      const n = pending.comments.length;
      if (!(await confirmAction(`Discard your pending review${n ? ` and its ${n} comment${n === 1 ? "" : "s"}` : ""}? This also removes it on GitHub.`, "Discard"))) return false;
      return write$(() => reviewApi.discardPending(pending.id));
    },

    checkout: async () => {
      const pr = get().opened?.pr;
      if (!pr) return null;
      const existing = pr.workspaceId ? useApp.getState().workspaces.find((w) => w.id === pr.workspaceId) : undefined;
      if (existing) return existing;
      set({ busy: "checkout", error: null });
      try {
        const ws = await reviewApi.checkout(pr.repo, pr.number, null);
        // The backend emits the new workspace (`workspace` event), so the sidebar picks it up on its own.
        await get().reload();
        return ws;
      } catch (e) {
        set({ error: clean(e) });
        return null;
      } finally {
        set({ busy: null });
      }
    },

    merge: async (method, deleteBranch) => {
      const pr = get().opened?.pr;
      if (!pr) return false;
      if (!(await confirmAction(`${method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Merge"} #${pr.number} into ${pr.baseRef}?`, "Merge"))) return false;
      set({ busy: "merge" });
      const ok = await write$(() => reviewApi.merge(pr.repo, pr.number, method, deleteBranch));
      set({ busy: null });
      if (ok) void get().loadQueue();
      return ok;
    },
    ready: async () => {
      const pr = get().opened?.pr;
      return !!pr && write$(() => reviewApi.ready(pr.repo, pr.number));
    },
    requestReviewers: async (add, remove) => {
      const pr = get().opened?.pr;
      return !!pr && write$(() => reviewApi.requestReviewers(pr.repo, pr.number, add, remove));
    },

    openInCode: async (path, line) => {
      const o = get().opened;
      if (!o) return;
      let ws: Workspace | null | undefined = o.local ? useApp.getState().workspaces.find((w) => w.id === o.local!.workspaceId) : null;
      if (o.pr) {
        ws = o.pr.workspaceId ? useApp.getState().workspaces.find((w) => w.id === o.pr!.workspaceId) : null;
        if (!ws) {
          if (!(await confirmAction(`Check out #${o.pr.number} into a new workspace to open it in Code?`, "Check out"))) return;
          ws = await get().checkout();
        }
      }
      if (!ws) return;
      const code = useCode.getState();
      await code.openRoot(ws.path, { workspaceId: ws.id });
      if (line) await code.openFileAt(path, { line, start: 0, end: 0 }, ws.path);
      else await code.openFile(path, { preview: false }, ws.path);
      useApp.getState().setView("code");
    },
  };
});

/** Workspaces with pending changes, for the queue's Local section. */
export function localQueue() {
  const { workspaces, changes } = useApp.getState();
  return workspaces.filter((w) => (changes[w.id]?.length ?? 0) > 0);
}

/** Refreshes every workspace's change list (cheap git calls) so the Local section is current. */
export function refreshLocal() {
  const s = useApp.getState();
  for (const w of s.workspaces) void s.refreshChanges(w.id);
}

export const openPr = async (input: string, repoId: string | null) => {
  try {
    const ref = await reviewApi.parseRef(input, repoId);
    useApp.getState().setView("review");
    await usePrReview.getState().open({ kind: "gh", ...ref });
    return true;
  } catch (e) {
    usePrReview.setState({ error: clean(e) });
    return false;
  }
};

