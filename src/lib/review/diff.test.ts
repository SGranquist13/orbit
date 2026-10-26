import { describe, expect, test } from "bun:test";
import { collapse, inlineChanges, lineDiff, pairs, splitLines, splitRows, stats } from "./diff";

const L = (s: string) => splitLines(s);

describe("lineDiff", () => {
  test("identical texts are all context", () => {
    const rows = lineDiff(L("a\nb\n"), L("a\nb\n"));
    expect(rows).toEqual([
      { kind: "ctx", old: 1, new: 1 },
      { kind: "ctx", old: 2, new: 2 },
    ]);
  });
  test("a replaced line is a deletion then an addition", () => {
    const rows = lineDiff(L("a\nb\nc"), L("a\nB\nc"));
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "del", "add", "ctx"]);
    expect(stats(rows)).toEqual({ additions: 1, deletions: 1 });
    expect(pairs(rows).get(2)).toBe(2);
  });
  test("added and removed files", () => {
    expect(lineDiff([], L("x\ny")).every((r) => r.kind === "add")).toBe(true);
    expect(lineDiff(L("x\ny"), []).every((r) => r.kind === "del")).toBe(true);
  });
  test("line numbers stay aligned after an insertion", () => {
    const rows = lineDiff(L("a\nb\nc"), L("a\nnew\nb\nc"));
    expect(rows.at(-1)).toEqual({ kind: "ctx", old: 3, new: 4 });
  });
  test("whitespace-only changes can be ignored", () => {
    const a = L("if (x) {\n  y();\n}"),
      b = L("if (x) {\n    y();  \n}");
    expect(stats(lineDiff(a, b))).toEqual({ additions: 1, deletions: 1 });
    expect(stats(lineDiff(a, b, { ignoreWhitespace: true }))).toEqual({ additions: 0, deletions: 0 });
    expect(stats(lineDiff(L("a = b + c"), L("a  =  b +\tc"), { ignoreWhitespace: true }))).toEqual({ additions: 0, deletions: 0 });
    expect(stats(lineDiff(L("sss"), L("s"), { ignoreWhitespace: true }))).toEqual({ additions: 1, deletions: 1 });
    expect(stats(lineDiff(a, L("if (x) {\n  z();\n}"), { ignoreWhitespace: true }))).toEqual({ additions: 1, deletions: 1 });
  });
  test("CRLF and a missing final newline don't create changes", () => {
    expect(stats(lineDiff(L("a\r\nb\r\n"), L("a\nb")))).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("collapse", () => {
  const old = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  const neu = [...old];
  neu[14] = "changed";
  const rows = lineDiff(old, neu);
  test("keeps context around the change and gaps the rest", () => {
    const blocks = collapse(rows, 3);
    expect(blocks.map((b) => b.kind)).toEqual(["gap", "rows", "gap"]);
    expect(blocks[1].rows.length).toBe(3 + 2 + 3);
  });
  test("kept rows (comment anchors) stay visible", () => {
    const blocks = collapse(rows, 3, (r) => r.kind === "ctx" && r.new === 2);
    expect(blocks[0].kind).toBe("rows");
    expect(blocks[0].rows.some((r) => r.kind === "ctx" && r.new === 2)).toBe(true);
  });
  test("short hidden runs are shown instead of gapped", () => {
    const blocks = collapse(lineDiff(L("a\nb\nc\nd\ne"), L("a\nb\nc\nd\nE")), 1);
    expect(blocks.every((b) => b.kind === "rows")).toBe(true);
  });
});

describe("splitRows", () => {
  test("pairs deletions with additions and pads the longer side", () => {
    const s = splitRows(lineDiff(L("a\nx\ny\nb"), L("a\nX\nb")));
    expect(s.map((r) => [r.left?.kind ?? null, r.right?.kind ?? null])).toEqual([
      ["ctx", "ctx"],
      ["del", "add"],
      ["del", null],
      ["ctx", "ctx"],
    ]);
  });
});

describe("inlineChanges", () => {
  test("marks the changed word", () => {
    const r = inlineChanges("const a = 1;", "const a = 2;");
    expect(r.a).toEqual([[10, 11]]);
    expect(r.b).toEqual([[10, 11]]);
  });
  test("gives up on unrelated lines", () => {
    expect(inlineChanges("hello world", "return 42;")).toEqual({ a: [], b: [] });
  });
});
