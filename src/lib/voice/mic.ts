// Microphone access in the webview. Chromium's echo canceller removes whatever this page plays (Orbit's own
// speech), so the mic can stay open while Orbit talks. Pure browser APIs: no Tauri, no React.
import { resampleLinear, rms } from "../voice";

export const SPEECH_BASE = `${import.meta.env.BASE_URL}speech/`;
export const WHISPER_RATE = 16000;

export type MicErrorKind = "blocked" | "noMic" | "other";

export class MicError extends Error {
  constructor(
    public kind: MicErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Opens the microphone with the browser's echo cancellation, noise suppression and auto gain. */
export async function openMic(deviceId: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicError("noMic", "no microphone: this webview has no audio capture");
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new MicError("blocked", "microphone blocked");
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      if (deviceId && name === "OverconstrainedError") return openMic(""); // the saved device is gone: use the default
      throw new MicError("noMic", "no microphone found");
    }
    throw new MicError("other", `microphone error: ${(e as Error)?.message ?? String(e)}`);
  }
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

export interface InputDevice {
  id: string;
  label: string;
}

/** Audio inputs. Labels are empty until the page has had microphone permission once. */
export async function listInputDevices(): Promise<{ devices: InputDevice[]; labelled: boolean }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { devices: [], labelled: false };
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
  return {
    devices: all.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
    labelled: all.some((d) => !!d.label),
  };
}

/** Asks for the microphone once so device names become visible, then lets go of it. */
export async function grantMicLabels(): Promise<void> {
  stopStream(await openMic(""));
}

export interface Recorder {
  /** Stops and resolves with everything captured, 16 kHz mono. */
  stop: () => Promise<Float32Array>;
  /** Stops and discards. */
  cancel: () => void;
}

/**
 * Dictation capture: records everything between start and stop (no voice-activity gating), resampled to
 * 16 kHz mono f32. `onLevel` gets the RMS of each ~64 ms block.
 */
export async function startRecorder(deviceId: string, onLevel: (rms: number) => void): Promise<Recorder> {
  const stream = await openMic(deviceId);
  let ctx: AudioContext | null = null;
  try {
    // Chromium resamples the microphone to the context's rate for us.
    ctx = new AudioContext({ sampleRate: WHISPER_RATE });
    await ctx.audioWorklet.addModule(`${SPEECH_BASE}recorder-worklet.js`);
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "orbit-recorder", { numberOfInputs: 1, numberOfOutputs: 0 });
    const blocks: Float32Array[] = [];
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      blocks.push(e.data);
      onLevel(rms(e.data));
    };
    source.connect(node);
    if (ctx.state === "suspended") await ctx.resume();
    const rate = ctx.sampleRate;
    const close = () => {
      node.port.onmessage = null;
      source.disconnect();
      stopStream(stream);
      void ctx?.close();
    };
    return {
      stop: async () => {
        close();
        const total = blocks.reduce((n, b) => n + b.length, 0);
        const all = new Float32Array(total);
        let at = 0;
        for (const b of blocks) {
          all.set(b, at);
          at += b.length;
        }
        return resampleLinear(all, rate, WHISPER_RATE);
      },
      cancel: close,
    };
  } catch (e) {
    stopStream(stream);
    void ctx?.close();
    throw e;
  }
}

/** Where onnxruntime-web finds its runtime (served by the app, see vite.config.ts). */
export const ORT_PATHS = { mjs: `${SPEECH_BASE}ort-wasm-simd-threaded.mjs`, wasm: `${SPEECH_BASE}ort-wasm-simd-threaded.wasm` };
