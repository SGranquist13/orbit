import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isTauri } from "../../lib/env";
import { useApp } from "../../stores/app";
import { useCode } from "../../stores/code";
import { StatusDot } from "../ui";

export async function openCodeFolder() {
  try {
    const path = isTauri() ? await open({ directory: true, title: "Open folder in Code" }) : "C:/code/superset";
    if (typeof path === "string") {
      useApp.getState().setView("code");
      await useCode.getState().openRoot(path);
    }
  } catch (e) {
    useApp.getState().setError(String(e));
  }
}

export function FolderSwitcher() {
  const roots = useCode((s) => s.roots),
    active = useCode((s) => s.activeRoot),
    recent = useCode((s) => s.recent);
  const repos = useApp((s) => s.repos),
    workspaces = useApp((s) => s.workspaces);
  const root = roots.find((r) => r.path === active),
    ws = workspaces.find((w) => w.id === root?.workspaceId);
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!container.current?.contains(e.target as Node)) setExpanded(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const choose = (path: string, workspaceId?: string) => {
    setExpanded(false);
    void useCode.getState().openRoot(path, { workspaceId });
  };
  const row =
    "flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-[12px] hover:bg-hover focus-visible:bg-hover outline-none";
  return (
    <div ref={container} className="relative min-w-0" onKeyDown={(e) => e.key === "Escape" && setExpanded(false)}>
      <button
        aria-expanded={expanded}
        aria-haspopup="menu"
        onClick={() => setExpanded(!expanded)}
        className="flex max-w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12.5px] font-medium hover:bg-hover"
      >
        <FolderOpen className="size-3.5 shrink-0 text-mute" />
        <span className="truncate">{ws?.name ?? root?.label ?? "Open folder"}</span>
        {ws && <span className="truncate text-mute">{ws.branch}</span>}
        <ChevronDown className="size-3 text-mute" />
      </button>
      {expanded && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-[4px] border-[1.5px] border-line-strong bg-raised p-1.5 shadow-hard"
        >
          {roots.length > 0 && (
            <>
              <p className="px-2 py-1 text-[11px] text-mute">Open folders</p>
              {roots.map((r) => (
                <div className="flex items-center" key={r.path}>
                  <button role="menuitem" className={row} onClick={() => choose(r.path, r.workspaceId ?? undefined)}>
                    {r.label}
                  </button>
                  <button
                    className="p-2 text-mute hover:text-fg"
                    title={`Close folder ${r.label}`}
                    onClick={() => void useCode.getState().closeRoot(r.path)}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </>
          )}
          <p className="px-2 py-1 text-[11px] text-mute">Repositories</p>
          {repos.map((r) => (
            <button role="menuitem" className={row} key={r.id} onClick={() => choose(r.path)}>
              <span>{r.name}</span>
              <span className="ml-auto truncate text-mute">{r.path}</span>
            </button>
          ))}
          <p className="px-2 py-1 text-[11px] text-mute">Workspaces</p>
          {workspaces.map((w) => (
            <button role="menuitem" className={row} key={w.id} onClick={() => choose(w.path, w.id)}>
              <StatusDot status={w.status} />
              <span className="truncate">{w.name}</span>
              <span className="ml-auto truncate text-mute">{w.branch}</span>
            </button>
          ))}
          {recent.length > 0 && (
            <>
              <p className="px-2 py-1 text-[11px] text-mute">Recent folders</p>
              {recent.map((p) => (
                <button role="menuitem" className={row} key={p} onClick={() => choose(p)}>
                  <span className="truncate">{p}</span>
                </button>
              ))}
            </>
          )}
          <button
            role="menuitem"
            className={`${row} mt-1 border-t-[1.5px] border-line`}
            onClick={() => {
              setExpanded(false);
              void openCodeFolder();
            }}
          >
            <FolderOpen className="size-3.5" />
            Open folder…
          </button>
        </div>
      )}
    </div>
  );
}
