import { useKeybindingLabels } from "../lib/useKeybinding";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, Code2, CircleDot, Clock, FolderPlus, Inbox, PanelLeft, Plus, Search, Settings, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { attentionReason, isUnread } from "../lib/attention";
import { archiveWithWorktree } from "../lib/archive";
import { confirmAction } from "../lib/confirm";
import { api, type Repo, type Workspace } from "../lib/ipc";
import { diffTotals, useApp } from "../stores/app";
import { TeammateLabel } from "./TeammateAvatar";
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
  const keyLabel = useKeybindingLabels();
  const repos = useApp((s) => s.repos);
  const workspaces = useApp((s) => s.workspaces);
  const running = workspaces.filter((w) => w.status === "running").length;
  const view = useApp((s) => s.view);
  const summaries = useApp((s) => s.summaries);
  const prs = useApp((s) => s.prs);
  const reviews = useApp((s) => s.reviews);
  const teammatesNeedYou = useApp((s) => s.teammates.filter((t) => t.status === "needsYou").length);
  const needsYou = workspaces.filter((w) => attentionReason(w, summaries[w.id], prs[w.id], undefined, reviews[w.id]?.review)).length + teammatesNeedYou;
  const activeRoutines = useApp((s) => s.routines.filter((r) => r.enabled).length);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  if (collapsed) return <Rail workspaces={workspaces} needsYou={needsYou} activeRoutines={activeRoutines} teammatesNeedYou={teammatesNeedYou} />;

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
          title={"Collapse sidebar" + (keyLabel("workbench.toggleSidebar") ? ` (${keyLabel("workbench.toggleSidebar")})` : "")}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-[4px] text-mute hover:bg-hover hover:text-fg",
            running === 0 && "ml-auto",
          )}
        >
          <PanelLeft className="size-3.5" />
        </button>
      </div>
      <div className="border-t-[1.5px] border-line" />

      <nav className="space-y-0.5 px-2 py-2">
        <NavItem icon={<Code2 className="size-3.5" />} label="Code" kbd={keyLabel("views.code")} active={view === "code"} onClick={() => useApp.getState().setView(view === "code" ? "workspace" : "code")} />
        <NavItem
          icon={<Inbox className="size-3.5" strokeWidth={2.5} />}
          label="Inbox"
          kbd={keyLabel("views.inbox")}
          active={view === "inbox"}
          count={needsYou}
          onClick={() => useApp.getState().setView(view === "inbox" ? "workspace" : "inbox")}
        />
        <NavItem
          icon={<Clock className="size-3.5" strokeWidth={2.5} />}
          label="Routines"
          kbd={keyLabel("views.routines")}
          active={view === "routines"}
          count={activeRoutines}
          onClick={() => useApp.getState().setView(view === "routines" ? "workspace" : "routines")}
        />
        <NavItem
          icon={<Users className="size-3.5" strokeWidth={2.5} />}
          label="Teammates"
          kbd={keyLabel("views.teammates")}
          active={view === "teammate"}
          count={teammatesNeedYou}
          onClick={() => useApp.getState().setView(view === "teammate" ? "workspace" : "teammate")}
        />
        <NavItem
          icon={<CircleDot className="size-3.5" strokeWidth={2.5} />}
          label="Issues"
          kbd={keyLabel("views.issues")}
          active={view === "issues"}
          onClick={() => useApp.getState().setView(view === "issues" ? "workspace" : "issues")}
        />
        <NavItem icon={<Plus className="size-3.5" strokeWidth={2.5} />} label="New workspace" kbd={keyLabel("workbench.newWorkspace")} onClick={() => useApp.getState().setNewWorkspaceOpen(true)} />
        <NavItem icon={<Search className="size-3.5" strokeWidth={2.5} />} label="Command palette" kbd={keyLabel("workbench.commandPalette")} onClick={() => useApp.getState().setPaletteOpen(true)} />
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
        <SettingsButton />
        <ThemeToggle />
      </div>
    </aside>
  );
}

/** Icon-only sidebar: nav actions plus one status dot per workspace. */
function Rail({ workspaces, needsYou, activeRoutines, teammatesNeedYou }: { workspaces: Workspace[]; needsYou: number; activeRoutines: number; teammatesNeedYou: number }) {
  const keyLabel = useKeybindingLabels();
  const view = useApp((s) => s.view);
  const selectedId = useApp((s) => s.selectedId);
  const summaries = useApp((s) => s.summaries);
  const btn = "relative grid size-9 place-items-center rounded-[4px] hover:bg-hover hover:text-fg";
  return (
    <aside className="flex h-full w-[52px] shrink-0 flex-col items-center border-r-[1.5px] border-line bg-panel">
      <div className="grid h-12 place-items-center" data-tauri-drag-region>
        <button onClick={() => useApp.getState().setSidebarCollapsed(false)} title={"Expand sidebar" + (keyLabel("workbench.toggleSidebar") ? ` (${keyLabel("workbench.toggleSidebar")})` : "")}>
          <OrbitMark size={30} zoom={1.75} />
        </button>
      </div>
      <div className="dither-rule w-full bg-line-strong" />
      <nav className="flex flex-col items-center gap-0.5 py-2 text-dim">
        <button title={"Code" + (keyLabel("views.code") ? ` (${keyLabel("views.code")})` : "")} onClick={() => useApp.getState().setView(view === "code" ? "workspace" : "code")} className={cn(btn, view === "code" && "bg-raised text-fg")}><Code2 className="size-3.5" /></button>
        <button
          onClick={() => useApp.getState().setView(view === "inbox" ? "workspace" : "inbox")}
          title={"Inbox" + (keyLabel("views.inbox") ? ` (${keyLabel("views.inbox")})` : "")}
          className={cn(btn, view === "inbox" && "bg-raised text-fg")}
        >
          <Inbox className="size-3.5" strokeWidth={2.5} />
          {needsYou > 0 && (
            <span className="absolute right-0.5 top-0.5 rounded-[3px] bg-fg px-1 text-[9px] font-semibold leading-3.5 tabular-nums text-bg">
              {needsYou}
            </span>
          )}
        </button>
        <button
          onClick={() => useApp.getState().setView(view === "routines" ? "workspace" : "routines")}
          title={"Routines" + (keyLabel("views.routines") ? ` (${keyLabel("views.routines")})` : "")}
          className={cn(btn, view === "routines" && "bg-raised text-fg")}
        >
          <Clock className="size-3.5" strokeWidth={2.5} />
          {activeRoutines > 0 && (
            <span className="absolute right-0.5 top-0.5 rounded-[3px] bg-fg px-1 text-[9px] font-semibold leading-3.5 tabular-nums text-bg">
              {activeRoutines}
            </span>
          )}
        </button>
        <button
          onClick={() => useApp.getState().setView(view === "teammate" ? "workspace" : "teammate")}
          title={"Teammates" + (keyLabel("views.teammates") ? ` (${keyLabel("views.teammates")})` : "")}
          className={cn(btn, view === "teammate" && "bg-raised text-fg")}
        >
          <Users className="size-3.5" strokeWidth={2.5} />
          {teammatesNeedYou > 0 && (
            <span className="absolute right-0.5 top-0.5 rounded-[3px] bg-fg px-1 text-[9px] font-semibold leading-3.5 tabular-nums text-bg">
              {teammatesNeedYou}
            </span>
          )}
        </button>
        <button
          onClick={() => useApp.getState().setView(view === "issues" ? "workspace" : "issues")}
          title={"Issues" + (keyLabel("views.issues") ? ` (${keyLabel("views.issues")})` : "")}
          className={cn(btn, view === "issues" && "bg-raised text-fg")}
        >
          <CircleDot className="size-3.5" strokeWidth={2.5} />
        </button>
        <button onClick={() => useApp.getState().setNewWorkspaceOpen(true)} title={"New workspace" + (keyLabel("workbench.newWorkspace") ? ` (${keyLabel("workbench.newWorkspace")})` : "")} className={btn}>
          <Plus className="size-3.5" strokeWidth={2.5} />
        </button>
        <button onClick={() => useApp.getState().setPaletteOpen(true)} title={"Command palette" + (keyLabel("workbench.commandPalette") ? ` (${keyLabel("workbench.commandPalette")})` : "")} className={btn}>
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
      <div className="flex flex-col items-center gap-0.5 py-2">
        <SettingsButton />
        <ThemeToggle />
      </div>
    </aside>
  );
}

function SettingsButton() {
  const keyLabel = useKeybindingLabels();
  const active = useApp((s) => s.view === "settings");
  return (
    <button
      onClick={() => (active ? useApp.getState().closeSettings() : useApp.getState().openSettings())}
      title={"Settings" + (keyLabel("workbench.settings") ? ` (${keyLabel("workbench.settings")})` : "")}
      aria-label="Settings"
      className={cn("grid size-7 shrink-0 place-items-center rounded-[4px] hover:bg-hover hover:text-fg", active ? "bg-raised text-fg" : "text-dim")}
    >
      <Settings className="size-3.5" />
    </button>
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
      title={kbd ? `${label} (${kbd})` : undefined}
      className={cn(
        "flex h-7 w-full items-center gap-2.5 rounded-[4px] px-2 text-[12.5px] font-medium transition-colors",
        active ? "bg-raised text-fg" : "text-dim hover:bg-hover hover:text-fg",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {!!count && (
        <span className="rounded-[3px] bg-fg px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-bg">{count}</span>
      )}
      {/* With a count badge there is no room for the shortcut too; it moves to the tooltip. */}
      {kbd && !count && <Kbd>{kbd}</Kbd>}
    </button>
  );
}

function RepoGroup({ repo, workspaces }: { repo: Repo; workspaces: Workspace[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const groups = useApp((s) => s.attemptGroups);
  // Best of N attempts collapse into one row (at the position of their first member) with A/B/C children.
  const items = useMemo(() => {
    const out: ({ kind: "ws"; ws: Workspace } | { kind: "group"; id: string; members: Workspace[] })[] = [];
    const seen = new Set<string>();
    for (const ws of workspaces) {
      // A decided group (kept or cancelled) is just a workspace again.
      if (!ws.attemptGroup || (groups[ws.attemptGroup] && groups[ws.attemptGroup].status !== "running")) out.push({ kind: "ws", ws });
      else if (!seen.has(ws.attemptGroup)) {
        seen.add(ws.attemptGroup);
        out.push({ kind: "group", id: ws.attemptGroup, members: workspaces.filter((w) => w.attemptGroup === ws.attemptGroup) });
      }
    }
    return out;
  }, [workspaces, groups]);
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
          {items.map((it) => (it.kind === "ws" ? <WorkspaceRow key={it.ws.id} ws={it.ws} /> : <AttemptGroupRow key={it.id} id={it.id} members={it.members} />))}
        </ul>
      )}
    </section>
  );
}

function AttemptGroupRow({ id, members }: { id: string; members: Workspace[] }) {
  const [open, setOpen] = useState(true);
  const group = useApp((s) => s.attemptGroups[id]);
  const selected = useApp((s) => s.view === "attempts" && s.selectedAttemptGroup === id);
  const running = members.some((w) => w.status === "running");
  const title = group?.prompt.split("\n")[0] || members[0].name.replace(/\s·\s[A-D]$/, "");
  return (
    <li>
      <div className={cn("relative flex h-8 items-center rounded-[4px] pr-2 text-[12px] font-medium transition-colors", selected ? "bg-raised text-fg" : "text-dim hover:bg-hover/70 hover:text-fg")}>
        <button onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse attempts" : "Expand attempts"} className="grid h-8 w-6 shrink-0 place-items-center text-mute hover:text-dim">
          {open ? <ChevronDown className="size-3" strokeWidth={3} /> : <ChevronRight className="size-3" strokeWidth={3} />}
        </button>
        <button data-attempt-group={id} onClick={() => useApp.getState().openAttempts(id)} className="relative flex min-w-0 flex-1 items-center gap-2 text-left">
          {selected && <span className="absolute inset-y-0 -left-6 w-[3px] bg-accent" />}
          {running && <span className="dither-sweep bg-run opacity-30" />}
          <span className="relative min-w-0 flex-1 truncate">{title}</span>
          <span className="relative shrink-0 text-[11px] text-mute">Best of {members.length}</span>
        </button>
      </div>
      {open && (
        <ul className="ml-4 space-y-px border-l border-line pl-1">
          {members.map((w, i) => (
            <WorkspaceRow key={w.id} ws={w} label={`Attempt ${"ABCD"[i]}`} />
          ))}
        </ul>
      )}
    </li>
  );
}

type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean } | "sep";

/** Right-click menu for a workspace row; closes on any outside click, scroll, resize or Escape. */
function WorkspaceMenu({ ws, x, y, onRename, onClose }: { ws: Workspace; x: number; y: number; onRename: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    const close = () => onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, [x, y, onClose]);

  const fail = (e: unknown) => useApp.getState().setError(String(e));
  const items: MenuItem[] = [
    { label: "Rename", run: onRename },
    { label: "Open worktree folder", run: () => void revealItemInDir(ws.path).catch(fail) },
    { label: "Copy branch name", run: () => void navigator.clipboard.writeText(ws.branch).catch(fail) },
    "sep",
    { label: "New session", run: () => void useApp.getState().newSession(ws.id) },
    { label: "Stop agent", disabled: ws.status !== "running", run: () => void api.interrupt(ws.id).catch(fail) },
    "sep",
    {
      label: "Archive…",
      danger: true,
      run: () => {
        void (async () => {
          const ok = await confirmAction(`Archive "${ws.name}" and delete its worktree?

The branch ${ws.branch} is kept.`, "Archive");
          if (!ok) return;
          try {
            if (await archiveWithWorktree(ws.id, ws.name)) useApp.getState().removeWorkspace(ws.id);
          } catch (e) {
            fail(e);
          }
        })();
      },
    },
  ];
  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 min-w-[190px] rounded-[6px] border-[1.5px] border-line-strong bg-raised p-1 shadow-pop"
    >
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <button
            key={it.label}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run();
            }}
            className={cn(
              "flex h-7 w-full items-center rounded-[4px] px-2.5 text-left text-[12.5px] font-medium disabled:opacity-40",
              it.danger ? "text-bad hover:bg-hover" : "text-dim hover:bg-hover hover:text-fg",
            )}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

function WorkspaceRow({ ws, label }: { ws: Workspace; label?: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(ws.name);
  const commitRename = () => {
    setRenaming(false);
    const name = draft.trim();
    if (name && name !== ws.name) void api.renameWorkspace(ws.id, name).catch((e) => useApp.getState().setError(String(e)));
  };
  const selected = useApp((s) => s.view === "workspace" && s.selectedId === ws.id);
  const unread = useApp((s) => isUnread(ws, s.summaries[ws.id]));
  const totals = diffTotals(useApp((s) => s.changes[ws.id]));
  const running = ws.status === "running";
  const plan = useApp((s) => s.plans[ws.id]);
  useEffect(() => {
    if (running) useApp.getState().ensurePlan(ws.id);
  }, [running, ws.id]);
  const planDone = plan ? plan.items.filter((i) => i.status === "done").length : 0;
  return (
    <li>
      {renaming && (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          aria-label="Workspace name"
          className="h-8 w-full rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] font-medium focus:outline-none"
        />
      )}
      {menu && (
        <WorkspaceMenu
          ws={ws}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => {
            setDraft(ws.name);
            setRenaming(true);
          }}
        />
      )}
      <button
        onClick={() => useApp.getState().select(ws.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={cn(
          renaming && "hidden",
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
        <span className={cn("relative min-w-0 flex-1 truncate", unread && "text-fg")}>{label ?? ws.name}</span>
        {ws.teammate && <TeammateLabel slug={ws.teammate} className="relative max-w-[72px] truncate" />}
        {ws.routineId && (
          <span title="Started by a routine" className="relative shrink-0 text-mute">
            <Clock className="size-3" />
          </span>
        )}
        {running && plan && plan.items.length > 0 && (
          <span title="Plan progress" className="relative shrink-0 text-[10.5px] font-medium tabular-nums text-mute">
            {planDone}/{plan.items.length}
          </span>
        )}
        <DiffStat {...totals} className={cn("relative", !selected && "hidden group-hover:inline")} />
        <AgentIcon agent={ws.agent} className="relative size-3 opacity-70" />
      </button>
    </li>
  );
}
