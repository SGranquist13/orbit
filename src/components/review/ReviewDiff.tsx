import { ChevronsUpDown, LoaderCircle } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DiffSide, PrThread } from "../../lib/ipc";
import { collapse, inlineChanges, lineDiff, pairs, splitLines, splitRows, type Block, type Ranges, type Row } from "../../lib/review/diff";
import { highlightLines, type Token } from "../../lib/review/highlight";
import { usePrReview, type Opened, type ReviewFile, type Texts } from "../../stores/prReview";
import { useReview, useReviewComments, type ReviewComment } from "../../stores/review";
import { cn } from "../ui";
import { Composer, DraftCard, ThreadCard } from "./ThreadCard";

const LARGE = 4_000;
type Pick = { side: DiffSide; start: number; end: number; editId?: string; text?: string };
const at = (side: DiffSide, line: number) => `${side}:${line}`;

/** Tokens with the in-line changed ranges wrapped in `.rv-word`. */
function renderLine(tokens: Token[] | undefined, plain: string, ranges: Ranges | undefined): ReactNode {
  const toks = tokens ?? [{ text: plain, cls: "" }];
  if (!toks.length) return " ";
  if (!ranges?.length) return toks.map((t, i) => (t.cls ? <span key={i} className={t.cls}>{t.text}</span> : <Fragment key={i}>{t.text}</Fragment>));
  const out: ReactNode[] = [];
  let pos = 0;
  toks.forEach((t, i) => {
    const end = pos + t.text.length;
    const cuts = new Set([pos, end]);
    for (const [a, b] of ranges) {
      if (a > pos && a < end) cuts.add(a);
      if (b > pos && b < end) cuts.add(b);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k < points.length - 1; k++) {
      const [a, b] = [points[k], points[k + 1]];
      const inWord = ranges.some(([x, y]) => a >= x && b <= y);
      const text = t.text.slice(a - pos, b - pos);
      out.push(<span key={`${i}-${a}`} className={cn(t.cls, inWord && "rv-word")}>{text}</span>);
    }
    pos = end;
  });
  return out;
}

export function ReviewDiff({ opened, file, layout, wrap, context }: { opened: Opened; file: ReviewFile; layout: "unified" | "split"; wrap: boolean; context: number }) {
  const [texts, setTexts] = useState<Texts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<{ old: Token[][]; new: Token[][] } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pick, setPick] = useState<Pick | null>(null);
  const [anchor, setAnchor] = useState<{ side: DiffSide; line: number } | null>(null);
  const [forceLarge, setForceLarge] = useState(false);
  const github = !!opened.pr;
  const drafts = useReviewComments(opened.key);

  useEffect(() => {
    let live = true;
    setTexts(null), setTokens(null), setError(null), setExpanded(new Set()), setPick(null), setForceLarge(false);
    usePrReview
      .getState()
      .loadTexts(file.path)
      .then(async (t) => {
        if (!live) return;
        setTexts(t);
        const [o, n] = await Promise.all([
          t.old ? highlightLines(t.old, file.previousPath ?? file.path) : [],
          t.new ? highlightLines(t.new, file.path) : [],
        ]);
        if (live) setTokens({ old: o, new: n });
      })
      .catch((e) => live && setError(String(e).replace(/^Error:\s*/, "")));
    return () => {
      live = false;
    };
  }, [opened.key, opened.pr?.headSha, opened.local?.headSha, file.path, file.previousPath, file.additions, file.deletions]);

  const oldLines = useMemo(() => splitLines(texts?.old ?? null), [texts]);
  const newLines = useMemo(() => splitLines(texts?.new ?? null), [texts]);
  const rows = useMemo(() => (texts ? lineDiff(oldLines, newLines) : []), [texts, oldLines, newLines]);
  const paired = useMemo(() => pairs(rows), [rows]);
  const inline = useMemo(() => {
    const m = new Map<number, { a: Ranges; b: Ranges }>();
    for (const [n, o] of paired) m.set(n, inlineChanges(oldLines[o - 1] ?? "", newLines[n - 1] ?? ""));
    return m;
  }, [paired, oldLines, newLines]);
  const oldInline = useMemo(() => {
    const m = new Map<number, Ranges>();
    for (const [n, o] of paired) m.set(o, inline.get(n)?.a ?? []);
    return m;
  }, [paired, inline]);

  const threads = useMemo(() => (opened.pr?.threads ?? []).filter((t) => t.path === file.path), [opened.pr, file.path]);
  const outdated = threads.filter((t) => t.line === null);
  const fileDrafts = drafts.filter((d) => d.path === file.path);
  const anchored = useMemo(() => {
    const m = new Map<string, { threads: PrThread[]; drafts: ReviewComment[] }>();
    const slot = (k: string) => m.get(k) ?? (m.set(k, { threads: [], drafts: [] }), m.get(k)!);
    for (const t of threads) if (t.line !== null) slot(at(t.side, t.line)).threads.push(t);
    for (const d of fileDrafts) if (pick?.editId !== d.id) slot(at(d.side, d.endLine)).drafts.push(d);
    return m;
  }, [threads, fileDrafts, pick?.editId]);

  const blocks: Block[] = useMemo(
    () => collapse(rows, context, (r) => (r.kind !== "add" && m(anchored, "old", r.old)) || (r.kind !== "del" && m(anchored, "new", r.new)) || pickHas(pick, r)),
    [rows, context, anchored, pick],
  );

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!texts) return <Notice><LoaderCircle className="mr-2 inline size-3.5 animate-spin" />Loading {file.path}…</Notice>;
  if (texts.unreadable) return <Notice>Binary file or too large to show.</Notice>;
  if (!rows.length) return <Notice>Empty file.</Notice>;
  if (!rows.some((r) => r.kind !== "ctx")) return <Notice>{file.status === "renamed" ? `Renamed from ${file.previousPath} without changes.` : "No changes in this file."}</Notice>;
  if (rows.length > LARGE && !forceLarge)
    return (
      <Notice>
        Large diff ({rows.length.toLocaleString()} lines).{" "}
        <button className="font-medium text-fg underline underline-offset-2" onClick={() => setForceLarge(true)}>Show it anyway</button>
      </Notice>
    );

  const sideText = (side: DiffSide, a: number, b: number) => (side === "old" ? oldLines : newLines).slice(a - 1, b);
  const clickLine = (side: DiffSide, line: number, shift: boolean) => {
    if (shift && anchor && anchor.side === side) setPick({ side, start: Math.min(anchor.line, line), end: Math.max(anchor.line, line) });
    else setPick({ side, start: line, end: line });
    setAnchor({ side, line });
  };
  const picked = (side: DiffSide, line: number | undefined) => !!pick && line !== undefined && pick.side === side && line >= pick.start && line <= pick.end && !pick.editId;

  const cards = (side: DiffSide, line: number) => {
    const slot = anchored.get(at(side, line));
    const composing = pick && pick.side === side && pick.end === line;
    if (!slot && !composing) return null;
    return (
      <>
        {slot?.threads.map((t) => <ThreadCard key={t.id} thread={t} original={sideText(t.side, t.startLine ?? t.line!, t.line!)} />)}
        {slot?.drafts.map((d) => (
          <DraftCard key={d.id} draftKey={opened.key} c={d} original={sideText(d.side, d.startLine, d.endLine)} onEdit={() => setPick({ side: d.side, start: d.startLine, end: d.endLine, editId: d.id, text: d.text })} />
        ))}
        {composing && (
          <Composer
            key={`${pick.side}-${pick.start}-${pick.end}-${pick.editId ?? ""}`}
            label={`${pick.editId ? "Edit comment on" : "Comment on"} ${pick.start === pick.end ? `line ${pick.start}` : `lines ${pick.start}–${pick.end}`}${pick.side === "old" ? " (base)" : ""}`}
            initial={pick.text ?? ""}
            github={github}
            canSuggest={pick.side === "new"}
            selected={sideText(pick.side, pick.start, pick.end)}
            onCancel={() => setPick(null)}
            onDraft={(text) => {
              const r = useReview.getState();
              if (pick.editId) r.update(opened.key, pick.editId, text);
              else r.add(opened.key, { path: file.path, side: pick.side, startLine: pick.start, endLine: pick.end, text, excerpt: sideText(pick.side, pick.start, pick.end).join("\n") });
              setPick(null);
            }}
            onPostNow={github && !pick.editId ? (text) => usePrReview.getState().postNow({ path: file.path, side: pick.side, startLine: pick.start, endLine: pick.end, text }) : undefined}
          />
        )}
      </>
    );
  };

  const num = (side: DiffSide, line: number | undefined) =>
    line === undefined ? <span className="rv-num" /> : (
      <span className="rv-num" onMouseDown={(e) => (e.preventDefault(), clickLine(side, line, e.shiftKey))} title="Comment (Shift-click for a range)">
        {line}
      </span>
    );
  const sign = (side: DiffSide, line: number | undefined, ch: string) => (
    <span className="rv-sign">
      {ch}
      {line !== undefined && (
        <span className="rv-plus" onMouseDown={(e) => (e.preventDefault(), clickLine(side, line, e.shiftKey))} title="Comment (Shift-click for a range)">+</span>
      )}
    </span>
  );
  const text = (r: Row, side: DiffSide) => {
    const line = side === "old" ? (r.kind === "add" ? undefined : r.old) : r.kind === "del" ? undefined : r.new;
    if (line === undefined) return <span className="rv-text" />;
    const toks = (side === "old" ? tokens?.old : tokens?.new)?.[line - 1];
    const plain = (side === "old" ? oldLines : newLines)[line - 1] ?? "";
    const ranges = r.kind === "add" ? inline.get(r.new)?.b : r.kind === "del" ? oldInline.get(r.old) : undefined;
    return <span className="rv-text">{renderLine(toks, plain, ranges)}</span>;
  };
  const cls = (r: Row | null) => (!r ? "rv-empty" : r.kind === "add" ? "rv-add" : r.kind === "del" ? "rv-del" : "");

  const renderRows = (rs: Row[]) =>
    layout === "unified"
      ? rs.map((r, i) => {
          const side: DiffSide = r.kind === "del" ? "old" : "new";
          const line = r.kind === "del" ? r.old : r.new;
          return (
            <Fragment key={i}>
              <div className={cn("rv-row rv-line", cls(r), picked(side, line) && "rv-picked")}>
                {num("old", r.kind === "add" ? undefined : r.old)}
                {num("new", r.kind === "del" ? undefined : r.new)}
                {sign(side, line, r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ")}
                {text(r, side)}
              </div>
              {r.kind === "ctx" ? (<>{cards("old", r.old)}{cards("new", r.new)}</>) : cards(side, line)}
            </Fragment>
          );
        })
      : splitRows(rs).map((s, i) => {
          const l = s.left && s.left.kind !== "add" ? s.left.old : undefined;
          const rr = s.right && s.right.kind !== "del" ? s.right.new : undefined;
          const left = l !== undefined ? cards("old", l) : null;
          const right = rr !== undefined ? cards("new", rr) : null;
          return (
            <Fragment key={i}>
              <div className="rv-split">
                <div className={cn("rv-half", s.left?.kind === "ctx" ? "" : cls(s.left), picked("old", l) && "rv-picked")}>
                  {num("old", l)}
                  {sign("old", l, s.left?.kind === "del" ? "−" : " ")}
                  {s.left ? text(s.left, "old") : <span className="rv-text" />}
                </div>
                <div className={cn("rv-half", s.right?.kind === "ctx" ? "" : cls(s.right), picked("new", rr) && "rv-picked")}>
                  {num("new", rr)}
                  {sign("new", rr, s.right?.kind === "add" ? "+" : " ")}
                  {s.right ? text(s.right, "new") : <span className="rv-text" />}
                </div>
              </div>
              {(left || right) && (
                <div className="rv-split">
                  <div className="min-w-0 py-0.5">{left}</div>
                  <div className="min-w-0 border-l-[1.5px] border-line py-0.5">{right}</div>
                </div>
              )}
            </Fragment>
          );
        });

  return (
    <div className={cn("rv-code select-text", wrap && "rv-wrap")} data-review-diff={file.path}>
      {outdated.length > 0 && (
        <div className="border-b-[1.5px] border-line py-1.5">
          <div className="px-4 pb-1 font-sans text-[11px] font-medium text-mute">Comments on lines that have since changed</div>
          {outdated.map((t) => <ThreadCard key={t.id} thread={t} />)}
        </div>
      )}
      {blocks.map((b) =>
        b.kind === "gap" && !expanded.has(b.id) ? (
          <button
            key={b.id}
            onClick={() => setExpanded((s) => new Set(s).add(b.id))}
            className="flex w-full items-center gap-2 border-y border-line bg-panel px-4 py-1 font-sans text-[11.5px] text-mute hover:bg-hover hover:text-fg"
          >
            <ChevronsUpDown className="size-3.5" />
            Show {b.rows.length} unchanged line{b.rows.length === 1 ? "" : "s"}
            <span className="tabular-nums opacity-70">
              {first(b.rows)}–{last(b.rows)}
            </span>
          </button>
        ) : (
          <Fragment key={b.kind === "gap" ? b.id : `rows-${rowKey(b.rows[0])}`}>{renderRows(b.rows)}</Fragment>
        ),
      )}
    </div>
  );
}

const m = (a: Map<string, unknown>, side: DiffSide, line: number) => a.has(at(side, line));
const pickHas = (p: Pick | null, r: Row) => !!p && ((p.side === "old" && r.kind !== "add" && r.old >= p.start && r.old <= p.end) || (p.side === "new" && r.kind !== "del" && r.new >= p.start && r.new <= p.end));
const lineOf = (r: Row) => (r.kind === "del" ? r.old : r.new);
const first = (rs: Row[]) => lineOf(rs[0]);
const last = (rs: Row[]) => lineOf(rs[rs.length - 1]);
const rowKey = (r: Row) => (r.kind === "ctx" ? `c${r.old}-${r.new}` : r.kind === "del" ? `d${r.old}` : `a${r.new}`);

function Notice({ children, tone }: { children: ReactNode; tone?: "bad" }) {
  return <div className={cn("selectable px-6 py-10 text-center font-sans text-[12.5px]", tone === "bad" ? "text-bad" : "text-mute")}>{children}</div>;
}
