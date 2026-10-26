import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ExternalLink, GitBranch, MessageSquareText, RefreshCw, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PrDetail, ReviewVerdict } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { localSig, usePrReview, type Opened } from "../../stores/prReview";
import { discardReview, sendReview, useReviewComments } from "../../stores/review";
import { AgentIcon, Button, cn } from "../ui";
import { PrActions } from "./PrActions";
import { Avatar } from "./ThreadCard";

function StateBadge({ pr }: { pr: PrDetail }) {
  const [label, cls] =
    pr.state === "MERGED" ? ["Merged", "border-merged/60 text-merged"] : pr.state === "CLOSED" ? ["Closed", "border-bad/60 text-bad"] : pr.isDraft ? ["Draft", "border-line-strong text-mute"] : ["Open", "border-ok/60 text-ok"];
  return <span className={cn("rounded-[3px] border-[1.5px] px-1.5 text-[11px] font-medium leading-[18px]", cls)}>{label}</span>;
}

function Checks({ pr }: { pr: PrDetail }) {
  const c = pr.checks;
  const total = c.passed + c.failed + c.pending;
  if (!total) return null;
  const [dot, text] = c.failed ? ["bg-bad", `${c.failed} failing`] : c.pending ? ["bg-run", `${c.pending} running`] : ["bg-ok", "Checks pass"];
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-dim" title={c.failing.length ? `Failing: ${c.failing.join(", ")}` : `${c.passed}/${total} passed`}>
      <span className={cn("size-1.5 rounded-full", dot)} />
      {text}
    </span>
  );
}

const Branch = ({ head, base }: { head: string; base: string }) => (
  <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-mute">
    <GitBranch className="size-3 shrink-0" />
    <code className="truncate font-mono text-[11px] text-dim">{head}</code>
    <span>→</span>
    <code className="font-mono text-[11px] text-dim">{base}</code>
  </span>
);

export function ReviewHeader({ opened }: { opened: Opened }) {
  const loading = usePrReview((s) => s.loading);
  const reload = () => void usePrReview.getState().reload();
  const refresh = (
    <button onClick={reload} title="Reload" className="grid size-7 place-items-center rounded-[4px] text-mute hover:bg-hover hover:text-fg">
      <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
    </button>
  );
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-3 border-b-[1.5px] border-line px-5 py-2" data-tauri-drag-region>
      {opened.pr ? <PrTitle pr={opened.pr} /> : <LocalTitle opened={opened} />}
      <span className="flex-1" />
      <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      {refresh}
      {opened.pr ? (
        <>
          <Button variant="ghost" onClick={() => void openUrl(opened.pr!.url)} title="Open on GitHub" aria-label="Open on GitHub">
            <ExternalLink className="size-3.5" />
          </Button>
          <PrActions pr={opened.pr} />
          <SubmitReview opened={opened} pr={opened.pr} />
        </>
      ) : (
        <LocalActions opened={opened} />
      )}
      </div>
    </header>
  );
}

function PrTitle({ pr }: { pr: PrDetail }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <StateBadge pr={pr} />
        <h1 className="selectable truncate text-[14.5px] font-semibold tracking-[-0.015em]">{pr.title}</h1>
        <span className="shrink-0 text-[14px] text-mute tabular-nums">#{pr.number}</span>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-3 whitespace-nowrap">
        <span className="flex items-center gap-1.5 text-[11.5px] text-dim">
          <Avatar login={pr.author} url={pr.authorAvatarUrl} size={16} />
          {pr.author}
        </span>
        <span className="text-[11.5px] text-mute">{pr.repo}</span>
        <Branch head={pr.headRef} base={pr.baseRef} />
        <Checks pr={pr} />
        {pr.reviewDecision === "APPROVED" && <span className="text-[11.5px] font-medium text-ok">Approved</span>}
        {pr.reviewDecision === "CHANGES_REQUESTED" && <span className="text-[11.5px] font-medium text-warn">Changes requested</span>}
      </div>
    </div>
  );
}

function LocalTitle({ opened }: { opened: Opened }) {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === opened.local!.workspaceId));
  const repo = useApp((s) => s.repos.find((r) => r.id === ws?.repoId));
  if (!ws) return <h1 className="text-[14.5px] font-semibold">Workspace</h1>;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="rounded-[3px] border-[1.5px] border-line-strong px-1.5 text-[11px] font-medium leading-[18px] text-dim">Local</span>
        <h1 className="truncate text-[14.5px] font-semibold tracking-[-0.015em]">{ws.name}</h1>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-3 whitespace-nowrap text-[11.5px] text-dim">
        <span className="flex items-center gap-1.5"><AgentIcon agent={ws.agent} className="size-3" />{repo?.name}</span>
        <Branch head={ws.branch} base={repo?.baseBranch ?? "main"} />
        {opened.local!.dirty && <span className="text-mute">includes uncommitted changes</span>}
        {ws.status === "running" && <span className="flex items-center gap-1.5 text-run"><span className="size-1.5 rounded-full bg-run" />agent is working</span>}
      </div>
    </div>
  );
}

function LocalActions({ opened }: { opened: Opened }) {
  const id = opened.local!.workspaceId;
  const drafts = useReviewComments(id);
  const reviewed = usePrReview((s) => s.reviewed[opened.key] === localSig(opened.local!.files));
  return (
    <>
      <Button variant="ghost" onClick={() => (useApp.getState().select(id), useApp.getState().setView("workspace"))} title="Open the workspace chat">
        <MessageSquareText className="size-3.5" /> Chat
      </Button>
      <Button variant="outline" disabled={reviewed} onClick={() => usePrReview.getState().markReviewed()} title="Remember this state; later agent changes show as new" data-testid="review-mark-reviewed">
        {reviewed ? "Reviewed" : "Mark reviewed"}
      </Button>
      {drafts.length > 0 && <Button onClick={() => void discardReview(id)}>Discard</Button>}
      <Button
        variant="primary"
        disabled={!drafts.length}
        onClick={async () => {
          if (await sendReview(id)) {
            useApp.getState().select(id);
            useApp.getState().setView("workspace");
          }
        }}
        data-testid="review-send-agent"
      >
        <Send className="size-3.5" /> Send to agent{drafts.length ? ` (${drafts.length})` : ""}
      </Button>
    </>
  );
}

const VERDICTS: { v: ReviewVerdict; label: string; hint: string }[] = [
  { v: "COMMENT", label: "Comment", hint: "General feedback without explicit approval." },
  { v: "APPROVE", label: "Approve", hint: "Give your approval to merge these changes." },
  { v: "REQUEST_CHANGES", label: "Request changes", hint: "Feedback that must be addressed before merging." },
];

function SubmitReview({ pr }: { opened: Opened; pr: PrDetail }) {
  // Your pending review lives on GitHub, so it is also visible (to you) on github.com.
  const drafts = pr.pendingReview?.comments ?? [];
  const busy = usePrReview((s) => s.busy);
  const error = usePrReview((s) => s.error);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [verdict, setVerdict] = useState<ReviewVerdict>("COMMENT");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [open]);
  const own = pr.viewerDidAuthor;
  const closed = pr.state !== "OPEN";
  const empty = verdict !== "APPROVE" && !body.trim() && !drafts.length;
  const stale = error?.startsWith("stale:");
  const go = async () => {
    if (await usePrReview.getState().submit(verdict, body.trim())) {
      setBody("");
      setVerdict("COMMENT");
      setOpen(false);
    }
  };
  return (
    <div className="relative" ref={ref}>
      <Button variant="primary" onClick={() => setOpen((o) => !o)} disabled={closed} data-testid="review-submit-open">
        Review{drafts.length ? ` (${drafts.length})` : ""} <ChevronDown className="size-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-[420px] rounded-[6px] border-[1.5px] border-line-strong bg-panel p-3 shadow-pop">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[13px] font-semibold">Finish your review</span>
            <span className="text-[11.5px] text-mute tabular-nums">
              {drafts.length} pending comment{drafts.length === 1 ? "" : "s"}
              {pr.pendingReview && (
                <button className="ml-2 underline underline-offset-2 hover:text-bad" onClick={async () => (await usePrReview.getState().discardPending()) && setOpen(false)} data-testid="review-discard-pending">
                  Discard
                </button>
              )}
            </span>
          </div>
          <textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !empty) void go();
            }}
            rows={5}
            placeholder="Leave a summary (Markdown)"
            className="selectable w-full resize-y rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 py-1.5 text-[12.5px] focus:border-line-strong focus:outline-none"
          />
          <div className="mt-2 space-y-1">
            {VERDICTS.map(({ v, label, hint }) => {
              const disabled = own && v !== "COMMENT";
              return (
                <label key={v} className={cn("flex cursor-pointer items-start gap-2.5 rounded-[4px] px-2 py-1.5", verdict === v ? "bg-raised" : "hover:bg-hover", disabled && "pointer-events-none opacity-40")}>
                  <input type="radio" name="verdict" checked={verdict === v} disabled={disabled} onChange={() => setVerdict(v)} className="mt-[3px] accent-[var(--fg)]" />
                  <span>
                    <span className={cn("block text-[12.5px] font-medium", v === "APPROVE" && "text-ok", v === "REQUEST_CHANGES" && "text-warn")}>{label}</span>
                    <span className="block text-[11.5px] text-mute">{disabled ? "You can't do this on your own pull request." : hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {error && (
            <div className="mt-2 rounded-[4px] border border-bad/50 px-2.5 py-1.5 text-[11.5px] text-bad">
              {stale ? "New commits were pushed since you loaded this PR. Reload to see them; your pending comments are kept." : error}
              {stale && (
                <button className="ml-2 font-medium underline underline-offset-2" onClick={() => (usePrReview.setState({ error: null }), void usePrReview.getState().reload())}>
                  Reload
                </button>
              )}
            </div>
          )}
          <div className="mt-3 flex justify-end gap-1.5">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={empty || busy === "submit"} onClick={() => void go()} data-testid="review-submit">
              {busy === "submit" ? "Submitting…" : "Submit review"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
