import { commands, executeCommand } from "../lib/keybindings";
import { useKeybindingLabels } from "../lib/useKeybinding";
import { isTauri } from "../lib/env";
import { useCode } from "../stores/code";
import { explorerAction, type ExplorerAction } from "./code/Explorer";
import { openPath } from "@tauri-apps/plugin-opener";
import { Command } from "cmdk";
import { useState } from "react";
import { SquareArrowOutUpRight, AlarmClock, Archive, CalendarClock, Check, Cpu, FolderPlus, FolderSymlink, GitBranch, GitMerge, History, ListChecks, Minimize2, Package, Paperclip, Plus, Rocket, RotateCcw, Shrink, Smartphone, Sparkles, Square, Trash2, Undo2, UserRound, Users, Zap } from "lucide-react";
import { AlarmClock, Archive, CalendarClock, Check, Cpu, FolderPlus, Gauge, FolderSymlink, GitBranch, GitMerge, History, ListChecks, Minimize2, Package, Paperclip, Plus, Rocket, RotateCcw, Shrink, Smartphone, Sparkles, Square, Trash2, Undo2, UserRound, Users, Zap } from "lucide-react";
import { AlarmClock, Archive, CalendarClock, Check, Cpu, FolderPlus, FolderSymlink, GitBranch, GitMerge, History, ListChecks, Minimize2, Package, Paperclip, Play, Plus, Rocket, RotateCcw, Shrink, Smartphone, Sparkles, Square, Trash2, Undo2, UserRound, Users, Zap } from "lucide-react";
import { AlarmClock, Archive, CalendarClock, Check, Cpu, FolderPlus, FolderSymlink, GitBranch, GitMerge, History, ListChecks, Minimize2, Package, Paperclip, Plug, Plus, Rocket, RotateCcw, Shrink, Smartphone, Sparkles, Square, Trash2, Undo2, UserRound, Users, Zap } from "lucide-react";
import { AlarmClock, Archive, CalendarClock, Check, Cpu, FolderPlus, FolderSymlink, GitBranch, GitMerge, History, ListChecks, Minimize2, Package, Paperclip, Plus, Rocket, RotateCcw, ScanSearch, Shrink, Smartphone, Sparkles, Square, Trash2, Undo2, UserRound, Users, Zap } from "lucide-react";
import { snoozeOptions } from "../lib/attention";
import { confirmAction } from "../lib/confirm";
import { openSelectedInEditor } from "../lib/openEditor";
import { api, activeProfile, workspacePackItems } from "../lib/ipc";
import { useApp } from "../stores/app";
import { startDevServer, stopDevServer } from "../stores/scripts";
import { pickAttachFolder, requestAttachImage } from "./Chat";
import { pickRepo } from "./Sidebar";
import { TeammateAvatar } from "./TeammateAvatar";
import { AgentIcon, StatusDot, TeammateDot } from "./ui";
export function Palette() {
  const keyLabel = useKeybindingLabels();
  const codeView = useApp((s) => s.view === "code");
  const codeRoot = useCode((s) => s.roots.find((r) => r.path === s.activeRoot));
  const codeRel = codeRoot?.activeRel;
  const codeBuffer = useCode((s) => codeRoot && codeRel ? s.buffers[`${codeRoot.path}|${codeRel}`] : undefined);
  const workspaces = useApp((s) => s.workspaces);
  const repos = useApp((s) => s.repos);
  const skills = useApp((s) => s.skills);
  const profiles = useApp((s) => s.profiles);
  const teammates = useApp((s) => s.teammates);
  // "Ask a teammate" narrows the palette to teammates; the scope can come from the store (openPalette("teammates")) or the entry.
  const [scope, setScope] = useState(useApp.getState().paletteScope);
  const [search, setSearch] = useState("");
  const selectedId = useApp((s) => s.selectedId);
  const selected = workspaces.find((w) => w.id === selectedId);
  const pr = useApp((s) => (selectedId ? s.prs[selectedId] : undefined));
  const currentProfile = selected && activeProfile(profiles, selected);
  const close = () => useApp.getState().setPaletteOpen(false);
  const openSettingsAt = (section: string) => {
    useApp.getState().openSettings();
    // Settings mounts (lazily) on a later frame; then bring the section into view.
    window.setTimeout(() => document.getElementById(`settings-${section}`)?.scrollIntoView({ block: "start" }), 250);
  };
  const prAct = (fn: () => Promise<unknown>) =>
    void fn()
      .catch((e) => useApp.getState().setError(String(e)))
      .finally(() => selectedId && void useApp.getState().refreshPr(selectedId));
  const openPr = pr && pr.state === "OPEN" ? pr : null;
  const canMerge = !!openPr && !openPr.isDraft && openPr.mergeable !== "CONFLICTING" && openPr.checks.failed === 0 && openPr.checks.pending === 0;
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
                  <TeammateAvatar avatar={t.avatar} name={t.name} size={20} />
                  <span className="shrink-0">Ask {t.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-mute">{t.description}</span>
                  <TeammateDot status={t.status} />
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {scope !== "teammates" && (
          <>
          <Command.Group heading="Commands" className={heading}>
            {commands.map((c) => <Command.Item key={c.id} value={`${c.title} ${c.id} Open ${c.title} Toggle ${c.title}`} className={item} onSelect={run(() => {
              // Restore the editor after the palette unmounts before invoking editor commands.
              window.setTimeout(() => executeCommand(c.id), 0);
            })}><span className="min-w-0 flex-1">{c.title}</span><span className="text-[11px] text-mute">{keyLabel(c.id)}</span></Command.Item>)}
          </Command.Group>
          <Command.Group heading="Code" className={heading}>
            {selected && (["Open this workspace in Code", "Watch the agent"] as const).map((title) => <Command.Item key={title} className={item} value={title} onSelect={run(() => { void useCode.getState().openRoot(selected.path, { workspaceId: selected.id }).then(() => { if (title === "Watch the agent") useCode.getState().setMode(useCode.getState().activeRoot!, "watch"); useApp.getState().setView("code"); }); })}>{title}</Command.Item>)}
            {codeView && <>
              {codeRoot && <>
                {([
                  ["Clear marks", () => useCode.getState().clearMarks()],
                ] as [string, () => void][]).map(([title, action]) => (
                  <Command.Item key={title} className={item} value={title} onSelect={run(action)}>{title}</Command.Item>
                ))}
                <Command.Item className={item} value="Close folder in Code" onSelect={run(() => { void useCode.getState().closeRoot(codeRoot.path); })}>Close folder in Code</Command.Item>
                {([["new-folder", "New folder"], ["rename", "Rename entry"], ["delete", "Delete entry"], ["copy-path", "Copy relative path"], ["reveal", "Reveal in Explorer"]] as [ExplorerAction, string][]).map(([action, title]) => <Command.Item key={action} className={item} value={title} onSelect={run(() => explorerAction(action))}>{title}</Command.Item>)}
              </>}
              {codeRoot && !isTauri() && <Command.Item className={item} value="Simulate agent edit (mock)" onSelect={run(() => window.dispatchEvent(new CustomEvent("orbit-simulate-agent-edit")))}>Simulate agent edit (mock)</Command.Item>}
              {codeRel && <>
                <Command.Item className={item} value="Pin preview tab" onSelect={run(() => useCode.getState().pin(codeRel))}>Pin preview tab</Command.Item>
                <Command.Item className={item} value="Reload file from disk" onSelect={run(() => { void useCode.getState().reloadFromDisk(codeRel, undefined, true); })}>Reload file from disk</Command.Item>
                <Command.Item className={item} value="Open file externally" onSelect={run(() => { void openPath(`${codeRoot!.path}/${codeRel}`).catch((e) => useApp.getState().setError(String(e))); })}>Open file externally</Command.Item>
                {codeBuffer?.dirty && codeBuffer.diskChanged && <Command.Item className={item} value="Keep mine (overwrite on next save)" onSelect={run(() => { void useCode.getState().keepMine(codeRel); })}>Keep mine (overwrite on next save)</Command.Item>}
              </>}
            </>}
          </Command.Group>
          <Command.Group heading="Actions" className={heading}>
            <Command.Item className={item} value="Refresh model lists" onSelect={run(() => { void useApp.getState().loadModels(true); })}>
              <Cpu className="size-3.5" /> Refresh model lists
            </Command.Item>
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
                <Command.Item
                  className={item}
                  value="Attach file… (image, PDF, text to the message)"
                  onSelect={run(() => {
                    useApp.getState().select(selectedId);
                    window.setTimeout(requestAttachImage, 50);
                  })}
                >
                  <Paperclip className="size-3.5" /> Attach file…
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
                    void confirmAction("Undo the last turn? Its save-point commit and any uncommitted edits since are discarded.", "Undo").then(
                      (ok) => void (ok && useApp.getState().undoLastTurn(selectedId)),
                    );
                  })}
                >
                  <Undo2 className="size-3.5" /> Undo last turn
                </Command.Item>
                <Command.Item
                  className={item}
                  value="Rewind to previous turn (restore code and conversation)"
                  onSelect={run(() => void useApp.getState().rewindOneTurn(selectedId))}
                >
                  <History className="size-3.5" /> Rewind to previous turn
                </Command.Item>
                <Command.Item
                  className={item}
                  value="Sync with base now (rebase onto the base branch)"
                  onSelect={run(() => void useApp.getState().syncNow(selectedId))}
                >
                  <GitBranch className="size-3.5" /> Sync with base now
                </Command.Item>
                <Command.Item className={item} value="Open in external editor (VS Code, Cursor, Zed)" onSelect={run(() => openSelectedInEditor())}>
                  <SquareArrowOutUpRight className="size-3.5" /> Open in external editor
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
                <Command.Item className={item} value="Run dev server (start the repo run script)" onSelect={run(() => void startDevServer(selectedId, useApp.getState().setError))}>
                  <Play className="size-3.5" /> Run dev server
                </Command.Item>
                <Command.Item className={item} value="Stop dev server" onSelect={run(() => stopDevServer(selectedId, useApp.getState().setError))}>
                  <Square className="size-3.5" /> Stop dev server
                </Command.Item>
                {openPr && (
                  <Command.Item
                    className={item}
                    value="Run AI review (read-only review of this branch)"
                    onSelect={run(() => {
                      const s = useApp.getState();
                      s.setShipOpen(true);
                      void s.runReview(selectedId);
                    })}
                  >
                    <ScanSearch className="size-3.5" /> Run AI review
                  </Command.Item>
                )}
                {selected?.status === "running" && (
                  <Command.Item className={item} value="Stop agent (interrupt the running turn)" onSelect={run(() => void useApp.getState().interrupt(selectedId))}>
                    <Square className="size-3.5" /> Stop agent
                  </Command.Item>
                )}
                {(pr === null || openPr) && (
                  <Command.Item className={item} value="Ship: commit, push, draft PR" onSelect={run(() => void useApp.getState().ship(selectedId))}>
                    <Rocket className="size-3.5" /> {pr === null ? "Ship: commit, push, draft PR" : "Ship: push updates"}
                  </Command.Item>
                )}
                {openPr && openPr.checks.failed > 0 && (
                  <Command.Item className={item} value="Fix CI (fix failing checks)" onSelect={run(() => void useApp.getState().runSkill(selectedId, "shipkit:fix-ci"))}>
                    <Rocket className="size-3.5" /> Fix CI
                  </Command.Item>
                )}
                {openPr && openPr.mergeable === "CONFLICTING" && (
                  <Command.Item className={item} value="Rebase (resolve conflicts with base)" onSelect={run(() => void useApp.getState().runSkill(selectedId, "shipkit:rebase"))}>
                    <GitBranch className="size-3.5" /> Rebase
                  </Command.Item>
                )}
                {openPr && (
                  <Command.Item className={item} value="Address comments (PR review comments)" onSelect={run(() => void useApp.getState().runSkill(selectedId, "shipkit:address-comments"))}>
                    <Rocket className="size-3.5" /> Address comments
                  </Command.Item>
                )}
                {openPr?.isDraft && (
                  <Command.Item className={item} value="Mark PR ready for review" onSelect={run(() => prAct(() => api.markPrReady(selectedId, openPr.number)))}>
                    <Check className="size-3.5" /> Mark PR ready for review
                  </Command.Item>
                )}
                {openPr && canMerge && (
                  <Command.Item
                    className={item}
                    value="Squash and merge PR"
                    onSelect={run(() => {
                      void confirmAction(`Squash-merge #${openPr.number} into the base branch?`, "Merge").then((ok) => {
                        if (!ok) return;
                        prAct(async () => {
                          const out = await api.mergePr(selectedId, openPr.number);
                          if (out?.archived) useApp.getState().removeWorkspace(selectedId);
                        });
                      });
                    })}
                  >
                    <GitMerge className="size-3.5" /> Squash & merge PR
                  </Command.Item>
                )}
                <Command.Item
                  className={item}
                  value="Archive workspace (delete its worktree)"
                  onSelect={run(() => void useApp.getState().archiveWorkspace(selectedId))}
                >
                  <Archive className="size-3.5" /> Archive workspace…
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
            <Command.Item className={item} value="Show plan limits usage 5-hour weekly" onSelect={run(() => useApp.getState().openSettingsAt("usage"))}>
              <Gauge className="size-3.5" /> Show plan limits
            <Command.Item className={item} value="Open MCP servers" onSelect={run(() => openSettingsAt("mcp"))}>
              <Plug className="size-3.5" /> Open MCP servers
            </Command.Item>
            <Command.Item className={item} value="Archived workspaces (restore)" onSelect={run(() => openSettingsAt("data"))}>
              <History className="size-3.5" /> Archived workspaces
            </Command.Item>
            <Command.Item className={item} value="Clean up merged worktrees" onSelect={run(() => openSettingsAt("data"))}>
              <Trash2 className="size-3.5" /> Clean up merged worktrees
            </Command.Item>
            <Command.Item className={item} onSelect={run(() => useApp.getState().setPacksOpen(true))}>
              <Package className="size-3.5" /> Manage skill packs
            </Command.Item>
            {selected && (
              <Command.Item className={item} onSelect={run(() => useApp.getState().setPacksOpen(true))}>
                <Package className="size-3.5" /> Skill packs for this workspace
              </Command.Item>
            )}
          </Command.Group>
          {selectedId && workspacePackItems(profiles, selected).length > 0 && (
            <Command.Group heading="Profile" className={heading}>
              {workspacePackItems(profiles, selected)
                .filter((p) => p.id !== currentProfile?.id)
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
              {workspacePackItems(skills, selected).map((s) => (
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
