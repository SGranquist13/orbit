import { describe, expect, test } from "bun:test";
import { SpeechSplitter } from "./stream";

function split(chunks: string[]) {
  const s = new SpeechSplitter();
  return [...chunks.flatMap((c) => s.push(c)), ...s.end()];
}

describe("incremental speech splitter", () => {
  test("sentences start before end and incomplete words wait", () => {
    const s = new SpeechSplitter();
    expect(s.push("Hel")).toEqual([]);
    expect(s.push("lo world. Nex")).toEqual(["Hello world."]);
    expect(s.push("t sentence!")).toEqual([]);
    expect(s.end()).toEqual(["Next sentence!"]);
  });
  test("first clause needs four words and only the first clause breaks early", () => {
    expect(split(["Here are four words, and here are more, still one sentence. "]))
      .toEqual(["Here are four words,", "and here are more, still one sentence."]);
    expect(split(["Hi there, friend. "])).toEqual(["Hi there, friend."]);
  });
  test("markdown split anywhere keeps content and removes syntax", () => {
    const text = "# Heading\n\n- **Bold words** and _italics_ with `code` and [a link](https://example.com).\n- Last item";
    const expected = ["Heading", "Bold words and italics with code and a link.", "Last item"];
    expect(split([text])).toEqual(expected);
    expect(split([...text])).toEqual(expected);
  });
  test("closed fences become one summary and code is never emitted early", () => {
    const s = new SpeechSplitter();
    expect(s.push("```ts\nconst x = 3.5;\n")).toEqual([]);
    expect(s.push("console.log(x);\n``")).toEqual([]);
    expect(s.push("`\nDone. ")).toEqual(["code block, 2 lines", "Done."]);
    expect(s.end()).toEqual([]);
    expect(split(["~~~py\nsecret. "])).toEqual([]);
    expect(split([..."```js\na\nb\n```\n"])).toEqual(["code block, 2 lines"]);
  });
  test("abbreviations, decimals, versions and filenames are intact across deltas", () => {
    const text = "Dr. Smith uses e.g. Chat.tsx, i.e. v1.2 with 3.5 seconds. Next. ";
    const expected = ["Dr. Smith uses e.g. Chat.tsx,", "i.e. v1.2 with 3.5 seconds.", "Next."];
    expect(split([text])).toEqual(expected);
    expect(split([...text])).toEqual(expected);
  });
  test("blank lines and list boundaries flush unpunctuated items", () => {
    const text = "Intro\n\n1. First item\n2. Second item\n- Third item";
    expect(split([...text])).toEqual(["Intro", "First item", "Second item", "Third item"]);
  });
  test("literal inline code content survives emphasis stripping", () => {
    expect(split([..."Use `foo_bar_baz` with **bold. More bold** text. "]))
      .toEqual(["Use foo_bar_baz with bold.", "More bold text."]);
  });
  test("empty input and incomplete fences finish silently", () => {
    expect(split([])).toEqual([]);
    expect(split(["Before\n```ts\nnever say this"])).toEqual(["Before"]);
  });
});
