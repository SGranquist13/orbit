import { archiveWithWorktree } from "../lib/archive";
import { create } from "zustand";
import {
  api,
  events,
  type AgentEvent,
  type AgentEventPayload,
  type Attachment,
  type Overlap,
  type FileChange,
  type Pack,
  type PrStatus,
  type Profile,
  type Related,
  type Repo,
  type Routine,
  type Settings,
  type SimplifyState,
  type Skill,
  type StoredEvent,
  type TeammateView,
  type Summary,
  type Workspace,
  type WorkspaceUsage,
} from "../lib/ipc";
import { confirmAction } from "../lib/confirm";
import { rememberTeammate, rememberedTeammate } from "../lib/lastTeammate";
import { applyUsage } from "../lib/usage";

export type View = "code" | "workspace" | "inbox" | "issues" | "settings" | "routines" | "teammate";

interface AppState {
  repos: Repo[];
  workspaces: Workspace[];
  selectedId: string | null;
  /** Persisted transcript per workspace, loaded lazily on first open. */
  transcripts: Record<string, StoredEvent[]>;
  /** In-flight streamed text per workspace, cleared when the final message lands. */
  live: Record<string, string>;
  changes: Record<string, FileChange[]>;
  /** Live digest of each workspace's event log; drives unread dots and the inbox. */
  summaries: Record<string, Summary>;
  /** Token/cost/context digest per workspace, kept current from `usage` events. */
  usage: Record<string, WorkspaceUsage>;
  view: View;
  routines: Routine[];
  /** Bumped whenever routines or their runs change, so open views refetch history. */
  routinesTick: number;
  /** Routine open in the editor: its id, "new" for a blank draft, or null. */
  selectedRoutine: string | null;
  teammates: TeammateView[];
  /** Thread open in the Teammate view. */
  selectedTeammate: string | null;
  /** Bumped on every teammate change, so an open thread refetches. */
  teammatesTick: number;
  /** Bumped to focus the open thread's composer ("Ask a teammate"). */
  teammateFocus: number;
  /** Teammate in the editor dialog: its slug, "new" for a blank one, or null. */
  teammateEditor: string | null;
  /** Palette restricted to teammates ("Ask a teammate…"). */
  paletteScope: "teammates" | null;
  /** "Schedule message" popover next to the composer. */
  scheduleOpen: boolean;
  /** The view to return to when settings closes. */
  previousView: View;
  /** Typed app settings; null until loaded (consumers fall back to defaults). */
  settingsSection: string | null;
  settings: Settings | null;
  /** undefined = not fetched yet, null = no PR for the branch. */
  prs: Record<string, PrStatus | null | undefined>;
  /** Folders attached to each workspace (loaded when it is selected, refetched after changes). */
  attachments: Record<string, Attachment[]>;
  /** Unattached related projects found per workspace; a cache, never blocks the UI. */
  related: Record<string, Related[]>;
  /** "Always attach" folders per repo. */
  relatedDefaults: Record<string, string[]>;
  /** Related-projects popover in the chat header. */
  relatedOpen: boolean;
  packs: Pack[];
  skills: Skill[];
  profiles: Profile[];
  pins: string[];
  newWorkspaceOpen: boolean;
  newWorkspacePrefill: { prompt: string; repoId?: string } | null;
  /** "New ticket" dialog (Issues view). */
  ticketOpen: boolean;
  packsOpen: boolean;
  paletteOpen: boolean;
  /** Ship panel (changes, PR, checks). Hidden until asked for; never opens on its own. */
  shipOpen: boolean;
  /** Simplify panel; takes the Ship panel's place on the right while open. Not persisted. */
  simplifyOpen: boolean;
  /** Simplify state per workspace, mirrored from the backend's `simplify` events. */
  simplify: Record<string, SimplifyState>;
  sidebarCollapsed: boolean;
  /** Chat only: hides the sidebar and Ship panel. Not persisted. */
  focusMode: boolean;
  error: string | null;
  /** Transcript load failures per workspace (shown with a Retry in the chat). */
  transcriptErrors: Record<string, string>;
  /** Workspaces whose ship gate (checks + ship turn) is in flight. */
  shipping: Record<string, boolean>;
  /** Set when the settings could not be loaded; the Settings page shows it instead of defaults. */
  settingsError: string | null;

  init: () => Promise<void>;
  select: (id: string | null) => void;
  loadTranscript: (id: string) => Promise<void>;
  loadSettings: () => Promise<void>;
  /** Interrupt the running agent; failures go to the error toast. */
  interrupt: (id: string) => Promise<void>;
  /** Confirm, then archive a workspace and delete its worktree (the branch is kept). */
  archiveWorkspace: (id: string) => Promise<void>;
  setView: (view: View) => void;
  refreshTeammates: () => Promise<void>;
  /** Opens a teammate's thread and focuses its composer. */
  openTeammate: (slug: string) => void;
  setTeammateEditor: (slug: string | null) => void;
  openPalette: (scope?: "teammates") => void;
  refreshRoutines: () => Promise<void>;
  setSelectedRoutine: (id: string | null) => void;
  setScheduleOpen: (open: boolean) => void;
  /** Opens the Routines view on a blank draft. */
  newRoutine: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  /** Saves a partial update immediately; resolves false (and sets the error) on failure. */
  updateSettings: (patch: Partial<Settings>) => Promise<boolean>;
  dismiss: (id: string) => Promise<void>;
  /** Summarise the conversation to free context. */
  compactSession: (id: string) => Promise<void>;
  /** Start a fresh agent session (same worktree); the old context is dropped. */
  newSession: (id: string) => Promise<void>;
  addRepo: (path: string) => Promise<Repo>;
  refreshChanges: (id: string) => Promise<void>;
  refreshPr: (id: string) => Promise<void>;
  refreshAttachments: (workspaceId: string) => Promise<void>;
  refreshRelated: (workspaceId: string) => Promise<void>;
  attachFolder: (workspaceId: string, path: string) => Promise<void>;
  detachFolder: (workspaceId: string, id: string) => Promise<void>;
  setAttachmentEditable: (workspaceId: string, id: string, editable: boolean) => Promise<void>;
  setRelatedDefault: (repoId: string, path: string, enabled: boolean) => Promise<void>;
  setRelatedOpen: (open: boolean) => void;
  loadSkills: () => Promise<void>;
  /** Switch a workspace's profile; resolves false (and sets the error) on failure. */
  setProfile: (workspaceId: string, profile: string) => Promise<boolean>;
  togglePin: (skillId: string) => Promise<void>;
  runSkill: (workspaceId: string, skillId: string, args?: string) => Promise<void>;
  /** Orbit's ship gate (checks + squash save points), then `shipkit:ship` if allowed. `anyway` skips the checks. */
  ship: (workspaceId: string, anyway?: boolean) => Promise<void>;
  undoLastTurn: (workspaceId: string) => Promise<void>;
  syncNow: (workspaceId: string) => Promise<void>;
  /** Workspace pairs that edit the same files. */
  overlaps: Overlap[];
  refreshOverlaps: () => Promise<void>;
  setPacksOpen: (open: boolean) => void;
  setNewWorkspaceOpen: (open: boolean) => void;
  setTicketOpen: (open: boolean) => void;
  snooze: (id: string, until: number) => Promise<void>;
  setPaletteOpen: (open: boolean) => void;
  setShipOpen: (open: boolean) => void;
  setSimplifyOpen: (open: boolean) => void;
  loadSimplify: (workspaceId: string) => Promise<void>;
  simplifyFind: (workspaceId: string) => Promise<void>;
  simplifyApply: (workspaceId: string, candidateIds: string[]) => Promise<void>;
  simplifyCancel: (workspaceId: string) => Promise<void>;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setFocusMode: (on: boolean) => void;
  setError: (error: string | null) => void;
  upsertWorkspace: (ws: Workspace) => void;
  removeWorkspace: (id: string) => void;
}

// One init in flight at a time (StrictMode runs effects twice); cleared on failure so a later call can retry.
let initializing: Promise<void> | null = null;

function readFlag(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Storage unavailable: the preference just won't survive a restart.
  }
}

const changeTimers: Record<string, number> = {};

export const useApp = create<AppState>((set, get) => ({
  repos: [],
  workspaces: [],
  selectedId: null,
  transcripts: {},
  live: {},
  changes: {},
  summaries: {},
  usage: {},
  view: "workspace",
  routines: [],
  routinesTick: 0,
  teammates: [],
  selectedTeammate: rememberedTeammate(),
  teammatesTick: 0,
  teammateFocus: 0,
  teammateEditor: null,
  paletteScope: null,
  selectedRoutine: null,
  scheduleOpen: false,
  previousView: "workspace",
  settingsSection: null,
  settings: null,
  prs: {},
  attachments: {},
  related: {},
  relatedDefaults: {},
  relatedOpen: false,
  packs: [],
  skills: [],
  profiles: [],
  pins: [],
  newWorkspaceOpen: false,
  newWorkspacePrefill: null,
  ticketOpen: false,
  packsOpen: false,
  paletteOpen: false,
  shipOpen: readFlag("shipOpen"),
  simplifyOpen: false,
  simplify: {},
  sidebarCollapsed: readFlag("sidebarCollapsed"),
  focusMode: false,
  error: null,
  transcriptErrors: {},
  shipping: {},
  settingsError: null,

  loadSettings: async () => {
    try {
      set({ settings: await api.getSettings(), settingsError: null });
    } catch (e) {
      set({ settingsError: String(e) });
    }
  },

  loadTranscript: async (id) => {
    set((s) => {
      const { [id]: _drop, ...rest } = s.transcriptErrors;
      return { transcriptErrors: rest };
    });
    try {
      const evs = await api.loadEvents(id);
      set((s) => ({ transcripts: { ...s.transcripts, [id]: evs } }));
    } catch (e) {
      set((s) => ({ transcriptErrors: { ...s.transcriptErrors, [id]: String(e) } }));
    }
  },

  interrupt: async (id) => {
    try {
      await api.interrupt(id);
    } catch (e) {
      get().setError(String(e));
    }
  },

  archiveWorkspace: async (id) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (!ws) return;
    const ok = await confirmAction(`Archive "${ws.name}" and delete its worktree?\n\nThe branch ${ws.branch} is kept.`, "Archive");
    if (!ok) return;
    try {
      if (await archiveWithWorktree(id, ws.name)) get().removeWorkspace(id);
    } catch (e) {
      get().setError(String(e));
    }
  },

  init: () => {
    initializing ??= (async () => {
      const [repos, workspaces, sums] = await Promise.all([api.listRepos(), api.listWorkspaces(), api.workspaceSummaries()]);
      set({ repos, workspaces, summaries: Object.fromEntries(sums.map((x) => [x.workspaceId, x])) });
      api
        .allWorkspaceUsage()
        .then((list) => set({ usage: Object.fromEntries(list.map((u) => [u.workspaceId, u])) }))
        .catch(() => {});
      await events.onWorkspace((ws) => get().upsertWorkspace(ws));
      await events.onAgentEvent(onAgentEvent);
      await events.onWorkspaceArchived((id) => get().removeWorkspace(id));
      await events.onRoutinesChanged(() => void get().refreshRoutines());
      void get().refreshRoutines();
      await events.onTeammateChanged(() => void get().refreshTeammates());
      void get().refreshTeammates();
      await events.onSimplify(onSimplify);
      for (const ws of workspaces) void get().refreshChanges(ws.id);
      void get().loadSkills();
      void get().loadSettings();
      const last = localStorage.getItem("selectedWorkspace");
      if (last && workspaces.some((w) => w.id === last)) get().select(last);
    })().catch((e) => {
      initializing = null;
      throw e;
    });
    return initializing;
  },

  select: (id) => {
    set({ selectedId: id, view: "workspace", previousView: "workspace" });
    if (!id) return;
    void markSeen(id);
    localStorage.setItem("selectedWorkspace", id);
    if (!get().transcripts[id]) {
      void get().loadTranscript(id);
    }
    void get().refreshChanges(id);
    void get().refreshPr(id);
    void get().refreshAttachments(id);
    void get().refreshRelated(id);
    const repoId = get().workspaces.find((w) => w.id === id)?.repoId;
    if (repoId && !get().relatedDefaults[repoId]) {
      api
        .getRelatedDefaults(repoId)
        .then((paths) => set((s) => ({ relatedDefaults: { ...s.relatedDefaults, [repoId]: paths } })))
        .catch(() => {});
    }
  },

  setView: (view) => set((s) => ({ view, previousView: view === "settings" ? s.previousView : view })),

  refreshTeammates: async () => {
    try {
      const teammates = await api.listTeammates();
      set((s) => ({ teammates, teammatesTick: s.teammatesTick + 1 }));
    } catch {
      // Keep the last known list; the next change event refetches.
    }
  },
  openTeammate: (slug) => (rememberTeammate(slug), set((s) => ({ selectedTeammate: slug, view: "teammate", previousView: "teammate", paletteOpen: false, teammateFocus: s.teammateFocus + 1 }))),
  setTeammateEditor: (slug) => set({ teammateEditor: slug }),
  openPalette: (scope) => set({ paletteOpen: true, paletteScope: scope ?? null }),
  refreshRoutines: async () => {
    try {
      const routines = await api.listRoutines();
      set((s) => ({ routines, routinesTick: s.routinesTick + 1 }));
    } catch {
      // Keep the last known list; the next change event refetches.
    }
  },
  setSelectedRoutine: (id) => set({ selectedRoutine: id }),
  setScheduleOpen: (open) => set({ scheduleOpen: open }),
  newRoutine: () => set((s) => ({ view: "routines", selectedRoutine: "new", previousView: s.view === "settings" ? s.previousView : "routines" })),

  openSettings: () => set((s) => (s.view === "settings" ? s : { view: "settings", previousView: s.view })),
  closeSettings: () => set((s) => (s.view === "settings" ? { view: s.previousView } : s)),

  updateSettings: async (patch) => {
    const before = get().settings;
    // Optimistic so toggles feel instant; the validated copy from the backend replaces it.
    if (before) set({ settings: { ...before, ...patch } });
    try {
      set({ settings: await api.updateSettings(patch) });
      return true;
    } catch (e) {
      if (before) set({ settings: before });
      get().setError(String(e));
      return false;
    }
  },

  dismiss: async (id) => {
    try {
      const dismissedSeq = await api.dismissWorkspace(id);
      patchWorkspace(id, { dismissedSeq });
    } catch (e) {
      get().setError(String(e));
    }
  },

  compactSession: async (id) => {
    try {
      await api.compactSession(id);
    } catch (e) {
      get().setError(String(e));
    }
  },

  newSession: async (id) => {
    try {
      await api.newSession(id);
    } catch (e) {
      get().setError(String(e));
    }
  },

  addRepo: async (path) => {
    const repo = await api.addRepo(path);
    set((s) => ({
      repos: s.repos.some((r) => r.id === repo.id)
        ? s.repos
        : [...s.repos, repo].sort((a, b) => a.name.localeCompare(b.name)),
    }));
    return repo;
  },

  refreshChanges: async (id) => {
    try {
      const files = await api.workspaceChanges(id);
      set((s) => ({ changes: { ...s.changes, [id]: files } }));
    } catch {
      // Worktree may have been removed outside the app; keep the last known state.
    }
  },

  refreshPr: async (id) => {
    try {
      const pr = await api.prStatus(id);
      set((s) => ({ prs: { ...s.prs, [id]: pr } }));
    } catch {
      // gh missing/unauthenticated or no remote: leave the PR section empty.
      set((s) => ({ prs: { ...s.prs, [id]: null } }));
    }
  },

  refreshAttachments: async (workspaceId) => {
    try {
      const list = await api.listAttachments(workspaceId);
      set((s) => ({ attachments: { ...s.attachments, [workspaceId]: list } }));
    } catch {
      // Keep the last known chips; the next change refetches.
    }
  },

  refreshRelated: async (workspaceId) => {
    try {
      const found = await api.discoverRelated(workspaceId);
      set((s) => ({ related: { ...s.related, [workspaceId]: found } }));
    } catch {
      // Discovery is a nicety: no suggestions beats an error toast.
    }
  },

  attachFolder: async (workspaceId, path) => {
    try {
      await api.attachFolder(workspaceId, path);
      await get().refreshAttachments(workspaceId);
      void get().refreshRelated(workspaceId);
    } catch (e) {
      get().setError(String(e));
    }
  },

  detachFolder: async (workspaceId, id) => {
    try {
      await api.detachFolder(id);
      await get().refreshAttachments(workspaceId);
      void get().refreshRelated(workspaceId);
    } catch (e) {
      get().setError(String(e));
    }
  },

  setAttachmentEditable: async (workspaceId, id, editable) => {
    try {
      await api.setAttachmentEditable(id, editable);
    } catch (e) {
      get().setError(String(e));
    }
    await get().refreshAttachments(workspaceId);
  },

  setRelatedDefault: async (repoId, path, enabled) => {
    try {
      await api.setRelatedDefault(repoId, path, enabled);
      const paths = await api.getRelatedDefaults(repoId);
      set((s) => ({ relatedDefaults: { ...s.relatedDefaults, [repoId]: paths } }));
    } catch (e) {
      get().setError(String(e));
    }
  },

  setRelatedOpen: (open) => set({ relatedOpen: open }),

  loadSkills: async () => {
    const [packs, skills, pins, profiles] = await Promise.all([
      api.listPacks(),
      api.listSkills(),
      api.getPins(),
      api.listProfiles(),
    ]);
    set({ packs, skills, pins, profiles });
  },

  setProfile: async (workspaceId, profile) => {
    try {
      get().upsertWorkspace(await api.setWorkspaceProfile(workspaceId, profile));
      return true;
    } catch (e) {
      get().setError(String(e));
      return false;
    }
  },

  togglePin: async (skillId) => {
    const pins = get().pins.includes(skillId) ? get().pins.filter((p) => p !== skillId) : [...get().pins, skillId];
    set({ pins });
    await api.setPins(pins);
  },

  runSkill: async (workspaceId, skillId, args = "") => {
    try {
      await api.runSkill(workspaceId, skillId, args);
    } catch (e) {
      get().setError(String(e));
    }
  },

  ship: async (workspaceId, anyway = false) => {
    if (get().shipping[workspaceId]) return;
    set((s) => ({ shipping: { ...s.shipping, [workspaceId]: true } }));
    try {
      const res = await api.prepareShip(workspaceId, anyway);
      if (!res.ok) {
        const cmd = res.checks?.command ?? "the check command";
        get().setError(`Checks failed (${cmd}). Fix them from the inbox, or Ship anyway.`);
        return;
      }
      await api.runSkill(workspaceId, "shipkit:ship", res.notes ?? "");
    } catch (e) {
      get().setError(String(e));
    } finally {
      set((s) => ({ shipping: { ...s.shipping, [workspaceId]: false } }));
    }
  },

  undoLastTurn: async (workspaceId) => {
    try {
      await api.undoLastTurn(workspaceId);
      void get().refreshChanges(workspaceId);
    } catch (e) {
      get().setError(String(e));
    }
  },

  syncNow: async (workspaceId) => {
    try {
      get().upsertWorkspace(await api.syncNow(workspaceId));
      void get().refreshChanges(workspaceId);
    } catch (e) {
      get().setError(String(e));
    }
  },

  overlaps: [],
  refreshOverlaps: async () => {
    try {
      set({ overlaps: await api.workspaceOverlaps() });
    } catch {
      // Overlap is a hint; keep the last known pairs.
    }
  },

  setPacksOpen: (open) => set({ packsOpen: open }),
  setNewWorkspaceOpen: (open) => set({ newWorkspaceOpen: open, ...(!open ? { newWorkspacePrefill: null } : {}) }),
  setTicketOpen: (open) => set({ ticketOpen: open }),
  snooze: async (id, until) => {
    try {
      get().upsertWorkspace(await api.snoozeWorkspace(id, until));
    } catch (e) {
      get().setError(String(e));
    }
  },
  setPaletteOpen: (open) => set(open ? { paletteOpen: true } : { paletteOpen: false, paletteScope: null }),
  setShipOpen: (open) => {
    writeFlag("shipOpen", open);
    set(open ? { shipOpen: true, simplifyOpen: false } : { shipOpen: false });
  },
  setSimplifyOpen: (open) => {
    set({ simplifyOpen: open });
    const id = get().selectedId;
    if (open && id) void get().loadSimplify(id);
  },
  loadSimplify: async (workspaceId) => {
    try {
      const st = await api.simplifyState(workspaceId);
      set((s) => ({ simplify: { ...s.simplify, [workspaceId]: st } }));
    } catch {
      // Only a convenience on open; the next event fills it in.
    }
  },
  simplifyFind: async (workspaceId) => {
    try {
      const st = await api.simplifyFind(workspaceId);
      set((s) => ({ simplify: { ...s.simplify, [workspaceId]: st } }));
    } catch (e) {
      get().setError(String(e));
    }
  },
  simplifyApply: async (workspaceId, candidateIds) => {
    try {
      const st = await api.simplifyApply(workspaceId, candidateIds);
      set((s) => ({ simplify: { ...s.simplify, [workspaceId]: st } }));
    } catch (e) {
      get().setError(String(e));
    }
  },
  simplifyCancel: async (workspaceId) => {
    try {
      await api.simplifyCancel(workspaceId);
    } catch (e) {
      get().setError(String(e));
    }
  },
  setSidebarCollapsed: (collapsed) => {
    writeFlag("sidebarCollapsed", collapsed);
    set({ sidebarCollapsed: collapsed });
  },
  setFocusMode: (on) => set({ focusMode: on }),
  setError: (error) => set({ error }),

  upsertWorkspace: (ws) =>
    set((s) => {
      const exists = s.workspaces.some((w) => w.id === ws.id);
      return {
        workspaces: exists ? s.workspaces.map((w) => (w.id === ws.id ? ws : w)) : [ws, ...s.workspaces],
      };
    }),

  removeWorkspace: (id) =>
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),
}));

function patchWorkspace(id: string, patch: Partial<Workspace>) {
  useApp.setState((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
}

async function markSeen(id: string) {
  try {
    patchWorkspace(id, { seenSeq: await api.markSeen(id) });
  } catch {
    // Non-critical: the dot just stays until the next open.
  }
}

/** Apply one event to a workspace's summary without another IPC round trip. */
function foldSummary(prev: Summary | undefined, id: string, seq: number | null, ts: number, event: AgentEvent): Summary {
  const next: Summary = prev
    ? { ...prev }
    : {
        workspaceId: id,
        lastSeq: 0,
        lastActivityTs: ts,
        lastTurnSeq: 0,
        lastTurnError: null,
        lastTurnInterrupted: false,
        lastAssistantText: null,
        lastUserText: null,
        routineName: null,
      };
  if (seq !== null) {
    next.lastSeq = Math.max(next.lastSeq, seq);
    next.lastActivityTs = ts;
  }
  if (event.type === "message") next.lastAssistantText = event.text;
  else if (event.type === "userMessage") next.lastUserText = event.skill ? `/${event.skill} ${event.text}`.trim() : event.text;
  else if (event.type === "turnCompleted") {
    if (seq !== null) next.lastTurnSeq = seq;
    next.lastTurnError = event.isError ? (event.error ?? "Turn failed") : null;
    next.lastTurnInterrupted = !!event.interrupted;
  }
  return next;
}

function patchUsage(all: Record<string, WorkspaceUsage>, id: string, event: AgentEvent) {
  const next = applyUsage(all[id], id, event);
  return next && next !== all[id] ? { ...all, [id]: next } : all;
}

/** Simplify commits and reverts change the branch outside any tool result, so re-read the diff after each step. */
function onSimplify(st: SimplifyState) {
  const { getState: get, setState: set } = useApp;
  set((s) => ({ simplify: { ...s.simplify, [st.workspaceId]: st } }));
  if (st.phase === "applying" || st.phase === "done") {
    clearTimeout(changeTimers[st.workspaceId]);
    changeTimers[st.workspaceId] = window.setTimeout(() => void get().refreshChanges(st.workspaceId), 400);
  }
}

function onAgentEvent({ workspaceId: id, seq, ts, event }: AgentEventPayload) {
  const { getState: get, setState: set } = useApp;
  // Live tool-input previews are for the Code view's Watch mode (its own listener), not the chat or inbox.
  if (event.type === "toolDraft") return;
  if (event.type === "textDelta") {
    set((s) => ({ live: { ...s.live, [id]: (s.live[id] ?? "") + event.text } }));
    return;
  }
  const clearsLive = event.type === "message" || event.type === "turnCompleted" || event.type === "exited";
  set((s) => {
    const loaded = s.transcripts[id];
    return {
      // Only append to transcripts already loaded; unloaded ones fetch the full history on open.
      transcripts: loaded && seq !== null ? { ...s.transcripts, [id]: [...loaded, { seq, ts, event }] } : s.transcripts,
      live: clearsLive ? { ...s.live, [id]: "" } : s.live,
      summaries: { ...s.summaries, [id]: foldSummary(s.summaries[id], id, seq, ts, event) },
      usage: patchUsage(s.usage, id, event),
    };
  });
  // The workspace the user is looking at never counts as unread.
  if (
    event.type === "turnCompleted" &&
    get().selectedId === id &&
    get().view === "workspace" &&
    document.visibilityState === "visible"
  ) {
    void markSeen(id);
  }
  // File edits land via tool results; debounce the git query.
  if (event.type === "toolResult" || event.type === "turnCompleted") {
    clearTimeout(changeTimers[id]);
    changeTimers[id] = window.setTimeout(() => void get().refreshChanges(id), 400);
  }
  // Agents open and update PRs from inside turns.
  if (event.type === "turnCompleted") void get().refreshPr(id);
}

export function diffTotals(files: FileChange[] | undefined) {
  return (files ?? []).reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );
}
