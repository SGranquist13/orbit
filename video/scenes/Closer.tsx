import { easeOut, prog, type Aspect } from "../lib";

const font = '"Inter Variable", Inter, sans-serif';

/** Scene 8 lock-up, below the small black hole. Holds on the URL until the end. */
export function Closer({ w, h, aspect, t }: { w: number; h: number; aspect: Aspect; t: number }) {
  const four = aspect === "4x5";
  const line = (at: number, children: React.ReactNode, style: React.CSSProperties) => {
    const k = easeOut(prog(t, at, at + 0.55));
    return <div style={{ opacity: k, transform: `translateY(${(1 - k) * 22}px)`, textAlign: "center", fontFamily: font, ...style }}>{children}</div>;
  };
  const top = four ? h * 0.5 : h * 0.57;
  return (
    <div style={{ position: "absolute", left: 60, width: w - 120, top, zIndex: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: four ? 22 : 16, color: "#fff" }}>
      {line(39.9, "Orbit v0.1", { fontSize: four ? 124 : 104, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1 })}
      {line(40.5, "Free & open source · Windows", { fontSize: four ? 46 : 40, fontWeight: 500, color: "#c9c9d0", letterSpacing: "-0.01em" })}
      {line(41.1, "Works with Claude Code & Codex", { fontSize: four ? 46 : 40, fontWeight: 500, color: "#c9c9d0", letterSpacing: "-0.01em" })}
      {line(42.0, "github.com/SGranquist13/orbit", {
        marginTop: four ? 34 : 24, fontSize: four ? 54 : 52, fontWeight: 600, letterSpacing: "-0.02em",
        padding: "14px 30px", border: "2px solid #34343b", borderRadius: 6, boxShadow: "6px 6px 0 0 #000, 6px 6px 0 2px #34343b", background: "#0b0b0d",
      })}
    </div>
  );
}
