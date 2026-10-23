// Text normalisation for speech: numbers, symbols and code identifiers become words, and a reply is cut into
// sentences. Pure (no DOM), used by the Kokoro pipeline before pronunciation lookup (see g2p.ts).

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion", "trillion"];

function below1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) parts.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? ` ${ONES[r % 10]}` : ""));
  return parts.join(" ");
}

/** 1234 -> "one thousand two hundred thirty four". Integers only (bigint-safe up to 10^15). */
export function integerToWords(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n < 0) return `minus ${integerToWords(-n)}`;
  n = Math.floor(n);
  if (n < 1000) return n === 0 ? "zero" : below1000(n);
  const parts: string[] = [];
  let scale = 0;
  while (n > 0 && scale < SCALES.length) {
    const group = n % 1000;
    if (group) parts.unshift(`${below1000(group)}${SCALES[scale] ? ` ${SCALES[scale]}` : ""}`);
    n = Math.floor(n / 1000);
    scale++;
  }
  return parts.join(" ");
}

const ORDINAL_IRREGULAR: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };

/** 21 -> "twenty first". */
export function ordinalToWords(n: number): string {
  const words = integerToWords(n).split(" ");
  const last = words[words.length - 1];
  words[words.length - 1] = ORDINAL_IRREGULAR[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return words.join(" ");
}

function digitsToWords(digits: string): string {
  return digits
    .split("")
    .map((d) => ONES[Number(d)])
    .join(" ");
}

/** "3.5" -> "three point five"; "1,200" -> "one thousand two hundred". */
export function numberToWords(raw: string): string {
  const neg = raw.startsWith("-");
  const [int, frac] = raw.replace(/^-/, "").replace(/,/g, "").split(".");
  let out = integerToWords(Number(int || "0"));
  if (frac) out += ` point ${digitsToWords(frac)}`;
  return neg ? `minus ${out}` : out;
}

/** 1999 -> "nineteen ninety nine", 2005 -> "two thousand five", 2024 -> "twenty twenty four". */
export function yearToWords(y: number): string {
  if (y >= 2000 && y < 2010) return y === 2000 ? "two thousand" : `two thousand ${ONES[y - 2000]}`;
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return `${integerToWords(hi)} hundred`;
  return `${integerToWords(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : integerToWords(lo)}`;
}

const LETTER_NAMES: Record<string, string> = {
  a: "ay", b: "bee", c: "see", d: "dee", e: "ee", f: "eff", g: "gee", h: "aitch", i: "eye", j: "jay", k: "kay", l: "el", m: "em",
  n: "en", o: "oh", p: "pee", q: "cue", r: "ar", s: "ess", t: "tee", u: "you", v: "vee", w: "double you", x: "ex", y: "why", z: "zee",
};

export const spellLetters = (s: string): string =>
  s
    .toLowerCase()
    .split("")
    .map((c) => own(LETTER_NAMES, c) ?? c)
    .join(" ");

/** File extensions read as one thing; everything else is spelled. */
const EXT_WORDS: Record<string, string> = {
  json: "jason", sql: "sequel", txt: "text", lock: "lock", toml: "tomel", yaml: "yamel", yml: "yamel", md: "markdown", sh: "shell",
  png: "P N G", jpg: "jay peg", jpeg: "jay peg", gif: "gif", svg: "S V G", env: "env", log: "log", exe: "exe", dll: "D L L",
};

const own = (o: Record<string, string>, k: string): string | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

const ABBREV_WORDS: Record<string, string> = { mr: "mister", mrs: "missus", ms: "miz", dr: "doctor", vs: "versus", etc: "et cetera" };

const ACRONYM_WORDS = new Set(["OK", "ID", "IDS"]);
const ALLCAPS_SKIP = new Set(["A", "I"]);

const SYMBOL_WORDS: Record<string, string> = {
  "&": "and", "&&": "and", "||": "or", "+": "plus", "=": "equals", "==": "equals", "===": "equals", "!=": "not equals", "!==": "not equals",
  "@": "at", "#": "hash", "->": "to", "=>": "arrow", "→": "to", "<": "less than", ">": "greater than", "<=": "less than or equal to",
  ">=": "greater than or equal to", "*": "star", "~": "tilde", "|": "pipe", "/": "slash", "\\": "backslash", "%": "percent", "^": "caret",
  "-": "—", "–": "—", "—": "—", "...": "…", "×": "times", "±": "plus or minus", "°": "degrees", "≈": "about", "≠": "not equals", "…": "…", "·": ",", "•": ",",
};

const CURRENCY: Record<string, [string, string]> = { $: ["dollar", "cent"], "£": ["pound", "pence"], "€": ["euro", "cent"] };
const MAGNITUDE: Record<string, string> = { k: "thousand", m: "million", b: "billion", t: "trillion" };

function plural(n: number, word: string) {
  return n === 1 ? word : `${word}s`;
}

function currencyToWords(sym: string, amount: string, mag: string | undefined): string {
  const [unit, sub] = CURRENCY[sym];
  const clean = amount.replace(/,/g, "");
  const [whole, frac] = clean.split(".");
  if (mag) return `${numberToWords(clean)} ${MAGNITUDE[mag.toLowerCase()]} ${unit}s`;
  const w = Number(whole);
  const out = [`${integerToWords(w)} ${plural(w, unit)}`];
  if (frac && Number(frac) > 0) {
    const cents = Number((frac + "0").slice(0, 2));
    out.push(`${integerToWords(cents)} ${sub === "pence" ? "pence" : plural(cents, sub)}`);
  }
  return out.join(" ");
}

function timeToWords(h: number, m: number): string {
  if (m === 0) return `${integerToWords(h)} o'clock`;
  return `${integerToWords(h)} ${m < 10 ? `oh ${ONES[m]}` : integerToWords(m)}`;
}

function splitIdentifier(s: string): string {
  return s
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ");
}

/** Words inside an identifier: digits become words, short ALL-CAPS runs are spelled out. */
function readPieces(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => {
      if (/^\d+$/.test(p)) return p.length > 1 && p.startsWith("0") ? digitsToWords(p) : numberToWords(p);
      if (/^[A-Z]{2,4}s?$/.test(p) && !ACRONYM_WORDS.has(p)) {
        const plural = p.endsWith("s") && p.length > 2 && p !== p.toLowerCase();
        return plural ? `${spellLetters(p.slice(0, -1))}s` : spellLetters(p);
      }
      if (ACRONYM_WORDS.has(p)) return p === "OK" ? "okay" : p === "ID" ? "eye dee" : "eye dees";
      if (/^[A-Z]$/.test(p) && !ALLCAPS_SKIP.has(p)) return spellLetters(p);
      return p;
    })
    .join(" ");
}

function spellExt(ext: string) {
  return ext.length <= 2 || !/[aeiouy]/i.test(ext) ? spellLetters(ext) : ext;
}

/** One whitespace-delimited chunk without its surrounding punctuation. */
function normCore(core: string): string {
  if (!core) return core;
  const sym = own(SYMBOL_WORDS, core);
  if (sym !== undefined) return sym;
  if (/^e\.g$/i.test(core)) return "for example";
  if (/^i\.e$/i.test(core)) return "that is";
  if (/^([A-Za-z]\.)+[A-Za-z]$/.test(core)) return spellLetters(core.replace(/\./g, ""));
  let m: RegExpMatchArray | null;
  if (/^[A-Z]{2,4}s$/.test(core)) return `${spellLetters(core.slice(0, -1))}s`;
  const abbr = own(ABBREV_WORDS, core.toLowerCase());
  if (abbr !== undefined) return abbr;
  if ((m = core.match(/^([$£€])(\d[\d,]*(?:\.\d+)?)([kKmMbBtT])?$/))) return currencyToWords(m[1], m[2], m[3]);
  if ((m = core.match(/^(-?\d[\d,]*(?:\.\d+)?)%$/))) return `${numberToWords(m[1])} percent`;
  if ((m = core.match(/^(\d+)(st|nd|rd|th)$/i))) return ordinalToWords(Number(m[1]));
  if ((m = core.match(/^(\d{1,2}):(\d{2})$/)) && Number(m[1]) < 25 && Number(m[2]) < 60) return timeToWords(Number(m[1]), Number(m[2]));
  if (/^\d{4}$/.test(core) && Number(core) >= 1100 && Number(core) <= 2099) return yearToWords(Number(core));
  if (/^-?\d[\d,]*(?:\.\d+)?$/.test(core) && !/^-?0\d/.test(core)) return numberToWords(core);
  if ((m = core.match(/^(v?)(\d+(?:\.\d+){2,})$/))) return (m[1] ? "version " : "") + m[2].split(".").map((g) => numberToWords(g)).join(" dot ");
  if (/^[^A-Za-z\d]+$/.test(core)) return core;

  // Code-ish chunks: paths, files, flags, identifiers.
  let t = core;
  t = t.replace(/^~(?=[\\/])/, "tilde ").replace(/^\.\.?(?=[\\/])/, (d) => (d === ".." ? "dot dot " : "dot "));
  t = t.replace(/^--?(?=[A-Za-z])/, (d) => (d === "--" ? "dash dash " : "dash "));
  t = t.replace(/[\\/]+/g, " slash ");
  t = t.replace(/^\.(?=[A-Za-z])/, "dot ");
  t = t.replace(/::/g, " ").replace(/=>|->/g, " to ");
  // a.b.c: the last segment of a name with a known extension is read as one; others get "dot".
  t = t.replace(/([A-Za-z\d])\.([A-Za-z][A-Za-z\d]*)(?=$|[\s.])/g, (_s, a: string, ext: string) => {
    const lower = ext.toLowerCase();
    const word = own(EXT_WORDS, lower);
    if (word) return `${a} dot ${word}`;
    return `${a} dot ${spellExt(ext)}`;
  });
  t = t.replace(/([A-Za-z\d])\.(?=[A-Za-z\d])/g, "$1 dot ");
  t = t.replace(/[=:]+(?=\S)/g, " ").replace(/[(){}\[\]<>,;"'`]/g, (c) => (c === "'" ? "'" : " "));
  t = splitIdentifier(t);
  return readPieces(t);
}

/**
 * Speech-ready text: numbers, currency, percentages, ordinals, years and times become words; symbols are
 * named; code identifiers are split (`useVoiceStore` -> "use Voice Store"), extensions are read (`.tsx` ->
 * "dot tee ess ex"), paths read naturally and short ALL-CAPS words are spelled. Sentence punctuation stays.
 */
export function normalizeText(input: string): string {
  const text = input.replace(/[’‘]/g, "'").replace(/ /g, " ").replace(/https?:\/\//g, "");
  const chunks = text.split(/(\s+)/);
  const out = chunks.map((chunk) => {
    if (!chunk || /^\s+$/.test(chunk)) return chunk;
    const lead = chunk.match(/^[("'“\[{]+/)?.[0] ?? "";
    let rest = chunk.slice(lead.length);
    const trail = rest.match(/[)"'”\]}.,;:!?…]+$/)?.[0] ?? "";
    // keep a trailing dot that is part of an abbreviation-free token, but never strip the whole token
    rest = rest.slice(0, rest.length - trail.length);
    if (!rest) return chunk;
    // "1,200." keeps the full stop; a comma inside a number is part of the number, not trailing.
    const dropDot = /^(e\.g|i\.e|mr|mrs|ms|dr|vs)$/i.test(rest) && trail.startsWith(".");
    return lead.replace(/["“(\[{]/g, "") + normCore(rest) + (dropDot ? trail.slice(1) : trail).replace(/["”)\]}]/g, "").replace(/'+$/, "");
  });
  return out.join("").replace(/[ \t]+/g, " ").trim();
}

const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|approx|St|No)\.$/;

/** Cuts text into sentences for streaming synthesis; overlong sentences break at commas, then spaces. */
export function splitSentences(text: string, maxLen = 220): string[] {
  const raw = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…])\s+(?=[^\s])/);
  const merged: string[] = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (ABBREVIATIONS.test(prev) || prev.length < 14)) merged[merged.length - 1] = `${prev} ${s}`;
    else merged.push(s);
  }
  const out: string[] = [];
  for (const s of merged) {
    if (s.length <= maxLen) {
      if (s) out.push(s);
      continue;
    }
    let cur = "";
    for (const part of s.split(/(?<=[,;:—])\s+/)) {
      if ((cur + " " + part).trim().length > maxLen && cur) {
        out.push(cur);
        cur = "";
      }
      if (part.length > maxLen) {
        // no punctuation to lean on: break on spaces
        for (const w of part.split(" ")) {
          if ((cur + " " + w).trim().length > maxLen && cur) {
            out.push(cur);
            cur = "";
          }
          cur = (cur + " " + w).trim();
        }
      } else cur = (cur + " " + part).trim();
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Shortens the wait for the first audio: a long opening sentence is cut at its first comma, semicolon, colon or
 * dash (between `min` and `max` characters in), so playback can start after a short clause has been synthesised.
 */
export function splitFirstClause(sentences: string[], min = 24, max = 90): string[] {
  const [first, ...rest] = sentences;
  if (!first || first.length <= max) return sentences;
  const re = /[,;:—] /g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(first))) {
    const cut = m.index + 1;
    if (cut >= min && cut <= max) return [first.slice(0, cut), first.slice(cut).trim(), ...rest];
  }
  return sentences;
}
