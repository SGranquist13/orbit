import { create } from "zustand";
import { codeApi, codeEvents, events, CONFLICT_PREFIX, type DirEntry, type AgentEventPayload } from "../lib/ipc";
import { createEditTracker, samePath } from "../lib/code/agentEdits";
import { agentChanges, type LineRange } from "../lib/code/agentMarks";
import { draftProjection, draftLineCount, makeReplay, type TypingProjection } from "../lib/code/liveTyping";
import { confirmAction } from "../lib/confirm";
import { useApp } from "./app";

export interface Tab {
  rel: string;
  preview: boolean;
}
export interface CodeRoot {
  path: string;
  label: string;
  workspaceId: string | null;
  mode: "watch" | "manual";
  /** The user picked the mode themselves; agent turns no longer switch it to Watch. */
  modePinned?: boolean;
  closedTabs?: Tab[];
  tabs: Tab[];
  activeRel: string | null;
  expanded: string[];
}
export interface Buffer {
  userVersion?: number;
  changedBy?: string;
  text: string;
  savedText: string;
  mtime: number;
  dirty: boolean;
  binary: boolean;
  tooLarge: boolean;
  loading: boolean;
  diskChanged: boolean;
  overwrite?: boolean;
  error?: string;
}
export const bufferKey = (root: string, rel: string) => `${root}|${rel}`;
const error = (e: unknown) => useApp.getState().setError(String(e));
const emptyBuffer: Buffer = {
  text: "",
  savedText: "",
  mtime: 0,
  dirty: false,
  binary: false,
  tooLarge: false,
  loading: true,
  diskChanged: false,
};
interface Persisted {
  roots: CodeRoot[];
  activeRoot: string | null;
  recent: string[];
  explorerWidth: number;
  activityWidth: number;
  bottomHeight: number;
  bottomOpen: boolean;
}
function restore(): Persisted {
  const fallback: Persisted = {
    roots: [],
    activeRoot: null,
    recent: [],
    explorerWidth: 248,
    activityWidth: 280,
    bottomHeight: 220,
    bottomOpen: false,
  };
  try {
    const p = JSON.parse(localStorage.getItem("orbit.code") ?? "null");
    if (!p || !Array.isArray(p.roots)) return fallback;
    return {
      ...fallback,
      ...p,
      roots: p.roots
        .filter((r: CodeRoot) => typeof r.path === "string" && Array.isArray(r.tabs) && Array.isArray(r.expanded))
        .map((r: CodeRoot) => ({ ...r, mode: r.mode ?? "manual" })),
    };
  } catch {
    return fallback;
  }
}
export interface CodeTerminal {
  id: string;
  title: string;
  root: string;
  exited: boolean;
}
export interface FileTarget {
  line: number;
  start: number;
  end: number;
}
export interface LivePreview extends TypingProjection {
  toolId: string;
  workspaceId: string;
  replay?: boolean;
  virtual?: boolean;
}
export interface AgentActivity {
  writing?: boolean;
  removed?: boolean;
  id: string;
  ts: number;
  root: string;
  workspaceId: string;
  turn: number;
  rel: string;
  phase: "editing" | "done" | "failed";
  additions: number;
  deletions: number;
}
export interface AgentTurn {
  number: number;
  running: boolean;
  userVersions: Record<string, number>;
}
export const baselineKey = (entry: Pick<AgentActivity, "root" | "workspaceId" | "turn" | "rel">) =>
  `${entry.workspaceId}|${entry.turn}|${bufferKey(entry.root, entry.rel)}`;
interface CodeState extends Persisted {
  explorerHidden: boolean;
  explorerFocus: number;
  cycleTab: (direction: number) => void;
  reopenTab: () => Promise<void>;
  closeAllTabs: () => Promise<void>;
  activity: AgentActivity[];
  previews: Record<string, LivePreview>;
  turns: Record<string, AgentTurn>;
  agentMessages: Record<string, string>;
  baselines: Record<string, string>;
  agentDiff: AgentActivity | null;
  marks: Record<string, { ranges: LineRange[]; nonce: number }>;
  markEpoch: number;
  /** A user choice (pins the mode). Automatic switches pass `auto` and leave pinned roots alone. */
  setMode: (path: string, mode: CodeRoot["mode"], auto?: boolean) => void;
  toggleMode: () => void;
  clearMarks: () => void;
  showAgentDiff: (entry: AgentActivity) => Promise<void>;
  onAgentEvent: (payload: AgentEventPayload) => void;
  terminals: CodeTerminal[];
  activeBottomTab: string;
  searchQuery: string;
  searchFocus: number;
  selection: string;
  jump: { key: string; target: FileTarget; nonce: number; follow?: boolean } | null;
  diffTabs: Record<string, "HEAD" | "base" | "disk">;
  newTerminal: () => void;
  toggleTerminal: () => void;
  closeTerminal: (id: string) => void;
  openSearch: () => void;
  toggleDiff: () => void;
  openFileAt: (rel: string, target: FileTarget, path?: string) => Promise<void>;
  autosave: (path: string, rel: string) => void;
  buffers: Record<string, Buffer>;
  dirs: Record<string, DirEntry[]>;
  files: Record<string, string[]>;
  quickOpen: boolean;
  bottomOpen: boolean;
  activityOpen: boolean;
  init: () => Promise<void>;
  openRoot: (path: string, options?: { workspaceId?: string }) => Promise<void>;
  closeRoot: (path: string) => Promise<void>;
  openFile: (rel: string, options?: { preview?: boolean }, path?: string) => Promise<void>;
  closeTab: (rel: string) => Promise<void>;
  setActive: (rel: string) => void;
  pin: (rel: string) => void;
  updateText: (path: string, rel: string, text: string) => void;
  save: (rel: string, path?: string) => Promise<void>;
  saveAll: () => Promise<void>;
  reloadFromDisk: (rel: string, path?: string, discard?: boolean) => Promise<void>;
  keepMine: (rel: string) => Promise<void>;
  loadDir: (path: string, rel: string) => Promise<void>;
  toggleDir: (rel: string) => void;
  loadFiles: (path: string) => Promise<void>;
  createEntry: (rel: string, dir: boolean) => Promise<void>;
  renameEntry: (from: string, to: string) => Promise<void>;
  deleteEntry: (rel: string) => Promise<void>;
  setQuickOpen: (open: boolean) => void;
  setExplorerWidth: (width: number) => void;
}
let terminalNumber = 0;
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let initialized: Promise<void> | undefined;
let agentUnlisten: (() => void) | undefined;
let fsUnlisten: (() => void) | undefined;
const saving = new Map<string, Promise<void>>();
const belongs = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`);
export const useCode = create<CodeState>((set, get) => {
  const rootUpdate = (path: string, fn: (r: CodeRoot) => CodeRoot) =>
    set((s) => ({ roots: s.roots.map((r) => (r.path === path ? fn(r) : r)) }));
  const refresh = async (path: string) => {
    const root = get().roots.find((r) => r.path === path);
    if (root) await Promise.all([get().loadFiles(path), ...root.expanded.map((rel) => get().loadDir(path, rel))]);
  };
  const frame = (fn: FrameRequestCallback) =>
    typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(() => fn(performance.now()), 16);
  type DraftJob = {
    entry: AgentActivity;
    name: string;
    input: Record<string, unknown>;
    cursor: number;
    base?: string;
    scheduled?: boolean;
    cancelled?: boolean;
  };
  const drafts = new Map<string, DraftJob>();
  const editCursors = new Map<string, number>();
  const replayTokens = new Map<string, object>();
  const landingTokens = new Map<string, object>();
  const clearPreview = (key: string) => {
    replayTokens.delete(key);
    set((s) => {
      const previews = { ...s.previews };
      delete previews[key];
      return { previews };
    });
  };
  const canType = (path: string, key: string) =>
    get().roots.find((r) => r.path === path)?.mode === "watch" &&
    useApp.getState().settings?.editorLiveTyping !== "instant" &&
    !get().buffers[key]?.dirty;
  const scheduleDraft = (job: DraftJob) => {
    if (job.scheduled || job.cancelled) return;
    job.scheduled = true;
    frame(() => {
      job.scheduled = false;
      const { entry } = job,
        key = bufferKey(entry.root, entry.rel);
      if (job.cancelled || job.base === undefined || !get().roots.some((r) => r.path === entry.root)) return;
      // Activity stores counts only, never the growing content.
      const row = get().activity.find((a) => a.id === entry.id && a.root === entry.root && a.rel === entry.rel);
      if (row?.phase === "editing") record({ ...row, writing: true, additions: draftLineCount(job.name, job.input, entry.rel) });
      const projection = draftProjection(job.base, job.name, job.input, entry.rel, job.cursor);
      if (!projection) return;
      if (job.name === "Edit" || job.name === "MultiEdit") editCursors.set(key, projection.caret);
      if (!canType(entry.root, key)) return;
      const b = get().buffers[key];
      if (!b || b.loading || b.error)
        set((s) => ({ buffers: { ...s.buffers, [key]: { ...emptyBuffer, ...b, loading: false, error: undefined } } }));
      set((s) => ({
        previews: {
          ...s.previews,
          [key]: { ...projection, toolId: entry.id, workspaceId: entry.workspaceId, virtual: !b || b.mtime === 0 },
        },
      }));
      const from = job.name === "Write" ? 0 : Math.min(projection.caret, ...projection.removed.map((r) => r.at));
      const first = projection.text.slice(0, from).split("\n").length;
      const last = projection.text.slice(0, projection.caret).split("\n").length;
      set((s) => ({ marks: { ...s.marks, [key]: { ranges: [{ from: first, to: Math.max(first, last) }], nonce: Date.now() } } }));
    });
  };
  const acceptDraft = (entry: AgentActivity, name: string, input: Record<string, unknown>) => {
    const key = bufferKey(entry.root, entry.rel),
      id = entry.id + "|" + key;
    let job = drafts.get(id);
    if (job) {
      job.input = input;
      scheduleDraft(job);
      return;
    }
    landingTokens.delete(key);
    if (get().previews[key]?.replay) clearPreview(key);
    job = { entry, name, input, cursor: editCursors.get(key) ?? 0 };
    drafts.set(id, job);
    const current = job;
    void (async () => {
      await capture(entry, true);
      if (current.cancelled) return;
      const b = get().buffers[key];
      current.base = (b && !b.loading && !b.error ? b.savedText : undefined) ?? get().baselines[baselineKey(entry)] ?? "";
      if (!b || b.loading || b.error) {
        // A real disk snapshot where possible; virtual files have an empty saved buffer.
        try {
          const file = await codeApi.readFile(entry.root, entry.rel);
          current.base = file.text ?? "";
          if (canType(entry.root, key) && !get().buffers[key] && !current.cancelled)
            set((s) => ({
              buffers: {
                ...s.buffers,
                [key]: {
                  ...emptyBuffer,
                  ...file,
                  text: file.text ?? "",
                  savedText: file.text ?? "",
                  loading: false,
                },
              },
            }));
        } catch {
          /* Write may be creating a file that does not exist yet. */
        }
      }
      scheduleDraft(current);
    })();
  };
  const stopDrafts = (entry: AgentActivity) => {
    const key = bufferKey(entry.root, entry.rel);
    for (const [id, job] of drafts)
      if (job.entry.id === entry.id && job.entry.root === entry.root && job.entry.rel === entry.rel) {
        job.cancelled = true;
        drafts.delete(id);
      }
    return key;
  };
  const trackers = new Map<string, ReturnType<typeof createEditTracker>>();
  const baselineRequests = new Map<string, Promise<void>>();
  const capture = (entry: AgentActivity, beforeLanding: boolean) => {
    const key = baselineKey(entry);
    if (key in get().baselines) return Promise.resolve();
    const pending = baselineRequests.get(key);
    if (pending) return pending;
    const buffer = get().buffers[bufferKey(entry.root, entry.rel)];
    const request = (async () => {
      let text: string | undefined = buffer && !buffer.loading && !buffer.error ? buffer.savedText : undefined;
      if (text === undefined && beforeLanding) {
        try {
          text = (await codeApi.readFile(entry.root, entry.rel)).text ?? undefined;
        } catch {
          /* New file or already removed. */
        }
      }
      if (text === undefined) {
        try {
          text = (await codeApi.fileAt(entry.root, entry.rel, "HEAD")) ?? "";
        } catch {
          text = "";
        }
      }
      set((s) => ({ baselines: { ...s.baselines, [key]: text! } }));
    })();
    baselineRequests.set(key, request);
    void request.finally(() => baselineRequests.delete(key));
    return request;
  };
  const record = (entry: AgentActivity) =>
    set((s) => ({
      activity: [...s.activity.filter((a) => a.id !== entry.id || a.root !== entry.root || a.rel !== entry.rel), entry].slice(
        -500,
      ),
    }));
  const land = async (entry: AgentActivity) => {
    const key = bufferKey(entry.root, entry.rel),
      landing = {};
    landingTokens.set(key, landing);
    await capture(entry, false);
    try {
      // Trust the disk over the event: an atomic replace (how agents write) reports a remove too.
      const onDisk = await codeApi.readFile(entry.root, entry.rel).catch(() => null);
      entry = { ...entry, removed: !onDisk };
      const file = onDisk ?? { text: "", mtime: Date.now(), binary: false, tooLarge: false };
      if (file.text === null || landingTokens.get(key) !== landing) return;
      const changes = agentChanges(get().baselines[baselineKey(entry)] ?? "", file.text);
      const latest = get().activity.find((a) => a.id === entry.id && a.root === entry.root && a.rel === entry.rel);
      if (!latest) return;
      record({ ...latest, removed: entry.removed, additions: changes.additions, deletions: changes.deletions });
      const turn = get().turns[entry.workspaceId];
      if (turn?.number !== entry.turn) return;
      let root = get().roots.find((r) => r.path === entry.root);
      if (!root) return;
      if (
        root.mode === "watch" &&
        (!root.activeRel ||
          !get().activity.some(
            (a) => a.root === entry.root && a.workspaceId === entry.workspaceId && a.turn === entry.turn && a.rel !== entry.rel,
          ))
      ) {
        if (!get().buffers[key]) {
          const text = get().baselines[baselineKey(entry)] ?? "";
          set((s) => ({ buffers: { ...s.buffers, [key]: { ...emptyBuffer, text, savedText: text, loading: false } } }));
        }
        void get().openFile(entry.rel, { preview: true }, entry.root);
        root = get().roots.find((r) => r.path === entry.root)!;
      }
      const previous = get().buffers[key];
      const hadDraft = get().previews[key]?.toolId === entry.id;
      stopDrafts(entry);
      clearPreview(key);
      const watch = root.mode === "watch" && (previous?.userVersion ?? 0) === (turn.userVersions[key] ?? 0);
      const delta = agentChanges(previous?.text ?? get().baselines[baselineKey(entry)] ?? "", file.text);
      set((s) => ({ marks: { ...s.marks, [key]: { ranges: changes.ranges, nonce: Date.now() } } }));
      if (previous && !previous.dirty) {
        const replay = makeReplay(previous.text, file.text);
        if (
          !hadDraft &&
          canType(entry.root, key) &&
          root.activeRel === entry.rel &&
          get().activeRoot === root.path &&
          useApp.getState().view === "code" &&
          replay.count > 0 &&
          replay.count <= 20000
        ) {
          const token = {},
            started = performance.now();
          replayTokens.set(key, token);
          await new Promise<void>((resolve) => {
            const tick: FrameRequestCallback = () => {
              if (
                landingTokens.get(key) !== landing ||
                replayTokens.get(key) !== token ||
                !canType(entry.root, key) ||
                useApp.getState().view !== "code" ||
                get().activeRoot !== root!.path ||
                get().roots.find((r) => r.path === root!.path)?.activeRel !== entry.rel
              ) {
                if (replayTokens.get(key) === token) clearPreview(key);
                resolve();
                return;
              }
              const elapsed = performance.now() - started;
              set((s) => ({
                previews: {
                  ...s.previews,
                  [key]: { ...replay.frame(elapsed), toolId: entry.id, workspaceId: entry.workspaceId, replay: true },
                },
              }));
              if (elapsed >= replay.duration) {
                clearPreview(key);
                resolve();
              } else frame(tick);
            };
            frame(tick);
          });
          if (landingTokens.get(key) !== landing || !get().roots.some((r) => r.path === entry.root)) return;
          // A user may have switched mode and edited while the animation was running.
          if (get().buffers[key]?.dirty) {
            set((s) => ({ buffers: { ...s.buffers, [key]: { ...s.buffers[key], diskChanged: true } } }));
            return;
          }
        }
        set((s) => ({
          buffers: {
            ...s.buffers,
            [key]: {
              ...file,
              text: file.text!,
              savedText: file.text!,
              userVersion: previous.userVersion,
              dirty: false,
              loading: false,
              diskChanged: false,
              changedBy: entry.workspaceId,
              ...(entry.removed ? { error: "File was removed on disk." } : {}),
            },
          },
        }));
        set((s) => ({ marks: { ...s.marks, [key]: { ranges: changes.ranges, nonce: Date.now() } } }));
        if (watch && !hadDraft && !replay.count && root.activeRel === entry.rel && delta.ranges.length) {
          // A follow jump scrolls within Code, without moving DOM focus.
          set({ jump: { key, target: { line: delta.ranges[0].from, start: 0, end: 0 }, follow: true, nonce: Date.now() } });
        }
      } else if (previous)
        set((s) => ({
          buffers: { ...s.buffers, [key]: { ...s.buffers[key], diskChanged: true, changedBy: entry.workspaceId } },
        }));
    } catch {
      /* Removed/unreadable files remain visible in the timeline. */
    }
  };
  return {
    ...restore(),
    activity: [],
    previews: {},
    turns: {},
    agentMessages: {},
    baselines: {},
    agentDiff: null,
    marks: {},
    markEpoch: 0,
    setMode: (path, mode, auto) => {
      rootUpdate(path, (r) => (auto ? (r.modePinned ? r : { ...r, mode }) : { ...r, mode, modePinned: true }));
      if (get().roots.find((r) => r.path === path)?.mode === "manual")
        for (const key of Object.keys(get().previews)) if (key.startsWith(path + "|")) clearPreview(key);
    },
    toggleMode: () => {
      const root = get().roots.find((r) => r.path === get().activeRoot);
      if (root) get().setMode(root.path, root.mode === "watch" ? "manual" : "watch");
    },
    clearMarks: () => set((s) => ({ marks: {}, markEpoch: s.markEpoch + 1 })),
    showAgentDiff: async (entry) => {
      set({ activeRoot: entry.root });
      await get().openFile(entry.rel, { preview: false }, entry.root);
      set({ agentDiff: entry });
    },
    onAgentEvent: ({ workspaceId, event, ts }) => {
      const ws = useApp.getState().workspaces.find((w) => w.id === workspaceId);
      const roots = get().roots.filter((r) => r.workspaceId === workspaceId || (ws && samePath(r.path, ws.path)));
      if (
        (event.type === "toolCall" || event.type === "toolDraft") &&
        (!get().turns[workspaceId]?.running || !get().turns[workspaceId]?.number)
      ) {
        get().onAgentEvent({ workspaceId, event: { type: "turnStarted" }, ts, seq: null });
      }
      if (event.type === "turnStarted") {
        const number = (get().turns[workspaceId]?.number ?? 0) + 1;
        for (const key of editCursors.keys()) if (roots.some((r) => key.startsWith(r.path + "|"))) editCursors.delete(key);
        for (const [key, tracker] of trackers) if (key.startsWith(`${workspaceId}|`)) tracker.clear();
        set((s) => ({
          turns: {
            ...s.turns,
            [workspaceId]: {
              number,
              running: true,
              userVersions: Object.fromEntries(Object.entries(s.buffers).map(([key, b]) => [key, b.userVersion ?? 0])),
            },
          },
          agentMessages: { ...s.agentMessages, [workspaceId]: "" },
          baselines: Object.fromEntries(
            Object.entries(s.baselines).filter(([key]) => s.activity.some((a) => baselineKey(a) === key)),
          ),
          marks: Object.fromEntries(Object.entries(s.marks).filter(([key]) => !roots.some((r) => key.startsWith(`${r.path}|`)))),
          markEpoch: s.markEpoch + 1,
        }));
        // Freeze loaded files now, before the first tool writes them.
        for (const root of roots)
          for (const [key, b] of Object.entries(get().buffers)) {
            if (!key.startsWith(`${root.path}|`)) continue;
            const baseline = baselineKey({ root: root.path, workspaceId, turn: number, rel: key.slice(root.path.length + 1) });
            set((s) => ({ baselines: { ...s.baselines, [baseline]: b.savedText } }));
          }
        if (useApp.getState().settings?.editorFollowAgent) for (const root of roots) get().setMode(root.path, "watch", true);
        return;
      }
      if (event.type === "message" || event.type === "textDelta") {
        set((s) => ({
          agentMessages: {
            ...s.agentMessages,
            [workspaceId]: (event.type === "message" ? event.text : (s.agentMessages[workspaceId] ?? "") + event.text)
              .replace(/\s+/g, " ")
              .trimStart()
              .slice(-400),
          },
        }));
        return;
      }
      if (event.type === "turnCompleted" || event.type === "exited") {
        if (event.type === "exited" || event.isError) {
          for (const [key, preview] of Object.entries(get().previews))
            if (preview.workspaceId === workspaceId) {
              clearPreview(key);
              const split = key.indexOf("|");
              void get().reloadFromDisk(key.slice(split + 1), key.slice(0, split));
            }
        }
        for (const job of [...drafts.values()])
          if (job.entry.workspaceId === workspaceId) {
            const key = stopDrafts(job.entry);
            clearPreview(key);
            void get().reloadFromDisk(job.entry.rel, job.entry.root);
          }
        const turn = get().turns[workspaceId];
        if (turn)
          set((s) => ({
            turns: { ...s.turns, [workspaceId]: { ...turn, running: false } },
            activity: s.activity.map((a) =>
              a.workspaceId === workspaceId && a.phase === "editing" ? { ...a, phase: "failed" } : a,
            ),
          }));
        return;
      }
      if (!roots.length) return;
      for (const root of roots) {
        const trackerKey = `${workspaceId}|${root.path}`;
        let tracker = trackers.get(trackerKey);
        if (!tracker) {
          tracker = createEditTracker();
          trackers.set(trackerKey, tracker);
        }
        const edit = tracker.accept(event, root.path);
        if (!edit) continue;
        for (const rel of edit.paths) {
          const turn = get().turns[workspaceId]?.number ?? 0;
          const entry: AgentActivity = {
            id: `${workspaceId}:${turn}:${edit.id}`,
            ts,
            workspaceId,
            root: root.path,
            turn,
            rel,
            phase: edit.phase === "pending" ? "editing" : edit.phase === "failed" ? "failed" : "done",
            additions: 0,
            deletions: 0,
          };
          const previousEntry = get().activity.find((a) => a.id === entry.id && a.root === entry.root && a.rel === entry.rel);
          record({
            ...entry,
            additions: previousEntry?.additions ?? 0,
            writing: event.type === "toolDraft" || (edit.phase === "pending" && previousEntry?.writing),
          });
          if (event.type === "toolDraft") acceptDraft(entry, event.name, event.input);
          if (edit.phase === "pending") {
            void capture(entry, true);
            if (root.mode === "watch") {
              set((s) => {
                const diffTabs = { ...s.diffTabs };
                delete diffTabs[bufferKey(root.path, rel)];
                return { diffTabs, agentDiff: s.agentDiff?.root === root.path ? null : s.agentDiff };
              });
              // Drafts retain tabs for other files so their live dots remain visible.
              if (event.type === "toolDraft")
                rootUpdate(root.path, (r) => ({
                  ...r,
                  tabs: r.tabs.some((t) => t.rel === rel) ? r.tabs : [...r.tabs, { rel, preview: true }],
                  activeRel: rel,
                }));
              else if (!get().previews[bufferKey(root.path, rel)]) void get().openFile(rel, { preview: true }, root.path);
            }
          } else if (edit.phase === "landed") void land(entry);
          else if (edit.phase === "failed") {
            const key = stopDrafts(entry);
            clearPreview(key);
            void get().reloadFromDisk(rel, root.path);
          }
        }
      }
    },
    terminals: [],
    activeBottomTab: "search",
    searchQuery: "",
    searchFocus: 0,
    selection: "",
    jump: null,
    diffTabs: {},
    newTerminal: () => {
      const root = get().activeRoot;
      if (!root) return;
      const id = crypto.randomUUID();
      set((s) => ({
        terminals: [...s.terminals, { id, title: `Terminal ${++terminalNumber}`, root, exited: false }],
        bottomOpen: true,
        activeBottomTab: id,
      }));
    },
    toggleTerminal: () => {
      if (!get().terminals.length) get().newTerminal();
      else
        set((s) => ({
          bottomOpen: !s.bottomOpen,
          activeBottomTab: s.terminals.some((t) => t.id === s.activeBottomTab) ? s.activeBottomTab : s.terminals[0].id,
        }));
    },
    closeTerminal: (id) =>
      set((s) => ({
        terminals: s.terminals.filter((t) => t.id !== id),
        activeBottomTab: s.activeBottomTab === id ? (s.terminals.find((t) => t.id !== id)?.id ?? "search") : s.activeBottomTab,
      })),
    openSearch: () =>
      set((s) => ({
        bottomOpen: true,
        activeBottomTab: "search",
        searchQuery: s.selection || s.searchQuery,
        searchFocus: s.searchFocus + 1,
      })),
    toggleDiff: () => {
      const s = get(),
        rel = s.roots.find((r) => r.path === s.activeRoot)?.activeRel;
      if (!s.activeRoot || !rel) return;
      const key = bufferKey(s.activeRoot, rel),
        diffTabs = { ...s.diffTabs };
      if (diffTabs[key]) delete diffTabs[key];
      else diffTabs[key] = "HEAD";
      set({ diffTabs, agentDiff: null });
    },
    openFileAt: async (rel, target, path = get().activeRoot ?? "") => {
      if (!get().roots.some((r) => r.path === path)) return;
      set({ activeRoot: path });
      await get().openFile(rel, { preview: false }, path);
      set((s) => {
        const diffTabs = { ...s.diffTabs };
        delete diffTabs[bufferKey(path, rel)];
        return { diffTabs, agentDiff: null, jump: { key: bufferKey(path, rel), target, nonce: Date.now() } };
      });
    },
    autosave: (path, rel) => {
      const root = get().roots.find((r) => r.path === path);
      const ws = root && useApp.getState().workspaces.find((w) => w.id === root.workspaceId || samePath(w.path, root.path));
      if (root?.mode === "watch" && ws && (get().turns[ws.id]?.running || ws.status === "running")) return;
      const b = get().buffers[bufferKey(path, rel)];
      if (!get().previews[bufferKey(path, rel)] && b?.dirty && !b.diskChanged) void get().save(rel, path);
    },
    buffers: {},
    dirs: {},
    files: {},
    quickOpen: false,
    activityOpen: false,
    init: () =>
      (initialized ??= (async () => {
        agentUnlisten ??= await events.onAgentEvent((payload) => get().onAgentEvent(payload));
        fsUnlisten ??= await codeEvents.onFs((event) => {
          const root = get().roots.find((r) => r.path === event.root);
          if (!root) return;
          const ws = useApp.getState().workspaces.find((w) => w.id === root.workspaceId || samePath(w.path, root.path));
          if (ws && (get().turns[ws.id]?.running || ws.status === "running")) {
            if (!get().turns[ws.id]?.running || !get().turns[ws.id]?.number)
              get().onAgentEvent({ workspaceId: ws.id, event: { type: "turnStarted" }, ts: Date.now(), seq: null });
            for (const rel of event.paths) {
              const turn = get().turns[ws.id]?.number ?? 0;
              const existing = [...get().activity]
                .reverse()
                .find((a) => a.root === root.path && a.workspaceId === ws.id && a.turn === turn && a.rel === rel);
              const entry: AgentActivity = {
                id: existing?.id ?? `fs:${crypto.randomUUID()}`,
                ts: Date.now(),
                root: root.path,
                workspaceId: ws.id,
                turn,
                rel,
                phase: "done",
                removed: event.kind === "remove",
                additions: existing?.additions ?? 0,
                deletions: existing?.deletions ?? 0,
              };
              if (
                existing?.phase !== "editing" &&
                ![...drafts.values()].some((j) => j.entry.root === root.path && j.entry.rel === rel)
              ) {
                record(entry);
                void land(entry);
              }
            }
          }
          for (const dir of root.expanded) {
            if (event.paths.some((p) => !dir || belongs(p, dir) || belongs(dir, p))) void get().loadDir(root.path, dir);
          }
          if (event.kind !== "modify") void get().loadFiles(root.path);
          for (const [key, b] of Object.entries(get().buffers)) {
            if (!key.startsWith(`${root.path}|`)) continue;
            const rel = key.slice(root.path.length + 1);
            if (!event.paths.some((p) => belongs(rel, p))) continue;
            if (b.dirty)
              void (async () => {
                // Ignore our own save/rename notifications if the observed version is still current.
                try {
                  const file = await codeApi.readFile(root.path, rel),
                    current = get().buffers[key];
                  if (!current || file.mtime === current.mtime) return;
                  if (!current.dirty) {
                    await get().reloadFromDisk(rel, root.path);
                    return;
                  }
                } catch {
                  /* Removed files also conflict with unsaved text. */
                }
                set((s) =>
                  s.buffers[key] ? { buffers: { ...s.buffers, [key]: { ...s.buffers[key], diskChanged: true } } } : {},
                );
              })();
            else if (
              !get().previews[key] &&
              !get().activity.some((a) => a.root === root.path && a.rel === rel && a.phase === "editing") &&
              !(ws && (get().turns[ws.id]?.running || ws.status === "running"))
            )
              void get().reloadFromDisk(rel, root.path);
          }
        });
        await Promise.all(
          get().roots.map(async (r) => {
            try {
              await codeApi.watch(r.path);
              await refresh(r.path);
              for (const t of r.tabs) await get().reloadFromDisk(t.rel, r.path);
            } catch (e) {
              error(e);
            }
          }),
        );
      })().catch((e) => {
        initialized = undefined;
        error(e);
      })),
    openRoot: async (path, options) => {
      path = path.replace(/\\/g, "/");
      if (path !== "/" && !/^[A-Za-z]:\/$/.test(path)) path = path.replace(/\/$/, "");
      options ??= {};
      options.workspaceId ??= useApp.getState().workspaces.find((w) => samePath(w.path, path))?.id;
      await get().init();
      if (!get().roots.some((r) => r.path === path)) {
        try {
          await codeApi.watch(path);
          set((s) => ({
            roots: [
              ...s.roots,
              {
                path,
                label: path.split("/").pop() || path,
                workspaceId: options?.workspaceId ?? null,
                mode: options?.workspaceId && useApp.getState().settings?.editorFollowAgent ? "watch" : "manual",
                tabs: [],
                activeRel: null,
                expanded: [""],
              },
            ],
          }));
        } catch (e) {
          error(e);
          return;
        }
      }
      if (options?.workspaceId)
        rootUpdate(path, (r) => ({
          ...r,
          workspaceId: options.workspaceId!,
          mode: useApp.getState().settings?.editorFollowAgent ? "watch" : "manual",
        }));
      set((s) => ({
        activeRoot: path,
        activityOpen: options?.workspaceId ? true : s.activityOpen,
        recent: [path, ...s.recent.filter((p) => p !== path)].slice(0, 12),
      }));
      await refresh(path);
      const ws = useApp.getState().workspaces.find((w) => w.id === options?.workspaceId || samePath(w.path, path));
      if (ws && !get().turns[ws.id])
        set((s) => ({
          turns: {
            ...s.turns,
            [ws.id]: {
              number: ws.status === "running" ? 1 : 0,
              running: ws.status === "running",
              userVersions: Object.fromEntries(Object.entries(s.buffers).map(([key, b]) => [key, b.userVersion ?? 0])),
            },
          },
        }));
    },
    closeRoot: async (path) => {
      if (
        Object.entries(get().buffers).some(([key, b]) => key.startsWith(`${path}|`) && b.dirty) &&
        !(await confirmAction("Discard unsaved changes in this folder?", "Discard"))
      )
        return;
      for (const job of [...drafts.values()]) if (job.entry.root === path) stopDrafts(job.entry);
      for (const key of trackers.keys()) if (key.endsWith("|" + path)) trackers.delete(key);
      for (const key of Object.keys(get().previews))
        if (key.startsWith(path + "|")) {
          clearPreview(key);
          landingTokens.delete(key);
        }
      try {
        await codeApi.unwatch(path);
      } catch (e) {
        error(e);
      }
      set((s) => {
        const roots = s.roots.filter((r) => r.path !== path);
        return {
          roots,
          activeRoot: s.activeRoot === path ? (roots[0]?.path ?? null) : s.activeRoot,
          buffers: Object.fromEntries(Object.entries(s.buffers).filter(([k]) => !k.startsWith(`${path}|`))),
          previews: Object.fromEntries(Object.entries(s.previews).filter(([k]) => !k.startsWith(`${path}|`))),
        };
      });
    },
    loadDir: async (path, rel) => {
      try {
        const entries = await codeApi.listDir(path, rel);
        if (get().roots.some((r) => r.path === path)) set((s) => ({ dirs: { ...s.dirs, [bufferKey(path, rel)]: entries } }));
      } catch (e) {
        error(e);
      }
    },
    loadFiles: async (path) => {
      try {
        const files = await codeApi.listFiles(path);
        set((s) => ({ files: { ...s.files, [path]: files } }));
      } catch (e) {
        error(e);
      }
    },
    toggleDir: (rel) => {
      const path = get().activeRoot;
      if (!path) return;
      rootUpdate(path, (r) => ({
        ...r,
        expanded: r.expanded.includes(rel) ? r.expanded.filter((p) => p !== rel) : [...r.expanded, rel],
      }));
      void get().loadDir(path, rel);
    },
    openFile: async (rel, options, path = get().activeRoot ?? "") => {
      if (!path) return;
      rootUpdate(path, (r) => {
        const exists = r.tabs.find((t) => t.rel === rel);
        const preview = options?.preview ?? true;
        const tabs = exists
          ? r.tabs.map((t) => (t.rel === rel ? { ...t, preview: t.preview && preview } : t))
          : [...r.tabs.filter((t) => !t.preview || get().buffers[bufferKey(path, t.rel)]?.dirty), { rel, preview }];
        return { ...r, tabs, activeRel: rel };
      });
      const b = get().buffers[bufferKey(path, rel)];
      if (!b || b.error) await get().reloadFromDisk(rel, path);
    },
    explorerHidden: false,
    explorerFocus: 0,
    cycleTab: (direction) => {
      const r = get().roots.find((r) => r.path === get().activeRoot);
      if (!r?.tabs.length) return;
      const index = (r.tabs.findIndex((t) => t.rel === r.activeRel) + direction + r.tabs.length) % r.tabs.length;
      get().setActive(r.tabs[index].rel);
    },
    reopenTab: async () => {
      const r = get().roots.find((r) => r.path === get().activeRoot),
        tab = r?.closedTabs?.at(-1);
      if (!r || !tab) return;
      rootUpdate(r.path, (r) => ({ ...r, closedTabs: r.closedTabs?.slice(0, -1) }));
      await get().openFile(tab.rel, { preview: false }, r.path);
    },
    closeAllTabs: async () => {
      const r = get().roots.find((r) => r.path === get().activeRoot);
      if (!r) return;
      if (
        r.tabs.some((t) => get().buffers[bufferKey(r.path, t.rel)]?.dirty) &&
        !(await confirmAction("Discard unsaved changes in all tabs?", "Discard"))
      )
        return;
      rootUpdate(r.path, (r) => ({
        ...r,
        closedTabs: [...(r.closedTabs ?? []), ...r.tabs].slice(-20),
        tabs: [],
        activeRel: null,
      }));
      set((s) => ({ buffers: Object.fromEntries(Object.entries(s.buffers).filter(([key]) => !key.startsWith(r.path + "|"))) }));
    },
    closeTab: async (rel) => {
      const path = get().activeRoot;
      if (!path) return;
      if (get().buffers[bufferKey(path, rel)]?.dirty && !(await confirmAction(`Discard unsaved changes to ${rel}?`, "Discard")))
        return;
      rootUpdate(path, (r) => {
        const at = r.tabs.findIndex((t) => t.rel === rel),
          tabs = r.tabs.filter((t) => t.rel !== rel);
        return {
          ...r,
          closedTabs: [...(r.closedTabs ?? []), ...r.tabs.filter((t) => t.rel === rel)].slice(-20),
          tabs,
          activeRel: r.activeRel === rel ? (tabs[Math.min(at, tabs.length - 1)]?.rel ?? null) : r.activeRel,
        };
      });
      set((s) => {
        const buffers = { ...s.buffers };
        delete buffers[bufferKey(path, rel)];
        return { buffers };
      });
    },
    setActive: (rel) => {
      const path = get().activeRoot;
      if (path) rootUpdate(path, (r) => ({ ...r, activeRel: rel }));
    },
    pin: (rel) => {
      const path = get().activeRoot;
      if (path) rootUpdate(path, (r) => ({ ...r, tabs: r.tabs.map((t) => (t.rel === rel ? { ...t, preview: false } : t)) }));
    },
    updateText: (path, rel, text) => {
      const key = bufferKey(path, rel),
        b = get().buffers[key];
      if (!b || get().previews[key]) return;
      clearTimeout(autosaveTimers.get(key));
      if (useApp.getState().settings?.editorAutosave === "delay") {
        autosaveTimers.set(
          key,
          setTimeout(() => {
            autosaveTimers.delete(key);
            if (useApp.getState().settings?.editorAutosave === "delay") get().autosave(path, rel);
          }, 1000),
        );
      }
      set((s) => ({
        buffers: { ...s.buffers, [key]: { ...b, text, userVersion: (b.userVersion ?? 0) + 1, dirty: text !== b.savedText } },
      }));
      rootUpdate(path, (r) => ({ ...r, tabs: r.tabs.map((t) => (t.rel === rel ? { ...t, preview: false } : t)) }));
    },
    save: (rel, path = get().activeRoot ?? "") => {
      const key = bufferKey(path, rel),
        pending = saving.get(key);
      if (pending) return pending.then(() => get().save(rel, path));
      const task = (async () => {
        const key = bufferKey(path, rel),
          b = get().buffers[key];
        if (get().previews[key] || !b || !b.dirty || b.loading || b.binary || b.tooLarge) return;
        try {
          const mtime = await codeApi.writeFile(path, rel, b.text, b.overwrite ? null : b.mtime);
          set((s) => {
            const current = s.buffers[key];
            return current
              ? {
                  buffers: {
                    ...s.buffers,
                    [key]: {
                      ...current,
                      savedText: b.text,
                      dirty: current.text !== b.text,
                      mtime,
                      diskChanged: false,
                      overwrite: false,
                    },
                  },
                }
              : {};
          });
        } catch (e) {
          if (String(e).startsWith(CONFLICT_PREFIX))
            set((s) => (s.buffers[key] ? { buffers: { ...s.buffers, [key]: { ...s.buffers[key], diskChanged: true } } } : {}));
          else error(e);
        }
      })();
      saving.set(key, task);
      void task.finally(() => {
        if (saving.get(key) === task) saving.delete(key);
      });
      return task;
    },
    saveAll: async () => {
      for (const [key, b] of Object.entries(get().buffers))
        if (b.dirty) {
          const split = key.indexOf("|");
          await get().save(key.slice(split + 1), key.slice(0, split));
        }
    },
    reloadFromDisk: async (rel, path = get().activeRoot ?? "", discard = false) => {
      const key = bufferKey(path, rel),
        before = get().buffers[key];
      if (get().previews[key] && !discard) return;
      if (discard && before?.dirty && !(await confirmAction(`Reload ${rel} and discard your changes?`, "Reload"))) return;
      if (!before) set((s) => ({ buffers: { ...s.buffers, [key]: { ...emptyBuffer } } }));
      try {
        const file = await codeApi.readFile(path, rel);
        const current = get().buffers[key];
        if (!current || !get().roots.some((r) => r.path === path)) return;
        if ((current.text !== before?.text && current.dirty) || (current.dirty && !discard)) {
          set((s) => ({ buffers: { ...s.buffers, [key]: { ...current, diskChanged: true } } }));
          return;
        }
        set((s) => ({
          buffers: {
            ...s.buffers,
            [key]: {
              ...file,
              userVersion: current.userVersion,
              changedBy: current.changedBy,
              text: file.text ?? "",
              savedText: file.text ?? "",
              dirty: false,
              loading: false,
              diskChanged: false,
            },
          },
        }));
      } catch (e) {
        set((s) => ({
          buffers: { ...s.buffers, [key]: { ...s.buffers[key], loading: false, diskChanged: true, error: String(e) } },
        }));
      }
    },
    keepMine: async (rel) => {
      const path = get().activeRoot;
      if (
        !path ||
        !(await confirmAction(`Keep your version of ${rel}? The next save will overwrite the file on disk.`, "Keep mine"))
      )
        return;
      const key = bufferKey(path, rel);
      set((s) => ({ buffers: { ...s.buffers, [key]: { ...s.buffers[key], diskChanged: false, overwrite: true } } }));
    },
    createEntry: async (rel, dir) => {
      const path = get().activeRoot;
      if (!path) return;
      try {
        await codeApi.create(path, rel, dir);
        await refresh(path);
        if (!dir) await get().openFile(rel, { preview: false }, path);
      } catch (e) {
        error(e);
      }
    },
    renameEntry: async (from, to) => {
      const path = get().activeRoot;
      if (!path || from === to) return;
      try {
        await codeApi.rename(path, from, to);
        const renamed = (p: string) => (belongs(p, from) ? to + p.slice(from.length) : p);
        rootUpdate(path, (r) => ({
          ...r,
          tabs: r.tabs.map((t) => ({ ...t, rel: renamed(t.rel) })),
          activeRel: r.activeRel && renamed(r.activeRel),
          expanded: r.expanded.map(renamed),
        }));
        set((s) => ({
          buffers: Object.fromEntries(
            Object.entries(s.buffers).map(([k, b]) => [
              k.startsWith(`${path}|`) ? bufferKey(path, renamed(k.slice(path.length + 1))) : k,
              b,
            ]),
          ),
        }));
        await refresh(path);
      } catch (e) {
        error(e);
      }
    },
    deleteEntry: async (rel) => {
      const path = get().activeRoot;
      if (!path || !(await confirmAction(`Delete ${rel}? Any unsaved changes in it will be discarded.`, "Delete"))) return;
      try {
        await codeApi.remove(path, rel);
        rootUpdate(path, (r) => {
          const tabs = r.tabs.filter((t) => !belongs(t.rel, rel));
          return {
            ...r,
            tabs,
            activeRel: r.activeRel && belongs(r.activeRel, rel) ? (tabs[0]?.rel ?? null) : r.activeRel,
            expanded: r.expanded.filter((p) => !belongs(p, rel)),
          };
        });
        set((s) => ({
          buffers: Object.fromEntries(
            Object.entries(s.buffers).filter(([k]) => !k.startsWith(`${path}|`) || !belongs(k.slice(path.length + 1), rel)),
          ),
        }));
        await refresh(path);
      } catch (e) {
        error(e);
      }
    },
    setQuickOpen: (quickOpen) => set({ quickOpen }),
    setExplorerWidth: (width) => set({ explorerWidth: Math.max(160, Math.min(480, width)) }),
  };
});
useCode.subscribe((s, previous) => {
  if (
    s.roots === previous.roots &&
    s.activeRoot === previous.activeRoot &&
    s.recent === previous.recent &&
    s.explorerWidth === previous.explorerWidth &&
    s.activityWidth === previous.activityWidth &&
    s.bottomHeight === previous.bottomHeight &&
    s.bottomOpen === previous.bottomOpen
  )
    return;
  try {
    localStorage.setItem(
      "orbit.code",
      JSON.stringify({
        roots: s.roots,
        activeRoot: s.activeRoot,
        recent: s.recent,
        explorerWidth: s.explorerWidth,
        activityWidth: s.activityWidth,
        bottomHeight: s.bottomHeight,
        bottomOpen: s.bottomOpen,
      }),
    );
  } catch {
    /* Private mode / storage quota. */
  }
});

// Focus autosave also covers tab/root changes triggered outside the editor (including Quick Open).
useCode.subscribe((s, previous) => {
  const rel = previous.roots.find((r) => r.path === previous.activeRoot)?.activeRel;
  const next = s.roots.find((r) => r.path === s.activeRoot)?.activeRel;
  if (
    useApp.getState().settings?.editorAutosave === "focus" &&
    previous.activeRoot &&
    rel &&
    (previous.activeRoot !== s.activeRoot || rel !== next)
  )
    s.autosave(previous.activeRoot, rel);
});

useApp.subscribe((app, previous) => {
  if (app.workspaces === previous.workspaces) return;
  for (const ws of app.workspaces) {
    if (ws.status !== "running" || previous.workspaces.find((w) => w.id === ws.id)?.status === "running") continue;
    if (!app.settings?.editorFollowAgent) continue;
    for (const root of useCode.getState().roots)
      if (root.workspaceId === ws.id || samePath(root.path, ws.path)) useCode.getState().setMode(root.path, "watch", true);
  }
});
