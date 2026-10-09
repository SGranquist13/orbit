import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, FolderPlus, Inbox, PanelLeft, Plus, Search } from "lucide-react";
import { useState } from "react";
import { attentionReason, isUnread } from "../lib/attention";
import type { Repo, Workspace } from "../lib/ipc";
import { diffTotals, useApp } from "../stores/app";
import { AgentIcon, DiffStat, Kbd, OrbitMark, StatusDot, ThemeToggle, cn } from "./ui";

export async function pickRepo() {
  const path = await open({ directory: true, title: "Add a git repository" });
  if (typeof path !== "string") return null;
  try {
    return await useApp.getState().addRepo(path);
  } catch (e) {
    useApp.getState().setError(String(e));
    return null;
  }
}

export function Sidebar() {
  const repos = useApp((s) => s.repos);
  const workspaces = useApp((s) => s.workspaces);
  const running = workspaces.filter((w) => w.status === "running").length;
  const view = useApp((s) => s.view);
  const summaries = useApp((s) => s.summaries);
  const prs = useApp((s) => s.prs);
  const needsYou = workspaces.filter((w) => attentionReason(w, summaries[w.id], prs[w.id])).length;
  const collapsed = useApp((s) => s.sidebarCollapsed);
  if (collapsed) return <Rail workspaces={workspaces} needsYou={needsYou} />;

  return (
    <aside className="relative flex h-full w-[216px] shrink-0 flex-col border-r-[1.5px] border-line bg-panel">
      <div className="flex h-12 items-center gap-2 px-3" data-tauri-drag-region>
        <OrbitMark size={30} zoom={1.75} className="-ml-1" />
        <span className="text-[17px] font-semibold tracking-[-0.02em]">orbit</span>
        {running > 0 && (
          <span className="ml-auto flex items-center gap-1.5 rounded-[3px] bg-run px-1.5 py-px text-[10px] font-semibold text-accent-fg">
            <span className="size-1.5 animate-pulse-dot bg-accent-fg" />
            {running} LIVE
          </span>
        )}
        <button
          onClick={() => useApp.getState().setSidebarCollapsed(true)}
          title="Collapse sidebar (Ctrl B)"
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-[4px] text-mute hover:bg-hover hover:text-fg",
            running === 0 && "ml-auto",
          )}
        >
          <PanelLeft className="size-3.5" />
        </button>
      </div>
      <div className="dither-rule bg-line-strong" />

      <nav className="space-y-0.5 px-2 py-2">
        <NavItem
          icon={<Inbox className="size-3.5" strokeWidth={2.5} />}
          label="Inbox"
          kbd="Ctrl I"
          active={view === "inbox"}
          count={needsYou}
          onClick={() => useApp.getState().setView(view === "inbox" ? "workspace" : "inbox")}
        />
        <NavItem icon={<Plus className="size-3.5" strokeWidth={2.5} />} label="New workspace" kbd="Ctrl N" onClick={() => useApp.getState().setNewWorkspaceOpen(true)} />
        <NavItem icon={<Search className="size-3.5" strokeWidth={2.5} />} label="Command palette" kbd="Ctrl K" onClick={() => useApp.getState().setPaletteOpen(true)} />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {repos.map((repo) => (
          <RepoGroup key={repo.id} repo={repo} workspaces={workspaces.filter((w) => w.repoId === repo.id)} />
        ))}
        {repos.length === 0 && (
          <p className="px-2 pt-6 text-center text-[12px] leading-relaxed text-mute">
            Add a repository to start running agents in parallel worktrees.
          </p>
        )}
      </div>

      <div className="dither-rule rotate-180 bg-line-strong" />
      <div className="flex items-center gap-2 px-2 py-2">
        <button
          onClick={() => void pickRepo()}
          title="Add repository"
          className="flex h-7 flex-1 items-center gap-2 rounded-[4px] px-2 text-[12.5px] font-medium text-dim hover:bg-hover hover:text-fg"
        >
          <FolderPlus className="size-3.5" strokeWidth={2.25} /> Add repo
        </button>
        <ThemeToggle />
      </div>
    </aside>
  );
}

/** Icon-only sidebar: nav actions plus one status dot per workspace. */
function Rail({ workspaces, needsYou }: { workspaces: Workspace[]; needsYou: number }) {
  const view = useApp((s) => s.view);
  const selectedId = useApp((s) => s.selectedId);
  const summaries = useApp((s) => s.summaries);
  const btn = "relative grid size-9 place-items-center rounded-[4px] hover:bg-hover hover:text-fg";
  return (
    <aside className="flex h-full w-[52px] shrink-0 flex-col items-center border-r-[1.5px] border-line bg-panel">
      <div className="grid h-12 place-items-center" data-tauri-drag-region>
        <button onClick={() => useApp.getState().setSidebarCollapsed(false)} title="Expand sidebar (Ctrl B)">
          <OrbitMark size={30} zoom={1.75} />
        </button>
      </div>
      <div className="dither-rule w-full bg-line-strong" />
      <nav className="flex flex-col items-center gap-0.5 py-2 text-dim">
        <button
          onClick={() => useApp.getState().setView(view === "inbox" ? "workspace" : "inbox")}
          title="Inbox (Ctrl I)"
          className={cn(btn, view === "inbox" && "bg-raised text-fg")}
        >
          <Inbox className="size-3.5" strokeWidth={2.5} />
          {needsYou > 0 && (
            <span className="absolute right-0.5 top-0.5 rounded-[3px] bg-fg px-1 text-[9px] font-semibold leading-3.5 tabular-nums text-bg">
              {needsYou}
            </span>
          )}
        </button>
        <button onClick={() => useApp.getState().setNewWorkspaceOpen(true)} title="New workspace (Ctrl N)" className={btn}>
          <Plus className="size-3.5" strokeWidth={2.5} />
        </button>
        <button onClick={() => useApp.getState().setPaletteOpen(true)} title="Command palette (Ctrl K)" className={btn}>
          <Search className="size-3.5" strokeWidth={2.5} />
        </button>
      </nav>
      <div className="dither-rule w-full bg-line-strong" />
      <div className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto py-2">
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            onClick={() => useApp.getState().select(ws.id)}
            title={ws.name}
            className={cn(btn, view === "workspace" && selectedId === ws.id && "bg-raised")}
          >
            <StatusDot status={ws.status} unread={isUnread(ws, summaries[ws.id])} />
          </button>
        ))}
      </div>
      <div className="dither-rule w-full rotate-180 bg-line-strong" />
      <div className="py-2">
        <ThemeToggle />
      </div>
    </aside>
  );
}

function NavItem({
  icon,
  label,
  kbd,
  active,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  kbd?: string;
  active?: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center gap-2.5 rounded-[4px] px-2 text-[12.5px] font-medium transition-colors",
        active ? "bg-raised text-fg" : "text-dim hover:bg-hover hover:text-fg",
      )}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {!!count && (
        <span className="rounded-[3px] bg-fg px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-bg">{count}</span>
      )}
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  );
}

function RepoGroup({ repo, workspaces }: { repo: Repo; workspaces: Workspace[] }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="mt-3">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="label flex h-6 w-full items-center gap-1 px-2 text-mute hover:text-dim"
      >
        {collapsed ? <ChevronRight className="size-3" strokeWidth={3} /> : <ChevronDown className="size-3" strokeWidth={3} />}
        <span className="flex-1 truncate text-left">{repo.name}</span>
        <span>{workspaces.length}</span>
      </button>
      {!collapsed && (
        <ul className="mt-0.5 space-y-px">
          {workspaces.map((ws) => (
            <WorkspaceRow key={ws.id} ws={ws} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkspaceRow({ ws }: { ws: Workspace }) {
  const selected = useApp((s) => s.view === "workspace" && s.selectedId === ws.id);
  const unread = useApp((s) => isUnread(ws, s.summaries[ws.id]));
  const totals = diffTotals(useApp((s) => s.changes[ws.id]));
  const running = ws.status === "running";
  return (
    <li>
      <button
        onClick={() => useApp.getState().select(ws.id)}
        className={cn(
          "group relative flex h-8 w-full items-center gap-2.5 overflow-hidden rounded-[4px] px-2 text-left text-[12px] font-medium transition-colors",
          selected ? "bg-raised text-fg" : "text-dim hover:bg-hover/70 hover:text-fg",
        )}
      >
        {selected && (
          <>
            <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" />
            <span className="dither-fade-x absolute inset-y-0 left-[3px] w-24 bg-accent opacity-[0.14]" />
          </>
        )}
        {running && <span className="dither-sweep bg-run opacity-30" />}
        <StatusDot status={ws.status} unread={unread} />
        <span className={cn("relative min-w-0 flex-1 truncate", unread && "text-fg")}>{ws.name}</span>
        <DiffStat {...totals} className={cn("relative", !selected && "hidden group-hover:inline")} />
        <AgentIcon agent={ws.agent} className="relative size-3 opacity-70" />
      </button>
    </li>
  );
}
