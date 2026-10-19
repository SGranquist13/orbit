import { create } from "zustand";
import { codeApi, codeEvents, CONFLICT_PREFIX, type DirEntry } from "../lib/ipc";
import { confirmAction } from "../lib/confirm";
import { useApp } from "./app";

export interface Tab { rel: string; preview: boolean }
export interface CodeRoot {
  path: string; label: string; workspaceId: string | null; mode: "watch" | "manual";
  tabs: Tab[]; activeRel: string | null; expanded: string[];
}
export interface Buffer {
  text: string; savedText: string; mtime: number; dirty: boolean; binary: boolean;
  tooLarge: boolean; loading: boolean; diskChanged: boolean; overwrite?: boolean; error?: string;
}
export const bufferKey = (root: string, rel: string) => `${root}|${rel}`;
const error = (e: unknown) => useApp.getState().setError(String(e));
const emptyBuffer: Buffer = { text: "", savedText: "", mtime: 0, dirty: false, binary: false, tooLarge: false, loading: true, diskChanged: false };
interface Persisted { roots: CodeRoot[]; activeRoot: string | null; recent: string[]; explorerWidth: number; activityWidth: number; bottomHeight: number }
function restore(): Persisted {
  const fallback: Persisted = { roots: [], activeRoot: null, recent: [], explorerWidth: 248, activityWidth: 280, bottomHeight: 220 };
  try {
    const p = JSON.parse(localStorage.getItem("orbit.code") ?? "null");
    if (!p || !Array.isArray(p.roots)) return fallback;
    return { ...fallback, ...p, roots: p.roots.filter((r: CodeRoot) => typeof r.path === "string" && Array.isArray(r.tabs) && Array.isArray(r.expanded)).map((r: CodeRoot) => ({ ...r, mode: r.mode ?? "manual" })) };
  } catch { return fallback; }
}
interface CodeState extends Persisted {
  buffers: Record<string, Buffer>; dirs: Record<string, DirEntry[]>; files: Record<string, string[]>;
  quickOpen: boolean; bottomOpen: boolean; activityOpen: boolean;
  init: () => Promise<void>;
  openRoot: (path: string, options?: { workspaceId?: string }) => Promise<void>;
  closeRoot: (path: string) => Promise<void>;
  openFile: (rel: string, options?: { preview?: boolean }, path?: string) => Promise<void>;
  closeTab: (rel: string) => Promise<void>;
  setActive: (rel: string) => void; pin: (rel: string) => void;
  updateText: (path: string, rel: string, text: string) => void;
  save: (rel: string, path?: string) => Promise<void>; saveAll: () => Promise<void>;
  reloadFromDisk: (rel: string, path?: string, discard?: boolean) => Promise<void>;
  keepMine: (rel: string) => Promise<void>;
  loadDir: (path: string, rel: string) => Promise<void>;
  toggleDir: (rel: string) => void; loadFiles: (path: string) => Promise<void>;
  createEntry: (rel: string, dir: boolean) => Promise<void>;
  renameEntry: (from: string, to: string) => Promise<void>;
  deleteEntry: (rel: string) => Promise<void>;
  setQuickOpen: (open: boolean) => void; setExplorerWidth: (width: number) => void;
}
let initialized: Promise<void> | undefined;
const saving = new Map<string, Promise<void>>();
const belongs = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`);
export const useCode = create<CodeState>((set, get) => {
  const rootUpdate = (path: string, fn: (r: CodeRoot) => CodeRoot) => set((s) => ({ roots: s.roots.map((r) => r.path === path ? fn(r) : r) }));
  const refresh = async (path: string) => {
    const root = get().roots.find((r) => r.path === path);
    if (root) await Promise.all([get().loadFiles(path), ...root.expanded.map((rel) => get().loadDir(path, rel))]);
  };
  return {
    ...restore(), buffers: {}, dirs: {}, files: {}, quickOpen: false, bottomOpen: false, activityOpen: false,
    init: () => initialized ??= (async () => {
      await codeEvents.onFs((event) => {
        const root = get().roots.find((r) => r.path === event.root);
        if (!root) return;
        for (const dir of root.expanded) {
          if (event.paths.some((p) => !dir || belongs(p, dir) || belongs(dir, p))) void get().loadDir(root.path, dir);
        }
        if (event.kind !== "modify") void get().loadFiles(root.path);
        for (const [key, b] of Object.entries(get().buffers)) {
          if (!key.startsWith(`${root.path}|`)) continue;
          const rel = key.slice(root.path.length + 1);
          if (!event.paths.some((p) => belongs(rel, p))) continue;
          if (b.dirty) void (async () => {
            // Ignore our own save/rename notifications if the observed version is still current.
            try {
              const file = await codeApi.readFile(root.path, rel), current = get().buffers[key];
              if (!current || file.mtime === current.mtime) return;
              if (!current.dirty) { await get().reloadFromDisk(rel, root.path); return; }
            } catch { /* Removed files also conflict with unsaved text. */ }
            set((s) => s.buffers[key] ? { buffers: { ...s.buffers, [key]: { ...s.buffers[key], diskChanged: true } } } : {});
          })();
          else void get().reloadFromDisk(rel, root.path);
        }
      });
      await Promise.all(get().roots.map(async (r) => {
        try { await codeApi.watch(r.path); await refresh(r.path); for (const t of r.tabs) await get().reloadFromDisk(t.rel, r.path); }
        catch (e) { error(e); }
      }));
    })().catch((e) => { initialized = undefined; error(e); }),
    openRoot: async (path, options) => {
      path = path.replace(/\\/g, "/");
      if (path !== "/" && !/^[A-Za-z]:\/$/.test(path)) path = path.replace(/\/$/, "");
      await get().init();
      if (!get().roots.some((r) => r.path === path)) {
        try {
          await codeApi.watch(path);
          set((s) => ({ roots: [...s.roots, { path, label: path.split("/").pop() || path, workspaceId: options?.workspaceId ?? null, mode: "manual", tabs: [], activeRel: null, expanded: [""] }] }));
        } catch (e) { error(e); return; }
      }
      set((s) => ({ activeRoot: path, recent: [path, ...s.recent.filter((p) => p !== path)].slice(0, 12) }));
      await refresh(path);
    },
    closeRoot: async (path) => {
      if (Object.entries(get().buffers).some(([key, b]) => key.startsWith(`${path}|`) && b.dirty) && !await confirmAction("Discard unsaved changes in this folder?", "Discard")) return;
      try { await codeApi.unwatch(path); } catch (e) { error(e); }
      set((s) => {
        const roots = s.roots.filter((r) => r.path !== path);
        return { roots, activeRoot: s.activeRoot === path ? roots[0]?.path ?? null : s.activeRoot,
          buffers: Object.fromEntries(Object.entries(s.buffers).filter(([k]) => !k.startsWith(`${path}|`))) };
      });
    },
    loadDir: async (path, rel) => { try { const entries = await codeApi.listDir(path, rel); if (get().roots.some((r) => r.path === path)) set((s) => ({ dirs: { ...s.dirs, [bufferKey(path, rel)]: entries } })); } catch (e) { error(e); } },
    loadFiles: async (path) => { try { const files = await codeApi.listFiles(path); set((s) => ({ files: { ...s.files, [path]: files } })); } catch (e) { error(e); } },
    toggleDir: (rel) => { const path = get().activeRoot; if (!path) return; rootUpdate(path, (r) => ({ ...r, expanded: r.expanded.includes(rel) ? r.expanded.filter((p) => p !== rel) : [...r.expanded, rel] })); void get().loadDir(path, rel); },
    openFile: async (rel, options, path = get().activeRoot ?? "") => {
      if (!path) return;
      rootUpdate(path, (r) => {
        const exists = r.tabs.find((t) => t.rel === rel);
        const preview = options?.preview ?? true;
        const tabs = exists ? r.tabs.map((t) => t.rel === rel ? { ...t, preview: t.preview && preview } : t) : [...r.tabs.filter((t) => !t.preview || get().buffers[bufferKey(path, t.rel)]?.dirty), { rel, preview }];
        return { ...r, tabs, activeRel: rel };
      });
      const b = get().buffers[bufferKey(path, rel)];
      if (!b || b.error) await get().reloadFromDisk(rel, path);
    },
    closeTab: async (rel) => {
      const path = get().activeRoot; if (!path) return;
      if (get().buffers[bufferKey(path, rel)]?.dirty && !await confirmAction(`Discard unsaved changes to ${rel}?`, "Discard")) return;
      rootUpdate(path, (r) => { const at = r.tabs.findIndex((t) => t.rel === rel), tabs = r.tabs.filter((t) => t.rel !== rel); return { ...r, tabs, activeRel: r.activeRel === rel ? tabs[Math.min(at, tabs.length - 1)]?.rel ?? null : r.activeRel }; });
      set((s) => { const buffers = { ...s.buffers }; delete buffers[bufferKey(path, rel)]; return { buffers }; });
    },
    setActive: (rel) => { const path = get().activeRoot; if (path) rootUpdate(path, (r) => ({ ...r, activeRel: rel })); },
    pin: (rel) => { const path = get().activeRoot; if (path) rootUpdate(path, (r) => ({ ...r, tabs: r.tabs.map((t) => t.rel === rel ? { ...t, preview: false } : t) })); },
    updateText: (path, rel, text) => {
      const key = bufferKey(path, rel), b = get().buffers[key]; if (!b) return;
      set((s) => ({ buffers: { ...s.buffers, [key]: { ...b, text, dirty: text !== b.savedText } } }));
      rootUpdate(path, (r) => ({ ...r, tabs: r.tabs.map((t) => t.rel === rel ? { ...t, preview: false } : t) }));
    },
    save: (rel, path = get().activeRoot ?? "") => {
      const key = bufferKey(path, rel), pending = saving.get(key);
      if (pending) return pending.then(() => get().save(rel, path));
      const task = (async () => {
      const key = bufferKey(path, rel), b = get().buffers[key]; if (!b || !b.dirty || b.loading || b.binary || b.tooLarge) return;
      try {
        const mtime = await codeApi.writeFile(path, rel, b.text, b.overwrite ? null : b.mtime);
        set((s) => { const current = s.buffers[key]; return current ? { buffers: { ...s.buffers, [key]: { ...current, savedText: b.text, dirty: current.text !== b.text, mtime, diskChanged: false, overwrite: false } } } : {}; });
      } catch (e) {
        if (String(e).startsWith(CONFLICT_PREFIX)) set((s) => s.buffers[key] ? ({ buffers: { ...s.buffers, [key]: { ...s.buffers[key], diskChanged: true } } }) : {});
        else error(e);
      }
      })();
      saving.set(key, task);
      void task.finally(() => { if (saving.get(key) === task) saving.delete(key); });
      return task;
    },
    saveAll: async () => { for (const [key, b] of Object.entries(get().buffers)) if (b.dirty) { const split = key.indexOf("|"); await get().save(key.slice(split + 1), key.slice(0, split)); } },
    reloadFromDisk: async (rel, path = get().activeRoot ?? "", discard = false) => {
      const key = bufferKey(path, rel), before = get().buffers[key];
      if (discard && before?.dirty && !await confirmAction(`Reload ${rel} and discard your changes?`, "Reload")) return;
      if (!before) set((s) => ({ buffers: { ...s.buffers, [key]: { ...emptyBuffer } } }));
      try {
        const file = await codeApi.readFile(path, rel);
        const current = get().buffers[key];
        if (!current || !get().roots.some((r) => r.path === path)) return;
        if (current.text !== before?.text && current.dirty || current.dirty && !discard) {
          set((s) => ({ buffers: { ...s.buffers, [key]: { ...current, diskChanged: true } } })); return;
        }
        set((s) => ({ buffers: { ...s.buffers, [key]: { ...file, text: file.text ?? "", savedText: file.text ?? "", dirty: false, loading: false, diskChanged: false } } }));
      } catch (e) { set((s) => ({ buffers: { ...s.buffers, [key]: { ...s.buffers[key], loading: false, diskChanged: true, error: String(e) } } })); }
    },
    keepMine: async (rel) => {
      const path = get().activeRoot; if (!path || !await confirmAction(`Keep your version of ${rel}? The next save will overwrite the file on disk.`, "Keep mine")) return;
      const key = bufferKey(path, rel); set((s) => ({ buffers: { ...s.buffers, [key]: { ...s.buffers[key], diskChanged: false, overwrite: true } } }));
    },
    createEntry: async (rel, dir) => { const path = get().activeRoot; if (!path) return; try { await codeApi.create(path, rel, dir); await refresh(path); if (!dir) await get().openFile(rel, { preview: false }, path); } catch (e) { error(e); } },
    renameEntry: async (from, to) => {
      const path = get().activeRoot; if (!path || from === to) return;
      try {
        await codeApi.rename(path, from, to);
        const renamed = (p: string) => belongs(p, from) ? to + p.slice(from.length) : p;
        rootUpdate(path, (r) => ({ ...r, tabs: r.tabs.map((t) => ({ ...t, rel: renamed(t.rel) })), activeRel: r.activeRel && renamed(r.activeRel), expanded: r.expanded.map(renamed) }));
        set((s) => ({ buffers: Object.fromEntries(Object.entries(s.buffers).map(([k, b]) => [k.startsWith(`${path}|`) ? bufferKey(path, renamed(k.slice(path.length + 1))) : k, b])) }));
        await refresh(path);
      } catch (e) { error(e); }
    },
    deleteEntry: async (rel) => {
      const path = get().activeRoot; if (!path || !await confirmAction(`Delete ${rel}? Any unsaved changes in it will be discarded.`, "Delete")) return;
      try {
        await codeApi.remove(path, rel);
        rootUpdate(path, (r) => { const tabs = r.tabs.filter((t) => !belongs(t.rel, rel)); return { ...r, tabs, activeRel: r.activeRel && belongs(r.activeRel, rel) ? tabs[0]?.rel ?? null : r.activeRel, expanded: r.expanded.filter((p) => !belongs(p, rel)) }; });
        set((s) => ({ buffers: Object.fromEntries(Object.entries(s.buffers).filter(([k]) => !k.startsWith(`${path}|`) || !belongs(k.slice(path.length + 1), rel))) }));
        await refresh(path);
      } catch (e) { error(e); }
    },
    setQuickOpen: (quickOpen) => set({ quickOpen }),
    setExplorerWidth: (width) => set({ explorerWidth: Math.max(160, Math.min(480, width)) }),
  };
});
useCode.subscribe((s) => {
  try { localStorage.setItem("orbit.code", JSON.stringify({ roots: s.roots, activeRoot: s.activeRoot, recent: s.recent, explorerWidth: s.explorerWidth, activityWidth: s.activityWidth, bottomHeight: s.bottomHeight })); } catch { /* Private mode / storage quota. */ }
});
