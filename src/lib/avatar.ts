// Teammate avatars: a teammate's `avatar` is "shape:colour[:expression[:badge[:accessory]]]" (e.g. "squircle:3:dots:code:none").
// Empty or "none" skips a slot. Old values ("bean:3:smile") keep working; anything else (legacy glyphs, icon names, empty)
// falls back to a deterministic pick from a seed.

export const AVATAR_SHAPES = [
  "circle",
  "triangle",
  "squircle",
  "hexagon",
  "cloud",
  "dome",
  "diamond",
  "ghost",
  "flower",
  "badge",
  "cat",
  "robot",
  "leaf",
  "planet",
] as const;
/** Still drawn (old saved avatars), no longer offered in the picker. */
export const LEGACY_SHAPES = ["bean", "drop", "pill"] as const;
export const AVATAR_EXPRESSIONS = ["dots", "smile", "happy", "focus", "specs", "sleepy"] as const;
export const AVATAR_COLORS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export const AVATAR_BADGES = ["code", "search", "shield", "message-square", "file-text", "play", "check", "git-branch", "bug", "lightbulb"] as const;
export const AVATAR_ACCESSORIES = ["dot", "glasses", "lens", "sparkle", "antenna"] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number] | (typeof LEGACY_SHAPES)[number];
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];
export type AvatarBadge = (typeof AVATAR_BADGES)[number];
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number];
export interface AvatarSpec {
  shape: AvatarShape;
  color: number;
  expression: AvatarExpression;
  badge: AvatarBadge | null;
  accessory: AvatarAccessory | null;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const ALL_SHAPES: readonly string[] = [...AVATAR_SHAPES, ...LEGACY_SHAPES];

export function parseAvatar(avatar: string, seed: string): AvatarSpec {
  const [shape, color, expression, badge, accessory] = (avatar || "").trim().toLowerCase().split(":");
  const h = hash(seed || avatar || "?");
  const okShape = ALL_SHAPES.includes(shape);
  const n = Number(color);
  const okColor = Number.isInteger(n) && n >= 1 && n <= AVATAR_COLORS.length;
  const okExpr = (AVATAR_EXPRESSIONS as readonly string[]).includes(expression ?? "");
  return {
    shape: okShape ? (shape as AvatarShape) : AVATAR_SHAPES[h % AVATAR_SHAPES.length],
    color: okColor ? n : ((h >>> 5) % AVATAR_COLORS.length) + 1,
    expression: okExpr ? (expression as AvatarExpression) : okShape ? "dots" : AVATAR_EXPRESSIONS[(h >>> 9) % 2],
    badge: (AVATAR_BADGES as readonly string[]).includes(badge ?? "") ? (badge as AvatarBadge) : null,
    accessory: (AVATAR_ACCESSORIES as readonly string[]).includes(accessory ?? "") ? (accessory as AvatarAccessory) : null,
  };
}

export function formatAvatar(a: AvatarSpec) {
  return `${a.shape}:${a.color}:${a.expression}:${a.badge ?? "none"}:${a.accessory ?? "none"}`;
}

export function randomAvatar(): AvatarSpec {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
  return {
    shape: pick(AVATAR_SHAPES),
    color: pick(AVATAR_COLORS),
    expression: "dots",
    badge: Math.random() < 0.5 ? pick(AVATAR_BADGES) : null,
    accessory: Math.random() < 0.3 ? pick(AVATAR_ACCESSORIES) : null,
  };
}
