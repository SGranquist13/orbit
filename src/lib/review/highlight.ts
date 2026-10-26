// Syntax highlighting outside an editor: the Code view's Lezer parsers, `tok-*` classes (styled in index.css).
import { Language, LanguageSupport } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { loadLanguage } from "../code/languages";

export interface Token {
  text: string;
  cls: string;
}

function languageOf(ext: Extension): Language | null {
  if (ext instanceof LanguageSupport) return ext.language;
  if (ext instanceof Language) return ext;
  return null;
}

const MAX = 400_000;

/** Tokens per line (lines split on \n, matching splitLines). Plain text when the language is unknown or the file is huge. */
export async function highlightLines(text: string, path: string): Promise<Token[][]> {
  const src = text.replace(/\r\n/g, "\n");
  const lang = src.length > MAX ? null : languageOf(await loadLanguage(path));
  const spans: { from: number; to: number; cls: string }[] = [];
  if (lang) highlightTree(lang.parser.parse(src), classHighlighter, (from, to, cls) => spans.push({ from, to, cls }));
  const lines: Token[][] = [[]];
  const push = (from: number, to: number, cls: string) => {
    let start = from;
    for (let k = from; k <= to; k++) {
      if (k === to || src.charCodeAt(k) === 10) {
        if (k > start) lines[lines.length - 1].push({ text: src.slice(start, k), cls });
        if (k < to) lines.push([]);
        start = k + 1;
      }
    }
  };
  let pos = 0;
  for (const s of spans) {
    if (s.from > pos) push(pos, s.from, "");
    push(s.from, s.to, s.cls);
    pos = s.to;
  }
  push(pos, src.length, "");
  if (src.endsWith("\n")) lines.pop();
  return lines;
}
