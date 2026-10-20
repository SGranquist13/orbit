import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { TypingProjection } from "./liveTyping";

export const setTyping = StateEffect.define<(TypingProjection & { label: string }) | null>();
class Caret extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: Caret) {
    return other.label === this.label;
  }
  toDOM() {
    const caret = document.createElement("span");
    caret.className = "cm-agent-caret";
    caret.setAttribute("aria-label", `${this.label} writing`);
    const label = document.createElement("span");
    label.className = "cm-agent-caret-label";
    label.textContent = this.label;
    caret.append(label);
    return caret;
  }
  ignoreEvent() {
    return true;
  }
}
class Removed extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: Removed) {
    return other.text === this.text;
  }
  get lineBreaks() {
    return this.text.split("\n").length - 1;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-agent-removed";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}
export const typingDecorations = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setTyping)) {
        if (!e.value) {
          value = Decoration.none;
          continue;
        }
        const p = e.value,
          length = tr.state.doc.length;
        const caret = Math.max(0, Math.min(length, p.caret));
        const ranges = p.removed
          .filter((r) => r.text)
          .map((r) => Decoration.widget({ widget: new Removed(r.text), side: -1 }).range(Math.min(length, Math.max(0, r.at))));
        ranges.push(Decoration.widget({ widget: new Caret(p.label), side: 1 }).range(caret));
        ranges.push(Decoration.line({ class: "cm-agent-writing-line" }).range(tr.state.doc.lineAt(caret).from));
        value = Decoration.set(ranges, true);
      }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
