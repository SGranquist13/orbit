import { GitPullRequest, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReviewQueueItem, ReviewQueueSource } from "../../lib/ipc";
import { diffTotals, useApp } from "../../stores/app";
import { localSig, openPr, refreshLocal, targetKey, usePrReview } from "../../stores/prReview";
import { useReview } from "../../stores/review";
import { AgentIcon, DiffStat, cn } from "../ui";
import { ago } from "./ThreadCard";

const SECTIONS: { source: ReviewQueueSource; title: string }[] = [
  { source: "requested", title: "Review requested" },
  { source: "mine", title: "Your pull requests" },
  { source: "involves", title: "Involves you" },
];

function decision(d: string) {
  if (d === "APPROVED") return <span className="text-[10.5px] font-medium text-ok">Approved</span>;
  if (d === "CHANGES_REQUESTED") return <span className="text-[10.5px] font-medium text-warn">Changes requested</span>;
  return null;
}

export function ReviewQueue() {
  const workspaces = useApp((s) => s.workspaces);
  const changes = useApp((s) => s.changes);
  const repos = useApp((s) => s.repos);
  const { queue, queueError, queueLoading, opened, reviewed, error } = usePrReview();
  const drafts = useReview((s) => s.drafts);
  const [input, setInput] = useState("");
  const current = opened?.key;

  useEffect(() => {
    refreshLocal();
    void usePrReview.getState().loadQueue();
  }, []);

  const local = workspaces.filter((w) => (changes[w.id]?.length ?? 0) > 0);
  const sections = useMemo(() => {
    const seen = new Set<string>();
    return SECTIONS.map((s) => {
      const items = (queue ?? []).filter((q) => q.sources.includes(s.source) && !seen.has(`${q.repo}#${q.number}`));
      items.forEach((q) => seen.add(`${q.repo}#${q.number}`));
      return { ...s, items };
    }).filter((s) => s.items.length);
  }, [queue]);

  const defaultRepo = () => {
    const saved = localStorage.getItem("lastRepo");
    return repos.find((r) => r.id === saved)?.id ?? repos[0]?.id ?? null;
  };
  const submit = async () => {
    if (input.trim() && (await openPr(input, defaultRepo()))) setInput("");
  };

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r-[1.5px] border-line bg-panel">
      <div className="space-y-2 px-3 pb-2 pt-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") setInput("");
          }}
          placeholder="Open a PR: link, owner/repo#12, #12"
          aria-label="Open a pull request"
          className="h-7 w-full rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 text-[12px] placeholder:text-mute focus:border-line-strong focus:outline-none"
        />
        {error && !opened && <p className="selectable text-[11.5px] text-bad">{error}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <Section title="Local changes" count={local.length} action={<Refresh loading={queueLoading} />}>
          {local.length === 0 ? (
            <p className="px-3 py-1 text-[11.5px] text-mute">No workspace has pending changes.</p>
          ) : (
            local.map((w) => {
              const files = changes[w.id] ?? [];
              const t = diffTotals(files);
              const key = targetKey({ kind: "local", workspaceId: w.id });
              const fresh = reviewed[key] !== undefined && reviewed[key] !== localSig(files);
              const repo = repos.find((r) => r.id === w.repoId)?.name;
              const pending = drafts[key]?.length ?? 0;
              return (
                <Item key={w.id} active={current === key} onClick={() => void usePrReview.getState().open({ kind: "local", workspaceId: w.id })} testid={`review-local-${w.id}`}>
                  <AgentIcon agent={w.agent} className="mt-0.5 size-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{w.name}</span>
                      {fresh && <span title="Changed since you marked it reviewed" className="size-1.5 shrink-0 rounded-full bg-fg" />}
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-mute">
                      <span className="min-w-0 truncate">{repo}</span>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0 tabular-nums">{files.length} file{files.length === 1 ? "" : "s"}</span>
                      {pending > 0 && <span className="shrink-0 text-warn">· {pending} pending</span>}
                      {w.status === "running" && <span className="shrink-0 text-run">· working</span>}
                    </div>
                  </div>
                  <DiffStat additions={t.additions} deletions={t.deletions} className="text-[10.5px]" />
                </Item>
              );
            })
          )}
        </Section>

        {queueError ? (
          <Section title="GitHub">
            <p className="selectable px-3 py-1 text-[11.5px] text-bad">{queueError}</p>
          </Section>
        ) : queue === null ? (
          <Section title="GitHub">
            <p className="flex items-center gap-1.5 px-3 py-1 text-[11.5px] text-mute"><LoaderCircle className="size-3 animate-spin" /> Loading pull requests…</p>
          </Section>
        ) : sections.length === 0 ? (
          <Section title="GitHub">
            <p className="px-3 py-1 text-[11.5px] text-mute">Nothing waiting on you.</p>
          </Section>
        ) : (
          sections.map((s) => (
            <Section key={s.source} title={s.title} count={s.items.length}>
              {s.items.map((q) => (
                <PrItem key={`${q.repo}#${q.number}`} q={q} active={current === targetKey({ kind: "gh", repo: q.repo, number: q.number })} pending={drafts[targetKey({ kind: "gh", repo: q.repo, number: q.number })]?.length ?? 0} />
              ))}
            </Section>
          ))
        )}
      </div>
    </aside>
  );
}

function Refresh({ loading }: { loading: boolean }) {
  return (
    <button onClick={() => (refreshLocal(), void usePrReview.getState().loadQueue())} title="Refresh" className="grid size-5 place-items-center rounded-[3px] text-mute hover:bg-hover hover:text-fg">
      <RefreshCw className={cn("size-3", loading && "animate-spin")} />
    </button>
  );
}

function PrItem({ q, active, pending }: { q: ReviewQueueItem; active: boolean; pending: number }) {
  return (
    <Item active={active} onClick={() => void usePrReview.getState().open({ kind: "gh", repo: q.repo, number: q.number })} testid={`review-pr-${q.number}`}>
      <GitPullRequest className={cn("mt-0.5 size-3.5 shrink-0", q.isDraft ? "text-mute" : "text-ok")} />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 font-medium leading-[1.35]">{q.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-mute">
          <span className="truncate">{q.repo.split("/")[1]} #{q.number}</span>
          <span>·</span>
          <span>{q.author}</span>
          <span>·</span>
          <span>{ago(q.updatedAt)}</span>
          {q.isDraft && <span>· draft</span>}
          {pending > 0 && <span className="text-warn">· {pending} pending</span>}
          {decision(q.reviewDecision)}
        </div>
      </div>
    </Item>
  );
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-2">
      <div className="flex h-6 items-center gap-1.5 px-3">
        <span className="label text-mute">{title}</span>
        {count !== undefined && <span className="text-[11px] tabular-nums text-mute">{count}</span>}
        <span className="flex-1" />
        {action}
      </div>
      <div className="space-y-px">{children}</div>
    </section>
  );
}

function Item({ active, onClick, children, testid }: { active: boolean; onClick: () => void; children: React.ReactNode; testid?: string }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={cn("mx-1.5 flex w-[calc(100%-12px)] items-start gap-2 rounded-[4px] px-2 py-1.5 text-left text-[12px]", active ? "bg-raised text-fg" : "text-dim hover:bg-hover hover:text-fg")}
    >
      {children}
    </button>
  );
}
