// GitHub end-to-end test of the REAL app: Ship → draft PR → checks → ready → merge, Fix CI from the
// inbox, write-ticket, and preflight across an attached project. Opt-in: it creates real PRs and
// issues in a throwaway private sandbox repo (set ORBIT_GH_SANDBOX; the maintainer default applies only
// to the maintainer's gh login). The sandbox's CI fails whenever a file named FAIL exists.
//
//   1. `bun run dev` running, debug build present (see scripts/e2e.mjs)
//   2. node scripts/e2e-github.mjs <scratch-dir> [step]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TURN_ENDS, createHarness, killLeftovers, resolveScratch, sleep, uiHelpers } from "./e2e-harness.mjs";

// The maintainer's sandbox is the default only for the maintainer's own gh login; everyone else must
// bring their own private repo.
const MAINTAINER_SANDBOX = "SGranquist13/orbit-e2e-sandbox";
const ghLogin = () => {
  try {
    return execFileSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const SANDBOX = process.env.ORBIT_GH_SANDBOX || (ghLogin() === "SGranquist13" ? MAINTAINER_SANDBOX : "");
if (!SANDBOX) {
  console.error(`ORBIT_GH_SANDBOX is not set.

e2e:github creates and closes real PRs and issues, so it needs a throwaway PRIVATE repo you own:
  1. gh repo create <you>/orbit-e2e-sandbox --private --add-readme
  2. Add a GitHub Actions workflow with one job named "check" that fails whenever a file named
     FAIL exists in the repo (e.g. \`test ! -e FAIL\`) and passes otherwise.
  3. ORBIT_GH_SANDBOX=<you>/orbit-e2e-sandbox bun run e2e:github

Requires gh to be logged in with the repo scope.`);
  process.exit(1);
}
const scratch = resolveScratch(process.argv[2], "orbit-e2e-github"); // must be outside any git repo
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
killLeftovers(scratch);
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

await h.step("review-on-ship", async () => {
  // Draft only: nothing is posted to the PR. Findings may legitimately be empty; a summary must exist.
  await h.invoke("update_settings", { patch: { reviewOnShip: "draft", reviewModel: "haiku", reviewMaxFindings: 3 } });
  const review = await h.invoke("run_review", { workspaceId: shipWs.id });
  if (!review.summary?.trim()) throw new Error(`review has no summary: ${JSON.stringify(review)}`);
  const stored = await h.invoke("latest_review", { workspaceId: shipWs.id });
  if (!stored || stored.headSha !== review.headSha || stored.prNumber !== review.prNumber) throw new Error("no stored review row for the PR head");
  if (stored.findings.length > 3) throw new Error("reviewMaxFindings was not honoured");
  await ui.openShip();
  await h.waitFor("Review section shows the summary", `return (${shipPanel})?.innerText.includes(${JSON.stringify(review.summary.slice(0, 20))})`, 30_000);
  await h.shot("gh-02a-review");
  await h.invoke("update_settings", { patch: { reviewOnShip: "off", reviewModel: "sonnet", reviewMaxFindings: 8 } });
});

await h.step("ready-and-merge", async () => {
  await h.waitFor("Ready for review button", `return !!(${panelButton("Ready for review")})`, 10_000);
  await h.js(`(${panelButton("Ready for review")}).click()`);
  await h.until("PR marked ready", async () => !prOf(shipWs.branch).isDraft, 60_000);
  await h.autoConfirm(true);
  await h.waitFor("merge enabled", `const b = ${panelButton("Squash & merge")}; return b && !b.disabled`, 60_000);
  await h.js(`(${panelButton("Squash & merge")}).click()`);
  await h.until("PR merged", async () => prOf(shipWs.branch).state === "MERGED", 60_000);
  // With "archive after merge" on (the default) the workspace is archived and its panel closes; otherwise the panel says Merged.
  await h.until("panel shows Merged or workspace archived", async () =>
    !(await h.invoke("list_workspaces")).some((w) => w.id === shipWs.id) || (await h.js(`return /Merged/.test((${shipPanel})?.innerText ?? '')`)), 30_000, 1000);
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
  await h.key("1", { alt: true });
  const row = `[...document.querySelectorAll('li')].find(li => li.innerText.includes(${JSON.stringify(failWs.name.slice(0, 24))}) && /Checks failing/.test(li.innerText))`;
  await h.waitFor("inbox row: Checks failing", `return !!(${row})`, 90_000);
  await h.js(`(${row}).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await h.waitFor("Fix CI suggestion", `return !![...(${row}).querySelectorAll('button')].find(b => /Fix CI/.test(b.innerText))`, 10_000);
  await h.shot("gh-03-inbox-checks-failing");
  await h.js(`[...(${row}).querySelectorAll('button')].find(b => /Fix CI/.test(b.innerText)).click()`);
  await h.until("CI green after Fix CI", async () => checksGreen(prOf(failWs.branch)), 600_000, 10_000);
  await ui.workspaceView();
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

/** Waits until a workspace (on screen or not) finishes a turn newer than `afterTurnSeq`. */
async function waitIdle(id, afterTurnSeq = 0, timeoutMs = 300_000) {
  await h.until("turn finished", async () => {
    const s = await h.invoke("workspace_summary", { id });
    const w = (await h.invoke("list_workspaces")).find((x) => x.id === id);
    return s.lastTurnSeq > afterTurnSeq && w.status !== "running";
  }, timeoutMs, 2000);
}

await h.step("issues-start-and-plan", async () => {
  const fileIssue = (title, body) => Number(gh(["issue", "create", "--title", title, "--body", body]).split("/").pop());
  const nStart = fileIssue(`Add a CONTRIBUTING.md (${stamp})`, "Add a short CONTRIBUTING.md explaining how to run the project. One paragraph is enough.");
  const nPlan = fileIssue(`Add a unit test for greet (${stamp})`, "lib.js exports greet but has no tests. Add a node:test unit test.");
  const rowOf = (n) => `[...document.querySelectorAll('li')].find(li => li.innerText.includes('#${n}'))`;
  const openIssues = async () => {
    await h.key("5", { alt: true });
    await h.waitFor("Issues view", `return [...document.querySelectorAll('h1')].some(x => x.innerText === 'Issues')`, 10_000);
  };
  const press = async (n, label) => {
    await h.waitFor(`issue #${n} listed`, `return !!(${rowOf(n)})`, 30_000);
    await h.js(`(${rowOf(n)}).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await h.waitFor(`${label} button`, `return !![...(${rowOf(n)}).querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(label)}))`, 5000);
    await h.js(`[...(${rowOf(n)}).querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(label)})).click()`);
    return h.until(`workspace for #${n}`, async () => (await h.invoke("list_workspaces")).find((w) => w.issueNumber === n), 60_000, 1000);
  };

  // Start: linked branch, the agent implements the issue, and Ship's PR closes it.
  await openIssues();
  await h.shot("gh-05-issues");
  const built = await press(nStart, "Start");
  if (!built.branch.includes(`${nStart}-`)) throw new Error(`branch not linked to the issue: ${built.branch}`);
  await waitIdle(built.id);
  await h.invoke("run_skill", { id: built.id, skillId: "shipkit:ship", args: "" });
  await waitIdle(built.id, (await h.invoke("workspace_summary", { id: built.id })).lastTurnSeq);
  const pr = await h.until("PR for the issue", () => gh(["pr", "view", built.branch, "--json", "body,files"]), 60_000);
  if (!new RegExp(`(Closes|Fixes|Resolves) #${nStart}\\b`, "i").test(pr.body)) throw new Error(`PR body doesn't close #${nStart}: ${pr.body.slice(0, 200)}`);
  if (!pr.files.some((f) => /CONTRIBUTING\.md$/i.test(f.path))) throw new Error("PR doesn't add CONTRIBUTING.md");

  // Plan: read-only Planner writes a plan and changes nothing.
  await openIssues();
  const planned = await press(nPlan, "Plan");
  if (planned.profile !== "shipkit:planner") throw new Error(`Plan used profile ${planned.profile}`);
  await waitIdle(planned.id);
  const changes = await h.invoke("workspace_changes", { id: planned.id });
  if (changes.length) throw new Error(`Planner changed files: ${changes.map((c) => c.path)}`);
  const plan = (await h.invoke("workspace_summary", { id: planned.id })).lastAssistantText ?? "";
  if (plan.length < 200) throw new Error(`plan too thin: ${plan.slice(0, 200)}`);

  for (const n of [nStart, nPlan]) gh(["issue", "close", String(n), "--reason", "not planned"]);
});

await h.step("new-ticket-dialog", async () => {
  // Palette > New ticket: notes go to a read-only Ticket writer workspace that runs /shipkit:write-ticket.
  const marker = `ticket-dialog-${stamp}`;
  const before = new Set((await h.invoke("list_workspaces")).map((w) => w.id));
  const model = (await h.invoke("get_settings")).defaultModelClaude;
  await h.invoke("update_settings", { patch: { defaultAgent: "claude", defaultModelClaude: "haiku" } });
  try {
    await h.key("p", { ctrl: true, shift: true });
    await h.waitFor("palette", `return !!document.querySelector('[cmdk-input]')`, 5000);
    await h.type("New ticket");
    await h.waitFor("New ticket item", `return [...document.querySelectorAll('[cmdk-item]')].some((i) => i.innerText.includes('New ticket'))`, 5000);
    await h.key("Enter");
    await h.waitFor("ticket dialog", `return !!document.querySelector('textarea[placeholder^="Describe the bug"]')`, 8000);
    await h.js(`document.querySelector('textarea[placeholder^="Describe the bug"]').focus()`);
    await h.type(`Add a dark mode toggle to the settings page. Include the tag ${marker} at the end of the issue body.`);
    await h.js(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Write ticket').click()`);
    const ws = await h.until("ticket writer workspace", async () => (await h.invoke("list_workspaces")).find((w) => !before.has(w.id)), 60_000, 1000);
    if (ws.profile !== "shipkit:ticket-writer") throw new Error(`workspace profile ${ws.profile}`);
    await h.waitFor("dialog closed", `return !document.querySelector('textarea[placeholder^="Describe the bug"]')`, 15_000);
    await waitIdle(ws.id);
    const issue = await h.until("issue filed on GitHub", async () => gh(["issue", "list", "--state", "open", "--search", `${marker} in:body`, "--json", "number,title"])[0], 90_000);
    console.log(`      filed #${issue.number}: ${issue.title}`);
    gh(["issue", "close", String(issue.number), "--reason", "not planned"]);
  } finally {
    await h.invoke("update_settings", { patch: { defaultModelClaude: model } });
  }
});

await h.step("issue-chip", async () => {
  // A workspace linked to an issue shows #n in its header; the chip's command resolves the issue URL.
  const n = Number(gh(["issue", "create", "--title", `Chip check (${stamp})`, "--body", "Throwaway issue for the e2e."]).split("/").pop());
  try {
    const repoId = (await h.invoke("list_repos"))[0].id;
    const ws = await h.invoke("create_workspace", { repoId, name: `chip ws ${stamp}`, agent: "claude", model: "haiku", prompt: null, issueNumber: n, profile: null });
    await h.waitFor("sidebar row", `return [...document.querySelectorAll('aside li button')].some((b) => b.innerText.includes(${JSON.stringify(ws.name)}))`, 10_000);
    await h.js(`[...document.querySelectorAll('aside li button')].find((b) => b.innerText.includes(${JSON.stringify(ws.name)})).click()`);
    await h.waitFor("#n chip in the header", `return [...document.querySelectorAll('header button[title="Open the linked issue on GitHub"]')].some((b) => b.innerText.includes('#${n}'))`, 10_000);
    const url = await h.invoke("issue_url", { workspaceId: ws.id });
    if (!url.includes(`github.com/${SANDBOX}/issues/${n}`)) throw new Error(`issue_url returned ${url}`);
    await h.shot("gh-06-issue-chip");
  } finally {
    gh(["issue", "close", String(n), "--reason", "not planned"]);
  }
});

await h.step("address-comments", async () => {
  const ws = await ui.newWorkspace({ model: "haiku", prompt: `Create a file notes/review-${stamp}.txt containing the single line: hi. Do not commit.` });
  await ui.waitTurn(0);
  await ui.clickChip("ship");
  await ui.waitTurn(1, 300_000);
  const pr = await h.until("PR opened", () => prOf(ws.branch), 60_000);
  try {
    const file = `notes/review-${stamp}.txt`;
    const sha = gh(["pr", "view", ws.branch, "--json", "headRefOid", "-q", ".headRefOid"]);
    gh(["api", `repos/${SANDBOX}/pulls/${pr.number}/comments`, "-f", "body=Please change the word hi to hello in this file.", "-f", `commit_id=${sha}`, "-f", `path=${file}`, "-F", "line=1", "-f", "side=RIGHT"]);
    const commits = () => gh(["pr", "view", ws.branch, "--json", "commits"]).commits.length;
    const before = commits();
    const seq = (await h.invoke("workspace_summary", { id: ws.id })).lastTurnSeq;
    await ui.openShip();
    await h.js(`[...(${shipPanel}).querySelectorAll('button')].find(b => b.title === 'Refresh')?.click()`);
    await h.waitFor("Address comments button", `const b = ${panelButton("Address comments")}; return !!b && !b.disabled`, 60_000);
    await h.js(`(${panelButton("Address comments")}).click()`);
    await h.waitFor("skill in transcript", `return [...document.querySelectorAll('[data-user-message]')].some((e) => e.innerText.includes('address-comments'))`, 15_000);
    await waitIdle(ws.id, seq);
    await h.until("a new commit on the PR", async () => commits() > before, 90_000, 3000);
    const content = gh(["api", `repos/${SANDBOX}/contents/${file}?ref=${ws.branch}`, "-q", ".content"]);
    const text = Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
    if (!/hello/i.test(text)) throw new Error(`the comment was not addressed; file reads: ${JSON.stringify(text)}`);
  } finally {
    closePr(pr.number, ws.branch);
  }
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

// Review view on a real PR (PLANNING #15): inline comments on both sides, a range, submit, reply, resolve, viewed.
await h.step("review-pr", async () => {
  const clone = path.join(scratch, "review-clone");
  const branch = `e2e/review-${stamp}`;
  fs.rmSync(clone, { recursive: true, force: true });
  execFileSync("gh", ["repo", "clone", SANDBOX, clone, "--", "-q"], { stdio: "ignore" });
  const git = (...a) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...a], { cwd: clone, stdio: "ignore" });
  git("checkout", "-q", "-b", branch);
  // Every README line changes, so old-side lines 1-2 are both removed lines.
  const readme = path.join(clone, "README.md");
  fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").split("\n").map((l, i, a) => (i === a.length - 1 && l === "" ? l : `${l} (e2e)`)).join("\n"));
  git("commit", "-qam", "e2e: review fixture");
  git("push", "-q", "-u", "origin", branch);
  const url = gh(["pr", "create", "--head", branch, "--title", `e2e review ${stamp}`, "--body", "Throwaway PR for the Review view e2e."], clone);
  const number = Number(String(url).split("/").pop());
  const set = (sel, text) => `const t = ${sel}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true }));`;
  const col = (kind) => (kind === "del" ? 0 : 1);
  const row = (kind, n) => `[...document.querySelectorAll('[data-review-diff="README.md"] .rv-row.rv-${kind}')].find(r => r.querySelectorAll('.rv-num')[${col(kind)}].innerText === '${n}')`;
  const press = (kind, n, shift = false) => h.js(`${row(kind, n)}.querySelectorAll('.rv-num')[${col(kind)}].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: ${shift} }))`);
  const addDraft = async (text) => {
    await h.waitFor("comment box", `return !!document.querySelector('[data-composer] textarea')`, 5000);
    await h.js(set(`document.querySelector('[data-composer] textarea')`, text));
    await h.js(`[...document.querySelectorAll('[data-composer] button')].find(b => b.innerText === 'Add review comment').click()`);
    await h.waitFor("composer closed", `return !document.querySelector('[data-composer]')`, 5000);
  };
  try {
    await h.key("6", { alt: true });
    await h.waitFor("Review view", `return !!document.querySelector('[data-view="review"]')`, 10_000);
    const input = `document.querySelector('input[aria-label="Open a pull request"]')`;
    await h.js(`const i = ${input}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(`${SANDBOX}#${number}`)}); i.dispatchEvent(new Event('input', { bubbles: true }));`);
    await h.js(`${input}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await h.waitFor("PR open", `return document.querySelector('[data-view="review"] h1')?.innerText.includes(${JSON.stringify(`e2e review ${stamp}`)})`, 30_000);
    await h.js(`document.querySelector('[data-review-file="README.md"]').click(); document.querySelector('button[title="Unified"]')?.click()`);
    await h.waitFor("diff rendered", `return !!${row("add", 1)}`, 30_000);
    await press("add", 1);
    await addDraft("New side comment from the e2e.");
    await press("del", 1);
    await sleep(200);
    await press("del", 2, true);
    await h.waitFor("old-side range", `return document.querySelector('[data-composer]')?.innerText.includes('lines 1–2 (base)')`, 5000);
    await addDraft("Old side range from the e2e.");
    await h.js(`document.querySelector('[data-testid="review-submit-open"]').click()`);
    await h.js(set(`document.querySelector('textarea[placeholder^="Leave a summary"]')`, "Review from the Orbit e2e."));
    await h.js(`document.querySelector('[data-testid="review-submit"]').click()`);
    await h.waitFor("threads posted", `return document.querySelectorAll('[data-thread]').length >= 2 && !document.querySelector('[data-draft]')`, 60_000);
    const comments = gh(["api", `repos/${SANDBOX}/pulls/${number}/comments`], clone);
    const right = comments.find((c) => c.body.includes("New side comment"));
    const left = comments.find((c) => c.body.includes("Old side range"));
    if (right?.side !== "RIGHT" || right?.line !== 1 || right?.path !== "README.md") throw new Error(`new-side comment wrong: ${JSON.stringify(right)}`);
    if (left?.side !== "LEFT" || left?.start_line !== 1 || left?.line !== 2) throw new Error(`old-side range wrong: ${JSON.stringify(left)}`);
    const reviews = gh(["api", `repos/${SANDBOX}/pulls/${number}/reviews`], clone);
    if (!reviews.some((r) => r.state === "COMMENTED" && r.body === "Review from the Orbit e2e.")) throw new Error("review summary missing");

    // Reply and resolve on the new-side thread, then mark the file viewed.
    const thread = `[...document.querySelectorAll('[data-thread]')].find(t => t.innerText.includes('New side comment'))`;
    await h.js(`[...${thread}.querySelectorAll('button')].find(b => b.innerText.includes('Reply')).click()`);
    await h.js(set(`${thread}.querySelector('textarea')`, "Reply from the e2e."));
    await h.js(`[...${thread}.querySelectorAll('button')].find(b => b.innerText === 'Reply').click()`);
    await h.until("reply posted", async () => gh(["api", `repos/${SANDBOX}/pulls/${number}/comments`], clone).some((c) => c.in_reply_to_id === right.id && c.body === "Reply from the e2e."), 60_000, 1000);
    await h.waitFor("reply shown", `return !!${thread} && ${thread}.innerText.includes('Reply from the e2e.')`, 30_000);
    await h.js(`[...${thread}.querySelectorAll('button')].find(b => b.innerText === 'Resolve').click()`);
    await h.js(`document.querySelector('[data-testid="review-viewed"]').click()`);
    const [owner, name] = SANDBOX.split("/");
    const query = `query { repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { reviewThreads(first: 10) { nodes { isResolved comments(first: 1) { nodes { body } } } } files(first: 10) { nodes { path viewerViewedState } } } } }`;
    await h.until("resolved and viewed on GitHub", async () => {
      const pr = gh(["api", "graphql", "-f", `query=${query}`], clone).data.repository.pullRequest;
      const resolved = pr.reviewThreads.nodes.find((t) => t.comments.nodes[0]?.body.includes("New side comment"))?.isResolved;
      const viewed = pr.files.nodes.find((f) => f.path === "README.md")?.viewerViewedState === "VIEWED";
      return resolved && viewed;
    }, 60_000, 2000);
    await h.shot("gh-05-review-pr");
  } finally {
    closePr(number, branch);
    await h.key("1", { alt: true });
  }
});

// Leave the sandbox tidy: close anything this run left open.
for (const { number, headRefName } of gh(["pr", "list", "--state", "open", "--json", "number,headRefName"])) closePr(number, headRefName);
await h.finish();
