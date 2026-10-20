import { strict as assert } from "node:assert";
import {
  commands,
  bindings,
  normalizeEvent,
  candidates,
  conflicts,
  overlaps,
  createDispatcher,
  registerHandler,
  executeCommand,
  isNonTerminalKey,
} from "../src/lib/keybindings";
const event = (key: string, code = "", modifiers: Partial<KeyboardEvent> = {}) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});
assert.equal(normalizeEvent(event("P", "KeyP", { ctrlKey: true, shiftKey: true })), "ctrl+shift+p");
assert.equal(normalizeEvent(event("é", "KeyE", { ctrlKey: true })), "ctrl+é");
for (const [key, code, expected] of [
  ["~", "Backquote", "`"],
  ["{", "BracketLeft", "["],
  ["}", "BracketRight", "]"],
  ["|", "Backslash", "\\"],
  ["?", "Slash", "/"],
  ["!", "Digit1", "1"],
])
  assert.equal(normalizeEvent(event(key, code, { ctrlKey: true, shiftKey: true })), `ctrl+shift+${expected}`);
assert.equal(normalizeEvent(event("Control")), null);
assert.equal(normalizeEvent(event("+", "Equal", { ctrlKey: true, shiftKey: true })), "ctrl+shift+=");
assert(isNonTerminalKey(event("p", "KeyP", { ctrlKey: true }) as KeyboardEvent));
assert(!isNonTerminalKey(event("c", "KeyC", { ctrlKey: true, shiftKey: true }) as KeyboardEvent));
assert(!isNonTerminalKey(event("`", "Backquote", { ctrlKey: true }) as KeyboardEvent, { "code.toggleTerminal": [] }));
assert(
  isNonTerminalKey(event("t", "KeyT", { ctrlKey: true, altKey: true }) as KeyboardEvent, {
    "code.toggleTerminal": ["ctrl+alt+t"],
  }),
);
assert.equal(normalizeEvent(event(" ", "Space", { ctrlKey: true })), "ctrl+space");
const editor = { code: true, editor: true, terminal: false },
  code = { ...editor, editor: false },
  global = { ...code, code: false };
const overrides = { "editor.find": ["ctrl+b"], "code.save": ["ctrl+b"] };
assert.equal(candidates("ctrl+b", editor, overrides)[0].id, "editor.find");
assert.equal(candidates("ctrl+b", code, overrides)[0].id, "code.save");
assert.equal(candidates("ctrl+b", global, overrides)[0].id, "workbench.toggleSidebar");
assert.equal(candidates("ctrl+b", global, { "workbench.theme": ["ctrl+b"] })[0].id, "workbench.theme");
assert.deepEqual(bindings("editor.find", { "editor.find": [] }), []);
assert(!candidates("ctrl+f", editor, { "editor.find": [] }).length);
assert(conflicts("editor.find", "ctrl+b").some((c) => c.id === "workbench.toggleSidebar"));
assert(!overlaps("editor", "terminal"));
assert(!overlaps("notEditor", "code"));
assert(!overlaps("notEditor", "terminal"));
const d = createDispatcher(),
  fired: string[] = [];
const run = (id: string) => {
  fired.push(id);
  return true;
};
assert(d.press("ctrl+k", editor, {}, run).hint.includes("Waiting"));
assert(d.press("s", editor, {}, run).handled);
assert.equal(fired.pop(), "code.saveAll");
d.press("ctrl+k", editor, {}, run);
assert.equal(d.press("escape", editor, {}, run).hint, "");
assert.equal(d.pending, "");
d.press("ctrl+k", editor, {}, run);
assert(d.press("x", editor, {}, run).hint.includes("is not a command"));
assert.equal(d.pending, "");
d.press("ctrl+k", editor, {}, run);
d.press("ctrl+0", editor, {}, run);
assert.equal(fired.pop(), "editor.foldAll");
const off = registerHandler("code.save", () => false);
assert.equal(executeCommand("code.save"), false);
off();
// Independent transcription of every bound entry in PLANNING #13, including terminal copy/paste.
const expected: Record<string, string> = {
  "workbench.commandPalette": "ctrl+shift+p|f1",
  "code.quickOpen": "ctrl+p",
  "code.focusExplorer": "ctrl+shift+e",
  "workbench.toggleSidebar": "ctrl+b",
  "code.toggleActivity": "ctrl+alt+b",
  "workbench.toggleShip": "ctrl+shift+g",
  "workbench.newWorkspace": "ctrl+n",
  "workbench.settings": "ctrl+,",
  "workbench.keyboardShortcuts": "ctrl+k ctrl+s",
  "workbench.theme": "ctrl+k ctrl+t",
  "workbench.focusMode": "ctrl+k z",
  "workbench.openInEditor": "",
  "agent.openChat": "ctrl+alt+i",
  "agent.askSelection": "ctrl+i",
  "review.addComment": "",
  "review.send": "",
  "review.discard": "",
  "code.newFile": "ctrl+n",
  "code.openFolder": "ctrl+k ctrl+o",
  "code.save": "ctrl+s",
  "code.saveAll": "ctrl+k s",
  "code.closeTab": "ctrl+w|ctrl+f4",
  "code.closeAll": "ctrl+k ctrl+w",
  "code.reopenTab": "ctrl+shift+t",
  "code.nextTab": "ctrl+tab|ctrl+pagedown",
  "code.previousTab": "ctrl+shift+tab|ctrl+pageup",
  "code.toggleTerminal": "ctrl+`",
  "code.newTerminal": "ctrl+shift+`",
  "code.togglePanel": "ctrl+j",
  "code.search": "ctrl+shift+f",
  "code.toggleMode": "",
  "code.toggleDiff": "",
  "terminal.copy": "ctrl+shift+c",
  "terminal.paste": "ctrl+shift+v",
  "editor.find": "ctrl+f",
  "editor.replace": "ctrl+h",
  "editor.gotoLine": "ctrl+g",
  "editor.findNext": "f3",
  "editor.findPrevious": "shift+f3",
  "editor.toggleComment": "ctrl+/",
  "editor.toggleBlockComment": "shift+alt+a",
  "editor.moveLineUp": "alt+arrowup",
  "editor.moveLineDown": "alt+arrowdown",
  "editor.copyLineUp": "shift+alt+arrowup",
  "editor.copyLineDown": "shift+alt+arrowdown",
  "editor.deleteLine": "ctrl+shift+k",
  "editor.insertBlankLine": "ctrl+enter",
  "editor.insertLineAbove": "ctrl+shift+enter",
  "editor.selectLine": "ctrl+l",
  "editor.selectNextOccurrence": "ctrl+d",
  "editor.selectSelectionMatches": "ctrl+shift+l",
  "editor.addCursorAbove": "ctrl+alt+arrowup",
  "editor.addCursorBelow": "ctrl+alt+arrowdown",
  "editor.undoSelection": "ctrl+u",
  "editor.indentMore": "ctrl+]",
  "editor.indentLess": "ctrl+[",
  "editor.cursorMatchingBracket": "ctrl+shift+\\",
  "editor.foldCode": "ctrl+shift+[",
  "editor.unfoldCode": "ctrl+shift+]",
  "editor.foldAll": "ctrl+k ctrl+0",
  "editor.unfoldAll": "ctrl+k ctrl+j",
  "editor.wordWrap": "alt+z",
  "editor.startCompletion": "ctrl+space",
};
["inbox", "code", "routines", "teammates", "issues"].forEach((v, i) => (expected[`views.${v}`] = `alt+${i + 1}`));
for (let i = 1; i <= 9; i++) expected[`workbench.workspace${i}`] = `ctrl+${i}`;
assert.equal(commands.length, Object.keys(expected).length);
for (const c of commands) {
  assert.equal(c.defaults.join("|"), expected[c.id], c.id);
  for (const key of c.defaults) assert.equal(conflicts(c.id, key).length, 0, `${c.id}: ${key} overlaps another default`);
}
assert.equal(new Set(commands.map((c) => c.id)).size, commands.length);
console.log(`keybindings smoke: ${commands.length} commands, full default map and resolution passed`);
