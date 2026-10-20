import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";

export interface TypingProjection {
  text: string;
  caret: number;
  removed: { at: number; text: string }[];
}
/** Exact matching only. Ambiguous edits continue after the previous edit's cursor. */
export function locateEdit(text: string, old: string, cursor = 0): number {
  if (!old) return -1;
  const first = text.indexOf(old);
  if (first < 0 || text.indexOf(old, first + 1) < 0) return first;
  const next = text.indexOf(old, cursor);
  return next < 0 ? first : next;
}
export function editProjection(base: string, edits: unknown[], previousCursor = 0): TypingProjection | null {
  let text = base,
    cursor = previousCursor;
  const removed: TypingProjection["removed"] = [];
  for (const raw of edits) {
    if (!raw || typeof raw !== "object") break;
    const e = raw as Record<string, unknown>;
    if (typeof e.old_string !== "string" || typeof e.new_string !== "string") break;
    let at = locateEdit(text, e.old_string, cursor);
    if (at < 0) return null;
    do {
      const end = at + e.old_string.length;
      for (const r of removed) if (r.at >= end) r.at += e.new_string.length - e.old_string.length;
      removed.push({ at, text: e.old_string });
      text = text.slice(0, at) + e.new_string + text.slice(end);
      cursor = at + e.new_string.length;
      at = e.replace_all ? text.indexOf(e.old_string, cursor) : -1;
    } while (at >= 0);
  }
  return removed.length ? { text, caret: cursor, removed } : null;
}
/** Accept incomplete hunks, including the last partially generated added line.
 * Context/removals must match the original file; malformed/foreign patches wait for disk. */
export function diffProjection(base: string, diff: string): TypingProjection | null {
  const source = base.split("\n");
  const output: string[] = [],
    removed: TypingProjection["removed"] = [];
  let index = 0,
    inHunk = false,
    caret = 0,
    changed = false;
  const lines = diff.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      const start = Math.max(0, Number(header[1]) - 1);
      if (start < index || start > source.length) return null;
      output.push(...source.slice(index, start));
      index = start;
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line === "" && n === lines.length - 1) break;
    const prefix = line[0],
      value = line.slice(1);
    if (prefix === " " || prefix === "-") {
      if (source[index] !== value) {
        if (n === lines.length - 1 && source[index]?.startsWith(value)) break;
        return null;
      }
      if (prefix === " ") output.push(value);
      else {
        removed.push({ at: output.join("\n").length + (output.length ? 1 : 0), text: value + "\n" });
        changed = true;
      }
      index++;
    } else if (prefix === "+") {
      output.push(value);
      changed = true;
      caret = output.join("\n").length;
    } else break;
  }
  if (!changed) return null;
  output.push(...source.slice(index));
  return { text: output.join("\n"), caret, removed };
}
/** Counts only generated additions, without retaining draft strings in activity state. */
export function draftLineCount(name: string, input: Record<string, unknown>, rel: string): number {
  const lines = (value: unknown) => (typeof value === "string" && value.length ? value.replace(/\n$/, "").split("\n").length : 0);
  if (name === "Write") return lines(input.content);
  if (name === "NotebookEdit") return lines(input.new_source);
  if (name === "MultiEdit" && Array.isArray(input.edits)) return input.edits.reduce((sum, e) => sum + lines(e?.new_string), 0);
  if (name === "Edit" && Array.isArray(input.changes))
    return input.changes.reduce((sum, c) => {
      if (
        typeof c?.path !== "string" ||
        !(c.path === rel || c.path.replaceAll("\\", "/").endsWith("/" + rel)) ||
        typeof c.diff !== "string"
      )
        return sum;
      return sum + c.diff.split("\n").filter((line: string) => line.startsWith("+") && !line.startsWith("+++")).length;
    }, 0);
  return lines(input.new_string);
}
export function draftProjection(
  base: string,
  name: string,
  input: Record<string, unknown>,
  rel: string,
  cursor = 0,
): TypingProjection | null {
  if (name === "Write" && typeof input.content === "string")
    return { text: input.content, caret: input.content.length, removed: [] };
  // Notebook JSON is not cell source: leave notebook editing to disk/replay.
  if (name === "NotebookEdit") return null;
  if (name === "MultiEdit" && Array.isArray(input.edits)) return editProjection(base, input.edits, cursor);
  if (name === "Edit" && Array.isArray(input.changes)) {
    const change = input.changes.find(
      (c) => c && typeof c.path === "string" && (c.path === rel || c.path.replaceAll("\\", "/").endsWith("/" + rel)),
    );
    return change && typeof change.diff === "string" ? diffProjection(base, change.diff) : null;
  }
  return name === "Edit" ? editProjection(base, [input], cursor) : null;
}
/** Line diff once per landed change; frames only slice the inserted strings. */
export function makeReplay(before: string, after: string) {
  const a = Text.of(before.split("\n")),
    b = Text.of(after.split("\n"));
  const chunks = Chunk.build(a, b, { scanLimit: 1000, timeout: 40 }).map((c) => ({
    from: Math.min(c.fromA, before.length),
    to: Math.min(c.toA, before.length),
    insert: after.slice(c.fromB, c.toB),
  }));
  const count = chunks.reduce((sum, c) => sum + c.insert.length, 0);
  const duration = Math.min(1500, Math.max(16, count * 4));
  return {
    count,
    duration,
    frame(elapsed: number): TypingProjection {
      if (elapsed >= duration) return { text: after, caret: after.length, removed: [] };
      let remaining = Math.floor((count * Math.max(0, elapsed)) / duration),
        text = "",
        previous = 0,
        caret = 0;
      const removed: TypingProjection["removed"] = [];
      for (const c of chunks) {
        text += before.slice(previous, c.from);
        if (c.to > c.from) removed.push({ at: text.length, text: before.slice(c.from, c.to) });
        const part = c.insert.slice(0, remaining);
        text += part;
        if (part.length) caret = text.length;
        remaining -= part.length;
        previous = c.to;
      }
      return { text: text + before.slice(previous), caret, removed };
    },
  };
}
