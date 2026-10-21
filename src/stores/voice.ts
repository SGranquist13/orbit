// Voice input and read-aloud: dictation, push-to-talk, the hands-free loop, text-to-speech.
// The Rust side (src-tauri/src/voice/) records and transcribes; this store drives the loop around it.
import { create } from "zustand";
import { api, events, voiceApi, type VoiceDownload, type VoiceModel, type VoiceModelId, type VoiceResult, type VoiceState, type VoiceStatus } from "../lib/ipc";
import * as tts from "../lib/tts";
import { handsFreeNext, isStopWord, speakable, type HandsFreeEvent, type HandsFreeState } from "../lib/voice";
import { useApp } from "./app";

export type VoiceErrorKind = "noModel" | "noMic" | "blocked" | "other";
export interface VoiceError {
  kind: VoiceErrorKind;
  message: string;
  workspaceId: string | null;
}

/** Payload of the `orbit-voice-text` window event. The composer sets `handled` when it takes the text. */
export interface VoiceTextDetail {
  workspaceId: string;
  text: string;
  handled?: boolean;
}

interface VoiceStore {
  status: VoiceStatus;
  workspaceId: string | null;
  mode: "dictate" | "handsfree" | null;
  /** Microphone level 0..1 while listening. */
  level: number;
  error: VoiceError | null;
  models: VoiceModel[];
  downloads: Partial<Record<VoiceModelId, VoiceDownload>>;
  handsFree: { workspaceId: string | null; phase: HandsFreeState };
  /** Id of the assistant message being read aloud (or "reply" for hands-free speech). */
  speakingId: string | null;

  refreshModels: () => Promise<void>;
  download: (id: VoiceModelId) => Promise<void>;
  deleteModel: (id: VoiceModelId) => Promise<void>;
  clearError: () => void;
  toggleDictation: (workspaceId: string) => Promise<void>;
  startHold: (workspaceId: string) => void;
  endHold: () => void;
  /** True between a press of the dictate key and its release. */
  holding: () => boolean;
  cancel: () => Promise<void>;
  toggleHandsFree: (workspaceId: string) => Promise<void>;
  readAloud: (messageId: string, markdown: string) => void;
  readLastReply: (workspaceId: string) => void;
  stopSpeaking: () => void;
}

const HOLD_TAP_MS = 300;

export const useVoice = create<VoiceStore>((set, get) => ({
  status: "idle",
  workspaceId: null,
  mode: null,
  level: 0,
  error: null,
  models: [],
  downloads: {},
  handsFree: { workspaceId: null, phase: "off" },
  speakingId: null,

  refreshModels: async () => {
    try {
      set({ models: await voiceApi.models() });
    } catch {
      /* the settings page shows an empty list */
    }
  },

  download: async (id) => {
    const total = get().models.find((m) => m.id === id)?.sizeBytes ?? 0;
    set((s) => ({ downloads: { ...s.downloads, [id]: { id, received: 0, total } }, error: s.error?.kind === "noModel" ? null : s.error }));
    try {
      await voiceApi.download(id);
      set((s) => {
        const { [id]: _done, ...rest } = s.downloads;
        return { downloads: rest };
      });
    } catch (e) {
      set((s) => ({ downloads: { ...s.downloads, [id]: { id, received: 0, total, error: errorText(e) } } }));
    }
    await get().refreshModels();
  },

  deleteModel: async (id) => {
    try {
      await voiceApi.deleteModel(id);
    } catch (e) {
      useApp.getState().setError(errorText(e));
    }
    await get().refreshModels();
  },

  clearError: () => set({ error: null }),

  toggleDictation: async (workspaceId) => {
    const s = get();
    if (s.status === "listening" && s.mode === "dictate") return stopDictation();
    if (s.status !== "idle" && s.status !== "error") return;
    if (s.handsFree.phase !== "off") return;
    await startDictation(workspaceId);
  },

  startHold: (workspaceId) => {
    if (holdAt !== null) return; // key auto-repeat
    holdAt = Date.now();
    const s = get();
    if (s.status === "listening" && s.mode === "dictate") {
      // A tap earlier toggled recording on; this press toggles it off.
      holdSwallow = true;
      void stopDictation();
      return;
    }
    holdSwallow = false;
    if ((s.status === "idle" || s.status === "error") && s.handsFree.phase === "off") void startDictation(workspaceId);
  },

  endHold: () => {
    if (holdAt === null) return;
    const held = Date.now() - holdAt;
    holdAt = null;
    if (holdSwallow) {
      holdSwallow = false;
      return;
    }
    // A tap leaves recording on (toggle); a hold is push-to-talk and ends on release.
    if (held >= HOLD_TAP_MS) void stopDictation();
  },

  holding: () => holdAt !== null,

  cancel: async () => {
    if (get().handsFree.phase !== "off") return stopHandsFree();
    try {
      await voiceApi.cancel();
    } catch {
      /* already idle */
    }
    set({ status: "idle", level: 0 });
  },

  toggleHandsFree: async (workspaceId) => {
    if (get().handsFree.phase !== "off") return stopHandsFree();
    const s = get();
    if (s.status !== "idle" && s.status !== "error") return;
    hfToken++;
    set({ handsFree: { workspaceId, phase: "listening" }, error: null });
    try {
      await voiceApi.start(workspaceId, "handsfree");
    } catch (e) {
      fail(e, workspaceId);
      hfSet({ type: "error" });
    }
  },

  readAloud: (messageId, markdown) => {
    if (get().speakingId === messageId) return get().stopSpeaking();
    const text = speakable(markdown);
    if (!text) return;
    void speakAloud(text, messageId);
  },

  readLastReply: (workspaceId) => {
    const text = lastReply[workspaceId] ?? lastAssistantText(workspaceId);
    if (text) get().readAloud("reply", text);
  },

  stopSpeaking: () => {
    set({ speakingId: null });
    tts.cancel();
  },
}));

// ── internals ──

let holdAt: number | null = null;
let holdSwallow = false;
let starting: Promise<void> | null = null;
/** Bumped whenever hands-free starts or stops, so stale async continuations bail out. */
let hfToken = 0;
/** The most recent finished assistant message per workspace, from the agent event stream. */
const lastReply: Record<string, string> = {};

function errorText(e: unknown): string {
  return String(e).replace(/^Error:\s*/, "");
}

function classify(message: string): VoiceErrorKind {
  if (message.startsWith("no model")) return "noModel";
  if (message.startsWith("microphone blocked")) return "blocked";
  if (message.startsWith("no microphone")) return "noMic";
  return "other";
}

function fail(e: unknown, workspaceId: string | null) {
  const message = errorText(e);
  useVoice.setState({ error: { kind: classify(message), message, workspaceId }, status: "idle", level: 0 });
}

function hfSet(event: HandsFreeEvent) {
  useVoice.setState((s) => {
    const phase = handsFreeNext(s.handsFree.phase, event);
    return { handsFree: { workspaceId: phase === "off" ? null : s.handsFree.workspaceId, phase } };
  });
}

function startDictation(workspaceId: string): Promise<void> {
  useVoice.setState({ error: null });
  starting = voiceApi
    .start(workspaceId, "dictate")
    .catch((e) => fail(e, workspaceId))
    .finally(() => {
      starting = null;
    });
  return starting;
}

async function stopDictation() {
  await starting;
  if (useVoice.getState().status !== "listening") return;
  try {
    const result = await voiceApi.stop();
    deliver(result);
  } catch (e) {
    fail(e, useVoice.getState().workspaceId);
  }
}

/** Hands the transcript to the composer; if none is mounted for that workspace, it lands in the draft. */
function deliver(r: VoiceResult) {
  if (!r.workspaceId) return;
  if (!r.text.trim()) {
    useVoice.setState({ error: { kind: "other", message: "Didn't catch anything. Try again closer to the microphone.", workspaceId: r.workspaceId } });
    return;
  }
  const detail: VoiceTextDetail = { workspaceId: r.workspaceId, text: r.text };
  window.dispatchEvent(new CustomEvent<VoiceTextDetail>("orbit-voice-text", { detail }));
  if (!detail.handled) {
    const key = `draft:${r.workspaceId}`;
    try {
      const draft = sessionStorage.getItem(key) ?? "";
      sessionStorage.setItem(key, draft && !/\s$/.test(draft) ? `${draft} ${r.text.trim()}` : draft + r.text.trim());
    } catch {
      /* storage unavailable */
    }
  }
}

async function stopHandsFree() {
  hfToken++;
  hfSet({ type: "stop" });
  tts.cancel();
  useVoice.setState({ speakingId: null });
  try {
    await voiceApi.cancel();
  } catch {
    /* idle already */
  }
  useVoice.setState({ status: "idle", level: 0 });
}

/** (Re)opens the mic for the hands-free loop; retries once because Rust may still be finishing the last utterance. */
async function listenAgain(workspaceId: string, token = hfToken) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (token !== hfToken) return;
    try {
      await voiceApi.start(workspaceId, "handsfree");
      return;
    } catch (e) {
      if (String(e).includes("busy") && attempt < 2) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      fail(e, workspaceId);
      hfSet({ type: "error" });
      return;
    }
  }
}

async function speakAloud(text: string, id: string): Promise<void> {
  const s = useApp.getState().settings;
  tts.cancel();
  useVoice.setState({ speakingId: id });
  await tts.speak(text, { voice: s?.voiceTtsVoice || undefined, rate: s?.voiceTtsRate });
  if (useVoice.getState().speakingId === id) useVoice.setState({ speakingId: null });
}

async function onHandsFreeResult(r: VoiceResult) {
  const hf = useVoice.getState().handsFree;
  if (hf.phase === "off" || hf.workspaceId !== r.workspaceId) return;
  const token = hfToken;
  const text = r.text.trim();
  if (text && isStopWord(text)) {
    void useApp.getState().interrupt(r.workspaceId);
    hfSet({ type: "result", text });
    return void listenAgain(r.workspaceId, token);
  }
  hfSet({ type: "result", text });
  if (!text) return void listenAgain(r.workspaceId, token);
  try {
    // While the agent works (phase waiting) the dictated text steers the running turn.
    await api.sendMessage(r.workspaceId, text);
  } catch (e) {
    useApp.getState().setError(errorText(e));
    hfSet({ type: "error" });
    return;
  }
  if (token !== hfToken) return;
  hfSet({ type: "sent" });
  // Keep the mic open while waiting so "stop" can interrupt the agent.
  void listenAgain(r.workspaceId, token);
}

async function onTurnCompleted(workspaceId: string, interrupted: boolean, isError: boolean) {
  const store = useVoice.getState();
  const settings = useApp.getState().settings;
  const text = lastReply[workspaceId] ?? "";
  const mode = settings?.voiceReadAloud ?? "off";
  const speakIt = !interrupted && !isError && !!text && mode !== "off";

  if (store.handsFree.phase === "waiting" && store.handsFree.workspaceId === workspaceId) {
    const token = hfToken;
    hfSet({ type: "turnCompleted", text: speakIt ? text : "" });
    if (!speakIt) return; // the mic is already open from the wait
    // The mic is never open while speaking.
    try {
      await voiceApi.cancel();
    } catch {
      /* ignore */
    }
    useVoice.setState({ status: "idle", level: 0 });
    await speakAloud(speakable(text), "reply");
    if (token !== hfToken) return;
    hfSet({ type: "spoken" });
    await listenAgain(workspaceId, token);
    return;
  }

  if (mode === "always" && speakIt && store.handsFree.phase === "off") {
    const app = useApp.getState();
    if (app.selectedId === workspaceId && app.view === "workspace") void speakAloud(speakable(text), "reply");
  }
}

function lastAssistantText(workspaceId: string): string | null {
  const rows = useApp.getState().transcripts[workspaceId] ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const ev = rows[i].event;
    if (ev.type === "message" && ev.text.trim()) return ev.text;
  }
  return null;
}

let started = false;
/** Subscribes to the voice and agent events once. Safe to call repeatedly. */
export function initVoice() {
  if (started) return;
  started = true;
  void useVoice.getState().refreshModels();

  void events.onVoiceState((s: VoiceState) => {
    useVoice.setState((cur) => ({
      status: s.status,
      workspaceId: s.workspaceId ?? null,
      mode: s.mode ?? null,
      level: s.status === "listening" ? cur.level : 0,
      ...(s.status === "error" ? { error: { kind: classify(s.error ?? ""), message: s.error ?? "Voice input failed", workspaceId: s.workspaceId ?? cur.workspaceId } } : {}),
    }));
    const phase = useVoice.getState().handsFree.phase;
    if (phase !== "off" && s.status === "error") {
      hfToken++;
      hfSet({ type: "error" });
    } else if (phase === "listening" && (s.status === "transcribing" || s.status === "tidying") && s.mode === "handsfree") {
      hfSet({ type: "transcribing" });
    }
  });
  void events.onVoiceLevel((rms) => {
    if (useVoice.getState().status === "listening") useVoice.setState({ level: rms });
  });
  void events.onVoiceDownload((d) => {
    useVoice.setState((s) => {
      if (d.done) {
        const { [d.id]: _gone, ...rest } = s.downloads;
        return { downloads: rest };
      }
      return { downloads: { ...s.downloads, [d.id]: d } };
    });
    if (d.done) void useVoice.getState().refreshModels();
  });
  void events.onVoiceResult((r) => void onHandsFreeResult(r));
  void events.onAgentEvent(({ workspaceId, event }) => {
    if (event.type === "turnStarted") delete lastReply[workspaceId];
    else if (event.type === "message" && event.text.trim()) lastReply[workspaceId] = event.text;
    else if (event.type === "turnCompleted") void onTurnCompleted(workspaceId, !!event.interrupted, event.isError);
  });
}
