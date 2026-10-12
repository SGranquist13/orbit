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
import path from "node:path";
import { TURN_ENDS, createHarness, resolveScratch, sleep, uiHelpers } from "./e2e-harness.mjs";

// `node scripts/e2e.mjs [scratch-dir] [step]`; a lone argument without path characters is a step name.
const args = process.argv.slice(2);
const stepOnly = args.length === 1 && !/[\\/:.]/.test(args[0]);
const scratch = resolveScratch(stepOnly ? undefined : args[0], "orbit-e2e");
const only = stepOnly ? args[0] : args[1]; // optional: run a single step by name
const h = createHarness({ scratch, only });
const ui = uiHelpers(h);
const { home, launch, quit, cdp, js, waitFor, until, key, type, shot, invoke, step } = h;
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

// Inbox helpers. Ctrl+I toggles, and a failed earlier step can leave the view open, so open it idempotently.
const INBOX_JS = `const inbox = [...document.querySelectorAll('h1')].find((h) => h.innerText === 'Inbox')?.closest('.flex-col');
    const rows = () => [...(inbox?.querySelectorAll('li') ?? [])];`;
const ensureInbox = async () => {
  if (!(await js(`${INBOX_JS} return !!inbox`))) await key("i", { ctrl: true });
  await waitFor("inbox view", `${INBOX_JS} return !!inbox`, 5000);
};
// Focus follows the mouse (and moves to a neighbour after a send), so key shortcuts must name their row:
// another workspace (e.g. the errored Codex one) can hold focus.
const focusInboxRow = async (name) => {
  await js(`${INBOX_JS} rows().find((li) => li.innerText.includes(${name}))?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await waitFor("row focused", `${INBOX_JS} return rows().find((li) => li.innerText.includes(${name}))?.querySelectorAll('button').length >= 3`, 5000);
};

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
  await js(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'REBASE').click()`);
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
  await key("i", { ctrl: true });
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
  await key("i", { ctrl: true });
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
  await key("e", { ctrl: true, shift: true });
  await waitFor("routines view lists the routine", `return document.body.innerText.includes('Routines') && document.body.innerText.includes('Reply with exactly one word')`, 10_000);
  await shot("11-routines");
  await invoke("delete_routine", { id: routine.id });
  // The Simplify action round-trips (it is only stored here, not run: that needs a real Friday afternoon of merged work).
  const simp = await invoke("save_routine", { input: { ...input, name: "", action: { kind: "simplify" }, schedule: { kind: "weekly", weekday: 5, time: "16:00" } } });
  if (simp.action.kind !== "simplify" || simp.name !== "Simplify recent changes") throw new Error(`bad simplify routine: ${JSON.stringify(simp)}`);
  await invoke("delete_routine", { id: simp.id });
  await key("e", { ctrl: true, shift: true });
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
  const sent = await invoke("teammate_send", { slug, text: "Reply with exactly the word: ready. Do not edit files.", repoId: null, newTask: null });
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
  // Open the Teammates view (Ctrl+Shift+T), pick the teammate in the list and look at its thread.
  await key("t", { ctrl: true, shift: true });
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
  await invoke("teammate_send", { slug: a, text: "Reply with exactly the word: ready. Do not edit files.", repoId: null, newTask: null });
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
  await key("t", { ctrl: true, shift: true });
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
        { teammate: a, title: "Say ready", brief: "Reply with exactly the word: ready. Do not edit files.", dependsOn: [] },
        { teammate: b, title: "Say set", brief: "Reply with exactly the word: set. Do not edit files.", dependsOn: [0] },
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
  await key("t", { ctrl: true, shift: true });
  await waitFor("teammates view", `return !!document.querySelector('[data-teammates] [data-teammate="chief"]')`, 5000);
  await js(`document.querySelector('[data-teammates] [data-teammate="chief"]').click()`);
  await waitFor("plan card in Chief's thread", `return !!document.querySelector('[data-plan="${plan.id}"]')`, 10_000);
  await shot("14-chief-plan");
  for (const slug of [a, b]) await invoke("delete_teammate", { slug });
  await js(`location.reload()`);
  await sleep(1500);
});

await h.finish();
