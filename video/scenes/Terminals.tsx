import { clamp, easeInOut, easeOut, lerp, noise1, prog, type Aspect } from "../lib";

// Six monochrome terminals, each streaming agent output. Only the error carries colour.
interface Term {
  title: string;
  lines: string[];
  /** Characters per second. */
  rate: number;
  /** When it tiles in. */
  at: number;
  kind?: "waiting" | "error";
}

const TERMS: Term[] = [
  { title: "claude  ~/relay  onboarding-crash", at: 4.35, rate: 46, lines: ["> fix the onboarding crash", "● Grep createOrganization", "  src/onboarding/submit.ts:42", "● Read src/onboarding/submit.ts", "● Bash bun test src/onboarding", "  1 fail: slugify(undefined)", "I'll validate the name before", "slugging and add a test.", "● Edit src/onboarding/submit.ts", "● Bash bun test src/onboarding", "  7 pass, 0 fail"] },
  { title: "codex  ~/relay  webhooks", at: 4.5, rate: 52, lines: ["$ codex exec idempotent webhooks", "thinking...", "exec rg retryWebhook src", "  src/billing/webhook.ts:88", "  src/jobs/queue.ts:31", "apply_patch src/billing/retry.ts", "exec bun test src/billing", "  41 pass, 0 fail", "apply_patch webhook.test.ts", "exec bun test src/billing", "  50 pass, 0 fail"] },
  { title: "claude  ~/marketing-site  hero", at: 4.65, rate: 44, kind: "error", lines: ["> refresh the homepage hero", "● Edit src/components/Hero.astro", "● Edit src/styles/hero.css", "● Bash npm run build", "  building for production...", "  error: Could not resolve", "  \"./hero.png\" from Hero.astro", "✗ build failed (exit 1)"] },
  { title: "claude  ~/api-gateway  rate-limit", at: 4.8, rate: 50, kind: "waiting", lines: ["> rate-limit the public API", "● Read cmd/gateway/main.go", "● Write middleware/ratelimit.go", "● Bash go test ./middleware/...", "  ok  gateway/middleware 0.41s", "? Burst of 100 per key, or per", "  IP as well?", "waiting for input..."] },
  { title: "codex  ~/relay  invoices", at: 4.95, rate: 48, lines: ["$ codex exec move invoices", "exec cat src/db/schema.ts", "apply_patch 0043_invoices.sql", "apply_patch backfill-invoices.ts", "exec bun run db:migrate --dry", "  3 tables, 2 indexes", "exec bun run backfill --batch", "  batch 1/12 ........", "  batch 2/12 ........", "  batch 3/12 ........"] },
  { title: "claude  ~/relay  dark-mode", at: 5.1, rate: 42, lines: ["> fix #412 dark mode flash", "● Read src/lib/theme.ts", "The theme is applied after", "hydration, so first paint is", "light. Inlining the script.", "● Edit index.html", "● Edit src/lib/theme.ts", "● Bash bun run build", "  built in 2.1s"] },
];

/** Window rects in the product area, as fractions, with a small tilt. */
function layout(aspect: Aspect, w: number, h: number) {
  const area = aspect === "4x5" ? { x: 30, y: 400, w: w - 60, h: h - 440 } : { x: 70, y: 36, w: w - 140, h: h - 230 };
  const cols: number = aspect === "4x5" ? 2 : 3, rows: number = aspect === "4x5" ? 3 : 2;
  const ww = area.w / cols * 1.14, wh = area.h / rows * 1.16;
  const jitter = [[-8, 6, -1.4], [10, -4, 1.0], [-6, 10, 0.8], [12, 8, -1.0], [-10, -6, 1.3], [6, 4, -0.7]];
  return TERMS.map((_, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const [jx, jy, rot] = jitter[i];
    return { x: area.x + (area.w - ww) * (cols === 1 ? 0 : c / (cols - 1)) + jx, y: area.y + (area.h - wh) * (rows === 1 ? 0 : r / (rows - 1)) + jy, w: ww, h: wh, rot };
  });
}

const MONO = '"JetBrains Mono Variable", Consolas, monospace';

export function Terminals({ w, h, aspect, t }: { w: number; h: number; aspect: Aspect; t: number }) {
  const rects = layout(aspect, w, h);
  const four = aspect === "4x5";
  const fs = four ? 21 : 17;
  const lh = fs * 1.5;
  // Camera shake builds through the scene, then the whole wall collapses toward the sidebar.
  const shakeAmt = 1 + 7 * prog(t, 6, 8.4);
  const sx = noise1(t * 14, 3) * shakeAmt, sy = noise1(t * 13, 9) * shakeAmt;
  const collapse = easeInOut(prog(t, 8.0, 8.95));
  const target = four ? { x: 60, y: 560 } : { x: 130, y: 330 };

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#050506" }}>
      <div style={{ position: "absolute", inset: 0, transform: `translate(${sx}px, ${sy}px)` }}>
        {TERMS.map((term, i) => {
          const r = rects[i];
          const inK = easeOut(prog(t, term.at, term.at + 0.45));
          if (inK <= 0) return null;
          const age = t - term.at - 0.3;
          const total = term.lines.join("\n");
          const shown = clamp(Math.floor(age * term.rate), 0, total.length);
          const visible = total.slice(0, shown).split("\n");
          const rowsFit = Math.floor((r.h - 38 - 20) / lh);
          const text = visible.slice(-rowsFit);
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          const tx = lerp(cx, target.x, collapse) - cx, ty = lerp(cy, target.y + (i % 3) * 20, collapse) - cy;
          const sc = lerp(0.85 + 0.15 * inK, 0.16, collapse);
          const err = term.kind === "error" && shown > total.indexOf("error:");
          const done = shown >= total.length;
          const blink = Math.floor(t * 2) % 2 === 0;
          return (
            <div
              key={i}
              style={{
                position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, overflow: "hidden",
                transform: `translate(${tx}px, ${ty}px) rotate(${r.rot * (1 - collapse)}deg) scale(${sc})`,
                opacity: inK * (1 - 0.6 * collapse), background: "#0b0b0d", borderRadius: 5,
                border: `1.5px solid ${err ? "#ff5468" : "#34343b"}`, boxShadow: "6px 6px 0 0 #000, 6px 6px 0 1.5px #1f1f24",
                zIndex: i,
              }}
            >
              <div style={{ height: 38, display: "flex", alignItems: "center", gap: 8, padding: "0 14px", borderBottom: "1.5px solid #1f1f24", background: "#121215" }}>
                <span style={{ width: 9, height: 9, background: "#63636c" }} />
                <span style={{ fontFamily: MONO, fontSize: 14, color: "#a2a2aa", whiteSpace: "nowrap", overflow: "hidden" }}>{term.title}</span>
              </div>
              <div style={{ padding: "12px 16px", fontFamily: MONO, fontSize: fs, lineHeight: `${lh}px`, color: "#ececef", whiteSpace: "pre" }}>
                {text.map((ln, k) => {
                  const bad = term.kind === "error" && /error|✗|resolve|hero\.png/.test(ln);
                  const waiting = term.kind === "waiting" && ln.startsWith("waiting");
                  return (
                    <div key={k} style={{ color: bad ? "#ff5468" : ln.startsWith(" ") || ln.startsWith("●") === false && ln.startsWith("  ") ? "#a2a2aa" : "#ececef", opacity: waiting ? (blink ? 1 : 0.25) : 1 }}>
                      {ln}
                      {k === text.length - 1 && !done && "▌"}
                      {waiting && blink ? " ▌" : ""}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
