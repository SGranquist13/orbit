import { memo, useLayoutEffect, useRef } from "react";
import App from "../../src/App";
import { cameraAt, frameFor } from "../director";
import { applyFx, applyTyping, cursorAt } from "../fx";
import type { Aspect } from "../lib";

/** The real Orbit window inside a frame; the camera is a transform on it. */
const RealApp = memo(function RealApp() {
  return <App />;
});

export function AppLayer({ aspect, t }: { w: number; h: number; aspect: Aspect; t: number }) {
  const f = frameFor(aspect);
  const cam = cameraAt(t, aspect);
  const tx = f.win.w / 2 - cam.fx * cam.s;
  const ty = f.win.h / 2 - cam.fy * cam.s;
  const cursor = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    applyFx(t);
    applyTyping(t);
    const c = cursorAt(t);
    const el = cursor.current!, rg = ring.current!;
    if (!c) {
      el.style.opacity = "0";
      rg.style.opacity = "0";
      return;
    }
    el.style.opacity = "1";
    el.style.transform = `translate(${c.p.x}px, ${c.p.y}px) scale(${c.down ? 0.88 : 1})`;
    if (c.click >= 0 && c.click < 1) {
      rg.style.opacity = String(0.7 * (1 - c.click));
      rg.style.transform = `translate(${c.p.x}px, ${c.p.y}px) translate(-50%, -50%) scale(${0.4 + c.click * 1.6})`;
    } else rg.style.opacity = "0";
  });

  return (
    <>
      <div
        style={{
          position: "absolute", left: f.win.x, top: f.win.y, width: f.win.w, height: f.win.h, overflow: "clip",
          border: "1.5px solid var(--line-strong)", borderRadius: 6, ...fadeMask(cam.fade), boxShadow: "6px 6px 0 0 #000, 6px 6px 0 1.5px var(--line-strong)", background: "var(--bg)",
        }}
      >
        <div
          id="app-virtual"
          style={{ position: "absolute", left: 0, top: 0, width: f.virt.w, height: f.virt.h, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${cam.s})` }}
        >
          <RealApp />
        </div>
      </div>
      <div ref={ring} style={{ position: "absolute", left: 0, top: 0, width: 44, height: 44, borderRadius: 22, border: "2px solid #fff", opacity: 0, zIndex: 41, pointerEvents: "none" }} />
      <div ref={cursor} style={{ position: "absolute", left: 0, top: 0, zIndex: 42, pointerEvents: "none", opacity: 0, filter: "drop-shadow(2px 3px 0 rgba(0,0,0,.6))" }}>
        <svg width="30" height="38" viewBox="0 0 20 26" style={{ marginLeft: -3, marginTop: -2 }}>
          <path d="M3 2 L3 20 L7.6 15.8 L10.8 23 L13.6 21.8 L10.5 14.8 L16.5 14.6 Z" fill="#fff" stroke="#050506" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      </div>
    </>
  );
}

/** Soft edges on the sides where the camera cuts through the app, so no text is cropped hard. */
function fadeMask(f?: { l: number; r: number; t: number; b: number }): React.CSSProperties {
  if (!f || f.l + f.r + f.t + f.b < 1) return {};
  const g = (dir: string, a: number, b: number) =>
    `linear-gradient(${dir}, transparent 0, #000 ${a}px, #000 calc(100% - ${b}px), transparent 100%)`;
  const image = `${g("to right", f.l, f.r)}, ${g("to bottom", f.t, f.b)}`;
  return { WebkitMaskImage: image, maskImage: image, WebkitMaskComposite: "source-in", maskComposite: "intersect" } as React.CSSProperties;
}
