// End-to-end test of the REAL desktop app (not the mock): launches the debug build with
// WebView2 remote debugging, drives the UI over the Chrome DevTools Protocol, and asserts on
// the DOM. Uses real agents (Claude haiku, Codex default) in a throwaway repo. The CDP driver is
// shared with scripts/e2e-github.mjs (scripts/e2e-harness.mjs).
//
//   1. `bun run dev` (Vite on :1420; the debug build loads the UI from it)
//   2. build once: cmd //c "scripts\\cargo.cmd build"
//   3. node scripts/e2e.mjs <scratch-dir> [step]
//
// <scratch-dir> gets a fresh `home/` (ORBIT_HOME) and `repo/` (a local git repo, no remote),
// so the user's real ~/.orbit state is never touched. Screenshots land in <scratch-dir>/shots.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TURN_ENDS, createHarness, sleep, uiHelpers } from "./e2e-harness.mjs";

const scratch = path.resolve(process.argv[2] ?? "e2e-scratch");
const only = process.argv[3]; // optional: run a single step by name
const h = createHarness({ scratch, only });
const ui = uiHelpers(h);
const { home, launch, quit, cdp, js, waitFor, key, type, shot, invoke, step } = h;
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

// ── Scenario ──────────────────────────────────────────────────
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

console.log(`Real-app e2e — scratch: ${scratch}`);
await launch();
await cdp("Runtime.enable");

await step("boots-real-backend", async () => {
  const info = await js(`return { tauri: 'isTauri' in window, theme: document.documentElement.dataset.theme, title: document.title }`);
  if (!info.tauri) throw new Error("not running inside Tauri (mock?)");
  const packs = await invoke("list_packs");
  if (!packs.some((p) => p.name === "shipkit" && p.builtin)) throw new Error("shipkit not installed into ORBIT_HOME");
  if (packs.length !== 1) throw new Error(`expected only shipkit, got ${packs.map((p) => p.name)}`);
  await shot("01-empty");
});

await step("add-repo", async () => {
  await invoke("add_repo", { path: repo }); // the UI path uses a native folder picker
  await js(`location.reload()`);
  await sleep(1500);
  await waitFor("repo in sidebar", `return document.body.innerText.toUpperCase().includes('REPO')`, 10_000);
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
  const ws = (await invoke("list_workspaces"))[0];
  if (!fs.existsSync(path.join(ws.path, "NOTES.md"))) throw new Error(`NOTES.md missing in worktree ${ws.path}`);
  if (fs.existsSync(path.join(repo, "NOTES.md"))) throw new Error("agent wrote to the main checkout, not the worktree");
});

await step("pr-panel-without-remote", async () => {
  await ui.openShip();
  await waitFor("no-PR state", `return document.body.innerText.includes('No pull request for this branch yet')`, 20_000);
});

await step("follow-up-message", async () => {
  const before = await js(turnEnds);
  await composerSend("What is the exact content of NOTES.md? Answer with just the content.");
  await waitFor("second turn", `${turnEnds} > ${before}`, 120_000);
  const last = await js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);
  if (!/hello from claude/i.test(last)) throw new Error(`unexpected answer: ${last.slice(0, 120)}`);
});

await step("slash-autocomplete-and-skill", async () => {
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
  await js(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'REBASE').click()`);
  await waitFor("skill chip in transcript", `return [...document.querySelectorAll('[data-user-message]')].some(e => e.innerText.includes('/shipkit:rebase'))`, 10_000);
  await waitFor("skill turn completed", `${turnEnds} > ${before}`, 180_000);
  await shot("05-skill");
});

await step("interrupt", async () => {
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
  await key("k", { ctrl: true });
  await waitFor("palette", `return !!document.querySelector('[cmdk-input]')`, 5000);
  await type("notes");
  await shot("07-palette");
  await key("Escape");
  const before = await js(`return document.documentElement.dataset.theme`);
  await key("l", { ctrl: true, shift: true });
  const after = await js(`return document.documentElement.dataset.theme`);
  if (before === after) throw new Error("Ctrl+Shift+L did not toggle theme");
  await shot("08-theme-toggled");
  await key("l", { ctrl: true, shift: true });
});

await step("packs-dialog", async () => {
  await js(`[...document.querySelectorAll('button')].find(b => b.title === 'Skill packs & pins')?.click()`);
  await waitFor("packs dialog", `return document.body.innerText.includes('Skill packs') && document.body.innerText.includes('shipkit')`, 5000);
  await shot("09-packs");
  await key("Escape");
  await js(`document.querySelector('.fixed.inset-0')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
});

await step("inbox", async () => {
  const INBOX = `const inbox = [...document.querySelectorAll('h1')].find((h) => h.innerText === 'Inbox')?.closest('.flex-col');
    const rows = () => [...(inbox?.querySelectorAll('li') ?? [])];`;
  const claudeWs = (await invoke("list_workspaces")).find((w) => w.agent === "claude");
  const name = JSON.stringify(claudeWs.name.slice(0, 20));
  const row = (cond) => `${INBOX} return rows().some((li) => li.innerText.includes(${name}) && ${cond})`;

  await key("i", { ctrl: true });
  await waitFor("inbox view", `${INBOX} return !!inbox`, 5000);
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
  await key("3");
  await waitFor("row leaves while the agent works", `${INBOX} return !rows().some((li) => li.innerText.includes(${name}) && /Finished/.test(li.innerText))`, 15_000);
  await waitFor("row comes back finished", row(`/Finished/.test(li.innerText)`), 120_000);
  const msg = await invoke("workspace_summary", { id: claudeWs.id });
  if (!/NOTES\.md/i.test(msg.lastAssistantText ?? "")) throw new Error(`summary turn answered: ${(msg.lastAssistantText ?? "").slice(0, 120)}`);
  await js(`document.activeElement?.blur()`);
  await key("e");
  await waitFor("dismissed", `${INBOX} return !rows().some((li) => li.innerText.includes(${name}) && /Finished/.test(li.innerText))`, 10_000);
  await key("i", { ctrl: true });
});

await step("inbox-snooze", async () => {
  const INBOX = `const inbox = [...document.querySelectorAll('h1')].find((h) => h.innerText === 'Inbox')?.closest('.flex-col');
    const rows = () => [...(inbox?.querySelectorAll('li') ?? [])];`;
  const claudeWs = (await invoke("list_workspaces")).find((w) => w.agent === "claude");
  const name = JSON.stringify(claudeWs.name.slice(0, 20));
  const inNeeds = `${INBOX} return rows().some((li) => li.innerText.includes(${name}))`;

  await key("i", { ctrl: true });
  await waitFor("inbox view", `${INBOX} return !!inbox`, 5000);
  // The previous step dismissed it; new activity puts it back in "Needs you".
  await invoke("send_message", { id: claudeWs.id, text: "Reply with exactly one word: again" });
  await waitFor("row is in Needs you", `${inNeeds} && /Finished/.test(rows().find((li) => li.innerText.includes(${name})).innerText)`, 120_000);
  await invoke("snooze_workspace", { id: claudeWs.id, until: Date.now() + 3_600_000 });
  await waitFor("snoozed row leaves Needs you", `${INBOX} return !rows().some((li) => li.innerText.includes(${name}))`, 10_000);
  await shot("11b-inbox-snoozed");
  await invoke("snooze_workspace", { id: claudeWs.id, until: 0 });
  await waitFor("unsnoozed row is back", `${INBOX} return rows().some((li) => li.innerText.includes(${name}) && /Finished/.test(li.innerText))`, 10_000);
  await js(`document.activeElement?.blur()`);
  await key("e");
  await key("i", { ctrl: true });
});

await step("attached-folders", async () => {
  const claudeWs = (await invoke("list_workspaces")).find((w) => w.agent === "claude");
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

await step("resume-after-restart", async () => {
  await quit();
  await launch();
  await cdp("Runtime.enable");
  // Not the profiles step's workspace, which is also Claude and now the most recently updated.
  const claudeWs = (await invoke("list_workspaces")).find((w) => w.agent === "claude" && w.name.includes("NOTES.md"));
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

await h.finish();
