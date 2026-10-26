import { Check, MessageSquare } from "lucide-react";
import { useMemo } from "react";
import type { PrFileStatus } from "../../lib/ipc";
import { usePrReview, type Opened } from "../../stores/prReview";
import { useReviewComments } from "../../stores/review";
import { DiffStat, cn } from "../ui";

const STATUS: Record<PrFileStatus, { letter: string; cls: string; label: string }> = {
  added: { letter: "A", cls: "text-ok", label: "Added" },
  modified: { letter: "M", cls: "text-warn", label: "Modified" },
  changed: { letter: "M", cls: "text-warn", label: "Changed" },
  removed: { letter: "D", cls: "text-bad", label: "Deleted" },
  renamed: { letter: "R", cls: "text-info", label: "Renamed" },
  copied: { letter: "C", cls: "text-info", label: "Copied" },
};

export function StatusLetter({ status }: { status: PrFileStatus }) {
  const s = STATUS[status];
  return <span title={s.label} className={cn("w-3 shrink-0 text-center text-[10.5px] font-semibold", s.cls)}>{s.letter}</span>;
}

/** Files grouped by folder, with viewed boxes and comment counts. */
export function FileTree({ opened, selected }: { opened: Opened; selected: string | null }) {
  const drafts = useReviewComments(opened.key);
  const { selectFile, setViewed } = usePrReview.getState();
  const groups = useMemo(() => {
    const m = new Map<string, typeof opened.files>();
    for (const f of opened.files) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      m.set(dir, [...(m.get(dir) ?? []), f]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [opened.files]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const t of opened.pr?.threads ?? []) if (!t.isResolved) c.set(t.path, (c.get(t.path) ?? 0) + 1);
    for (const d of drafts) c.set(d.path, (c.get(d.path) ?? 0) + 1);
    return c;
  }, [opened.pr, drafts]);
  const viewed = opened.files.filter((f) => f.viewed).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <span className="label text-mute">Files</span>
        <span className="text-[11px] tabular-nums text-mute">{opened.files.length}</span>
        <span className="ml-auto text-[11px] tabular-nums text-mute">{viewed}/{opened.files.length} viewed</span>
      </div>
      <div className="mx-3 mb-2 h-[3px] overflow-hidden rounded-full bg-line">
        <div className="h-full bg-fg/70 transition-[width]" style={{ width: `${opened.files.length ? (viewed / opened.files.length) * 100 : 0}%` }} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {groups.map(([dir, files]) => (
          <div key={dir} className="mt-1">
            {dir && <div className="truncate px-3 py-0.5 font-mono text-[10.5px] text-mute" title={dir}>{dir}/</div>}
            {files.map((f) => {
              const name = f.path.slice(f.path.lastIndexOf("/") + 1);
              const n = counts.get(f.path) ?? 0;
              return (
                <div
                  key={f.path}
                  role="button"
                  tabIndex={-1}
                  onClick={() => selectFile(f.path)}
                  data-review-file={f.path}
                  className={cn(
                    "group mx-1.5 flex h-7 cursor-pointer items-center gap-1.5 rounded-[4px] pl-2 pr-1.5 text-[12px]",
                    selected === f.path ? "bg-raised text-fg" : "text-dim hover:bg-hover hover:text-fg",
                  )}
                  title={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}
                >
                  <StatusLetter status={f.status} />
                  <span className={cn("min-w-0 flex-1 truncate font-mono text-[11.5px]", f.viewed && "text-mute line-through decoration-line-strong", f.status === "removed" && "text-mute")}>{name}</span>
                  {n > 0 && (
                    <span className="flex items-center gap-0.5 text-[10.5px] tabular-nums text-mute">
                      <MessageSquare className="size-3" />
                      {n}
                    </span>
                  )}
                  <DiffStat additions={f.additions} deletions={f.deletions} className="text-[10.5px]" />
                  <button
                    onClick={(e) => (e.stopPropagation(), setViewed(f.path, !f.viewed))}
                    title={f.viewed ? "Viewed (click to unmark)" : "Mark viewed"}
                    aria-label={`${f.viewed ? "Unmark" : "Mark"} ${f.path} viewed`}
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded-[3px] border-[1.5px]",
                      f.viewed ? "border-fg bg-fg text-bg" : "border-line-strong text-transparent hover:border-fg",
                    )}
                  >
                    <Check className="size-2.5" strokeWidth={3.5} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
