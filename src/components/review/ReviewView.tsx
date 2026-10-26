import { ChevronLeft, ChevronRight, Code2, Columns2, Eye, LoaderCircle, Rows2, Space, WrapText } from "lucide-react";
import { useEffect } from "react";
import { useApp } from "../../stores/app";
import { rangeShas, usePrReview, type Range } from "../../stores/prReview";
import type { PrDetail } from "../../lib/ipc";
import { isImage, isRich } from "./RichDiff";
import { Kbd, cn } from "../ui";
import { Conversation } from "./Conversation";
import { FileTree, StatusLetter } from "./FileTree";
import { ReviewDiff } from "./ReviewDiff";
import { ReviewHeader } from "./ReviewHeader";
import { ReviewQueue } from "./ReviewQueue";
import { DiffStat } from "../ui";

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** The Review view: a queue of local workspaces and GitHub PRs, and a careful file-by-file review of one. */
export function ReviewView() {
  const { opened, loading, error, file, tab } = usePrReview();
  const settings = useApp((s) => s.settings);
  const layout = usePrReview((s) => s.layout) ?? settings?.reviewDiffLayout ?? "unified";
  const wrap = usePrReview((s) => s.wrap) ?? settings?.reviewWrapLines ?? false;
  const context = settings?.reviewContextLines ?? 3;
  const hideWhitespace = usePrReview((s) => s.hideWhitespace) ?? settings?.reviewHideWhitespace ?? false;
  const preview = usePrReview((s) => s.preview);
  const rangeView = usePrReview((s) => s.rangeView);
  const range = usePrReview((s) => s.range);
  // A range has its own file list; viewed marks always come from the whole PR.
  const files = rangeView ? rangeView.files.map((f) => ({ ...f, viewed: opened?.files.find((x) => x.path === f.path)?.viewed ?? false })) : (opened?.files ?? []);
  const current = files.find((f) => f.path === file) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = usePrReview.getState();
      if (!s.opened) return;
      if (e.key === "]") s.step(1);
      else if (e.key === "[") s.step(-1);
      else if (e.key === "v" && s.file) s.setViewed(s.file, !s.opened.files.find((f) => f.path === s.file)?.viewed);
      else if (e.key === "w") s.setHideWhitespace(!(s.hideWhitespace ?? useApp.getState().settings?.reviewHideWhitespace ?? false));
      else if (e.key === "o" && s.file) void s.openInCode(s.file);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-w-0 flex-1 bg-bg" data-view="review">
      <ReviewQueue />
      <main className="flex min-w-0 flex-1 flex-col">
        {!opened ? (
          <Empty loading={loading} error={error} />
        ) : (
          <>
            <ReviewHeader opened={opened} />
            {error && <div className="selectable border-b border-bad/40 px-5 py-1.5 text-[12px] text-bad">{error.startsWith("stale:") ? "New commits were pushed since you loaded this PR. Reload to see them." : error}</div>}
            {opened.pr && (
              <div className="flex h-9 shrink-0 items-end gap-4 border-b-[1.5px] border-line px-5">
                <Tab active={tab === "files"} onClick={() => usePrReview.getState().setTab("files")} count={opened.files.length}>Files</Tab>
                <Tab active={tab === "conversation"} onClick={() => usePrReview.getState().setTab("conversation")} count={opened.pr.comments.length + opened.pr.reviews.filter((r) => r.body.trim()).length}>
                  Conversation
                </Tab>
              </div>
            )}
            {opened.pr && tab === "conversation" ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Conversation pr={opened.pr} />
              </div>
            ) : opened.files.length === 0 ? (
              <div className="grid flex-1 place-items-center text-[12.5px] text-mute">No changes to review.</div>
            ) : (
              <div className="flex min-h-0 flex-1">
                <div className="flex w-[300px] shrink-0 flex-col border-r-[1.5px] border-line">
                  {opened.pr && opened.pr.commits.length > 0 && <RangePicker pr={opened.pr} range={range} />}
                  <div className="min-h-0 flex-1">
                    <FileTree opened={opened} files={files} selected={file} />
                  </div>
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  {current && (
                    <div className="flex h-9 shrink-0 items-center gap-2 border-b-[1.5px] border-line px-3">
                      <StatusLetter status={current.status} />
                      <code className="selectable min-w-0 truncate font-mono text-[11.5px] text-fg" title={current.path}>
                        {current.previousPath && <span className="text-mute">{current.previousPath} → </span>}
                        {current.path}
                      </code>
                      <DiffStat additions={current.additions} deletions={current.deletions} />
                      <span className="flex-1" />
                      <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-dim hover:text-fg" title="Toggle viewed (V)">
                        <input type="checkbox" checked={current.viewed} onChange={(e) => usePrReview.getState().setViewed(current.path, e.target.checked)} className="accent-[var(--fg)]" data-testid="review-viewed" />
                        Viewed
                      </label>
                      <span className="mx-1 h-4 w-[1.5px] bg-line" />
                      {isRich(current.path) && (
                        <Seg active={preview} onClick={() => usePrReview.getState().setPreview(!preview)} title={preview ? "Show the source diff" : "Show it rendered"}><Eye className="size-3.5" /></Seg>
                      )}
                      {!isImage(current.path) && (
                        <Seg active={hideWhitespace} onClick={() => usePrReview.getState().setHideWhitespace(!hideWhitespace)} title="Hide whitespace changes (W)"><Space className="size-3.5" /></Seg>
                      )}
                      <Seg active={layout === "unified"} onClick={() => usePrReview.getState().setLayout("unified")} title="Unified"><Rows2 className="size-3.5" /></Seg>
                      <Seg active={layout === "split"} onClick={() => usePrReview.getState().setLayout("split")} title="Split"><Columns2 className="size-3.5" /></Seg>
                      <Seg active={wrap} onClick={() => usePrReview.getState().setWrap(!wrap)} title="Wrap lines"><WrapText className="size-3.5" /></Seg>
                      <span className="mx-1 h-4 w-[1.5px] bg-line" />
                      <Seg onClick={() => void usePrReview.getState().openInCode(current.path)} title={current.status === "removed" ? "Deleted in this change" : "Open in Code (O)"} disabled={current.status === "removed"}>
                        <Code2 className="size-3.5" />
                      </Seg>
                      <Seg onClick={() => usePrReview.getState().step(-1)} title="Previous file ([)"><ChevronLeft className="size-3.5" /></Seg>
                      <Seg onClick={() => usePrReview.getState().step(1)} title="Next file (])"><ChevronRight className="size-3.5" /></Seg>
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-auto">
                    {current && <ReviewDiff key={`${opened.key}:${current.path}`} opened={opened} file={current} layout={layout} wrap={wrap} context={context} hideWhitespace={hideWhitespace} preview={preview} rangeView={rangeView} />}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Tab({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn("-mb-[1.5px] flex h-9 items-center gap-1.5 border-b-[1.5px] px-0.5 text-[12.5px] font-medium", active ? "border-fg text-fg" : "border-transparent text-mute hover:text-fg")}>
      {children}
      <span className="rounded-[3px] bg-raised px-1 text-[10.5px] tabular-nums text-mute">{count}</span>
    </button>
  );
}

function Seg({ active, onClick, title, disabled, children }: { active?: boolean; onClick: () => void; title: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} aria-pressed={active} disabled={disabled} className={cn("grid size-7 place-items-center rounded-[4px] disabled:opacity-40", active ? "bg-raised text-fg" : "text-mute hover:bg-hover hover:text-fg")}>
      {children}
    </button>
  );
}

/** All changes, only what's new since your last review, or one commit. */
function RangePicker({ pr, range }: { pr: PrDetail; range: Range }) {
  const since = rangeShas(pr, { kind: "since" });
  const value = range.kind === "commit" ? `commit:${range.oid}` : range.kind;
  const pick = (v: string) =>
    void usePrReview.getState().setRange(v === "all" ? { kind: "all" } : v === "since" ? { kind: "since" } : { kind: "commit", oid: v.slice(7) });
  return (
    <div className="border-b-[1.5px] border-line px-3 py-2.5">
      <select
        value={value}
        onChange={(e) => pick(e.target.value)}
        aria-label="Changes to show"
        data-testid="review-range"
        className="h-7 w-full rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] font-medium text-fg focus:outline-none"
      >
        <option value="all">All changes ({pr.commits.length} commit{pr.commits.length === 1 ? "" : "s"})</option>
        {since && <option value="since">{since.label}</option>}
        <optgroup label="One commit">
          {pr.commits.map((c) => (
            <option key={c.oid} value={`commit:${c.oid}`}>
              {c.oid.slice(0, 7)} {c.message}
            </option>
          ))}
        </optgroup>
      </select>
      {range.kind === "since" && <p className="mt-1.5 text-[11px] text-mute">Only what changed after the commit you last reviewed.</p>}
    </div>
  );
}

function Empty({ loading, error }: { loading: boolean; error: string | null }) {
  return (
    <div className="grid flex-1 place-items-center" data-tauri-drag-region>
      {loading ? (
        <LoaderCircle className="size-4 animate-spin text-mute" />
      ) : (
        <div className="max-w-[380px] text-center">
          <p className="label text-mute">Review</p>
          <p className="mt-2 text-[13px] text-dim">Pick a workspace to read what its agent changed, or a pull request to review it here instead of on GitHub.</p>
          {error && <p className="selectable mt-3 text-[12px] text-bad">{error}</p>}
          <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-[11.5px] text-mute">
            <span className="flex items-center gap-1.5"><Kbd>[</Kbd><Kbd>]</Kbd> files</span>
            <span className="flex items-center gap-1.5"><Kbd>V</Kbd> viewed</span>
            <span className="flex items-center gap-1.5"><Kbd>W</Kbd> whitespace</span>
            <span className="flex items-center gap-1.5"><Kbd>O</Kbd> open in Code</span>
            <span className="flex items-center gap-1.5"><Kbd>Shift</Kbd> click for a range</span>
          </div>
        </div>
      )}
    </div>
  );
}
