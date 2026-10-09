import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Archive, FolderOpen, LoaderCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { timeAgo } from "../../lib/attention";
import { confirmAction } from "../../lib/confirm";
import { api, type CleanupCandidate, type Workspace } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { Button } from "../ui";
import { Row, SubHeading } from "./controls";
import { useEnv, useEnvironment } from "./env";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Data() {
  const { info } = useEnvironment();
  const repos = useApp((s) => s.repos);
  const [archived, setArchived] = useState<Workspace[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CleanupCandidate[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const setError = useApp.getState().setError;

  const loadArchived = useCallback(() => {
    api.listArchivedWorkspaces().then(setArchived).catch((e) => setError(String(e)));
  }, [setError]);
  useEffect(loadArchived, [loadArchived]);

  const restore = async (ws: Workspace) => {
    setRestoring(ws.id);
    try {
      useApp.getState().upsertWorkspace(await api.restoreWorkspace(ws.id));
      setArchived((a) => (a ?? []).filter((x) => x.id !== ws.id));
      void useEnv.getState().refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRestoring(null);
    }
  };

  const scan = async () => {
    setScanning(true);
    setCandidates(null);
    try {
      setCandidates(await api.cleanupMergedWorktrees(true));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const clean = async () => {
    if (!candidates?.length) return;
    const n = candidates.length;
    const ok = await confirmAction(
      `Archive ${n} merged workspace${n === 1 ? "" : "s"} and remove ${n === 1 ? "its" : "their"} worktree${n === 1 ? "" : "s"}? Branches are kept and you can restore them from Settings.`,
      "Clean up",
    );
    if (!ok) return;
    setCleaning(true);
    try {
      await api.cleanupMergedWorktrees(false);
      setCandidates([]);
      const fresh = await api.listWorkspaces();
      const kept = new Set(fresh.map((w) => w.id));
      useApp.setState((s) => ({
        workspaces: s.workspaces.filter((w) => kept.has(w.id)),
        selectedId: s.selectedId && kept.has(s.selectedId) ? s.selectedId : null,
      }));
      loadArchived();
      void useEnv.getState().refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCleaning(false);
    }
  };

  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? "unknown repo";

  return (
    <>
      <Row label="Orbit home" description={<span className="selectable">{info?.orbitHome ?? "Locating…"}</span>}>
        <Button variant="outline" disabled={!info} onClick={() => info && void revealItemInDir(info.orbitHome).catch(() => {})}>
          <FolderOpen className="size-3.5" /> Open folder
        </Button>
      </Row>
      <Row label="Database size" description="Workspaces, transcripts and settings (state.db).">
        <span className="text-[12px] font-medium tabular-nums text-dim">{info ? formatBytes(info.dbSizeBytes) : "…"}</span>
      </Row>
      <Row label="Worktrees on disk" description="Folders under worktrees/, including those of archived workspaces.">
        <span className="text-[12px] font-medium tabular-nums text-dim">{info ? info.worktreeCount : "…"}</span>
      </Row>

      <SubHeading>Clean up merged worktrees</SubHeading>
      <Row
        label="Find merged branches"
        description="Workspaces whose branch is merged into the base branch (or whose PR is merged) and whose worktree has no uncommitted changes."
      >
        <Button variant="outline" onClick={() => void scan()} disabled={scanning || cleaning}>
          {scanning && <LoaderCircle className="size-3.5 animate-spin" />} {scanning ? "Scanning…" : "Scan"}
        </Button>
      </Row>
      {candidates && (
        <div className="border-b border-line py-2.5">
          {candidates.length === 0 ? (
            <p className="text-[12px] text-mute">Nothing to clean up.</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {candidates.map((c) => (
                  <li key={c.workspaceId} className="flex items-baseline gap-3 text-[12px]">
                    <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                    <span className="shrink-0 text-[11.5px] text-mute">{c.branch}</span>
                    <span className="shrink-0 text-[11.5px] text-dim">{c.reason}</span>
                  </li>
                ))}
              </ul>
              <div className="pt-3">
                <Button variant="primary" onClick={() => void clean()} disabled={cleaning}>
                  {cleaning && <LoaderCircle className="size-3.5 animate-spin" />}
                  Clean up {candidates.length}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <SubHeading>Archived workspaces</SubHeading>
      <div className="border-t border-line">
        {archived === null && <p className="py-2.5 text-[12px] text-mute">Loading…</p>}
        {archived?.length === 0 && <p className="py-2.5 text-[12px] text-mute">No archived workspaces.</p>}
        {archived?.map((w) => (
          <div key={w.id} className="flex items-center gap-3 border-b border-line py-2 text-[12px]">
            <Archive className="size-3.5 shrink-0 text-mute" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{w.name}</span>
              <span className="block truncate text-[11.5px] text-mute">
                {repoName(w.repoId)} · {w.branch} · {timeAgo(w.updatedAt)}
              </span>
            </span>
            <Button variant="outline" disabled={restoring === w.id} onClick={() => void restore(w)}>
              {restoring === w.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              Restore
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}
