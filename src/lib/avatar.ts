// Teammate avatars: a teammate's `avatar` is "shape:colour" or "shape:colour:expression" (e.g. "bean:3:smile").
// Anything else (legacy glyphs, icon names, empty) falls back to a deterministic pick from a seed.

export const AVATAR_SHAPES = ["circle", "squircle", "triangle", "ghost", "bean", "cloud", "drop", "pill"] as const;
export const AVATAR_EXPRESSIONS = ["dots", "smile", "happy", "focus", "specs", "sleepy"] as const;
export const AVATAR_COLORS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];
export interface AvatarSpec {
  shape: AvatarShape;
  color: number;
  expression: AvatarExpression;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function parseAvatar(avatar: string, seed: string): AvatarSpec {
  const [shape, color, expression] = (avatar || "").trim().toLowerCase().split(":");
  const h = hash(seed || avatar || "?");
  const okShape = (AVATAR_SHAPES as readonly string[]).includes(shape);
  const n = Number(color);
  const okColor = Number.isInteger(n) && n >= 1 && n <= AVATAR_COLORS.length;
  const okExpr = (AVATAR_EXPRESSIONS as readonly string[]).includes(expression ?? "");
  return {
    shape: okShape ? (shape as AvatarShape) : AVATAR_SHAPES[h % AVATAR_SHAPES.length],
    color: okColor ? n : ((h >>> 5) % AVATAR_COLORS.length) + 1,
    expression: okExpr ? (expression as AvatarExpression) : okShape ? "dots" : AVATAR_EXPRESSIONS[(h >>> 9) % 2],
  };
}

export function formatAvatar(a: AvatarSpec) {
  return `${a.shape}:${a.color}:${a.expression}`;
}

export function randomAvatar(): AvatarSpec {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
  return { shape: pick(AVATAR_SHAPES), color: pick(AVATAR_COLORS), expression: pick(AVATAR_EXPRESSIONS) };
}
