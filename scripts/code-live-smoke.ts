// bun scripts/code-live-smoke.ts
import { strict as assert } from "node:assert";
import { EditorState } from "@codemirror/state";
import type { AgentEvent, AgentEventPayload } from "../src/lib/ipc";
import { editedPaths, createEditTracker } from "../src/lib/code/agentEdits";
import { agentChanges, agentMarks, agentMarkState, setAgentMarks, clearAgentMarks } from "../src/lib/code/agentMarks";

const call = (name: string, input: unknown, id = "edit-1"): AgentEvent => ({ type: "toolCall", id, name, input });
const root = "C:/code/live";
assert.deepEqual(editedPaths(call("Write", { file_path: "src/a.ts" }), root), ["src/a.ts"]);
assert.deepEqual(editedPaths(call("MultiEdit", { file_path: "c:\\code\\live\\src\\a.ts" }), root), ["src/a.ts"]);
assert.deepEqual(editedPaths(call("NotebookEdit", { notebook_path: "C:/code/live/demo.ipynb" }), root), ["demo.ipynb"]);
assert.deepEqual(
  editedPaths(call("Edit", { files: ["src/a.ts", { path: "src/b.ts" }, { path: "C:\\code\\live\\src\\a.ts" }, null] }), root),
  ["src/a.ts", "src/b.ts"],
);
for (const path of [
  "C:/code/lively/a.ts",
  "../secret",
  "C:/elsewhere/a.ts",
  "D:/code/live/a.ts",
  "/etc/passwd",
  "src/../../secret",
  "C:/code/live/../secret",
])
  assert.deepEqual(editedPaths(call("Edit", { file_path: path }), root), [], path);
assert.deepEqual(editedPaths(call("Bash", { file_path: "src/a.ts" }), root), []);
assert.deepEqual(editedPaths(call("Edit", null), root), []);
assert.deepEqual(editedPaths(call("Edit", { file_path: "/repo/src/a.ts" }), "/repo"), ["src/a.ts"]);
const tracker = createEditTracker();
assert.equal(tracker.accept(call("Edit", { file_path: "a.ts" }), root)?.phase, "pending");
assert.equal(tracker.accept({ type: "toolResult", id: "edit-1", output: "", isError: false }, root)?.phase, "landed");
assert.equal(tracker.accept({ type: "toolResult", id: "edit-1", output: "", isError: false }, root), null);
tracker.accept(call("Write", { file_path: "a.ts" }), root);
assert.equal(tracker.accept({ type: "toolResult", id: "edit-1", output: "", isError: true }, root)?.phase, "failed");
assert.deepEqual(agentChanges("a\nb\nc", "a\nB\nc"), { ranges: [{ from: 2, to: 2 }], additions: 1, deletions: 1 });
assert.deepEqual(agentChanges("a\nc", "a\nb\nc"), { ranges: [{ from: 2, to: 2 }], additions: 1, deletions: 0 });
assert.deepEqual(agentChanges("a\nb\nc", "a\nc"), { ranges: [{ from: 2, to: 2 }], additions: 0, deletions: 1 });
assert.equal(agentChanges("same", "same").ranges.length, 0);
assert.equal(agentChanges("", "new\nfile").additions, 2);
assert.equal(agentChanges("a\nb", "").deletions, 2);
let editor = EditorState.create({ doc: "a\nb\nc", extensions: agentMarks });
editor = editor.update({ effects: setAgentMarks.of({ ranges: [{ from: 2, to: 2 }], flash: true }) }).state;
editor = editor.update({ changes: { from: 0, insert: "first\n" } }).state;
const positions: number[] = [];
editor.field(agentMarkState).marks.between(0, editor.doc.length, (from) => {
  positions.push(editor.doc.lineAt(from).number);
});
assert.deepEqual(positions, [3], "Agent gutter follows subsequent human edits");
editor = editor.update({ effects: clearAgentMarks.of(null) }).state;
assert.equal(editor.field(agentMarkState).marks.size, 0);

Object.assign(globalThis, { window: globalThis, confirm: () => true, localStorage: { getItem: () => null, setItem: () => {} } });
await import("../src/lib/env");
const { mockIPC } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const { mockCodeCommand } = await import("../src/lib/code/mock");
mockIPC((cmd, args) => mockCodeCommand(cmd, args), { shouldMockEvents: true });
const { codeApi } = await import("../src/lib/ipc");
const { useCode, bufferKey, baselineKey } = await import("../src/stores/code");
const { useApp } = await import("../src/stores/app");
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
const s = () => useCode.getState();
useApp.setState({
  workspaces: [{ id: "live", path: root, status: "running", name: "Live test" } as never],
  settings: { editorFollowAgent: true, editorAutosave: "off" } as never,
});
await s().openRoot(root, { workspaceId: "live" });
await s().init(); // repeated init must not subscribe twice
assert.equal(s().roots[0].mode, "watch");
await s().openFile("src/main.ts");
const key = bufferKey(root, "src/main.ts"),
  before = s().buffers[key].text;
let seq = 0;
const agent = async (event: AgentEvent) => {
  await emit("agent-event", { workspaceId: "live", seq: ++seq, ts: Date.now(), event } satisfies AgentEventPayload);
  await pause();
};
await agent({ type: "turnStarted" });
await agent(call("Edit", { file_path: `${root}/src/main.ts` }));
assert.equal(s().activity.length, 1, "one subscription");
assert.equal(s().activity[0].phase, "editing");
const updated = before.replace("async function main()", "async function boot()");
await codeApi.writeFile(root, "src/main.ts", updated, null);
await agent({ type: "toolResult", id: "edit-1", output: "", isError: false });
assert.equal(s().activity.length, 1, "fs + toolResult coalesce");
assert.equal(s().activity[0].phase, "done");
assert.equal(s().baselines[baselineKey(s().activity[0])], before);
assert.equal(s().buffers[key].text, updated);
assert(s().marks[key].ranges.length);
await agent({ type: "turnCompleted", durationMs: 1, costUsd: null, isError: false, error: null });
assert.equal(s().roots[0].mode, "watch");
assert.equal(s().turns.live.running, false);
// Explicit Manual must survive unrelated workspace updates.
s().setMode(root, "manual");
useApp.setState((app) => ({ workspaces: app.workspaces.map((w) => ({ ...w, name: "Renamed" })) }));
assert.equal(s().roots[0].mode, "manual");
await agent({ type: "turnStarted" });
s().setMode(root, "manual");
await agent(call("Edit", { file_path: "src/main.ts" }, "edit-2"));
s().updateText(root, "src/main.ts", updated + "// human typing\n");
// Switching back to Watch cannot discard typing performed during this turn.
s().setMode(root, "watch");
await codeApi.writeFile(root, "src/main.ts", updated + "// agent typing\n", null);
await agent({ type: "toolResult", id: "edit-2", output: "", isError: false });
assert(s().buffers[key].text.includes("human typing"));
assert.equal(s().buffers[key].diskChanged, true);
assert.equal(s().buffers[key].changedBy, "live");
assert.equal(s().baselines[baselineKey(s().activity.at(-1)!)], updated);
await agent(call("Edit", { file_path: "README.md" }, "failed"));
await agent({ type: "toolResult", id: "failed", output: "Denied", isError: true });
assert.equal(s().activity.at(-1)?.phase, "failed");
await agent({ type: "message", text: "All done.\nSecond line." });
assert.equal(s().agentMessages.live, "All done. Second line.");
// Manual records activity without changing the active file; filesystem-only edits use HEAD as a fallback.
s().setMode(root, "manual");
await s().openFile("src/main.ts");
await agent(call("Edit", { file_path: "README.md" }, "manual-edit"));
assert.equal(s().roots[0].activeRel, "src/main.ts");
await codeApi.writeFile(root, "README.md", "# Updated by a shell command\n", null);
await pause();
assert.equal(s().roots[0].activeRel, "src/main.ts");
assert(s().activity.some((a) => a.rel === "README.md" && a.phase === "done"));
await codeApi.create(root, "shell-output.ts", false);
await codeApi.writeFile(root, "shell-output.ts", "export const shell = true;\n", null);
await pause();
assert(s().activity.some((a) => a.rel === "shell-output.ts" && a.phase === "done" && a.additions > 0));
await codeApi.remove(root, "shell-output.ts");
await pause();
assert(s().activity.some((a) => a.rel === "shell-output.ts" && a.removed));
await agent({ type: "turnCompleted", durationMs: 1, costUsd: null, isError: false, error: null });
await agent({ type: "turnStarted" });
assert.deepEqual(s().marks, {}, "next turn clears agent marks");
s().clearMarks();
assert.deepEqual(s().marks, {});
const { selectionMessage } = await import("../src/lib/code/helpers");
assert.equal(
  selectionMessage({ rel: "src/a.ts", from: 10, to: 20, text: "const a = 1;" }, "Explain it"),
  "In `src/a.ts` lines 10-20:\n\n```ts\nconst a = 1;\n```\n\nExplain it",
);
assert(selectionMessage({ rel: "a.md", from: 1, to: 1, text: "```" }, "Help").includes("line 1:\n\n````markdown"));
console.log(
  "Code live smoke passed: paths/tracker, line ranges, mapped marks, single subscription, turn baselines, fs/result coalescing, Watch/Manual, preserved human edits, attribution, failure and messages.",
);
