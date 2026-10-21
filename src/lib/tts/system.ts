// The system voices fallback: the webview's built-in speech synthesis (no network, no model download).

const synth = (): SpeechSynthesis | null => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);

export function ttsAvailable(): boolean {
  return synth() !== null;
}

/** Installed voices. They load asynchronously in Chromium, so wait for `voiceschanged` when the list is empty. */
export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const now = s.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      s.removeEventListener("voiceschanged", done);
      window.clearTimeout(timer);
      resolve(s.getVoices());
    };
    // Some systems never fire the event (no voices installed): give up after a moment.
    const timer = window.setTimeout(done, 1500);
    s.addEventListener("voiceschanged", done);
  });
}

let current: SpeechSynthesisUtterance | null = null;
let finishCurrent: (() => void) | null = null;
let generation = 0;

/** Speaks `text`; resolves when it ends or is cancelled. A new call cancels the previous one. */
export async function speak(text: string, opts: { voice?: string; rate?: number; beforeStart?: () => Promise<void>; onStart?: () => void } = {}): Promise<void> {
  const s = synth();
  if (!s || !text.trim()) return;
  cancel();
  const mine = generation;
  const u = new SpeechSynthesisUtterance(text);
  if (opts.voice) {
    const v = (await listVoices()).find((x) => x.name === opts.voice);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
  }
  await opts.beforeStart?.();
  if (mine !== generation) return;
  u.rate = Math.min(2, Math.max(0.5, opts.rate ?? 1));
  current = u;
  return new Promise<void>((resolve) => {
    const finish = () => {
      if (current === u) { current = null; finishCurrent = null; }
      resolve();
    };
    finishCurrent = finish;
    u.onend = finish;
    u.onerror = finish; // "canceled" / "interrupted" land here too
    opts.onStart?.();
    s.speak(u);
  });
}

export function cancel(): void {
  generation++;
  finishCurrent?.();
  const s = synth();
  if (!s) return;
  // Resolve the pending promise through onerror/onend; clear first so a following speak() is not cut off.
  s.cancel();
}

export function speaking(): boolean {
  const s = synth();
  return !!s && (s.speaking || s.pending || current !== null);
}
