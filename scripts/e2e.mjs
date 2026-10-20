// End-to-end test of the REAL desktop app (not the mock): launches the debug build with
// WebView2 remote debugging, drives the UI over the Chrome DevTools Protocol, and asserts on
// the DOM. Uses real agents (Claude haiku, Codex default) in a throwaway repo. The CDP driver is
// shared with scripts/e2e-github.mjs (scripts/e2e-harness.mjs).
//
//   1. `bun run dev` (Vite on :1420; the debug build loads the UI from it)
//   2. build once: cmd //c "scripts\\cargo.cmd build"
//   3. node scripts/e2e.mjs [scratch-dir] [step]
//
// Single step: `node scripts/e2e.mjs trunk-save-points`. <scratch-dir> defaults to <os tmpdir>/orbit-e2e and must be OUTSIDE any git repo (checked: git would
// resolve plain folders in it to the enclosing repo). A single step runs after the cheap prerequisites
// (boots-real-backend, add-repo); steps needing workspaces from earlier steps fail fast with
// "needs the full suite". It gets a fresh `home/` (ORBIT_HOME) and `repo/` (a local git repo, no remote),
// so the user's real ~/.orbit state is never touched. Screenshots land in <scratch-dir>/shots.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import path from "node:path";
import { TURN_ENDS, createHarness, killLeftovers, resolveScratch, sleep, uiHelpers } from "./e2e-harness.mjs";

// `node scripts/e2e.mjs [scratch-dir] [step]`; a lone argument without path characters is a step name.
const args = process.argv.slice(2);
const stepOnly = args.length === 1 && !/[\\/:.]/.test(args[0]);
const scratch = resolveScratch(stepOnly ? undefined : args[0], "orbit-e2e");
const only = stepOnly ? args[0] : args[1]; // optional: run a single step by name
const h = createHarness({ scratch, only });
const ui = uiHelpers(h);
const { home, launch, quit, cdp, js, waitFor, until, key, chord, type, shot, invoke, step } = h;
const repo = path.join(scratch, "repo");

const DOM = `
  const text = () => document.body.innerText;
  const userBlocks = () => [...document.querySelectorAll('[data-user-message]')].map(e => e.innerText);
  const sidebarRow = (name) => [...document.querySelectorAll('aside li button')].find(b => b.innerText.includes(name));
`;

const newWorkspace = (opts) => ui.newWorkspace(opts);

async function composerSend(text) {
  await js(`document.querySelector('textarea[placeholder*="Claude"], textarea[placeholder*="Codex"]').focus()`);
  await type(text);
  await key("Enter");
}

const turnEnds = TURN_ENDS;

// Inbox helpers. Alt+1 opens, and a failed earlier step can leave the view open, so open it idempotently.
const INBOX_JS = `const inbox = [...document.querySelectorAll('h1')].find((h) => h.innerText === 'Inbox')?.closest('.flex-col');
    const rows = () => [...(inbox?.querySelectorAll('li') ?? [])];`;
// Alt+4 opens the Teammates view, so only press it when the view isn't already open.
const ensureTeammates = async () => {
  if (!(await js(`return !!document.querySelector('[data-teammates]')`))) await key("4", { alt: true });
};
const ensureInbox = async () => {
  if (!(await js(`${INBOX_JS} return !!inbox`))) await key("1", { alt: true });
  await waitFor("inbox view", `${INBOX_JS} return !!inbox`, 5000);
};
// Focus follows the mouse (and moves to a neighbour after a send), so key shortcuts must name their row:
// another workspace (e.g. the errored Codex one) can hold focus.
const focusInboxRow = async (name) => {
  await js(`${INBOX_JS} rows().find((li) => li.innerText.includes(${name}))?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await waitFor("row focused", `${INBOX_JS} return rows().find((li) => li.innerText.includes(${name}))?.querySelectorAll('button').length >= 3`, 5000);
};

// ── Scenario ──────────────────────────────────────────────────
killLeftovers(scratch);
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
const git = (...a) => new Promise((res, rej) => spawn("git", a, { cwd: repo, stdio: "ignore" }).on("exit", (c) => (c ? rej(new Error(`git ${a.join(" ")}`)) : res())));
fs.writeFileSync(path.join(repo, "README.md"), "# Demo\n\nScratch repo for Orbit e2e.\n");
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "repo-lib" }, null, 2) + "\n");
fs.writeFileSync(path.join(repo, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
// A sibling project that consumes `repo`, for the attached-folders step.
const consumer = path.join(scratch, "consumer");
fs.mkdirSync(consumer, { recursive: true });
fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", dependencies: { "repo-lib": "file:../repo" } }, null, 2) + "\n");
fs.writeFileSync(path.join(consumer, "README.md"), "# Consumer\n\nThe unique marker word is ZEBRA-42.\n");
await git("init", "-q", "-b", "main");
await git("add", "-A");
await git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "init");

// Pack installs only accept https:// or git@ URLs; git itself rewrites this fake host to the local pack source (packs steps).
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = `url.${path.join(scratch, "packsrc").split("\\").join("/")}/.insteadOf`;
process.env.GIT_CONFIG_VALUE_0 = "https://orbit-e2e.test/";

console.log(`Real-app e2e — scratch: ${scratch}`);
await launch();
await cdp("Runtime.enable");

/** The first Claude workspace, made by claude-workspace-turn; single-step runs don't have one. */
const needClaudeWs = async (stepName, pred = (w) => w.agent === "claude") => {
  const ws = (await invoke("list_workspaces")).find(pred);
  if (!ws) throw new Error(`step "${stepName}" needs the full suite (run without a step argument): no workspace from an earlier step`);
  return ws;
};

await step("boots-real-backend", async () => {
  // A freshly built app can still be on its first load when the harness attaches; give it a moment.
  const probe = `return { tauri: 'isTauri' in window, theme: document.documentElement.dataset.theme, title: document.title, url: location.href }`;
  let info = await js(probe);
  for (let i = 0; i < 30 && !info.tauri; i++) {
    await sleep(500);
    info = await js(probe);
  }
  if (!info.tauri) throw new Error(`not running inside Tauri (mock?): ${JSON.stringify(info)}`);
  const packs = await invoke("list_packs");
  if (!packs.some((p) => p.name === "shipkit" && p.builtin)) throw new Error("shipkit not installed into ORBIT_HOME");
  if (packs.length !== 1) throw new Error(`expected only shipkit, got ${packs.map((p) => p.name)}`);
  await shot("01-empty");
}, { always: true });

await step("add-repo", async () => {
  await invoke("add_repo", { path: repo }); // the UI path uses a native folder picker
  await js(`location.reload()`);
  await sleep(1500);
  await waitFor("repo in sidebar", `return document.body.innerText.toUpperCase().includes('REPO')`, 10_000);
}, { always: true });

await step("code-shell", async () => {
  const filename = "ORBIT_CODE_E2E.ts";
  const file = path.join(repo, filename);
  fs.writeFileSync(file, "export const value = 1;\n");
  try {
    if (!(await js(`return !!document.querySelector('[data-code-view]')`))) await key("2", { alt: true });
    await waitFor("Code view", `return !!document.querySelector('[data-code-view]')`, 10_000);
    await js(`document.querySelector('[data-code-view] header button[aria-haspopup="menu"]').click()`);
    const repoName = (await invoke("list_repos"))[0].name;
    await js(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.innerText.includes(${JSON.stringify(repoName)})).click()`);
    await waitFor("Code explorer", `return !!document.getElementById('file-${filename}')`, 10_000);
    await js(`document.getElementById('file-${filename}').click()`);
    await waitFor("CodeMirror document", `return document.querySelector('.cm-content')?.innerText.includes('export const value = 1')`, 10_000);
    await js(`document.querySelector('.cm-content').focus()`);
    await key("End", { ctrl: true });
    await type("\n// Saved through Orbit Code\n");
    await waitFor("dirty tab", `return !!document.querySelector('[role="tablist"] [aria-label="Unsaved"]')`, 5000);
    await key("s", { ctrl: true });
    await until("Code saved file", async () => fs.readFileSync(file, "utf8").includes("Saved through Orbit Code"), 10_000, 100);
    await waitFor("clean tab", `return !document.querySelector('[role="tablist"] [aria-label="Unsaved"]')`, 5000);
    // Prove an external clean-buffer reload through the native watcher.
    fs.writeFileSync(file, "export const value = 2;\n");
    await waitFor("external file reload", `return document.querySelector('.cm-content')?.innerText.includes('export const value = 2')`, 10_000);
    await key("p", { ctrl: true });
    await waitFor("quick open", `return !!document.querySelector('[cmdk-input][placeholder^="Find a file"]')`, 5000);
    await key("Escape");
    await shot("code-shell-void");
    await chord(["k", { ctrl: true }], ["t", { ctrl: true }]);
    await shot("code-shell-paper");
    await chord(["k", { ctrl: true }], ["t", { ctrl: true }]);
    await key("w", { ctrl: true });
  } finally {
    fs.rmSync(file, { force: true });
    if (await js(`return !!document.querySelector('[data-code-view]')`)) await key("1", { alt: true });
  }
});


// No agent turn: recorder, live overrides, reset, and the save-all chord against two dirty files.
await step("keybindings", async () => {
  const filenames = ["ORBIT_KEYS_A.ts", "ORBIT_KEYS_B.ts"];
  for (const name of filenames) fs.writeFileSync(path.join(repo, name), "export const value = 1;\n");
  const panelOpen = `return document.querySelector('[aria-label="Bottom panel"]')?.getBoundingClientRect().height > 0`;
  try {
    await key("2", { alt: true });
    await waitFor("Code view", `return !!document.querySelector('[data-code-view]')`, 10000);
    await js(`document.querySelector('[data-code-view] header button[aria-haspopup="menu"]').click()`);
    const repoName = (await invoke("list_repos"))[0].name;
    await js(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.innerText.includes(${JSON.stringify(repoName)})).click()`);
    await waitFor("keybinding fixtures", `return !!document.getElementById('file-${filenames[0]}')`, 10000);
    for (const name of filenames) {
      await js(`document.getElementById('file-${name}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await js(`document.getElementById('file-${name}').click()`);
      await waitFor("active fixture", `return [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some(t => t.innerText.includes('${name}'))`, 5000);
      // The tab activates before the file loads; until then the hidden editor still holds the previous file.
      await waitFor("fixture loaded", `const c = document.querySelector('[data-code-view] .cm-content'); return !!c?.offsetParent && c.innerText.trim() === 'export const value = 1;'`, 5000);
      await js(`document.querySelector('[data-code-view] .cm-content').focus()`);
      await key("End", { ctrl: true });
      await type("\n// keybindings save all\n");
    }
    await chord(["k", { ctrl: true }], ["s", {}]);
    await until("both files saved by chord", async () => filenames.every(name => fs.readFileSync(path.join(repo, name), "utf8").includes("keybindings save all")), 10000, 100);
    await chord(["k", { ctrl: true }], ["s", { ctrl: true }]);
    await waitFor("keyboard shortcuts editor", `return !!document.querySelector('[data-command="code.toggleTerminal"]')`, 10000);
    await js(`document.querySelector('[aria-label="Change Toggle terminal"]').click()`);
    await waitFor("recorder", `return !!document.querySelector('[aria-label="Record keybinding"]')`, 5000);
    await key("t", { ctrl: true, alt: true });
    await key("Enter");
    await until("binding saved to settings", async () => (await invoke("get_settings")).keybindings["code.toggleTerminal"]?.[0] === "ctrl+alt+t", 5000, 100);
    await waitFor("binding persisted", `return document.querySelector('[data-command="code.toggleTerminal"]')?.innerText.includes('User')`, 5000);
    await key("2", { alt: true });
    await js(`document.activeElement?.blur()`);
    const before = await js(panelOpen);
    await key("t", { ctrl: true, alt: true });
    await waitFor("rebound terminal toggles", `${panelOpen.replace('return ', 'return (')} ) !== ${before}`, 10000);
    const rebound = await js(panelOpen);
    await key("`", { ctrl: true });
    await sleep(200);
    if ((await js(panelOpen)) !== rebound) throw new Error("old Toggle terminal key still active");
    await chord(["k", { ctrl: true }], ["s", { ctrl: true }]);
    await waitFor("shortcuts after rebind", `return !!document.querySelector('[data-command="code.toggleTerminal"]')`, 5000);
    await h.autoConfirm();
    await js(`[...document.querySelectorAll('#settings-shortcuts button')].find(b => b.innerText === 'Reset all').click()`);
    await waitFor("defaults restored", `return document.querySelector('[data-command="code.toggleTerminal"]')?.innerText.includes('Default')`, 5000);
    await key("2", { alt: true });
    await js(`document.activeElement?.blur()`);
    const restored = await js(panelOpen);
    await key("`", { ctrl: true });
    await waitFor("default terminal toggles", `${panelOpen.replace('return ', 'return (')} ) !== ${restored}`, 5000);
    await shot("keybindings");
  } finally {
    // Restore defaults even when a recorder/assertion fails, so subsequent scenarios are independent.
    await key("Escape");
    await invoke("update_settings", { patch: { keybindings: {} } });
    for (const name of filenames) fs.rmSync(path.join(repo, name), { force: true });
    await js(`location.reload()`);
    await sleep(1000);
    await key("1", { alt: true });
  }
});

// Requires the Code backend branch; no agent turn is needed for these editor checks.
await step("code-panels", async () => {
  const filename = "ORBIT_PANELS_E2E.ts";
  const file = path.join(repo, filename);
  fs.writeFileSync(file, 'export const PANEL_NEEDLE = "hi";\n');
  try {
    if (!(await js(`return !!document.querySelector('[data-code-view]')`))) await key("2", { alt: true });
    await waitFor("Code view", `return !!document.querySelector('[data-code-view]')`, 10_000);
    await js(`document.querySelector('[data-code-view] header button[aria-haspopup="menu"]').click()`);
    const repoName = (await invoke("list_repos"))[0].name;
    await js(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.innerText.includes(${JSON.stringify(repoName)})).click()`);
    await waitFor("panel fixture", `return !!document.getElementById('file-${filename}')`, 10_000);
    await js(`document.getElementById('file-${filename}').click()`);
    await waitFor("added gutter", `return !!document.querySelector('.cm-git-added')`, 10_000);
    await js(`[...document.querySelectorAll('[data-code-view] button')].find(b => b.innerText === 'Diff').click()`);
    await waitFor("merge editors", `return document.querySelectorAll('.code-diff .cm-editor').length === 2`, 10_000);
    await js(`[...document.querySelectorAll('[data-code-view] button')].find(b => b.innerText === 'Diff').click()`);
    await key("f", { ctrl: true, shift: true });
    await waitFor("project search focus", `return document.activeElement?.getAttribute('aria-label') === 'Search in files'`, 5000);
    await type("PANEL_NEEDLE");
    await waitFor("project search result", `return [...document.querySelectorAll('details button')].some(b => b.innerText.includes('PANEL_NEEDLE'))`, 10_000);
    await js(`[...document.querySelectorAll('details button')].find(b => b.innerText.includes('PANEL_NEEDLE')).click()`);
    await waitFor("search selection", `const el = document.querySelector('.cm-content'); return el && window.getSelection()?.toString() === 'PANEL_NEEDLE'`, 5000);
    await key("`", { ctrl: true });
    await waitFor("terminal textarea", `return !!document.querySelector('.xterm-helper-textarea')`, 10_000);
    await js(`document.querySelector('.xterm-helper-textarea').focus()`);
    await type("echo ORBIT_TERMINAL_SMOKE");
    await key("Enter");
    await waitFor("terminal shell output", `return (document.querySelector('.xterm-rows')?.textContent.match(/ORBIT_TERMINAL_SMOKE/g) || []).length >= 2`, 10_000);
    await shot("code-panels");
    await js(`document.querySelector('[aria-label^="Close Terminal"]').click()`);
    await key("w", { ctrl: true });
  } finally {
    fs.rmSync(file, { force: true });
    if (await js(`return !!document.querySelector('[data-code-view]')`)) await key("1", { alt: true });
  }
});

await step("claude-workspace-turn", async () => {
  await newWorkspace({
    agent: "claude",
    model: "haiku",
    prompt: "Create a file NOTES.md containing exactly one line: hello from claude. Then reply with one short sentence.",
  });
  await waitFor("workspace selected + user block", `${DOM} return userBlocks().some(t => t.includes('NOTES.md'))`, 30_000);
  // Fast models can finish before we look, so the running indicator is best-effort.
  await waitFor("running status or finished", `return !!document.querySelector('.dither-sweep') || ${turnEnds.slice(7)} >= 1`, 20_000);
  await shot("02-claude-running");
  await waitFor("turn completed", `${turnEnds} >= 1`, 120_000);
  // The Ship panel is hidden by default, so check the workspace's changes directly.
  await waitFor("changes list NOTES.md", `const id = (await window.__TAURI_INTERNALS__.invoke("list_workspaces"))[0].id; return (await window.__TAURI_INTERNALS__.invoke("workspace_changes", { id })).some(f => f.path === 'NOTES.md')`, 15_000);
  const tools = await js(`return document.body.innerText.match(/\\d+ TOOL CALLS?/i)?.[0] ?? ''`);
  if (!tools) throw new Error("no tool-call group rendered");
  await shot("03-claude-done");
});

await step("worktree-on-disk", async () => {
  const ws = await needClaudeWs("worktree-on-disk");
  if (!fs.existsSync(path.join(ws.path, "NOTES.md"))) throw new Error(`NOTES.md missing in worktree ${ws.path}`);
  if (fs.existsSync(path.join(repo, "NOTES.md"))) throw new Error("agent wrote to the main checkout, not the worktree");
});

await step("pr-panel-without-remote", async () => {
  await needClaudeWs("pr-panel-without-remote");
  await ui.openShip();
  await waitFor("no-PR state", `return document.body.innerText.includes('No pull request for this branch yet')`, 20_000);
});

await step("follow-up-message", async () => {
  await needClaudeWs("follow-up-message");
  const before = await js(turnEnds);
  await composerSend("What is the exact content of NOTES.md? Answer with just the content.");
  await waitFor("second turn", `${turnEnds} > ${before}`, 120_000);
  const last = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
  if (!/hello from claude/i.test(last)) throw new Error(`unexpected answer: ${last.slice(0, 120)}`);
});

await step("slash-autocomplete-and-skill", async () => {
  await needClaudeWs("slash-autocomplete-and-skill");
  await js(`document.querySelector('textarea[placeholder*="Claude"]').focus()`);
  await type("/rebase");
  await waitFor("autocomplete popup", `return [...document.querySelectorAll('ul li button')].some(b => b.innerText.includes('/shipkit:rebase'))`, 5000);
  await shot("04-autocomplete");
  await key("Tab");
  const val = await js(`return document.querySelector('textarea[placeholder*="Claude"]').value`);
  if (val !== "/shipkit:rebase ") throw new Error(`tab completion gave "${val}"`);
  // Clear and run a harmless skill through a pinned chip instead (no remote, so nothing leaves the machine).
  await js(`
    const t = document.querySelector('textarea[placeholder*="Claude"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '');
    t.dispatchEvent(new Event('input', { bubbles: true }));`);
  const before = await js(turnEnds);
  await ui.clickChip("rebase");
  await waitFor("skill chip in transcript", `return [...document.querySelectorAll('[data-user-message]')].some(e => e.innerText.includes('/shipkit:rebase'))`, 10_000);
  await waitFor("skill turn completed", `${turnEnds} > ${before}`, 180_000);
  await shot("05-skill");
});

await step("interrupt", async () => {
  await needClaudeWs("interrupt");
  const before = await js(turnEnds);
  await composerSend("Count slowly from 1 to 400, one number per line, no tools.");
  await waitFor("streaming started", `return !!document.querySelector('.streaming-caret') || !!document.querySelector('.dither-march')`, 60_000);
  await sleep(1500);
  await js(`document.querySelector('textarea').focus()`);
  await key("Escape");
  await waitFor("turn ended after interrupt", `${turnEnds} > ${before}`, 60_000);
  await waitFor("status leaves running", `return !document.querySelector('header .dither-sweep')`, 20_000);
  const end = await js(`return [...document.querySelectorAll('.dither-rule.flex-1')].at(-1).parentElement.innerText`);
  if (!/interrupted/i.test(end)) throw new Error(`interrupt rendered as: ${end}`);
  const status = (await invoke("list_workspaces")).find((w) => w.agent === "claude").status;
  if (status !== "idle") throw new Error(`status after interrupt is ${status}, expected idle`);
});

await step("codex-workspace-turn", async () => {
  await newWorkspace({ agent: "codex", prompt: "Reply with exactly the word: pong" });
  await waitFor("codex user block", `${DOM} return userBlocks().some(t => t.includes('pong'))`, 30_000);
  await waitFor("codex turn completed", `${turnEnds} >= 1`, 120_000);
  const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
  if (!/pong/i.test(msg)) throw new Error(`codex answered: ${msg.slice(0, 120)}`);
  await shot("06-codex");
});

await step("palette-and-theme", async () => {
  await key("p", { ctrl: true, shift: true });
  await waitFor("palette", `return !!document.querySelector('[cmdk-input]')`, 5000);
  await type("notes");
  await shot("07-palette");
  await key("Escape");
  const before = await js(`return document.documentElement.dataset.theme`);
  await chord(["k", { ctrl: true }], ["t", { ctrl: true }]);
  const after = await js(`return document.documentElement.dataset.theme`);
  if (before === after) throw new Error("Ctrl+K Ctrl+T did not toggle theme");
  await shot("08-theme-toggled");
  await chord(["k", { ctrl: true }], ["t", { ctrl: true }]);
});

await step("packs-dialog", async () => {
  await js(`[...document.querySelectorAll('button')].find(b => b.title === 'Add or manage skill shortcuts')?.click()`);
  await waitFor("packs dialog", `return document.body.innerText.includes('Skill packs') && document.body.innerText.includes('shipkit')`, 5000);
  await shot("09-packs");
  await key("Escape");
  await js(`document.querySelector('.fixed.inset-0')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
});

await step("inbox", async () => {
  const INBOX = `const inbox = [...document.querySelectorAll('h1')].find((h) => h.innerText === 'Inbox')?.closest('.flex-col');
    const rows = () => [...(inbox?.querySelectorAll('li') ?? [])];`;
  const claudeWs = await needClaudeWs("inbox");
  const name = JSON.stringify(claudeWs.name.slice(0, 20));
  const row = (cond) => `${INBOX} return rows().some((li) => li.innerText.includes(${name}) && ${cond})`;

  await ensureInbox();
  // Work finishes in the background while the user is in the inbox.
  await invoke("send_message", { id: claudeWs.id, text: "Reply with exactly one word: ready" });
  await waitFor("finished row appears", row(`/Finished/.test(li.innerText)`), 120_000);
  await waitFor(
    "AI suggestions load (real Haiku)",
    `${INBOX} return !inbox.innerText.includes('Thinking of suggestions') &&
      rows().find((li) => li.innerText.includes(${name}))?.querySelectorAll('button').length >= 6`,
    60_000,
  );
  await shot("11-inbox");
  // Rule chip 3 is "Summarize what changed" (the worktree has NOTES.md, so chip 1 is "Ship it").
  await js(`document.activeElement?.blur()`);
  await focusInboxRow(name);
  await key("3");
  await waitFor("row leaves while the agent works", `${INBOX} return !rows().some((li) => li.innerText.includes(${name}) && /Finished/.test(li.innerText))`, 15_000);
  await waitFor("row comes back finished", row(`/Finished/.test(li.innerText)`), 120_000);
  const msg = await invoke("workspace_summary", { id: claudeWs.id });
  if (!/NOTES\.md/i.test(msg.lastAssistantText ?? "")) throw new Error(`summary turn answered: ${(msg.lastAssistantText ?? "").slice(0, 120)}`);
  await js(`document.activeElement?.blur()`);
  await focusInboxRow(name);
  await key("e");
  await waitFor("dismissed", `${INBOX} return !rows().some((li) => li.innerText.includes(${name}) && /Finished/.test(li.innerText))`, 10_000);
  await ui.workspaceView();
});

await step("inbox-snooze", async () => {
  const INBOX = `const inbox = [...document.querySelectorAll('h1')].find((h) => h.innerText === 'Inbox')?.closest('.flex-col');
    const rows = () => [...(inbox?.querySelectorAll('li') ?? [])];`;
  const claudeWs = await needClaudeWs("inbox-snooze");
  const name = JSON.stringify(claudeWs.name.slice(0, 20));
  const inNeeds = `${INBOX} return rows().some((li) => li.innerText.includes(${name}))`;

  await ensureInbox();
  // The previous step dismissed it; new activity puts it back in "Needs you".
  await invoke("send_message", { id: claudeWs.id, text: "Reply with exactly one word: again" });
  await waitFor("row is in Needs you", `${inNeeds} && /Finished/.test(rows().find((li) => li.innerText.includes(${name})).innerText)`, 120_000);
  await invoke("snooze_workspace", { id: claudeWs.id, until: Date.now() + 3_600_000 });
  await waitFor("snoozed row leaves Needs you", `${INBOX} return !rows().some((li) => li.innerText.includes(${name}))`, 10_000);
  await shot("11b-inbox-snoozed");
  await invoke("snooze_workspace", { id: claudeWs.id, until: 0 });
  await waitFor("unsnoozed row is back", `${INBOX} return rows().some((li) => li.innerText.includes(${name}) && /Finished/.test(li.innerText))`, 10_000);
  await js(`document.activeElement?.blur()`);
  await focusInboxRow(name);
  await key("e");
  await ui.workspaceView();
});

await step("attached-folders", async () => {
  const claudeWs = await needClaudeWs("attached-folders");
  const norm = (p) => p.split("\\").join("/").toLowerCase();
  const found = await invoke("discover_related", { workspaceId: claudeWs.id });
  if (!found.some((r) => norm(r.path) === norm(consumer) && r.relation === "dependent")) {
    throw new Error(`consumer not discovered as a dependent: ${JSON.stringify(found)}`);
  }
  await invoke("attach_folder", { workspaceId: claudeWs.id, path: consumer }); // the native picker can't be automated
  await js(`location.reload()`);
  await sleep(1500);
  await waitFor("sidebar loaded", `return !!document.querySelector('aside li button')`, 15_000);
  await js(`${DOM} sidebarRow(${JSON.stringify(claudeWs.name.slice(0, 20))}).click()`);
  await waitFor("attachment chip in header", `return [...document.querySelectorAll('header span')].some(e => e.innerText.includes('consumer'))`, 10_000);
  await waitFor("history restored", `return document.querySelectorAll('.prose-chat').length >= 2`, 15_000);
  await shot("12-attached-chip");
  const before = await js(turnEnds);
  await composerSend("Without editing anything, what unique marker word is written in the README.md of the attached consumer folder? Answer with just the word.");
  await waitFor("attached-folder turn", `${turnEnds} > ${before}`, 120_000);
  const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
  if (!msg.includes("ZEBRA-42")) throw new Error(`agent did not read the attached folder; answered: ${msg.slice(0, 120)}`);

  // Editable attachments: plain folders are refused; a git repo gets its own isolated worktree.
  const atts = await invoke("list_attachments", { workspaceId: claudeWs.id });
  const plain = atts.find((a) => norm(a.path) === norm(consumer));
  const refused = await invoke("set_attachment_editable", { id: plain.id, editable: true }).then(() => null, (e) => String(e));
  if (!/git repositor/i.test(refused ?? "")) throw new Error(`non-git folder was made editable: ${refused}`);
  const gitAtt = await invoke("attach_folder", { workspaceId: claudeWs.id, path: repo });
  const editable = await invoke("set_attachment_editable", { id: gitAtt.id, editable: true });
  if (!editable.worktreePath || !fs.existsSync(path.join(editable.worktreePath, "README.md"))) {
    throw new Error(`no worktree for editable attachment: ${JSON.stringify(editable)}`);
  }
  await invoke("detach_folder", { id: gitAtt.id }); // clean worktree, so detaching removes it
  if (fs.existsSync(editable.worktreePath)) throw new Error("detaching left the attachment worktree behind");
});

await step("profiles", async () => {
  const profiles = await invoke("list_profiles");
  for (const id of ["builder", "debugger", "planner", "reviewer", "shipper", "ticket-writer"]) {
    if (!profiles.some((p) => p.id === `shipkit:${id}`)) throw new Error(`missing profile shipkit:${id}`);
  }
  if (!profiles.find((p) => p.id === "shipkit:planner").readonly) throw new Error("planner is not read-only");

  // Planner can't edit: the Claude file tools are denied, and the prompt says so.
  await newWorkspace({
    agent: "claude",
    model: "haiku",
    profile: "shipkit:planner",
    prompt: "Create a file PLAN_TEST.md containing hello. If you cannot, reply exactly: READ-ONLY",
  });
  await waitFor("planner workspace + user block", `${DOM} return userBlocks().some(t => t.includes('PLAN_TEST.md'))`, 30_000);
  await waitFor("planner turn completed", `${turnEnds} >= 1`, 120_000);
  const planWs = (await invoke("list_workspaces")).find((w) => w.name.includes("PLAN_TEST.md"));
  if (planWs?.profile !== "shipkit:planner") throw new Error(`workspace profile not stored: ${planWs?.profile}`);
  if (fs.existsSync(path.join(planWs.path, "PLAN_TEST.md"))) throw new Error("read-only planner created PLAN_TEST.md");
  await waitFor("composer footer shows Planner", `return [...document.querySelectorAll('button[data-profile-trigger]')].some(b => b.innerText.includes('Planner'))`, 5000);
  await shot("13-planner");

  // Switch to Builder through the footer menu; the restarted session may now edit.
  await js(`document.querySelector('button[data-profile-trigger]').click()`);
  await waitFor("profile menu", `return !!document.querySelector('button[data-profile="shipkit:builder"]')`, 5000);
  await js(`document.querySelector('button[data-profile="shipkit:builder"]').click()`);
  await waitFor("footer shows Builder", `return [...document.querySelectorAll('button[data-profile-trigger]')].some(b => b.innerText.includes('Builder'))`, 5000);
  const before = await js(turnEnds);
  await composerSend("Now create PLAN_TEST.md containing hello.");
  await waitFor("builder turn completed", `${turnEnds} > ${before}`, 120_000);
  if (!fs.existsSync(path.join(planWs.path, "PLAN_TEST.md"))) throw new Error("builder did not create PLAN_TEST.md after switching");
  await shot("14-builder");
});

await step("trunk-save-points", async () => {
  // Orbit commits the worktree after a turn (save point), can undo it, and gates Ship on checks.
  const ws = await newWorkspace({ agent: "claude", model: "haiku", prompt: "Create a file TRUNK_TEST.md containing the word hello. Don't commit it." });
  await waitFor("trunk turn completed", `${turnEnds} >= 1`, 120_000);
  const g = (...a) => execFileSync("git", a, { cwd: ws.path, encoding: "utf8" }).trim();
  await h.until("save-point commit", async () => g("log", "-1", "--format=%s").startsWith("wip:") && fs.existsSync(path.join(ws.path, "TRUNK_TEST.md")), 30_000, 500);
  if (g("status", "--porcelain")) throw new Error("worktree still dirty after the save point");

  // Undo last turn drops the save point and its file.
  const head = g("rev-parse", "HEAD");
  await invoke("undo_last_turn", { workspaceId: ws.id });
  if (g("rev-parse", "HEAD") === head || fs.existsSync(path.join(ws.path, "TRUNK_TEST.md"))) throw new Error("undo_last_turn did not drop the save point");

  // prepare_ship: a failing check blocks (and flags the workspace); a passing one squashes the save points.
  const wip = () => {
    fs.writeFileSync(path.join(ws.path, "SAVED.md"), "saved\n");
    g("add", "-A");
    g("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "wip: simulated turn");
  };
  wip();
  const repoRow = (await invoke("list_repos"))[0];
  await invoke("set_check_command", { repoId: repoRow.id, cmd: "exit 1" });
  const blocked = await invoke("prepare_ship", { workspaceId: ws.id, skipChecks: false });
  if (blocked.ok || blocked.checks?.ok !== false) throw new Error(`failing check did not block: ${JSON.stringify(blocked)}`);
  if (!g("log", "-1", "--format=%s").startsWith("wip:")) throw new Error("blocked ship squashed anyway");
  const flagged = (await invoke("list_workspaces")).find((w) => w.id === ws.id);
  if (!flagged.checksFailed) throw new Error("checksFailed not set on the workspace");
  await invoke("set_check_command", { repoId: repoRow.id, cmd: "exit 0" });
  const ok = await invoke("prepare_ship", { workspaceId: ws.id, skipChecks: false });
  if (!ok.ok || ok.squashed < 1) throw new Error(`passing check did not ship-prepare: ${JSON.stringify(ok)}`);
  if (g("log", "-1", "--format=%s").startsWith("wip:")) throw new Error("save points were not squashed");
  await invoke("set_check_command", { repoId: repoRow.id, cmd: null });
});

await step("routines", async () => {
  const repoId = (await invoke("list_repos"))[0].id;
  const input = {
    repoId, name: "", schedule: { kind: "daily", time: "03:00" }, action: { kind: "prompt", text: "Reply with exactly one word: ping" },
    agent: "claude", model: "haiku", mode: "fresh", enabled: true,
  };
  // A one-off in the past is refused; a valid routine is stored with a next run and a default name.
  const past = await invoke("save_routine", { input: { ...input, schedule: { kind: "once", at: "2020-01-01T09:00" } } }).then(() => null, (e) => String(e));
  if (!past) throw new Error("a past one-off should be rejected");
  const routine = await invoke("save_routine", { input });
  if (!routine.nextRunAt || !routine.name.startsWith("Reply with exactly one word")) throw new Error(`bad routine: ${JSON.stringify(routine)}`);
  const known = new Set((await invoke("list_workspaces")).map((w) => w.id));
  await invoke("run_routine_now", { id: routine.id });
  // The run finishes by itself; nothing changed in the worktree, so it is marked quiet and archived.
  const run = await until("routine run finished", async () => {
    const [r] = await invoke("routine_runs", { routineId: routine.id, limit: 1 });
    return r && r.status !== "running" ? r : null;
  }, 180_000, 2000);
  // The row is finished as "done" first; the quiet check flips it a moment later, so let it settle.
  if (run.status === "done") {
    await until("routine run settled", async () => {
      const [r] = await invoke("routine_runs", { routineId: routine.id, limit: 1 });
      if (r.status !== "done") Object.assign(run, r);
      return r.status !== "done";
    }, 30_000, 1000).catch(() => {});
  }
  if (run.status !== "quiet") throw new Error(`expected a quiet run, got ${run.status}: ${run.summary}`);
  if (!(run.summary ?? "").trim()) throw new Error("routine run has no summary");
  await until("quiet workspace archived", async () => {
    const live = await invoke("list_workspaces");
    return !live.some((w) => !known.has(w.id) && w.routineId === routine.id);
  }, 30_000, 1000);
  await key("3", { alt: true });
  // Diagnostic for a full-suite-only failure (2026-10-18): record focus + header if the view didn't open.
  const diag = await js(`const a = document.activeElement; return (a?.tagName ?? '') + '#' + (a?.getAttribute('aria-label') ?? a?.className ?? '').slice(0, 60) + ' | h1=' + [...document.querySelectorAll('h1')].map(h => h.innerText).join(',')`);
  console.log(`      routines key diag: ${diag}`);
  await waitFor("routines view lists the routine", `return document.body.innerText.includes('Routines') && document.body.innerText.includes('Reply with exactly one word')`, 10_000);
  await shot("11-routines");
  await invoke("delete_routine", { id: routine.id });
  // The Simplify action round-trips (it is only stored here, not run: that needs a real Friday afternoon of merged work).
  const simp = await invoke("save_routine", { input: { ...input, name: "", action: { kind: "simplify" }, schedule: { kind: "weekly", weekday: 5, time: "16:00" } } });
  if (simp.action.kind !== "simplify" || simp.name !== "Simplify recent changes") throw new Error(`bad simplify routine: ${JSON.stringify(simp)}`);
  await invoke("delete_routine", { id: simp.id });
  await ui.workspaceView();
});

// Skipped unless an Ollama server with at least one model is reachable on localhost:11434.
await step("local-model-suggestions", async () => {
  const tags = await fetch("http://localhost:11434/api/tags").then((r) => r.json(), () => null);
  const models = (tags?.models ?? []).filter((m) => !/cloud/.test(m.name)).sort((a, b) => a.size - b.size);
  if (!models.length) return console.log("      (skipped: no Ollama on :11434)");
  const model = models.find((m) => m.name === "llama3.2:3b") ?? models[0];
  const status = await invoke("local_models_status");
  if (!status.ollama.running || !status.ollama.models.some((m) => m.name === model.name)) throw new Error("status does not list the Ollama model");
  const claudeWs = await needClaudeWs("local-model-suggestions");
  await invoke("update_settings", { patch: { modelSuggestions: `local:${model.name}`, localTimeoutSecs: 120 } });
  try {
    const out = await invoke("suggest_prompts", { id: claudeWs.id, reason: "Finished", offered: [] });
    if (!Array.isArray(out) || !out.length || out.some((s) => typeof s !== "string" || !s.trim())) throw new Error(`no local suggestions: ${JSON.stringify(out)}`);
    const after = await invoke("local_models_status");
    if (after.lastErrors.ollama) throw new Error(`ollama call recorded an error: ${after.lastErrors.ollama}`);
  } finally {
    await invoke("update_settings", { patch: { modelSuggestions: "default", localTimeoutSecs: 60 } });
  }
});

await step("simplify", async () => {
  // Find over-nested code with the read-only pass, apply every candidate, and let Orbit police it:
  // refactor commits only where the repo's check (a real behaviour test) stays green, tests untouched.
  const ws = await newWorkspace({ agent: "claude", model: "haiku", prompt: "Reply with the single word ok. Do not create or edit any files." });
  await waitFor("setup turn completed", `${turnEnds} >= 1`, 120_000);
  const g = (...a) => execFileSync("git", a, { cwd: ws.path, encoding: "utf8" }).trim();
  const commit = (msg) => g("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", msg);
  const wipHead = g("rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(ws.path, "shipping.js"),
    [
      "function shippingCost(order) {",
      "  let cost = 0;",
      "  if (order) {",
      "    if (order.items) {",
      "      if (order.items.length > 0) {",
      "        if (order.destination) {",
      "          if (order.destination.country === 'US') {",
      "            if (order.total > 100) {",
      "              cost = 0;",
      "            } else {",
      "              cost = 5;",
      "            }",
      "          } else {",
      "            cost = 20;",
      "          }",
      "        }",
      "      }",
      "    }",
      "  }",
      "  return cost;",
      "}",
      "module.exports = { shippingCost };",
      "",
    ].join("\n"),
  );
  const testSrc = [
    "const assert = require('node:assert');",
    "const { shippingCost } = require('./shipping.js');",
    "assert.strictEqual(shippingCost(null), 0);",
    "assert.strictEqual(shippingCost({ items: [] }), 0);",
    "assert.strictEqual(shippingCost({ items: [1], destination: { country: 'US' }, total: 150 }), 0);",
    "assert.strictEqual(shippingCost({ items: [1], destination: { country: 'US' }, total: 50 }), 5);",
    "assert.strictEqual(shippingCost({ items: [1], destination: { country: 'FR' }, total: 50 }), 20);",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(ws.path, "shipping.test.js"), testSrc);
  g("add", "-A");
  commit("feat: shipping cost");
  const featureHead = g("rev-parse", "HEAD");

  const repoRow = (await invoke("list_repos"))[0];
  await invoke("set_check_command", { repoId: repoRow.id, cmd: "node shipping.test.js" });
  await invoke("update_settings", { patch: { simplifyModel: "haiku", simplifyMaxCandidates: 3 } });

  await invoke("simplify_find", { workspaceId: ws.id });
  let st;
  await h.until("find finished", async () => {
    st = await invoke("simplify_state", { workspaceId: ws.id });
    if (st.error) throw new Error(`find failed: ${st.error}`);
    return st.phase === "ready";
  }, 300_000, 2000);
  if (st.candidates.length < 1) throw new Error("find returned no candidates for an obviously over-nested function");
  if (st.candidates.some((c) => /\.test\./.test(c.file))) throw new Error("a candidate targets a test file");
  await ui.openShip(); // make sure the right-hand area is in a known state, then open the Simplify panel
  await js(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Simplify').click()`);
  await waitFor("candidates listed in the panel", `return document.body.innerText.includes(${JSON.stringify(st.candidates[0].title.slice(0, 20))})`, 10_000);
  await shot("15-simplify-ready");

  // Two candidates are enough to prove the loop (each is a real haiku turn plus a check run).
  await invoke("simplify_apply", { workspaceId: ws.id, candidateIds: st.candidates.slice(0, 2).map((c) => c.id) });
  await h.until(
    "apply finished",
    async () => {
      const s = await invoke("simplify_state", { workspaceId: ws.id });
      if (s.phase === "done") return true;
      process.stdout.write(`      apply: ${s.rows.map((r) => r.status).join(", ")}\r`);
      return false;
    },
    480_000,
    3000,
  );
  st = await invoke("simplify_state", { workspaceId: ws.id });
  await shot("16-simplify-done");

  const applied = st.rows.filter((r) => r.status === "applied");
  if (applied.length < 1) throw new Error(`expected at least one applied refactor, got ${JSON.stringify(st.rows)}`);
  if (applied.some((r) => r.unchecked)) throw new Error("applied rows should have been checked");
  const subjects = g("log", "--format=%s", `${featureHead}..HEAD`).split("\n").filter(Boolean);
  if (!subjects.length || !subjects.every((s) => s.startsWith("refactor:"))) throw new Error(`unexpected commits after simplify: ${subjects}`);
  if (subjects.length !== applied.length) throw new Error(`${subjects.length} commits for ${applied.length} applied rows`);
  if (g("diff", featureHead, "HEAD", "--", "shipping.test.js")) throw new Error("the test file was changed");
  if (g("status", "--porcelain")) throw new Error("worktree left dirty");
  execFileSync("node", ["shipping.test.js"], { cwd: ws.path }); // behaviour preserved
  if (wipHead === g("rev-parse", "HEAD")) throw new Error("HEAD did not move");
  await invoke("set_check_command", { repoId: repoRow.id, cmd: null });
  await invoke("update_settings", { patch: { simplifyModel: "sonnet", simplifyMaxCandidates: 12 } });
});

// ── Settings, data and sessions ───────────────────────────────
/** Creates a workspace through the backend without a prompt (no agent turn), for steps that only need a worktree. */
const mkWs = async (name, extra = {}) =>
  invoke("create_workspace", { repoId: (await invoke("list_repos"))[0].id, name, agent: "claude", model: "haiku", prompt: null, issueNumber: null, profile: null, ...extra });
const gitIn = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const gitCommit = (cwd, msg) => gitIn(cwd, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", msg);
const wsStatus = async (id) => (await invoke("list_workspaces")).find((w) => w.id === id)?.status;
const SETTINGS_OPEN = `return [...document.querySelectorAll('h1')].some((h) => h.innerText === 'Settings')`;
const openSettingsView = async () => {
  if (!(await js(SETTINGS_OPEN))) {
    await js(`document.activeElement?.blur()`);
    await key(",", { ctrl: true });
  }
  await waitFor("settings view", SETTINGS_OPEN, 8000);
};
const closeSettingsView = async () => {
  if (await js(SETTINGS_OPEN)) await js(`[...document.querySelectorAll('header button')].find((b) => /^Close/.test(b.innerText.trim()))?.click()`);
  await waitFor("settings closed", `return ![...document.querySelectorAll('h1')].some((h) => h.innerText === 'Settings')`, 5000);
};
/** Runs fn with a settings patch applied, then puts the previous values back. */
const withSettings = async (patch, fn) => {
  const before = await invoke("get_settings");
  await invoke("update_settings", { patch });
  try {
    return await fn();
  } finally {
    await invoke("update_settings", { patch: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])) });
  }
};
const selectWsInSidebar = async (name) => {
  await js(`${DOM} sidebarRow(${JSON.stringify(name)})?.click()`);
  await waitFor("workspace selected", `return document.querySelector('header h1')?.innerText === ${JSON.stringify(name)}`, 10_000);
};

await step("agent-model-lists", async () => {
  const claude = await invoke("agent_models", { agent: "claude", refresh: false });
  if (claude.map((m) => m.id).join(",") !== "opus,sonnet,haiku") throw new Error("unexpected Claude aliases");
  const codex = await invoke("agent_models", { agent: "codex", refresh: true });
  if (!codex.length || codex.some((m) => !m.id || !m.label || !Array.isArray(m.efforts))) throw new Error("invalid Codex catalog/fallback");
  if (JSON.stringify(await invoke("agent_models", { agent: "codex", refresh: false })) !== JSON.stringify(codex)) throw new Error("catalog not cached");
  await withSettings({ extraModelsCodex: ["orbit-e2e-custom-model"] }, async () => {
    await js(`location.reload()`);
    await sleep(1500);
    await waitFor("sidebar after reload", `return !!document.querySelector('aside')`, 15_000);
    await openSettingsView();
    await waitFor("catalog labels and extra model in default picker", `
      const options = [...(document.querySelector('select[aria-label="Default codex model"]')?.options ?? [])];
      return options.some(o => o.value === 'orbit-e2e-custom-model') &&
        ${JSON.stringify(codex)}.every(m => options.some(o => o.value === m.id && o.text === m.label));`, 15_000);
    await waitFor("refresh models action ready", `return [...document.querySelectorAll('#settings-agents button')].some(b => b.innerText === 'Refresh models' && !b.disabled)`, 15_000);
    await js(`document.querySelector('#settings-agents').scrollIntoView(); [...document.querySelectorAll('#settings-agents button')].find(b => b.innerText === 'Refresh models').click()`);
    await waitFor("model refresh finished", `return [...document.querySelectorAll('#settings-agents button')].some(b => b.innerText === 'Refresh models' && !b.disabled)`, 15_000);
    await closeSettingsView();
    await key("p", { ctrl: true, shift: true });
    await waitFor("refresh palette action", `return [...document.querySelectorAll('[cmdk-item]')].some(el => el.innerText.includes('Refresh model lists'))`, 5000);
    await js(`[...document.querySelectorAll('[cmdk-item]')].find(el => el.innerText.includes('Refresh model lists')).click()`);
    await waitFor("palette closed", `return !document.querySelector('[cmdk-root]')`, 5000);
  });
  await js(`location.reload()`);
    await sleep(1500);
    await waitFor("sidebar after reload", `return !!document.querySelector('aside')`, 15_000);
});

await step("settings-branch-prefix", async () => {
  // The prefix from Settings > General names the branch of the next workspace (no agent turn needed).
  await withSettings({ branchPrefix: "e2e-pre/" }, async () => {
    const ws = await mkWs("prefix check");
    if (!ws.branch.startsWith("e2e-pre/")) throw new Error(`branch ${ws.branch} does not start with the configured prefix`);
    if (gitIn(ws.path, "rev-parse", "--abbrev-ref", "HEAD") !== ws.branch) throw new Error("worktree is not on the prefixed branch");
  });
  const plain = await mkWs("prefix restored");
  if (plain.branch.startsWith("e2e-pre/")) throw new Error(`prefix was not restored: ${plain.branch}`);
});

await step("roles-opt-in", async () => {
  // Roles are opt-in: New workspace starts with no role, Settings > General can name a default,
  // and the chat footer can remove a role (no agent turn needed).
  if ((await invoke("get_settings")).defaultProfile !== "") throw new Error("default role is not empty");
  const NEW_WS = `return !!document.querySelector('textarea[placeholder^="Describe the task"]')`;
  const openNew = async () => {
    if (await js(`return !!document.querySelector('[data-code-view]')`)) await key("1", { alt: true });
    await js(`document.activeElement?.blur()`);
    await key("n", { ctrl: true });
    await waitFor("new workspace dialog", NEW_WS, 5000);
  };
  const closeNew = async () => {
    await key("Escape");
    await waitFor("new workspace dialog closed", `return !document.querySelector('textarea[placeholder^="Describe the task"]')`, 5000);
  };
  await openNew();
  if (!(await js(`return !!document.querySelector('[data-testid=profile-change]') && !document.querySelector('button[data-profile]')`))) {
    throw new Error("New workspace does not start with no role behind + Add role");
  }
  await closeNew();

  const planner = (await invoke("list_profiles")).find((p) => p.id === "shipkit:planner");
  const before = await invoke("get_settings");
  try {
    await openSettingsView();
    await waitFor("Default role picker", `return !!document.querySelector('select[aria-label="Default role"]')`, 5000);
    await js(`
      const sel = document.querySelector('select[aria-label="Default role"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'shipkit:planner');
      sel.dispatchEvent(new Event('change', { bubbles: true }));`);
    await until("default role saved", async () => (await invoke("get_settings")).defaultProfile === "shipkit:planner", 5000, 250);
    await closeSettingsView();
    await openNew();
    await waitFor("Planner pre-selected", `return !document.querySelector('[data-testid=profile-change]') && document.body.innerText.includes(${JSON.stringify(planner.description)})`, 5000);
    await closeNew();
  } finally {
    await invoke("update_settings", { patch: { defaultProfile: before.defaultProfile } });
    await js(`location.reload()`);
    await sleep(1500);
    await waitFor("sidebar after reload", `return !!document.querySelector('aside')`, 15_000);
  }

  // The profiles step left its workspace on Builder; "No role" in the footer clears it.
  const planWs = (await invoke("list_workspaces")).find((w) => w.name.includes("PLAN_TEST.md"));
  if (!planWs) throw new Error("needs the full suite (the profiles step's workspace)");
  await selectWsInSidebar(planWs.name);
  await js(`document.querySelector('button[data-profile-trigger]').click()`);
  await waitFor("No role option", `return !!document.querySelector('button[data-profile=""]')`, 5000);
  await js(`document.querySelector('button[data-profile=""]').click()`);
  await waitFor("footer shows No role", `return [...document.querySelectorAll('button[data-profile-trigger]')].some(b => b.innerText.includes('No role'))`, 5000);
  const cleared = (await invoke("list_workspaces")).find((w) => w.id === planWs.id);
  if (cleared.profile) throw new Error(`profile not cleared: ${cleared.profile}`);
});

await step("agent-plan", async () => {
  // The agent's own todo list is pinned above the chat as a plan card and kept by latest_plan.
  const ws = await newWorkspace({
    agent: "claude", model: "haiku",
    prompt: "Use your todo list tool to plan three steps for saying hello, mark them all done, then reply done.",
  });
  await waitFor("turn completed", `${turnEnds} >= 1`, 120_000);
  const plan = await invoke("latest_plan", { workspaceId: ws.id });
  if (!plan || plan.items.length < 1) throw new Error(`no plan recorded: ${JSON.stringify(plan)}`);
  await waitFor("plan card", `return !!document.querySelector('[data-testid=plan-card]') && /Plan · \d+\/\d+/.test(document.querySelector('[data-testid=plan-card]').innerText)`, 10_000);
});

await step("best-of-n", async () => {
  // One prompt, two Claude attempts side by side; both finish, summaries land, picking A archives B.
  const repoId = (await invoke("list_repos"))[0].id;
  await h.autoConfirm(true);
  const started = await invoke("start_attempts", {
    repoId,
    prompt: "Create hello.txt containing hi.",
    attempts: [{ agent: "claude", model: "haiku" }, { agent: "claude", model: "haiku" }],
  });
  if (started.workspaceIds.length !== 2) throw new Error("expected two attempt workspaces");
  await until("both attempts summarised", async () => {
    const g = await invoke("attempt_group", { id: started.id });
    return g.attempts.length === 2 && g.attempts.every((a) => a.finished && a.summary);
  }, 240_000, 3000);
  const group = await invoke("attempt_group", { id: started.id });
  if (group.attempts.some((a) => a.summary.filesChanged < 1)) throw new Error(`an attempt changed no files: ${JSON.stringify(group.attempts.map((a) => a.summary))}`);
  const [a, b] = started.workspaceIds;
  const all = await invoke("list_workspaces");
  if (!all.find((w) => w.id === a)?.name.endsWith("A") || !all.find((w) => w.id === b)?.name.endsWith("B")) throw new Error("attempt workspaces are not named A and B");
  const picked = await invoke("pick_attempt", { groupId: started.id, workspaceId: a });
  if (picked.status !== "picked" || picked.winnerWorkspaceId !== a) throw new Error("group not marked picked");
  const after = await invoke("list_workspaces");
  if (!after.some((w) => w.id === a)) throw new Error("kept attempt disappeared");
  if (after.some((w) => w.id === b)) throw new Error("the other attempt was not archived");
});

await step("settings-accept-edits", async () => {
  // Accept edits allows file edits but denies shell commands. (A bare `echo > file` is auto-approved by the
  // Claude CLI in this mode as a "file edit", so the denied command is a node one-liner.)
  await withSettings({ claudePermissionMode: "acceptEdits" }, async () => {
    const ws = await newWorkspace({
      agent: "claude",
      model: "haiku",
      prompt:
        "Two things. 1) Use the Bash tool to run exactly: node -e \"require('fs').writeFileSync('DENIED.txt','x')\" . If that tool call is refused, do not try any other way to create that file. 2) Use the Write tool to create ALLOWED.txt containing the word ok. Then reply with one short sentence.",
    });
    await waitFor("turn completed", `${turnEnds} >= 1`, 120_000);
    if (fs.existsSync(path.join(ws.path, "DENIED.txt"))) throw new Error("Bash wrote DENIED.txt even though the mode is Accept edits");
    if (!fs.existsSync(path.join(ws.path, "ALLOWED.txt"))) throw new Error("the Write tool was blocked too: Accept edits should allow file edits");
    await until("workspace idle", async () => (await wsStatus(ws.id)) !== "running", 20_000, 500);
  });
  if ((await invoke("get_settings")).claudePermissionMode !== "bypassPermissions") throw new Error("permission mode not restored");
});

await step("context-meter-and-compact", async () => {
  // Created without a prompt: the workspace name is part of the agent's context, so it must not contain the word.
  const ws = await mkWs("memory test");
  await waitFor("sidebar row", `${DOM} return !!sidebarRow("memory test")`, 10_000);
  await selectWsInSidebar("memory test");
  await composerSend("Remember the secret word PINEAPPLE-7. Do not use tools. Reply with just: noted");
  await waitFor("first turn completed", `${turnEnds} >= 1`, 120_000);
  const meter = `return document.querySelector('[data-context-meter]')?.innerText ?? ''`;
  await waitFor("context meter shown", meter, 15_000);
  const pct = async () => Number((await js(meter)).match(/(\d+)%/)?.[1] ?? -1);
  const used = async () => (await invoke("workspace_usage", { id: ws.id })).contextTokens;
  const before = await used();
  if (!(await pct()) || !(before > 0)) throw new Error(`context meter reads ${await js(meter)} (contextTokens ${before})`);
  await shot("17-context-meter");

  // Compact: the popover button sends /compact; the turn ends and the context shrinks or at least gets re-measured.
  await js(`document.querySelector('[data-context-meter]').click()`);
  await waitFor("context popover", `return !!document.querySelector('[data-context-popover]')`, 5000);
  const endsBefore = await js(turnEnds);
  await js(`document.querySelector('[data-compact]').click()`);
  await waitFor("/compact in transcript", `return [...document.querySelectorAll('[data-user-message]')].some(e => e.innerText.includes('/compact'))`, 15_000);
  await waitFor("compact turn ended", `${turnEnds} > ${endsBefore}`, 120_000);
  await until("workspace idle after compact", async () => (await wsStatus(ws.id)) !== "running", 30_000, 500);
  const after = await used();
  console.log(`      context tokens: ${before} -> ${after}`);
  if (after === before) throw new Error(`compact did not change the context size (${before})`);

  // New session: divider, and the agent no longer knows the word.
  await js(`document.querySelector('[data-context-meter]')?.click()`);
  await waitFor("context popover", `return !!document.querySelector('[data-context-popover]')`, 5000);
  await js(`document.querySelector('[data-new-session]').click()`);
  await waitFor("session divider", `return document.body.innerText.includes('New session, context cleared')`, 10_000);
  const ends = await js(turnEnds); // the divider adds a rule of its own, so count after it appears
  await composerSend("What was the secret word I told you earlier? Do not use tools. If you do not know, reply with exactly: UNKNOWN");
  await waitFor("post-reset turn ended", `${turnEnds} > ${ends}`, 120_000);
  const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
  if (/pineapple/i.test(msg)) throw new Error(`the agent still remembers the word after New session: ${msg.slice(0, 120)}`);
});

await step("archive-and-restore", async () => {
  const ws = await mkWs("archive me");
  await waitFor("sidebar row", `${DOM} return !!sidebarRow("archive me")`, 10_000);
  await selectWsInSidebar("archive me");
  await h.autoConfirm(true);
  // UI path: palette > Archive workspace (confirm is auto-accepted).
  await key("p", { ctrl: true, shift: true });
  await waitFor("palette", `return !!document.querySelector('[cmdk-input]')`, 5000);
  await type("Archive workspace");
  await waitFor("archive item", `return [...document.querySelectorAll('[cmdk-item]')].some(i => i.innerText.includes('Archive workspace'))`, 5000);
  await key("Enter");
  await until("workspace archived", async () => !(await invoke("list_workspaces")).some((w) => w.id === ws.id), 15_000, 500);
  await waitFor("gone from sidebar", `${DOM} return !sidebarRow("archive me")`, 5000);
  if (fs.existsSync(ws.path)) throw new Error("worktree still on disk after archive");
  if (!gitIn(repo, "branch", "--list", ws.branch)) throw new Error("branch was not kept");

  // Settings > Data lists it and Restore brings it back with a worktree.
  await openSettingsView();
  await waitFor("listed under Archived workspaces", `return document.body.innerText.includes('archive me') && /archived workspaces/i.test(document.body.innerText)`, 10_000);
  await js(`document.querySelector('[data-section="data"]')?.scrollIntoView()`);
  await shot("18-archived-list");
  await js(`const row = [...document.querySelectorAll('div')].filter((d) => d.className.includes('border-b') && d.innerText.includes('archive me') && d.querySelector('button')).at(-1); [...row.querySelectorAll('button')].find((b) => /Restore/.test(b.innerText)).click()`);
  await until("restored", async () => (await invoke("list_workspaces")).some((w) => w.id === ws.id), 20_000, 500);
  if (!fs.existsSync(ws.path)) throw new Error("worktree not recreated on restore");
  if (gitIn(ws.path, "rev-parse", "--abbrev-ref", "HEAD") !== ws.branch) throw new Error("restored worktree is on the wrong branch");
  await closeSettingsView();

  // A dirty worktree is refused without force (and nothing is touched), and archived with it.
  fs.writeFileSync(path.join(ws.path, "UNSAVED.txt"), "precious\n");
  const refused = await invoke("archive_workspace", { id: ws.id, removeWorktree: true }).then(() => null, (e) => String(e));
  if (!refused?.includes("Uncommitted changes:") || !refused.includes("UNSAVED.txt")) throw new Error(`dirty archive was not refused properly: ${refused}`);
  if (!fs.existsSync(path.join(ws.path, "UNSAVED.txt")) || !(await invoke("list_workspaces")).some((w) => w.id === ws.id)) throw new Error("a refused archive still changed something");
  await invoke("archive_workspace", { id: ws.id, removeWorktree: true, force: true });
  if ((await invoke("list_workspaces")).some((w) => w.id === ws.id) || fs.existsSync(ws.path)) throw new Error("forced archive did not archive");
  await h.autoConfirm(false);
});

await step("cleanup-merged-dry-run", async () => {
  const ws = await mkWs("merged work");
  fs.writeFileSync(path.join(ws.path, "MERGED.md"), "merged\n");
  gitIn(ws.path, "add", "-A");
  gitCommit(ws.path, "feat: merged work");
  const unmerged = await mkWs("unmerged work");
  fs.writeFileSync(path.join(unmerged.path, "UNMERGED.md"), "not yet\n");
  gitIn(unmerged.path, "add", "-A");
  gitCommit(unmerged.path, "feat: unmerged work");
  gitIn(repo, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "merge", "--no-ff", "-qm", "merge merged work", ws.branch);

  const dry = await invoke("cleanup_merged_worktrees", { dryRun: true });
  const mine = dry.find((c) => c.workspaceId === ws.id);
  if (!mine || mine.branch !== ws.branch || !/Merged into main/.test(mine.reason)) throw new Error(`dry run does not list the merged workspace: ${JSON.stringify(dry)}`);
  if (dry.some((c) => c.workspaceId === unmerged.id)) throw new Error("dry run lists an unmerged workspace");
  if (!fs.existsSync(ws.path)) throw new Error("dry run removed the worktree");

  // UI path: Settings > Data > Scan lists it, Clean up (auto-confirmed) archives and removes the worktree.
  await h.autoConfirm(true);
  await openSettingsView();
  await js(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Scan').click()`);
  await waitFor("scan result lists the workspace", `return document.body.innerText.includes('merged work') && [...document.querySelectorAll('button')].some((b) => /^Clean up \\d/.test(b.innerText.trim()))`, 20_000);
  await shot("19-cleanup-scan");
  await js(`[...document.querySelectorAll('button')].find((b) => /^Clean up \\d/.test(b.innerText.trim())).click()`);
  await until("merged workspace archived", async () => !(await invoke("list_workspaces")).some((w) => w.id === ws.id), 30_000, 500);
  if (fs.existsSync(ws.path)) throw new Error("cleanup left the worktree on disk");
  if (!gitIn(repo, "branch", "--list", ws.branch)) throw new Error("cleanup deleted the branch");
  if (!(await invoke("list_workspaces")).some((w) => w.id === unmerged.id) || !fs.existsSync(unmerged.path)) throw new Error("cleanup touched the unmerged workspace");
  await closeSettingsView();
  await h.autoConfirm(false);
});

await step("environment-diagnostics", async () => {
  const info = await invoke("environment_info");
  if (!info.claude.ok || !info.claude.path || !info.claude.version) throw new Error(`claude not verified: ${JSON.stringify(info.claude)}`);
  if (!info.codex.path || !info.codex.version) throw new Error(`codex not verified: ${JSON.stringify(info.codex)}`);
  await openSettingsView();
  await js(`document.querySelector('[data-section="agents"]')?.scrollIntoView()`);
  const rows = `const rows = [...document.querySelectorAll('div.border-b')].filter((d) => /^(Claude Code|Codex)\\n/.test(d.innerText.trim()));`;
  await waitFor("diagnostic rows with paths", `${rows} return rows.length === 2 && rows.every((r) => /\\.(exe|cmd)|[\\\\/]/.test(r.innerText))`, 30_000).catch(async (e) => {
    throw new Error(`${e.message}; rows: ${await js(`${rows} return JSON.stringify(rows.map((r) => r.innerText))`)}`);
  });
  const txt = await js(`${rows} return rows.map((r) => r.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
  if (!/Claude Code v\d/.test(txt) || !/Codex v\d/.test(txt)) throw new Error(`diagnostics rows read: ${txt}`);
  if (txt.includes("Not found") || txt.includes("Not verified")) throw new Error(`diagnostics rows read: ${txt}`);
  await shot("20-diagnostics");
  await closeSettingsView();
});

await step("usage-report", async () => {
  let report = await invoke("usage_report", { sinceMs: null });
  if (!report.totals.turns) {
    await newWorkspace({ agent: "claude", model: "haiku", prompt: "Reply with the single word ok. Do not use tools." });
    await waitFor("turn completed", `${turnEnds} >= 1`, 120_000);
    report = await invoke("usage_report", { sinceMs: null });
  }
  if (!report.totals.turns || !(report.totals.outputTokens > 0)) throw new Error(`usage report is empty: ${JSON.stringify(report.totals)}`);
  await openSettingsView();
  await js(`document.querySelector('[data-section="usage"]')?.scrollIntoView()`);
  await waitFor("usage section", `return !!document.querySelector('[data-usage-section]')`, 10_000);
  await js(`[...document.querySelectorAll('[data-usage-section] [role=tab]')].find((t) => t.innerText.trim() === 'All').click()`);
  const stat = (label) => js(`return document.querySelector('[data-usage-section]').innerText.match(new RegExp(${JSON.stringify(label)} + '\\\\s+(\\\\S+)', 'i'))?.[1] ?? ''`);
  await until("non-zero totals shown", async () => {
    const [tokens, turns] = [await stat("Tokens"), await stat("Turns")];
    return tokens && tokens !== "0" && Number(turns) > 0;
  }, 10_000, 500);
  await shot("21-usage");
  await closeSettingsView();
});

await step("plan-limits", async () => {
  // Follows usage-report, which has run a Claude turn; limits arrive with that turn's stream.
  let limits = [];
  await until("claude rate limits reported", async () => {
    limits = await invoke("get_rate_limits");
    return limits.some((l) => l.agent === "claude" && l.windows.length > 0);
  }, 20_000, 1000);
  await openSettingsView();
  await js(`document.querySelector('[data-section="usage"]')?.scrollIntoView()`);
  await waitFor("plan limits block", `return !!document.querySelector('[data-plan-limits]')`, 10_000);
  await waitFor("a limit window row", `return document.querySelectorAll('[data-plan-limits] [data-limit-window]').length > 0`, 10_000);
  await shot("21b-plan-limits");
  await closeSettingsView();
});

await step("ui-shortcuts", async () => {
  while ((await invoke("list_workspaces")).length < 2) await mkWs(`shortcut ws ${Date.now() % 1000}`);
  await waitFor("sidebar rows", `return document.querySelectorAll('aside li button').length >= 2`, 10_000);
  const rowNames = await js(`return [...document.querySelectorAll('aside li button')].map((b) => b.innerText)`);
  const sw = `(() => { const a = [...document.querySelectorAll('aside')].find((a) => a.getBoundingClientRect().left < 5); return a ? Math.round(a.getBoundingClientRect().width) : 0; })()`;
  const sidebarW = `return ${sw}`;
  const h1 = `return document.querySelector('header h1')?.innerText ?? ''`;
  await js(`document.activeElement?.blur()`);
  if (await js(`return [...document.querySelectorAll('h1')].some((h) => h.innerText === 'Inbox')`)) await ui.workspaceView();

  // Ctrl+1 selects the first workspace in sidebar order (go to the last one first).
  await js(`[...document.querySelectorAll('aside li button')].at(-1).click()`);
  await sleep(300);
  const lastName = await js(h1);
  await key("1", { ctrl: true });
  await waitFor("first workspace selected", `return ${JSON.stringify(rowNames[0])}.includes(document.querySelector('header h1')?.innerText ?? '@@')`, 5000);
  if (rowNames.length > 1 && rowNames[0].includes(lastName)) throw new Error("test needs two distinct workspaces");

  // Palette offers Archive workspace while one is selected.
  await key("p", { ctrl: true, shift: true });
  await waitFor("palette", `return !!document.querySelector('[cmdk-input]')`, 5000);
  await type("Archive workspace");
  await waitFor("Archive workspace item", `return [...document.querySelectorAll('[cmdk-item]')].some(i => i.innerText.includes('Archive workspace'))`, 5000);
  await key("Escape");
  await waitFor("palette closed", `return !document.querySelector('[cmdk-input]')`, 5000);

  // Focus mode (Ctrl+K Z) hides the sidebar; again restores it.
  const full = await js(sidebarW);
  if (full < 150) throw new Error(`expected an expanded sidebar, width ${full}`);
  await chord(["k", { ctrl: true }], ["z", {}]);
  await waitFor("sidebar hidden in focus mode", `return ${sw} === 0`, 5000).catch(async () => {
    throw new Error(`focus mode left a sidebar of width ${await js(sidebarW)}`);
  });
  await chord(["k", { ctrl: true }], ["z", {}]);
  await waitFor("sidebar back", `return ${sw} >= 150`, 5000);

  // Ctrl+B collapses the sidebar to a rail and back.
  await key("b", { ctrl: true });
  await waitFor("sidebar rail", `return ${sw} > 0 && ${sw} < 80`, 5000).catch(async () => {
    throw new Error(`Ctrl+B left sidebar width ${await js(sidebarW)}`);
  });
  await key("b", { ctrl: true });
  await waitFor("sidebar expanded again", `return ${sw} >= 150`, 5000);

  // Ctrl+Shift+I is WebView2's DevTools shortcut, so it must not open the Inbox.
  await key("i", { ctrl: true, shift: true });
  await sleep(500);
  if (await js(`return [...document.querySelectorAll('h1')].some((h) => h.innerText === 'Inbox')`)) throw new Error("Ctrl+Shift+I opened the Inbox");
  await key("1", { alt: true });
  await waitFor("Alt+1 opens the Inbox", `return [...document.querySelectorAll('h1')].some((h) => h.innerText === 'Inbox')`, 5000);
  await ui.workspaceView();
});

/** Waits until the workspace's status is idle (a turn or queued message may still be running). */
const settled = (id, ms = 180_000) => until("workspace not running", async () => (await wsStatus(id)) !== "running", ms, 1000);

await step("claude-midturn-queue", async () => {
  // The first message keeps the agent busy for ~8 s inside a tool call; the second arrives while it runs.
  const ws = await newWorkspace({ agent: "claude", model: "haiku", prompt: `Use the Bash tool to run exactly: node -e "setTimeout(()=>{},8000)" and then reply with the single word: first` });
  await until("turn running", async () => (await wsStatus(ws.id)) === "running", 30_000, 200);
  await composerSend("Then reply with exactly the word: finished");
  if ((await wsStatus(ws.id)) !== "running") throw new Error("the first turn ended before the second message was sent; not a mid-turn test");
  await waitFor("both user messages shown", `${DOM} const u = userBlocks(); return u.some(t => t.includes('setTimeout')) && u.some(t => t.includes('exactly the word: finished'))`, 15_000);
  await waitFor("the second message is answered", `return /finished/i.test([...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? '')`, 180_000);
  await settled(ws.id, 60_000);
  const blocks = await js(`return [...document.querySelectorAll('[data-user-message], .prose-chat')].map((e) => e.hasAttribute('data-user-message') ? 'U' : 'A').join('')`);
  if (!/U.*U.*A/.test(blocks)) throw new Error(`transcript order unexpected: ${blocks}`);
});

await step("codex-steer", async () => {
  const ws = await newWorkspace({ agent: "codex", prompt: "Count from 1 to 40, one number per line. Do not run any commands." });
  await waitFor("codex turn running", `return !!document.querySelector('.streaming-caret') || !!document.querySelector('.dither-march') || !!document.querySelector('header .dither-sweep')`, 60_000);
  await composerSend("Also end your reply with the word: steered");
  if ((await wsStatus(ws.id)) !== "running") throw new Error("the turn ended before the steer was sent; not a mid-turn test");
  await waitFor("steer message shown", `${DOM} return userBlocks().some(t => t.includes('end your reply with the word: steered'))`, 15_000);
  await settled(ws.id, 180_000);
  const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
  if (!msg.trim()) throw new Error("no reply after the steer");
  console.log(`      (codex reply ends: ${JSON.stringify(msg.trim().slice(-40))})`);
});

// ── Batch 2: packs, skills, attachments, routines, trunk gates, undo, teammates, Chief ──────
const PACK_URL = "https://orbit-e2e.test/e2e-pack"; // rewritten to the local source repo by GIT_CONFIG (see the top of this file)
const packSrc = path.join(scratch, "packsrc", "e2e-pack");
const makePackSource = () => {
  fs.rmSync(packSrc, { recursive: true, force: true });
  fs.mkdirSync(path.join(packSrc, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(packSrc, "commands"), { recursive: true });
  fs.writeFileSync(path.join(packSrc, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "e2epack", version: "0.0.1", description: "Throwaway pack for the e2e" }, null, 2) + "\n");
  fs.writeFileSync(path.join(packSrc, "commands", "hello.md"), "---\ndescription: Say hello, nothing else.\n---\n\nReply with exactly the word: hello. Do not use tools or edit files.\n");
  gitIn(packSrc, "init", "-q", "-b", "main");
  gitIn(packSrc, "add", "-A");
  gitCommit(packSrc, "init pack");
};
const reloadUi = async () => {
  await js(`location.reload()`);
  await sleep(1500);
  await waitFor("sidebar after reload", `return !!document.querySelector('aside')`, 15_000);
};
const hasSkill = async (id) => (await invoke("list_skills")).some((s) => s.id === id);
const removePackQuietly = async () => {
  await invoke("remove_pack", { name: "e2e-pack" }).catch(() => {});
  await invoke("set_pack_enabled", { name: "e2e-pack", enabled: true }).catch(() => {});
};
/** Installs the throwaway pack (through the git URL rewrite), reloads the UI so its skill store is fresh, runs fn, then removes the pack. */
const withPack = async (fn) => {
  await removePackQuietly();
  makePackSource();
  await invoke("install_pack", { url: PACK_URL });
  await reloadUi();
  try {
    return await fn();
  } finally {
    await removePackQuietly();
    await h.autoConfirm(false);
  }
};
const openPacksDialog = async () => {
  await key("p", { ctrl: true, shift: true });
  await waitFor("palette", `return !!document.querySelector('[cmdk-input]')`, 5000);
  await type("Manage skill packs");
  await key("Enter");
  await waitFor("packs dialog", `return document.body.innerText.includes('Skill packs')`, 5000);
};
const closePacksDialog = async () => {
  await js(`document.querySelector('.fixed.inset-0')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await waitFor("packs dialog closed", `return !document.body.innerText.includes('Install a pack from git')`, 5000);
};
const packRow = `[...document.querySelectorAll('section div.rounded-\\\\[4px\\\\]')].find((d) => d.innerText.includes('e2e-pack') && d.querySelector('[role=switch]'))`;
const setComposer = async (text) => {
  await js(`const t = document.querySelector('textarea[placeholder*="Claude"], textarea[placeholder*="Codex"]'); t.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true }))`);
};
const autocompleteHas = (id) => js(`return [...document.querySelectorAll('ul li button')].some((b) => b.innerText.includes(${JSON.stringify("/" + id)}))`);
const paletteRun = async (text, itemText) => {
  await key("p", { ctrl: true, shift: true });
  await waitFor("palette", `return !!document.querySelector('[cmdk-input]')`, 5000);
  await type(text);
  await waitFor("palette item", `return [...document.querySelectorAll('[cmdk-item]')].some((i) => i.innerText.includes(${JSON.stringify(itemText)}))`, 5000);
  await key("Enter");
};
const throwaway = (name) =>
  invoke("save_teammate", {
    input: { name, avatar: "", description: "Throwaway teammate that replies with the one word it is told to. Never edits files.", agent: "claude", model: "haiku", profile: null, repos: [], instructions: "Answer in one word. Never edit files." },
  });
const RUN_DONE = (r) => r && r.status !== "running";
const lastRun = async (routineId) => (await invoke("routine_runs", { routineId, limit: 1 }))[0];

await step("packs-install-lifecycle", async () => {
  // Install only accepts https:// or git@, so the URL below is rewritten to a local repo by git's own insteadOf.
  await removePackQuietly();
  makePackSource();
  const ws = await mkWs("pack ws");
  await waitFor("sidebar row", `${DOM} return !!sidebarRow("pack ws")`, 10_000);
  await selectWsInSidebar("pack ws");
  await h.autoConfirm(true);
  try {
    // Install through the Skill packs dialog.
    await openPacksDialog();
    await js(`document.querySelector('input[placeholder^="https://github.com"]').focus()`);
    await type(PACK_URL);
    await js(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Add').click()`);
    await waitFor("pack listed with its command", `return !!(${packRow}) && /\\/e2epack:/.test((${packRow}).innerText) && document.body.innerText.includes('/e2epack:hello')`, 30_000);
    if (!(await hasSkill("e2epack:hello"))) throw new Error("skill not listed by list_skills");
    const pack = (await invoke("list_packs")).find((p) => p.name === "e2e-pack");
    if (!pack || pack.plugin !== "e2epack" || pack.commandCount !== 1 || !pack.enabled) throw new Error(`bad pack: ${JSON.stringify(pack)}`);
    await shot("22-pack-installed");
    await closePacksDialog();
    await setComposer("/e2epack");
    await waitFor("autocomplete offers the pack's command", `return [...document.querySelectorAll('ul li button')].some((b) => b.innerText.includes('/e2epack:hello'))`, 5000);

    // Disable: the skill leaves the list and the autocomplete.
    await setComposer("");
    await openPacksDialog();
    await js(`(${packRow}).querySelector('[role=switch]').click()`);
    await until("pack disabled", async () => (await invoke("list_packs")).find((p) => p.name === "e2e-pack")?.enabled === false, 10_000, 300);
    if (await hasSkill("e2epack:hello")) throw new Error("a disabled pack still lists its skill");
    await closePacksDialog();
    await setComposer("/e2epack");
    await sleep(500);
    if (await autocompleteHas("e2epack:hello")) throw new Error("autocomplete still offers a disabled pack's command");

    // Enable again.
    await setComposer("");
    await openPacksDialog();
    await js(`(${packRow}).querySelector('[role=switch]').click()`);
    await until("pack enabled", async () => (await hasSkill("e2epack:hello")), 10_000, 300);
    await closePacksDialog();
    await setComposer("/e2epack");
    await waitFor("autocomplete is back", `return [...document.querySelectorAll('ul li button')].some((b) => b.innerText.includes('/e2epack:hello'))`, 5000);
    await setComposer("");

    // Update pulls a new command from the source repo.
    fs.writeFileSync(path.join(packSrc, "commands", "bye.md"), "---\ndescription: Say bye.\n---\n\nReply with exactly the word: bye.\n");
    gitIn(packSrc, "add", "-A");
    gitCommit(packSrc, "add bye");
    await openPacksDialog();
    await js(`(${packRow}).querySelector('button[title^="Update"]').click()`);
    await until("update pulled the new command", async () => hasSkill("e2epack:bye"), 20_000, 500);
    await waitFor("new command in the dialog", `return document.body.innerText.includes('/e2epack:bye')`, 5000);

    // Remove deletes the folder and the skills.
    await js(`(${packRow}).querySelector('button[title="Remove pack"]').click()`);
    await until("pack removed", async () => !(await invoke("list_packs")).some((p) => p.name === "e2e-pack"), 10_000, 300);
    if (fs.existsSync(path.join(h.home, "packs", "e2e-pack"))) throw new Error("pack folder still on disk");
    if (await hasSkill("e2epack:hello")) throw new Error("removed pack still lists its skill");
    await closePacksDialog();
  } finally {
    await removePackQuietly();
    await h.autoConfirm(false);
  }
});

await step("workspace-pack-toggles", async () => {
  await withPack(async () => {
    const ws = await mkWs("pack switch claude");
    const other = await mkWs("pack switch codex", { agent: "codex", model: null });
    const pins = await invoke("get_pins");
    try {
      await invoke("set_pins", { pins: [...pins, "e2epack:hello"] });
      await reloadUi();
      await selectWsInSidebar("pack switch claude");
      await paletteRun("Skill packs for this workspace", "Skill packs for this workspace");
      const toggle = `document.querySelector('[role="switch"][aria-label="Enable e2e-pack in this workspace"]')`;
      await waitFor("workspace switch", `return !!(${toggle})`, 5000);
      await js(`(${toggle}).click()`);
      await until("workspace override saved", async () => (await invoke("list_workspaces")).find((w) => w.id === ws.id)?.disabledPacks.includes("e2e-pack"), 5000, 100);
      if (!(await hasSkill("e2epack:hello"))) throw new Error("workspace toggle changed global skills");
      await closePacksDialog();
      await setComposer("/e2epack");
      await sleep(300);
      if (await autocompleteHas("e2epack:hello")) throw new Error("workspace-disabled skill in autocomplete");
      if (await js(`return [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'HELLO')`)) throw new Error("workspace-disabled pinned chip visible");
      await setComposer("");
      await key("p", { ctrl: true, shift: true });
      await type("e2epack:hello");
      await sleep(300);
      if (await js(`return [...document.querySelectorAll('[cmdk-item]')].some((i) => i.innerText.includes('/e2epack:hello'))`)) throw new Error("workspace-disabled palette skill visible");
      await key("Escape");
      let rejected = false;
      try { await invoke("run_skill", { id: ws.id, skillId: "e2epack:hello", args: "" }); }
      catch (e) { rejected = String(e).includes("disabled"); }
      if (!rejected) throw new Error("disabled Claude skill was not rejected");
      await selectWsInSidebar("pack switch codex");
      await setComposer("/e2epack");
      await waitFor("other workspace still offers skill", `return [...document.querySelectorAll('ul li button')].some((b) => b.innerText.includes('/e2epack:hello'))`, 5000);
      await setComposer("");
      await invoke("set_workspace_packs", { id: other.id, disabled: ["e2e-pack", "shipkit"] });
      if ((await invoke("list_profiles", { workspaceId: other.id })).some((p) => p.pack === "shipkit")) throw new Error("workspace-disabled profiles offered");
      rejected = false;
      try { await invoke("run_skill", { id: other.id, skillId: "e2epack:hello", args: "" }); }
      catch (e) { rejected = String(e).includes("disabled"); }
      if (!rejected) throw new Error("disabled Codex skill was not rejected");
      await invoke("set_pack_enabled", { name: "e2e-pack", enabled: false });
      await invoke("set_workspace_packs", { id: other.id, disabled: [] });
      if (await hasSkill("e2epack:hello")) throw new Error("workspace override enabled a globally disabled pack");
      await invoke("set_pack_enabled", { name: "e2e-pack", enabled: true });
      await selectWsInSidebar("pack switch claude");
      await openPacksDialog();
      await js(`(${toggle}).click()`);
      await until("workspace override cleared", async () => (await invoke("list_workspaces")).find((w) => w.id === ws.id)?.disabledPacks.length === 0, 5000, 100);
      await closePacksDialog();
      await setComposer("/e2epack");
      await waitFor("workspace autocomplete restored", `return [...document.querySelectorAll('ul li button')].some((b) => b.innerText.includes('/e2epack:hello'))`, 5000);
      await setComposer("");
    } finally {
      await invoke("set_pins", { pins });
      await invoke("set_workspace_packs", { id: ws.id, disabled: [] });
      await invoke("set_workspace_packs", { id: other.id, disabled: [] });
    }
  });
});

await step("pins-and-palette-skill", async () => {
  await withPack(async () => {
    await mkWs("pins ws");
    await waitFor("sidebar row", `${DOM} return !!sidebarRow("pins ws")`, 10_000);
    await selectWsInSidebar("pins ws");
    const chip = `return [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'HELLO')`;
    const pinButton = async (title) => {
      await openPacksDialog();
      await js(`document.querySelector('section input[placeholder^="Search"]').focus()`);
      await type("e2epack:hello");
      await waitFor("skill row", `return [...document.querySelectorAll('li.group')].some((l) => l.innerText.includes('/e2epack:hello'))`, 5000);
      await js(`[...document.querySelectorAll('li.group')].find((l) => l.innerText.includes('/e2epack:hello')).querySelector('button[title=${JSON.stringify(title)}]').click()`);
      await sleep(300);
      await closePacksDialog();
    };
    if (await js(chip)) throw new Error("the skill is pinned before the test pins it");
    await pinButton("Pin to composer");
    await waitFor("chip appears", chip, 5000);
    if (!(await invoke("get_pins")).includes("e2epack:hello")) throw new Error("pin not stored");
    await shot("23-pinned-chip");
    await pinButton("Unpin from composer");
    await waitFor("chip disappears", `return !(await (async () => { ${chip} })())`, 5000);
    if ((await invoke("get_pins")).includes("e2epack:hello")) throw new Error("unpin not stored");

    // Run it from the palette (no preview there: it sends at once).
    await paletteRun("/e2epack:hello", "/e2epack:hello");
    await waitFor("skill in transcript", `return [...document.querySelectorAll('[data-user-message]')].some((e) => e.innerText.includes('/e2epack:hello'))`, 15_000);
    await waitFor("turn ended", `${turnEnds} >= 1`, 120_000);
    const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
    if (!/hello/i.test(msg)) throw new Error(`skill answered: ${msg.slice(0, 120)}`);
  });
});

await step("codex-inlined-skill", async () => {
  await withPack(async () => {
    const ws = await mkWs("codex skill ws", { agent: "codex", model: null });
    await waitFor("sidebar row", `${DOM} return !!sidebarRow("codex skill ws")`, 10_000);
    await selectWsInSidebar("codex skill ws");
    await paletteRun("/e2epack:hello", "/e2epack:hello");
    await waitFor("skill in transcript", `return [...document.querySelectorAll('[data-user-message]')].some((e) => e.innerText.includes('/e2epack:hello'))`, 15_000);
    await waitFor("codex turn ended", `${turnEnds} >= 1`, 180_000);
    const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
    // Codex can't load foreign skills, so Orbit inlined the body: it answered with the word the command asked for.
    if (!/hello/i.test(msg)) throw new Error(`codex answered: ${msg.slice(0, 120)}`);
    await settled(ws.id, 60_000);
  });
});

await step("always-attach", async () => {
  const repoId = (await invoke("list_repos"))[0].id;
  const norm = (p) => p.split("\\").join("/").replace(/^\/\/\?\//, "").toLowerCase();
  await invoke("set_related_default", { repoId, path: consumer, enabled: true });
  try {
    if (!(await invoke("get_related_defaults", { repoId })).some((p) => norm(p).endsWith("/consumer"))) throw new Error("default not stored");
    const ws = await mkWs("attach defaults");
    const atts = await invoke("list_attachments", { workspaceId: ws.id });
    if (!atts.some((a) => norm(a.path).endsWith("/consumer"))) throw new Error(`new workspace has no attached folder: ${JSON.stringify(atts)}`);
    await waitFor("sidebar row", `${DOM} return !!sidebarRow("attach defaults")`, 10_000);
    await selectWsInSidebar("attach defaults");
    await waitFor("attachment shown", `return document.body.innerText.toLowerCase().includes('consumer')`, 10_000);
  } finally {
    await invoke("set_related_default", { repoId, path: consumer, enabled: false });
  }
  const plain = await mkWs("attach none");
  if ((await invoke("list_attachments", { workspaceId: plain.id })).length) throw new Error("a workspace created after disabling still got the folder");
});

await step("routine-scheduler-tick", async () => {
  // A one-off ~30-90 s out; the 30 s tick picks it up and runs it without any "Run now".
  const repoId = (await invoke("list_repos"))[0].id;
  const t = new Date(Math.ceil((Date.now() + 30_000) / 60_000) * 60_000);
  const p2 = (n) => String(n).padStart(2, "0");
  const at = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}T${p2(t.getHours())}:${p2(t.getMinutes())}`;
  const routine = await invoke("save_routine", {
    input: { repoId, name: "e2e tick", schedule: { kind: "once", at }, action: { kind: "prompt", text: "Reply with exactly one word: tick" }, agent: "claude", model: "haiku", mode: "fresh", enabled: true },
  });
  try {
    if (!routine.nextRunAt) throw new Error(`no next run: ${JSON.stringify(routine)}`);
    const run = await until("scheduled run finished", async () => {
      const r = await lastRun(routine.id);
      return RUN_DONE(r) ? r : null;
    }, 200_000, 3000);
    if (!["done", "quiet"].includes(run.status)) throw new Error(`scheduled run ended as ${run.status}: ${run.summary}`);
    // The first row may still flip done -> quiet, but the run happened by itself and the one-off switched itself off.
    const after = (await invoke("list_routines")).find((r) => r.id === routine.id);
    if (after?.enabled) throw new Error("a once routine should switch itself off after running");
  } finally {
    await invoke("delete_routine", { id: routine.id });
  }
});

await step("routine-standing-workspace", async () => {
  const repoId = (await invoke("list_repos"))[0].id;
  const routine = await invoke("save_routine", {
    input: { repoId, name: "e2e standing", schedule: { kind: "daily", time: "03:00" }, action: { kind: "prompt", text: "Reply with exactly one word: stand" }, agent: "claude", model: "haiku", mode: "standing", enabled: true },
  });
  try {
    await invoke("run_routine_now", { id: routine.id });
    const first = await until("first run finished", async () => {
      const r = await lastRun(routine.id);
      return RUN_DONE(r) ? r : null;
    }, 180_000, 2000);
    if (!first.workspaceId) throw new Error(`first run has no workspace: ${JSON.stringify(first)}`);
    await sleep(2000); // let the quiet check settle
    await invoke("run_routine_now", { id: routine.id });
    const second = await until("second run finished", async () => {
      const [r] = await invoke("routine_runs", { routineId: routine.id, limit: 1 });
      return r && r.id !== first.id && RUN_DONE(r) ? r : null;
    }, 180_000, 2000);
    if (second.workspaceId !== first.workspaceId) throw new Error(`standing routine used two workspaces: ${first.workspaceId} then ${second.workspaceId}`);
    const live = (await invoke("list_workspaces")).filter((w) => w.routineId === routine.id);
    if (live.length !== 1 || live[0].id !== first.workspaceId) throw new Error(`expected one standing workspace, got ${JSON.stringify(live.map((w) => w.name))}`);
  } finally {
    await invoke("delete_routine", { id: routine.id });
  }
});

await step("routine-owned-by-teammate", async () => {
  const repoId = (await invoke("list_repos"))[0].id;
  const t = await throwaway("E2E Owner");
  const routine = await invoke("save_routine", {
    input: {
      repoId, name: "e2e owned", schedule: { kind: "daily", time: "03:00" }, agent: "claude", model: "haiku", mode: "fresh", enabled: true, teammate: t.slug,
      action: { kind: "prompt", text: "Reply with exactly the word: ready. That is the whole task and it is complete once you reply; nothing is needed from anyone. Do not edit files." },
    },
  });
  try {
    await invoke("run_routine_now", { id: routine.id });
    const report = await until("owner's report", async () => (await invoke("teammate_thread", { slug: t.slug, limit: 50 })).find((m) => m.kind === "task_report" || m.kind === "error") ?? null, 180_000, 2000);
    if (report.kind !== "task_report") throw new Error(`owned run failed: ${report.text}`);
    const [task] = await invoke("teammate_tasks", { slug: t.slug });
    if (task.originKind !== "routine" || task.originRef !== "e2e owned") throw new Error(`task is not marked as scheduled: ${JSON.stringify(task)}`);
    const run = await lastRun(routine.id);
    if (run.workspaceId !== task.workspaceId) throw new Error("the routine run and the teammate task use different workspaces");
    await ensureTeammates();
    await waitFor("teammates view", `return !!document.querySelector('[data-teammates] [data-teammate="${t.slug}"]')`, 5000);
    await js(`document.querySelector('[data-teammates] [data-teammate="${t.slug}"]').click()`);
    await waitFor("Scheduled label in the thread", `const th = document.querySelector('[data-teammate-thread="${t.slug}"]'); return !!th && /Scheduled/.test(th.innerText) && /ready/i.test(th.innerText)`, 10_000);
    await shot("24-owned-routine");
  } finally {
    await invoke("delete_routine", { id: routine.id });
    await invoke("delete_teammate", { slug: t.slug });
    await js(`location.reload()`);
    await sleep(1500);
  }
});

await step("trunk-warn-and-ship-anyway", async () => {
  // Warn mode: a failing check does not stop Ship, but flags the workspace and the inbox offers Ship anyway.
  const repoId = (await invoke("list_repos"))[0].id;
  // One real (cheap) turn: the inbox only lists workspaces that have had activity.
  const ws = await newWorkspace({ agent: "claude", model: "haiku", prompt: "Reply with the single word warn. Do not use tools. Do not edit files." });
  await waitFor("turn completed", `${turnEnds} >= 1`, 120_000);
  await until("turn settled", async () => (await wsStatus(ws.id)) !== "running", 30_000, 500);
  await invoke("set_check_command", { repoId, cmd: "exit 1" });
  try {
    await withSettings({ checksMode: "warn" }, async () => {
      const res = await invoke("prepare_ship", { workspaceId: ws.id, skipChecks: false });
      if (!res.ok || res.checks?.ok !== false) throw new Error(`warn mode should proceed with a failed check: ${JSON.stringify(res)}`);
      if (!(await invoke("list_workspaces")).find((w) => w.id === ws.id).checksFailed) throw new Error("checksFailed not set");
      const wsKey = JSON.stringify(ws.name.slice(0, 20));
      await ensureInbox();
      await waitFor("inbox row with Ship anyway", `${INBOX_JS} const li = rows().find((li) => li.innerText.includes(${wsKey})); return !!li && /Ship anyway/.test(li.innerText)`, 15_000);
      await shot("25-ship-anyway");
      // Shipping anyway (the gate only: no remote, so no ship turn) clears the flag and the row.
      const anyway = await invoke("prepare_ship", { workspaceId: ws.id, skipChecks: true });
      if (!anyway.ok) throw new Error(`skip-checks did not proceed: ${JSON.stringify(anyway)}`);
      await waitFor("flag cleared", `const w = (await window.__TAURI_INTERNALS__.invoke("list_workspaces")).find((w) => w.id === ${JSON.stringify(ws.id)}); return !w.checksFailed`, 10_000);
      await waitFor("row has no Ship anyway", `${INBOX_JS} const li = rows().find((li) => li.innerText.includes(${wsKey})); return !li || !/Ship anyway/.test(li.innerText)`, 10_000);
      await key("1", { alt: true });
    });
  } finally {
    await invoke("set_check_command", { repoId, cmd: null });
  }
});

await step("checks-autodetect", async () => {
  const repoId = (await invoke("list_repos"))[0].id;
  const ws = await mkWs("autodetect checks");
  if ((await invoke("get_check_command", { repoId })).override) throw new Error("a check override is set; this step needs none");
  const pkgPath = path.join(ws.path, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  await withSettings({ installBeforeChecks: false, checksMode: "block" }, async () => {
    pkg.scripts = { test: `node -e "process.exit(0)"` };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    const ok = await invoke("prepare_ship", { workspaceId: ws.id, skipChecks: false });
    if (!ok.ok || !ok.checks?.ok || !/npm run test/.test(ok.checks.command ?? "")) throw new Error(`detected check did not run and pass: ${JSON.stringify(ok.checks)}`);
    // The same detection blocks when the script fails.
    pkg.scripts = { test: `node -e "process.exit(1)"` };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    const bad = await invoke("prepare_ship", { workspaceId: ws.id, skipChecks: false });
    if (bad.ok || bad.checks?.ok !== false) throw new Error(`a failing detected check did not block: ${JSON.stringify(bad.checks)}`);
    await invoke("prepare_ship", { workspaceId: ws.id, skipChecks: true }); // clears the flag
  });
});

await step("undo-last-turn", async () => {
  const ws = await newWorkspace({ agent: "claude", model: "haiku", prompt: "Create a file UNDO_TEST.md containing the word hello. Don't commit it." });
  await waitFor("turn completed", `${turnEnds} >= 1`, 120_000);
  await h.until("save-point commit", async () => gitIn(ws.path, "log", "-1", "--format=%s").startsWith("wip:") && fs.existsSync(path.join(ws.path, "UNDO_TEST.md")), 30_000, 500);
  const head = gitIn(ws.path, "rev-parse", "HEAD");
  await h.autoConfirm(true);
  await paletteRun("Undo last turn", "Undo last turn");
  await until("wip commit dropped", async () => gitIn(ws.path, "rev-parse", "HEAD") !== head && !fs.existsSync(path.join(ws.path, "UNDO_TEST.md")), 20_000, 500);
  if (gitIn(ws.path, "log", "-1", "--format=%s").startsWith("wip:")) throw new Error("a wip commit is still on top");
  if (gitIn(ws.path, "status", "--porcelain")) throw new Error("worktree left dirty after undo");
  await h.autoConfirm(false);
});

await step("teammate-crud-and-memory", async () => {
  const t = await invoke("save_teammate", { input: { name: "E2E Crud", avatar: "", description: "first", agent: "claude", model: "haiku", profile: null, repos: [], readonly: null, instructions: "Answer in one word." } });
  const file = path.join(h.home, "teammates", `${t.slug}.md`);
  try {
    if (t.slug !== "e2e-crud" || !fs.existsSync(file)) throw new Error(`custom teammate not stored: ${t.slug}`);
    // Edit.
    const edited = await invoke("save_teammate", { input: { slug: t.slug, name: "E2E Crud", avatar: "", description: "second", agent: "claude", model: "haiku", profile: null, repos: [], readonly: null, instructions: "Answer in two words." } });
    if (edited.description !== "second" || !fs.readFileSync(file, "utf8").includes("Answer in two words.")) throw new Error(`edit not saved: ${JSON.stringify(edited)}`);

    // Override a starter, then reset it to its default.
    const starters = await invoke("list_teammates");
    const starter = starters.find((x) => x.bundled && x.slug === "builder") ?? starters.find((x) => x.bundled);
    if (!starter) throw new Error("no starter teammates");
    const original = starter.description;
    const over = await invoke("save_teammate", { input: { slug: starter.slug, name: starter.name, avatar: starter.avatar, description: "edited by the e2e", agent: starter.agent, model: starter.model, profile: starter.profile, repos: starter.repos, readonly: starter.readonly ?? null, instructions: starter.instructions } });
    if (!over.overridden || over.description !== "edited by the e2e") throw new Error(`starter override not applied: ${JSON.stringify(over)}`);
    await invoke("delete_teammate", { slug: starter.slug });
    const reset = (await invoke("list_teammates")).find((x) => x.slug === starter.slug);
    if (reset.overridden || reset.description !== original) throw new Error(`starter was not reset to its default: ${JSON.stringify(reset)}`);

    // Memory tab in the editor writes the notes file on disk.
    await ensureTeammates();
    await waitFor("teammate row", `return !!document.querySelector('[data-teammates] [data-teammate="${t.slug}"]')`, 8000);
    await js(`document.querySelector('[data-teammates] [data-teammate="${t.slug}"]').click()`);
    await waitFor("thread header", `return !!document.querySelector('[data-teammate-thread="${t.slug}"]')`, 5000);
    await js(`[...document.querySelectorAll('[data-teammate-thread="${t.slug}"] header button')].find((b) => b.innerText.trim() === 'Edit').click()`);
    await waitFor("editor", `return !!document.querySelector('[data-teammate-editor]')`, 5000);
    await js(`[...document.querySelectorAll('[data-teammate-editor] button')].find((b) => b.innerText.trim() === 'Memory').click()`);
    await waitFor("memory textarea enabled", `const t = document.querySelector('[data-teammate-editor] textarea'); return !!t && !t.disabled`, 5000);
    await js(`document.querySelector('[data-teammate-editor] textarea').focus()`);
    await type("- always say PLUM-9\n");
    await js(`[...document.querySelectorAll('[data-teammate-editor] button')].find((b) => b.innerText.trim() === 'Save memory').click()`);
    const memFile = path.join(h.home, "teammates", `${t.slug}.memory.md`);
    await until("memory file written", async () => fs.existsSync(memFile) && fs.readFileSync(memFile, "utf8").includes("PLUM-9"), 8000, 300);
    if (!(await invoke("teammate_memory", { slug: t.slug })).includes("PLUM-9")) throw new Error("teammate_memory does not read the saved notes");
    await shot("26-teammate-memory");
    await js(`[...document.querySelectorAll('[data-teammate-editor] button')].find((b) => b.innerText.trim() === 'Cancel').click()`);
  } finally {
    await invoke("delete_teammate", { slug: t.slug });
  }
  if (fs.existsSync(file)) throw new Error("deleted teammate's file is still on disk");
  if ((await invoke("list_teammates")).some((x) => x.slug === t.slug)) throw new Error("deleted teammate still listed");
  await js(`location.reload()`);
  await sleep(1500);
});

await step("chief-edit-cancel", async () => {
  const [a, b] = await makePair("E2E Edit");
  await invoke("update_settings", { patch: { suggestionModel: "haiku" } });
  const sent = await invoke("teammate_send", { slug: "chief", text: `Have ${a} reply "ready" and then ${b} reply "set". Each teammate only replies with that word.`, repoId: null, newTask: null });
  if (sent.workspaceId !== null) throw new Error("Chief should not open a workspace");
  try {
    const plan = await until("Chief's plan", async () => {
      const p = (await invoke("teammate_plans", { slug: "chief" })).at(-1);
      return p && p.status !== "planning" ? p : null;
    }, 150_000, 2000);
    if (plan.status !== "proposed" || !plan.parts.length) throw new Error(`Chief could not plan: ${JSON.stringify(plan).slice(0, 300)}`);
    // Retarget: both parts to B, with a new title on the first.
    await invoke("chief_plan_edit", {
      planId: plan.id,
      plan: {
        summary: "edited summary",
        parts: [
          { teammate: b, title: "Retargeted", brief: "Reply with exactly the word: ready.", dependsOn: [] },
          { teammate: b, title: "Second", brief: "Reply with exactly the word: set.", dependsOn: [0] },
        ],
      },
    });
    const edited = (await invoke("teammate_plans", { slug: "chief" })).find((p) => p.id === plan.id);
    if (edited.summary !== "edited summary" || edited.parts[0].teammate !== b || edited.parts[0].title !== "Retargeted" || edited.status !== "proposed") throw new Error(`edit not stored: ${JSON.stringify(edited).slice(0, 300)}`);
    // An unknown teammate is refused (validation shared with the model's reply).
    const bad = await invoke("chief_plan_edit", { planId: plan.id, plan: { summary: "x", parts: [{ teammate: "no-such-person", title: "t", brief: "b", dependsOn: [] }] } }).then(() => null, (e) => String(e));
    if (!bad) throw new Error("a plan with only unknown teammates should be rejected");

    await ensureTeammates();
    await waitFor("teammates view", `return !!document.querySelector('[data-teammates] [data-teammate="chief"]')`, 5000);
    await js(`document.querySelector('[data-teammates] [data-teammate="chief"]').click()`);
    await waitFor("plan card shows the edit", `const c = document.querySelector('[data-plan="${plan.id}"]'); return !!c && c.innerText.includes('Retargeted')`, 10_000);

    // Cancel before Start: nothing runs, and the plan can no longer be started.
    await invoke("chief_plan_cancel", { planId: plan.id });
    const cancelled = (await invoke("teammate_plans", { slug: "chief" })).find((p) => p.id === plan.id);
    if (cancelled.status !== "cancelled") throw new Error(`plan status ${cancelled.status}`);
    const start = await invoke("chief_plan_start", { planId: plan.id }).then(() => null, (e) => String(e));
    if (!start) throw new Error("a cancelled plan could be started");
    await sleep(1500);
    for (const slug of [a, b]) {
      if ((await invoke("teammate_tasks", { slug })).length) throw new Error(`teammate ${slug} got a task from a cancelled plan`);
    }
    if ((await invoke("list_workspaces")).some((w) => w.teammate === a || w.teammate === b)) throw new Error("a workspace was created by a cancelled plan");
    await waitFor("card shows cancelled", `const c = document.querySelector('[data-plan="${plan.id}"]'); return !!c && /cancel/i.test(c.innerText)`, 10_000);
    await shot("27-chief-cancelled");
  } finally {
    for (const slug of [a, b]) await invoke("delete_teammate", { slug });
    await js(`location.reload()`);
    await sleep(1500);
  }
});

await step("teammate-memory-append", async () => {
  // The teammate is told to remember a code word; its context carries the memory file's path and the
  // instruction to append to it, so the word must land in the file on disk after its report.
  const word = `plum-${Date.now().toString(36)}`;
  const t = await invoke("save_teammate", {
    input: { name: "E2E Memo", avatar: "", description: "Throwaway teammate that keeps notes.", agent: "claude", model: "haiku", profile: null, repos: [], readonly: null, instructions: "Answer in one word. The only file you may edit is your own memory file." },
  });
  try {
    await invoke("teammate_send", {
      slug: t.slug,
      text: `Remember that the code word is ${word}; append it to your memory file (the path is in your context). Then reply with exactly the word: saved. That is the whole task.`,
      repoId: null,
      newTask: null,
    });
    const report = await until("teammate report", async () => (await invoke("teammate_thread", { slug: t.slug, limit: 50 })).find((m) => m.kind === "task_report" || m.kind === "error") ?? null, 180_000, 2000);
    if (report.kind !== "task_report") throw new Error(`teammate failed: ${report.text}`);
    const file = path.join(h.home, "teammates", `${t.slug}.memory.md`);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (!text.includes(word)) throw new Error(`memory file lacks the code word ${word}: ${JSON.stringify(text.slice(0, 300))}`);
  } finally {
    await invoke("delete_teammate", { slug: t.slug });
  }
});

await step("resume-after-restart", async () => {
  await quit();
  await launch();
  await cdp("Runtime.enable");
  // Not the profiles step's workspace, which is also Claude and now the most recently updated.
  const claudeWs = await needClaudeWs("resume-after-restart", (w) => w.agent === "claude" && w.name.includes("NOTES.md"));
  await waitFor("sidebar loaded", `return !!document.querySelector('aside li button')`, 15_000);
  await js(`[...document.querySelectorAll('aside li button')].find(b => b.innerText.includes(${JSON.stringify(claudeWs.name.slice(0, 20))})).click()`);
  await waitFor("history restored", `return document.querySelectorAll('.prose-chat').length >= 2`, 15_000);
  const before = await js(turnEnds);
  await composerSend("Without using tools: what file did you create earlier in this conversation? Just the filename.");
  await waitFor("resumed turn", `${turnEnds} > ${before}`, 120_000);
  const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
  if (!/NOTES\.md/i.test(msg)) throw new Error(`session not resumed; answered: ${msg.slice(0, 120)}`);
  await shot("10-resumed");
});

await step("teammates", async () => {
  // A custom teammate (Claude haiku) takes a one-line task: it creates its own workspace, the turn
  // ends, and a report lands in its thread. Runs last so its workspace cannot disturb earlier steps.
  const slug = "e2e-helper";
  const saved = await invoke("save_teammate", {
    input: { name: "E2E helper", avatar: "E", description: "Throwaway teammate for the e2e", agent: "claude", model: "haiku", profile: null, repos: [], instructions: "Answer in one word. Never edit files." },
  });
  if (saved.slug !== slug || saved.bundled) throw new Error(`bad teammate: ${JSON.stringify(saved)}`);
  const team = await invoke("list_teammates");
  if (!team.some((t) => t.slug === slug) || !team.some((t) => t.slug === "builder" && t.bundled)) throw new Error(`teammate list wrong: ${team.map((t) => t.slug)}`);
  const known = new Set((await invoke("list_workspaces")).map((w) => w.id));
  const sent = await invoke("teammate_send", { slug, text: "Reply with exactly the word: ready. That is the whole task and it is complete once you reply; nothing is needed from anyone. Do not edit files.", repoId: null, newTask: null });
  if (!sent.newTask || known.has(sent.workspaceId)) throw new Error(`expected a new task workspace: ${JSON.stringify(sent)}`);
  const report = await until("teammate report in the thread", async () => {
    const thread = await invoke("teammate_thread", { slug, limit: 50 });
    return thread.find((m) => m.kind === "task_report" || m.kind === "error") ?? null;
  }, 180_000, 2000);
  if (report.kind !== "task_report" || !/ready/i.test(report.text)) throw new Error(`bad report: ${JSON.stringify(report)}`);
  const ws = (await invoke("list_workspaces")).find((w) => w.teammate === slug);
  if (!ws || ws.id !== sent.workspaceId || ws.model !== "haiku") throw new Error(`no teammate workspace: ${JSON.stringify(ws)}`);
  const [task] = await invoke("teammate_tasks", { slug });
  if (task.workspaceId !== ws.id || !["done", "waiting"].includes(task.status)) throw new Error(`bad task: ${JSON.stringify(task)}`);
  if (!(await invoke("teammate_memory", { slug })).includes("Memory")) throw new Error("memory file was not created on first use");
  // Open the Teammates view (Alt+4), pick the teammate in the list and look at its thread.
  await ensureTeammates();
  await waitFor("teammates view", `return !!document.querySelector('[data-teammates] [data-teammate="${slug}"]')`, 5000);
  await js(`document.querySelector('[data-teammates] [data-teammate="${slug}"]').click()`);
  await waitFor("thread view with the report", `const t = document.querySelector('[data-teammate-thread="${slug}"]'); return !!t && t.innerText.toLowerCase().includes('ready')`, 10_000);
  await shot("12-teammate-thread");
  await invoke("delete_teammate", { slug });
  if ((await invoke("list_teammates")).some((t) => t.slug === slug)) throw new Error("teammate still listed after delete");
  await js(`location.reload()`);
  await sleep(1500);
});

/** Two throwaway Claude-haiku teammates for the hand-off and Chief steps. */
async function makePair(prefix) {
  const mk = (name) =>
    invoke("save_teammate", {
      input: { name, avatar: "", description: "Throwaway teammate that replies with the one word it is told to. Never edits files.", agent: "claude", model: "haiku", profile: null, repos: [], instructions: "Answer in one word. Never edit files." },
    });
  const a = await mk(`${prefix} A`);
  const b = await mk(`${prefix} B`);
  return [a.slug, b.slug];
}

await step("teammates-handoff", async () => {
  // A finishes a one-word task; its result is handed to B through the command the chips call. B's task
  // carries the hand-off brief and "from A"; A's thread shows "Handed to B".
  const [a, b] = await makePair("E2E Hand");
  await invoke("teammate_send", { slug: a, text: "Reply with exactly the word: ready. That is the whole task and it is complete once you reply; nothing is needed from anyone. Do not edit files.", repoId: null, newTask: null });
  const report = await until("A's report", async () => (await invoke("teammate_thread", { slug: a, limit: 50 })).find((m) => m.kind === "task_report" || m.kind === "error") ?? null, 180_000, 2000);
  if (report.kind !== "task_report") throw new Error(`A failed: ${report.text}`);
  const [task] = await invoke("teammate_tasks", { slug: a });
  if (!Array.isArray(task.handoffs) || !Array.isArray(task.handedTo)) throw new Error(`tasks lack hand-off fields: ${JSON.stringify(task)}`);
  const sent = await invoke("teammate_handoff", { fromTaskId: task.id, toSlug: b, note: null });
  if (!sent.newTask || !sent.workspaceId) throw new Error(`hand-off did not open a task: ${JSON.stringify(sent)}`);
  await until("B's report", async () => (await invoke("teammate_thread", { slug: b, limit: 50 })).find((m) => m.kind === "task_report" || m.kind === "error") ?? null, 180_000, 2000);
  const threadB = await invoke("teammate_thread", { slug: b, limit: 50 });
  const brief = threadB.find((m) => m.kind === "brief");
  if (!brief || !/handed this to you/i.test(brief.text) || !/ready/i.test(brief.text) || !/Branch:/.test(brief.text)) throw new Error(`bad hand-off brief: ${JSON.stringify(brief)}`);
  const [taskB] = await invoke("teammate_tasks", { slug: b });
  if (taskB.originKind !== "handoff" || taskB.parentTaskId !== task.id || taskB.originRef !== a) throw new Error(`bad task origin: ${JSON.stringify(taskB)}`);
  const after = await invoke("teammate_thread", { slug: a, limit: 50 });
  if (!after.some((m) => m.kind === "handoff" && /Handed to/.test(m.text) && m.meta === b)) throw new Error("source thread lacks the Handed to line");
  const [taskA] = await invoke("teammate_tasks", { slug: a });
  if (!taskA.handedTo.includes(b)) throw new Error(`source task does not list B: ${JSON.stringify(taskA.handedTo)}`);
  await ensureTeammates();
  await waitFor("teammates view", `return !!document.querySelector('[data-teammates] [data-teammate="${a}"]')`, 5000);
  await js(`document.querySelector('[data-teammates] [data-teammate="${a}"]').click()`);
  await waitFor("Handed to in A's thread", `const t = document.querySelector('[data-teammate-thread="${a}"]'); return !!t && t.innerText.includes('Handed to')`, 10_000);
  await shot("13-handoff");
  for (const slug of [a, b]) await invoke("delete_teammate", { slug });
});

await step("chief", async () => {
  // Chief plans a trivial request with a real (haiku) planning call; the plan's parts are then pinned to
  // two throwaway teammates (B after A) so no starter teammate runs a costly turn. Start all runs A, then B
  // with A's result in its brief, then Chief posts the combined report.
  const [a, b] = await makePair("E2E Chief");
  await invoke("update_settings", { patch: { suggestionModel: "haiku" } });
  const sent = await invoke("teammate_send", { slug: "chief", text: `Have ${a} reply "ready" and then ${b} reply "set". Each teammate only replies with that word.`, repoId: null, newTask: null });
  if (sent.workspaceId !== null) throw new Error(`Chief should not open a workspace: ${JSON.stringify(sent)}`);
  const plan = await until("Chief's plan", async () => {
    const p = (await invoke("teammate_plans", { slug: "chief" })).at(-1);
    return p && p.status !== "planning" ? p : null;
  }, 150_000, 2000);
  if (plan.status !== "proposed" || !plan.parts.length) throw new Error(`Chief could not plan: ${JSON.stringify(plan).slice(0, 400)}`);
  await invoke("chief_plan_edit", {
    planId: plan.id,
    plan: {
      summary: plan.summary,
      parts: [
        { teammate: a, title: "Say ready", brief: "Reply with exactly the word: ready. That is the whole task and it is complete once you reply; nothing is needed from anyone. Do not edit files.", dependsOn: [] },
        { teammate: b, title: "Say set", brief: "Reply with exactly the word: set. That is the whole task and it is complete once you reply; nothing is needed from anyone. Do not edit files.", dependsOn: [0] },
      ],
    },
  });
  await invoke("chief_plan_start", { planId: plan.id });
  await until("plan done", async () => {
    const p = (await invoke("teammate_plans", { slug: "chief" })).find((x) => x.id === plan.id);
    if (p?.views.some((v) => v.state === "failed")) throw new Error(`a part failed: ${JSON.stringify(p.views.map((v) => [v.title, v.state, v.summary]))}`);
    return p?.status === "done" ? p : null;
  }, 420_000, 3000);
  const [taskA] = await invoke("teammate_tasks", { slug: a });
  const [taskB] = await invoke("teammate_tasks", { slug: b });
  if (taskA.parentTaskId !== plan.id || taskA.originKind !== "chief" || taskB.parentTaskId !== plan.id) throw new Error("child tasks are not linked to the plan");
  if (taskB.createdAt < taskA.finishedAt) throw new Error("B started before A was done");
  const briefB = (await invoke("teammate_thread", { slug: b, limit: 50 })).find((m) => m.kind === "brief");
  if (!briefB || !/Earlier parts of this plan are done/.test(briefB.text)) throw new Error(`B's brief lacks A's result: ${JSON.stringify(briefB)}`);
  const combined = (await invoke("teammate_thread", { slug: "chief", limit: 50 })).find((m) => m.kind === "task_report" && m.meta === plan.id);
  if (!combined || !combined.text.trim()) throw new Error("no combined report in Chief's thread");
  await ensureTeammates();
  await waitFor("teammates view", `return !!document.querySelector('[data-teammates] [data-teammate="chief"]')`, 5000);
  await js(`document.querySelector('[data-teammates] [data-teammate="chief"]').click()`);
  await waitFor("plan card in Chief's thread", `return !!document.querySelector('[data-plan="${plan.id}"]')`, 10_000);
  await shot("14-chief-plan");
  for (const slug of [a, b]) await invoke("delete_teammate", { slug });
  await js(`location.reload()`);
  await sleep(1500);
});

// Standalone: node scripts/e2e.mjs open-in-editor (renders only; never launches an editor).
await step("open-in-editor", async () => {
  await newWorkspace({ agent: "claude", model: "haiku", prompt: "" });
  await waitFor("Open in editor button", `return !!document.querySelector('button[aria-label="Open in editor"]')`, 10_000);
  const editors = await invoke("list_editors");
  if (!Array.isArray(editors)) throw new Error("list_editors did not return an array");
  await openSettingsView();
  await waitFor("External editor select", `return !!document.querySelector('select[aria-label="External editor"]')`, 8000);
  await closeSettingsView();
});

// Standalone: node scripts/e2e.mjs code-live (one cheap real Haiku edit).
await step("code-live", async () => {
  const ws = await newWorkspace({ agent: "claude", model: "haiku", prompt: "" });
  const filename = "COUNT.txt";
  fs.writeFileSync(path.join(ws.path, filename), "Before streaming\n");
  try {
    await js(`document.querySelector('button[title^="Open in Code"]').click()`);
    await waitFor("linked Code root", `return !!document.querySelector('[data-code-view] [aria-label="Editor mode"]')`, 10000);
    await waitFor("live fixture", `return !!document.getElementById('file-${filename}')`, 10000);
    await js(`document.getElementById('file-${filename}').click()`);
    await waitFor("initial file", `return document.querySelector('.cm-content')?.innerText.includes('Before streaming')`, 10000);
    await js(`[...document.querySelectorAll('[aria-label="Editor mode"] button')].find(b => b.innerText === 'Watch').click()`);
    await invoke("send_message", { id: ws.id, text: `Use the Write tool to create ${filename} with the numbers 1 to 40, one per line. Reply with just done.` });
    let sawPartial = false;
    await until("streamed partial document then all 40 lines", async () => {
      const state = await js(`const content = document.querySelector('.cm-content');
        const text = content ? Array.from(content.querySelectorAll('.cm-line')).map(l => l.textContent.replace(/Claude|Codex/g, '')).join('\\n') : '';
        const numbers = text.trim().split(/\\n/).filter(l => /^\\d+$/.test(l));
        return { count: numbers.length, caret: !!document.querySelector('.cm-agent-caret'), complete: text.trim() === Array.from({length:40}, (_, i) => String(i+1)).join('\\n') };`);
      if (state.count > 1 && state.count < 40 && state.caret) sawPartial = true;
      return state.complete;
    }, 120000, 100);
    if (!sawPartial) throw new Error("Never observed a partial Write with the agent caret before all 40 lines");
    await waitFor("agent timeline", `return document.querySelector('aside[aria-label="Activity"]')?.innerText.includes('${filename}')`, 120000);
    await until("live turn ended", async () => (await invoke("list_workspaces")).find((w) => w.id === ws.id)?.status !== "running", 120000, 500);
    await waitFor("agent gutter", `return !!document.querySelector('.cm-agent-gutter .cm-agent-mark')`, 10000);
    await js(`[...document.querySelectorAll('aside[aria-label="Activity"] button')].find(b => b.innerText.includes('${filename}')).click()`);
    // The diff editor only renders lines in view, so check the old text and the first new lines, not line 40.
    await waitFor("turn comparison", `const t = document.querySelector('.code-diff')?.innerText ?? ''; return t.includes('Before streaming') && /(^|\\n)1\\n+2\\n+3(\\n|$)/.test(t)`, 10000);
    await waitFor("activity counts the rewrite", `return [...document.querySelectorAll('aside[aria-label="Activity"] button')].some(b => b.innerText.includes('${filename}') && b.innerText.includes('+40'))`, 10000);
    await js(`[...document.querySelectorAll('[data-code-view] button')].find(b => b.innerText === 'Back to file').click()`);
    await js(`document.querySelector('.cm-content').focus()`);
    await key("i", { ctrl: true });
    await waitFor("selection prompt owns Ctrl I", `return !!document.querySelector('textarea[aria-label="Question about selection"]') && !document.querySelector('[cmdk-input]')`, 5000);
    await type("Explain this line");
    await js(`const select = document.querySelector('select[aria-label="Target workspace"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'new'); select.dispatchEvent(new Event('change', { bubbles: true }));`);
    await js(`[...document.querySelectorAll('[aria-label="Ask about selection"] button')].find(b => b.innerText === 'Continue').click()`);
    await waitFor("new workspace selection prefill", `const t = document.querySelector('textarea[placeholder^="Describe the task"]'); return t?.value.includes('${filename}') && t.value.includes('Explain this line')`, 5000);
    await key("Escape");
    await key("p", { ctrl: true, shift: true });
    await type("Toggle Watch / Manual");
    await key("Enter");
    await waitFor("manual shortcut", `return [...document.querySelectorAll('[aria-label="Editor mode"] button')].find(b => b.innerText === 'Manual')?.getAttribute('aria-checked') === 'true'`, 5000);
    await shot("code-live");
  } finally {
    if (await js(`return !!document.querySelector('[data-code-view]')`)) await key("1", { alt: true });
  }
});

const wsEvents = async (id) => (await invoke("load_events", { id })).map((e) => e.event);

// Standalone: node scripts/e2e.mjs diff-comments (one cheap real Haiku turn: the review message is a plain chat send).
await step("diff-comments", async () => {
  const ws = await newWorkspace({ agent: "claude", model: "haiku", prompt: "" });
  const filename = "REVIEW.txt";
  fs.writeFileSync(path.join(ws.path, filename), "alpha\nbeta\ngamma\n");
  try {
    await js(`document.querySelector('button[title^="Open in Code"]').click()`);
    await waitFor("linked Code root", `return !!document.querySelector('[data-code-view] [aria-label="Editor mode"]')`, 10000);
    await waitFor("fixture file", `return !!document.getElementById('file-${filename}')`, 10000);
    await js(`document.getElementById('file-${filename}').click()`);
    await waitFor("file open", `return document.querySelector('.cm-content')?.innerText.includes('beta')`, 10000);
    await js(`[...document.querySelectorAll('[data-code-view] button')].find(b => b.innerText === 'Diff').click()`);
    await waitFor("merge editors", `return document.querySelectorAll('.code-diff .cm-editor').length === 2`, 10000);
    // Gutter mousedown (CodeMirror listens for mousedown on the gutter); falls back to the dev hook if the gutter is not there.
    const viaGutter = await js(`const els = [...document.querySelectorAll('.code-diff .cm-review-gutter .cm-gutterElement')].filter(e => e.querySelector('.cm-review-plus'));
      if (els.length < 2) return false;
      els[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return true;`);
    if (viaGutter) {
      await waitFor("comment box", `return !!document.querySelector('textarea[aria-label="Review comment"]')`, 5000);
      await js(`const t = document.querySelector('textarea[aria-label="Review comment"]'); t.focus();`);
      await type("Rename this to delta.");
      await key("Enter");
    } else {
      await js(`window.__ORBIT_REVIEW__.add(${JSON.stringify(ws.id)}, { path: ${JSON.stringify(filename)}, startLine: 2, endLine: 2, text: "Rename this to delta.", excerpt: "beta" })`);
    }
    await waitFor("review bar", `return document.querySelector('[aria-label="Review"]')?.innerText.includes('Review (1)')`, 5000);
    await waitFor("comment card", `return !!document.querySelector('.code-diff .cm-review-card')`, 5000);
    await shot("diff-comments");
    await js(`[...document.querySelectorAll('[aria-label="Review"] button')].find(b => b.innerText === 'Send to agent').click()`);
    const um = await until("review message sent", async () => {
      const evs = await wsEvents(ws.id);
      return evs.find((e) => e.type === "userMessage" && e.text?.includes("Review comments on your changes"));
    }, 30_000, 500);
    if (!um.text.includes(`${filename}:2`) || !um.text.includes("Rename this to delta.")) throw new Error(`review message lacks path or comment: ${um.text}`);
    if (await js(`return !!document.querySelector('[aria-label="Review"]')`)) throw new Error("review bar should clear after sending");
    await until("turn ended", async () => (await invoke("list_workspaces")).find((w) => w.id === ws.id)?.status !== "running", 120000, 500);
  } finally {
    if (await js(`return !!document.querySelector('[data-code-view]')`)) await key("1", { alt: true });
  }
});

// ── Attachments (images and files in chat) ───────────────────
/** A solid-colour RGB PNG, built with zlib (no dependencies). */
function solidPng(rgb, size = 64) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => (~[...b].reduce((r, x) => table[(r ^ x) & 255] ^ (r >>> 8), ~0)) >>> 0;
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const body = Buffer.concat([Buffer.from(t), d]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8; // bit depth
  head[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(size).fill(Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(size).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
const RED = [255, 0, 0];
const attachDir = path.join(scratch, "attach");
fs.mkdirSync(attachDir, { recursive: true });
const norm = (p) => String(p).replaceAll("\\", "/").toLowerCase();
const underHomeImages = (p) => norm(p).startsWith(norm(path.join(home, "images")) + "/");
const underHomeFiles = (p) => norm(p).startsWith(norm(path.join(home, "files")) + "/");
const STRIP_READY = `const s = document.querySelector('[data-pending-strip]'); return !!s && s.children.length > 0 && !s.querySelector('.animate-spin') && ![...s.querySelectorAll('img')].some(i => i.classList.contains('opacity-50'))`;
const STRIP_GONE = `return !document.querySelector('[data-pending-strip]')`;

/** Fresh workspace (no turn yet), selected in the sidebar. */
async function attachWs(name, extra = {}) {
  const ws = await mkWs(name, extra);
  await waitFor("sidebar row", `${DOM} return !!sidebarRow(${JSON.stringify(name)})`, 10_000);
  await selectWsInSidebar(name);
  return ws;
}

// Attachments go through the composer's real hidden file input (CDP DOM.setFileInputFiles), not a synthetic paste.
for (const [name, agent] of [["attachments-image", "claude"], ["attachments-codex-image", "codex"]]) {
  await step(name, async () => {
    const png = path.join(attachDir, "red.png");
    fs.writeFileSync(png, solidPng(RED));
    const ws = await attachWs(`${name} ws`, agent === "codex" ? { agent: "codex", model: null } : {});
    await h.setFileInputFiles("[data-attach-input]", [png]);
    await waitFor("thumbnail in the strip", `return !!document.querySelector('[data-pending-strip] [data-pending-image] img')`, 10_000);
    await waitFor("thumbnail uploaded", STRIP_READY, 20_000);
    const before = await js(turnEnds);
    await composerSend("Is this image red, green or blue? Answer with one word.");
    await waitFor("strip cleared after send", STRIP_GONE, 15_000);
    await waitFor("turn completed", `${turnEnds} > ${before}`, 180_000);
    const evs = await wsEvents(ws.id);
    const um = evs.find((e) => e.type === "userMessage" && e.images?.length);
    if (!um) throw new Error("no userMessage event carries images");
    if (!underHomeImages(um.images[0].path)) throw new Error(`image path is not under <home>/images: ${um.images[0].path}`);
    if (!fs.existsSync(um.images[0].path)) throw new Error("stored image is missing on disk");
    if (um.images[0].data) throw new Error("userMessage image carries inline base64");
    if (agent === "codex") {
      // Delivery is checked in Codex's own session log, independent of how well the model reads colours.
      const thread = evs.find((e) => e.type === "sessionStarted")?.sessionId;
      const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
      const rollout = thread && fs.readdirSync(sessions, { recursive: true }).map(String).find((f) => f.endsWith(`${thread}.jsonl`));
      if (!rollout) throw new Error(`no Codex session log for thread ${thread}`);
      if (!fs.readFileSync(path.join(sessions, rollout), "utf8").includes('"type":"input_image"')) throw new Error("Codex never received the image (no input_image in its session log)");
    }
    await waitFor("image in the user bubble", `return !!document.querySelector('[data-user-message] [data-chat-image] img')`, 10_000);
    const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
    if (!/red/i.test(msg)) {
      // A Codex account at its usage limit fails the turn: say so instead of a bare assertion failure.
      const err = evs.filter((e) => e.type === "turnCompleted" && e.isError).at(-1)?.error;
      throw new Error(agent === "codex" && err ? `Codex turn failed (usage limit or account?): ${String(err).slice(0, 160)}` : `${agent} answered: ${msg.slice(0, 120)}`);
    }
    await shot(name);
  });
}

await step("attachments-file", async () => {
  const txt = path.join(attachDir, "secret.txt");
  fs.writeFileSync(txt, "The secret word is pelican.\n");
  const ws = await attachWs("attachments-file ws");
  await h.setFileInputFiles("[data-attach-input]", [txt]);
  await waitFor("file chip in the strip", `return !!document.querySelector('[data-pending-strip] [data-file-chip]')`, 10_000);
  await waitFor("file uploaded", STRIP_READY, 20_000);
  const before = await js(turnEnds);
  await composerSend("What is the secret word in the attached file? One word.");
  await waitFor("strip cleared after send", STRIP_GONE, 15_000);
  await waitFor("turn completed", `${turnEnds} > ${before}`, 180_000);
  const um = (await wsEvents(ws.id)).find((e) => e.type === "userMessage" && e.files?.length);
  if (!um) throw new Error("no userMessage event carries files");
  const f = um.files[0];
  if (f.name !== "secret.txt" || !underHomeFiles(f.path)) throw new Error(`unexpected file ref: ${JSON.stringify(f)}`);
  if (!fs.existsSync(f.path)) throw new Error("stored file is missing on disk");
  await waitFor("file chip in the user bubble", `return !!document.querySelector('[data-user-message] [data-file-chip]')`, 10_000);
  const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
  if (!/pelican/i.test(msg)) throw new Error(`claude answered: ${msg.slice(0, 120)}`);
});

await step("attachments-tool-image", async () => {
  const ws = await attachWs("attachments-tool-image ws");
  fs.writeFileSync(path.join(ws.path, "red.png"), solidPng(RED));
  const before = await js(turnEnds);
  await composerSend("Use the Read tool on red.png, then reply with one word: done.");
  await waitFor("turn completed", `${turnEnds} > ${before}`, 180_000);
  const evs = await wsEvents(ws.id);
  const results = evs.filter((e) => e.type === "toolResult");
  const tr = results.find((e) => e.images?.length);
  if (!tr) throw new Error(`no toolResult event carries images (outputs: ${JSON.stringify(results.map((e) => e.output.slice(0, 60)))})`);
  if (!underHomeImages(tr.images[0].path)) throw new Error(`tool image path is not under <home>/images: ${tr.images[0].path}`);
  if (!fs.existsSync(tr.images[0].path)) throw new Error("stored tool image is missing on disk");
  for (const e of results) if (/"data"\s*:/.test(JSON.stringify(e))) throw new Error('a stored toolResult event still carries a base64 "data" field');
  await waitFor("thumbnail in the tool group", `return !!document.querySelector('[data-chat-image] img') && !document.querySelector('[data-user-message] [data-chat-image]')`, 10_000);
  await shot("attachments-tool-image");
});

// Standalone: node scripts/e2e.mjs worktree-setup (no agent turn).
await step("worktree-setup", async () => {
  const repoId = (await invoke("list_repos"))[0].id;
  const giPath = path.join(repo, ".gitignore");
  const giOrig = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : null;
  fs.writeFileSync(giPath, (giOrig ?? "") + "\n.env.local\n");
  fs.writeFileSync(path.join(repo, ".env.local"), "SECRET=1\n");
  try {
    await invoke("set_repo_scripts", { repoId, scripts: { setupScript: "echo setup-ok > setup.txt", runScript: null, copyGlobs: [".env.local"] } });
    const ws = await mkWs("worktree setup");
    await until("setup.txt and .env.local in the worktree", () => fs.existsSync(path.join(ws.path, "setup.txt")) && fs.existsSync(path.join(ws.path, ".env.local")), 20000);
    await until("setup row reached done", async () => (await js(`const s = window.__ORBIT_SCRIPTS__?.(); return s?.setup?.[${JSON.stringify(ws.id)}]?.status ?? null`)) === "done", 20000);
    // The run script serves nothing heavy; Orbit hands it a free port in $PORT.
    await invoke("set_repo_scripts", { repoId, scripts: { setupScript: null, runScript: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"`, copyGlobs: [] } });
    const port = await invoke("start_run", { workspaceId: ws.id });
    if (!(port > 0)) throw new Error(`no port returned: ${port}`);
    try {
      await until("dev server answering on its port", async () => { try { return (await (await fetch(`http://127.0.0.1:${port}`)).text()) === "ok"; } catch { return false; } }, 15000);
    } finally {
      await invoke("stop_run", { workspaceId: ws.id });
    }
    await until("run stopped", async () => (await invoke("run_status", { workspaceId: ws.id })).status === "stopped", 10000);
  } finally {
    if (giOrig === null) fs.rmSync(giPath, { force: true }); else fs.writeFileSync(giPath, giOrig);
    await invoke("set_repo_scripts", { repoId, scripts: { setupScript: null, runScript: null, copyGlobs: [] } });
  }
});

// Standalone: node scripts/e2e.mjs mcp-servers (one cheap real Haiku turn).
await step("mcp-servers", async () => {
  const stub = path.join(scratch, "orbit-mcp-stub.cjs");
  fs.writeFileSync(stub, [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
    "rl.on('line', (line) => {",
    "  let r; try { r = JSON.parse(line); } catch { return; }",
    "  if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: r.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'orbit-stub', version: '1.0.0' } } });",
    "  else if (r.method === 'tools/list') send({ id: r.id, result: { tools: [{ name: 'orbit_ping', description: 'Returns pong', inputSchema: { type: 'object', properties: {} } }] } });",
    "  else if (r.method === 'tools/call') send({ id: r.id, result: { content: [{ type: 'text', text: 'pong' }] } });",
    "  else if (r.id !== undefined) send({ id: r.id, result: {} });",
    "});",
  ].join("\n"));
  const saved = await invoke("save_mcp_server", { server: { id: "", name: "orbitstub", transport: "stdio", command: process.execPath, args: [stub], env: {}, url: null, headers: {}, enabled: true } });
  try {
    const info = await invoke("test_mcp_server", { server: saved });
    if (info.name !== "orbit-stub") throw new Error(`probe returned ${JSON.stringify(info)}`);
    const ws = await newWorkspace({ agent: "claude", model: "haiku", prompt: "" });
    const before = await js(turnEnds);
    await composerSend("Call the orbit_ping tool and reply with its result.");
    await waitFor("turn completed", `${turnEnds} > ${before}`, 180_000);
    const msg = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
    if (!/pong/i.test(msg)) throw new Error(`claude answered: ${msg.slice(0, 160)} (workspace ${ws.id})`);
  } finally {
    await invoke("delete_mcp_server", { id: saved.id });
  }
});

await step("rewind", async () => {
  // Two cheap turns that each create a file; rewind to after turn 1, then branch from it.
  const ws = await newWorkspace({ agent: "claude", model: "haiku", prompt: "Create a file REWIND_ONE.md containing the word one. Don't commit it." });
  await waitFor("rewind turn 1", `${turnEnds} >= 1`, 120_000);
  await composerSend("Now create a file REWIND_TWO.md containing the word two. Don't commit it.");
  await waitFor("rewind turn 2", `${turnEnds} >= 2`, 120_000);
  const f1 = path.join(ws.path, "REWIND_ONE.md");
  const f2 = path.join(ws.path, "REWIND_TWO.md");
  let points = [];
  await h.until("two checkpoints", async () => (points = await invoke("workspace_turn_points", { workspaceId: ws.id })).length >= 2, 30_000, 500);
  if (!fs.existsSync(f1) || !fs.existsSync(f2)) throw new Error("both files should exist before the rewind");
  const pv = await invoke("rewind_preview", { workspaceId: ws.id, seq: points[0].seq });
  if (pv.droppedTurns.length !== 1 || !pv.files.includes("REWIND_TWO.md")) throw new Error(`bad preview: ${JSON.stringify(pv)}`);

  // Branch first (the original stays untouched), then rewind.
  const branch = await invoke("branch_from_turn", { workspaceId: ws.id, seq: points[0].seq });
  if (!fs.existsSync(path.join(branch.path, "REWIND_ONE.md"))) throw new Error("branch is missing file 1");
  if (fs.existsSync(path.join(branch.path, "REWIND_TWO.md"))) throw new Error("branch should not have file 2");
  if (!fs.existsSync(f2)) throw new Error("branching changed the original workspace");

  await invoke("rewind_workspace", { workspaceId: ws.id, seq: points[0].seq });
  if (fs.existsSync(f2)) throw new Error("rewind did not remove file 2");
  if (!fs.existsSync(f1)) throw new Error("rewind removed file 1");
  const evs = await invoke("load_events", { id: ws.id });
  const turns = evs.filter((e) => e.event.type === "turnCompleted").length;
  if (turns !== 1) throw new Error(`transcript should have 1 turn after the rewind, has ${turns}`);
  await shot("rewind");
});

await h.finish();
