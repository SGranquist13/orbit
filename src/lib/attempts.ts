// Pure helpers for the Best of N compare view (mirrors `attempts::rank` in Rust).
import type { Attempt } from "./ipc";

/** Passing checks first, then the smallest total line delta; attempts without a summary last. Stable. */
export function rankAttempts(attempts: Attempt[]): Attempt[] {
  const key = (a: Attempt): [number, number] =>
    a.summary ? [a.summary.checks === "pass" ? 0 : 1, a.summary.additions + a.summary.deletions] : [2, Number.MAX_SAFE_INTEGER];
  return attempts
    .map((a, i) => ({ a, i, k: key(a) }))
    .sort((x, y) => x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.i - y.i)
    .map((x) => x.a);
}

/** True once every attempt's turn finished and its summary (checks, diff stat) is stored. */
export function attemptsReady(attempts: Attempt[]) {
  return attempts.length > 0 && attempts.every((a) => a.finished && a.summary);
}

export const attemptLetter = (index: number) => "ABCD"[index] ?? String(index + 1);

export function formatDuration(ms: number | null) {
  if (ms == null) return "-";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function formatCost(usd: number | null) {
  return usd == null ? "-" : `$${usd.toFixed(2)}`;
}
