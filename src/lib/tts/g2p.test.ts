import { describe, expect, test } from "bun:test";
import { KOKORO_VOCAB } from "./kokoroVocab";
import { buildLexicon, letterToSound, MAX_TOKENS, phonemesToIds, sentenceToChunks, textToPhonemes, wordToPhonemes } from "./g2p";

const lex = buildLexicon(
  { hello: "həlˈO", world: "wˈɜɹld", the: "ði", read: { DEFAULT: "ɹˈid", VBD: "ɹˈɛd" }, dog: "dˈɔɡ", walk: "wˈɔk", play: "plˈA", stop: "stˈɑp", run: "ɹˈʌn", make: "mˈAk", cat: "kˈæt", want: "wˈɑnt", Abel: "ˈAbᵊl", do: "dˈu", three: "θɹˈi", apples: "ˈæpᵊlz" },
  { hello: "SILVER", extra: "ˈɛkstɹə", nothing: null },
);

describe("lexicon", () => {
  test("gold wins over silver, DEFAULT is used for part-of-speech objects, nulls are skipped", () => {
    expect(wordToPhonemes("hello", lex)).toBe("həlˈO");
    expect(wordToPhonemes("read", lex)).toBe("ɹˈid");
    expect(wordToPhonemes("extra", lex)).toBe("ˈɛkstɹə");
    expect(lex.has("nothing")).toBe(false);
  });
  test("lookup is case-insensitive, and keeps case-specific entries", () => {
    expect(wordToPhonemes("Hello", lex)).toBe("həlˈO");
    expect(wordToPhonemes("WORLD", lex)).toBe("wˈɜɹld");
    expect(wordToPhonemes("Abel", lex)).toBe("ˈAbᵊl");
  });
});

describe("inflections from the lexicon's stems", () => {
  test("possessive and plural s: z after voiced, s after voiceless", () => {
    expect(wordToPhonemes("dog's", lex)).toBe("dˈɔɡz");
    expect(wordToPhonemes("dogs", lex)).toBe("dˈɔɡz");
    expect(wordToPhonemes("cats", lex)).toBe("kˈæts");
  });
  test("-ed: t, d, or ɪd", () => {
    expect(wordToPhonemes("walked", lex)).toBe("wˈɔkt");
    expect(wordToPhonemes("played", lex)).toBe("plˈAd");
    expect(wordToPhonemes("wanted", lex)).toBe("wˈɑntᵻd");
    expect(wordToPhonemes("stopped", lex)).toBe("stˈɑpt");
  });
  test("-ing, with dropped e and doubled consonant", () => {
    expect(wordToPhonemes("walking", lex)).toBe("wˈɔkɪŋ");
    expect(wordToPhonemes("making", lex)).toBe("mˈAkɪŋ");
    expect(wordToPhonemes("running", lex)).toBe("ɹˈʌnɪŋ");
  });
  test("contractions fall back to stem + clitic", () => {
    expect(wordToPhonemes("don't", lex)).toBe("dˈunt");
  });
});

describe("letterToSound", () => {
  test("produces only characters Kokoro knows", () => {
    for (const w of ["zustand", "vite", "tauri", "foobar", "quixotic", "strength", "knight", "thought", "xylophone", "rhythm", "psychology", "ghost"]) {
      const ph = letterToSound(w);
      expect(ph.length).toBeGreaterThan(0);
      for (const ch of ph) expect(KOKORO_VOCAB[ch]).toBeDefined();
    }
  });
  test("a few sensible spellings", () => {
    expect(letterToSound("ship")).toBe("ʃˈɪp");
    expect(letterToSound("cat")).toBe("kˈæt");
    expect(letterToSound("cake")).toBe("kˈAk");
    expect(letterToSound("phone")).toBe("fˈOn");
    expect(letterToSound("moon")).toBe("mˈun");
    expect(letterToSound("boy")).toBe("bˈY");
  });
  test("unknown words reach it through wordToPhonemes", () => {
    expect(wordToPhonemes("blorp", lex)).toBe(letterToSound("blorp"));
  });
  test("compounds of known words are joined", () => {
    expect(wordToPhonemes("helloworld", lex)).toBe("həlˈOwˌɜɹld");
  });
});

describe("textToPhonemes", () => {
  test("keeps phrase punctuation and spaces words", () => {
    expect(textToPhonemes("Hello, world!", lex)).toBe("həlˈO, wˈɜɹld!");
    expect(textToPhonemes("hello world... hello?", lex)).toBe("həlˈO wˈɜɹld… həlˈO?");
  });
  test("drops quotes and brackets that Kokoro cannot phrase", () => {
    expect(textToPhonemes('say "hello" now', lex)).not.toContain('"');
  });
  test("numbers are read as words", () => {
    expect(textToPhonemes("3 apples", lex)).toBe("θɹˈi ˈæpᵊlz");
  });
  test("empty input", () => {
    expect(textToPhonemes("  ", lex)).toBe("");
    expect(textToPhonemes("¿¡", lex)).toBe("");
  });
});

describe("tokenisation", () => {
  test("maps phonemes to ids and drops unknown characters", () => {
    expect(phonemesToIds("a b")).toEqual([KOKORO_VOCAB["a"], KOKORO_VOCAB[" "], KOKORO_VOCAB["b"]]);
    expect(phonemesToIds("a§b")).toEqual([KOKORO_VOCAB["a"], KOKORO_VOCAB["b"]]);
    expect(phonemesToIds("$a")).toEqual([KOKORO_VOCAB["a"]]);
  });
  test("vocab has the 115 symbols with the expected anchors", () => {
    expect(Object.keys(KOKORO_VOCAB).length).toBe(115);
    expect(KOKORO_VOCAB["$"]).toBe(0);
    expect(KOKORO_VOCAB[" "]).toBe(16);
    expect(KOKORO_VOCAB["ˈ"]).toBe(156);
  });
  test("sentenceToChunks stays under the model limit", () => {
    expect(sentenceToChunks("Hello world.", lex).length).toBe(1);
    const long = Array.from({ length: 400 }, () => "hello").join(" ");
    const chunks = sentenceToChunks(long, lex);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= MAX_TOKENS && c.length > 0)).toBe(true);
    expect(sentenceToChunks("", lex)).toEqual([]);
  });
});
