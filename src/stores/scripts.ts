import { create } from "zustand";
import { api, events, type SetupStatus, type WorkspaceRunEvent, type WorkspaceSetupEvent } from "../lib/ipc";

const MAX_LINES = 200;

export interface ScriptLog {
  status: SetupStatus | "stopped";
  lines: string[];
  /** Setup finished cleanly and its "ready" row has been shown long enough. */
  dismissed: boolean;
}
export interface RunState extends ScriptLog {
  port: number | null;
}

interface ScriptsState {
  setup: Record<string, ScriptLog>;
  run: Record<string, RunState>;
  onSetup: (e: WorkspaceSetupEvent) => void;
  onRun: (e: WorkspaceRunEvent) => void;
  setPort: (id: string, port: number) => void;
  dismissSetup: (id: string) => void;
  refreshRun: (id: string) => Promise<void>;
}

const push = (lines: string[], line?: string) => (line === undefined ? lines : [...lines, line].slice(-MAX_LINES));

export const useScripts = create<ScriptsState>((set, get) => ({
  setup: {},
  run: {},
  onSetup: (e) =>
    set((s) => {
      const prev = s.setup[e.workspaceId];
      // A new "running" after a finished one starts a fresh log.
      const base = !prev || (prev.status !== "running" && e.status === "running") ? { status: e.status, lines: [], dismissed: false } : prev;
      const next: ScriptLog = { ...base, status: e.status, lines: push(base.lines, e.line) };
      if (e.status === "done") setTimeout(() => get().dismissSetup(e.workspaceId), 2500);
      return { setup: { ...s.setup, [e.workspaceId]: next } };
    }),
  onRun: (e) =>
    set((s) => {
      const prev = s.run[e.workspaceId];
      const fresh = !prev || (prev.status !== "running" && e.status === "running");
      const base: RunState = fresh ? { status: e.status, lines: [], dismissed: false, port: prev?.port ?? null } : prev;
      return { run: { ...s.run, [e.workspaceId]: { ...base, status: e.status, lines: push(base.lines, e.line) } } };
    }),
  setPort: (id, port) => set((s) => ({ run: { ...s.run, [id]: { status: "running", lines: s.run[id]?.lines ?? [], dismissed: false, port } } })),
  dismissSetup: (id) => set((s) => (s.setup[id] ? { setup: { ...s.setup, [id]: { ...s.setup[id], dismissed: true } } } : s)),
  refreshRun: async (id) => {
    const st = await api.runStatus(id);
    set((s) => ({ run: { ...s.run, [id]: { status: st.status, lines: s.run[id]?.lines ?? [], dismissed: false, port: st.port } } }));
  },
}));

let started = false;
/** Subscribes once to the backend's setup and run events. */
export function startScriptEvents() {
  if (started) return;
  started = true;
  void events.onWorkspaceSetup((e) => useScripts.getState().onSetup(e));
  void events.onWorkspaceRun((e) => useScripts.getState().onRun(e));
  // Read-only handle for the real-app e2e.
  (window as unknown as { __ORBIT_SCRIPTS__?: () => unknown }).__ORBIT_SCRIPTS__ = () => useScripts.getState();
}

/** Starts the repo's run script and records the port it was given. */
export async function startDevServer(id: string, onError: (e: string) => void) {
  try {
    const port = await api.startRun(id);
    useScripts.getState().setPort(id, port);
  } catch (e) {
    onError(String(e));
  }
}

export function stopDevServer(id: string, onError: (e: string) => void) {
  api.stopRun(id).catch((e) => onError(String(e)));
}
