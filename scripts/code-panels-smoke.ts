// Contract regression smoke: bun scripts/code-panels-smoke.ts
import { strict as assert } from "node:assert";
Object.assign(globalThis, { window: globalThis, confirm: () => true, localStorage: { getItem: () => null, setItem: () => {} } });
await import("../src/lib/env");
const { mockIPC } = await import("@tauri-apps/api/mocks");
const { mockCodeCommand } = await import("../src/lib/code/mock");
mockIPC((cmd, args) => mockCodeCommand(cmd, args), { shouldMockEvents: true });
const { codeApi, ptyApi, codeEvents } = await import("../src/lib/ipc");
const { useCode, bufferKey } = await import("../src/stores/code");
const { useApp } = await import("../src/stores/app");
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const { Text } = await import("@codemirror/state");
const { gitLineChanges } = await import("../src/lib/code/gitGutter");
const changes = (a: string | null, b: string) => [...gitLineChanges(a, Text.of(b.split("\n"))).values()];
assert.deepEqual(
  changes("one\ntwo\nthree", "one\nTWO\nthree").map((m) => m.kind),
  ["modified"],
);
assert.deepEqual(
  changes("one\nthree", "one\ntwo\nthree").map((m) => m.kind),
  ["added"],
);
assert(changes("one\ntwo\nthree", "one\nthree").some((m) => m.deletedBelow));
assert(changes("one\ntwo\nthree", "one\nTWO").some((m) => m.deletedBelow));
assert.deepEqual(
  changes(null, "one\ntwo").map((m) => m.kind),
  ["added", "added"],
);
assert.equal(changes("same", "same").length, 0);
const s = () => useCode.getState();
const root = "C:/code/panels-smoke";
await s().openRoot(root);
await s().createEntry("search.txt", false);
s().updateText(root, "search.txt", "Session session sessions 🙂session\n");
await s().save("search.txt");
await pause();
const options = { regex: false, caseSensitive: false, wholeWord: false, include: "*.txt", exclude: "" };
assert.equal((await codeApi.search(root, "session", { ...options, wholeWord: true }, 8)).matches.length, 3);
assert.equal((await codeApi.search(root, "Session", { ...options, caseSensitive: true }, 9)).matches.length, 1);
const unicode = await codeApi.search(root, "🙂session", { ...options, regex: true }, 10);
assert.equal(unicode.matches[0].end - unicode.matches[0].start, 9);
assert.equal((await codeApi.search(root, ".", { ...options, regex: true, exclude: "search.*" }, 11)).matches.length, 0);
await assert.rejects(() => codeApi.search(root, "[", { ...options, regex: true }, 12));
assert.equal(await codeApi.fileAt(root, "src/components/Login.tsx", "HEAD"), null);
const head = await codeApi.fileAt(root, "README.md", "HEAD");
assert.notEqual(head, (await codeApi.readFile(root, "README.md")).text);
assert.notEqual(head, await codeApi.fileAt(root, "README.md", "base"));
await codeApi.writeFile(root, "README.md", "edited on disk", null);
assert.equal(await codeApi.fileAt(root, "README.md", "HEAD"), head, "HEAD stays frozen after writes");
await s().openFileAt("src/main.ts", { line: 4, start: 0, end: 5 });
assert.equal(s().jump?.target.line, 4);
assert.equal(s().roots[0].tabs.find((t) => t.rel === "src/main.ts")?.preview, false);
s().toggleDiff();
assert.equal(s().diffTabs[bufferKey(root, "src/main.ts")], "HEAD");
s().toggleDiff();
assert.equal(s().diffTabs[bufferKey(root, "src/main.ts")], undefined);

const output = new Map<string, string>(),
  exits: string[] = [];
const offData = await codeEvents.onPtyData(({ id, data }) => output.set(id, (output.get(id) ?? "") + data));
const offExit = await codeEvents.onPtyExit(({ id }) => exits.push(id));
const first = await ptyApi.open(root, 80, 24),
  second = await ptyApi.open("C:/other", 80, 24);
await pause();
assert(output.get(first)?.includes("PS C:\\code\\panels-smoke> "));
await ptyApi.write(first, "echo hix\x7f\r");
assert(output.get(first)?.includes("\r\nhi\r\nPS "));
assert(!output.get(second)?.includes("hi"));
await ptyApi.write(first, "pwd\rdir\runknown\r");
assert(output.get(first)?.includes("package.json"));
assert(output.get(first)?.includes("(mock shell) unknown"));
await ptyApi.write(first, "exit\r");
assert.deepEqual(exits, [first]);
await ptyApi.close(second);
offData();
offExit();

const originalSettings = useApp.getState().settings;
useApp.setState({ settings: { ...originalSettings, editorAutosave: "delay" } as NonNullable<typeof originalSettings> });
s().updateText(root, "src/main.ts", "// delay save\n");
await pause(1100);
assert.equal(s().buffers[bufferKey(root, "src/main.ts")].dirty, false);
s().updateText(root, "src/main.ts", "// conflict: never autosave\n");
await codeApi.writeFile(root, "src/main.ts", "// external\n", null);
await pause(1100);
assert.equal(s().buffers[bufferKey(root, "src/main.ts")].diskChanged, true);
assert.equal((await codeApi.readFile(root, "src/main.ts")).text, "// external\n");
useApp.setState({ settings: { ...originalSettings, editorAutosave: "focus" } as NonNullable<typeof originalSettings> });
await s().reloadFromDisk("src/main.ts", root, true);
s().updateText(root, "src/main.ts", "// focus save\n");
s().setActive("search.txt");
await pause();
assert.equal((await codeApi.readFile(root, "src/main.ts")).text, "// focus save\n");
s().newTerminal();
const terminalId = s().terminals[0].id;
s().openSearch();
assert.equal(s().activeBottomTab, "search");
assert.equal(s().terminals[0].id, terminalId);
s().closeTerminal(terminalId);
useApp.setState({ settings: originalSettings });
console.log(
  "Code panels smoke passed: git gutter line mapping, search options/UTF-16, frozen HEAD/base, navigation/diff, PTY shell/routing/exit, autosave/conflicts.",
);
