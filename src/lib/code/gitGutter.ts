import { RangeSet, StateEffect, StateField, Text } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, ViewPlugin } from "@codemirror/view";
import { Chunk } from "@codemirror/merge";

type Kind = "added" | "modified" | "deleted";
export function gitLineChanges(baseline: string | null, doc: Text) {
  const lines = new Map<number, { kind: Kind; deletedBelow: boolean }>();
  if (baseline === null) {
    for (let n = 1; n <= doc.lines; n++) lines.set(doc.line(n).from, { kind: "added", deletedBelow: false });
    return lines;
  }
  const base = Text.of(baseline.split("\n"));
  for (const chunk of Chunk.build(base, doc, { scanLimit: 1000, timeout: 40 })) {
    if (chunk.fromB === chunk.toB) {
      const pos = doc.lineAt(Math.max(0, Math.min(doc.length, chunk.fromB - 1))).from;
      lines.set(pos, { kind: "deleted", deletedBelow: true });
      continue;
    }
    const oldCount =
      chunk.fromA === chunk.toA
        ? 0
        : base.lineAt(Math.min(base.length, chunk.toA - 1)).number - base.lineAt(chunk.fromA).number + 1;
    let index = 0,
      last = 0;
    for (let pos = chunk.fromB; pos < chunk.toB && pos <= doc.length; ) {
      const line = doc.lineAt(pos);
      lines.set(line.from, { kind: index < oldCount ? "modified" : "added", deletedBelow: false });
      index++;
      last = line.from;
      pos = line.to + 1;
    }
    if (oldCount > index) lines.get(last)!.deletedBelow = true;
  }
  return lines;
}
class GitMarker extends GutterMarker {
  constructor(
    readonly kind: Kind,
    readonly deletedBelow = false,
  ) {
    super();
  }
  eq(other: GitMarker) {
    return this.kind === other.kind && this.deletedBelow === other.deletedBelow;
  }
  toDOM() {
    const node = document.createElement("div");
    node.className = `cm-git-${this.kind}`;
    node.title = this.kind === "deleted" ? "Deleted below" : this.kind === "added" ? "Added line" : "Modified line";
    if (this.deletedBelow && this.kind !== "deleted") {
      const deletion = document.createElement("span");
      deletion.className = "cm-git-deleted";
      node.appendChild(deletion);
      node.title += "; deleted below";
    }
    return node;
  }
}
const update = StateEffect.define<RangeSet<GutterMarker>>();
const markers = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update: (value, tr) => {
    value = value.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(update)) value = effect.value;
    return value;
  },
});
// Reconfigure this extension after fetching the baseline on open, reload, or save.
export function gitGutter(baseline: string | null) {
  return [
    markers,
    gutter({
      class: "cm-git-gutter",
      markers: (view) => view.state.field(markers),
      initialSpacer: () => new GitMarker("added"),
    }),
    ViewPlugin.fromClass(
      class {
        timer: ReturnType<typeof setTimeout>;
        constructor(readonly view: EditorView) {
          this.timer = setTimeout(() => this.compute(), 0);
        }
        update(u: { docChanged: boolean }) {
          if (u.docChanged) {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.compute(), 200);
          }
        }
        compute() {
          const lines = gitLineChanges(baseline, this.view.state.doc);
          const ranges = [...lines]
            .sort(([a], [b]) => a - b)
            .map(([pos, marker]) => new GitMarker(marker.kind, marker.deletedBelow).range(pos));
          this.view.dispatch({ effects: update.of(RangeSet.of(ranges)) });
        }
        destroy() {
          clearTimeout(this.timer);
        }
      },
    ),
    EditorView.baseTheme({
      ".cm-git-gutter": { width: "5px" },
      ".cm-git-gutter .cm-gutterElement": { padding: "0 1px" },
      ".cm-git-added": { width: "3px", height: "100%", background: "var(--ok)" },
      ".cm-git-modified": { width: "3px", height: "100%", background: "var(--warn)" },
      ".cm-git-deleted": {
        display: "block",
        width: "0",
        height: "0",
        position: "relative",
        top: "100%",
        borderLeft: "4px solid var(--bad)",
        borderTop: "3px solid transparent",
        borderBottom: "3px solid transparent",
      },
    }),
  ];
}
