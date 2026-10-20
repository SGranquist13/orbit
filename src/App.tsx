import { FolderPlus, Plus, X } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { Chat } from "./components/Chat";
import { NewWorkspace } from "./components/NewWorkspace";
import { Palette } from "./components/Palette";
import { RightPanel } from "./components/RightPanel";
import { Sidebar, pickRepo } from "./components/Sidebar";
import { Button } from "./components/ui";
import { OrbitHero } from "./components/OrbitHero";
import { installKeybindings } from "./lib/keybindingRuntime";
import { KeybindingHint } from "./components/KeybindingHint";
import { useApp } from "./stores/app";

const CodeView = lazy(() => import("./components/code/CodeView").then((m) => ({ default: m.CodeView })));

// Heavy views load on first use so the main chunk stays small.
const Inbox = lazy(() => import("./components/Inbox").then((m) => ({ default: m.Inbox })));
const Issues = lazy(() => import("./components/Issues").then((m) => ({ default: m.Issues })));
const NewTicket = lazy(() => import("./components/Issues").then((m) => ({ default: m.NewTicket })));
const Packs = lazy(() => import("./components/Packs").then((m) => ({ default: m.Packs })));
const Settings = lazy(() => import("./components/Settings").then((m) => ({ default: m.Settings })));
const Routines = lazy(() => import("./components/Routines").then((m) => ({ default: m.Routines })));
const Teammates = lazy(() => import("./components/Teammates").then((m) => ({ default: m.Teammates })));
const TeammateEditor = lazy(() => import("./components/Teammates").then((m) => ({ default: m.TeammateEditor })));
const SimplifyPanel = lazy(() => import("./components/SimplifyPanel").then((m) => ({ default: m.SimplifyPanel })));

/** Quiet placeholder while a lazy view loads. */
function Lazy({ children, fallback }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  return <Suspense fallback={fallback === undefined ? <main className="flex-1 bg-bg" /> : fallback}>{children}</Suspense>;
}

export default function App() {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === s.selectedId));
  const newOpen = useApp((s) => s.newWorkspaceOpen);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const packsOpen = useApp((s) => s.packsOpen);
  const ticketOpen = useApp((s) => s.ticketOpen);
  const view = useApp((s) => s.view);
  const [codeLoaded, setCodeLoaded] = useState(view === "code");
  useEffect(() => { if (view === "code") setCodeLoaded(true); }, [view]);
  const shipOpen = useApp((s) => s.shipOpen);
  const simplifyOpen = useApp((s) => s.simplifyOpen);
  const focusMode = useApp((s) => s.focusMode);
  const teammateEditor = useApp((s) => s.teammateEditor);

  useEffect(() => {
    useApp.getState().init().catch((e) => useApp.getState().setError(String(e)));
  }, []);

  const [chordHint, setChordHint] = useState("");
  useEffect(() => installKeybindings(setChordHint), []);

  return (
    <div className="flex h-full">
      {!focusMode && <Sidebar />}
      {(codeLoaded || view === "code") && (
        <div className={view === "code" ? "flex min-w-0 flex-1" : "hidden"}>
          <Lazy><CodeView /></Lazy>
        </div>
      )}
      {view === "code" ? null : view === "settings" ? (
        <Lazy><Settings /></Lazy>
      ) : view === "inbox" ? (
        <Lazy><Inbox /></Lazy>
      ) : view === "issues" ? (
        <Lazy><Issues /></Lazy>
      ) : view === "routines" ? (
        <Lazy><Routines /></Lazy>
      ) : view === "teammate" ? (
        <Lazy><Teammates /></Lazy>
      ) : ws ? (
        <>
          <Chat key={ws.id} ws={ws} />
          {simplifyOpen && !focusMode ? <Lazy fallback={null}><SimplifyPanel key={`simplify-${ws.id}`} ws={ws} /></Lazy> : shipOpen && !focusMode && <RightPanel ws={ws} />}
        </>
      ) : (
        <Empty />
      )}
      {newOpen && <NewWorkspace />}
      {teammateEditor && (
        <Suspense fallback={null}>
          <TeammateEditor key={teammateEditor} slug={teammateEditor} />
        </Suspense>
      )}
      {paletteOpen && <Palette />}
      {packsOpen && <Lazy fallback={null}><Packs /></Lazy>}
      {ticketOpen && <Lazy fallback={null}><NewTicket /></Lazy>}
      {chordHint && <div role="status" className="fixed bottom-2 left-2 z-[70] rounded-[4px] border border-line bg-raised px-3 py-2 font-sans text-[12px] text-mute">{chordHint}</div>}
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
            <Plus className="size-3.5" /> New workspace <KeybindingHint command="workbench.newWorkspace" />
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
