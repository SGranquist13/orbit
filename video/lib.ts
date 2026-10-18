// Pure helpers: easing, interpolation, seeded random. Nothing here reads the clock.
export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
/** 0..1 progress of t within [a,b]. */
export const prog = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const smooth = (x: number) => x * x * (3 - 2 * x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeOutBack = (x: number) => {
  const c1 = 1.4, c3 = c1 + 1;
  const y = clamp(x) - 1;
  return 1 + c3 * y * y * y + c1 * y * y;
};

/** mulberry32: a small seeded PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 1D value noise in -1..1. */
export function noise1(x: number, seed = 1) {
  const i = Math.floor(x), f = x - i;
  const h = (n: number) => rng(n * 7919 + seed * 104729)() * 2 - 1;
  return lerp(h(i), h(i + 1), smooth(f));
}

export type Aspect = "4x5" | "16x9";
export const SIZES: Record<Aspect, { w: number; h: number }> = { "4x5": { w: 1080, h: 1350 }, "16x9": { w: 1920, h: 1080 } };

export const DURATION = 45;
export const FPS = 30;
