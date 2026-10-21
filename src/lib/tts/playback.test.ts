import { describe, expect, mock, test } from "bun:test";

// The default fixture matches the UI-only backend: no Kokoro pack or audio device.
let installed = false;
mock.module("@tauri-apps/api/core", () => ({ invoke: async (_command: string, args: { path: string }) => {
  if (!installed) throw new Error("not installed (mock)");
  return args.path.startsWith("voices/") ? new Float32Array(510 * 256).buffer
    : args.path.endsWith(".json") ? new TextEncoder().encode("{}").buffer : new ArrayBuffer(1);
} }));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const tts = await import("../tts");
const kokoro = await import("./kokoro");

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const originals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
let spoken: SpeechSynthesisUtterance[];

async function withSystem(check: () => Promise<void>) {
  spoken = [];
  install("window", { speechSynthesis: {
    speak(u: SpeechSynthesisUtterance) { spoken.push(u); },
    cancel() {}, getVoices: () => [], speaking: false, pending: false,
  } });
  install("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
  try { await check(); } finally {
    tts.stop();
    kokoro.unload();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    originals.clear();
    installed = false;
  }
}
function endAudio(index: number) { spoken[index].onend?.(new Event("end") as SpeechSynthesisEvent); }

describe("stream playback without audio devices", () => {
  test("system voice starts before end, preserves sentence order, and done waits for audio", async () => withSystem(async () => {
    const stream = tts.createStream({ engine: "system" });
    stream.push("First sentence. ");
    await tick();
    expect(spoken.map((u) => u.text)).toEqual(["First sentence."]);
    stream.push("Second sentence."); stream.end();
    let done = false;
    void stream.done.then(() => { done = true; });
    await tick(); expect(done).toBe(false);
    endAudio(0); await tick();
    expect(spoken.map((u) => u.text)).toEqual(["First sentence.", "Second sentence."]);
    expect(done).toBe(false);
    endAudio(1); await stream.done;
  }));
  test("missing Kokoro pack falls back and keeps accepting deltas", async () => withSystem(async () => {
    const stream = tts.createStream({ engine: "kokoro" });
    stream.push("Early reply. ");
    await tick();
    expect(spoken.map((u) => u.text)).toEqual(["Early reply."]);
    stream.push("Last reply."); stream.end();
    endAudio(0); await tick();
    expect(spoken[1].text).toBe("Last reply.");
    endAudio(1); await stream.done;
  }));
  test("held fallback synthesizes/selects the engine but stays silent until released", async () => withSystem(async () => {
    const stream = tts.createStream({ engine: "kokoro" });
    stream.setHeld(true);
    stream.push("Wait for the user. "); stream.end();
    await tick(); expect(spoken.length).toBe(0);
    stream.setHeld(false); await tick(); expect(spoken.length).toBe(1);
    endAudio(0); await stream.done;
  }));
  test("cancel resolves immediately even when Chromium sends no cancellation event", async () => withSystem(async () => {
    const stream = tts.createStream({ engine: "system" });
    stream.push("First. Second. "); stream.end();
    await tick(); expect(spoken.length).toBe(1);
    stream.cancel(); await stream.done; await tick();
    expect(spoken.length).toBe(1);
    stream.push("Stale text. "); await tick(); expect(spoken.length).toBe(1);
  }));
  test("empty Kokoro stream finishes without loading a pack", async () => withSystem(async () => {
    const stream = kokoro.createStream(); stream.end(); await stream.done;
    expect(spoken.length).toBe(0);
  }));
});


test("Kokoro pool synthesizes ahead while held and schedules out-of-order results gaplessly", async () => withSystem(async () => {
  installed = true;
  const threads: number[] = [];
  const jobs: { reply: (samples: Float32Array) => void }[] = [];
  install("navigator", { hardwareConcurrency: 12 });
  install("crossOriginIsolated", true);
  install("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage(req: { type: string; id: number; threads?: number }) {
      if (req.type === "init") {
        threads.push(req.threads!);
        queueMicrotask(() => this.onmessage?.({ data: { type: "ready", id: req.id } }));
      } else jobs.push({ reply: (samples) => this.onmessage?.({ data: { type: "audio", id: req.id, samples } }) });
    }
    terminate() {}
  });
  const sources: { buffer: { duration: number; sample: number } | null; at: number; onended: (() => void) | null; stopped: boolean }[] = [];
  install("AudioContext", class {
    state = "running";
    currentTime = 0;
    destination = {};
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, sample: 0, copyToChannel(samples: Float32Array) { this.sample = samples[0]; } };
    }
    createBufferSource() {
      const src = { buffer: null as { duration: number; sample: number } | null, at: 0, onended: null as (() => void) | null,
        stopped: false, connect() {}, disconnect() {}, start(at: number) { this.at = at; }, stop() { this.stopped = true; } };
      sources.push(src);
      return src;
    }
  });
  const stream = kokoro.createStream();
  stream.setHeld(true);
  stream.push("One sentence. Two sentences. ");
  await tick();
  expect(threads).toEqual([4, 4, 4]);
  expect(jobs.length).toBe(2);
  jobs[1].reply(new Float32Array([2])); await tick(); expect(sources.length).toBe(0);
  jobs[0].reply(new Float32Array([1])); await tick(); expect(sources.length).toBe(0);
  stream.setHeld(false); await tick();
  expect(sources.map((s) => s.buffer?.sample)).toEqual([1, 2]);
  expect(sources[1].at).toBeCloseTo(sources[0].at + sources[0].buffer!.duration);
  stream.end();
  let done = false;
  void stream.done.then(() => { done = true; });
  sources[0].onended?.(); await tick(); expect(done).toBe(false);
  sources[1].onended?.(); await stream.done;

  const next = kokoro.createStream();
  next.push("New sentence. "); await tick();
  // Speech starting during synthesis must still hold the first audio.
  next.setHeld(true);
  jobs[2].reply(new Float32Array([3])); await tick();
  expect(sources.length).toBe(2);
  next.setHeld(false); await tick();
  expect(sources.length).toBe(3);
  next.cancel(); await next.done;
  expect(sources[2].stopped).toBe(true);
  next.push("Stale audio. "); await tick(); expect(jobs.length).toBe(3);
}));
