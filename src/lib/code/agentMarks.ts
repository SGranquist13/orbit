import { RangeSet, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from "@codemirror/view";
import { Chunk } from "@codemirror/merge";

export interface LineRange {
  from: number;
  to: number;
}
export function agentChanges(before: string, after: string) {
  const a = Text.of(before.split("\n")),
    b = Text.of(after.split("\n"));
  let additions = 0,
    deletions = 0;
  const ranges: LineRange[] = [];
  for (const c of Chunk.build(a, b, { scanLimit: 1000, timeout: 40 })) {
    const count = (doc: Text, from: number, to: number) =>
      from === to ? 0 : doc.lineAt(Math.min(doc.length, to - 1)).number - doc.lineAt(Math.min(doc.length, from)).number + 1;
    additions += count(b, c.fromB, c.toB);
    deletions += count(a, c.fromA, c.toA);
    const from = b.lineAt(Math.min(b.length, c.fromB)).number;
    const to = c.fromB === c.toB ? from : b.lineAt(Math.min(b.length, c.toB - 1)).number;
    ranges.push({ from, to });
  }
  return { ranges, additions, deletions };
}
export const setAgentMarks = StateEffect.define<{ ranges: LineRange[]; flash: boolean }>();
export const clearAgentMarks = StateEffect.define<null>();
export const clearAgentFlash = StateEffect.define<null>();
class AgentMark extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-agent-mark";
    el.title = "Changed by the agent this turn";
    return el;
  }
}
const marker = new AgentMark();
export const agentMarkState = StateField.define<{ marks: RangeSet<GutterMarker>; flash: DecorationSet }>({
  create: () => ({ marks: RangeSet.empty, flash: Decoration.none }),
  update(value, tr) {
    let marks = value.marks.map(tr.changes),
      flash = value.flash.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearAgentMarks)) {
        marks = RangeSet.empty;
        flash = Decoration.none;
      }
      if (e.is(clearAgentFlash)) flash = Decoration.none;
      if (e.is(setAgentMarks)) {
        const positions = new Set<number>();
        marks.between(0, tr.state.doc.length, (from) => {
          positions.add(tr.state.doc.lineAt(from).from);
        });
        const flashing = new Set<number>();
        for (const range of e.value.ranges)
          for (let n = Math.max(1, range.from); n <= Math.min(tr.state.doc.lines, range.to); n++) {
            const pos = tr.state.doc.line(n).from;
            positions.add(pos);
            flashing.add(pos);
          }
        marks = RangeSet.of([...positions].sort((a, b) => a - b).map((pos) => marker.range(pos)));
        flash = e.value.flash
          ? Decoration.set(
              [...flashing].sort((a, b) => a - b).map((pos) => Decoration.line({ class: "cm-agent-flash" }).range(pos)),
            )
          : Decoration.none;
      }
    }
    return { marks, flash };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.flash),
});
export const agentMarks = [
  agentMarkState,
  gutter({ class: "cm-agent-gutter", markers: (view) => view.state.field(agentMarkState).marks, initialSpacer: () => marker }),
];
