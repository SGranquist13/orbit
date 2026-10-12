// The one deliberately colourful element: teammate avatars are little blob characters (see CLAUDE.md, Conventions).
import { parseAvatar, type AvatarShape, type AvatarSpec } from "../lib/avatar";
import { cn } from "../lib/cn";

interface Face {
  body: React.ReactNode;
  /** Eye centre y and half the distance between the eyes (viewBox 40x40). */
  ey: number;
  dx: number;
}

const FACES: Record<AvatarShape, Face> = {
  circle: { body: <circle cx="20" cy="20" r="17.5" />, ey: 18, dx: 6.5 },
  squircle: { body: <rect x="3.5" y="3.5" width="33" height="33" rx="12" />, ey: 18, dx: 7 },
  triangle: {
    body: <path d="M20 4.5c2.4 0 3.9 1.5 5.2 3.9l10 19.6c2.3 4.6-.6 8.5-5 8.5H9.8c-4.4 0-7.3-3.9-5-8.5l10-19.6C16.1 6 17.6 4.5 20 4.5z" />,
    ey: 24,
    dx: 5.5,
  },
  ghost: {
    body: <path d="M5.5 20C5.5 11 12 4.5 20 4.5S34.5 11 34.5 20v14.5c0 1.2-1.2 1.8-2.2.9l-3.6-3.2-3.7 3.3a1.8 1.8 0 0 1-2.4 0L20 32.2l-2.6 3.3a1.8 1.8 0 0 1-2.4 0l-3.7-3.3-3.6 3.2c-1 .9-2.2.3-2.2-.9z" />,
    ey: 19,
    dx: 6.5,
  },
  bean: {
    body: <path d="M9 14.5C9 8 14 4 21 4.5c8 .6 13 6 12.5 14.5-.4 9-5.5 16.5-14 16.5C11 35.5 6 31 6.5 24c.2-3.7 2.5-6 2.5-9.5z" />,
    ey: 20,
    dx: 6.5,
  },
  cloud: {
    body: <path d="M12.5 33C7 33 3.5 29.5 3.5 25c0-3.6 2.4-6.6 5.8-7.5C10 11.8 14.5 7.5 20.5 7.5c5.5 0 9.8 3.7 10.8 8.8 3.1.8 5.2 3.6 5.2 6.9 0 4.2-3.5 7.8-8 7.8z" />,
    ey: 22,
    dx: 7,
  },
  drop: { body: <path d="M20 3.5S6.5 17.5 6.5 25.5a13.5 13.5 0 0 0 27 0C33.5 17.5 20 3.5 20 3.5z" />, ey: 26, dx: 6 },
  pill: { body: <rect x="9" y="3.5" width="22" height="33" rx="11" />, ey: 16, dx: 5.5 },
};

const INK = "var(--avatar-ink)";

function Eyes({ spec, face }: { spec: AvatarSpec; face: Face }) {
  const { ey, dx } = face;
  const l = 20 - dx;
  const r = 20 + dx;
  switch (spec.expression) {
    case "happy":
      return (
        <g className="avatar-eyes" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d={`M${l - 2.5} ${ey + 1}q2.5-4.2 5 0`} />
          <path d={`M${r - 2.5} ${ey + 1}q2.5-4.2 5 0`} />
        </g>
      );
    case "sleepy":
      return (
        <g className="avatar-eyes" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round">
          <path d={`M${l - 2.3} ${ey}h4.6`} />
          <path d={`M${r - 2.3} ${ey}h4.6`} />
        </g>
      );
    case "specs":
      return (
        <g className="avatar-eyes" fill="none" stroke={INK} strokeWidth="2">
          <circle cx={l} cy={ey} r="3.9" />
          <circle cx={r} cy={ey} r="3.9" />
          <path d={`M${l + 3.9} ${ey}h${dx * 2 - 7.8}`} strokeLinecap="round" />
          <circle cx={l + 0.6} cy={ey + 0.3} r="1.3" fill={INK} stroke="none" />
          <circle cx={r + 0.6} cy={ey + 0.3} r="1.3" fill={INK} stroke="none" />
        </g>
      );
    default:
      return (
        <g className="avatar-eyes" fill={INK}>
          <ellipse cx={l} cy={ey} rx="2.2" ry="2.8" />
          <ellipse cx={r} cy={ey} rx="2.2" ry="2.8" />
          <circle cx={l + 0.8} cy={ey - 1} r="0.8" fill="#fff" opacity="0.85" />
          <circle cx={r + 0.8} cy={ey - 1} r="0.8" fill="#fff" opacity="0.85" />
        </g>
      );
  }
}

function Extras({ spec, face }: { spec: AvatarSpec; face: Face }) {
  const { ey, dx } = face;
  const my = ey + 6.5;
  if (spec.expression === "smile" || spec.expression === "happy")
    return (
      <>
        <path d={`M17.2 ${my}q2.8 3 5.6 0`} fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
        <ellipse cx={20 - dx - 3} cy={my - 0.5} rx="2.2" ry="1.4" fill="#ff7a93" opacity="0.5" />
        <ellipse cx={20 + dx + 3} cy={my - 0.5} rx="2.2" ry="1.4" fill="#ff7a93" opacity="0.5" />
      </>
    );
  if (spec.expression === "focus")
    return (
      <g fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round">
        <path d={`M${20 - dx - 3.2} ${ey - 5.8}l6 2`} />
        <path d={`M${20 + dx + 3.2} ${ey - 5.8}l-6 2`} />
        <path d={`M18 ${my + 0.5}h4`} strokeWidth="2" />
      </g>
    );
  if (spec.expression === "sleepy") return <ellipse cx="20" cy={my + 0.5} rx="1.6" ry="1.3" fill={INK} opacity="0.8" />;
  if (spec.expression === "specs") return <path d={`M18 ${my}q2 1.6 4 0`} fill="none" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />;
  return null;
}

/** A teammate's blob character. `avatar` is "shape:colour[:expression]"; anything else falls back to a pick seeded by `name`. */
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
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={cn("inline-block shrink-0", blink && "avatar-blink", className)} aria-hidden focusable="false">
      <g fill={`var(--avatar-${spec.color})`}>{face.body}</g>
      <Eyes spec={spec} face={face} />
      <Extras spec={spec} face={face} />
    </svg>
  );
}
