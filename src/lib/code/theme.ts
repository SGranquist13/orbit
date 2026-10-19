import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const codeTheme = [EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: '"JetBrains Mono Variable", monospace', lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--hover)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--panel)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--mute)", borderRight: "1.5px solid var(--line)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px" },
  ".cm-panels, .cm-tooltip": { backgroundColor: "var(--raised)", color: "var(--fg)", fontFamily: '"Inter Variable", sans-serif', borderColor: "var(--line-strong)" },
  ".cm-panels": { borderWidth: "1.5px" },
  ".cm-search": { padding: "8px 12px", fontSize: "12px" },
  ".cm-textfield, .cm-button": { fontFamily: "inherit", fontSize: "12px", background: "var(--panel)", color: "var(--fg)", border: "1.5px solid var(--line-strong)", borderRadius: "3px" },
  ".cm-searchMatch": { backgroundColor: "var(--hover)", outline: "1px solid var(--warn)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--panel)", outline: "1px solid var(--info)" },
  "&.cm-focused": { outline: "none" },
}), syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: "var(--mute)", fontStyle: "italic" },
  { tag: tags.keyword, color: "var(--fg)", fontWeight: "500" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--info)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warn)" },
  { tag: [tags.variableName, tags.typeName, tags.propertyName], color: "var(--fg)" },
  { tag: [tags.punctuation, tags.operator], color: "var(--dim)" },
]))];
