// Pure diff model for the Review view: line rows, collapsed context, split pairing and in-line changes.
import { diff, presentableDiff } from "@codemirror/merge";

/** 1-based line numbers. `ctx` lines exist on both sides. */
export type Row = { kind: "ctx"; old: number; new: number } | { kind: "del"; old: number } | { kind: "add"; new: number };
export type Block = { kind: "rows"; rows: Row[] } | { kind: "gap"; id: string; rows: Row[] };
export interface SplitRow {
  left: Row | null;
  right: Row | null;
}

export function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** One BMP code unit per distinct line, so the character diff becomes a line diff. */
function encode(lines: string[], ids: Map<string, number>): string {
  let out = "";
  for (const l of lines) {
    let id = ids.get(l);
    if (id === undefined) {
      const n = ids.size;
      // 0x100–0xD7FF, then 0xE000–0xFFFD; past that, lines share codes (still a valid, less precise diff).
      id = n < 0xd700 ? 0x100 + n : 0xe000 + ((n - 0xd700) % 0x1ffd);
      ids.set(l, id);
    }
    out += String.fromCharCode(id);
  }
  return out;
}

export function lineDiff(a: string[], b: string[]): Row[] {
  const ids = new Map<string, number>();
  const changes = diff(encode(a, ids), encode(b, ids), { scanLimit: 20_000, timeout: 1_000 });
  const rows: Row[] = [];
  let i = 0,
    j = 0;
  const ctxUntil = (toA: number) => {
    while (i < toA) rows.push({ kind: "ctx", old: ++i, new: ++j });
  };
  for (const c of changes) {
    ctxUntil(c.fromA);
    while (i < c.toA) rows.push({ kind: "del", old: ++i });
    while (j < c.toB) rows.push({ kind: "add", new: ++j });
  }
  ctxUntil(a.length);
  return rows;
}

/** Keeps `context` lines around every change and every `keep` row; longer unchanged runs become gaps. */
export function collapse(rows: Row[], context: number, keep: (r: Row) => boolean = () => false): Block[] {
  const shown = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, k) => {
    if (r.kind === "ctx" && !keep(r)) return;
    for (let x = Math.max(0, k - context); x <= Math.min(rows.length - 1, k + context); x++) shown[x] = true;
  });
  const blocks: Block[] = [];
  let k = 0;
  while (k < rows.length) {
    const start = k;
    const vis = shown[k];
    while (k < rows.length && shown[k] === vis) k++;
    const run = rows.slice(start, k);
    // Hiding a handful of lines saves nothing and costs a click.
    if (!vis && run.length > 3) blocks.push({ kind: "gap", id: `gap-${start}`, rows: run });
    else if (blocks.length && blocks[blocks.length - 1].kind === "rows") (blocks[blocks.length - 1] as { rows: Row[] }).rows.push(...run);
    else blocks.push({ kind: "rows", rows: run });
  }
  return blocks;
}

/** Side-by-side pairing: within each change run, the i-th deleted line sits next to the i-th added line. */
export function splitRows(rows: Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  let k = 0;
  while (k < rows.length) {
    const r = rows[k];
    if (r.kind === "ctx") {
      out.push({ left: r, right: r });
      k++;
      continue;
    }
    const dels: Row[] = [],
      adds: Row[] = [];
    while (k < rows.length && rows[k].kind === "del") dels.push(rows[k++]);
    while (k < rows.length && rows[k].kind === "add") adds.push(rows[k++]);
    for (let x = 0; x < Math.max(dels.length, adds.length); x++) out.push({ left: dels[x] ?? null, right: adds[x] ?? null });
  }
  return out;
}

/** For each changed line, the old line it replaced (same pairing as the split view). */
export function pairs(rows: Row[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of splitRows(rows)) if (s.left?.kind === "del" && s.right?.kind === "add") m.set(s.right.new, s.left.old);
  return m;
}

export type Ranges = [number, number][];
/** Word-aligned changed ranges inside a replaced line, or nothing when the lines barely resemble each other. */
export function inlineChanges(a: string, b: string): { a: Ranges; b: Ranges } {
  if (a.length + b.length > 2_000) return { a: [], b: [] };
  const changes = presentableDiff(a, b);
  const changed = changes.reduce((n, c) => n + (c.toA - c.fromA) + (c.toB - c.fromB), 0);
  if (changed > (a.length + b.length) * 0.6) return { a: [], b: [] };
  return {
    a: changes.filter((c) => c.toA > c.fromA).map((c) => [c.fromA, c.toA]),
    b: changes.filter((c) => c.toB > c.fromB).map((c) => [c.fromB, c.toB]),
  };
}

export function stats(rows: Row[]) {
  let additions = 0,
    deletions = 0;
  for (const r of rows) r.kind === "add" ? additions++ : r.kind === "del" && deletions++;
  return { additions, deletions };
}
