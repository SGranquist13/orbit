import { Gauge } from "lucide-react";
import { agentLabel, cn } from "./ui";
import { clampPct, resetText, windowLabel, worstLimit } from "../lib/limits";
import { useApp } from "../stores/app";

/** Quiet composer-footer warning: only appears once a plan window reaches 80%. Click opens Settings > Usage. */
export function LimitsBadge() {
  const limits = useApp((s) => s.rateLimits);
  const all = Object.values(limits).filter((l): l is NonNullable<typeof l> => !!l);
  const { level, pct } = worstLimit(all);
  if (level === "ok") return null;
  const tip = all
    .flatMap((l) =>
      l.windows.map((w) => `${agentLabel[l.agent]} ${windowLabel(w.kind)}: ${clampPct(w)}%${resetText(w.resetsAt) ? `, ${resetText(w.resetsAt)}` : ""}`),
    )
    .join("\n");
  return (
    <button
      data-limits-badge
      onClick={() => useApp.getState().openSettingsAt("usage")}
      title={`${tip}\nOpen plan limits`}
      className={cn(
        "flex h-6 items-center gap-1 rounded-[3px] px-1.5 text-[11px] font-medium tabular-nums hover:bg-hover",
        level === "bad" ? "text-bad" : "text-warn",
      )}
    >
      <Gauge className="size-3" /> {Math.min(100, Math.round(pct))}%
    </button>
  );
}
