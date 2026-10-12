import { Command } from "cmdk";
import { useState } from "react";
import { AlarmClock, CalendarClock, CircleDot, Clock, Cpu, Focus, FolderPlus, FolderSymlink, GitBranch, Inbox, ListChecks, Minimize2, Package, PanelLeft, Plus, Rocket, RotateCcw, Settings, Shrink, Smartphone, Sparkles, Undo2, UserRound, Users, Zap } from "lucide-react";
import { snoozeOptions } from "../lib/attention";
import { confirmAction } from "../lib/confirm";
import { api, activeProfile } from "../lib/ipc";
import { useApp } from "../stores/app";
import { pickAttachFolder } from "./Chat";
import { pickRepo } from "./Sidebar";
import { AgentIcon, Avatar, StatusDot, TeammateDot } from "./ui";

export function Palette() {
  const workspaces = useApp((s) => s.workspaces);
  const repos = useApp((s) => s.repos);
  const skills = useApp((s) => s.skills);
  const profiles = useApp((s) => s.profiles);
  const teammates = useApp((s) => s.teammates);
  // "Ask a teammate" narrows the palette to teammates; the scope can come from the store (Ctrl Shift T) or the entry.
  const [scope, setScope] = useState(useApp.getState().paletteScope);
  const [search, setSearch] = useState("");
  const selectedId = useApp((s) => s.selectedId);
  const selected = workspaces.find((w) => w.id === selectedId);
  const currentProfile = selected && activeProfile(profiles, selected);
  const close = () => useApp.getState().setPaletteOpen(false);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const item =
    "flex h-9 cursor-default items-center gap-2.5 rounded-[3px] px-2.5 text-[12.5px] font-medium text-dim data-[selected=true]:bg-accent data-[selected=true]:text-accent-fg data-[selected=true]:[&_*]:text-accent-fg";
  const heading =
    "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-mute";

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-overlay pt-[14vh]" onMouseDown={close}>
      <Command
        loop
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="w-[560px] overflow-hidden rounded-[6px] border-[1.5px] border-line-strong bg-raised shadow-pop"
      >
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder={scope === "teammates" ? "Ask a teammate…" : "Jump to a workspace or run a command…"}
          className="h-12 w-full border-b-[1.5px] border-line-strong bg-transparent px-4 text-[15px] font-medium placeholder:text-mute focus:outline-none"
        />
        <Command.List className="max-h-[380px] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-[12px] text-mute">No results.</Command.Empty>
          {teammates.length > 0 && (
            <Command.Group heading="Teammates" className={heading}>
              {teammates.map((t) => (
                <Command.Item key={t.slug} value={`Ask ${t.name} (teammate) ${t.description}`} className={item} onSelect={run(() => useApp.getState().openTeammate(t.slug))}>
                  <Avatar avatar={t.avatar} name={t.name} size={18} className="border-transparent bg-transparent" />
                  <span className="shrink-0">Ask {t.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-mute">{t.description}</span>
                  <TeammateDot status={t.status} />
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {scope !== "teammates" && (
          <>
          <Command.Group heading="Actions" className={heading}>
            <Command.Item
              className={item}
              value="Ask a teammate… (hand off a task)"
              onSelect={() => {
                setScope("teammates");
                setSearch("");
              }}
            >
              <Users className="size-3.5" /> Ask a teammate…
            </Command.Item>
            <Command.Item className={item} value="New teammate" onSelect={run(() => useApp.getState().setTeammateEditor("new"))}>
              <Plus className="size-3.5" /> New teammate
            </Command.Item>
            <Command.Item className={item} onSelect={run(() => useApp.getState().setView("inbox"))}>
              <Inbox className="size-3.5" /> Open inbox
            </Command.Item>
            <Command.Item className={item} onSelect={run(() => useApp.getState().setView("issues"))}>
              <CircleDot className="size-3.5" /> Open issues
            </Command.Item>
            <Command.Item className={item} value="Routines (scheduled messages)" onSelect={run(() => useApp.getState().setView("routines"))}>
              <Clock className="size-3.5" /> Routines
            </Command.Item>
            <Command.Item className={item} value="New routine (schedule a message)" onSelect={run(() => useApp.getState().newRoutine())}>
              <Plus className="size-3.5" /> New routine
            </Command.Item>
            <Command.Item
              className={item}
              onSelect={run(() => {
                useApp.getState().setView("issues");
                useApp.getState().setTicketOpen(true);
              })}
            >
              <Plus className="size-3.5" /> New ticket
            </Command.Item>
            <Command.Item className={item} onSelect={run(() => useApp.getState().setNewWorkspaceOpen(true))}>
              <Plus className="size-3.5" /> New workspace
            </Command.Item>
            <Command.Item className={item} onSelect={run(() => void pickRepo())}>
              <FolderPlus className="size-3.5" /> Add repository
            </Command.Item>
            {selectedId && (
              <>
                <Command.Item
                  className={item}
                  value="Schedule message… (run the composer text later)"
                  onSelect={run(() => {
                    useApp.getState().select(selectedId);
                    useApp.getState().setScheduleOpen(true);
                  })}
                >
                  <CalendarClock className="size-3.5" /> Schedule message…
                </Command.Item>
                <Command.Item
                  className={item}
                  value="Snooze this workspace for 1 hour"
                  onSelect={run(() => void useApp.getState().snooze(selectedId, snoozeOptions()[0].until))}
                >
                  <AlarmClock className="size-3.5" /> Snooze this workspace for 1 hour
                </Command.Item>
                <Command.Item className={item} onSelect={run(() => void pickAttachFolder(selectedId))}>
                  <FolderSymlink className="size-3.5" /> Attach folder…
                </Command.Item>
                <Command.Item className={item} onSelect={run(() => useApp.getState().setRelatedOpen(true))}>
                  <Sparkles className="size-3.5" /> Find related projects
                </Command.Item>
                <Command.Item
                  className={item}
                  value="Compact context (summarise the conversation)"
                  onSelect={run(() => void useApp.getState().compactSession(selectedId))}
                >
                  <Minimize2 className="size-3.5" /> Compact context
                </Command.Item>
                <Command.Item
                  className={item}
                  value="Undo last turn (drop its save point)"
                  onSelect={run(() => {
                    void confirmAction("Undo the last turn? Its save-point commit and any edits since are discarded.", "Undo").then(
                      (ok) => void (ok && useApp.getState().undoLastTurn(selectedId)),
                    );
                  })}
                >
                  <Undo2 className="size-3.5" /> Undo last turn
                </Command.Item>
                <Command.Item
                  className={item}
                  value="Sync with base now (rebase onto the base branch)"
                  onSelect={run(() => void useApp.getState().syncNow(selectedId))}
                >
                  <GitBranch className="size-3.5" /> Sync with base now
                </Command.Item>
                <Command.Item
                  className={item}
                  value="Run checks"
                  onSelect={run(() => {
                    api.runChecks(selectedId).catch((e) => useApp.getState().setError(String(e)));
                  })}
                >
                  <ListChecks className="size-3.5" /> Run checks
                </Command.Item>
                <Command.Item
                  className={item}
                  value="Simplify changes (find and apply simplifications)"
                  onSelect={run(() => {
                    const s = useApp.getState();
                    s.setSimplifyOpen(true);
                    // An explicit command starts the read-only pass unless one is already underway or waiting.
                    api
                      .simplifyState(selectedId)
                      .then((st) => (st.phase === "idle" ? s.simplifyFind(selectedId) : undefined))
                      .catch((e) => s.setError(String(e)));
                  })}
                >
                  <Shrink className="size-3.5" /> Simplify changes
                </Command.Item>
                <Command.Item
                  className={item}
                  value="New session (clear context)"
                  onSelect={run(() => void useApp.getState().newSession(selectedId))}
                >
                  <RotateCcw className="size-3.5" /> New session
                </Command.Item>
              </>
            )}
            <Command.Item className={item} onSelect={run(() => useApp.getState().openSettings())}>
              <Settings className="size-3.5" /> Open settings
            </Command.Item>
            <Command.Item
              className={item}
              value="Pair a phone (Mobile settings)"
              onSelect={run(() => {
                useApp.getState().openSettings();
                // Settings mounts on the next frame; then bring the Mobile section into view.
                window.setTimeout(() => document.getElementById("settings-mobile")?.scrollIntoView({ block: "start" }), 120);
              })}
            >
              <Smartphone className="size-3.5" /> Pair a phone
            </Command.Item>
            <Command.Item
              className={item}
              value="Local models (Ollama, Models settings)"
              onSelect={run(() => {
                useApp.getState().openSettings();
                window.setTimeout(() => document.getElementById("settings-models")?.scrollIntoView({ block: "start" }), 120);
              })}
            >
              <Cpu className="size-3.5" /> Local models
            </Command.Item>
            <Command.Item className={item} onSelect={run(() => useApp.getState().setPacksOpen(true))}>
              <Package className="size-3.5" /> Manage skill packs
            </Command.Item>
            <Command.Item className={item} onSelect={run(() => useApp.getState().setShipOpen(!useApp.getState().shipOpen))}>
              <Rocket className="size-3.5" /> Toggle Ship panel
            </Command.Item>
            <Command.Item
              className={item}
              onSelect={run(() => useApp.getState().setSidebarCollapsed(!useApp.getState().sidebarCollapsed))}
            >
              <PanelLeft className="size-3.5" /> Toggle sidebar
            </Command.Item>
            <Command.Item className={item} onSelect={run(() => useApp.getState().setFocusMode(!useApp.getState().focusMode))}>
              <Focus className="size-3.5" /> Toggle focus mode
            </Command.Item>
          </Command.Group>
          {selectedId && !!currentProfile && profiles.length > 1 && (
            <Command.Group heading="Profile" className={heading}>
              {profiles
                .filter((p) => p.id !== currentProfile.id)
                .map((p) => (
                  <Command.Item
                    key={p.id}
                    value={`Switch profile: ${p.name} ${p.description}`}
                    className={item}
                    onSelect={run(() => void useApp.getState().setProfile(selectedId, p.id))}
                  >
                    <UserRound className="size-3.5 shrink-0" />
                    <span className="shrink-0">Switch profile: {p.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-mute">{p.description}</span>
                  </Command.Item>
                ))}
            </Command.Group>
          )}
          {selectedId && skills.length > 0 && (
            <Command.Group heading="Run skill in this workspace" className={heading}>
              {skills.map((s) => (
                <Command.Item
                  key={s.id}
                  value={`/${s.id} ${s.description}`}
                  className={item}
                  onSelect={run(() => void useApp.getState().runSkill(selectedId, s.id))}
                >
                  <Zap className="size-3.5 shrink-0 text-accent" />
                  <span className="shrink-0 text-[12px]">/{s.id}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-mute">{s.description}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {workspaces.length > 0 && (
            <Command.Group heading="Workspaces" className={heading}>
              {workspaces.map((w) => (
                <Command.Item
                  key={w.id}
                  value={`${w.name} ${w.branch} ${w.id}`}
                  className={item}
                  onSelect={run(() => useApp.getState().select(w.id))}
                >
                  <StatusDot status={w.status} />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  <span className=" text-[10.5px] text-mute">{repos.find((r) => r.id === w.repoId)?.name}</span>
                  <AgentIcon agent={w.agent} className="size-3" />
                </Command.Item>
              ))}
            </Command.Group>
          )}
          </>
          )}
        </Command.List>
      </Command>
    </div>
  );
}
