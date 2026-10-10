import { Check, ChevronRight, LoaderCircle, Minus, Shrink, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SimplifyCandidate, SimplifyRisk, SimplifyRow, SimplifySignal, SimplifyState, Workspace } from "../lib/ipc";
import { useApp } from "../stores/app";
import { Button, cn } from "./ui";

const signalLabel: Record<SimplifySignal, string> = {
  nesting: "Deep nesting",
  longFunction: "Long function",
  nestedTernary: "Nested ternary",
  booleanFlags: "Boolean flags",
  duplication: "Duplication",
  deadCode: "Dead code",
  needlessWrapper: "Needless wrapper",
  naming: "Naming",
  other: "Other",
};

const riskTone: Record<SimplifyRisk, string> = { low: "text-ok", medium: "text-warn", high: "text-bad" };

/** What the finished run amounts to, in plain numbers. */
export function summarize(rows: SimplifyRow[]) {
  const applied = rows.filter((r) => r.status === "applied");
  return {
    applied: applied.length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    noop: rows.filter((r) => r.status === "noop").length,
    linesRemoved: applied.reduce((n, r) => n + r.linesRemoved, 0),
  };
}

const EMPTY: SimplifyState = {
  workspaceId: "",
  phase: "idle",
  candidates: [],
  rows: [],
  error: null,
  scopeFiles: 0,
  scopeNote: null,
  checkCommand: null,
  cancelled: false,
};

/**
 * Right-hand panel for the simplification pass. It sits where the Ship panel does (not a takeover)
 * because every edit turn streams into the chat as "Simplify: <title>", and you want both in view.
 */
export function SimplifyPanel({ ws }: { ws: Workspace }) {
  const st = useApp((s) => s.simplify[ws.id]) ?? { ...EMPTY, workspaceId: ws.id };
  const lowRiskButton = useApp((s) => s.settings?.simplifyLowRiskButton ?? true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const running = ws.status === "running" && st.phase !== "applying";
  const rowOf = useMemo(() => new Map(st.rows.map((r) => [r.candidateId, r])), [st.rows]);

  // A fresh list starts with the low-risk candidates ticked.
  const listKey = st.candidates.map((c) => c.id + c.title).join("|");
  useEffect(() => {
    setPicked(new Set(st.candidates.filter((c) => c.risk === "low").map((c) => c.id)));
    setOpen(null);
  }, [listKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectable = (c: SimplifyCandidate) => (st.phase === "ready" || st.phase === "done") && rowOf.get(c.id)?.status === "queued";
  const ticked = st.candidates.filter((c) => selectable(c) && picked.has(c.id));
  const lowRisk = st.candidates.filter((c) => selectable(c) && c.risk === "low");
  const apply = (list: SimplifyCandidate[]) => void useApp.getState().simplifyApply(ws.id, list.map((c) => c.id));
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l-[1.5px] border-line bg-panel">
      <div className="flex h-12 shrink-0 items-center gap-1 px-3" data-tauri-drag-region>
        <span className="label px-1 text-fg">Simplify</span>
        <span className="flex-1" />
        <Button onClick={() => useApp.getState().setSimplifyOpen(false)} title="Close" className="px-1.5">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="dither-rule bg-line-strong" />

      {st.phase === "idle" && <Intro ws={ws} st={st} running={running} />}

      {st.phase === "finding" && (
        <div className="space-y-3 px-4 py-5">
          <div className="relative h-2 overflow-hidden">
            <span className="dither-march absolute inset-0 bg-run" />
          </div>
          <p className="text-[12.5px] text-dim">Finding simplifications…</p>
          <p className="text-[11.5px] leading-relaxed text-mute">
            A read-only pass over this workspace's changes. Nothing is edited until you apply.
          </p>
          <Button variant="outline" className="justify-center" onClick={() => void useApp.getState().simplifyCancel(ws.id)}>
            Cancel
          </Button>
        </div>
      )}

      {(st.phase === "ready" || st.phase === "applying" || st.phase === "done") && (
        <>
          {st.candidates.length === 0 ? (
            <div className="space-y-3 px-4 py-5">
              <p className="text-[13px] font-medium text-fg">Nothing to simplify</p>
              <p className="text-[12px] leading-relaxed text-mute">
                {st.scopeFiles === 0
                  ? "This workspace has no changed source files to look at."
                  : `The ${st.scopeFiles} changed ${st.scopeFiles === 1 ? "file looks" : "files look"} clean already.`}
              </p>
              <Button variant="outline" className="justify-center" disabled={running} onClick={() => void useApp.getState().simplifyFind(ws.id)}>
                Look again
              </Button>
            </div>
          ) : (
            <>
              <Summary st={st} />
              <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {st.candidates.map((c) => (
                  <CandidateRow
                    key={c.id}
                    c={c}
                    row={rowOf.get(c.id)}
                    selectable={selectable(c)}
                    checked={picked.has(c.id)}
                    expanded={open === c.id}
                    onToggle={() => toggle(c.id)}
                    onExpand={() => setOpen(open === c.id ? null : c.id)}
                  />
                ))}
              </ul>
              <div className="dither-rule bg-line-strong" />
              <Footer
                st={st}
                running={running}
                ticked={ticked}
                lowRisk={lowRisk}
                lowRiskButton={lowRiskButton}
                onApply={apply}
                onFind={() => void useApp.getState().simplifyFind(ws.id)}
                onCancel={() => void useApp.getState().simplifyCancel(ws.id)}
              />
            </>
          )}
        </>
      )}
    </aside>
  );
}

function Intro({ ws, st, running }: { ws: Workspace; st: SimplifyState; running: boolean }) {
  return (
    <div className="space-y-3 px-4 py-5">
      <p className="text-[12.5px] leading-relaxed text-dim">
        Orbit asks Claude to read this workspace's changes (read-only) and list code that can be simpler without changing what it does. You pick which to apply.
      </p>
      <p className="text-[11.5px] leading-relaxed text-mute">
        Each one is a separate edit turn, then Orbit runs your checks and commits it as <span className="font-medium text-dim">refactor:</span>, or puts it back. Edits that touch tests are always put back.
      </p>
      {st.error && <p className="whitespace-pre-wrap break-words text-[12px] text-bad">{st.error}</p>}
      <Button variant="primary" className="w-full justify-center" disabled={running} onClick={() => void useApp.getState().simplifyFind(ws.id)}>
        <Shrink className="size-3.5" /> Find simplifications
      </Button>
      {running && <p className="text-[11.5px] text-mute">Available when the agent is idle.</p>}
    </div>
  );
}

function Summary({ st }: { st: SimplifyState }) {
  const sum = summarize(st.rows);
  const started = st.rows.some((r) => r.status !== "queued");
  return (
    <div className="space-y-1.5 px-4 pb-2 pt-3">
      <div className="flex items-center gap-2 text-[11.5px] tabular-nums">
        {started ? (
          <>
            <span className={cn("font-medium", sum.applied > 0 ? "text-ok" : "text-mute")}>{sum.applied} applied</span>
            {sum.skipped > 0 && <span className="font-medium text-warn">{sum.skipped} skipped</span>}
            {sum.noop > 0 && <span className="text-mute">{sum.noop} unchanged</span>}
            <span className="flex-1" />
            {sum.applied > 0 && (
              <span className="font-medium text-dim">
                {sum.linesRemoved >= 0 ? `−${sum.linesRemoved}` : `+${-sum.linesRemoved}`} lines
              </span>
            )}
          </>
        ) : (
          <span className="text-mute">
            {st.candidates.length} {st.candidates.length === 1 ? "candidate" : "candidates"} in {st.scopeFiles} {st.scopeFiles === 1 ? "file" : "files"}
          </span>
        )}
      </div>
      {st.cancelled && <p className="text-[11.5px] text-mute">Cancelled. The step in progress was put back.</p>}
      {st.scopeNote && <p className="text-[11.5px] leading-snug text-mute">{st.scopeNote}</p>}
      {!st.checkCommand && (
        <p className="text-[11.5px] leading-snug text-mute">
          No check command for this repo, so changes are applied unchecked. Set one in Settings &gt; Git.
        </p>
      )}
    </div>
  );
}

function RowStatus({ row }: { row: SimplifyRow | undefined }) {
  switch (row?.status) {
    case "editing":
    case "checking":
      return (
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-run">
          <LoaderCircle className="size-3 animate-spin" /> {row.status === "editing" ? "Editing" : "Checking"}
        </span>
      );
    case "applied":
      return (
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-ok">
          <Check className="size-3" /> {row.commit && <span className="font-mono">{row.commit}</span>}
        </span>
      );
    case "skipped":
      return <span className="shrink-0 text-[11px] font-medium text-warn">Skipped</span>;
    case "noop":
      return <span className="shrink-0 text-[11px] font-medium text-mute">No change</span>;
    default:
      return null;
  }
}

function CandidateRow({
  c,
  row,
  selectable,
  checked,
  expanded,
  onToggle,
  onExpand,
}: {
  c: SimplifyCandidate;
  row: SimplifyRow | undefined;
  selectable: boolean;
  checked: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
}) {
  const working = row?.status === "editing" || row?.status === "checking";
  const lines = c.endLine > c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
  return (
    <li className={cn("relative overflow-hidden rounded-[3px] px-2 py-2", working && "bg-hover", expanded && !working && "bg-hover/60")}>
      {working && <span className="dither-sweep bg-run opacity-[0.14]" />}
      <div className="relative flex items-start gap-2">
        <button
          role="checkbox"
          aria-checked={selectable ? checked : false}
          aria-label={`Apply: ${c.title}`}
          disabled={!selectable}
          onClick={onToggle}
          className={cn(
            "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-[3px] border-[1.5px] disabled:opacity-40",
            selectable && checked ? "border-accent bg-accent text-accent-fg" : "border-line-strong bg-raised",
          )}
        >
          {selectable && checked && <Check className="size-2.5" strokeWidth={3} />}
          {!selectable && row?.status && row.status !== "queued" && <Minus className="size-2.5 text-mute" />}
        </button>
        <button onClick={onExpand} className="min-w-0 flex-1 text-left" title="Show details">
          <span className="flex items-start gap-1">
            <ChevronRight className={cn("mt-[3px] size-3 shrink-0 text-mute transition-transform", expanded && "rotate-90")} />
            <span className="text-[12.5px] font-medium leading-snug text-fg">{c.title}</span>
          </span>
          <span className="mt-0.5 block truncate pl-4 font-mono text-[10.5px] text-mute" title={`${c.file}:${lines}`}>
            {c.file}:{lines}
          </span>
          <span className="mt-0.5 flex items-center gap-2 pl-4 text-[11px] font-medium">
            <span className="text-mute">{signalLabel[c.signal]}</span>
            <span className={riskTone[c.risk]}>{c.risk} risk</span>
            <span className="flex-1" />
            <RowStatus row={row} />
          </span>
        </button>
      </div>
      {row?.status === "skipped" && row.detail && <SkipDetail detail={row.detail} />}
      {row?.status === "applied" && row.unchecked && <p className="relative mt-1 pl-[22px] text-[11px] text-mute">Applied without a check.</p>}
      {expanded && (
        <div className="relative mt-2 space-y-2 pl-[22px] text-[12px] leading-relaxed">
          <p className="text-dim">{c.rationale}</p>
          <div>
            <p className="label mb-0.5 text-mute">Proposed change</p>
            <p className="whitespace-pre-wrap text-dim">{c.proposedChange}</p>
          </div>
        </div>
      )}
    </li>
  );
}

/** First line is the reason; anything after it is check output, kept short and monospaced. */
function SkipDetail({ detail }: { detail: string }) {
  const [reason, ...rest] = detail.split("\n");
  const output = rest.join("\n").trim();
  return (
    <div className="relative mt-1 space-y-1 pl-[22px]">
      <p className="text-[11.5px] text-warn">{reason}</p>
      {output && (
        <pre className="max-h-24 overflow-auto rounded-[3px] border border-line bg-bg p-1.5 font-mono text-[10.5px] leading-snug text-mute">{output}</pre>
      )}
    </div>
  );
}

function Footer({
  st,
  running,
  ticked,
  lowRisk,
  lowRiskButton,
  onApply,
  onFind,
  onCancel,
}: {
  st: SimplifyState;
  running: boolean;
  ticked: SimplifyCandidate[];
  lowRisk: SimplifyCandidate[];
  lowRiskButton: boolean;
  onApply: (list: SimplifyCandidate[]) => void;
  onFind: () => void;
  onCancel: () => void;
}) {
  if (st.phase === "applying") {
    return (
      <div className="space-y-2 px-4 py-3">
        <p className="text-[11.5px] text-mute">Applying one at a time. Watch each edit in the chat.</p>
        <Button variant="outline" className="w-full justify-center" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="grid grid-cols-1 gap-1.5">
        <Button variant="primary" className="justify-center" disabled={running || ticked.length === 0} onClick={() => onApply(ticked)}>
          Apply selected{ticked.length > 0 && ` (${ticked.length})`}
        </Button>
        {lowRiskButton && (
          <Button variant="outline" className="justify-center" disabled={running || lowRisk.length === 0} onClick={() => onApply(lowRisk)}>
            Apply all low-risk{lowRisk.length > 0 && ` (${lowRisk.length})`}
          </Button>
        )}
      </div>
      <button onClick={onFind} disabled={running} className="text-[11.5px] text-mute hover:text-fg disabled:opacity-40">
        Find again
      </button>
      {running && <p className="text-[11.5px] text-mute">Available when the agent is idle.</p>}
    </div>
  );
}
