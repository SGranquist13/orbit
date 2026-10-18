import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Archive,
  Check,
  CircleDot,
  FolderOpen,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  LoaderCircle,
  RefreshCw,
  Rocket,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { confirmAction } from "../lib/confirm";
import type { PrStatus, Workspace } from "../lib/ipc";
import { api } from "../lib/ipc";
import { diffTotals, useApp } from "../stores/app";
import { Button, DiffStat, cn } from "./ui";

export function RightPanel({ ws }: { ws: Workspace }) {
  const files = useApp((s) => s.changes[ws.id]);
  const repo = useApp((s) => s.repos.find((r) => r.id === ws.repoId));
  const totals = diffTotals(files);
  const overlaps = useApp((s) => s.overlaps);
  const workspaces = useApp((s) => s.workspaces);
  const nChanges = files?.length ?? 0;
  useEffect(() => {
    void useApp.getState().refreshOverlaps();
  }, [ws.id, nChanges]);
  // "Also edited in <workspace>: file, file" for each live workspace touching the same files.
  const alsoEdited = overlaps
    .filter((o) => o.a === ws.id || o.b === ws.id)
    .map((o) => ({ name: workspaces.find((w) => w.id === (o.a === ws.id ? o.b : o.a))?.name, files: o.files }))
    .filter((o) => o.name);

  const archive = async () => {
    const ok = await confirmAction(`Archive "${ws.name}" and delete its worktree?\n\nThe branch ${ws.branch} is kept.`, "Archive");
    if (!ok) return;
    try {
      await api.archiveWorkspace(ws.id, true);
      useApp.getState().removeWorkspace(ws.id);
    } catch (e) {
      useApp.getState().setError(String(e));
    }
  };

  return (
    <aside className="flex h-full w-[304px] shrink-0 flex-col border-l-[1.5px] border-line bg-panel">
      <div className="flex h-12 items-center gap-1 px-3" data-tauri-drag-region>
        <span className="label px-1 text-fg">Ship</span>
        <span className="flex-1" />
        <Button onClick={() => void revealItemInDir(ws.path)} title="Open worktree folder" className="px-1.5">
          <FolderOpen className="size-3.5" />
        </Button>
        <Button onClick={() => void archive()} title="Archive workspace" className="px-1.5">
          <Archive className="size-3.5" />
        </Button>
        <Button onClick={() => useApp.getState().setShipOpen(false)} title="Close (Ctrl .)" className="px-1.5">
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="dither-rule bg-line-strong" />
      <ShipSection ws={ws} />

      <div className="dither-rule bg-line-strong" />
      <div className="flex items-center gap-2 px-4 pb-2 pt-3">
        <span className="label text-fg">Changes</span>
        <span className=" text-[11px] text-mute">{files?.length ?? 0}</span>
        <span className="flex-1" />
        <DiffStat {...totals} />
      </div>
      <div className="flex items-center gap-1.5 px-4 pb-2 text-[11px] text-mute">
        <GitBranch className="size-3" />
        <span className="truncate">→ {repo?.baseBranch ?? "main"}</span>
      </div>

      {alsoEdited.map((o) => (
        <p key={o.name} className="truncate px-4 pb-2 text-[11px] text-mute" title={o.files.join(", ")}>
          Also edited in {o.name}: {o.files.slice(0, 3).join(", ")}
          {o.files.length > 3 ? ` +${o.files.length - 3}` : ""}
        </p>
      ))}

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {files?.map((f) => {
          const slash = f.path.lastIndexOf("/");
          return (
            <li key={f.path} className="flex h-7 items-center gap-2 rounded-[3px] px-2 hover:bg-hover" title={f.path}>
              <span className={cn("size-1.5 shrink-0", f.untracked ? "bg-ok" : "bg-warn")} />
              <span className="min-w-0 flex-1 truncate text-[12px]">
                <span className="font-medium text-fg">{f.path.slice(slash + 1)}</span>
                {slash > 0 && <span className="ml-1.5 text-mute">{f.path.slice(0, slash)}</span>}
              </span>
              <DiffStat additions={f.additions} deletions={f.deletions} />
            </li>
          );
        })}
        {files && files.length === 0 && <p className="px-2 pt-2 text-[12px] text-mute">No changes yet.</p>}
      </ul>
    </aside>
  );
}

function ShipSection({ ws }: { ws: Workspace }) {
  const pr = useApp((s) => s.prs[ws.id]);
  const shipping = useApp((s) => !!s.shipping[ws.id]);
  const running = ws.status === "running";
  const run = (skill: string) => void useApp.getState().runSkill(ws.id, skill);

  // Poll while checks are in flight; PRs change outside the app too.
  useEffect(() => {
    if (!pr || pr.state !== "OPEN") return;
    const t = window.setInterval(() => void useApp.getState().refreshPr(ws.id), pr.checks.pending > 0 ? 20_000 : 60_000);
    return () => window.clearInterval(t);
  }, [pr, ws.id]);

  if (pr === undefined) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-[12px] text-mute">
        <span className="dither-march h-2 w-8 bg-mute" /> <span className="label">Checking for a PR</span>
      </div>
    );
  }

  if (pr === null) {
    return (
      <div className="space-y-2.5 px-4 py-4">
        <p className="text-[12px] text-mute">No pull request for this branch yet.</p>
        <Button variant="primary" className="w-full justify-center" disabled={running || shipping} onClick={() => void useApp.getState().ship(ws.id)}>
          {shipping ? <LoaderCircle className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />} {shipping ? "Running checks…" : "Ship: commit, push, draft PR"}
        </Button>
      </div>
    );
  }

  return <PrCard ws={ws} pr={pr} running={running} shipping={shipping} run={run} />;
}

function PrCard({ ws, pr, running, shipping, run }: { ws: Workspace; pr: PrStatus; running: boolean; shipping: boolean; run: (skill: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const open = pr.state === "OPEN";
  const { passed, failed, pending, failing } = pr.checks;
  const conflicting = pr.mergeable === "CONFLICTING";
  const canMerge = open && !pr.isDraft && !conflicting && failed === 0 && pending === 0;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      useApp.getState().setError(String(e));
    } finally {
      setBusy(null);
      void useApp.getState().refreshPr(ws.id);
    }
  };

  const StateIcon = pr.state === "MERGED" ? GitMerge : pr.isDraft ? GitPullRequestDraft : GitPullRequest;
  const stateLabel = pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.isDraft ? "Draft" : "Open";
  const stateColor =
    pr.state === "MERGED" ? "text-merged" : pr.state === "CLOSED" ? "text-bad" : pr.isDraft ? "text-mute" : "text-ok";

  return (
    <div className="space-y-3 px-4 py-3.5">
      <div className="flex items-start gap-2">
        <StateIcon className={cn("mt-0.5 size-4 shrink-0", stateColor)} />
        <button onClick={() => void openUrl(pr.url)} className="min-w-0 flex-1 text-left" title="Open on GitHub">
          <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-fg hover:underline">{pr.title}</span>
          <span className=" text-[11px] text-mute">
            #{pr.number} · <span className={stateColor}>{stateLabel}</span>
          </span>
        </button>
        <button
          onClick={() => void act("refresh", () => useApp.getState().refreshPr(ws.id))}
          title="Refresh"
          className="text-mute hover:text-fg"
        >
          <RefreshCw className={cn("size-3.5", busy === "refresh" && "animate-spin")} />
        </button>
      </div>

      {open && (
        <div className="space-y-1.5 rounded-[4px] border-[1.5px] border-line-strong bg-bg px-3 py-2 text-[11.5px] font-medium">
          <div className="flex items-center gap-3 tabular-nums">
            {passed + failed + pending === 0 ? (
              <span className="text-mute">No checks</span>
            ) : (
              <>
                <span className="flex items-center gap-1 text-ok"><Check className="size-3" />{passed}</span>
                {failed > 0 && <span className="flex items-center gap-1 text-bad"><X className="size-3" />{failed}</span>}
                {pending > 0 && <span className="flex items-center gap-1 text-warn"><CircleDot className="size-3 animate-pulse-dot" />{pending}</span>}
              </>
            )}
            <span className="flex-1" />
            {pr.reviewDecision === "APPROVED" && <span className="text-ok">approved</span>}
            {pr.reviewDecision === "CHANGES_REQUESTED" && <span className="text-warn">changes requested</span>}
          </div>
          {failing.length > 0 && <p className="truncate text-bad/90">Failing: {failing.join(", ")}</p>}
          {conflicting && <p className="text-warn">Conflicts with base branch</p>}
        </div>
      )}

      {open && (
        <div className="grid grid-cols-2 gap-1.5">
          {failed > 0 && <Action icon={<X className="size-3.5" />} label="Fix CI" disabled={running} onClick={() => run("shipkit:fix-ci")} />}
          {conflicting && <Action label="Rebase" disabled={running} onClick={() => run("shipkit:rebase")} />}
          <Action label="Address comments" disabled={running} onClick={() => run("shipkit:address-comments")} />
          <Action icon={<Rocket className="size-3.5" />} label={shipping ? "Running checks…" : "Push updates"} busy={shipping} disabled={running || shipping} onClick={() => void useApp.getState().ship(ws.id)} />
          {pr.isDraft && (
            <Action
              label="Ready for review"
              busy={busy === "ready"}
              onClick={() => void act("ready", () => api.markPrReady(ws.id, pr.number))}
            />
          )}
          <Action
            primary
            icon={<GitMerge className="size-3.5" />}
            label="Squash & merge"
            disabled={!canMerge}
            busy={busy === "merge"}
            title={canMerge ? undefined : "Needs: ready for review, green checks, no conflicts"}
            onClick={async () => {
              if (await confirmAction(`Squash-merge #${pr.number} into the base branch?`, "Merge")) {
                void act("merge", async () => {
                  const out = await api.mergePr(ws.id, pr.number);
                  // Orbit archived the workspace and removed its worktree.
                  if (out?.archived) useApp.getState().removeWorkspace(ws.id);
                });
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

function Action({
  label,
  icon,
  primary,
  busy,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon?: React.ReactNode; primary?: boolean; busy?: boolean }) {
  return (
    <Button variant={primary ? "primary" : "outline"} className="justify-center px-2 text-[11.5px]" {...props}>
      {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : icon}
      {label}
    </Button>
  );
}
