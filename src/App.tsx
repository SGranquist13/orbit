import { FolderPlus, Plus, X } from "lucide-react";
import { useEffect } from "react";
import { Chat } from "./components/Chat";
import { Inbox } from "./components/Inbox";
import { Issues, NewTicket } from "./components/Issues";
import { NewWorkspace } from "./components/NewWorkspace";
import { Packs } from "./components/Packs";
import { Palette } from "./components/Palette";
import { RightPanel } from "./components/RightPanel";
import { Settings } from "./components/Settings";
import { Sidebar, pickRepo } from "./components/Sidebar";
import { Button, Kbd } from "./components/ui";
import { OrbitHero } from "./components/OrbitHero";
import { useTheme } from "./lib/theme";
import { useApp } from "./stores/app";

export default function App() {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === s.selectedId));
  const newOpen = useApp((s) => s.newWorkspaceOpen);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const packsOpen = useApp((s) => s.packsOpen);
  const ticketOpen = useApp((s) => s.ticketOpen);
  const view = useApp((s) => s.view);
  const shipOpen = useApp((s) => s.shipOpen);
  const focusMode = useApp((s) => s.focusMode);

  useEffect(() => {
    useApp.getState().init().catch((e) => useApp.getState().setError(String(e)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const s = useApp.getState();
      const key = e.key.toLowerCase();
      if (key === "l" && e.shiftKey) {
        e.preventDefault();
        useTheme.getState().toggle();
      } else if (key === "k") {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (key === "g" && e.shiftKey) {
        // Not Ctrl+Shift+I: WebView2 reserves it for DevTools in dev builds.
        e.preventDefault();
        s.setView(s.view === "issues" ? "workspace" : "issues");
      } else if (e.key === ",") {
        e.preventDefault();
        if (s.view === "settings") s.closeSettings();
        else s.openSettings();
      } else if (key === "i") {
        e.preventDefault();
        s.setView(s.view === "inbox" ? "workspace" : "inbox");
      } else if (e.key === ".") {
        e.preventDefault();
        s.setShipOpen(!s.shipOpen);
      } else if (key === "b") {
        e.preventDefault();
        s.setSidebarCollapsed(!s.sidebarCollapsed);
      } else if (e.key === "\\") {
        e.preventDefault();
        s.setFocusMode(!s.focusMode);
      } else if (key === "n") {
        e.preventDefault();
        s.setNewWorkspaceOpen(true);
      } else if (/^[1-9]$/.test(e.key)) {
        // Ctrl+1..9 jumps to the nth workspace in sidebar order.
        const ordered = s.repos.flatMap((r) => s.workspaces.filter((w) => w.repoId === r.id));
        const target = ordered[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          s.select(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full">
      {!focusMode && <Sidebar />}
      {view === "settings" ? (
        <Settings />
      ) : view === "inbox" ? (
        <Inbox />
      ) : view === "issues" ? (
        <Issues />
      ) : ws ? (
        <>
          <Chat key={ws.id} ws={ws} />
          {shipOpen && !focusMode && <RightPanel ws={ws} />}
        </>
      ) : (
        <Empty />
      )}
      {newOpen && <NewWorkspace />}
      {paletteOpen && <Palette />}
      {packsOpen && <Packs />}
      {ticketOpen && <NewTicket />}
      <ErrorToast />
    </div>
  );
}

function Empty() {
  const hasRepos = useApp((s) => s.repos.length > 0);
  return (
    <main className="relative grid flex-1 place-items-center overflow-hidden" data-tauri-drag-region>
      <div className="relative flex flex-col items-center text-center">
        <OrbitHero size={440} />
        <div className="-mt-6">
          <h2 className="text-[56px] font-semibold leading-none tracking-[-0.035em]">orbit</h2>
          <p className="mt-3 text-[13.5px] font-medium text-dim">Every task gets its own worktree, branch, and agent.</p>
        </div>
        <div className="mt-6" />
        {hasRepos ? (
          <Button variant="primary" onClick={() => useApp.getState().setNewWorkspaceOpen(true)}>
            <Plus className="size-3.5" /> New workspace <Kbd>Ctrl N</Kbd>
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void pickRepo()}>
            <FolderPlus className="size-3.5" /> Add a repository
          </Button>
        )}
      </div>
    </main>
  );
}

function ErrorToast() {
  const error = useApp((s) => s.error);
  if (!error) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex max-w-[440px] items-start gap-3 rounded-[4px] border-[1.5px] border-bad bg-raised px-3.5 py-2.5 shadow-hard">
      <p className="selectable flex-1 whitespace-pre-wrap text-[11.5px] font-medium text-bad">{error}</p>
      <button onClick={() => useApp.getState().setError(null)} className="text-mute hover:text-fg">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
