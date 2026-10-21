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
import { splitFirstClause, splitSentences } from "./normalize";
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
  if (typeof crossOriginIsolated !== "undefined" && crossOriginIsolated) return 1; // one worker with threads
  return Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 2) / 4)));
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

function send<T extends Float32Array | null>(slot: Slot, req: WorkerRequest, transfer: Transferable[] = []): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    slot.pending.set(req.id, { resolve: resolve as (v: Float32Array | null) => void, reject });
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
      const threads = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
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
      unload();
      throw new KokoroUnavailable(errText(e), false);
    }
  })().catch((e) => {
    loading = null; // a failed load can be retried (e.g. after the download finishes)
    throw e;
  });
  return loading;
}

/** Drops the loaded model (after the pack is deleted, or on a crash) so the next use loads it again. */
export function unload() {
  stop();
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
}

/**
 * Speaks `text` sentence by sentence: the first sentence starts playing as soon as it is synthesised while the
 * rest are still being made. Resolves when playback ends or `stop()` is called. Throws KokoroUnavailable if the
 * pack is missing or fails to load (nothing has been played then).
 */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  stop();
  const mine = generation;
  const sentences = splitFirstClause(splitSentences(text));
  if (sentences.length === 0) return;
  busy++;
  try {
    await load();
    if (mine !== generation) return;
    const voice = await voiceFile(opts.voice || "af_heart");
    if (mine !== generation) return;
    const speed = Math.min(2, Math.max(0.5, opts.speed ?? 1));
    const chunks = sentences.flatMap((s) => sentenceToChunks(s, lexicon!));
    // Queue everything: idle workers pick sentences up in order while earlier ones are already playing.
    const waves = chunks.map((ids) => synth(ids, styleRow(voice, ids.length), speed));
    for (const w of waves) w.catch(() => {}); // surfaced when awaited below, never as an unhandled rejection

    const c = audioContext();
    if (c.state === "suspended") await c.resume().catch(() => {});
    if (mine !== generation) return;
    gain = c.createGain();
    gain.connect(c.destination);
    const out = gain;
    let at = c.currentTime + 0.05;
    const ends: Promise<void>[] = [];
    for (const pending of waves) {
      const wave = await pending;
      if (mine !== generation || !wave) return;
      const buf = c.createBuffer(1, wave.length, KOKORO_RATE);
      buf.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(out);
      const start = Math.max(at, c.currentTime + 0.02);
      src.start(start);
      at = start + buf.duration;
      active.add(src);
      ends.push(
        new Promise<void>((resolve) => {
          src.onended = () => {
            active.delete(src);
            src.disconnect();
            resolve();
          };
        }),
      );
    }
    await Promise.all(ends);
  } finally {
    busy--;
  }
}
