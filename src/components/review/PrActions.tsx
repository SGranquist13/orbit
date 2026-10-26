import { ChevronDown, GitBranch, GitMerge, Plus, RotateCw, UserPlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MergeMethod, PrDetail } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { usePrReview } from "../../stores/prReview";
import { Button, cn } from "../ui";

/** A button with a popover that closes on outside click or Escape. */
function Pop({ label, icon, title, disabled, variant = "ghost", testid, children }: { label: string; icon: React.ReactNode; title: string; disabled?: boolean; variant?: "ghost" | "outline"; testid?: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("mousedown", off), window.removeEventListener("keydown", esc));
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button variant={variant} title={title} disabled={disabled} onClick={() => setOpen((o) => !o)} data-testid={testid}>
        {icon} {label} <ChevronDown className="size-3" />
      </Button>
      {open && <div className="absolute right-0 top-9 z-30 w-[300px] rounded-[6px] border-[1.5px] border-line-strong bg-panel p-3 shadow-pop">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** Check out / workspace, ready for review, reviewers and merge, for an open PR. */
export function PrActions({ pr }: { pr: PrDetail }) {
  const busy = usePrReview((s) => s.busy);
  const ws = useApp((s) => (pr.workspaceId ? s.workspaces.find((w) => w.id === pr.workspaceId) : undefined));
  const open = pr.state === "OPEN";
  return (
    <>
      {ws ? (
        <Button onClick={() => (useApp.getState().select(ws.id), useApp.getState().setView("workspace"))} title={`Open the workspace on ${ws.branch}`}>
          <GitBranch className="size-3.5" /> Workspace
        </Button>
      ) : (
        open && (
          <Button
            onClick={() => void usePrReview.getState().checkout()}
            disabled={busy === "checkout" || !pr.localRepoId}
            title={pr.localRepoId ? (pr.isCrossRepository ? "Check out into a workspace (a fork: your commits stay local)" : `Check out ${pr.headRef} into a workspace`) : `Add ${pr.repo} to Orbit to check it out`}
            data-testid="review-checkout"
          >
            <GitBranch className="size-3.5" /> {busy === "checkout" ? "Checking out…" : "Check out"}
          </Button>
        )
      )}
      {open && <Reviewers pr={pr} />}
      {open && pr.isDraft && (
        <Button variant="outline" onClick={() => void usePrReview.getState().ready()} title="Mark this draft ready for review">
          Ready for review
        </Button>
      )}
      {open && !pr.isDraft && <Merge pr={pr} />}
    </>
  );
}

function Reviewers({ pr }: { pr: PrDetail }) {
  const [login, setLogin] = useState("");
  // People who reviewed but aren't requested any more can be asked again.
  const reviewed = [...new Set(pr.reviews.filter((r) => r.state !== "PENDING" && r.author !== pr.viewerLogin && r.author !== pr.author).map((r) => r.author))].filter((a) => !pr.requestedReviewers.includes(a));
  const act = (add: string[], remove: string[] = []) => void usePrReview.getState().requestReviewers(add, remove);
  const n = pr.requestedReviewers.length;
  return (
    <Pop label={n ? `Reviewers (${n})` : "Reviewers"} icon={<UserPlus className="size-3.5" />} title="Request reviewers" testid="review-reviewers">
      {() => (
        <div className="space-y-3 text-[12px]">
          <Group title="Requested">
            {n === 0 && <p className="text-mute">Nobody yet.</p>}
            {pr.requestedReviewers.map((r) => (
              <Person key={r} login={r}>
                <IconBtn title={`Remove ${r}`} onClick={() => act([], [r])}><X className="size-3.5" /></IconBtn>
              </Person>
            ))}
          </Group>
          {reviewed.length > 0 && (
            <Group title="Reviewed">
              {reviewed.map((r) => (
                <Person key={r} login={r}>
                  <IconBtn title={`Re-request a review from ${r}`} onClick={() => act([r])}><RotateCw className="size-3.5" /></IconBtn>
                </Person>
              ))}
            </Group>
          )}
          {pr.suggestedReviewers.length > 0 && (
            <Group title="Suggested">
              {pr.suggestedReviewers.map((r) => (
                <Person key={r} login={r}>
                  <IconBtn title={`Request ${r}`} onClick={() => act([r])}><Plus className="size-3.5" /></IconBtn>
                </Person>
              ))}
            </Group>
          )}
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const v = login.trim().replace(/^@/, "");
              if (v) act([v]), setLogin("");
            }}
          >
            <input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="username or org/team"
              aria-label="Reviewer to request"
              className="h-7 min-w-0 flex-1 rounded-[4px] border-[1.5px] border-line bg-bg px-2 text-[12px] placeholder:text-mute focus:border-line-strong focus:outline-none"
            />
            <Button variant="outline" type="submit" disabled={!login.trim()}>Request</Button>
          </form>
        </div>
      )}
    </Pop>
  );
}

const METHODS: { m: MergeMethod; label: string; hint: string }[] = [
  { m: "squash", label: "Squash and merge", hint: "One commit on the base branch" },
  { m: "merge", label: "Create a merge commit", hint: "Keep every commit, plus a merge commit" },
  { m: "rebase", label: "Rebase and merge", hint: "Replay the commits onto the base branch" },
];

function Merge({ pr }: { pr: PrDetail }) {
  const settings = useApp((s) => s.settings);
  const busy = usePrReview((s) => s.busy);
  const [method, setMethod] = useState<MergeMethod>(settings?.mergeMethod ?? "squash");
  const [del, setDel] = useState(settings?.deleteBranchOnMerge ?? false);
  const conflict = pr.mergeable === "CONFLICTING";
  const c = pr.checks;
  const warning = conflict ? "This branch has conflicts with the base branch." : c.failed ? `${c.failed} check${c.failed === 1 ? "" : "s"} failing.` : c.pending ? `${c.pending} check${c.pending === 1 ? "" : "s"} still running.` : pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes were requested." : pr.reviewDecision === "REVIEW_REQUIRED" ? "A review is still required." : null;
  return (
    <Pop label={busy === "merge" ? "Merging…" : "Merge"} icon={<GitMerge className="size-3.5" />} title="Merge this pull request" variant="outline" disabled={busy === "merge"} testid="review-merge">
      {(close) => (
        <div className="space-y-2.5 text-[12px]">
          {warning && <p className={cn("rounded-[4px] border px-2.5 py-1.5 text-[11.5px]", conflict || c.failed ? "border-bad/50 text-bad" : "border-warn/50 text-warn")}>{warning}</p>}
          <div className="space-y-1">
            {METHODS.map(({ m, label, hint }) => (
              <label key={m} className={cn("flex cursor-pointer items-start gap-2.5 rounded-[4px] px-2 py-1.5", method === m ? "bg-raised" : "hover:bg-hover")}>
                <input type="radio" name="merge-method" checked={method === m} onChange={() => setMethod(m)} className="mt-[3px] accent-[var(--fg)]" />
                <span>
                  <span className="block font-medium">{label}</span>
                  <span className="block text-[11.5px] text-mute">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          {!pr.isCrossRepository && (
            <label className="flex cursor-pointer items-center gap-2 px-2 text-[11.5px] text-dim">
              <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} className="accent-[var(--fg)]" />
              Delete <code className="font-mono text-[11px]">{pr.headRef}</code> after merging
            </label>
          )}
          <div className="flex justify-end">
            <Button variant="primary" disabled={conflict} onClick={async () => (await usePrReview.getState().merge(method, del)) && close()} data-testid="review-merge-confirm">
              {METHODS.find((x) => x.m === method)!.label}
            </Button>
          </div>
        </div>
      )}
    </Pop>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-1 text-mute">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Person({ login, children }: { login: string; children: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-2 rounded-[4px] px-1.5 hover:bg-hover">
      <span className="min-w-0 flex-1 truncate">{login}</span>
      {children}
    </div>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} className="grid size-6 place-items-center rounded-[3px] text-mute hover:bg-raised hover:text-fg">
      {children}
    </button>
  );
}
