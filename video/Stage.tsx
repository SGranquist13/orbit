import { useEffect } from "react";
import { useClock } from "./clock";
import { prog, type Aspect } from "./lib";
import { AppLayer } from "./scenes/AppLayer";
import { BlackHoleLayer } from "./scenes/BlackHole";
import { Terminals } from "./scenes/Terminals";
import { Captions } from "./scenes/Captions";
import { Closer } from "./scenes/Closer";
import { Wipe } from "./scenes/Wipe";
import { T } from "./timeline";

/** The stage is exactly the target pixel size; layers are mounted by time and each is a pure function of t. */
export function Stage({ w, h, aspect }: { w: number; h: number; aspect: Aspect }) {
  const t = useClock((s) => s.t);

  // Running sweeps / progress marches in the real components are CSS animations (disabled in video mode):
  // drive them from t through custom properties instead.
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty("--vt-sweep", String((t % 1.8) / 1.8));
    r.setProperty("--vt-march", String(Math.floor((t % 0.6) / 0.15) / 4));
  }, [t]);

  const holeA = t < T.terminalsIn + 0.5;
  const holeB = t > T.closerWipe;
  const terminals = t >= T.terminalsIn - 0.3 && t < T.appIn + 0.1;
  const app = t >= T.appIn - 0.1 && t < T.closerWipe + 0.7;

  void prog;
  return (
    <div id="stage" style={{ position: "relative", width: w, height: h, overflow: "clip", background: "#050506" }}>
      {(holeA || holeB) && <BlackHoleLayer w={w} h={h} aspect={aspect} t={t} />}
      {terminals && <Terminals w={w} h={h} aspect={aspect} t={t} />}
      {app && <AppLayer w={w} h={h} aspect={aspect} t={t} />}
      {t >= T.closerWipe && <Closer w={w} h={h} aspect={aspect} t={t} />}
      <Wipe w={w} h={h} t={t} />
      <Captions w={w} h={h} aspect={aspect} t={t} />
    </div>
  );
}
