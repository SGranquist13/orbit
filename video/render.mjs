// Renders the launch film: headless Edge over CDP, one screenshot per frame, then ffmpeg.
//
//   node video/render.mjs                         both aspects, full film
//   node video/render.mjs --aspect 4x5            one aspect
//   node video/render.mjs --stills 2,7,12 --aspect 16x9   stills only -> video/out/stills/
//
// Needs the video dev server on :1430 (`bun run video:dev`); it is started here if nothing answers.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "video", "out");
const EDGE = process.env.EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 1430;
const DEBUG_PORT = 9444;
const FPS = 30;
const DURATION = 45;
const SIZES = { "4x5": [1080, 1350], "16x9": [1920, 1080] };
const POSTER_T = 17.5;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const aspects = opt("aspect") ? [opt("aspect")] : ["4x5", "16x9"];
const stills = opt("stills")?.split(",").map(Number);
const from = Number(opt("from", 0));
const to = Number(opt("to", DURATION * FPS));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureServer() {
  try {
    await fetch(`http://localhost:${PORT}/`);
    return null;
  } catch {}
  const proc = spawn("bunx", ["vite", "--config", "video/vite.config.ts", "--port", String(PORT)], { cwd: root, stdio: "ignore", shell: true });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${PORT}/`);
      return proc;
    } catch {}
    await sleep(500);
  }
  throw new Error("video dev server did not start");
}

async function launchEdge(profile) {
  const proc = spawn(
    EDGE,
    [
      "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--mute-audio",
      "--force-device-scale-factor=1", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--no-first-run", "--no-default-browser-check", "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      const page = pages.find((p) => p.type === "page");
      if (page) return { proc, wsUrl: page.webSocketDebuggerUrl };
    } catch {}
    await sleep(300);
  }
  throw new Error("Edge did not expose a debuggable page");
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const logs = [];
  let id = 0;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      logs.push("EXC " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      logs.push(msg.params.type + " " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    }
  };
  const open = new Promise((r) => (ws.onopen = r));
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { open, cdp, logs, close: () => ws.close() };
}

async function renderAspect(aspect, edgeInfo) {
  const [w, h] = SIZES[aspect];
  const c = client(edgeInfo.wsUrl);
  await c.open;
  await c.cdp("Runtime.enable");
  await c.cdp("Page.enable");
  await c.cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await c.cdp("Page.navigate", { url: `http://localhost:${PORT}/?aspect=${aspect}&seed=launch` });
  for (let i = 0; i < 120; i++) {
    const r = await c.cdp("Runtime.evaluate", { expression: "window.__ready === true", returnByValue: true });
    if (r.result.value) break;
    await sleep(500);
    if (i === 119) throw new Error("page never became ready:\n" + c.logs.join("\n"));
  }

  const shot = async (t, file) => {
    const r = await c.cdp("Runtime.evaluate", { expression: `window.__seek(${t})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`seek(${t}): ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    const s = await c.cdp("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(s.data, "base64"));
  };

  if (stills) {
    const dir = path.join(outDir, "stills");
    fs.mkdirSync(dir, { recursive: true });
    for (const t of stills) {
      const file = path.join(dir, `${aspect}-${String(t).replace(".", "_")}.png`);
      await shot(t, file);
      console.log(file);
    }
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `orbit-video-${aspect}-`));
    const frames = Math.min(to, DURATION * FPS);
    const t0 = Date.now();
    for (let f = from; f < frames; f++) {
      await shot(f / FPS, path.join(tmp, `${String(f).padStart(5, "0")}.png`));
      if (f % 60 === 0) console.log(`${aspect} frame ${f}/${frames} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const mp4 = path.join(outDir, `orbit-launch-${aspect}.mp4`);
    execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-i", path.join(tmp, "%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", mp4], { stdio: "inherit" });
    await shot(POSTER_T, path.join(outDir, `orbit-launch-${aspect}-poster.png`));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log("wrote", mp4);
  }
  if (c.logs.length) console.log("page log:\n" + [...new Set(c.logs)].slice(0, 20).join("\n"));
  c.close();
}

const server = await ensureServer();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-video-edge-"));
const edge = await launchEdge(profile);
try {
  for (const a of aspects) await renderAspect(a, edge);
} finally {
  edge.proc.kill();
  server?.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
