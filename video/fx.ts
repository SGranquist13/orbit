// DOM effects on top of the real components: the cursor, key/button presses, and a row sliding away.
// All of it is a pure function of t and the current DOM.
import { T, REQUEST } from "./timeline";
import { clamp, easeInOut, lerp, prog } from "./lib";

type Pt = { x: number; y: number };

const root = () => document.getElementById("app-virtual")!;
const all = (sel: string) => [...root().querySelectorAll<HTMLElement>(sel)];
const byText = (sel: string, text: string, exact = false) =>
  all(sel).find((e) => (exact ? e.textContent?.trim() === text : e.textContent?.includes(text)) && e.getBoundingClientRect().width > 0) ?? null;

/** Click/press times shared with the director's state changes. */
export const CLICKS = {
  fixCi: T.ship + 1.4,
  ready: T.ship + 3.9,
  merge: T.ship + 4.8,
  startAll: T.teammates + 3.1,
  inboxKey1: 22.9,
  inboxKey2: 25.0,
};

interface Key {
  t: number;
  find: () => HTMLElement | null;
  dx?: number;
  dy?: number;
  click?: boolean;
  /** Fallback offset from the previous key when the element is not on screen. */
  key: string;
}

const cache = new Map<string, Pt>();

const keys: Key[] = [
  { key: "ship0", t: T.ship + 0.5, find: () => byText("button", "Address comments"), dx: 260, dy: 220 },
  { key: "fixci", t: CLICKS.fixCi, find: () => byText("button", "Fix CI"), click: true },
  { key: "ready", t: CLICKS.ready, find: () => byText("button", "Ready for review"), click: true },
  { key: "merge", t: CLICKS.merge, find: () => byText("button", "Squash & merge"), click: true },
  { key: "merge-out", t: CLICKS.merge + 0.9, find: () => byText("button", "Squash & merge"), dx: 90, dy: 150 },
  { key: "tm0", t: T.teammates + 1.9, find: () => all("textarea")[0] ?? null, dx: 360, dy: 30 },
  { key: "start", t: CLICKS.startAll, find: () => byText("button", "Start all"), click: true },
  { key: "start-out", t: CLICKS.startAll + 0.9, find: () => byText("button", "Start all"), dx: 220, dy: 120 },
];

function resolve(k: Key): Pt | null {
  const el = k.find();
  if (el) {
    const r = el.getBoundingClientRect();
    const p = { x: r.left + r.width / 2 + (k.dx ?? 0), y: r.top + r.height / 2 + (k.dy ?? 0) };
    cache.set(k.key, p);
    return p;
  }
  return cache.get(k.key) ?? null;
}

/** Position of the cursor at t (null = hidden). */
export function cursorAt(t: number): { p: Pt; down: number; click: number } | null {
  if (t < T.ship + 0.5 || (t > T.ship + 6.0 && t < T.teammates + 1.9) || t > T.teammates + 5.6) return null;
  const list = keys.filter((k) => (t < T.teammates ? k.t < T.teammates : k.t >= T.teammates));
  let i = list.findIndex((k) => k.t > t);
  if (i < 0) i = list.length;
  const a = list[Math.max(0, i - 1)], b = list[Math.min(list.length - 1, i)];
  const pa = resolve(a), pb = resolve(b);
  if (!pa || !pb) return pa || pb ? { p: (pa ?? pb)!, down: 0, click: 0 } : null;
  const x = a === b ? 1 : easeInOut(prog(t, a.t + 0.08, b.t));
  const p = { x: lerp(pa.x, pb.x, x), y: lerp(pa.y, pb.y, x) };
  // The click that ends segment [a,b] is `b` when b.click; the one that started it is `a`.
  const clickT = [a, b].filter((k) => k.click && Math.abs(t - k.t) < 0.5).map((k) => t - k.t)[0];
  return { p, down: clickT !== undefined && clickT > -0.06 && clickT < 0.14 ? 1 : 0, click: clickT !== undefined && clickT >= 0 ? clamp(clickT / 0.45) : -1 };
}

/** Class marks for buttons that are being pressed, and the inbox row that slides away. */
export function applyFx(t: number) {
  for (const e of all(".vt-press")) e.classList.remove("vt-press");
  for (const e of all("[data-vt-slide]")) {
    e.style.transform = "";
    e.style.opacity = "";
    e.removeAttribute("data-vt-slide");
  }
  const press = (el: HTMLElement | null, at: number) => {
    if (el && t >= at - 0.02 && t < at + 0.28) el.classList.add("vt-press");
  };
  press(byText("button", "Fix CI", true) ?? byText("button", "Fix CI"), CLICKS.fixCi);
  press(byText("button", "Ready for review"), CLICKS.ready);
  press(byText("button", "Squash & merge"), CLICKS.merge);
  press(byText("button", "Start all"), CLICKS.startAll);

  // Inbox: pressing a number key presses the chip, then the row slides away.
  if (t >= 20 && t < T.ship) {
    for (const [at, n] of [[CLICKS.inboxKey1, "3"], [CLICKS.inboxKey2, "4"]] as const) {
      const chip = all("button").find((b) => b.querySelector("kbd")?.textContent?.trim() === n && b.closest("li"));
      if (chip) press(chip, at);
      const slide = prog(t, at + 0.25, at + 0.7);
      if (slide > 0 && slide < 1) {
        const li = chip?.closest("li") as HTMLElement | null | undefined;
        if (li) {
          li.setAttribute("data-vt-slide", "1");
          li.style.transform = `translateX(${-easeInOut(slide) * 120}px)`;
          li.style.opacity = String(1 - slide);
        }
      }
    }
  }
}

/** Types the request into Chief's composer (and clears it on send), as a function of t. */
export function applyTyping(t: number) {
  const ta = document.querySelector<HTMLTextAreaElement>("[data-teammate-thread] textarea");
  if (!ta) return;
  const a = T.teammates + 0.4, dur = 1.2, send = T.teammates + 1.8;
  const n = t < a ? 0 : t >= send ? 0 : Math.round(REQUEST.length * prog(t, a, a + dur));
  const want = REQUEST.slice(0, n);
  if (ta.value !== want) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, want);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
