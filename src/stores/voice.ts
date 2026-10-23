// Voice input and read-aloud: dictation, push-to-talk, the hands-free loop, text-to-speech.
// Capture and speech happen in this webview (echo-cancelled mic, Silero VAD, Kokoro); Rust only transcribes
// (Whisper), downloads model packs and serves their files. The pure decisions live in lib/voice.ts (`hfReduce`).
import { create } from "zustand";
import { api, events, voiceApi, type VoiceDownload, type VoiceModel, type VoiceModelId, type VoiceResult } from "../lib/ipc";
import * as tts from "../lib/tts";
import {
  classifyUtterance,
  needsSetup,
  type VoiceSetupAction,
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
  setup: { then?: () => void } | null;
  setupLoading: boolean;
  setupError: string | null;
  openSetup: (then?: () => void) => void;
  closeSetup: (complete?: boolean) => void;
  ensureSetup: (then?: () => void, action?: VoiceSetupAction) => boolean;

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
/** Dictation shorter than this is not worth sending to Whisper. */
const MIN_DICTATION_SAMPLES = 16000 * 0.3;
const HEARD_MS = 5000;
const MISSED_MS = 2000;

const log = (...args: unknown[]) => console.debug("[voice]", ...args);

let setupDismissed = false;

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
  setup: null,
  setupLoading: false,
  setupError: null,

  openSetup: (then) => {
    if (get().setup) return;
    set({ setup: { then }, setupLoading: true, setupError: null });
    void get().refreshModels().finally(() => set({ setupLoading: false }));
  },
  closeSetup: (complete = false) => {
    const then = get().setup?.then;
    setupDismissed = true;
    // Choosing a subset is also a decision to keep the system voice.
    try { localStorage.setItem("orbit.voice.setupDismissed", "1"); } catch { /* storage unavailable */ }
    set({ setup: null });
    if (complete) then?.();
  },
  ensureSetup: (then, action = "dictate") => {
    if (get().setup) return false;
    const models = get().models;
    const model = useApp.getState().settings?.voiceModel ?? "base.en";
    let dismissed = setupDismissed;
    try { dismissed ||= localStorage.getItem("orbit.voice.setupDismissed") === "1"; } catch { /* storage unavailable */ }
    if (!needsSetup({ sttInstalled: !!models.find((m) => m.id === model)?.installed,
      ttsInstalled: !!models.find((m) => m.id === "kokoro")?.installed, dismissed, action })) return true;
    get().openSetup(then);
    return false;
  },

  refreshModels: async () => {
    try {
      set({ models: await voiceApi.models(), setupError: null });
    } catch (e) {
      set({ setupError: errorText(e) });
    }
  },

  download: async (id) => {
    if (get().downloads[id] && !get().downloads[id]?.error) return;
    const total = get().models.find((m) => m.id === id)?.sizeBytes ?? 0;
    set((s) => ({
      downloads: { ...s.downloads, [id]: { id, received: 0, total } },
      error: s.error?.kind === "noModel" ? null : s.error,
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

  toggleDictation: async (workspaceId) => {
    const s = get();
    if (s.status === "listening" && s.mode === "dictate") return stopDictation();
    if (s.status !== "idle" && s.status !== "error") return;
    if (s.handsFree.phase !== "off") return;
    if (!s.ensureSetup(() => { void get().toggleDictation(workspaceId); })) return;
    await startDictation(workspaceId);
  },

  startHold: (workspaceId) => {
    if (holdAt !== null) return; // key auto-repeat
    const s = get();
    if (s.status !== "listening" && !s.ensureSetup(() => { void get().toggleDictation(workspaceId); })) return;
    holdAt = Date.now();
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
    if (!s.ensureSetup(() => { void get().toggleHandsFree(workspaceId); }, "handsfree")) return;
    await startHandsFree(workspaceId);
  },

  readAloud: (messageId, markdown) => {
    if (get().speakingId === messageId) return get().stopSpeaking();
    const text = speakable(markdown);
    if (!text) return;
    if (!get().ensureSetup(() => { void speakAloud(text, messageId); }, "readAloud")) return;
    void speakAloud(text, messageId);
  },

  readLastReply: (workspaceId) => {
    const text = lastReply[workspaceId] ?? lastAssistantText(workspaceId);
    if (text) get().readAloud("reply", text);
  },

  stopSpeaking: () => {
    cancelReplyStream();
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
  const kind = classify(e);
  useVoice.setState({ error: kind === "noModel" ? null : { kind, message, workspaceId }, status: "idle", mode: null, level: 0 });
  if (kind === "noModel") useVoice.getState().openSetup(workspaceId ? () => { void useVoice.getState().toggleDictation(workspaceId); } : undefined);
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
  syncStreamHold();
}

function runEffect(effect: HfEffect, workspaceId: string, token: number) {
  switch (effect.type) {
    case "stopSpeech":
      cancelReplyStream();
      speechSeq++;
      tts.stop();
      useVoice.setState({ speakingId: null });
      break;
    case "interrupt":
      cancelReplyStream();
      void useApp.getState().interrupt(workspaceId);
      break;
    case "send":
      cancelReplyStream();
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
  cancelReplyStream();
  const token = ++hfToken;
  const settings = useApp.getState().settings;
  if ((settings?.voiceTtsEngine ?? "kokoro") === "kokoro") tts.warmup();
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
        if (bargeIn && (replyStream?.speaking || (!replyStream && tts.speaking()))) {
          cancelReplyStream();
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
    // A missing model pauses the loop for setup; other transcription errors stay inline.
    log("hands-free: transcription failed", errorText(e));
    if (classify(e) === "noModel") {
      await stopHandsFree();
      useVoice.getState().openSetup(() => { void useVoice.getState().toggleHandsFree(workspaceId); });
      return;
    }
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
  cancelReplyStream();
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
    await tts.speak(text, {
      engine: s?.voiceTtsEngine ?? "kokoro",
      kokoroVoice: s?.voiceKokoroVoice,
      systemVoice: s?.voiceTtsVoice,
      speed: s?.voiceTtsRate,
    });
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

interface ReplyStream {
  workspaceId: string;
  stream: tts.SpeechStream;
  token?: number;
  speaking: boolean;
}
let replyStream: ReplyStream | null = null;
const turns = new Set<string>();
const mutedTurns = new Set<string>();
const streamedTurns = new Set<string>();

function cancelReplyStream() {
  const run = replyStream;
  if (!run) return;
  replyStream = null;
  mutedTurns.add(run.workspaceId);
  run.stream.cancel();
  useVoice.setState({ speakingId: null });
  if (run.token !== undefined) hfDispatch({ type: "speechDone" }, run.token);
}

function syncStreamHold() {
  const run = replyStream;
  if (!run) return;
  const state = run.token === hf?.token ? hf?.state : null;
  const held = !!state && (state.hearing || state.ignoring || state.transcribing > 0);
  run.stream.setHeld(held);
}

function canStream(workspaceId: string) {
  const app = useApp.getState();
  if ((app.settings?.voiceReadAloud ?? "off") === "off" || mutedTurns.has(workspaceId)) return false;
  return hf ? hf.workspaceId === workspaceId
    : app.settings?.voiceReadAloud === "always" && app.selectedId === workspaceId && app.view === "workspace";
}

function pushReply(workspaceId: string, text: string) {
  if (!turns.has(workspaceId) || !canStream(workspaceId)) return;
  if (replyStream && replyStream.workspaceId !== workspaceId) cancelReplyStream();
  if (!replyStream) {
    const s = useApp.getState().settings;
    const run: ReplyStream = {
      workspaceId, token: hf?.token, speaking: false,
      stream: tts.createStream({
        engine: s?.voiceTtsEngine, kokoroVoice: s?.voiceKokoroVoice,
        systemVoice: s?.voiceTtsVoice, speed: s?.voiceTtsRate,
        onSentence: () => { if (replyStream === run) syncStreamHold(); },
        onStart: () => {
          if (replyStream !== run) return;
          run.speaking = true;
          useVoice.setState({ speakingId: "reply" });
          if (run.token !== undefined) hfDispatch({ type: "speechStarted" }, run.token);
        },
      }),
    };
    replyStream = run;
    syncStreamHold();
    log("stream opened", { workspaceId });
    void run.stream.done.finally(() => {
      if (replyStream !== run) return;
      replyStream = null;
      useVoice.setState({ speakingId: null });
      if (run.token !== undefined) hfDispatch({ type: "speechDone" }, run.token);
    });
  }
  streamedTurns.add(workspaceId);
  replyStream.stream.push(text);
}

function onTurnCompleted(workspaceId: string, interrupted: boolean, isError: boolean) {
  if (interrupted || isError) {
    if (replyStream?.workspaceId === workspaceId) cancelReplyStream();
    if (hf?.workspaceId === workspaceId) hfDispatch({ type: "turnInterrupted" }, hf.token);
  } else {
    if (!streamedTurns.has(workspaceId) && lastReply[workspaceId]) pushReply(workspaceId, lastReply[workspaceId]);
    if (replyStream?.workspaceId === workspaceId) replyStream.stream.end();
    if (hf?.workspaceId === workspaceId) hfDispatch({ type: "turnCompleted", reply: null }, hf.token);
  }
  turns.delete(workspaceId);
}

let started = false;
/** Subscribes to download and agent events once. Safe to call repeatedly. */
export function initVoice() {
  if (started) return;
  started = true;
  void useVoice.getState().refreshModels();
  useApp.subscribe((app) => {
    if (replyStream && !hf && (app.selectedId !== replyStream.workspaceId || app.view !== "workspace")) cancelReplyStream();
    if (replyStream && app.settings?.voiceReadAloud === "off") cancelReplyStream();
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
  void events.onAgentEvent(({ workspaceId, event }) => {
    if (event.type === "turnStarted") {
      if (replyStream?.workspaceId === workspaceId) cancelReplyStream();
      turns.add(workspaceId);
      mutedTurns.delete(workspaceId);
      streamedTurns.delete(workspaceId);
      delete lastReply[workspaceId];
      if (hf && hf.workspaceId === workspaceId) hfDispatch({ type: "turnStarted" }, hf.token);
    } else if (event.type === "textDelta") pushReply(workspaceId, event.text);
    else if (event.type === "userMessage") {
      if (replyStream?.workspaceId === workspaceId) cancelReplyStream();
      if (hf?.workspaceId === workspaceId && hf.state.speaking) hfDispatch({ type: "speechDone" }, hf.token);
    } else if (event.type === "error" || event.type === "sessionReset" || event.type === "exited") {
      if (replyStream?.workspaceId === workspaceId) cancelReplyStream();
      turns.delete(workspaceId);
      if (hf?.workspaceId === workspaceId) hfDispatch({ type: "turnInterrupted" }, hf.token);
    } else if (event.type === "message" && event.text.trim()) lastReply[workspaceId] = event.text;
    else if (event.type === "turnCompleted") onTurnCompleted(workspaceId, !!event.interrupted, event.isError);
  });
}

// Dev builds only: lets the mock UI drive the voice states from the console.
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __orbitVoice?: typeof useVoice }).__orbitVoice = useVoice;
