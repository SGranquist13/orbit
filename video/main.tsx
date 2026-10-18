import React from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";
import "./video.css";
import { installMockBackend } from "../src/lib/mock";
import { installTheme } from "../src/lib/theme";
import { installDitherTiles } from "../src/lib/dither";
import { useApp } from "../src/stores/app";
import { useClock } from "./clock";
import { Stage } from "./Stage";
import { direct, prepareDirector, overrides } from "./director";
import { applyTyping } from "./fx";
import { SIZES, type Aspect } from "./lib";

const params = new URLSearchParams(location.search);
const aspect: Aspect = params.get("aspect") === "4x5" ? "4x5" : "16x9";

declare global {
  interface Window {
    __seek: (t: number) => Promise<void>;
    __ready: boolean;
    __pending: number;
  }
}

const viewMarker = (t: number) => (t >= 33 && t < 39 ? "[data-teammate-thread]" : t >= 20 && t < 26 ? "[data-inbox-row],ul.mx-auto" : null);
const postFx = (t: number) => applyTyping(t);
const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function boot() {
  installMockBackend();
  // Count in-flight IPC calls (the mock answers asynchronously) so a seek can wait until the UI has settled.
  window.__pending = 0;
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (...a: unknown[]) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const inv = internals.invoke.bind(internals);
  internals.invoke = (...a: unknown[]) => {
    const cmd = a[0] as string;
    const o = overrides[cmd]?.((a[1] ?? {}) as Record<string, unknown>);
    if (o !== undefined) return Promise.resolve(o);
    window.__pending++;
    return inv(...a).finally(() => { window.__pending--; });
  };
  installTheme();
  installDitherTiles();
  document.documentElement.dataset.theme = "dark";
  useClock.setState({ aspect });
  const { w, h } = SIZES[aspect];
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  flushSync(() => root.render(<Stage w={w} h={h} aspect={aspect} />));
  await prepareDirector(aspect);
  await document.fonts.ready;

  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await raf();
      if (window.__pending === 0) break;
      await sleep(8);
    }
    await raf();
    await raf();
  };

  window.__seek = async (t: number) => {
    // The director may need two passes: the first applies store state, async IPC settles, the second re-asserts it.
    await direct(t, aspect);
    flushSync(() => useClock.setState({ t }));
    await settle();
    await direct(t, aspect);
    flushSync(() => useClock.setState({ t }));
    await settle();
    // Lazy views (inbox, teammates) may still be loading on first sight.
    for (let i = 0; i < 100; i++) {
      const want = viewMarker(t);
      if (!want || document.querySelector(want)) break;
      await sleep(30);
    }
    await settle();
    postFx(t);
    await settle();
    await document.fonts.ready;
  };
  window.__ready = true;
  const t0 = Number(params.get("t") ?? 0);
  void window.__seek(t0);
  void useApp;
}

void boot();
