import { Command } from "cmdk";
import { AlarmClock, CircleDot, Focus, UserRound, FolderPlus, FolderSymlink, Inbox, Package, PanelLeft, Plus, Rocket, Settings, Sparkles, Zap } from "lucide-react";
import { snoozeOptions } from "../lib/attention";
import { activeProfile } from "../lib/ipc";
import { useApp } from "../stores/app";
import { pickAttachFolder } from "./Chat";
import { pickRepo } from "./Sidebar";
import { AgentIcon, StatusDot } from "./ui";

export function Palette() {
  const workspaces = useApp((s) => s.workspaces);
  const repos = useApp((s) => s.repos);
  const skills = useApp((s) => s.skills);
  const profiles = useApp((s) => s.profiles);
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
          placeholder="Jump to a workspace or run a command…"
          className="h-12 w-full border-b-[1.5px] border-line-strong bg-transparent px-4 text-[15px] font-medium placeholder:text-mute focus:outline-none"
        />
        <Command.List className="max-h-[380px] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-[12px] text-mute">No results.</Command.Empty>
          <Command.Group heading="Actions" className={heading}>
            <Command.Item className={item} onSelect={run(() => useApp.getState().setView("inbox"))}>
              <Inbox className="size-3.5" /> Open inbox
            </Command.Item>
            <Command.Item className={item} onSelect={run(() => useApp.getState().setView("issues"))}>
              <CircleDot className="size-3.5" /> Open issues
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
              </>
            )}
            <Command.Item className={item} onSelect={run(() => useApp.getState().openSettings())}>
              <Settings className="size-3.5" /> Open settings
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
        </Command.List>
      </Command>
    </div>
  );
}
