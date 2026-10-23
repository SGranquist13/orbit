import { describe, expect, test } from "bun:test";
import { integerToWords, normalizeText, numberToWords, ordinalToWords, splitFirstClause, splitSentences, yearToWords } from "./normalize";

describe("numbers", () => {
  test("integers", () => {
    expect(integerToWords(0)).toBe("zero");
    expect(integerToWords(21)).toBe("twenty one");
    expect(integerToWords(1234)).toBe("one thousand two hundred thirty four");
    expect(integerToWords(1_000_005)).toBe("one million five");
  });
  test("decimals and negatives", () => {
    expect(numberToWords("3.14")).toBe("three point one four");
    expect(numberToWords("1,200")).toBe("one thousand two hundred");
    expect(numberToWords("-5")).toBe("minus five");
  });
  test("ordinals and years", () => {
    expect(ordinalToWords(1)).toBe("first");
    expect(ordinalToWords(22)).toBe("twenty second");
    expect(ordinalToWords(40)).toBe("fortieth");
    expect(yearToWords(1999)).toBe("nineteen ninety nine");
    expect(yearToWords(2005)).toBe("two thousand five");
    expect(yearToWords(2024)).toBe("twenty twenty four");
    expect(yearToWords(1905)).toBe("nineteen oh five");
  });
});

describe("normalizeText", () => {
  test("numbers, ordinals, years, percent, money", () => {
    expect(normalizeText("I have 3 apples")).toBe("I have three apples");
    expect(normalizeText("the 21st of May 1999")).toBe("the twenty first of May nineteen ninety nine");
    expect(normalizeText("Coverage is 85%.")).toBe("Coverage is eighty five percent.");
    expect(normalizeText("It costs $5 or $3.50")).toBe("It costs five dollars or three dollars fifty cents");
    expect(normalizeText("about 1,200 files")).toBe("about one thousand two hundred files");
  });
  test("symbols", () => {
    expect(normalizeText("a & b")).toBe("a and b");
    expect(normalizeText("x = 5")).toBe("x equals five");
  });
  test("camelCase, snake_case and kebab-case split", () => {
    expect(normalizeText("useVoiceStore")).toBe("use Voice Store");
    expect(normalizeText("parse_plan_card")).toBe("parse plan card");
    expect(normalizeText("dark-mode toggle")).toBe("dark mode toggle");
    expect(normalizeText("XMLHttpRequest")).toBe("ex em el Http Request");
  });
  test("extensions and paths", () => {
    expect(normalizeText("Edit Chat.tsx now")).toBe("Edit Chat dot tee ess ex now");
    expect(normalizeText("src/lib/voice.ts")).toBe("src slash lib slash voice dot tee ess");
    expect(normalizeText("see package.json.")).toBe("see package dot jason.");
    expect(normalizeText("run --force")).toBe("run dash dash force");
  });
  test("short ALL-CAPS words are spelled; longer ones and I/A are not", () => {
    expect(normalizeText("the API is down")).toBe("the ay pee eye is down");
    expect(normalizeText("I am OK")).toBe("I am okay");
    expect(normalizeText("README")).toBe("README");
    expect(normalizeText("two APIs")).toBe("two ay pee eyes");
  });
  test("punctuation survives; Object prototype names are plain words", () => {
    expect(normalizeText("Done, then \"go\".")).toBe("Done, then go.");
    expect(normalizeText("constructor")).toBe("constructor");
    expect(normalizeText("e.g. this")).toBe("for example this");
  });
  test("versions and times", () => {
    expect(normalizeText("v1.2.3")).toBe("version one dot two dot three");
    expect(normalizeText("at 10:30")).toBe("at ten thirty");
  });
});

describe("splitFirstClause", () => {
  const long = "I looked through the routines module and the scheduler tick, and found the flaky test was a race on the clock. Then more.";
  test("cuts a long opening sentence at its first clause so audio can start sooner", () => {
    const out = splitFirstClause([long.split(". ")[0] + ".", "Then more."]);
    expect(out[0]).toBe("I looked through the routines module and the scheduler tick,");
    expect(out.length).toBe(3);
  });
  test("leaves short sentences and sentences without a usable clause alone", () => {
    expect(splitFirstClause(["Short one, really.", "Next."])).toEqual(["Short one, really.", "Next."]);
    const nocomma = "word ".repeat(30).trim() + ".";
    expect(splitFirstClause([nocomma])).toEqual([nocomma]);
    expect(splitFirstClause([])).toEqual([]);
  });
});

describe("splitSentences", () => {
  test("splits on sentence ends and keeps abbreviations together", () => {
    expect(splitSentences("This is the first sentence. This is the second one! And a third?")).toEqual([
      "This is the first sentence.",
      "This is the second one!",
      "And a third?",
    ]);
    expect(splitSentences("Ask Dr. Smith about it today. Then go.")).toEqual(["Ask Dr. Smith about it today.", "Then go."]);
  });
  test("short fragments merge into the next sentence", () => {
    expect(splitSentences("Okay. That works for the plan we made.")).toEqual(["Okay. That works for the plan we made."]);
  });
  test("long text breaks at commas under the limit", () => {
    const long = Array.from({ length: 12 }, (_, i) => `clause number ${i} here`).join(", ") + ".";
    const parts = splitSentences(long, 80);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 80)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long);
  });
  test("a single long run without punctuation breaks on spaces", () => {
    const parts = splitSentences("word ".repeat(100).trim(), 50);
    expect(parts.every((p) => p.length <= 50)).toBe(true);
  });
});
