// Pure helpers for voice input and read-aloud: no React, no DOM.

export type HandsFreeState = "off" | "listening" | "transcribing" | "sending" | "waiting" | "speaking";

export type HandsFreeEvent =
  | { type: "start" }
  | { type: "transcribing" }
  | { type: "result"; text: string }
  | { type: "sent" }
  | { type: "turnCompleted"; text: string }
  | { type: "spoken" }
  | { type: "stop" }
  | { type: "error" };

/**
 * The hands-free loop: listen -> transcribe -> send -> wait for the agent -> speak -> listen again.
 * `stop` and `error` always end it. A stop word or an empty result keeps listening (the caller
 * interrupts the agent for a stop word); an empty reply skips speaking.
 */
export function handsFreeNext(state: HandsFreeState, event: HandsFreeEvent): HandsFreeState {
  switch (event.type) {
    case "stop":
    case "error":
      return "off";
    case "start":
      return state === "off" ? "listening" : state;
    case "transcribing":
      return state === "listening" ? "transcribing" : state;
    case "result":
      // A stop word can arrive while the agent is working: the state stays as it is.
      if (state !== "listening" && state !== "transcribing") return state;
      return event.text.trim() && !isStopWord(event.text) ? "sending" : "listening";
    case "sent":
      return state === "sending" ? "waiting" : state;
    case "turnCompleted":
      if (state !== "waiting") return state;
      return event.text.trim() ? "speaking" : "listening";
    case "spoken":
      return state === "speaking" ? "listening" : state;
  }
}

/** "stop" / "cancel" alone, ignoring case and punctuation. */
export function isStopWord(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  return t === "stop" || t === "cancel";
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
