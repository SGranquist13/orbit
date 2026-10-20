import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { attemptLetter, attemptsReady, formatCost, formatDuration, rankAttempts } from "../lib/attempts";
import { confirmAction } from "../lib/confirm";
import { api, type Attempt } from "../lib/ipc";
import { useApp } from "../stores/app";
import { AgentIcon, Button, DiffStat, StatusDot, agentLabel, cn } from "./ui";

const checksLabel = { pass: "Checks passed", fail: "Checks failed", timedOut: "Checks timed out", none: "No checks" } as const;
const checksTone = { pass: "text-ok", fail: "text-bad", timedOut: "text-bad", none: "text-mute" } as const;

/** Unified diff text: additions and deletions carry the only colour. */
function DiffText({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <pre className="selectable overflow-auto px-4 py-3 font-mono text-[11.5px] leading-[1.55]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "whitespace-pre",
            l.startsWith("+") && !l.startsWith("+++") && "text-ok",
            l.startsWith("-") && !l.startsWith("---") && "text-bad",
            (l.startsWith("@@") || l.startsWith("diff ") || l.startsWith("---") || l.startsWith("+++")) && "text-mute",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

export function Attempts() {
  const id = useApp((s) => s.selectedAttemptGroup);
  const group = useApp((s) => (id ? s.attemptGroups[id] : undefined));
  const workspaces = useApp((s) => s.workspaces);
  const changes = useApp((s) => s.changes);
  const [chosen, setChosen] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ text: string } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id && !group) api.attemptGroup(id).then((g) => useApp.getState().upsertAttemptGroup(g), (e) => useApp.getState().setError(String(e)));
  }, [id, group]);
  const live = group?.status === "running";
  useEffect(() => {
    if (!group || !live) return;
    for (const a of group.attempts) void useApp.getState().refreshChanges(a.workspaceId);
  }, [group, live]);

  const [a, b] = chosen;
  useEffect(() => {
    setDiff(null);
    if (!a || !b) return;
    let current = true;
    api.compareAttempts(a, b, path ?? undefined).then(
      (text) => current && setDiff({ text }),
      (e) => current && setDiff({ error: String(e) }),
    );
    return () => {
      current = false;
    };
  }, [a, b, path]);

  if (!group) return <main className="flex-1 bg-bg" />;
  const ready = attemptsReady(group.attempts);
  const best = ready && live ? rankAttempts(group.attempts)[0] : undefined;
  const letterOf = (wsId: string) => attemptLetter(group.workspaceIds.indexOf(wsId));
  const toggle = (wsId: string) => {
    setPath(null);
    setChosen((c) => (c.includes(wsId) ? c.filter((x) => x !== wsId) : [...c.slice(-1), wsId]));
  };
  const files = a && b ? [...new Set([a, b].flatMap((w) => (changes[w] ?? []).map((f) => f.path)))].sort() : [];

  const keep = async (att: Attempt) => {
    const ok = await confirmAction(
      `Keep attempt ${letterOf(att.workspaceId)} and archive the other ${group.workspaceIds.length - 1}?\n\nTheir worktrees are removed; the branches are kept.`,
      "Keep this one",
    );
    if (!ok) return;
    setBusy(true);
    try {
      const g = await api.pickAttempt(group.id, att.workspaceId);
      useApp.getState().upsertAttemptGroup(g);
      useApp.getState().select(att.workspaceId);
    } catch (e) {
      useApp.getState().setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!(await confirmAction("Cancel all attempts and archive their worktrees?\n\nThe branches are kept.", "Cancel all"))) return;
    setBusy(true);
    try {
      useApp.getState().upsertAttemptGroup(await api.cancelAttempts(group.id));
    } catch (e) {
      useApp.getState().setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const status = group.status === "picked" ? `Kept ${letterOf(group.winnerWorkspaceId ?? "")}` : group.status === "cancelled" ? "Cancelled" : ready ? "Ready to compare" : "Running";
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg" data-testid="attempts-view">
      <header className="flex h-12 shrink-0 items-center gap-3 px-6" data-tauri-drag-region>
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.02em]">{group.prompt.split("\n")[0]}</h1>
        <span className="label shrink-0 text-mute">Best of {group.workspaceIds.length}</span>
        <span className="shrink-0 text-[12px] font-medium text-dim" data-testid="attempts-status">{status}</span>
        <span className="flex-1" />
        {live && (
          <Button variant="outline" onClick={() => void cancel()} disabled={busy}>
            Cancel all
          </Button>
        )}
      </header>
      <div className="border-t-[1.5px] border-line" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-3 px-6 py-4" style={{ gridTemplateColumns: `repeat(${group.attempts.length}, minmax(0, 1fr))` }}>
          {group.attempts.map((att) => {
            const ws = workspaces.find((w) => w.id === att.workspaceId);
            const s = att.summary;
            const letter = letterOf(att.workspaceId);
            const winner = group.winnerWorkspaceId === att.workspaceId;
            const list = changes[att.workspaceId] ?? [];
            const picked = chosen.includes(att.workspaceId);
            return (
              <section key={att.workspaceId} data-attempt={letter} className={cn("min-w-0 rounded-[6px] border-[1.5px] p-3", picked ? "border-fg" : "border-line-strong")}>
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold">{letter}</span>
                  {ws ? <AgentIcon agent={ws.agent} className="size-3.5 opacity-80" /> : null}
                  <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{ws ? `${agentLabel[ws.agent]}${ws.model ? ` · ${ws.model}` : ""}` : "Archived"}</span>
                  {best?.workspaceId === att.workspaceId && <span data-testid="best-label" className="label text-mute">Best</span>}
                  {winner && <span className="label text-mute">Kept</span>}
                </div>
                <div className="mt-2 flex items-center gap-2 text-[12px] font-medium">
                  {ws ? <StatusDot status={ws.status} /> : null}
                  {att.finished ? (
                    s ? <span className={checksTone[s.checks]}>{checksLabel[s.checks]}</span> : (
                      <span className="flex items-center gap-1 text-mute"><LoaderCircle className="size-3 animate-spin" /> Running checks</span>
                    )
                  ) : (
                    <span className="flex items-center gap-1 text-mute"><LoaderCircle className="size-3 animate-spin" /> Working</span>
                  )}
                </div>
                <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                  <dt className="text-mute">Lines</dt>
                  <dd>{s ? <DiffStat additions={s.additions} deletions={s.deletions} /> : "-"}</dd>
                  <dt className="text-mute">Files</dt>
                  <dd className="tabular-nums">{s ? s.filesChanged : "-"}</dd>
                  <dt className="text-mute">Duration</dt>
                  <dd className="tabular-nums">{formatDuration(att.durationMs)}</dd>
                  <dt className="text-mute">Cost</dt>
                  <dd className="tabular-nums">{formatCost(att.costUsd)}</dd>
                </dl>
                <ul className="mt-2.5 max-h-40 space-y-px overflow-y-auto border-t border-line pt-2">
                  {list.length === 0 && <li className="text-[11.5px] text-mute">No changed files</li>}
                  {list.map((f) => (
                    <li key={f.path} className="flex items-center gap-2 text-[11.5px]">
                      <span className="min-w-0 flex-1 truncate font-mono text-dim">{f.path}</span>
                      <DiffStat additions={f.additions} deletions={f.deletions} />
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {live && (
                    <label className="flex cursor-default items-center gap-1.5 text-[12px] text-dim">
                      <input type="checkbox" checked={picked} onChange={() => toggle(att.workspaceId)} aria-label={`Compare ${letter}`} />
                      Compare
                    </label>
                  )}
                  <span className="flex-1" />
                  {ws && (
                    <Button variant="outline" onClick={() => useApp.getState().select(ws.id)}>
                      Open
                    </Button>
                  )}
                  {live && (
                    <Button variant="primary" className="whitespace-nowrap" onClick={() => void keep(att)} disabled={busy || !att.finished}>
                      Keep this one
                    </Button>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        {live && (
          <div className="mx-6 mb-6 overflow-hidden rounded-[6px] border-[1.5px] border-line-strong" data-testid="attempts-diff">
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 text-[12px]">
              {a && b ? (
                <>
                  <span className="font-medium text-dim">
                    {letterOf(a)} to {letterOf(b)}
                  </span>
                  <button onClick={() => setPath(null)} className={cn("rounded-[3px] px-1.5 py-0.5 font-medium", path === null ? "bg-hover text-fg" : "text-mute hover:text-dim")}>
                    All files
                  </button>
                  {files.map((f) => (
                    <button key={f} onClick={() => setPath(f)} className={cn("rounded-[3px] px-1.5 py-0.5 font-mono", path === f ? "bg-hover text-fg" : "text-mute hover:text-dim")}>
                      {f}
                    </button>
                  ))}
                </>
              ) : (
                <span className="text-mute">Tick Compare on two attempts to see how they differ.</span>
              )}
            </div>
            {a && b && !diff && <div className="px-4 py-3 text-[12px] text-mute">Loading diff…</div>}
            {diff && "error" in diff && <div className="px-4 py-3 text-[12px] text-bad">{diff.error}</div>}
            {diff && "text" in diff && (diff.text.trim() ? <DiffText text={diff.text} /> : <div className="px-4 py-3 text-[12px] text-mute">No differences.</div>)}
          </div>
        )}
      </div>
    </main>
  );
}
