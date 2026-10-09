// 1-bit ordered (Bayer 8×8) dithering, rendered to canvas and used as CSS masks so
// the masked element's background colour (a theme token) shows through the pixels.
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "./cn";

const BAYER = (() => {
  // Recursive construction of the 8×8 Bayer index matrix (values 0..63).
  let m = [[0]];
  while (m.length < 8) {
    const n = m.length;
    const next = Array.from({ length: n * 2 }, () => new Array<number>(n * 2));
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    m = next;
  }
  return m;
})();

export type DitherShape = "x" | "y" | "radial" | "comet";

export interface DitherOptions {
  w: number;
  h: number;
  shape: DitherShape;
  /** Coverage at the start (left / top / centre), 0..1. */
  from?: number;
  /** Coverage at the end (right / bottom / edge), 0..1. */
  to?: number;
  /** Size of one dither pixel in CSS px. */
  cell?: number;
}

const cache = new Map<string, string>();

/** PNG data URL: opaque where a dither pixel is on, transparent elsewhere. */
export function ditherMask({ w, h, shape, from = 1, to = 0, cell = 2 }: DitherOptions): string {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const key = [w, h, shape, from, to, cell, dpr].join("|");
  const hit = cache.get(key);
  if (hit) return hit;

  const px = Math.max(1, Math.round(cell * dpr));
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  const cols = Math.ceil(W / px);
  const rows = Math.ceil(H / px);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = (c + 0.5) / cols;
      const v = (r + 0.5) / rows;
      let t: number;
      if (shape === "x") t = u;
      else if (shape === "y") t = v;
      else if (shape === "comet") t = Math.abs(u - 0.6) / 0.6; // bright core just right of centre
      else t = Math.min(1, Math.hypot(u - 0.5, v - 0.5) * 2);
      const coverage = from + (to - from) * Math.min(1, Math.max(0, t));
      if (coverage > (BAYER[r % 8][c % 8] + 0.5) / 64) ctx.fillRect(c * px, r * px, px, px);
    }
  }
  const url = canvas.toDataURL("image/png");
  cache.set(key, url);
  return url;
}

/** Generates the fixed-size tiles the CSS utilities (.dither-fade-x, .dither-sweep, …) use. */
export function installDitherTiles() {
  const root = document.documentElement.style;
  const set = (name: string, url: string) => root.setProperty(name, `url("${url}")`);
  set("--dither-fade-x", ditherMask({ w: 96, h: 32, shape: "x", from: 0.9, to: 0 }));
  set("--dither-comet", ditherMask({ w: 140, h: 32, shape: "comet", from: 0.75, to: 0 }));
}

/**
 * A dithered gradient layer that fills its positioned parent and colours itself with
 * `currentColor` (set text-accent, text-line, … on it). Re-renders on resize.
 */
export function Dither({
  shape,
  from,
  to,
  cell = 2,
  className,
}: Omit<DitherOptions, "w" | "h"> & { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string>();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setUrl(ditherMask({ w: Math.round(width), h: Math.round(height), shape, from, to, cell }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [shape, from, to, cell]);

  return (
    <span
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 bg-current", className)}
      style={url ? { maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")`, maskSize: "100% 100%" } : { opacity: 0 }}
    />
  );
}
