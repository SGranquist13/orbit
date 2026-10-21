// Silero voice-activity detection for hands-free (@ricky0123/vad-web, ISC) on our own echo-cancelled mic stream.
// The model, the worklet and the onnxruntime-web wasm are served by the app itself (see vite.config.ts), so
// nothing is fetched from a CDN and Orbit works offline.
import type { MicVAD } from "@ricky0123/vad-web";
import { rms } from "../voice";
import { openMic, ORT_PATHS, SPEECH_BASE, stopStream } from "./mic";

export interface VadOptions {
  deviceId: string;
  /** Speech shorter than this is a misfire (a click, a cough). */
  minSpeechMs: number;
  /** A pause this long ends the utterance. */
  silenceMs: number;
  /** Speech has started (a few frames of confirmed speech, ~130 ms, so a single blip does not count). */
  onSpeechStart: () => void;
  /** Speech was too short to count after all (only fires after `onSpeechStart`). */
  onMisfire: () => void;
  /** The utterance, 16 kHz mono f32, with a short pad before the first word. */
  onSpeechEnd: (audio: Float32Array) => void;
  /** Microphone level 0..1, ~30 per second. */
  onLevel: (level: number) => void;
}

export interface VadHandle {
  destroy: () => Promise<void>;
}

const POSITIVE_THRESHOLD = 0.55;
const NEGATIVE_THRESHOLD = 0.4;
const PRE_SPEECH_PAD_MS = 300;
/** Consecutive speech frames (32 ms each) before we call it speech, for barge-in. */
const CONFIRM_FRAMES = 4;

/** Starts the microphone and the detector; resolves once both are running. */
export async function startVad(o: VadOptions): Promise<VadHandle> {
  const stream = await openMic(o.deviceId);
  let vad: MicVAD | null = null;
  try {
    let candidate = false;
    let confirmed = false;
    let run = 0;
    const confirm = () => {
      if (confirmed) return;
      confirmed = true;
      candidate = false;
      o.onSpeechStart();
    };
    const { MicVAD: VadClass } = await import("@ricky0123/vad-web"); // loaded on first use: it carries onnxruntime
    vad = await VadClass.new({
      model: "v5",
      baseAssetPath: SPEECH_BASE,
      onnxWASMBasePath: SPEECH_BASE,
      ortConfig: (ort) => {
        ort.env.logLevel = "error";
        ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which the app does not have
        ort.env.wasm.wasmPaths = ORT_PATHS as unknown as string;
      },
      getStream: async () => stream,
      pauseStream: async () => {}, // we own the stream and stop it ourselves
      resumeStream: async () => stream,
      positiveSpeechThreshold: POSITIVE_THRESHOLD,
      negativeSpeechThreshold: NEGATIVE_THRESHOLD,
      preSpeechPadMs: PRE_SPEECH_PAD_MS,
      redemptionMs: o.silenceMs,
      minSpeechMs: o.minSpeechMs,
      onFrameProcessed: (probs, frame) => {
        o.onLevel(rms(frame));
        if (candidate && !confirmed) {
          run = probs.isSpeech >= POSITIVE_THRESHOLD ? run + 1 : 0;
          if (run >= CONFIRM_FRAMES) confirm();
        }
      },
      onSpeechStart: () => {
        candidate = true;
        confirmed = false;
        run = 1;
      },
      onSpeechRealStart: () => confirm(),
      onVADMisfire: () => {
        const was = confirmed;
        candidate = false;
        confirmed = false;
        run = 0;
        if (was) o.onMisfire();
      },
      onSpeechEnd: (audio) => {
        confirm(); // a very short but valid utterance may end before the confirm frames were counted
        candidate = false;
        confirmed = false;
        run = 0;
        o.onSpeechEnd(audio);
      },
    });
    await vad.start();
  } catch (e) {
    await vad?.destroy().catch(() => {});
    stopStream(stream);
    throw e;
  }
  const running = vad;
  return {
    destroy: async () => {
      try {
        await running.destroy();
      } finally {
        stopStream(stream);
      }
    },
  };
}
