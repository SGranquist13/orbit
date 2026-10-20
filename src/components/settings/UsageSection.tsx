import { useEffect, useMemo, useState } from "react";
import { api, type UsageReport, type UsageTotals } from "../../lib/ipc";
import { formatCost, formatTokens } from "../../lib/transcript";
import { contextLevel, contextPercent, totalTokens } from "../../lib/usage";
import { clampPct, limitLevel, resetText, windowLabel } from "../../lib/limits";
import { useApp } from "../../stores/app";
import { AgentIcon, agentLabel, cn } from "../ui";

const DAY = 86_400_000;
const PERIODS = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All" },
] as const;
type Period = (typeof PERIODS)[number]["id"];

function sinceFor(period: Period): number | null {
  if (period === "all") return null;
  if (period === "today") return new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  return Date.now() - (period === "7d" ? 7 : 30) * DAY;
}

const levelText = { ok: "text-dim", warn: "text-warn", bad: "text-bad" } as const;
const cost = (t: UsageTotals) => (t.costUsd > 0 ? formatCost(t.costUsd) : "—");

/** Tokens, cost and context fill across every workspace. Rendered inside Settings. */
export function UsageSection() {
  const [period, setPeriod] = useState<Period>("7d");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Live turns refresh the report without polling.
  const turns = useApp((s) => Object.values(s.usage).reduce((n, u) => n + u.total.turns, 0));

  useEffect(() => {
    let stale = false;
    api
      .usageReport(sinceFor(period))
      .then((r) => !stale && (setReport(r), setFailed(null)))
      .catch((e) => !stale && setFailed(String(e)));
    return () => {
      stale = true;
    };
  }, [period, turns]);

  const maxDay = useMemo(() => Math.max(1, ...(report?.byDay ?? []).map((d) => d.tokens)), [report]);

  return (
    <section data-usage-section className="flex flex-col gap-5">
      <PlanLimits />
      <header className="flex items-end justify-between gap-4">
        <p className="text-[12px] text-mute">Tokens added (input, output, cache writes), cost and context across all workspaces.</p>
        <div role="tablist" className="flex shrink-0 rounded-[4px] border-[1.5px] border-line-strong p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={period === p.id}
              onClick={() => setPeriod(p.id)}
              className={cn(
                "h-6 whitespace-nowrap rounded-[3px] px-2.5 text-[11.5px] font-medium",
                period === p.id ? "bg-accent text-accent-fg" : "text-dim hover:bg-hover hover:text-fg",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {failed && <p className="text-[12px] text-bad">{failed}</p>}
      {!report ? (
        !failed && <p className="text-[12px] text-mute">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Tokens" value={formatTokens(totalTokens(report.totals))} hint={`${formatTokens(report.totals.inputTokens + report.totals.outputTokens)} excluding cache`} />
            <Stat label="Cost" value={cost(report.totals)} hint="Claude only; Codex runs on your plan" />
            <Stat label="Turns" value={String(report.totals.turns)} />
          </div>

          <div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-mute">Last 14 days</h3>
            <div className="flex h-24 items-end gap-1 border-b-[1.5px] border-line-strong">
              {report.byDay.map((d, i) => (
                <div
                  key={d.day}
                  title={`${d.day}: ${d.tokens.toLocaleString()} tokens${d.costUsd > 0 ? ` · ${formatCost(d.costUsd)}` : ""}`}
                  className="flex h-full flex-1 flex-col justify-end"
                >
                  <div
                    className={cn("w-full rounded-t-[2px]", i === report.byDay.length - 1 ? "bg-fg" : "bg-mute/60")}
                    style={{ height: `${d.tokens === 0 ? 0 : Math.max(3, (d.tokens / maxDay) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[10.5px] tabular-nums text-mute">
              <span>{report.byDay[0]?.day.slice(5)}</span>
              <span>peak {formatTokens(maxDay === 1 ? 0 : maxDay)}</span>
              <span>{report.byDay[report.byDay.length - 1]?.day.slice(5)}</span>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-mute">By workspace</h3>
            {report.byWorkspace.length === 0 ? (
              <p className="text-[12px] text-mute">No usage in this period.</p>
            ) : (
              <table className="w-full text-[12px] tabular-nums">
                <thead>
                  <tr className="border-b border-line text-left text-[10.5px] font-medium uppercase tracking-wide text-mute">
                    <th className="py-1.5 font-medium">Workspace</th>
                    <th className="font-medium">Agent</th>
                    <th className="text-right font-medium">Tokens</th>
                    <th className="text-right font-medium">Cost</th>
                    <th className="text-right font-medium">Context</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byWorkspace.map((w) => {
                    const pct = contextPercent(w);
                    return (
                      <tr key={w.workspaceId} className="border-b border-line/60 text-dim">
                        <td className="max-w-[220px] truncate py-1.5 pr-3 font-medium text-fg">{w.name}</td>
                        <td>
                          <span className="flex items-center gap-1.5">
                            <AgentIcon agent={w.agent} className="size-3" />
                            {agentLabel[w.agent]}
                          </span>
                        </td>
                        <td className="text-right">{formatTokens(totalTokens(w.total))}</td>
                        <td className="text-right">{cost(w.total)}</td>
                        <td className={cn("text-right", pct !== null && levelText[contextLevel(pct)])}>
                          {pct === null ? "—" : `${pct}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {report.byAgent.length > 0 && (
            <div>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-mute">By agent</h3>
              <table className="w-full text-[12px] tabular-nums">
                <tbody>
                  {report.byAgent.map((a) => (
                    <tr key={a.agent} className="border-b border-line/60 text-dim">
                      <td className="py-1.5 pr-3">
                        <span className="flex items-center gap-1.5 font-medium text-fg">
                          <AgentIcon agent={a.agent} className="size-3" />
                          {agentLabel[a.agent]}
                        </span>
                      </td>
                      <td className="text-right">{a.total.turns} turns</td>
                      <td className="text-right">{formatTokens(totalTokens(a.total))} tok</td>
                      <td className="text-right">{cost(a.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint} className="rounded-[4px] border border-line bg-panel px-3 py-2.5">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-mute">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-fg">{value}</div>
    </div>
  );
}

const limitBar = { ok: "bg-mute", warn: "bg-warn", bad: "bg-bad" } as const;

/** Claude and Codex plan windows (5-hour, weekly), live from the agents' own rate-limit reports. */
function PlanLimits() {
  const limits = useApp((s) => s.rateLimits);
  const rows = (["claude", "codex"] as const).map((a) => limits[a]).filter((l): l is NonNullable<typeof l> => !!l && l.windows.length > 0);
  return (
    <div data-plan-limits>
      <h3 className="mb-2 text-[12px] font-semibold text-fg">Plan limits</h3>
      {rows.length === 0 ? (
        <p className="text-[12px] text-mute">Shows up after the first turn.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((l) => (
            <div key={l.agent} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-dim">
                <AgentIcon agent={l.agent} /> {agentLabel[l.agent]}
                {l.status === "rejected" && <span className="text-bad">· limit reached</span>}
              </div>
              {l.windows.map((w) => {
                const pct = clampPct(w);
                const level = l.status === "rejected" ? "bad" : limitLevel(w.usedPercent);
                const reset = resetText(w.resetsAt);
                return (
                  <div key={w.kind} data-limit-window className="grid grid-cols-[64px_1fr_40px_132px] items-center gap-3 text-[11.5px] tabular-nums">
                    <span className="text-dim">{windowLabel(w.kind)}</span>
                    <span className="relative h-1 overflow-hidden rounded-[1px] bg-line">
                      <span className={cn("dither-50 absolute inset-y-0 left-0", limitBar[level])} style={{ width: `${Math.max(pct, 2)}%` }} />
                    </span>
                    <span className={cn("text-right", levelText[level])}>{pct}%</span>
                    <span className="text-mute">{reset ?? ""}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
