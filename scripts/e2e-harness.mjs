// Shared driver for Orbit's real-app e2e scripts: launches the debug build with WebView2 remote
// debugging, talks CDP, and records step results. Each scenario script creates one harness.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves the scratch dir. Default: <tmpdir>/<name> (outside any git repo); an explicit CLI arg
 * overrides. Aborts when the dir is inside a git work tree: git would resolve "plain" folders in
 * it to the enclosing repo (e.g. Orbit's own), and Orbit would create real worktrees of that repo.
 */
export function resolveScratch(arg, name) {
  const scratch = path.resolve(arg ?? path.join(os.tmpdir(), name));
  assertOutsideGit(scratch);
  return scratch;
}

export function assertOutsideGit(dir) {
  let probe = dir;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  let top = "";
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: probe, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return; // not a work tree (or git missing): fine
  }
  if (top) throw new Error(`e2e scratch dir ${dir} is inside the git work tree ${top}; pass a scratch path outside any repo (default: the OS temp dir)`);
}

/**
 * Kills leftovers of an earlier run on the same scratch dir (a crashed run leaves the app, WebView2 and
 * agent processes holding files there, so clearing the dir fails with EPERM). WebView2 processes are found by
 * their `--user-data-dir` (which lives in the scratch dir); the orbit.exe that owns them is their parent.
 */
export function killLeftovers(scratch) {
  if (process.platform !== "win32") return;
  const script = `
    $s = $env:ORBIT_E2E_SCRATCH
    $procs = Get-CimInstance Win32_Process
    $web = @($procs | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($s, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    $ids = @($web | ForEach-Object { $_.ProcessId })
    $ids += @($procs | Where-Object { $_.Name -in @('orbit.exe', 'claude.exe', 'codex.exe', 'node.exe') -and $_.CommandLine -and $_.CommandLine.IndexOf($s, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId })
    foreach ($w in $web) { $p = $procs | Where-Object { $_.ProcessId -eq $w.ParentProcessId -and $_.Name -eq 'orbit.exe' }; if ($p) { $ids += $p.ProcessId } }
    $ids | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800`;
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ORBIT_E2E_SCRATCH: scratch }, stdio: "ignore", timeout: 30_000 });
  } catch {}
}

/**
 * Page errors that fail the step they happen in (React key / render-loop warnings and the like). Known-harmless
 * ones can be listed in HARMLESS_PAGE_ERRORS; none have shown up so far.
 */
const FATAL_PAGE_ERROR = /Warning: |same key|Maximum update depth|Cannot update a component/;
const HARMLESS_PAGE_ERRORS = [];

export function createHarness({ scratch, port = 9333, only }) {
  const exe = path.join(root, "src-tauri", "target", "debug", "orbit.exe");
  const home = path.join(scratch, "home");
  const shots = path.join(scratch, "shots");
  const results = [];
  const pageErrors = [];
  const pending = new Map();
  let app;
  let ws;
  let nextId = 0;

  // ── App process ─────────────────────────────────────────────
  async function launch() {
    app = spawn(exe, [], {
      // Own WebView2 profile: otherwise a running Orbit (the user's own window) owns the shared browser
      // process, the test window joins it, and the debugging port never opens.
      env: {
        ...process.env,
        ORBIT_HOME: home,
        WEBVIEW2_USER_DATA_FOLDER: path.join(scratch, "webview2"),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const page = pages.find((p) => p.type === "page" && p.url.includes("localhost:1420"));
        if (page) {
          await connect(page.webSocketDebuggerUrl);
          await cdp("Runtime.enable");
          return;
        }
      } catch {}
      await sleep(500);
    }
    throw new Error("app did not expose a debuggable page (is `bun run dev` running?)");
  }

  async function quit() {
    app?.kill();
    await sleep(1500);
    killLeftovers(scratch);
  }

  // ── CDP ─────────────────────────────────────────────────────
  function connect(url) {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url);
      ws.onopen = resolve;
      ws.onerror = reject;
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
        if (msg.method === "Runtime.exceptionThrown") {
          const d = msg.params.exceptionDetails;
          pageErrors.push(d.exception?.description ?? d.text);
        } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
          pageErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
        }
      };
    });
  }

  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function js(expr) {
    const r = await cdp("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async function waitFor(desc, expr, timeoutMs = 90_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await js(expr).catch(() => null);
      if (v) return v;
      await sleep(400);
    }
    throw new Error(`timed out waiting for: ${desc}`);
  }

  /** Polls an async Node-side check (e.g. a `gh` query) until it returns a truthy value. */
  async function until(desc, fn, timeoutMs = 90_000, everyMs = 3000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      try {
        last = await fn();
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(everyMs);
    }
    throw new Error(`timed out waiting for: ${desc}${last ? ` (last: ${String(last).slice(0, 160)})` : ""}`);
  }

  async function key(k, { ctrl = false, shift = false, alt = false } = {}) {
    const codes = { Enter: 13, Escape: 27, Tab: 9, "`": 192 };
    const named = { "`": "Backquote" };
    const vk = codes[k] ?? k.toUpperCase().charCodeAt(0);
    const code = named[k] ?? (k.length === 1 ? `Key${k.toUpperCase()}` : k);
    const base = { key: k, code, windowsVirtualKeyCode: vk, modifiers: (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0) };
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  const type = (text) => cdp("Input.insertText", { text });

  async function shot(name) {
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  }

  /** Calls a Rust command in the real app; rejections become Errors carrying the backend's message. */
  async function invoke(cmd, args = {}) {
    const r = await js(`try { return { ok: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}) }; }
      catch (e) { return { err: String(e) }; }`);
    if (r && "err" in r) throw new Error(r.err);
    return r?.ok;
  }

  /**
   * Native confirm dialogs can't be clicked over CDP, and Tauri's `invoke` is non-writable, so
   * `confirmAction` (src/lib/confirm.ts) honours this page global instead. Survives until reload.
   */
  async function autoConfirm(answer = true) {
    await js(`window.__ORBIT_AUTOCONFIRM__ = ${answer}; return true;`);
  }

  /** opts.always: runs even when a single step is selected (cheap prerequisites). */
  async function step(name, fn, opts = {}) {
    if (only && only !== name && !opts.always) return;
    const t0 = Date.now();
    const errorsBefore = pageErrors.length;
    try {
      await fn();
      const bad = pageErrors.slice(errorsBefore).map(String).filter((e) => FATAL_PAGE_ERROR.test(e) && !HARMLESS_PAGE_ERRORS.some((h) => h.test(e)));
      if (bad.length) throw new Error(`page error during the step: ${bad[0].split(/\r?\n/)[0].slice(0, 300)}`);
      results.push({ name, ok: true, ms: Date.now() - t0 });
      console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      results.push({ name, ok: false, error: e.message, pageErrors: pageErrors.slice(-5) });
      console.log(`  ✗ ${name}: ${e.message}`);
      for (const err of pageErrors.splice(0)) console.log(`      page error: ${String(err).split("\n").slice(0, 4).join(" | ")}`);
      await shot(`FAIL-${name}`).catch(() => {});
    }
  }

  async function finish() {
    await quit();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
    fs.writeFileSync(path.join(scratch, "results.json"), JSON.stringify(results, null, 2));
    process.exit(failed.length ? 1 : 0);
  }

  return { home, launch, quit, cdp, js, waitFor, until, key, type, shot, invoke, autoConfirm, step, finish, results };
}

// ── UI helpers shared by scenarios ───────────────────────────
/** Number of completed turns rendered in the open workspace. */
export const TURN_ENDS = `return document.querySelectorAll('.dither-rule.flex-1').length`;

export function uiHelpers(h) {
  /**
   * Creates a workspace through the dialog and resolves once it exists and is the one on screen
   * (worktree creation takes a few seconds; until then the previous workspace is still showing).
   */
  async function newWorkspace({ prompt, agent = "claude", model, profile }) {
    const known = new Set((await h.invoke("list_workspaces")).map((w) => w.id));
    const dialog = `return !!document.querySelector('textarea[placeholder^="Describe the task"]')`;
    // A CDP key event can be lost right after a reload or a focus change; retry once through the same
    // window handler (App.tsx) with the page's focus cleared, and say what was on screen if it still fails.
    await h.key("n", { ctrl: true });
    if (!(await h.until("new workspace dialog (key)", async () => h.js(dialog), 3000, 250).catch(() => false))) {
      await h.js(`document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true })); return true`);
    }
    await h.waitFor("new workspace dialog", dialog, 5000).catch(async (e) => {
      const seen = await h.js(`return { active: document.activeElement?.tagName, overlays: [...document.querySelectorAll('.fixed.inset-0')].map((e) => e.innerText.slice(0, 40)), h1: document.querySelector('h1')?.innerText }`);
      throw new Error(`${e.message} (page: ${JSON.stringify(seen)})`);
    });
    await h.js(`document.querySelector('textarea[placeholder^="Describe the task"]').focus()`);
    await h.type(prompt);
    await h.js(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(agent === "codex" ? "Codex" : "Claude")})?.click()`);
    if (profile) await h.js(`document.querySelector('button[data-profile=${JSON.stringify(profile)}]')?.click()`);
    if (model) {
      await h.js(`
        const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === ${JSON.stringify(model)}));
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(model)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));`);
    }
    await h.key("Enter", { ctrl: true });
    const ws = await h.until("new workspace created", async () => (await h.invoke("list_workspaces")).find((w) => !known.has(w.id)), 60_000, 500);
    await h.waitFor("new workspace on screen", `return document.querySelector('header h1')?.innerText === ${JSON.stringify(ws.name)}`, 15_000);
    return ws;
  }

  /** Opens the Ship panel if it isn't already (its open state persists between runs). */
  async function openShip() {
    const isOpen = `return [...document.querySelectorAll('aside')].some(a => /CHANGES/i.test(a.innerText))`;
    if (!(await h.js(isOpen))) await h.js(`[...document.querySelectorAll('header button')].find(b => /Ship/.test(b.innerText))?.click()`);
    await h.waitFor("Ship panel open", isOpen, 5000);
  }

  /** Runs a pinned skill chip by its label (chips render uppercase). */
  async function clickChip(label) {
    await h.js(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(label.toUpperCase())}).click()`);
    // Chips open a preview first; confirm it.
    await h.waitFor("skill preview", `return !!document.querySelector('[data-skill-preview]')`, 5000);
    await h.js(`[...document.querySelectorAll('[data-skill-preview] button')].find(b => /run in this workspace/i.test(b.innerText)).click()`);
  }

  /** Waits until the open workspace has more completed turns than `before`. */
  async function waitTurn(before, timeoutMs = 240_000) {
    await h.waitFor("turn completed", `${TURN_ENDS} > ${before}`, timeoutMs);
  }

  const lastMessage = () => h.js(`return [...document.querySelectorAll('.prose-chat')].at(-1)?.innerText ?? ''`);

  return { newWorkspace, openShip, clickChip, waitTurn, lastMessage };
}
