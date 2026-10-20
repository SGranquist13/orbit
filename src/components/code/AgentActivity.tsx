import { useEffect, useState } from "react";
import { samePath } from "../../lib/code/agentEdits";
import { useCode } from "../../stores/code";
import { useApp } from "../../stores/app";
import { Button, DiffStat, StatusDot, cn } from "../ui";
import { Segmented } from "../settings/controls";

function ago(ts: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  return seconds < 60
    ? "just now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} min ago`
      : `${Math.floor(seconds / 3600)} hr ago`;
}
export function AgentStrip() {
  const root = useCode((s) => s.roots.find((r) => r.path === s.activeRoot));
  const ws = useApp((s) => s.workspaces.find((w) => root && (w.id === root.workspaceId || samePath(w.path, root.path))));
  const turn = useCode((s) => (ws ? s.turns[ws.id] : undefined));
  const activity = useCode((s) => s.activity);
  const message = useCode((s) => (ws ? s.agentMessages[ws.id] : ""));
  const activityOpen = useCode((s) => s.activityOpen);
  const workspaces = useApp((s) => s.workspaces);
  const repos = useApp((s) => s.repos);
  const [picking, setPicking] = useState(false);
  if (!root) return null;
  if (!ws) {
    const preferred = (path: string) => {
      const p = path.replaceAll("\\", "/").toLowerCase().replace(/\/$/, ""),
        r = root.path.toLowerCase().replace(/\/$/, "");
      return p === r || p.startsWith(r + "/") || r.startsWith(p + "/");
    };
    const priority = (repoId: string, path: string) => Number(preferred(repos.find((r) => r.id === repoId)?.path ?? path));
    const choices = [...workspaces].sort((a, b) => priority(b.repoId, b.path) - priority(a.repoId, a.path));
    return (
      <div className="relative flex items-center gap-2 text-[12px] text-mute">
        {choices.length ? (
          <>
            <Button aria-expanded={picking} onClick={() => setPicking(!picking)}>
              Watch an agent ▾
            </Button>
            {picking && (
              <div className="absolute left-0 top-full z-30 mt-1 min-w-56 rounded-[4px] border border-line bg-raised p-1 shadow-pop">
                {choices.map((w) => (
                  <button
                    key={w.id}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover"
                    onClick={() => {
                      setPicking(false);
                      void useCode
                        .getState()
                        .openRoot(w.path, { workspaceId: w.id })
                        .then(() => useCode.getState().setMode(useCode.getState().activeRoot!, "watch"));
                    }}
                  >
                    <StatusDot status={w.status} />
                    {w.name}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            No agent on this folder<Button onClick={() => useApp.getState().setNewWorkspaceOpen(true)}>New workspace</Button>
          </>
        )}
      </div>
    );
  }
  const running = turn?.running ?? ws.status === "running";
  const edit = [...activity].reverse().find((a) => a.root === root.path && a.phase === "editing" && a.turn === turn?.number);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 text-[12px]">
      <span
        aria-label={running ? "Agent working" : "Agent idle"}
        className={cn("size-1.5 shrink-0 rounded-full", running ? "animate-pulse-dot bg-run" : "bg-mute")}
      />
      <div className="min-w-0 flex-1 truncate text-dim" title={message || ws.name}>
        {edit ? (
          <button
            className="max-w-full truncate hover:text-fg"
            onClick={() => void useCode.getState().openFile(edit.rel, {}, root.path)}
          >
            Editing {edit.rel}
          </button>
        ) : (
          message?.trim() || ws.name
        )}
      </div>
      <Segmented
        label="Editor mode"
        value={root.mode}
        options={[
          { value: "watch", label: "Watch" },
          { value: "manual", label: "Manual" },
        ]}
        onChange={(mode) => useCode.getState().setMode(root.path, mode)}
      />
      <Button aria-pressed={activityOpen} onClick={() => useCode.setState({ activityOpen: !activityOpen })}>
        Activity
      </Button>
      {running && <Button onClick={() => void useApp.getState().interrupt(ws.id)}>Stop</Button>}
    </div>
  );
}
export function ActivityTimeline() {
  const root = useCode((s) => s.activeRoot);
  const all = useCode((s) => s.activity);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  const groups = new Map<string, typeof all>();
  for (const entry of [...all].reverse()) {
    if (entry.root !== root) continue;
    const key = `${entry.workspaceId}:${entry.turn}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3 text-[11px] text-mute">
        <span>Agent activity</span>
        <button className="hover:text-fg" onClick={() => useCode.getState().clearMarks()}>
          Clear marks
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!groups.size && <p className="px-3 py-4 text-[12px] text-mute">File edits will appear here when the agent works.</p>}
        {[...groups].map(([key, entries]) => (
          <section key={key} className="border-b border-line pb-2">
            <h2 className="px-3 pb-1 pt-3 text-[11px] font-medium text-mute">
              {entries[0].turn > 0 ? `Turn ${entries[0].turn}` : "Earlier"} · {ago(Math.min(...entries.map((e) => e.ts)))}
            </h2>
            {entries.map((entry) => (
              <button
                key={`${entry.id}:${entry.rel}`}
                className="relative flex w-full items-center gap-2 overflow-hidden px-3 py-2 text-left hover:bg-hover"
                onClick={() => void useCode.getState().showAgentDiff(entry)}
                title={`${entry.rel} · ${entry.phase}`}
              >
                {entry.phase === "editing" && <span className="dither-sweep bg-run opacity-10" />}
                <span
                  aria-label={entry.phase}
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    entry.phase === "editing" ? "animate-pulse-dot bg-run" : entry.phase === "failed" ? "bg-bad" : "bg-ok",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-fg">{entry.rel.split("/").pop()}</span>
                  <span className="block truncate text-[10px] text-mute">
                    {entry.rel.split("/").slice(0, -1).join("/") || "."} · {ago(entry.ts)}
                  </span>
                </span>
                <DiffStat additions={entry.additions} deletions={entry.deletions} />
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
export function AgentDot({ path, rel, dir = false }: { path: string; rel: string; dir?: boolean }) {
  const activity = useCode((s) => s.activity);
  const turns = useCode((s) => s.turns);
  const entries = activity.filter(
    (a) =>
      a.root === path && a.turn === (turns[a.workspaceId]?.number ?? 0) && (dir ? a.rel.startsWith(`${rel}/`) : a.rel === rel),
  );
  if (!entries.length) return null;
  return (
    <span
      aria-label="Touched by agent this turn"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        dir ? "bg-mute" : "bg-run",
        !dir && entries.some((a) => a.phase === "editing") && "animate-pulse-dot",
      )}
    />
  );
}
