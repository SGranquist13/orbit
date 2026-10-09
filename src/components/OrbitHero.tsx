import { useEffect, useRef } from "react";
import orbitArt from "../assets/orbit.png";

// Geometry as fractions of the hero size, measured against assets/orbit.png.
const CENTER = { x: 0.52, y: 0.475 };
const HORIZON_R = 0.13;
const ORBIT = { rx: 0.44, ry: 0.11, tilt: (-15 * Math.PI) / 180 };
const PERIOD_MS = 16_000;
const PLANET = 0.05;

/**
 * The start-page mark: the black hole with a small planet on a tilted orbit. On the far half
 * of the orbit the planet passes behind the event horizon; on the near half it crosses in front.
 */
export function OrbitHero({ size }: { size: number }) {
  const planet = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = planet.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const start = performance.now();

    const place = (theta: number) => {
      const ox = ORBIT.rx * Math.cos(theta);
      const oy = ORBIT.ry * Math.sin(theta);
      const x = CENTER.x + ox * Math.cos(ORBIT.tilt) - oy * Math.sin(ORBIT.tilt);
      const y = CENTER.y + ox * Math.sin(ORBIT.tilt) + oy * Math.cos(ORBIT.tilt);
      const near = Math.sin(theta) > 0; // lower half of the orbit faces us
      const depth = (Math.sin(theta) + 1) / 2; // 0 far … 1 near
      el.style.transform = `translate(${x * size}px, ${y * size}px) translate(-50%, -50%) scale(${0.7 + 0.45 * depth})`;
      el.style.opacity = String(0.55 + 0.45 * depth);
      el.style.zIndex = near ? "4" : "1";
    };

    if (reduced) {
      place(0.5);
      return;
    }
    const tick = (now: number) => {
      place(((now - start) / PERIOD_MS) * Math.PI * 2);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [size]);

  const p = PLANET * size;
  return (
    <div className="pointer-events-none relative" style={{ width: size, height: size }} aria-hidden>
      {/* Faint dotted orbit path. */}
      <svg className="absolute inset-0 z-0 text-line-strong" width={size} height={size}>
        <ellipse
          cx={CENTER.x * size}
          cy={CENTER.y * size}
          rx={ORBIT.rx * size}
          ry={ORBIT.ry * size}
          transform={`rotate(${(ORBIT.tilt * 180) / Math.PI} ${CENTER.x * size} ${CENTER.y * size})`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="1.5 6"
        />
      </svg>

      {/* Planet: a lit sphere with a stippled terminator. z-index flips with the orbit side. */}
      <span ref={planet} className="absolute left-0 top-0 block overflow-hidden rounded-full bg-fg" style={{ width: p, height: p }}>
        <span className="dither-50 absolute inset-0 translate-x-[38%] translate-y-[30%] rounded-full bg-bg" />
        <span className="absolute inset-0 translate-x-[58%] translate-y-[48%] rounded-full bg-bg" />
      </span>

      {/* Event horizon: hides the planet while it's behind the hole. */}
      <span
        className="absolute z-[2] rounded-full bg-bg"
        style={{
          left: (CENTER.x - HORIZON_R) * size,
          top: (CENTER.y - HORIZON_R) * size,
          width: HORIZON_R * 2 * size,
          height: HORIZON_R * 2 * size,
        }}
      />

      <img src={orbitArt} alt="" draggable={false} className="orbit-art absolute inset-0 z-[3] size-full" />
    </div>
  );
}
