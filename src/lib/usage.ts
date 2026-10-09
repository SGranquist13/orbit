// Pure helpers for token/context usage; the Rust side (usage.rs) does the same maths for history.
import type { AgentEvent, UsageTotals, WorkspaceUsage } from "./ipc";

export const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  turns: 0,
});

export function totalTokens(t: Pick<UsageTotals, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

function addTurn(t: UsageTotals, e: Extract<AgentEvent, { type: "usage" }>): UsageTotals {
  return {
    inputTokens: t.inputTokens + e.inputTokens,
    outputTokens: t.outputTokens + e.outputTokens,
    cacheReadTokens: t.cacheReadTokens + e.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens + e.cacheWriteTokens,
    costUsd: t.costUsd + (e.costUsd ?? 0),
    turns: t.turns + 1,
  };
}

/** Folds one live event into a workspace's usage digest (undefined = no usage yet). */
export function applyUsage(prev: WorkspaceUsage | undefined, id: string, ev: AgentEvent): WorkspaceUsage | undefined {
  if (ev.type === "usage") {
    const base: WorkspaceUsage = prev ?? {
      workspaceId: id,
      total: emptyTotals(),
      session: emptyTotals(),
      contextTokens: null,
      contextWindow: null,
      model: null,
    };
    return {
      ...base,
      total: addTurn(base.total, ev),
      session: addTurn(base.session, ev),
      // A turn that can't tell its context size leaves the last known value.
      contextTokens: ev.contextTokens ?? base.contextTokens,
      contextWindow: ev.contextWindow ?? base.contextWindow,
      model: ev.model ?? base.model,
    };
  }
  if (ev.type === "sessionReset" && prev) return { ...prev, session: emptyTotals(), contextTokens: null };
  return prev;
}

export type ContextLevel = "ok" | "warn" | "bad";

/** Neutral below 70%, warn 70-90%, bad above 90%. */
export function contextLevel(pct: number): ContextLevel {
  return pct > 90 ? "bad" : pct >= 70 ? "warn" : "ok";
}

export function contextPercent(u: Pick<WorkspaceUsage, "contextTokens" | "contextWindow"> | undefined): number | null {
  if (!u || u.contextTokens === null || !u.contextWindow) return null;
  return Math.min(100, Math.round((u.contextTokens / u.contextWindow) * 100));
}
