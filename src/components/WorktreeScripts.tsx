import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Workspace } from "../lib/ipc";
import { useApp } from "../stores/app";
import { startDevServer, stopDevServer, useScripts } from "../stores/scripts";
import { Button, cn } from "./ui";

function LogLines({ lines, empty }: { lines: string[]; empty: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <pre ref={ref} className="selectable max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[4px] border border-line bg-panel px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-dim">
      {lines.length ? lines.join("\n") : empty}
    </pre>
  );
}

/** Top of the transcript while a worktree's setup script runs, and after it fails. */
export function SetupRow({ wsId }: { wsId: string }) {
  const log = useScripts((s) => s.setup[wsId]);
  const [open, setOpen] = useState(false);
  if (!log || (log.status === "done" && log.dismissed)) return null;
  const failed = log.status === "failed" || log.status === "timedOut";
  const running = log.status === "running";
  const title = running ? "Setting up worktree…" : failed ? (log.status === "timedOut" ? "Worktree setup timed out" : "Worktree setup failed") : "Worktree ready";
  return (
    <div className={cn("relative overflow-hidden rounded-[4px] border-[1.5px] px-3 py-2", failed ? "border-bad" : "border-line")}>
      {running && <span className="dither-sweep bg-run opacity-[0.14]" />}
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="relative flex w-full items-center gap-2 text-left">
        <ChevronRight className={cn("size-3 shrink-0 text-mute transition-transform", open && "rotate-90")} strokeWidth={2.5} />
        <span className={cn("text-[12px] font-medium", failed ? "text-bad" : running ? "text-fg" : "text-mute")}>{title}</span>
        {!running && !failed && <span className="size-1.5 rounded-full bg-ok" />}
        <span className="flex-1" />
        <span className="text-[11px] tabular-nums text-mute">{log.lines.length ? `${log.lines.length} lines` : ""}</span>
      </button>
      {failed && <p className="relative mt-1 pl-5 text-[11.5px] text-mute">The agent was told, so it can look at the output and carry on.</p>}
      {(open || failed) && (
        <div className="relative mt-2 pl-5">
          <LogLines lines={log.lines} empty="No output." />
        </div>
      )}
    </div>
  );
}

/** Run / Stop toggle in the chat header; only shown when the repo has a run script. */
export function RunButton({ ws }: { ws: Workspace }) {
  const [has, setHas] = useState(false);
  const run = useScripts((s) => s.run[ws.id]);
  const [logOpen, setLogOpen] = useState(false);
  const setError = useApp.getState().setError;

  useEffect(() => {
    let cancelled = false;
    setHas(false);
    const check = () =>
      api
        .getRepoScripts(ws.repoId)
        .then((v) => !cancelled && setHas(!!v.runScript?.trim()))
        .catch(() => {});
    check();
    void useScripts.getState().refreshRun(ws.id).catch(() => {});
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, [ws.id, ws.repoId]);

  if (!has && !run?.lines.length && run?.status !== "running") return null;
  const running = run?.status === "running";
  const failed = run?.status === "failed" || run?.status === "timedOut";
  return (
    <div className="relative flex shrink-0 items-center gap-1.5">
      {run?.port != null && running && (
        <button
          onClick={() => void openUrl(`http://localhost:${run.port}`).catch((e) => setError(String(e)))}
          title={`Open http://localhost:${run.port}`}
          className="text-[11.5px] font-medium tabular-nums text-dim underline decoration-line-strong underline-offset-2 hover:text-fg"
        >
          :{run.port}
        </button>
      )}
      <span className={cn("size-1.5 shrink-0 rounded-full", running ? "bg-run" : failed ? "bg-bad" : "hidden")} />
      {(running || failed || (run?.lines.length ?? 0) > 0) && (
        <Button onClick={() => setLogOpen(!logOpen)} title="Dev server output" className={cn("px-1.5", logOpen && "bg-raised text-fg")}>
          Log
        </Button>
      )}
      {running ? (
        <Button onClick={() => stopDevServer(ws.id, setError)} title="Stop the dev server">
          <Square className="size-3.5" /> Stop
        </Button>
      ) : (
        <Button onClick={() => void startDevServer(ws.id, setError)} title="Run the dev server (the repo's run script)">
          <Play className="size-3.5" /> Run
        </Button>
      )}
      {logOpen && (
        <>
          <div className="fixed inset-0 z-20" onMouseDown={() => setLogOpen(false)} />
          <div className="fixed right-6 top-[56px] z-30 w-[460px] max-w-[80vw] rounded-[6px] border-[1.5px] border-line-strong bg-raised p-2 shadow-hard">
            <div className="label px-1 pb-1.5 text-mute">Dev server output</div>
            <LogLines lines={run?.lines ?? []} empty="No output yet." />
          </div>
        </>
      )}
    </div>
  );
}
