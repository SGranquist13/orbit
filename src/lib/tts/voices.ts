import type { KokoroVoiceId } from "../ipc";

/** The Kokoro voices in the model pack, with the names Settings shows. */
export const KOKORO_VOICES: ReadonlyArray<{ id: KokoroVoiceId; label: string }> = [
  { id: "af_heart", label: "Heart" },
  { id: "af_bella", label: "Bella" },
  { id: "af_nicole", label: "Nicole" },
  { id: "am_michael", label: "Michael" },
  { id: "am_fenrir", label: "Fenrir" },
  { id: "am_puck", label: "Puck" },
  { id: "bf_emma", label: "Emma (British)" },
  { id: "bm_george", label: "George (British)" },
];

/** Sample rate of the Kokoro waveform. */
export const KOKORO_RATE = 24000;
/** A voice file is float32 [510, 1, 256]: one 256-wide style row per input length. */
export const VOICE_ROWS = 510;
export const STYLE_DIM = 256;
