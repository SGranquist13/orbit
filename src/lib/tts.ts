// Read-aloud front door: Kokoro (natural, on-device) when the engine is "kokoro" and its pack is installed,
// the operating system's voices otherwise. Playback happens in this webview in both cases.
import * as kokoro from "./tts/kokoro";
import * as system from "./tts/system";

export type TtsEngine = "kokoro" | "system";

export interface SpeakOptions {
  engine?: TtsEngine;
  /** Kokoro voice id, e.g. "af_heart". */
  kokoroVoice?: string;
  /** System voice name (empty = the OS default). */
  systemVoice?: string;
  /** Speed multiplier, 0.5 to 2. */
  speed?: number;
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

/** Speaks `text`; resolves when it ends or `stop()` is called. A new call cuts off the previous one. */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  stop();
  if ((opts.engine ?? "kokoro") === "kokoro") {
    try {
      await kokoro.speak(text, { voice: opts.kokoroVoice, speed: opts.speed });
      return { engine: "kokoro" };
    } catch (e) {
      if (!(e instanceof kokoro.KokoroUnavailable)) {
        console.debug("[voice] kokoro failed mid-speech", e); // part of it may have played: do not repeat it
        return { engine: "kokoro" };
      }
      console.debug("[voice] kokoro unavailable, using the system voice:", e.message);
      await system.speak(text, { voice: opts.systemVoice || undefined, rate: opts.speed });
      return { engine: "system", fellBack: { notInstalled: e.notInstalled, message: e.message } };
    }
  }
  await system.speak(text, { voice: opts.systemVoice || undefined, rate: opts.speed });
  return { engine: "system" };
}

/** Cuts speech off immediately and drops anything still queued. */
export function stop(): void {
  kokoro.stop();
  system.cancel();
}

/** Forgets the loaded Kokoro model (after its pack is deleted). */
export const unloadKokoro = kokoro.unload;
