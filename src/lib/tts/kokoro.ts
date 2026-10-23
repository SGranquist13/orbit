// Natural read-aloud: Kokoro-82M synthesised in workers, played through one Web Audio graph in this webview
// (so Chromium's echo canceller knows what Orbit is saying and keeps it out of the microphone).
// Model, voices and lexicons come from the Rust side through `voice_file`; nothing is fetched from the network.
//
// Speed: the quantized model runs on onnxruntime's wasm backend, which is single-threaded unless the page is
// cross-origin isolated (WebGPU does not help the int8 model). A small pool of workers synthesises several
// sentences at once instead, and the first sentence is cut at a clause so audio starts early.
import { voiceApi } from "../ipc";
import { ORT_PATHS } from "../voice/mic";
import { buildLexicon, sentenceToChunks, type Lexicon } from "./g2p";
import { SpeechSplitter, type SpeechStream } from "./stream";
import { KOKORO_RATE, STYLE_DIM, VOICE_ROWS } from "./voices";
import type { WorkerReply, WorkerRequest } from "./kokoroWorker";

/** Thrown when the pack is not installed or cannot be loaded; the caller falls back to the system voice. */
export class KokoroUnavailable extends Error {
  constructor(
    message: string,
    public notInstalled: boolean,
  ) {
    super(message);
  }
}

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, "");
const log = (...args: unknown[]) => console.debug("[voice]", ...args);

// ── worker pool ──

interface Slot {
  worker: Worker;
  busy: boolean;
  pending: Map<number, { resolve: (v: Float32Array | null) => void; reject: (e: Error) => void }>;
}
interface Job {
  request: Extract<WorkerRequest, { type: "synth" }>;
  generation: number;
  resolve: (v: Float32Array | null) => void;
  reject: (e: Error) => void;
}

let slots: Slot[] = [];
let loading: Promise<void> | null = null;
let lexicon: Lexicon | null = null;
let nextId = 1;
const queue: Job[] = [];
const voices = new Map<string, Float32Array>();

function poolSize(): number {
  return Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 1) / 4)));
}

function startSlot(): Slot {
  const worker = new Worker(new URL("./kokoroWorker.ts", import.meta.url), { type: "module" });
  const slot: Slot = { worker, busy: false, pending: new Map() };
  worker.onmessage = (e: MessageEvent<WorkerReply>) => {
    const r = e.data;
    const p = slot.pending.get(r.id);
    if (!p) return;
    slot.pending.delete(r.id);
    if (r.type === "error") p.reject(new Error(r.message));
    else p.resolve(r.type === "audio" ? r.samples : null);
  };
  worker.onerror = (e) => {
    for (const p of slot.pending.values()) p.reject(new Error(e.message || "synthesis worker crashed"));
    slot.pending.clear();
    unload(); // load again next time
  };
  return slot;
}

/** A worker that never answers (a wasm that fails to start its threads) must fail, not hang speech forever. */
const TIMEOUT_MS = { init: 60_000, synth: 30_000 };

function send<T extends Float32Array | null>(slot: Slot, req: WorkerRequest, transfer: Transferable[] = []): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      slot.pending.delete(req.id);
      reject(new Error(`speech worker did not answer (${req.type})`));
    }, TIMEOUT_MS[req.type]);
    const settle = <A>(fn: (a: A) => void) => (a: A) => {
      clearTimeout(timer);
      fn(a);
    };
    slot.pending.set(req.id, { resolve: settle(resolve as (v: Float32Array | null) => void), reject: settle(reject) });
    slot.worker.postMessage(req, transfer);
  });
}

/** Hands queued jobs to idle workers; jobs from a cancelled speech are dropped. */
function pump() {
  for (const slot of slots) {
    while (!slot.busy && queue.length > 0) {
      const job = queue.shift()!;
      if (job.generation !== generation) {
        job.resolve(null);
        continue;
      }
      slot.busy = true;
      send<Float32Array>(slot, job.request)
        .then(job.resolve, job.reject)
        .finally(() => {
          slot.busy = false;
          pump();
        });
    }
  }
}

function synth(ids: number[], style: Float32Array, speed: number): Promise<Float32Array | null> {
  return new Promise((resolve, reject) => {
    queue.push({ request: { type: "synth", id: nextId++, ids: [0, ...ids, 0], style, speed }, generation, resolve, reject });
    pump();
  });
}

/** Loads the model and lexicons once (about 100 MB read from disk, a few seconds). */
export function load(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    let model: ArrayBuffer;
    let gold: ArrayBuffer;
    let silver: ArrayBuffer;
    try {
      [model, gold, silver] = await Promise.all([voiceApi.file("model_quantized.onnx"), voiceApi.file("us_gold.json"), voiceApi.file("us_silver.json")]);
    } catch (e) {
      throw new KokoroUnavailable(errText(e), true);
    }
    try {
      const started = performance.now();
      const dec = new TextDecoder();
      lexicon = buildLexicon(JSON.parse(dec.decode(gold)), JSON.parse(dec.decode(silver)));
      const threads = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 1) / poolSize()))) : 1;
      const made = Array.from({ length: poolSize() }, startSlot);
      slots = made;
      // Every worker needs its own copy of the model bytes; the last one takes the original.
      await Promise.all(
        made.map((slot, i) => {
          const bytes = i === made.length - 1 ? model : model.slice(0);
          return send(slot, { type: "init", id: nextId++, model: bytes, paths: ORT_PATHS, threads }, [bytes]);
        }),
      );
      log("kokoro loaded", { workers: made.length, threads, lexicon: lexicon.size, ms: Math.round(performance.now() - started) });
    } catch (e) {
      unload(false);
      throw new KokoroUnavailable(errText(e), false);
    }
  })().catch((e) => {
    loading = null; // a failed load can be retried (e.g. after the download finishes)
    throw e;
  });
  return loading;
}

/** Drops the loaded model (after the pack is deleted, or on a crash) so the next use loads it again. */
export function unload(stopPlayback = true) {
  if (stopPlayback) stop();
  for (const s of slots) s.worker.terminate();
  slots = [];
  loading = null;
  lexicon = null;
  voices.clear();
}

async function voiceFile(id: string): Promise<Float32Array> {
  const cached = voices.get(id);
  if (cached) return cached;
  let buf: ArrayBuffer;
  try {
    buf = await voiceApi.file(`voices/${id}.bin`);
  } catch (e) {
    throw new KokoroUnavailable(errText(e), true);
  }
  const data = new Float32Array(buf);
  if (data.length !== VOICE_ROWS * STYLE_DIM) throw new KokoroUnavailable(`voice file ${id} has the wrong size`, false);
  voices.set(id, data);
  return data;
}

/** The style vector for an input of `n` tokens: row min(n, 509). */
export function styleRow(voice: Float32Array, n: number): Float32Array {
  const row = Math.min(n, VOICE_ROWS - 1);
  return voice.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM);
}

// ── playback ──

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
const active = new Set<AudioBufferSourceNode>();
/** Bumped by every speak() and stop(); a running speak() that sees a newer value gives up. */
let generation = 0;
let busy = 0;

function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: "interactive" });
  return ctx;
}

/** Cuts playback at once and abandons queued sentences. */
export function stop() {
  generation++;
  cancelCurrent?.();
  cancelCurrent = null;
  if (gain) {
    gain.gain.value = 0;
    gain.disconnect();
    gain = null;
  }
  for (const s of active) {
    try {
      s.stop();
    } catch {
      /* not started */
    }
  }
  active.clear();
  for (const job of queue.splice(0)) job.resolve(null);
}

export function speaking(): boolean {
  return busy > 0 || active.size > 0;
}

export interface SpeakOptions {
  voice?: string;
  speed?: number;
  onSentence?: () => void;
  onStart?: () => void;
}

let cancelCurrent: (() => void) | null = null;

export function createStream(opts: SpeakOptions = {}): SpeechStream {
  stop();
  const mine = generation;
  const splitter = new SpeechSplitter();
  let ended = false, cancelled = false, settled = false, held = false;
  let release: (() => void) | null = null;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const started = performance.now();
  let first = true, index = 0, pending = 0;
  let at = 0;
  let out: GainNode | null = null;
  let playback = Promise.resolve();
  const ends: Promise<void>[] = [];
  // Load lazily: an empty stream needs neither a model nor an audio context.
  let ready: Promise<Float32Array> | null = null;
  busy++;
  const settle = (error?: unknown) => {
    if (settled) return;
    settled = true;
    busy--;
    if (cancelCurrent === cancel) cancelCurrent = null;
    if (out) { out.disconnect(); if (gain === out) gain = null; }
    log("stream done", { ms: Math.round(performance.now() - started), cancelled });
    if (error) fail(error); else finish();
  };
  const cancel = () => { cancelled = true; release?.(); settle(); };
  cancelCurrent = cancel;
  const check = () => {
    if (ended && pending === 0 && !settled) void Promise.all(ends).then(() => settle());
  };
  const enqueue = (text: string) => {
    opts.onSentence?.();
    const n = index++;
    const queued = performance.now();
    pending++;
    log("sentence queued", { index: n, chars: text.length });
    ready ??= load().then(() => voiceFile(opts.voice || "af_heart"));
    // Synthesis is independent of the ordered playback chain.
    const waves = ready.then((voice) => {
      if (cancelled || mine !== generation) return [];
      const chunks = sentenceToChunks(text, lexicon!);
      const result = chunks.map((ids) => synth(ids, styleRow(voice, ids.length), Math.min(2, Math.max(0.5, opts.speed ?? 1))));
      void Promise.all(result).then(() => {
        log("sentence synthesized", { index: n, chars: text.length, synthMs: Math.round(performance.now() - queued) });
      }).catch(() => {});
      return result;
    });
    void waves.catch(() => {});
    playback = playback.then(async () => {
      const audio = await waves;
      while (held && !cancelled) await new Promise<void>((resolve) => { release = resolve; });
      if (cancelled || mine !== generation) return;
      const c = audioContext();
      if (c.state === "suspended") await c.resume().catch(() => {});
      if (cancelled || mine !== generation) return;
      if (!out) { out = c.createGain(); out.connect(c.destination); gain = out; }
      for (const pendingAudio of audio) {
        const wave = await pendingAudio;
        while (held && !cancelled) await new Promise<void>((resolve) => { release = resolve; });
        if (cancelled || mine !== generation) return;
        if (!wave) continue;
        const buf = c.createBuffer(1, wave.length, KOKORO_RATE);
        buf.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(out);
        const start = Math.max(at, c.currentTime + 0.02);
        ends.push(new Promise<void>((resolve) => { src.onended = () => { active.delete(src); src.disconnect(); resolve(); }; }));
        active.add(src);
        src.start(start);
        at = start + buf.duration;
        if (first) { first = false; opts.onStart?.(); log("first audio", { ms: Math.round(performance.now() - started + (start - c.currentTime) * 1000) }); }
      }
    }).catch((e) => { if (!settled) { settle(e); stop(); } }).finally(() => { pending--; check(); });
  };
  log("stream opened");
  return {
    push(delta) { if (!ended && !cancelled) splitter.push(delta).forEach(enqueue); },
    end() { if (ended || cancelled) return; ended = true; splitter.end().forEach(enqueue); check(); },
    cancel() { if (!settled && mine === generation) stop(); },
    setHeld(value) { held = value; if (!held) { release?.(); release = null; } },
    done,
  };
}

export function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const stream = createStream(opts);
  stream.push(text);
  stream.end();
  return stream.done;
}

let warming: Promise<void> | null = null;
/** Prime model/JIT without scheduling audio or interrupting a reply. */
export function warmup(): Promise<void> {
  return warming ??= load().then(async () => {
    const voice = await voiceFile("af_heart");
    const ids = sentenceToChunks("Hi.", lexicon!)[0];
    if (ids) await synth(ids, styleRow(voice, ids.length), 1);
  }).finally(() => { warming = null; });
}
