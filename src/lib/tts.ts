// Read-aloud front door: Kokoro (natural, on-device) when the engine is "kokoro" and its pack is installed,
// the operating system's voices otherwise. Playback happens in this webview in both cases.
import * as kokoro from "./tts/kokoro";
import * as system from "./tts/system";
import { SpeechSplitter, type SpeechStream } from "./tts/stream";
export type { SpeechStream } from "./tts/stream";

export type TtsEngine = "kokoro" | "system";

export interface SpeakOptions {
  engine?: TtsEngine;
  /** Kokoro voice id, e.g. "af_heart". */
  kokoroVoice?: string;
  /** System voice name (empty = the OS default). */
  systemVoice?: string;
  /** Speed multiplier, 0.5 to 2. */
  speed?: number;
  onSentence?: () => void;
  onStart?: () => void;
}

export interface SpeakResult {
  /** The engine that actually spoke. */
  engine: TtsEngine;
  /** Set when Kokoro was wanted but could not be used: `notInstalled` means the pack has to be downloaded. */
  fellBack?: { notInstalled: boolean; message: string };
}

export const ttsAvailable = (): boolean => system.ttsAvailable() || typeof AudioContext !== "undefined";
export const listVoices = system.listVoices;
export const speaking = (): boolean => kokoro.speaking() || system.speaking();

let currentStream: SpeechStream | null = null;

export function createStream(opts: SpeakOptions = {}): SpeechStream {
  stop();
  const started = performance.now();
  let cancelled = false, ended = false, held = false, settled = false, raw = "";
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  let engine: SpeechStream;
  const makeSystem = (): SpeechStream => {
    const splitter = new SpeechSplitter();
    let chain = Promise.resolve();
    let release: (() => void) | null = null;
    let finish!: () => void;
    let first = true, index = 0;
    const systemDone = new Promise<void>((r) => { finish = r; });
    const enqueue = (text: string) => {
      opts.onSentence?.();
      const n = index++;
      console.debug("[voice] sentence queued", { index: n, chars: text.length, synthMs: 0 });
      chain = chain.then(async () => {
        const waitForUser = async () => {
          while (held && !cancelled) await new Promise<void>((r) => { release = r; });
        };
        await waitForUser();
        if (cancelled) return;
        await system.speak(text, {
          voice: opts.systemVoice, rate: opts.speed, beforeStart: waitForUser,
          onStart: () => {
            if (first) {
              first = false;
              opts.onStart?.();
              console.debug("[voice] first audio", { ms: Math.round(performance.now() - started) });
            }
          },
        });
      }).catch((e) => console.debug("[voice] system speech failed", e));
    };
    return {
      push(delta) { splitter.push(delta).forEach(enqueue); },
      end() { splitter.end().forEach(enqueue); void chain.then(finish); },
      cancel() { release?.(); system.cancel(); finish(); },
      setHeld(value) { if (!value) { release?.(); release = null; } },
      done: systemDone,
    };
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    if (currentStream === stream) currentStream = null;
    console.debug("[voice] stream done", { ms: Math.round(performance.now() - started), cancelled });
    resolve();
  };
  const watch = (target: SpeechStream) => {
    void target.done.then(finish, (e) => {
      if (cancelled) return;
      if (!(e instanceof kokoro.KokoroUnavailable)) {
        console.debug("[voice] kokoro failed mid-speech", e);
        finish();
        return;
      }
      console.debug("[voice] kokoro unavailable, using the system voice:", e.message);
      engine = makeSystem();
      watch(engine);
      engine.push(raw);
      raw = "";
      if (ended) engine.end();
    });
  };
  engine = (opts.engine ?? "kokoro") === "kokoro"
    ? kokoro.createStream({ voice: opts.kokoroVoice, speed: opts.speed, onSentence: opts.onSentence, onStart: opts.onStart }) : makeSystem();
  const stream: SpeechStream = {
    push(delta) { if (!ended && !cancelled) { raw += delta; engine.push(delta); } },
    end() { if (!ended && !cancelled) { ended = true; engine.end(); } },
    cancel() { if (!cancelled && !settled) { cancelled = true; engine.cancel(); finish(); } },
    setHeld(value) { held = value; engine.setHeld(value); },
    done,
  };
  currentStream = stream;
  watch(engine);
  console.debug("[voice] stream opened", { engine: opts.engine ?? "kokoro" });
  return stream;
}

/** Manual read-aloud preserves the engine/fallback result contract. */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  stop();
  if ((opts.engine ?? "kokoro") === "kokoro") {
    try {
      await kokoro.speak(text, { voice: opts.kokoroVoice, speed: opts.speed });
      return { engine: "kokoro" };
    } catch (e) {
      if (!(e instanceof kokoro.KokoroUnavailable)) {
        console.debug("[voice] kokoro failed mid-speech", e);
        return { engine: "kokoro" };
      }
      const stream = createStream({ ...opts, engine: "system" });
      stream.push(text); stream.end(); await stream.done;
      return { engine: "system", fellBack: { notInstalled: e.notInstalled, message: e.message } };
    }
  }
  const stream = createStream({ ...opts, engine: "system" });
  stream.push(text); stream.end(); await stream.done;
  return { engine: "system" };
}

export function warmup(): void {
  void kokoro.warmup().catch((e) => console.debug("[voice] warm-up unavailable", e));
}

/** Cuts speech off immediately and drops anything still queued. */
export function stop(): void {
  const stream = currentStream;
  currentStream = null;
  stream?.cancel();
  kokoro.stop();
  system.cancel();
}

/** Forgets the loaded Kokoro model (after its pack is deleted). */
export const unloadKokoro = kokoro.unload;
