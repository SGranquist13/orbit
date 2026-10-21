// Pure helpers for voice input and read-aloud: no React, no DOM.
//
// Hands-free is "listening first": the microphone (echo-cancelled in the webview) stays open the whole time,
// while idle, while the agent works and while Orbit speaks. `hfReduce` is the whole decision table: it takes
// the loop's state and one event and returns the next state plus the side effects the store must run.

/** What the hands-free bar shows. `listening` is the quiet default. */
export type HandsFreePhase = "off" | "listening" | "hearing" | "transcribing" | "working" | "speaking";

export interface HfState {
  on: boolean;
  /** The VAD reports speech right now. */
  hearing: boolean;
  /** Utterances sent to Whisper that have not come back yet. */
  transcribing: number;
  /** A turn is running (set when we send, cleared when it completes or is interrupted). */
  working: boolean;
  /** Orbit is speaking a reply. */
  speaking: boolean;
  /** A finished reply waiting for the user to stop talking before it is spoken. */
  pending: string | null;
  /** The current utterance began while Orbit spoke and barge-in is off: its audio is discarded. */
  ignoring: boolean;
}

export const hfInitial: HfState = { on: false, hearing: false, transcribing: 0, working: false, speaking: false, pending: null, ignoring: false };

export type HfEvent =
  | { type: "start" }
  | { type: "stop" }
  /** The VAD heard speech begin. */
  | { type: "speechStart"; bargeIn: boolean }
  /** It turned out to be too short to be speech (a click, a cough under the minimum). */
  | { type: "speechMisfire" }
  /** The utterance ended and its audio goes to transcription. */
  | { type: "speechEnd" }
  | { type: "transcribed"; text: string; dropped: boolean }
  | { type: "transcribeFailed" }
  | { type: "sendFailed" }
  | { type: "turnStarted" }
  /** `reply` is what to read out, or null when nothing should be spoken (read-aloud off, interrupted, error, empty). */
  | { type: "turnCompleted"; reply: string | null }
  | { type: "speechDone" };

export type HfEffect =
  | { type: "stopSpeech" }
  | { type: "interrupt" }
  | { type: "send"; text: string }
  | { type: "speak"; text: string };

export type UtteranceKind = "ignore" | "stop" | "send";

/** What a transcript means: nothing (dropped or empty), a command to stop, or a message for the agent. */
export function classifyUtterance(text: string, dropped: boolean): UtteranceKind {
  if (dropped || !text.trim()) return "ignore";
  return isStopWord(text) ? "stop" : "send";
}

/** The phase to show, in priority order: what the user is doing first, then what Orbit is doing. */
export function handsFreePhase(s: HfState): HandsFreePhase {
  if (!s.on) return "off";
  if (s.hearing) return "hearing";
  if (s.transcribing > 0) return "transcribing";
  if (s.speaking) return "speaking";
  if (s.working) return "working";
  return "listening";
}

export function hfReduce(state: HfState, event: HfEvent): { state: HfState; effects: HfEffect[] } {
  const effects: HfEffect[] = [];
  let s = { ...state };
  const stopSpeech = () => {
    if (s.speaking) effects.push({ type: "stopSpeech" });
    s.speaking = false;
  };

  if (event.type === "start") return { state: { ...hfInitial, on: true }, effects };
  if (event.type === "stop") {
    if (s.speaking) effects.push({ type: "stopSpeech" });
    return { state: { ...hfInitial }, effects };
  }
  if (!s.on) return { state, effects };

  switch (event.type) {
    case "speechStart":
      if (s.speaking && !event.bargeIn) {
        s.ignoring = true; // Orbit's own voice leaking through: not the user
      } else {
        s.hearing = true;
        s.ignoring = false;
        stopSpeech(); // barge-in: cut Orbit off at once and keep listening
      }
      break;
    case "speechMisfire":
      s.hearing = false;
      s.ignoring = false;
      break;
    case "speechEnd":
      if (s.ignoring) {
        s.ignoring = false;
        s.hearing = false;
      } else {
        s.hearing = false;
        s.transcribing += 1;
      }
      break;
    case "transcribed": {
      s.transcribing = Math.max(0, s.transcribing - 1);
      const kind = classifyUtterance(event.text, event.dropped);
      if (kind === "stop") {
        effects.push({ type: "interrupt" });
        stopSpeech();
        s.working = false;
        s.pending = null;
      } else if (kind === "send") {
        // Sent even while the agent works: Codex steers the running turn, Claude queues it.
        stopSpeech(); // a reply read out after this would be stale
        s.pending = null;
        s.working = true;
        effects.push({ type: "send", text: event.text.trim() });
      }
      break;
    }
    case "transcribeFailed":
      s.transcribing = Math.max(0, s.transcribing - 1);
      break;
    case "sendFailed":
      s.working = false;
      break;
    case "turnStarted":
      s.working = true;
      break;
    case "turnCompleted":
      s.working = false;
      if (event.reply) {
        // If the user is mid-utterance (or one is being transcribed), wait for them to finish.
        if (s.hearing || s.transcribing > 0 || s.ignoring) s.pending = event.reply;
        else {
          stopSpeech();
          s.speaking = true;
          s.pending = null;
          effects.push({ type: "speak", text: event.reply });
        }
      }
      break;
    case "speechDone":
      s.speaking = false;
      break;
  }

  // A reply held back for the user is spoken as soon as they have finished and sent nothing new.
  if (s.pending && !s.hearing && !s.ignoring && s.transcribing === 0 && !s.speaking) {
    effects.push({ type: "speak", text: s.pending });
    s.speaking = true;
    s.pending = null;
  }
  return { state: s, effects };
}

const STOP_PHRASES = new Set(["stop", "cancel", "wait", "hold on"]);

/** "stop" / "cancel" / "wait" / "hold on" alone, ignoring case and punctuation. */
export function isStopWord(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return STOP_PHRASES.has(t);
}

/** Raw f32 PCM in a Float32Array to the base64 of its little-endian bytes (what `voice_transcribe` takes). */
export function f32ToBase64(samples: Float32Array): string {
  // A DataView makes the byte order explicit instead of trusting the platform's.
  const le = new Uint8Array(samples.length * 4);
  const view = new DataView(le.buffer);
  for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < le.length; i += CHUNK) bin += String.fromCharCode(...le.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Resampler for mic audio to the Whisper rate: window-averaged when going down (a cheap low-pass), linear when going up. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  if (ratio > 1) {
    for (let i = 0; i < out.length; i++) {
      const from = Math.floor(i * ratio);
      const to = Math.min(input.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = from; j < to; j++) sum += input[j];
      out[i] = sum / (to - from);
    }
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Root-mean-square level of a block of samples, 0..1. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Plain text for a speech engine: markdown syntax removed, code summarised, whitespace collapsed. */
export function speakable(markdown: string): string {
  let t = markdown.replace(/\r\n?/g, "\n");
  // Fenced code blocks (``` or ~~~), including an unterminated trailing one.
  t = t.replace(/^[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, (_m, _f, body: string) => {
    const lines = body.replace(/\n+$/, "").split("\n").length;
    return `\ncode block, ${lines} ${lines === 1 ? "line" : "lines"}\n`;
  });
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images -> alt text
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links -> text
  t = t.replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
  t = t.replace(/`+([^`\n]+)`+/g, "$1"); // inline code -> its text
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, ""); // headings
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, ""); // quotes
  t = t.replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/gm, ""); // list markers
  t = t.replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, ""); // rules
  t = t.replace(/\|/g, " "); // table pipes
  t = t.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2").replace(/~~(.+?)~~/g, "$1");
  t = t.replace(/<[^>\n]+>/g, ""); // stray html tags
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Insert dictated text at the cursor (replacing only a selection), adding a single space
 * when the neighbouring characters would otherwise run into the insert. Never touches other text.
 */
export function insertAtCursor(value: string, selStart: number, selEnd: number, insert: string): { value: string; cursor: number } {
  const text = insert.trim();
  const start = Math.max(0, Math.min(selStart, value.length));
  const end = Math.max(start, Math.min(selEnd, value.length));
  if (!text) return { value, cursor: end };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return { value: before + lead + text + trail + after, cursor: before.length + lead.length + text.length + trail.length };
}
