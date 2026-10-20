import type { LimitWindow, RateLimits } from "./ipc";

export const WARN_AT = 80;

export function windowLabel(kind: string): string {
  return kind === "fiveHour" ? "5-hour" : kind === "weekly" ? "Weekly" : kind;
}

export function limitLevel(pct: number): "ok" | "warn" | "bad" {
  return pct >= 100 ? "bad" : pct >= WARN_AT ? "warn" : "ok";
}

/** "resets in 2h 14m" within a day, else "resets Mon 09:00". */
export function resetText(resetsAt: number | null, now = Date.now()): string | null {
  if (resetsAt === null) return null;
  const ms = resetsAt * 1000 - now;
  if (ms <= 0) return "resetting now";
  if (ms < 24 * 3_600_000) {
    const mins = Math.max(1, Math.round(ms / 60_000));
    return `resets in ${mins >= 60 ? `${Math.floor(mins / 60)}h ` : ""}${mins % 60}m`;
  }
  const d = new Date(resetsAt * 1000);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `resets ${day} ${time}`;
}

/** Worst level across every agent and window; `rejected` counts as at the limit. */
export function worstLimit(all: RateLimits[]): { level: "ok" | "warn" | "bad"; pct: number } {
  let pct = 0;
  let rejected = false;
  for (const l of all) {
    if (l.status === "rejected") rejected = true;
    for (const w of l.windows) pct = Math.max(pct, w.usedPercent);
  }
  return { level: rejected ? "bad" : limitLevel(pct), pct: rejected ? Math.max(pct, 100) : pct };
}

export const clampPct = (w: LimitWindow) => Math.min(100, Math.max(0, Math.round(w.usedPercent)));
