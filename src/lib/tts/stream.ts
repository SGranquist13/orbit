import { speakable } from "../voice";

/** Keeps incomplete words and Markdown in the buffer until their boundary is known. */
export class SpeechSplitter {
  private buffer = "";
  private first = true;

  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  end(): string[] { return this.drain(true); }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    const emit = (raw: string) => {
      // Protect literal inline code from emphasis stripping (e.g. `foo_bar_baz`).
      const code: string[] = [];
      const masked = raw.replace(/(`+)([^`\n]+)\1/g, (_match, _ticks: string, body: string) => {
        code.push(body);
        return `\u0000${code.length - 1}\u0000`;
      });
      const text = speakable(masked).replace(/\*+|~~/g, "").replace(/(?<!\w)_+|_+(?!\w)/g, "")
        .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => code[Number(index)]).trim();
      if (text) { out.push(text); this.first = false; }
    };
    while (this.buffer) {
      const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n/m.exec(this.buffer);
      const limit = fence ? fence.index : this.buffer.length;
      let cut = 0;
      let inline = "";
      let brackets = 0;
      let url = 0;
      for (let i = 0; i < limit; i++) {
        const c = this.buffer[i];
        if (c === "`") {
          const run = this.buffer.slice(i).match(/^`+/)![0];
          if (!inline) inline = run; else if (inline === run) inline = "";
          i += run.length - 1;
          continue;
        }
        if (inline) continue;
        if (c === "[") brackets++;
        if (c === "]") brackets = Math.max(0, brackets - 1);
        if (c === "(" && (this.buffer[i - 1] === "]" || url)) url++;
        if (c === ")" && url) { url--; continue; }
        if (brackets || url) continue;
        if (c === "\n" && /^(?:\s*\n|[ \t]*(?:[-*+]|\d+[.)])[ \t]+)/.test(this.buffer.slice(i + 1))) { cut = i + 1; break; }
        if (!/[.!?… ,;:—]/.test(c) || c === " ") continue;
        const tail = this.buffer.slice(i + 1).match(/^[*_'"”’)]*/)?.[0] ?? "";
        const after = i + 1 + tail.length;
        if (after >= this.buffer.length ? !final : !/\s/.test(this.buffer[after])) continue;
        const prefix = this.buffer.slice(0, i + 1);
        if (c === "." && /^[ \t]*\d+\.$/.test(prefix.slice(prefix.lastIndexOf("\n") + 1))) continue;
        if (c === "." && /\b(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc|e\.g|i\.e|approx|st|no)\.$/i.test(prefix)) continue;
        if (/[.!?…]/.test(c) || (this.first && /[,;:—]/.test(c) && speakable(prefix).split(/\s+/).length >= 4)) { cut = after; break; }
      }
      if (cut) { emit(this.buffer.slice(0, cut)); this.buffer = this.buffer.slice(cut); continue; }
      if (fence) {
        if (fence.index > 0) { emit(this.buffer.slice(0, fence.index)); this.buffer = this.buffer.slice(fence.index); continue; }
        const bodyStart = fence[0].length;
        const marker = fence[1][0];
        const close = new RegExp("^[ \t]*" + marker + "{" + fence[1].length + ",}[ \t]*(?:\\n|$)", "m").exec(this.buffer.slice(bodyStart));
        if (!close || (!final && bodyStart + close.index + close[0].length === this.buffer.length && !close[0].endsWith("\n"))) break;
        const body = this.buffer.slice(bodyStart, bodyStart + close.index).replace(/\n+$/, "");
        const n = body ? body.split("\n").length : 0;
        emit(`code block, ${n} ${n === 1 ? "line" : "lines"}`);
        this.buffer = this.buffer.slice(bodyStart + close.index + close[0].length);
        continue;
      }
      if (final) { emit(this.buffer); this.buffer = ""; }
      break;
    }
    return out;
  }
}

export interface SpeechStream {
  push(delta: string): void;
  end(): void;
  cancel(): void;
  /** Hold playback without holding synthesis. */
  setHeld(held: boolean): void;
  done: Promise<void>;
}
