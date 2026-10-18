import { useEffect, useRef } from "react";
import { WIPES } from "../timeline";
import { prog, smooth } from "../lib";

// 8x8 Bayer matrix, normalised to 0..1.
const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];
const CELL = 6;

/** Coverage 0..1 of the black dither overlay at time t. */
export function wipeCover(t: number): number {
  for (const [a, b, c] of WIPES) {
    if (t >= a && t <= c) return t < b ? smooth(prog(t, a, b)) : 1 - smooth(prog(t, b, c));
  }
  return 0;
}

/** 1-bit ordered-dither wipe through black. The mask is a pure function of the cover amount. */
export function Wipe({ w, h, t }: { w: number; h: number; t: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cover = wipeCover(t);
  const cw = Math.ceil(w / CELL), ch = Math.ceil(h / CELL);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(cw, ch);
    // A diagonal sweep biases the threshold so the wipe travels rather than fading uniformly.
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const bias = ((x / cw) * 0.35 + (y / ch) * 0.15) - 0.25;
        const th = (BAYER[y & 7][x & 7] + 0.5) / 64 + bias;
        const on = th < cover * 1.5 - 0.1;
        const i = (y * cw + x) * 4;
        img.data[i] = 5; img.data[i + 1] = 5; img.data[i + 2] = 6;
        img.data[i + 3] = on ? 255 : 0;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [cover, cw, ch]);
  if (cover <= 0) return null;
  return <canvas ref={ref} width={cw} height={ch} style={{ position: "absolute", inset: 0, width: w, height: h, imageRendering: "pixelated", zIndex: 50 }} />;
}
