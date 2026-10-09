import { Minimize2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Workspace } from "../lib/ipc";
import { formatCost, formatTokens } from "../lib/transcript";
import { contextLevel, contextPercent, totalTokens } from "../lib/usage";
import { useApp } from "../stores/app";
import { cn } from "./ui";

const levelText = { ok: "text-dim", warn: "text-warn", bad: "text-bad" } as const;
const levelBar = { ok: "bg-mute", warn: "bg-warn", bad: "bg-bad" } as const;

/** Composer-footer gauge of how full the agent's context window is. Click for tokens, cost and
 *  the two ways to free context. Hidden until the first usage arrives. */
export function ContextMeter({ ws, running }: { ws: Workspace; running: boolean }) {
  const usage = useApp((s) => s.usage[ws.id]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => setOpen(false), [ws.id]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pct = contextPercent(usage);
  if (!usage || pct === null || usage.contextTokens === null || !usage.contextWindow) return null;
  const level = contextLevel(pct);
  const used = `${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextWindow)}`;
  const act = (fn: (id: string) => Promise<void>) => {
    setOpen(false);
    void fn(ws.id);
  };

  return (
    <span ref={ref} className="relative flex items-center">
      <button
        data-context-meter
        onClick={() => setOpen((o) => !o)}
        title={`Context: ${usage.contextTokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens${
          usage.model ? ` (${usage.model})` : ""
        }\nCompact or start a new session to free context`}
        className="flex h-6 items-center gap-2 rounded-[3px] px-1.5 text-[11px] font-medium tabular-nums hover:bg-hover"
      >
        <span className="relative h-1 w-14 overflow-hidden rounded-[1px] bg-line">
          <span
            className={cn("dither-50 absolute inset-y-0 left-0", levelBar[level])}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </span>
        <span className={levelText[level]}>
          {pct}% · {used}
        </span>
      </button>
      {open && (
        <div
          data-context-popover
          className="absolute bottom-full right-0 z-20 mb-2 w-[272px] rounded-[6px] border-[1.5px] border-line-strong bg-raised p-3 shadow-hard"
        >
          <div className="mb-2 flex items-baseline justify-between text-[12px] font-medium text-fg">
            <span>This session</span>
            <span className="text-[11px] font-normal tabular-nums text-mute">{usage.model ?? ""}</span>
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[11.5px] tabular-nums">
            <Row label="Input" value={formatTokens(usage.session.inputTokens)} />
            <Row label="Output" value={formatTokens(usage.session.outputTokens)} />
            <Row label="Cache read" value={formatTokens(usage.session.cacheReadTokens)} />
            <Row label="Cache write" value={formatTokens(usage.session.cacheWriteTokens)} />
            <Row label="Turns" value={String(usage.session.turns)} />
            <Row label="Cost" value={usage.session.costUsd > 0 ? formatCost(usage.session.costUsd) : "—"} />
          </dl>
          {usage.total.turns > usage.session.turns && (
            <p className="mt-2 text-[11px] tabular-nums text-mute">
              All sessions: {formatTokens(totalTokens(usage.total))} tok
              {usage.total.costUsd > 0 && ` · ${formatCost(usage.total.costUsd)}`}
            </p>
          )}
          <div className="dither-rule my-2.5 bg-line-strong" />
          <div className="flex gap-2">
            <button
              data-compact
              disabled={running}
              title={running ? "Wait for the current turn to finish" : "Summarise the conversation to free context"}
              onClick={() => act(useApp.getState().compactSession)}
              className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[3px] border-[1.5px] border-line-strong text-[11.5px] font-medium text-dim hover:bg-accent hover:text-accent-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-dim"
            >
              <Minimize2 className="size-3" /> Compact context
            </button>
            <button
              data-new-session
              disabled={running}
              title={running ? "Wait for the current turn to finish" : "Start fresh in the same worktree; the agent forgets this conversation"}
              onClick={() => act(useApp.getState().newSession)}
              className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[3px] border-[1.5px] border-line-strong text-[11.5px] font-medium text-dim hover:bg-accent hover:text-accent-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-dim"
            >
              <RotateCcw className="size-3" /> New session
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-mute">{label}</dt>
      <dd className="text-right text-fg">{value}</dd>
    </>
  );
}
