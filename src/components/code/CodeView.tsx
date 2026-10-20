import { commands, registerHandler } from "../../lib/keybindings";
import { runEditorCommand } from "../../lib/code/keymap";
import { useEffect } from "react";
import { FolderOpen, Search } from "lucide-react";
import { useCode } from "../../stores/code";
import { useApp } from "../../stores/app";
import { Button } from "../ui";
import { FolderSwitcher, openCodeFolder } from "./FolderSwitcher";
import { Explorer } from "./Explorer";
import { EditorTabs } from "./EditorTabs";
import { EditorPane } from "./EditorPane";
import { BottomPanel } from "./BottomPanel";
import { AgentStrip, ActivityTimeline } from "./AgentActivity";
import { KeybindingHint } from "../KeybindingHint";
import { QuickOpen } from "./QuickOpen";

export function CodeView() {
  const explorerHidden = useCode((s) => s.explorerHidden);
  const explorerFocus = useCode((s) => s.explorerFocus);
  const active = useApp((s) => s.view === "code");
  const root = useCode((s) => s.activeRoot),
    width = useCode((s) => s.explorerWidth),
    quickOpen = useCode((s) => s.quickOpen);
  const activityOpen = useCode((s) => s.activityOpen),
    activityWidth = useCode((s) => s.activityWidth);
  const workspaces = useApp((s) => s.workspaces);
  useEffect(() => {
    if (active && explorerFocus && root) {
      document.querySelector<HTMLElement>('[role="tree"]')?.focus();
      useCode.setState({ explorerFocus: 0 });
    }
  }, [active, explorerFocus, root]);
  useEffect(() => {
    const off = commands.filter((c) => c.when === "editor").map((c) => registerHandler(c.id, () => runEditorCommand(c.id)));
    return () => off.forEach((unregister) => unregister());
  }, []);
  useEffect(() => {
    void useCode.getState().init();
  }, []);

  return (
    <main data-code-view={active ? "" : undefined} className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b-[1.5px] border-line px-3" data-tauri-drag-region>
        <span className="text-[13px] font-medium text-mute">Code</span>
        <FolderSwitcher />
        <AgentStrip />
        {root && (
          <button
            className="ml-auto flex items-center gap-2 rounded-[4px] px-2 py-1 text-[12px] text-mute hover:bg-hover hover:text-fg"
            onClick={() => useCode.getState().setQuickOpen(true)}
          >
            <Search className="size-3.5" />
            Find file
            <KeybindingHint command="code.quickOpen" />
          </button>
        )}
      </header>
      {!root && (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6">
          <FolderOpen className="size-9 text-mute" strokeWidth={1.5} />
          <h1 className="text-center text-[24px] font-medium tracking-tight text-dim">Open a folder or a workspace</h1>
          <Button onClick={() => void openCodeFolder()}>
            <FolderOpen className="size-3.5" />
            Open folder
          </Button>
          {workspaces.length > 0 && (
            <div className="mt-2 flex max-w-lg flex-wrap justify-center gap-2">
              {workspaces.slice(0, 5).map((w) => (
                <Button key={w.id} onClick={() => void useCode.getState().openRoot(w.path, { workspaceId: w.id })}>
                  {w.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className={root ? "flex min-h-0 flex-1" : "hidden"}>
        <aside
          hidden={explorerHidden}
          style={{ width: explorerHidden ? 0 : width }}
          className={explorerHidden ? "hidden" : "flex min-w-0 shrink-0 flex-col"}
        >
          <Explorer />
        </aside>
        <div
          hidden={explorerHidden}
          role="separator"
          aria-label="Explorer width"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={160}
          aria-valuemax={480}
          tabIndex={0}
          className="w-[3px] shrink-0 cursor-col-resize border-r-[1.5px] border-line hover:bg-line-strong focus:bg-line-strong"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              useCode.getState().setExplorerWidth(width + (e.key === "ArrowRight" ? 16 : -16));
            }
          }}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) useCode.getState().setExplorerWidth(width + e.movementX);
          }}
          onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        />
        <section className="flex min-w-0 flex-1 flex-col">
          <EditorTabs />
          <EditorPane />
          <BottomPanel />
        </section>
        <aside
          aria-label="Activity"
          hidden={!activityOpen}
          style={{ width: activityWidth }}
          className="shrink-0 border-l-[1.5px] border-line bg-panel"
        >
          <ActivityTimeline />
        </aside>
      </div>
      {quickOpen && <QuickOpen />}
    </main>
  );
}
