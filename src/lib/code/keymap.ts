import { Prec, EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding, type Command } from "@codemirror/view";
import * as editing from "@codemirror/commands";
import * as searching from "@codemirror/search";
import * as folding from "@codemirror/language";
import { startCompletion, autocompletion, completeAnyWord, completionKeymap } from "@codemirror/autocomplete";
import { bindings, commands, type Overrides } from "../keybindings";
import { useApp } from "../../stores/app";
import { useCode } from "../../stores/code";
import { editorSelection } from "../../components/code/AskSelection";

let lastEditor: EditorView | undefined;
const insertLineAbove: Command = (view) => {
  if (view.state.readOnly) return false;
  view.dispatch(
    view.state.changeByRange((range) => {
      const from = view.state.doc.lineAt(range.head).from;
      return { changes: { from, insert: "\n" }, range: EditorSelection.cursor(from) };
    }),
    { scrollIntoView: true, userEvent: "input" },
  );
  return true;
};
const actions: Record<string, Command> = {
  toggleComment: editing.toggleComment,
  toggleBlockComment: editing.toggleBlockComment,
  moveLineUp: editing.moveLineUp,
  moveLineDown: editing.moveLineDown,
  copyLineUp: editing.copyLineUp,
  copyLineDown: editing.copyLineDown,
  deleteLine: editing.deleteLine,
  insertBlankLine: editing.insertBlankLine,
  insertLineAbove,
  selectLine: editing.selectLine,
  selectNextOccurrence: searching.selectNextOccurrence,
  selectSelectionMatches: searching.selectSelectionMatches,
  addCursorAbove: editing.addCursorAbove,
  addCursorBelow: editing.addCursorBelow,
  undoSelection: editing.undoSelection,
  indentMore: editing.indentMore,
  indentLess: editing.indentLess,
  cursorMatchingBracket: editing.cursorMatchingBracket,
  foldCode: folding.foldCode,
  unfoldCode: folding.unfoldCode,
  foldAll: folding.foldAll,
  unfoldAll: folding.unfoldAll,
  startCompletion,
  find: searching.openSearchPanel,
  gotoLine: searching.gotoLine,
  findNext: searching.findNext,
  findPrevious: searching.findPrevious,
  replace: (view) => {
    searching.openSearchPanel(view);
    view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus();
    return true;
  },
  wordWrap: () => {
    void useApp.getState().updateSettings({ editorWordWrap: !useApp.getState().settings?.editorWordWrap });
    return true;
  },
};

export function runEditorCommand(id: string, view?: EditorView): boolean {
  const focused = document.activeElement instanceof HTMLElement ? EditorView.findFromDOM(document.activeElement) : null;
  view ??= focused ?? lastEditor;
  if (!view || !view.dom.isConnected || useApp.getState().view !== "code") return false;
  if (id === "agent.askSelection") {
    const s = useCode.getState(),
      root = s.activeRoot,
      rel = s.roots.find((r) => r.path === root)?.activeRel;
    if (!root || !rel) return false;
    const selection = editorSelection(view, root, rel);
    window.dispatchEvent(new CustomEvent("orbit-code-editor", { detail: { selection } }));
    return true;
  }
  view.focus();
  return actions[id.slice(7)]?.(view) ?? false;
}

const keyNames: Record<string, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  space: "Space",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  tab: "Tab",
  escape: "Escape",
  home: "Home",
  end: "End",
  backspace: "Backspace",
  delete: "Delete",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  enter: "Enter",
  pagedown: "PageDown",
  pageup: "PageUp",
};
const cmKey = (key: string) =>
  key
    .split("+")
    .map((k) => keyNames[k] ?? (/^f\d+$/.test(k) ? k.toUpperCase() : k))
    .join("-");

/** Keep navigation, deletion, select-all and history; registry owns modified editing shortcuts. */
export function plainBindings(list: readonly KeyBinding[]): KeyBinding[] {
  return list
    .filter((b) => {
      const k = b.key ?? "";
      if (!b.key) return false;
      if (k === "F3" || k === "Shift-F3") return false;
      return (
        !/(Mod|Ctrl|Alt|Meta)-/.test(k) ||
        /^(Mod|Ctrl)-(Shift-)?[zya]$/i.test(k) ||
        /^(Mod|Ctrl)-(Shift-)?(Arrow(Left|Right|Up|Down)|Home|End|Backspace|Delete)$/.test(k)
      );
    })
    .map((b) => ({ ...b, mac: undefined, win: undefined, linux: undefined }));
}

export function editorKeymap(overrides: Overrides = {}) {
  const keys = commands
    .filter((c) => c.when === "editor")
    .flatMap((c) =>
      bindings(c.id, overrides)
        .filter((b) => !b.includes(" "))
        .map((b) => ({
          key: cmKey(b),
          run: (view: EditorView) => runEditorCommand(c.id, view),
        })),
    );
  return [
    EditorState.allowMultipleSelections.of(true),
    autocompletion({ defaultKeymap: false, override: [completeAnyWord] }),
    Prec.highest(keymap.of(plainBindings(completionKeymap))),
    Prec.high(keymap.of(keys)),
    EditorView.domEventHandlers({
      focus: (_e, view) => {
        lastEditor = view;
        return false;
      },
    }),
  ];
}
