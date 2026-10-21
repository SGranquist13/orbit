// Voice input and read-aloud: dictation, push-to-talk, the hands-free loop, text-to-speech.
// Capture and speech happen in this webview (echo-cancelled mic, Silero VAD, Kokoro); Rust only transcribes
// (Whisper), downloads model packs and serves their files. The pure decisions live in lib/voice.ts (`hfReduce`).
import { create } from "zustand";
import { api, events, voiceApi, type VoiceDownload, type VoiceModel, type VoiceModelId, type VoiceResult } from "../lib/ipc";
import * as tts from "../lib/tts";
import {
  classifyUtterance,
  f32ToBase64,
  handsFreePhase,
  hfInitial,
  hfReduce,
  speakable,
  type HandsFreePhase,
  type HfEffect,
  type HfEvent,
  type HfState,
} from "../lib/voice";
import { MicError, startRecorder, type Recorder } from "../lib/voice/mic";
import { startVad, type VadHandle } from "../lib/voice/vad";
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

/** What the hands-free bar says about the last thing it heard. */
export interface Heard {
  kind: "sent" | "stop" | "missed" | "error";
  text: string;
  at: number;
}

interface VoiceStore {
  /** Dictation: idle -> listening (recording) -> transcribing -> idle. */
  status: "idle" | "listening" | "transcribing" | "error";
  workspaceId: string | null;
  mode: "dictate" | null;
  /** Microphone level 0..1 while recording or in hands-free. */
  level: number;
  error: VoiceError | null;
  models: VoiceModel[];
  downloads: Partial<Record<VoiceModelId, VoiceDownload>>;
  handsFree: { workspaceId: string | null; phase: HandsFreePhase; heard: Heard | null };
  /** Id of the assistant message being read aloud (or "reply" for hands-free speech). */
  speakingId: string | null;
  /** Set when the natural voice was wanted but is not downloaded: a notice offers the download. */
  kokoroMissing: boolean;

  refreshModels: () => Promise<void>;
  download: (id: VoiceModelId) => Promise<void>;
  deleteModel: (id: VoiceModelId) => Promise<void>;
  clearError: () => void;
  dismissKokoroMissing: () => void;
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
/** Dictation shorter than this is not worth sending to Whisper. */
const MIN_DICTATION_SAMPLES = 16000 * 0.3;
const HEARD_MS = 5000;
const MISSED_MS = 2000;

const log = (...args: unknown[]) => console.debug("[voice]", ...args);

export const useVoice = create<VoiceStore>((set, get) => ({
  status: "idle",
  workspaceId: null,
  mode: null,
  level: 0,
  error: null,
  models: [],
  downloads: {},
  handsFree: { workspaceId: null, phase: "off", heard: null },
  speakingId: null,
  kokoroMissing: false,

  refreshModels: async () => {
    try {
      set({ models: await voiceApi.models() });
    } catch {
      /* the settings page shows an empty list */
    }
  },

  download: async (id) => {
    const total = get().models.find((m) => m.id === id)?.sizeBytes ?? 0;
    set((s) => ({
      downloads: { ...s.downloads, [id]: { id, received: 0, total } },
      error: s.error?.kind === "noModel" ? null : s.error,
      kokoroMissing: id === "kokoro" ? false : s.kokoroMissing,
    }));
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
      if (id === "kokoro") tts.unloadKokoro();
    } catch (e) {
      useApp.getState().setError(errorText(e));
    }
    await get().refreshModels();
  },

  clearError: () => set({ error: null }),
  dismissKokoroMissing: () => set({ kokoroMissing: false }),

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
    if (hf) return stopHandsFree();
    await starting;
    recorder?.cancel();
    recorder = null;
    set({ status: "idle", level: 0, mode: null, workspaceId: null });
  },

  toggleHandsFree: async (workspaceId) => {
    if (hf) return stopHandsFree();
    const s = get();
    if (s.status !== "idle" && s.status !== "error") return;
    await startHandsFree(workspaceId);
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
    speechSeq++;
    tts.stop();
  },
}));

// ── internals ──

let holdAt: number | null = null;
let holdSwallow = false;
let starting: Promise<void> | null = null;
let recorder: Recorder | null = null;
/** The most recent finished assistant message per workspace, from the agent event stream. */
const lastReply: Record<string, string> = {};

function errorText(e: unknown): string {
  return String(e).replace(/^Error:\s*/, "");
}

function classify(e: unknown): VoiceErrorKind {
  if (e instanceof MicError) return e.kind;
  return errorText(e).startsWith("no model") ? "noModel" : "other";
}

function fail(e: unknown, workspaceId: string | null) {
  const message = e instanceof MicError ? e.message : errorText(e);
  log("error", message);
  useVoice.setState({ error: { kind: classify(e), message, workspaceId }, status: "idle", mode: null, level: 0 });
}

/** Level updates at most ~20 per second. */
let levelAt = 0;
function pushLevel(rms: number) {
  const now = performance.now();
  if (now - levelAt < 50) return;
  levelAt = now;
  useVoice.setState({ level: rms });
}

// ── dictation ──

function startDictation(workspaceId: string): Promise<void> {
  useVoice.setState({ error: null, workspaceId, mode: "dictate" });
  const deviceId = useApp.getState().settings?.voiceDevice ?? "";
  starting = startRecorder(deviceId, pushLevel)
    .then((r) => {
      recorder = r;
      useVoice.setState({ status: "listening" });
      log("dictation: recording");
    })
    .catch((e) => fail(e, workspaceId))
    .finally(() => {
      starting = null;
    });
  return starting;
}

async function stopDictation(): Promise<void> {
  await starting;
  const rec = recorder;
  if (!rec || useVoice.getState().status !== "listening") return;
  recorder = null;
  const workspaceId: string = useVoice.getState().workspaceId ?? "";
  useVoice.setState({ status: "transcribing", level: 0 });
  try {
    const audio = await rec.stop();
    log("dictation: stopped", { seconds: +(audio.length / 16000).toFixed(2) });
    if (audio.length < MIN_DICTATION_SAMPLES) return deliver({ workspaceId, text: "", raw: "", dropped: true });
    deliver(await voiceApi.transcribe(workspaceId, f32ToBase64(audio), "dictate"));
  } catch (e) {
    fail(e, workspaceId);
  } finally {
    if (useVoice.getState().status === "transcribing") useVoice.setState({ status: "idle", mode: null, workspaceId: null, level: 0 });
  }
}

/** Hands the transcript to the composer; if none is mounted for that workspace, it lands in the draft. */
function deliver(r: VoiceResult) {
  if (!r.workspaceId) return;
  if (r.dropped || !r.text.trim()) {
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

// ── hands-free ──

interface HandsFree {
  token: number;
  workspaceId: string;
  state: HfState;
  vad: VadHandle | null;
}
let hf: HandsFree | null = null;
let hfToken = 0;
/** Bumped whenever speech starts or is cut, so a finished (or cancelled) utterance cannot touch a newer one. */
let speechSeq = 0;

function syncHandsFree() {
  if (!hf) return;
  const phase = handsFreePhase(hf.state);
  useVoice.setState((s) => (s.handsFree.phase === phase && s.handsFree.workspaceId === hf!.workspaceId ? s : { handsFree: { ...s.handsFree, workspaceId: hf!.workspaceId, phase } }));
}

function setHeard(kind: Heard["kind"], text: string, ms: number) {
  const heard: Heard = { kind, text, at: Date.now() };
  useVoice.setState((s) => ({ handsFree: { ...s.handsFree, heard } }));
  setTimeout(() => {
    useVoice.setState((s) => (s.handsFree.heard === heard ? { handsFree: { ...s.handsFree, heard: null } } : s));
  }, ms);
}

function hfDispatch(event: HfEvent, token: number) {
  if (!hf || hf.token !== token) return;
  const before = hf.state;
  const { state, effects } = hfReduce(before, event);
  hf.state = state;
  log("hands-free", event.type, "->", handsFreePhase(state), effects.map((e) => e.type));
  syncHandsFree();
  for (const effect of effects) runEffect(effect, hf.workspaceId, token);
}

function runEffect(effect: HfEffect, workspaceId: string, token: number) {
  switch (effect.type) {
    case "stopSpeech":
      speechSeq++;
      tts.stop();
      useVoice.setState({ speakingId: null });
      break;
    case "interrupt":
      void useApp.getState().interrupt(workspaceId);
      break;
    case "send":
      void api.sendMessage(workspaceId, effect.text).catch((e) => {
        useApp.getState().setError(errorText(e));
        setHeard("error", errorText(e), HEARD_MS);
        hfDispatch({ type: "sendFailed" }, token);
      });
      break;
    case "speak": {
      const id = ++speechSeq;
      void speakAloud(effect.text, "reply").finally(() => {
        if (id === speechSeq) hfDispatch({ type: "speechDone" }, token);
      });
      break;
    }
  }
}

async function startHandsFree(workspaceId: string) {
  const token = ++hfToken;
  const settings = useApp.getState().settings;
  const run: HandsFree = { token, workspaceId, state: hfReduce(hfInitial, { type: "start" }).state, vad: null };
  hf = run;
  useVoice.setState({ error: null, handsFree: { workspaceId, phase: "listening", heard: null } });
  log("hands-free: starting", { silenceMs: settings?.voiceSilenceMs, minSpeechMs: settings?.voiceMinSpeechMs, bargeIn: settings?.voiceBargeIn });
  try {
    run.vad = await startVad({
      deviceId: settings?.voiceDevice ?? "",
      silenceMs: settings?.voiceSilenceMs ?? 1500,
      minSpeechMs: settings?.voiceMinSpeechMs ?? 400,
      onLevel: (rms) => hf?.token === token && pushLevel(rms),
      onSpeechStart: () => {
        const bargeIn = useApp.getState().settings?.voiceBargeIn ?? true;
        // Also covers a read-aloud started by hand while hands-free is on.
        if (bargeIn && tts.speaking()) {
          speechSeq++;
          tts.stop();
          useVoice.setState({ speakingId: null });
        }
        hfDispatch({ type: "speechStart", bargeIn }, token);
      },
      onMisfire: () => hfDispatch({ type: "speechMisfire" }, token),
      onSpeechEnd: (audio) => {
        if (!hf || hf.token !== token) return;
        const before = hf.state.transcribing;
        hfDispatch({ type: "speechEnd" }, token);
        if (hf && hf.token === token && hf.state.transcribing > before) void transcribeUtterance(audio, token);
      },
    });
    if (hf?.token !== token) {
      // stopped while the microphone was still opening
      await run.vad.destroy().catch(() => {});
      return;
    }
    log("hands-free: listening");
  } catch (e) {
    if (hf?.token === token) {
      hf = null;
      fail(e, workspaceId);
      useVoice.setState({ handsFree: { workspaceId: null, phase: "off", heard: null } });
    }
  }
}

async function transcribeUtterance(audio: Float32Array, token: number) {
  const workspaceId = hf?.workspaceId;
  if (!workspaceId) return;
  try {
    const started = performance.now();
    const r = await voiceApi.transcribe(workspaceId, f32ToBase64(audio), "handsfree");
    if (!hf || hf.token !== token) return;
    const kind = classifyUtterance(r.text, r.dropped);
    log("hands-free: heard", { kind, ms: Math.round(performance.now() - started), seconds: +(audio.length / 16000).toFixed(2), text: r.text, raw: r.raw });
    if (kind === "send") setHeard("sent", r.text.trim(), HEARD_MS);
    else if (kind === "stop") setHeard("stop", r.text.trim(), HEARD_MS);
    else setHeard("missed", "", MISSED_MS);
    hfDispatch({ type: "transcribed", text: r.text, dropped: r.dropped }, token);
  } catch (e) {
    if (!hf || hf.token !== token) return;
    // An inline message, never the end of the loop: the mic and the detector keep running.
    log("hands-free: transcription failed", errorText(e));
    useVoice.setState({ error: { kind: classify(e), message: errorText(e), workspaceId } });
    hfDispatch({ type: "transcribeFailed" }, token);
  }
}

async function stopHandsFree(): Promise<void> {
  const run = hf;
  if (!run) return;
  hf = null;
  hfToken++;
  log("hands-free: stopping");
  speechSeq++;
  tts.stop();
  useVoice.setState({ handsFree: { workspaceId: null, phase: "off", heard: null }, speakingId: null, level: 0 });
  try {
    await run.vad?.destroy();
  } catch (e) {
    log("hands-free: vad teardown failed", errorText(e));
  }
}

// ── read aloud ──

async function speakAloud(text: string, id: string): Promise<void> {
  const s = useApp.getState().settings;
  useVoice.setState({ speakingId: id });
  try {
    const r = await tts.speak(text, {
      engine: s?.voiceTtsEngine ?? "kokoro",
      kokoroVoice: s?.voiceKokoroVoice,
      systemVoice: s?.voiceTtsVoice,
      speed: s?.voiceTtsRate,
    });
    if (r.fellBack?.notInstalled) useVoice.setState({ kokoroMissing: true });
  } catch (e) {
    log("speech failed", errorText(e));
  } finally {
    if (useVoice.getState().speakingId === id) useVoice.setState({ speakingId: null });
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

function onTurnCompleted(workspaceId: string, interrupted: boolean, isError: boolean) {
  const app = useApp.getState();
  const mode = app.settings?.voiceReadAloud ?? "off";
  const text = lastReply[workspaceId] ? speakable(lastReply[workspaceId]) : "";
  const speakIt = !interrupted && !isError && !!text && mode !== "off";
  if (hf && hf.workspaceId === workspaceId) {
    hfDispatch({ type: "turnCompleted", reply: speakIt ? text : null }, hf.token);
    return;
  }
  if (mode === "always" && speakIt && !hf && app.selectedId === workspaceId && app.view === "workspace") void speakAloud(text, "reply");
}

let started = false;
/** Subscribes to download and agent events once. Safe to call repeatedly. */
export function initVoice() {
  if (started) return;
  started = true;
  void useVoice.getState().refreshModels();

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
  void events.onAgentEvent(({ workspaceId, event }) => {
    if (event.type === "turnStarted") {
      delete lastReply[workspaceId];
      if (hf && hf.workspaceId === workspaceId) hfDispatch({ type: "turnStarted" }, hf.token);
    } else if (event.type === "message" && event.text.trim()) lastReply[workspaceId] = event.text;
    else if (event.type === "turnCompleted") onTurnCompleted(workspaceId, !!event.interrupted, event.isError);
  });
}

// Dev builds only: lets the mock UI drive the voice states from the console.
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __orbitVoice?: typeof useVoice }).__orbitVoice = useVoice;
