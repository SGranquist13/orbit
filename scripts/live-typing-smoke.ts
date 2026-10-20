// bun scripts/live-typing-smoke.ts
import { strict as assert } from "node:assert";
import { draftProjection, editProjection, diffProjection, locateEdit, makeReplay } from "../src/lib/code/liveTyping";
import { editedPaths } from "../src/lib/code/agentEdits";
import type { AgentEvent } from "../src/lib/ipc";

assert.deepEqual(
  editedPaths({ type: "toolDraft", id: "partial-path", name: "Write", input: { file_path: "src/par" } }, "/repo"),
  [],
);
assert.deepEqual(
  editedPaths({ type: "toolDraft", id: "path", name: "Write", input: { file_path: "src/partial.ts", content: "" } }, "/repo"),
  ["src/partial.ts"],
);
assert.equal(locateEdit("one two", "two"), 4);
assert.equal(locateEdit("x x x", "x", 2), 2);
assert.equal(locateEdit("x x x", "x", 9), 0);
assert.equal(locateEdit("abc", "missing"), -1);
assert.equal(editProjection("one", [{ old_string: "missing", new_string: "x" }]), null);
assert.equal(editProjection("x x x", [{ old_string: "x", new_string: "YES" }], 2)?.text, "x YES x");
assert.equal(editProjection("x x", [{ old_string: "x", new_string: "xx", replace_all: true }])?.text, "xx xx");
const multi = editProjection("a b a", [
  { old_string: "a", new_string: "A" },
  { old_string: "a", new_string: "Z" },
])!;
assert.equal(multi.text, "A b Z");
assert.deepEqual(multi.removed, [
  { at: 0, text: "a" },
  { at: 4, text: "a" },
]);
assert.equal(draftProjection("{}", "NotebookEdit", { new_source: "cell" }, "x.ipynb"), null);
const patch = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+";
for (const part of ["B", "Be", "Better"]) {
  const p = diffProjection("a\nb\nc\n", patch + part)!;
  assert.equal(p.text, `a\n${part}\nc\n`);
  assert.deepEqual(p.removed, [{ at: 2, text: "b\n" }]);
  assert.equal(p.caret, 2 + part.length);
}
assert.equal(diffProjection("other\nb", patch + "B"), null);
assert.equal(diffProjection("a", "@@ -bad"), null);
assert.equal(diffProjection("", "@@ -0,0 +1,2 @@\n+first\n+sec")?.text, "first\nsec\n");
assert.equal(draftProjection("a\nb\nc\n", "Edit", { changes: [{ path: "/repo/x", diff: patch + "B" }] }, "x")?.text, "a\nB\nc\n");
const replay = makeReplay("a\nb\nc\nd", "a\nBIG\nc\nDIFFERENT");
assert(replay.duration <= 1500);
assert.equal(replay.frame(replay.duration).text, "a\nBIG\nc\nDIFFERENT");
assert.notEqual(replay.frame(replay.duration / 2).text, replay.frame(replay.duration).text);
const huge = makeReplay("", "x".repeat(20001));
assert(huge.count > 20000);
assert.equal(huge.duration, 1500);
assert.equal(huge.frame(1500).text.length, 20001);

Object.assign(globalThis, { window: globalThis, confirm: () => true, localStorage: { getItem: () => null, setItem: () => {} } });
await import("../src/lib/env");
const { mockIPC } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const { mockCodeCommand } = await import("../src/lib/code/mock");
let writes = 0;
mockIPC(
  (cmd, args) => {
    if (cmd === "code_write_file" || cmd === "code_create") writes++;
    return mockCodeCommand(cmd, args);
  },
  { shouldMockEvents: true },
);
const { codeApi } = await import("../src/lib/ipc");
const { useCode, bufferKey } = await import("../src/stores/code");
const { useApp } = await import("../src/stores/app");
const root = "C:/live-typing",
  key = bufferKey(root, "new.ts"),
  existing = bufferKey(root, "src/main.ts");
const s = () => useCode.getState();
const wait = (ms = 65) => new Promise((r) => setTimeout(r, ms));
const send = async (event: AgentEvent) => {
  await emit("agent-event", { workspaceId: "typing", seq: null, ts: Date.now(), event });
  await wait();
};
const draft = (id: string, content: string): AgentEvent => ({
  type: "toolDraft",
  id,
  name: "Write",
  input: { file_path: "new.ts", content },
});
useApp.setState({
  workspaces: [{ id: "typing", path: root, status: "running", agent: "claude" } as never],
  settings: { editorFollowAgent: true, editorAutosave: "delay" } as never,
  view: "code",
});
await s().openRoot(root, { workspaceId: "typing" });
await s().init();
for (const text of ["", "export", "export const a = 1;\n", "export const a = 1;\n// next"]) {
  await send(draft("write", text));
  assert.equal(s().previews[key]?.text, text);
  assert.equal(s().buffers[key].text, "", "saved buffer never contains a draft");
  assert.equal(s().buffers[key].dirty, false);
  s().autosave(root, "new.ts");
  await s().save("new.ts", root);
  assert.equal(writes, 0, "draft never touches disk");
}
assert.equal(s().roots[0].activeRel, "new.ts");
assert(s().activity[0].turn > 0);
assert.equal(s().activity[0].writing, true);
assert.equal(s().activity.length, 1, "drafts coalesce to one timeline row");
await assert.rejects(codeApi.readFile(root, "new.ts"));
await send({ type: "toolResult", id: "write", output: "denied", isError: true });
assert.equal(s().previews[key], undefined, "failure discards the virtual preview");
assert.equal(s().buffers[key].text, "");
await s().openFile("src/main.ts");
const original = s().buffers[existing].text;
const old = "async function main()";
await send({
  type: "toolDraft",
  id: "edit",
  name: "Edit",
  input: { file_path: "src/main.ts", old_string: old, new_string: "async function b" },
});
assert.equal(s().previews[existing].text, original.replace(old, "async function b"));
assert.equal(s().previews[existing].removed[0].text, old);
await send({ type: "toolResult", id: "edit", output: "denied", isError: true });
assert.equal(s().previews[existing], undefined);
assert.equal(s().buffers[existing].text, original, "failed edit reverts to disk");
await send({
  type: "toolDraft",
  id: "success",
  name: "Edit",
  input: { file_path: "src/main.ts", old_string: old, new_string: "async function boot()" },
});
const final = original.replace(old, "async function boot()");
await codeApi.writeFile(root, "src/main.ts", final, null);
await wait();
assert(s().previews[existing], "filesystem notification must not settle a streaming tool early");
await send({
  type: "toolCall",
  id: "success",
  name: "Edit",
  input: { file_path: "src/main.ts", old_string: old, new_string: "async function boot()" },
});
await send({ type: "toolResult", id: "success", output: "done", isError: false });
assert.equal(s().previews[existing], undefined);
assert.equal(s().buffers[existing].text, final);
s().setMode(root, "manual");
const human = final + "// human\n";
s().updateText(root, "src/main.ts", human);
s().setMode(root, "watch");
await send({ type: "toolDraft", id: "dirty", name: "Write", input: { file_path: "src/main.ts", content: "DRAFT" } });
assert.equal(s().previews[existing], undefined);
assert.equal(s().buffers[existing].text, human, "dirty buffer never overwritten in Watch");
await codeApi.writeFile(root, "src/main.ts", "DISK", null);
await send({ type: "toolResult", id: "dirty", output: "done", isError: false });
assert.equal(s().buffers[existing].text, human);
assert(s().buffers[existing].diskChanged);
s().setMode(root, "manual");
await send(draft("manual", "manual draft"));
assert.equal(s().roots[0].activeRel, "src/main.ts");
assert.equal(s().previews[key], undefined);
assert(s().activity.at(-1)?.writing);
await send({ type: "toolResult", id: "manual", output: "denied", isError: true });
s().setMode(root, "watch");
await send(draft("interrupt", "partial"));
assert(s().previews[key]);
await send({ type: "turnCompleted", durationMs: 1, costUsd: null, isError: true, error: "Interrupted" });
assert.equal(Object.keys(s().previews).length, 0);
// A landed formatter edit without drafts replays only the visible clean file.
await s().reloadFromDisk("src/main.ts", root, true);
await s().openFile("src/main.ts", { preview: false }, root);
await send({ type: "turnStarted" });
await send({ type: "toolCall", id: "formatter", name: "Bash", input: { command: "format" } });
const replayBefore = s().buffers[existing].text,
  replayAfter = replayBefore + "\n" + "x".repeat(600);
await codeApi.writeFile(root, "src/main.ts", replayAfter, null);
await wait(80);
assert(s().previews[existing]?.replay, "visible formatter edit replays");
assert.equal(s().buffers[existing].text, replayBefore, "replay leaves real buffer untouched until settlement");
assert(s().previews[existing].text.length < replayAfter.length);
await wait(1550);
assert.equal(s().previews[existing], undefined);
assert.equal(s().buffers[existing].text, replayAfter);
await codeApi.writeFile(root, "src/main.ts", replayAfter + "x".repeat(20001), null);
await wait();
assert.equal(s().previews[existing], undefined, "huge insertion flashes without replay");
assert.equal(s().buffers[existing].text.length, replayAfter.length + 20001);
useApp.setState((app) => ({ settings: { ...app.settings!, editorLiveTyping: "instant" } }));
await send(draft("instant", "instant"));
assert.equal(s().previews[key], undefined);
await send({ type: "toolResult", id: "instant", output: "denied", isError: true });
console.log(
  "Live typing smoke passed: progressive Write/Edit/diff, MultiEdit, replay cap, no disk writes, dirty protection, Manual/Instant, failure and interruption.",
);
