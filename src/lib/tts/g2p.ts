// Grapheme-to-phoneme for Kokoro, with no espeak-ng: misaki's US lexicons (Apache-2.0) for known words, stem
// rules for inflections, and a modest letter-to-sound fallback for the rest. Output uses Kokoro's phoneme
// alphabet (see kokoroVocab.ts). Pure: the lexicon is passed in, loaded by the engine through `voice_file`.
import { KOKORO_VOCAB } from "./kokoroVocab";
import { normalizeText } from "./normalize";

export type Lexicon = Map<string, string>;
export type RawLexicon = Record<string, string | Record<string, string | null> | null>;

/** Merges lexicons in priority order (the first one that has a word wins) into one lookup table. */
export function buildLexicon(...raws: RawLexicon[]): Lexicon {
  const lex: Lexicon = new Map();
  for (const raw of raws) {
    for (const key of Object.keys(raw)) {
      if (lex.has(key)) continue;
      const v = raw[key];
      const ph = typeof v === "string" ? v : (v?.DEFAULT ?? Object.values(v ?? {}).find((x) => !!x) ?? null);
      if (ph) lex.set(key, ph);
    }
  }
  return lex;
}

const lookup = (lex: Lexicon, w: string): string | undefined => lex.get(w) ?? lex.get(w.toLowerCase());

const VOICELESS = new Set(["p", "t", "k", "f", "θ"]);
const SIBILANT = new Set(["s", "z", "ʃ", "ʒ", "ʧ", "ʤ"]);

/** Last phoneme character that is not a stress mark. */
const lastPhone = (ph: string) => [...ph].reverse().find((c) => c !== "ˈ" && c !== "ˌ") ?? "";

function addS(stem: string): string {
  const l = lastPhone(stem);
  if (SIBILANT.has(l)) return `${stem}ᵻz`;
  return VOICELESS.has(l) ? `${stem}s` : `${stem}z`;
}
function addEd(stem: string): string {
  const l = lastPhone(stem);
  if (l === "t" || l === "d") return `${stem}ᵻd`;
  return VOICELESS.has(l) || l === "s" || l === "ʃ" || l === "ʧ" ? `${stem}t` : `${stem}d`;
}
const addIng = (stem: string) => `${stem}ɪŋ`;

/** Inflected forms built from a stem found in the lexicon (misaki does the same). */
function inflected(w: string, lex: Lexicon): string | undefined {
  const tryStem = (stems: string[], add: (s: string) => string) => {
    for (const s of stems) {
      if (s.length < 2) continue;
      const ph = lookup(lex, s);
      if (ph) return add(ph);
    }
    return undefined;
  };
  const doubled = (s: string) => (s.length > 2 && s[s.length - 1] === s[s.length - 2] ? [s.slice(0, -1)] : []);
  if (w.endsWith("'s") || w.endsWith("’s")) return tryStem([w.slice(0, -2)], addS);
  if (w.endsWith("s'")) return tryStem([w.slice(0, -2), w.slice(0, -1)], (s) => s);
  if (w.endsWith("ies") && w.length > 4) {
    const r = tryStem([`${w.slice(0, -3)}y`], addS);
    if (r) return r;
  }
  if (w.endsWith("es")) {
    const r = tryStem([w.slice(0, -2), w.slice(0, -1)], addS);
    if (r) return r;
  }
  if (w.endsWith("s") && !w.endsWith("ss")) {
    const r = tryStem([w.slice(0, -1)], addS);
    if (r) return r;
  }
  if (w.endsWith("ied")) {
    const r = tryStem([`${w.slice(0, -3)}y`], addEd);
    if (r) return r;
  }
  if (w.endsWith("ed")) {
    const r = tryStem([w.slice(0, -2), w.slice(0, -1), ...doubled(w.slice(0, -2))], addEd);
    if (r) return r;
  }
  if (w.endsWith("ing")) {
    const base = w.slice(0, -3);
    const r = tryStem([base, `${base}e`, ...doubled(base)], addIng);
    if (r) return r;
  }
  if (w.endsWith("ly") && w.length > 4) {
    const r = tryStem([w.slice(0, -2), `${w.slice(0, -3)}le`, `${w.slice(0, -3)}y`], (s) => `${s}li`);
    if (r) return r;
  }
  if (w.endsWith("er") && w.length > 4) {
    const r = tryStem([w.slice(0, -2), w.slice(0, -1), ...doubled(w.slice(0, -2))], (s) => `${s}ɚ`);
    if (r) return r;
  }
  return undefined;
}

/** Contractions the lexicon may not list: stem + clitic. */
const CLITICS: Record<string, string> = { "'s": "z", "'d": "d", "'ll": "ᵊl", "'ve": "v", "'re": "ɚ", "'m": "m", "n't": "nt" };

// ── letter-to-sound fallback ──

const LONG: Record<string, string> = { a: "A", e: "i", i: "I", o: "O", u: "u" };
const SHORT: Record<string, string> = { a: "æ", e: "ɛ", i: "ɪ", o: "ɑ", u: "ʌ", y: "ɪ" };
const VOWELS = "aeiouy";
const isVowel = (c: string | undefined) => !!c && VOWELS.includes(c);

/**
 * Rule-based pronunciation guess for words missing from the lexicon (names, jargon, identifiers). Not
 * linguistically complete: it aims for something intelligible, with stress on the first vowel.
 */
export function letterToSound(input: string): string {
  const w = input.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  let out = "";
  let stressed = false;
  const V = (ph: string) => {
    if (stressed) return ph;
    stressed = true;
    return `ˈ${ph}`;
  };
  let i = 0;
  while (i < w.length) {
    const rest = w.slice(i);
    const c = w[i];
    const prev = w[i - 1];
    const next = w[i + 1];
    const eat = (n: number, ph: string) => {
      out += ph;
      i += n;
    };
    // consonant clusters
    if (rest.startsWith("tch")) { eat(3, "ʧ"); continue; }
    if (rest.startsWith("dge")) { eat(3, "ʤ"); continue; }
    if (rest.startsWith("tion")) { eat(4, "ʃᵊn"); continue; }
    if (rest.startsWith("sion")) { eat(4, "ʒᵊn"); continue; }
    if (rest.startsWith("ture") && i > 0) { eat(4, "ʧɚ"); continue; }
    if (rest.startsWith("igh")) { eat(3, V("I")); continue; }
    if (rest.startsWith("ough")) { eat(4, V("O")); continue; }
    if (rest.startsWith("ch")) { eat(2, "ʧ"); continue; }
    if (rest.startsWith("sh")) { eat(2, "ʃ"); continue; }
    if (rest.startsWith("th")) { eat(2, "θ"); continue; }
    if (rest.startsWith("ph")) { eat(2, "f"); continue; }
    if (rest.startsWith("wh")) { eat(2, "w"); continue; }
    if (rest.startsWith("ck")) { eat(2, "k"); continue; }
    if (rest.startsWith("nk")) { eat(2, "ŋk"); continue; }
    if (rest.startsWith("ng")) { eat(2, "ŋ"); continue; }
    if (rest.startsWith("qu")) { eat(2, "kw"); continue; }
    if (rest.startsWith("kn") && i === 0) { eat(2, "n"); continue; }
    if (rest.startsWith("wr") && i === 0) { eat(2, "ɹ"); continue; }
    if (rest.startsWith("gh")) { eat(2, i === 0 ? "ɡ" : isVowel(prev) ? "" : "ɡ"); continue; }
    if (rest.startsWith("mb") && i + 2 === w.length) { eat(2, "m"); continue; }
    // vowel teams
    if (rest.startsWith("ee") || rest.startsWith("ea") || rest.startsWith("ie")) { eat(2, V("i")); continue; }
    if (rest.startsWith("oo")) { eat(2, V("u")); continue; }
    if (rest.startsWith("ou")) { eat(2, V("W")); continue; }
    if (rest.startsWith("ow")) { eat(2, V(i + 2 >= w.length ? "O" : "W")); continue; }
    if (rest.startsWith("oa")) { eat(2, V("O")); continue; }
    if (rest.startsWith("ai") || rest.startsWith("ay") || rest.startsWith("ei") || rest.startsWith("ey")) { eat(2, V("A")); continue; }
    if (rest.startsWith("oi") || rest.startsWith("oy")) { eat(2, V("Y")); continue; }
    if (rest.startsWith("au") || rest.startsWith("aw")) { eat(2, V("ɔ")); continue; }
    if (rest.startsWith("ue") || rest.startsWith("ew") || rest.startsWith("eu") || rest.startsWith("ui")) { eat(2, V("u")); continue; }
    if (rest.startsWith("ar")) { eat(2, V("ɑɹ")); continue; }
    if (rest.startsWith("or")) { eat(2, V("ɔɹ")); continue; }
    if (rest.startsWith("er") || rest.startsWith("ir") || rest.startsWith("ur")) { eat(2, stressed ? "ɚ" : V("ɜɹ")); continue; }
    // single vowels
    if ("aeiou".includes(c)) {
      const tail = w.slice(i + 1);
      if (c === "e" && i === w.length - 1 && i > 0) { i++; continue; } // silent final e
      if (c === "e" && tail === "s" && i > 0) { i++; continue; }
      if (tail.length === 0) { eat(1, c === "a" ? "ə" : c === "e" ? V("i") : V(LONG[c])); continue; } // open final vowel
      if (/^[bcdfghjklmnpqrstvwxz]e$/.test(tail) && stressed === false) { eat(1, V(c === "u" ? "u" : LONG[c])); continue; } // magic e
      eat(1, stressed ? (c === "a" || c === "u" ? "ə" : SHORT[c]) : V(SHORT[c]));
      continue;
    }
    if (c === "y") {
      if (i === 0) { eat(1, "j"); continue; }
      const alone = !w.slice(0, i).split("").some(isVowel);
      eat(1, i === w.length - 1 ? (alone ? V("I") : "i") : V("ɪ"));
      continue;
    }
    // consonants
    switch (c) {
      case "c": {
        if (next === "c" && "eiy".includes(w[i + 2] ?? "")) { eat(2, "ks"); break; }
        eat(next === "c" ? 2 : 1, "eiy".includes(next ?? "") ? "s" : "k");
        break;
      }
      case "g":
        eat(next === "g" ? 2 : 1, "eiy".includes(next ?? "") ? "ʤ" : "ɡ");
        break;
      case "s":
        eat(next === "s" ? 2 : 1, isVowel(prev) && isVowel(next) ? "z" : "s");
        break;
      case "x": eat(1, i === 0 ? "z" : "ks"); break;
      case "j": eat(1, "ʤ"); break;
      case "q": eat(1, "k"); break;
      case "r": eat(next === "r" ? 2 : 1, "ɹ"); break;
      case "h": eat(1, "h"); break;
      default: {
        // b d f k l m n p t v w z; doubled letters sound once
        const ph = c === "k" || "bdflmnptvwz".includes(c) ? c : "";
        eat(next === c ? 2 : 1, ph);
      }
    }
  }
  return out;
}

/** Spoken names for letters, for spelled-out acronyms the lexicon would read as words. */
const OVERRIDES: Record<string, string> = {
  ay: "ˈA", aitch: "ˈAʧ", jay: "ʤˈA", kay: "kˈA", el: "ˈɛl", em: "ˈɛm", en: "ˈɛn", ess: "ˈɛs", ar: "ˈɑɹ", eff: "ˈɛf", cue: "kjˈu", ex: "ˈɛks",
  zee: "zˈi", vee: "vˈi", dee: "dˈi", gee: "ʤˈi", pee: "pˈi", tee: "tˈi", bee: "bˈi", ee: "ˈi", jason: "ʤˈAsᵊn", sequel: "sˈikwᵊl",
  tomel: "tˈɑmᵊl", yamel: "jˈæmᵊl", github: "ɡˈɪthʌb", wasm: "wˈæzᵊm", npm: "ˈɛnpˈipˈiˈɛm", cli: "sˈiˌɛlˈI", vite: "vˈit", tauri: "tˈWɹi",
  regex: "ɹˈɛʤˌɛks", config: "kˈɑnfˌɪɡ", async: "ˈAsˌɪŋk", args: "ˈɑɹɡz", repo: "ɹˈipO", repos: "ɹˈipOz", params: "pəɹˈæmz", stdout: "stˈædˌWt",
  stderr: "stˈædˌɛɹ", webview: "wˈɛbvjˌu", readme: "ɹˈidmi", codex: "kˈOdˌɛks", zustand: "zˈWstˌænd", lib: "lˈɪb", src: "sˈɔɹs", dev: "dˈɛv",
};

/** Pronunciation of one word (no punctuation) in Kokoro's alphabet. */
export function wordToPhonemes(word: string, lex: Lexicon): string {
  const w = word.replace(/’/g, "'");
  if (!w) return "";
  const lower = w.toLowerCase();
  const over = Object.prototype.hasOwnProperty.call(OVERRIDES, lower) ? OVERRIDES[lower] : undefined;
  if (over) return over;
  const direct = lookup(lex, w);
  if (direct) return direct;
  const inf = inflected(lower, lex);
  if (inf) return inf;
  for (const [suffix, ph] of Object.entries(CLITICS)) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      const stem = lookup(lex, lower.slice(0, -suffix.length));
      if (stem) return suffix === "'s" ? addS(stem) : `${stem}${ph}`;
    }
  }
  if (lower.includes("'")) return wordToPhonemes(lower.replace(/'/g, ""), lex);
  // compound of two known words ("workflow", "filename")
  if (lower.length >= 6) {
    for (let k = 3; k <= lower.length - 3; k++) {
      const a = lex.get(lower.slice(0, k));
      const b = lex.get(lower.slice(k));
      if (a && b) return a + b.replace(/ˈ/g, "ˌ");
    }
  }
  return letterToSound(lower);
}

/** Punctuation Kokoro phrases with; anything else between words becomes a space. */
const KEEP_PUNCT = new Set([",", ".", "!", "?", ";", ":", "—", "…"]);

/** Whole text to a phoneme string: normalised, looked up word by word, with sentence punctuation kept. */
export function textToPhonemes(text: string, lex: Lexicon): string {
  const normalised = normalizeText(text).replace(/\.{2,}/g, "…").replace(/\s+-\s+|--+|–/g, " — ");
  const tokens = normalised.match(/[A-Za-z][A-Za-z'’]*|\d+|[^\sA-Za-z\d]/g) ?? [];
  let out = "";
  const sep = () => (out && !/\s$/.test(out) ? " " : "");
  for (let n = 0; n < tokens.length; n++) {
    const tok = tokens[n];
    if (/^[A-Za-z]/.test(tok)) {
      const lower = tok.toLowerCase();
      const nextWord = tokens.slice(n + 1).find((t) => /^[A-Za-z]/.test(t)) ?? "";
      // Articles reduce: "the" is ði only before a vowel sound, "a" is the schwa-like ɐ.
      const ph = lower === "the" ? (/^([aeiou]|hour|honest|heir)/i.test(nextWord) ? "ði" : "ðə") : lower === "a" ? "ɐ" : wordToPhonemes(tok, lex);
      out += sep() + ph;
    } else if (/^\d+$/.test(tok)) out += sep() + digitsWord(tok).split(" ").map((w) => wordToPhonemes(w, lex)).join(" ");
    else if (KEEP_PUNCT.has(tok)) out = out.replace(/ $/, "") + tok + " ";
    else if (tok === "(" || tok === ")") out = out.replace(/ $/, "") + ", ";
  }
  return out.trim();
}

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const digitsWord = (d: string) => d.split("").map((x) => DIGIT_WORDS[Number(x)]).join(" ");

/** Phonemes to token ids; characters Kokoro does not know are dropped. */
export function phonemesToIds(ph: string): number[] {
  const ids: number[] = [];
  for (const ch of ph) {
    const id = KOKORO_VOCAB[ch];
    if (id !== undefined && ch !== "$") ids.push(id);
  }
  return ids;
}

/** Model input limit: the id sequence is wrapped in two boundary tokens and must stay within 512 positions. */
export const MAX_TOKENS = 510;

/** One sentence to model-ready id chunks (usually one; split at spaces if the phonemes run too long). */
export function sentenceToChunks(sentence: string, lex: Lexicon): number[][] {
  const ph = textToPhonemes(sentence, lex);
  if (!ph) return [];
  const ids = phonemesToIds(ph);
  if (ids.length === 0) return [];
  if (ids.length <= MAX_TOKENS) return [ids];
  const chunks: number[][] = [];
  let cur = "";
  for (const word of ph.split(" ")) {
    if (phonemesToIds(`${cur} ${word}`).length > MAX_TOKENS && cur) {
      chunks.push(phonemesToIds(cur));
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) chunks.push(phonemesToIds(cur).slice(0, MAX_TOKENS));
  return chunks.filter((c) => c.length > 0);
}
