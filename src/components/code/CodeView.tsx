import { useEffect } from "react";
import { FolderOpen, Search } from "lucide-react";
import { useCode } from "../../stores/code";
import { useApp } from "../../stores/app";
import { Button, Kbd } from "../ui";
import { FolderSwitcher, openCodeFolder } from "./FolderSwitcher";
import { Explorer } from "./Explorer";
import { EditorTabs } from "./EditorTabs";
import { EditorPane } from "./EditorPane";
import { QuickOpen } from "./QuickOpen";

export function CodeView() {
  const root = useCode((s) => s.activeRoot),
    width = useCode((s) => s.explorerWidth),
    quickOpen = useCode((s) => s.quickOpen);
  const bottomOpen = useCode((s) => s.bottomOpen),
    bottomHeight = useCode((s) => s.bottomHeight),
    activityOpen = useCode((s) => s.activityOpen),
    activityWidth = useCode((s) => s.activityWidth);
  const workspaces = useApp((s) => s.workspaces);
  useEffect(() => {
    void useCode.getState().init();
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const s = useCode.getState(),
        rel = s.roots.find((r) => r.path === s.activeRoot)?.activeRel;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) void s.saveAll();
        else if (rel) void s.save(rel);
      } else if (e.key.toLowerCase() === "w" && !e.shiftKey) {
        e.preventDefault();
        if (rel) void s.closeTab(rel);
      } else if (e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        s.setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return (
    <main data-code-view className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b-[1.5px] border-line px-3" data-tauri-drag-region>
        <span className="text-[13px] font-medium text-mute">Code</span>
        <FolderSwitcher />
        {root && (
          <button
            className="ml-auto flex items-center gap-2 rounded-[4px] px-2 py-1 text-[12px] text-mute hover:bg-hover hover:text-fg"
            onClick={() => useCode.getState().setQuickOpen(true)}
          >
            <Search className="size-3.5" />
            Find file<Kbd>Ctrl P</Kbd>
          </button>
        )}
      </header>
      {!root ? (
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
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside style={{ width }} className="flex min-w-0 shrink-0 flex-col">
            <Explorer />
          </aside>
          <div
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
            {/* Extension point: terminal and project search own their tabs/content in the next slices. */}
            <section
              aria-label="Bottom panel"
              hidden={!bottomOpen}
              style={{ height: bottomHeight }}
              className="shrink-0 border-t-[1.5px] border-line bg-panel"
            >
              <div
                role="tablist"
                aria-label="Bottom panels"
                className="flex h-9 items-center gap-4 border-b-[1.5px] border-line px-3 text-[12px] text-mute"
              >
                <span>Terminal</span>
                <span>Search</span>
              </div>
            </section>
          </section>
          <aside
            aria-label="Activity"
            hidden={!activityOpen}
            style={{ width: activityWidth }}
            className="shrink-0 border-l-[1.5px] border-line bg-panel"
          />
        </div>
      )}
      {quickOpen && <QuickOpen />}
    </main>
  );
}
