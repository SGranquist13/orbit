import { Facet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet } from "@codemirror/view";
import type { ReviewComment } from "../../stores/review";

/** Callbacks the host (DiffView) supplies; the extension itself knows nothing about stores. */
export interface ReviewHandlers {
  add: (startLine: number, endLine: number, text: string) => void;
  update: (id: string, text: string) => void;
  remove: (id: string) => void;
}
const handlers = Facet.define<ReviewHandlers, ReviewHandlers>({ combine: (v) => v[0] });

interface Composer {
  startLine: number;
  endLine: number;
  /** Set when editing an existing comment. */
  id?: string;
  text: string;
}
export const setReviewComments = StateEffect.define<ReviewComment[]>();
/** Open a comment box under a line range (or edit an existing comment); null closes it. */
export const openComposer = StateEffect.define<Composer | null>();

let live: EditorView | null = null;

class CardWidget extends WidgetType {
  constructor(
    readonly c: ReviewComment,
    readonly h: ReviewHandlers,
  ) {
    super();
  }
  eq(o: CardWidget) {
    return o.c.id === this.c.id && o.c.text === this.c.text && o.c.startLine === this.c.startLine && o.c.endLine === this.c.endLine;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-review-card";
    el.dataset.reviewComment = this.c.id;
    const head = document.createElement("div");
    head.className = "cm-review-head";
    const label = document.createElement("span");
    label.textContent = this.c.startLine === this.c.endLine ? `Line ${this.c.startLine}` : `Lines ${this.c.startLine}–${this.c.endLine}`;
    const actions = document.createElement("span");
    actions.className = "cm-review-actions";
    const mk = (name: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name;
      b.setAttribute("aria-label", `${name} comment`);
      b.onclick = fn;
      return b;
    };
    actions.append(
      mk("Edit", () => view.dispatch({ effects: openComposer.of({ startLine: this.c.startLine, endLine: this.c.endLine, id: this.c.id, text: this.c.text }) })),
      mk("Delete", () => this.h.remove(this.c.id)),
    );
    head.append(label, actions);
    const body = document.createElement("div");
    body.className = "cm-review-text";
    body.textContent = this.c.text;
    el.append(head, body);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class ComposerWidget extends WidgetType {
  constructor(
    readonly s: Composer,
    readonly h: ReviewHandlers,
  ) {
    super();
  }
  eq(o: ComposerWidget) {
    return o.s.id === this.s.id && o.s.startLine === this.s.startLine && o.s.endLine === this.s.endLine;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-review-card cm-review-composer";
    el.dataset.reviewComposer = "";
    const label = document.createElement("div");
    label.className = "cm-review-head";
    label.textContent = this.s.startLine === this.s.endLine ? `Comment on line ${this.s.startLine}` : `Comment on lines ${this.s.startLine}–${this.s.endLine}`;
    const area = document.createElement("textarea");
    area.rows = 2;
    area.value = this.s.text;
    area.placeholder = "Comment for the agent…";
    area.setAttribute("aria-label", "Review comment");
    const close = () => {
      view.dispatch({ effects: openComposer.of(null) });
      view.focus();
    };
    const submit = () => {
      const text = area.value.trim();
      if (!text) return;
      if (this.s.id) this.h.update(this.s.id, text);
      else this.h.add(this.s.startLine, this.s.endLine, text);
      close();
    };
    area.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    };
    const row = document.createElement("div");
    row.className = "cm-review-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.onclick = close;
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = this.s.id ? "Save" : "Add comment";
    save.onclick = submit;
    row.append(cancel, save);
    el.append(label, area, row);
    queueMicrotask(() => area.focus());
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

interface FieldValue {
  comments: ReviewComment[];
  composer: Composer | null;
  set: DecorationSet;
}

function build(state: EditorState, comments: ReviewComment[], composer: Composer | null): DecorationSet {
  const h = state.facet(handlers);
  const items: { pos: number; order: number; deco: Decoration }[] = [];
  const at = (line: number) => state.doc.line(Math.min(Math.max(1, line), state.doc.lines)).to;
  for (const c of comments) {
    if (composer?.id === c.id) continue;
    items.push({ pos: at(c.endLine), order: c.startLine, deco: Decoration.widget({ widget: new CardWidget(c, h), block: true, side: 1 }) });
  }
  if (composer) items.push({ pos: at(composer.endLine), order: 1e9, deco: Decoration.widget({ widget: new ComposerWidget(composer, h), block: true, side: 2 }) });
  items.sort((a, b) => a.pos - b.pos || a.order - b.order);
  const b = new RangeSetBuilder<Decoration>();
  for (const i of items) b.add(i.pos, i.pos, i.deco);
  return b.finish();
}

class Plus extends GutterMarker {
  constructor(readonly line?: number) {
    super();
  }
  eq(other: Plus) {
    return this.line === other.line;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-review-plus";
    if (this.line !== undefined) s.dataset.reviewLine = String(this.line);
    s.textContent = "+";
    s.title = "Comment on this line (Shift-click for a range)";
    return s;
  }
}

/** Commentable-line gutter, inline comment cards and the comment box, for the new side of a diff. */
export function reviewExtension(h: ReviewHandlers): Extension {
  const plus = new Plus();
  let anchor = 0;
  const field = StateField.define<FieldValue>({
    create: () => ({ comments: [], composer: null, set: Decoration.none }),
    update(v, tr) {
      let { comments, composer } = v;
      let changed = false;
      for (const e of tr.effects) {
        if (e.is(setReviewComments)) (comments = e.value), (changed = true);
        if (e.is(openComposer)) (composer = e.value), (changed = true);
      }
      if (!changed && !tr.docChanged) return v;
      return { comments, composer, set: build(tr.state, comments, composer) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.set),
  });
  const gutterExt = gutter({
    class: "cm-review-gutter",
    // The spacer has no line; real markers carry CodeMirror's 1-based document line.
    lineMarker: (view, line) => new Plus(view.state.doc.lineAt(line.from).number),
    initialSpacer: () => plus,
    domEventHandlers: {
      mousedown(v, block, e) {
        e.preventDefault();
        // block.from is a document offset, not a zero-based line index.
        const line = v.state.doc.lineAt(block.from).number;
        let start = line,
          end = line;
        const sel = v.state.selection.main;
        if ((e as MouseEvent).shiftKey && anchor) {
          start = Math.min(anchor, line);
          end = Math.max(anchor, line);
        } else if (!sel.empty) {
          const a = v.state.doc.lineAt(sel.from).number,
            b = v.state.doc.lineAt(sel.to).number;
          if (line >= a && line <= b) (start = a), (end = b);
        }
        anchor = line;
        v.dispatch({ effects: openComposer.of({ startLine: start, endLine: end, text: "" }) });
        return true;
      },
    },
  });
  const track = ViewPlugin.define((v) => {
    live = v;
    return {
      destroy() {
        if (live === v) live = null;
      },
    };
  });
  return [handlers.of(h), field, gutterExt, track, reviewTheme];
}

export const reviewView = () => live;

/** Open the comment box for the cursor's line (or the selected lines). */
export function commentAtCursor(view: EditorView) {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from).number;
  const endLine = Math.max(startLine, view.state.doc.lineAt(sel.to > sel.from ? sel.to - 1 : sel.to).number);
  view.dispatch({ effects: openComposer.of({ startLine, endLine, text: "" }) });
}

const reviewTheme = EditorView.theme({
  ".cm-review-gutter": { width: "16px" },
  ".cm-review-gutter .cm-gutterElement": { cursor: "pointer", textAlign: "center" },
  ".cm-review-plus": { opacity: "0", color: "var(--color-fg)", fontFamily: "Inter, sans-serif", fontWeight: "600" },
  ".cm-review-gutter .cm-gutterElement:hover .cm-review-plus": { opacity: "1" },
  ".cm-review-card": {
    margin: "4px 12px 4px 16px",
    padding: "6px 8px",
    border: "1.5px solid var(--color-line-strong)",
    borderRadius: "4px",
    background: "var(--color-raised)",
    color: "var(--color-fg)",
    fontFamily: "Inter, sans-serif",
    fontSize: "12.5px",
    whiteSpace: "normal",
  },
  ".cm-review-head": { display: "flex", justifyContent: "space-between", gap: "8px", color: "var(--color-mute)", fontSize: "11px", marginBottom: "3px" },
  ".cm-review-text": { whiteSpace: "pre-wrap" },
  ".cm-review-actions": { display: "flex", gap: "6px", justifyContent: "flex-end" },
  ".cm-review-actions button": {
    border: "1px solid var(--color-line)",
    borderRadius: "3px",
    padding: "1px 8px",
    color: "var(--color-fg)",
    background: "transparent",
    fontSize: "11px",
    cursor: "pointer",
  },
  ".cm-review-actions button:hover": { background: "var(--color-hover)" },
  ".cm-review-card textarea": {
    width: "100%",
    resize: "vertical",
    border: "1px solid var(--color-line)",
    borderRadius: "3px",
    background: "var(--color-bg)",
    color: "var(--color-fg)",
    padding: "4px 6px",
    fontFamily: "Inter, sans-serif",
    fontSize: "12.5px",
    outline: "none",
    marginBottom: "4px",
  },
});
