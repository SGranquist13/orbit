// Review view state: the queue, the open review (a local workspace or a GitHub PR), file texts and viewed marks.
// Draft comments live in ./review (useReview), keyed by workspace id or ghDraftKey, so the Code view shares local drafts.
import { create } from "zustand";
import { codeApi, reviewApi, type FileChange, type LocalReview, type NewPrComment, type PrDetail, type PrFileStatus, type ReviewQueueItem, type ReviewVerdict } from "../lib/ipc";
import { useApp } from "./app";
import { ghDraftKey, useReview, type ReviewComment } from "./review";

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
  busy: "submit" | "comment" | null;

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
}

export const textKey = (o: Opened, path: string) =>
  o.pr ? `${o.key}@${o.pr.headSha}:${path}` : `${o.key}@${o.local?.headSha}:${localSig(o.local?.files ?? [])}:${path}`;

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
      set({ loading: true, error: null, ...(same ? {} : { opened: null, file: null, tab: "files" as const }) });
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
      const k = textKey(o, path);
      const cached = get().texts[k];
      if (cached) return cached;
      const f = o.files.find((x) => x.path === path);
      if (!f) throw new Error(`${path} is not part of this review`);
      let texts: Texts;
      if (o.pr) {
        const pr = o.pr;
        const [old, neu] = await Promise.all([
          f.status === "added" ? null : reviewApi.file(pr.repo, pr.mergeBaseSha, f.previousPath ?? f.path),
          f.status === "removed" ? null : reviewApi.file(pr.repo, pr.headSha, f.path),
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
      const drafts = useReview.getState().drafts[o.key] ?? [];
      set({ busy: "submit", error: null });
      try {
        await reviewApi.submit(o.pr.repo, o.pr.number, o.pr.headSha, event, body, drafts.map(toNewComment));
        useReview.getState().clear(o.key);
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

