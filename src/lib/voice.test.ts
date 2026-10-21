import { describe, expect, test } from "bun:test";
import { handsFreeNext, insertAtCursor, isStopWord, speakable, type HandsFreeEvent, type HandsFreeState } from "./voice";

const run = (start: HandsFreeState, events: HandsFreeEvent[]) => events.reduce(handsFreeNext, start);

describe("handsFreeNext", () => {
  test("full loop", () => {
    expect(
      run("off", [
        { type: "start" },
        { type: "result", text: "add a test" },
        { type: "sent" },
        { type: "turnCompleted", text: "Done." },
        { type: "spoken" },
      ]),
    ).toBe("listening");
  });
  test("states along the way", () => {
    expect(run("off", [{ type: "start" }])).toBe("listening");
    expect(run("listening", [{ type: "transcribing" }])).toBe("transcribing");
    expect(run("listening", [{ type: "result", text: "go" }])).toBe("sending");
    expect(run("sending", [{ type: "sent" }])).toBe("waiting");
    expect(run("waiting", [{ type: "turnCompleted", text: "ok" }])).toBe("speaking");
  });
  test("empty result and stop word keep listening", () => {
    expect(run("listening", [{ type: "result", text: "  " }])).toBe("listening");
    expect(run("waiting", [{ type: "result", text: "stop" }])).toBe("waiting");
    expect(run("listening", [{ type: "result", text: "Stop." }])).toBe("listening");
  });
  test("an empty reply skips speaking", () => {
    expect(run("waiting", [{ type: "turnCompleted", text: "" }])).toBe("listening");
  });
  test("stop and error end it from anywhere", () => {
    for (const s of ["listening", "transcribing", "sending", "waiting", "speaking"] as const) {
      expect(handsFreeNext(s, { type: "stop" })).toBe("off");
      expect(handsFreeNext(s, { type: "error" })).toBe("off");
    }
  });
  test("irrelevant events are ignored", () => {
    expect(handsFreeNext("off", { type: "turnCompleted", text: "x" })).toBe("off");
    expect(handsFreeNext("listening", { type: "start" })).toBe("listening");
    expect(handsFreeNext("speaking", { type: "sent" })).toBe("speaking");
  });
});

describe("isStopWord", () => {
  test("matches stop and cancel only", () => {
    expect(isStopWord("Stop.")).toBe(true);
    expect(isStopWord(" cancel! ")).toBe(true);
    expect(isStopWord("STOP")).toBe(true);
    expect(isStopWord("stop the build")).toBe(false);
    expect(isStopWord("")).toBe(false);
  });
});

describe("speakable", () => {
  test("strips markdown", () => {
    expect(speakable("## Title\n\nSome **bold** and _italic_ text.")).toBe("Title Some bold and italic text.");
    expect(speakable("- one\n- two\n1. three")).toBe("one two three");
  });
  test("links and inline code become their text", () => {
    expect(speakable("See [the docs](https://x.dev/a) and run `bun test`.")).toBe("See the docs and run bun test.");
  });
  test("fenced code blocks are summarised", () => {
    expect(speakable("Before\n```ts\nconst a = 1;\nconst b = 2;\n```\nAfter")).toBe("Before code block, 2 lines After");
    expect(speakable("```\nx\n```")).toBe("code block, 1 line");
  });
  test("collapses whitespace", () => {
    expect(speakable("a\n\n\n  b \t c")).toBe("a b c");
  });
});

describe("insertAtCursor", () => {
  test("into empty text", () => {
    expect(insertAtCursor("", 0, 0, "hello")).toEqual({ value: "hello", cursor: 5 });
  });
  test("adds a space after existing text", () => {
    expect(insertAtCursor("fix this", 8, 8, "and that")).toEqual({ value: "fix this and that", cursor: 17 });
  });
  test("adds spaces on both sides mid-text and keeps surrounding text", () => {
    const r = insertAtCursor("ab", 1, 1, "X");
    expect(r.value).toBe("a X b");
    expect(r.cursor).toBe(4);
  });
  test("no extra space next to whitespace", () => {
    expect(insertAtCursor("hello ", 6, 6, "world").value).toBe("hello world");
    expect(insertAtCursor("a\nb", 2, 2, "x").value).toBe("a\nx b");
  });
  test("replaces only the selection", () => {
    expect(insertAtCursor("one two three", 4, 7, "2").value).toBe("one 2 three");
  });
  test("ignores empty insert and clamps", () => {
    expect(insertAtCursor("abc", 1, 1, "  ")).toEqual({ value: "abc", cursor: 1 });
    expect(insertAtCursor("abc", 99, 99, "d").value).toBe("abc d");
  });
});
