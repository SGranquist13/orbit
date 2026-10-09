// GitHub end-to-end test of the REAL app: Ship → draft PR → checks → ready → merge, Fix CI from the
// inbox, write-ticket, and preflight across an attached project. Opt-in: it creates real PRs and
// issues in a throwaway private sandbox repo (default SGranquist13/orbit-e2e-sandbox, override with
// ORBIT_GH_SANDBOX). The sandbox's CI fails whenever a file named FAIL exists.
//
//   1. `bun run dev` running, debug build present (see scripts/e2e.mjs)
//   2. node scripts/e2e-github.mjs <scratch-dir> [step]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TURN_ENDS, createHarness, sleep, uiHelpers } from "./e2e-harness.mjs";

const SANDBOX = process.env.ORBIT_GH_SANDBOX ?? "SGranquist13/orbit-e2e-sandbox";
const scratch = path.resolve(process.argv[2] ?? ".e2e-github");
const only = process.argv[3];
const repo = path.join(scratch, "repo");
const consumer = path.join(scratch, "consumer");
const stamp = Date.now().toString(36);

const gh = (args, cwd = repo) => {
  const out = execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.trim().startsWith("{") || out.trim().startsWith("[") ? JSON.parse(out) : out.trim();
};
const prOf = (branch) =>
  gh(["pr", "view", branch, "--json", "number,isDraft,state,statusCheckRollup,url"]);
// Rollup entries are CheckRuns (status/conclusion) or StatusContexts (state), e.g. third-party
// apps like CodeRabbit. Only the sandbox's own "check" job decides green/red; others must just finish.
const verdict = (c) => (c.__typename === "StatusContext" ? c.state : c.status === "COMPLETED" ? c.conclusion : "PENDING");
const ownCheck = (pr) => pr.statusCheckRollup.find((c) => c.name === "check");
const checksGreen = (pr) => verdict(ownCheck(pr) ?? {}) === "SUCCESS";
const checksRed = (pr) => verdict(ownCheck(pr) ?? {}) === "FAILURE";
/** Closes a PR and deletes its remote branch (the local one is held by an Orbit worktree). */
const closePr = (number, branch) => {
  gh(["pr", "close", String(number)]);
  try {
    gh(["api", "-X", "DELETE", `repos/${SANDBOX}/git/refs/heads/${branch}`]);
  } catch {}
};

// ── Scenario setup ────────────────────────────────────────────
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
execFileSync("gh", ["repo", "clone", SANDBOX, repo, "--", "-q"], { stdio: "ignore" });
// Leftovers from earlier runs would confuse PR lookups.
for (const { number, headRefName } of gh(["pr", "list", "--state", "open", "--json", "number,headRefName"])) closePr(number, headRefName);
fs.mkdirSync(consumer, { recursive: true });
fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "sandbox-app", type: "module", dependencies: { "sandbox-lib": "file:../repo" } }, null, 2) + "\n");
fs.writeFileSync(path.join(consumer, "index.js"), 'import { greet } from "sandbox-lib";\n\nconsole.log(greet("Orbit"));\n');

const h = createHarness({ scratch, only });
const ui = uiHelpers(h);
const shipPanel = `[...document.querySelectorAll('aside')].find(a => /CHANGES/i.test(a.innerText))`;
const panelButton = (label) => `[...(${shipPanel})?.querySelectorAll('button') ?? []].find(b => b.innerText.trim() === ${JSON.stringify(label)})`;

console.log(`GitHub e2e — sandbox ${SANDBOX}, scratch ${scratch}`);
await h.launch();
await h.invoke("add_repo", { path: repo });
await h.js(`location.reload()`);
await sleep(1500);

let shipWs;
await h.step("ship-opens-draft-pr", async () => {
  shipWs = await ui.newWorkspace({ model: "haiku", prompt: `Create a file notes/hello-${stamp}.txt containing the single line: hi. Do not commit.` });
  await ui.waitTurn(0);
  await ui.clickChip("ship");
  await ui.waitTurn(1, 300_000);
  const pr = await h.until("draft PR exists", () => prOf(shipWs.branch), 60_000);
  if (!pr.isDraft) throw new Error("Ship should open a draft PR");
  await ui.openShip();
  await h.waitFor("PR card in Ship panel", `return (${shipPanel})?.innerText.includes('#${pr.number}')`, 30_000);
  await h.shot("gh-01-draft-pr");
});

await h.step("checks-pass-in-panel", async () => {
  await h.until("CI green on GitHub", async () => checksGreen(prOf(shipWs.branch)), 240_000, 5000);
  await h.js(`[...(${shipPanel}).querySelectorAll('button')].find(b => b.title === 'Refresh')?.click()`);
  await h.waitFor("header hint shows a green checks dot", `return !!document.querySelector('header button .bg-ok')`, 30_000);
  const status = await h.invoke("pr_status", { id: shipWs.id });
  if (status.checks.passed < 1 || status.checks.failed) throw new Error(`unexpected checks ${JSON.stringify(status.checks)}`);
});

await h.step("ready-and-merge", async () => {
  await h.waitFor("Ready for review button", `return !!(${panelButton("Ready for review")})`, 10_000);
  await h.js(`(${panelButton("Ready for review")}).click()`);
  await h.until("PR marked ready", async () => !prOf(shipWs.branch).isDraft, 60_000);
  await h.autoConfirm(true);
  await h.waitFor("merge enabled", `const b = ${panelButton("Squash & merge")}; return b && !b.disabled`, 60_000);
  await h.js(`(${panelButton("Squash & merge")}).click()`);
  await h.until("PR merged", async () => prOf(shipWs.branch).state === "MERGED", 60_000);
  await h.waitFor("panel shows Merged", `return /Merged/.test((${shipPanel})?.innerText ?? '')`, 30_000);
  await h.shot("gh-02-merged");
});

let failWs;
await h.step("fix-ci-from-inbox", async () => {
  failWs = await ui.newWorkspace({ model: "haiku", prompt: "Add a file notes/todo.md with a short three-item todo list. Do not commit." });
  await ui.waitTurn(0);
  await ui.clickChip("ship");
  await ui.waitTurn(1, 300_000);
  await h.until("PR opened", () => prOf(failWs.branch), 60_000);
  // A teammate accidentally pushes a debug marker to the branch, which breaks CI. (Asking the agent
  // itself to create FAIL doesn't work: it rightly refuses to undo what it was asked to do.)
  const mate = path.join(scratch, "teammate");
  execFileSync("gh", ["repo", "clone", SANDBOX, mate, "--", "-q", "--branch", failWs.branch], { stdio: "ignore" });
  fs.writeFileSync(path.join(mate, "FAIL"), "");
  const git = (...a) => execFileSync("git", ["-c", "user.name=teammate", "-c", "user.email=teammate@example.com", ...a], { cwd: mate, stdio: "ignore" });
  git("add", "FAIL");
  git("commit", "-m", "chore: temporary debug marker (remove before merge)");
  git("push", "origin", failWs.branch);
  await h.until("CI red on GitHub", async () => checksRed(prOf(failWs.branch)), 240_000, 5000);
  // The inbox surfaces failing checks; send its Fix CI suggestion with one click.
  await h.key("i", { ctrl: true });
  const row = `[...document.querySelectorAll('li')].find(li => li.innerText.includes(${JSON.stringify(failWs.name.slice(0, 24))}) && /Checks failing/.test(li.innerText))`;
  await h.waitFor("inbox row: Checks failing", `return !!(${row})`, 90_000);
  await h.js(`(${row}).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await h.waitFor("Fix CI suggestion", `return !![...(${row}).querySelectorAll('button')].find(b => /Fix CI/.test(b.innerText))`, 10_000);
  await h.shot("gh-03-inbox-checks-failing");
  await h.js(`[...(${row}).querySelectorAll('button')].find(b => /Fix CI/.test(b.innerText)).click()`);
  await h.until("CI green after Fix CI", async () => checksGreen(prOf(failWs.branch)), 600_000, 10_000);
  await h.key("i", { ctrl: true });
});

await h.step("write-ticket", async () => {
  const marker = `dark-mode-${stamp}`;
  const before = (await h.invoke("workspace_summary", { id: failWs.id })).lastTurnSeq;
  await h.invoke("run_skill", {
    id: failWs.id,
    skillId: "shipkit:write-ticket",
    args: `Add a dark mode toggle to the settings page. Include the tag ${marker} at the end of the issue body.`,
  });
  await h.until("ticket turn finished", async () => {
    const s = await h.invoke("workspace_summary", { id: failWs.id });
    const w = (await h.invoke("list_workspaces")).find((x) => x.id === failWs.id);
    return s.lastTurnSeq > before && w.status !== "running";
  }, 300_000);
  const issue = await h.until("issue filed on GitHub", async () => {
    const found = gh(["issue", "list", "--state", "open", "--search", `${marker} in:body`, "--json", "number,title"]);
    return found[0];
  }, 60_000);
  console.log(`      filed #${issue.number}: ${issue.title}`);
  gh(["issue", "close", String(issue.number), "--reason", "not planned"]);
});

await h.step("preflight-flags-consumer", async () => {
  const ws = await ui.newWorkspace({ model: "haiku", prompt: "In lib.js, rename the exported function greet to welcome. Change only this repository. Do not commit." });
  await ui.waitTurn(0);
  await h.invoke("attach_folder", { workspaceId: ws.id, path: consumer });
  const before = await h.js(TURN_ENDS);
  await ui.clickChip("preflight");
  await ui.waitTurn(before, 300_000);
  const report = await ui.lastMessage();
  await h.shot("gh-04-preflight");
  if (!/breaking/i.test(report) || !/sandbox-app|consumer|index\.js/i.test(report)) {
    throw new Error(`preflight missed the broken consumer: ${report.slice(0, 300)}`);
  }
});

// Leave the sandbox tidy: close anything this run left open.
for (const { number, headRefName } of gh(["pr", "list", "--state", "open", "--json", "number,headRefName"])) closePr(number, headRefName);
await h.finish();
