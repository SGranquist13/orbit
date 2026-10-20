/** The sole shortcut catalog. This module deliberately has no React or store imports. */
export type When = "global" | "code" | "editor" | "notEditor" | "terminal";
export type Overrides = Record<string, string[]>;
export interface Command {
  id: string;
  title: string;
  group: "General" | "Views" | "Code" | "Editor" | "Terminal" | "Agent";
  when: When;
  defaults: string[];
}
const command = (id: string, title: string, group: Command["group"], when: When, ...defaults: string[]): Command => ({
  id,
  title,
  group,
  when,
  defaults,
});
export const commands: Command[] = [
  command("workbench.commandPalette", "Command palette", "General", "global", "ctrl+shift+p", "f1"),
  command("code.quickOpen", "Quick open file", "Code", "global", "ctrl+p"),
  command("code.focusExplorer", "Code view + focus explorer", "Code", "global", "ctrl+shift+e"),
  command("workbench.openInEditor", "Open in external editor", "General", "global"),
  command("workbench.toggleSidebar", "Toggle sidebar", "General", "global", "ctrl+b"),
  command("code.toggleActivity", "Toggle Activity column", "Code", "global", "ctrl+alt+b"),
  command("workbench.toggleShip", "Toggle Ship panel", "General", "global", "ctrl+shift+g"),
  ...["inbox", "code", "routines", "teammates", "issues"].map((v, i) =>
    command(`views.${v}`, `Open ${v}`, "Views", "global", `alt+${i + 1}`),
  ),
  command("workbench.newWorkspace", "New workspace", "General", "notEditor", "ctrl+n"),
  ...Array.from({ length: 9 }, (_, i) =>
    command(`workbench.workspace${i + 1}`, `Jump to workspace ${i + 1}`, "General", "notEditor", `ctrl+${i + 1}`),
  ),
  command("workbench.settings", "Settings", "General", "global", "ctrl+,"),
  command("workbench.keyboardShortcuts", "Keyboard shortcuts", "General", "global", "ctrl+k ctrl+s"),
  command("workbench.theme", "Switch theme", "General", "global", "ctrl+k ctrl+t"),
  command("workbench.focusMode", "Focus mode", "General", "global", "ctrl+k z"),
  command("agent.openChat", "Open workspace chat", "Agent", "global", "ctrl+alt+i"),
  command("agent.askSelection", "Ask about selection", "Agent", "editor", "ctrl+i"),
  command("code.newFile", "New file", "Code", "code", "ctrl+n"),
  command("code.openFolder", "Open folder in Code", "Code", "code", "ctrl+k ctrl+o"),
  command("code.save", "Save file", "Code", "code", "ctrl+s"),
  command("code.saveAll", "Save all files", "Code", "code", "ctrl+k s"),
  command("code.closeTab", "Close file tab", "Code", "code", "ctrl+w", "ctrl+f4"),
  command("code.closeAll", "Close all tabs", "Code", "code", "ctrl+k ctrl+w"),
  command("code.reopenTab", "Reopen closed tab", "Code", "code", "ctrl+shift+t"),
  command("code.nextTab", "Next tab", "Code", "code", "ctrl+tab", "ctrl+pagedown"),
  command("code.previousTab", "Previous tab", "Code", "code", "ctrl+shift+tab", "ctrl+pageup"),
  command("code.toggleTerminal", "Toggle terminal", "Code", "code", "ctrl+`"),
  command("code.newTerminal", "New terminal", "Code", "code", "ctrl+shift+`"),
  command("code.togglePanel", "Toggle panel", "Code", "code", "ctrl+j"),
  command("code.search", "Search in files", "Code", "code", "ctrl+shift+f"),
  command("code.toggleMode", "Toggle Watch / Manual", "Agent", "code"),
  command("code.toggleDiff", "Toggle diff", "Code", "code"),
  command("terminal.copy", "Copy terminal selection", "Terminal", "terminal", "ctrl+shift+c"),
  command("terminal.paste", "Paste into terminal", "Terminal", "terminal", "ctrl+shift+v"),
  command("editor.find", "Find in file", "Editor", "editor", "ctrl+f"),
  command("editor.replace", "Replace in file", "Editor", "editor", "ctrl+h"),
  command("editor.gotoLine", "Go to line", "Editor", "editor", "ctrl+g"),
  command("editor.findNext", "Next match", "Editor", "editor", "f3"),
  command("editor.findPrevious", "Previous match", "Editor", "editor", "shift+f3"),
  command("editor.toggleComment", "Toggle comment", "Editor", "editor", "ctrl+/"),
  command("editor.toggleBlockComment", "Block comment", "Editor", "editor", "shift+alt+a"),
  command("editor.moveLineUp", "Move line up", "Editor", "editor", "alt+arrowup"),
  command("editor.moveLineDown", "Move line down", "Editor", "editor", "alt+arrowdown"),
  command("editor.copyLineUp", "Copy line up", "Editor", "editor", "shift+alt+arrowup"),
  command("editor.copyLineDown", "Copy line down", "Editor", "editor", "shift+alt+arrowdown"),
  command("editor.deleteLine", "Delete line", "Editor", "editor", "ctrl+shift+k"),
  command("editor.insertBlankLine", "Insert line below", "Editor", "editor", "ctrl+enter"),
  command("editor.insertLineAbove", "Insert line above", "Editor", "editor", "ctrl+shift+enter"),
  command("editor.selectLine", "Select line", "Editor", "editor", "ctrl+l"),
  command("editor.selectNextOccurrence", "Next occurrence", "Editor", "editor", "ctrl+d"),
  command("editor.selectSelectionMatches", "All occurrences", "Editor", "editor", "ctrl+shift+l"),
  command("editor.addCursorAbove", "Add cursor above", "Editor", "editor", "ctrl+alt+arrowup"),
  command("editor.addCursorBelow", "Add cursor below", "Editor", "editor", "ctrl+alt+arrowdown"),
  command("editor.undoSelection", "Undo cursor", "Editor", "editor", "ctrl+u"),
  command("editor.indentMore", "Indent", "Editor", "editor", "ctrl+]"),
  command("editor.indentLess", "Outdent", "Editor", "editor", "ctrl+["),
  command("editor.cursorMatchingBracket", "Jump to bracket", "Editor", "editor", "ctrl+shift+\\"),
  command("editor.foldCode", "Fold", "Editor", "editor", "ctrl+shift+["),
  command("editor.unfoldCode", "Unfold", "Editor", "editor", "ctrl+shift+]"),
  command("editor.foldAll", "Fold all", "Editor", "editor", "ctrl+k ctrl+0"),
  command("editor.unfoldAll", "Unfold all", "Editor", "editor", "ctrl+k ctrl+j"),
  command("editor.wordWrap", "Toggle word wrap", "Editor", "editor", "alt+z"),
  command("editor.startCompletion", "Trigger suggest", "Editor", "editor", "ctrl+space"),
];
export function bindings(id: string, overrides: Overrides = {}): string[] {
  return overrides[id] ?? commands.find((c) => c.id === id)?.defaults ?? [];
}
export interface Context {
  code: boolean;
  editor: boolean;
  terminal: boolean;
}
export function active(when: When, c: Context): boolean {
  return when === "global" || (when === "notEditor" ? !c.code && !c.editor : c[when]);
}
const rank: Record<When, number> = { global: 0, notEditor: 1, code: 2, terminal: 3, editor: 4 };
export function candidates(key: string, context: Context, overrides: Overrides = {}, prefix = false): Command[] {
  return commands
    .filter(
      (c) => active(c.when, context) && bindings(c.id, overrides).some((b) => (prefix ? b.startsWith(key + " ") : b === key)),
    )
    .sort(
      (a, b) => rank[b.when] - rank[a.when] || Number(Object.hasOwn(overrides, b.id)) - Number(Object.hasOwn(overrides, a.id)),
    );
}
export function overlaps(a: When, b: When): boolean {
  for (const code of [false, true]) {
    for (const editor of [false, true]) {
      for (const terminal of [false, true]) {
        const context = { code, editor, terminal };
        if ((!editor || code) && (!terminal || code) && !(terminal && editor) && active(a, context) && active(b, context))
          return true;
      }
    }
  }
  return false;
}
export function conflicts(id: string, key: string, overrides: Overrides = {}): Command[] {
  const own = commands.find((c) => c.id === id);
  return commands.filter((c) => c.id !== id && own && overlaps(c.when, own.when) && bindings(c.id, overrides).includes(key));
}
const physical: Record<string, string> = {
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Equal: "=",
  Minus: "-",
  Semicolon: ";",
  Quote: "'",
  Space: "space",
};
export function normalizeEvent(
  e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
): string | null {
  if (["Control", "Meta", "Shift", "Alt", "AltGraph"].includes(e.key)) return null;
  const key = physical[e.code] ?? (/^Digit[0-9]$/.test(e.code) ? e.code.slice(5) : e.key.toLowerCase());
  return [e.ctrlKey || e.metaKey ? "ctrl" : "", e.shiftKey ? "shift" : "", e.altKey ? "alt" : "", key].filter(Boolean).join("+");
}
export function displayBinding(key: string): string {
  const names: Record<string, string> = {
    ctrl: "Ctrl",
    shift: "Shift",
    alt: "Alt",
    escape: "Esc",
    arrowup: "↑",
    arrowdown: "↓",
    space: "Space",
    pagedown: "PageDown",
    pageup: "PageUp",
  };
  return key
    .split(" ")
    .map((part) =>
      part
        .split("+")
        .map((k) => names[k] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)))
        .join(" "),
    )
    .join(", ");
}
type Handler = () => unknown;
const handlers = new Map<string, Handler[]>();
export function registerHandler(id: string, fn: Handler): () => void {
  const list = handlers.get(id) ?? [];
  list.push(fn);
  handlers.set(id, list);
  return () => {
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  };
}
export function executeCommand(id: string): boolean {
  for (const fn of [...(handlers.get(id) ?? [])].reverse()) if (fn() !== false) return true;
  return false;
}
/** A dispatcher owns its pending chord; no timers or DOM are needed for resolution tests. */
export function createDispatcher() {
  let pending = "";
  return {
    cancel() {
      pending = "";
    },
    get pending() {
      return pending;
    },
    press(key: string, context: Context, overrides: Overrides, run = executeCommand) {
      if (pending) {
        const first = pending;
        pending = "";
        if (key === "escape") return { handled: true, hint: "" };
        const match = candidates(first + " " + key, context, overrides).find((c) => run(c.id));
        const combination = `${displayBinding(first).replaceAll(" ", "+")}, ${displayBinding(key).replaceAll(" ", "+")}`;
        return { handled: true, hint: match ? "" : `The key combination (${combination}) is not a command.` };
      }
      if (candidates(key, context, overrides, true).length) {
        pending = key;
        const label = displayBinding(key).replaceAll(" ", "+");
        return { handled: true, hint: `(${label}) was pressed. Waiting for second key of chord…` };
      }
      return { handled: candidates(key, context, overrides).some((c) => run(c.id)), hint: "" };
    },
  };
}
export function isNonTerminalKey(e: KeyboardEvent, overrides: Overrides = {}): boolean {
  const key = normalizeEvent(e);
  if (!key) return false;
  const context = { code: true, editor: false, terminal: true };
  return [...candidates(key, context, overrides), ...candidates(key, context, overrides, true)].some(
    (c) => c.when !== "terminal",
  );
}
