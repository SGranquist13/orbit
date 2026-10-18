import { CAPTIONS } from "../timeline";
import { easeOut, prog, type Aspect } from "../lib";

/** Caption box per aspect: inside safe margins, clear of the product frame. */
export function captionBox(aspect: Aspect, w: number, h: number) {
  return aspect === "4x5"
    ? { left: 72, width: w - 144, top: 76, height: 290, size: 64, align: "left" as const }
    : { left: 120, width: w - 240, top: h - 190, height: 150, size: 56, align: "center" as const };
}

export function Captions({ w, h, aspect, t }: { w: number; h: number; aspect: Aspect; t: number }) {
  const box = captionBox(aspect, w, h);
  return (
    <>
      {CAPTIONS.map((c, i) => {
        if (t < c.a - 0.01 || t > c.b + 0.01) return null;
        const inn = easeOut(prog(t, c.a, c.a + 0.55));
        const out = prog(t, c.b - 0.35, c.b);
        const opacity = inn * (1 - out);
        const dy = (1 - inn) * 26 - out * 10;
        return (
          <div
            key={i}
            style={{
              position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height,
              display: "flex", alignItems: aspect === "4x5" ? "flex-start" : "center", justifyContent: aspect === "4x5" ? "flex-start" : "center",
              opacity, transform: `translateY(${dy}px)`, zIndex: 60, pointerEvents: "none",
            }}
          >
            <p
              style={{
                margin: 0, color: "#fff", fontFamily: '"Inter Variable", Inter, sans-serif', fontWeight: 600,
                fontSize: box.size, lineHeight: 1.12, letterSpacing: "-0.03em", textAlign: box.align,
                textWrap: "balance", textShadow: "0 2px 24px rgba(0,0,0,.9)",
              } as React.CSSProperties}
            >
              {c.text}
            </p>
          </div>
        );
      })}
    </>
  );
}
