// The one deliberately colourful element: teammate avatars are little blob characters (see CLAUDE.md, Conventions).
import { Bug, Check, Code, FileText, GitBranch, Lightbulb, MessageSquare, Play, Search, Shield } from "lucide-react";
import { useId } from "react";
import { portraitUrl, parseAvatar, type AvatarBadge, type AvatarShape, type AvatarSpec } from "../lib/avatar";
import { cn } from "../lib/cn";
import { useApp } from "../stores/app";

interface Face {
  /** Body drawn with the given paint (a gradient url); `behind` is drawn first (planet ring). */
  body: (paint: string) => React.ReactNode;
  behind?: (id: string) => React.ReactNode;
  front?: React.ReactNode;
  /** Eye centre y and half the distance between the eyes (viewBox 40x40). */
  ey: number;
  dx: number;
  /** Robot: dark visor with pale eyes. */
  visor?: boolean;
}

/** A smooth blob with `n` lobes (wavy badge, star-flower). */
function lobes(n: number, base: number, amp: number) {
  const pts: string[] = [];
  for (let i = 0; i <= 72; i++) {
    const t = (i / 72) * Math.PI * 2;
    const r = base + amp * Math.cos(n * t);
    pts.push(`${i ? "L" : "M"}${(20 + r * Math.cos(t)).toFixed(2)} ${(20 + r * Math.sin(t)).toFixed(2)}`);
  }
  return pts.join("") + "z";
}
const FLOWER = lobes(6, 14.5, 2.6);
const WAVY = lobes(12, 16, 1.5);

const FACES: Record<AvatarShape, Face> = {
  circle: { body: (p) => <circle cx="20" cy="20" r="17.5" fill={p} />, ey: 18, dx: 6.5 },
  squircle: { body: (p) => <rect x="3.5" y="3.5" width="33" height="33" rx="12" fill={p} />, ey: 18, dx: 7 },
  triangle: {
    body: (p) => <path fill={p} d="M20 4.5c2.4 0 3.9 1.5 5.2 3.9l10 19.6c2.3 4.6-.6 8.5-5 8.5H9.8c-4.4 0-7.3-3.9-5-8.5l10-19.6C16.1 6 17.6 4.5 20 4.5z" />,
    ey: 25,
    dx: 5.5,
  },
  hexagon: { body: (p) => <polygon points="20,6 32.5,13 32.5,27 20,34 7.5,27 7.5,13" fill={p} stroke={p} strokeWidth="6" strokeLinejoin="round" />, ey: 20, dx: 6.5 },
  cloud: {
    body: (p) => <path fill={p} d="M12.5 33C7 33 3.5 29.5 3.5 25c0-3.6 2.4-6.6 5.8-7.5C10 11.8 14.5 7.5 20.5 7.5c5.5 0 9.8 3.7 10.8 8.8 3.1.8 5.2 3.6 5.2 6.9 0 4.2-3.5 7.8-8 7.8z" />,
    ey: 22,
    dx: 7,
  },
  dome: { body: (p) => <path fill={p} d="M3.5 31c0-11 7-22.5 16.5-22.5S36.5 20 36.5 31c0 2-1.2 3-3 3h-27c-1.8 0-3-1-3-3z" />, ey: 24, dx: 6.5 },
  diamond: { body: (p) => <rect x="8" y="8" width="24" height="24" rx="6" transform="rotate(45 20 20)" fill={p} />, ey: 19, dx: 6 },
  ghost: {
    body: (p) => <path fill={p} d="M5.5 20C5.5 11 12 4.5 20 4.5S34.5 11 34.5 20v14.5c0 1.2-1.2 1.8-2.2.9l-3.6-3.2-3.7 3.3a1.8 1.8 0 0 1-2.4 0L20 32.2l-2.6 3.3a1.8 1.8 0 0 1-2.4 0l-3.7-3.3-3.6 3.2c-1 .9-2.2.3-2.2-.9z" />,
    ey: 19,
    dx: 6.5,
  },
  flower: { body: (p) => <path fill={p} d={FLOWER} stroke={p} strokeWidth="3" strokeLinejoin="round" />, ey: 20, dx: 6.5 },
  badge: { body: (p) => <path fill={p} d={WAVY} />, ey: 20, dx: 6.5 },
  cat: {
    body: (p) => <path fill={p} d="M6 33c0-1.5 0-9 0-17 0-1.4.3-2.6 1-3.7L9.2 5c.3-1.3 1.7-1.6 2.5-.7l3.3 3.7c3.3-.9 6.7-.9 10 0l3.3-3.7c.8-.9 2.2-.6 2.5.7l2.2 7.3c.7 1.1 1 2.3 1 3.7v17c0 2-1.5 3.5-3.5 3.5h-21C7.5 36.5 6 35 6 33z" />,
    ey: 21,
    dx: 6.5,
  },
  robot: {
    body: (p) => (
      <>
        <rect x="19" y="4.5" width="2" height="6" fill={p} />
        <circle cx="20" cy="4.5" r="2.4" fill={p} />
        <rect x="4" y="10" width="32" height="26" rx="13" fill={p} />
      </>
    ),
    ey: 23,
    dx: 6,
    visor: true,
  },
  leaf: { body: (p) => <path fill={p} d="M6.5 30C4.5 22 10.5 6 21 4.5c6-.5 9.5 3 10.5 9 .9 5.200.5 12-3 18-3 5-9 5.500-13 3.500-4.500-.5-7.500-2.500-9-5z" />, ey: 21, dx: 6 },
  planet: {
    behind: (id) => <path d="M1.700 21.500a18.500 5.200 0 0 1 36.600 0" transform="rotate(-16 20 21.500)" fill="none" stroke={`url(#${id}-ring)`} strokeWidth="2.200" strokeLinecap="round" />,
    body: (p) => <circle cx="20" cy="20" r="14.500" fill={p} />,
    front: <path d="M1.700 21.500a18.500 5.200 0 0 0 36.600 0" transform="rotate(-16 20 21.500)" fill="none" stroke="var(--avatar-ring)" strokeWidth="2.200" strokeLinecap="round" />,
    ey: 17,
    dx: 6,
  },
  // legacy shapes (old saved avatars)
  bean: {
    body: (p) => <path fill={p} d="M9 14.5C9 8 14 4 21 4.5c8 .6 13 6 12.5 14.5-.4 9-5.5 16.5-14 16.5C11 35.5 6 31 6.5 24c.2-3.7 2.5-6 2.5-9.5z" />,
    ey: 20,
    dx: 6.5,
  },
  drop: { body: (p) => <path fill={p} d="M20 3.5S6.5 17.5 6.5 25.5a13.5 13.5 0 0 0 27 0C33.5 17.5 20 3.5 20 3.5z" />, ey: 26, dx: 6 },
  pill: { body: (p) => <rect x="9" y="3.5" width="22" height="33" rx="11" fill={p} />, ey: 16, dx: 5.5 },
};

const INK = "var(--avatar-ink)";

/** Tall, slightly tilted oval eyes. */
function Oval({ cx, cy, rot, fill, shine = true }: { cx: number; cy: number; rot: number; fill: string; shine?: boolean }) {
  return (
    <g transform={`rotate(${rot} ${cx} ${cy})`}>
      <ellipse cx={cx} cy={cy} rx="1.9" ry="3.1" fill={fill} />
      {shine && <circle cx={cx + 0.5} cy={cy - 1.1} r="0.7" fill="#fff" opacity="0.8" />}
    </g>
  );
}

function Eyes({ spec, face }: { spec: AvatarSpec; face: Face }) {
  const { ey, dx } = face;
  const l = 20 - dx;
  const r = 20 + dx;
  if (face.visor)
    return (
      <>
        <rect x="9" y={ey - 6.500} width="22" height="13" rx="6.500" fill={INK} />
        <g className="avatar-eyes">
          <ellipse cx={l + 0.5} cy={ey} rx="2" ry="3" fill="#dfe3f2" />
          <ellipse cx={r - 0.5} cy={ey} rx="2" ry="3" fill="#dfe3f2" />
        </g>
      </>
    );
  switch (spec.expression) {
    case "happy":
      return (
        <g className="avatar-eyes" fill="none" stroke={INK} strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round">
          <path d={`M${l - 2.5} ${ey + 1}q2.500-4.200 5 0`} />
          <path d={`M${r - 2.5} ${ey + 1}q2.500-4.200 5 0`} />
        </g>
      );
    case "sleepy":
      return (
        <g className="avatar-eyes" fill="none" stroke={INK} strokeWidth="2.400" strokeLinecap="round">
          <path d={`M${l - 2.3} ${ey}h4.600`} />
          <path d={`M${r - 2.3} ${ey}h4.600`} />
        </g>
      );
    case "specs":
      return (
        <g className="avatar-eyes" fill="none" stroke={INK} strokeWidth="2">
          <circle cx={l} cy={ey} r="3.900" />
          <circle cx={r} cy={ey} r="3.900" />
          <path d={`M${l + 3.9} ${ey}h${dx * 2 - 7.8}`} strokeLinecap="round" />
          <circle cx={l + 0.6} cy={ey + 0.3} r="1.300" fill={INK} stroke="none" />
          <circle cx={r + 0.6} cy={ey + 0.3} r="1.300" fill={INK} stroke="none" />
        </g>
      );
    default:
      return (
        <g className="avatar-eyes">
          <Oval cx={l} cy={ey} rot={-12} fill={INK} />
          <Oval cx={r} cy={ey} rot={-12} fill={INK} />
        </g>
      );
  }
}

function Extras({ spec, face }: { spec: AvatarSpec; face: Face }) {
  if (face.visor) return null;
  const { ey, dx } = face;
  const my = ey + 6.5;
  if (spec.expression === "smile" || spec.expression === "happy")
    return (
      <>
        <path d={`M17.2 ${my}q2.800 3 5.600 0`} fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
        <ellipse cx={20 - dx - 3} cy={my - 0.5} rx="2.200" ry="1.400" fill="#ff7a93" opacity="0.5" />
        <ellipse cx={20 + dx + 3} cy={my - 0.5} rx="2.200" ry="1.400" fill="#ff7a93" opacity="0.5" />
      </>
    );
  if (spec.expression === "focus")
    return (
      <g fill="none" stroke={INK} strokeWidth="2.200" strokeLinecap="round">
        <path d={`M${20 - dx - 3.2} ${ey - 5.8}l6 2`} />
        <path d={`M${20 + dx + 3.2} ${ey - 5.8}l-6 2`} />
        <path d={`M18 ${my + 0.5}h4`} strokeWidth="2" />
      </g>
    );
  if (spec.expression === "sleepy") return <ellipse cx="20" cy={my + 0.5} rx="1.600" ry="1.300" fill={INK} opacity="0.8" />;
  if (spec.expression === "specs") return <path d={`M18 ${my}q2 1.600 4 0`} fill="none" stroke={INK} strokeWidth="1.800" strokeLinecap="round" />;
  return null;
}

function Accessory({ spec, face }: { spec: AvatarSpec; face: Face }) {
  const { ey, dx } = face;
  switch (spec.accessory) {
    case "dot":
      return <circle cx="31.500" cy="7.500" r="4" fill="var(--avatar-alert)" />;
    case "sparkle":
      return <path d="M33.500 1c.6 3.200 1.800 4.500 5 5.500-3.200 1-4.400 2.300-5 5.500-.6-3.200-1.800-4.500-5-5.500 3.200-1 4.400-2.300 5-5.500z" fill="var(--avatar-spark)" />;
    case "glasses":
      return (
        <g fill="none" stroke={INK} strokeWidth="1.800">
          <circle cx={20 - dx} cy={ey} r="4.800" />
          <circle cx={20 + dx} cy={ey} r="4.800" />
          <path d={`M${20 - dx + 4.8} ${ey}h${dx * 2 - 9.6}`} strokeLinecap="round" />
        </g>
      );
    case "lens":
      return (
        <g>
          <ellipse cx="6.500" cy={ey + 2} rx="4.800" ry="6" fill="var(--avatar-badge)" />
          <ellipse cx="6.800" cy={ey + 2} rx="2.200" ry="3.200" fill="var(--avatar-lens)" />
        </g>
      );
    case "antenna":
      return (
        <g>
          <rect x="19.200" y="1.800" width="1.600" height="4" fill={INK} opacity="0.7" />
          <circle cx="20" cy="2.200" r="2" fill="var(--avatar-alert)" />
        </g>
      );
    default:
      return null;
  }
}

const BADGE_ICONS: Record<AvatarBadge, typeof Code> = {
  code: Code,
  search: Search,
  shield: Shield,
  "message-square": MessageSquare,
  "file-text": FileText,
  play: Play,
  check: Check,
  "git-branch": GitBranch,
  bug: Bug,
  lightbulb: Lightbulb,
};

/** A teammate's blob character. `avatar` is "shape:colour[:expression[:badge[:accessory]]]"; anything else falls back to a pick seeded by `name`. */
export function TeammateAvatar({
  avatar,
  name,
  size = 28,
  blink,
  spec: given,
  className,
}: {
  avatar?: string;
  name?: string;
  size?: number;
  /** Blink every few seconds (a working teammate). */
  blink?: boolean;
  /** Draw this spec directly (the editor's picker). */
  spec?: AvatarSpec;
  className?: string;
}) {
  const spec = given ?? parseAvatar(avatar ?? "", name ?? "");
  const face = FACES[spec.shape];
  const id = `av${useId().replace(/:/g, "")}`;
  if (spec.portrait) {
    return (
      <span aria-hidden className={cn("relative inline-block shrink-0 overflow-hidden align-middle", className)} style={{ width: size, height: size }}>
        <img src={portraitUrl(spec.portrait)} alt="" draggable={false} className="absolute max-w-none object-contain" style={spec.portrait === "support" ? { width: "100%", height: "100%" } : { width: "150%", height: "150%", left: "-25%", top: "-25%" }} />
      </span>
    );
  }
  const c = `var(--avatar-${spec.color})`;
  const Badge = spec.badge && size >= 20 ? BADGE_ICONS[spec.badge] : null;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={cn("inline-block shrink-0", blink && "avatar-blink", className)} aria-hidden focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: `color-mix(in srgb, ${c}, white 32%)` }} />
          <stop offset="1" style={{ stopColor: `color-mix(in srgb, ${c}, black 6%)` }} />
        </linearGradient>
        <linearGradient id={`${id}-ring`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "var(--avatar-ring)" }} />
          <stop offset="1" style={{ stopColor: "var(--avatar-ring)" }} />
        </linearGradient>
        <radialGradient id={`${id}-shine`} cx="0.3" cy="0.2" r="0.6">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {face.behind?.(id)}
      {face.body(`url(#${id})`)}
      {!face.visor && face.body(`url(#${id}-shine)`)}
      {face.front}
      <Eyes spec={spec} face={face} />
      <Extras spec={spec} face={face} />
      <Accessory spec={spec} face={face} />
      {Badge && (
        <g>
          <rect x="23.500" y="23.500" width="15" height="15" rx="4.500" fill="var(--avatar-badge)" />
          <Badge x={26} y={26} width={10} height={10} color="var(--avatar-badge-ink)" strokeWidth={2.400} />
        </g>
      )}
    </svg>
  );
}

/** "<avatar> Teammate name" on workspaces a teammate created. */
export function TeammateLabel({ slug, className }: { slug: string; className?: string }) {
  const t = useApp((s) => s.teammates.find((x) => x.slug === slug));
  if (!t) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-mute", className)} title={`Created by ${t.name}`}>
      <TeammateAvatar avatar={t.avatar} name={t.name} size={16} />
      {t.name}
    </span>
  );
}
