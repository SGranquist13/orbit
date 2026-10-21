import { useKeybindingLabels } from "../lib/useKeybinding";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  Code2,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDot,
  FilePen,
  FileText,
  ImagePlus,
  Image as ImageIcon,
  Folder,
  GitBranch,
  History,
  Globe,
  LoaderCircle,
  Lock,
  PenLine,
  Plus,
  Rocket,
  Search,
  Shrink,
  Sparkles,
  Square,
  SquareArrowOutUpRight,
  ChevronDown,
  SquareTerminal,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Fragment, Suspense, lazy, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const MarkdownText = lazy(() => import("./MarkdownText"));
import { defaultSchedule, describeShort, textToAction } from "../lib/routines";
import { MAX_FILE_BYTES, formatSize, isImageFile, prepareImage, toDataUrl } from "../lib/images";
import { FileChip, FileRow, ImageRow } from "./ChatImage";
import { activeProfile, api, workspacePackItems, type Attachment, type EditorInfo, type FileRef, type ImageRef, type Schedule, type PrStatus, type Related, type Skill, type Workspace } from "../lib/ipc";
import { fold, formatCost, formatDuration, formatTokens, toolSummary, type Block, type ToolCallView } from "../lib/transcript";
import { editorLabel } from "../lib/openEditor";
import { useCode } from "../stores/code";
import { useApp } from "../stores/app";
import { ContextMeter } from "./ContextMeter";
import { LimitsBadge } from "./LimitsBadge";
import { discardReview, sendReview, useReviewComments } from "../stores/review";
import { SchedulePreview, WhenControl } from "./ScheduleControls";
import { TeammateLabel } from "./TeammateAvatar";
import { RunButton, SetupRow } from "./WorktreeScripts";
import { AgentIcon, Button, Kbd, StatusDot, agentLabel, cn } from "./ui";

export function Chat({ ws }: { ws: Workspace }) {
  const keyLabel = useKeybindingLabels();
  const events = useApp((s) => s.transcripts[ws.id]);
  const live = useApp((s) => s.live[ws.id] ?? "");
  const blocks = useMemo(() => fold(events ?? []), [events]);
  const running = ws.status === "running";
  const focusMode = useApp((s) => s.focusMode);

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col bg-bg"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (files.length === 0) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("orbit-attach-files", { detail: { workspaceId: ws.id, files } }));
      }}
    >
      <header className="relative flex h-12 shrink-0 items-center gap-3 overflow-hidden px-6" data-tauri-drag-region>
        <StatusDot status={ws.status} />
        <h1 className="truncate text-[15px] font-semibold tracking-[-0.02em]">{ws.name}</h1>
        <span className="flex items-center gap-1 truncate rounded-[3px] border border-line px-1.5 py-px text-[10.5px] font-medium text-mute">
          <GitBranch className="size-3" strokeWidth={2.5} />
          {ws.branch}
        </span>
        {ws.teammate && <TeammateLabel slug={ws.teammate} className="rounded-[3px] border border-line px-1.5 py-px" />}
        {ws.issueNumber != null && (
          <button
            onClick={() =>
              api
                .issueUrl(ws.id)
                .then((url) => openUrl(url))
                .catch((e) => useApp.getState().setError(String(e)))
            }
            title="Open the linked issue on GitHub"
            className="relative flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-px text-[10.5px] font-medium tabular-nums text-mute hover:text-fg"
          >
            <CircleDot className="size-3" strokeWidth={2.5} />#{ws.issueNumber}
          </button>
        )}
        {running && <span className="dither-sweep bg-run opacity-[0.14]" />}
        <AttachmentBar ws={ws} />
        <span className="flex-1" />
        <RunButton ws={ws} />
        <Button title={"Open in Code" + (keyLabel("views.code") ? ` (${keyLabel("views.code")})` : "")} className="relative shrink-0 px-1.5" onClick={() => void useCode.getState().openRoot(ws.path, { workspaceId: ws.id }).then(() => useApp.getState().setView("code"))}><Code2 className="size-3.5" /></Button>
        <EditorButton ws={ws} />
        {focusMode ? (
          <Button onClick={() => useApp.getState().setFocusMode(false)} className="relative shrink-0">
            Exit focus {keyLabel("workbench.focusMode") && <Kbd>{keyLabel("workbench.focusMode")}</Kbd>}
          </Button>
        ) : (
          <>
            <SimplifyButton ws={ws} />
            <ShipButton ws={ws} />
          </>
        )}
      </header>
      <div className="border-t-[1.5px] border-line" />
      <RelatedPopover ws={ws} />

      <PlanCard wsId={ws.id} running={running} />
      <Transcript blocks={blocks} live={live} running={running} loading={!events} wsId={ws.id} />
      <Composer ws={ws} running={running} />
    </div>
  );
}

/** Native folder picker, then attaches the folder to the workspace. */
export async function pickAttachFolder(workspaceId: string) {
  const path = await open({ directory: true, title: "Attach a project folder" });
  if (typeof path !== "string") return;
  await useApp.getState().attachFolder(workspaceId, path);
}

const chipBase = "flex h-5 shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 text-[10.5px] font-medium text-mute";

/** Attached folders as quiet chips after the branch pill; overflow scrolls sideways instead of wrapping the header. */
function AttachmentBar({ ws }: { ws: Workspace }) {
  const attachments = useApp((s) => s.attachments[ws.id]) ?? [];
  const suggestions = useApp((s) => s.related[ws.id]) ?? [];
  return (
    <div className="relative flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
      {attachments.map((a) => (
        <AttachmentChip key={a.id} ws={ws} a={a} />
      ))}
      <button
        onClick={() => void pickAttachFolder(ws.id)}
        title="Attach another project folder so the agent can read it"
        className="flex h-5 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-[10.5px] font-medium text-mute hover:bg-hover hover:text-fg"
      >
        <Plus className="size-3" strokeWidth={2.5} /> Attach
      </button>
      {suggestions.length > 0 && (
        <button
          onClick={() => useApp.getState().setRelatedOpen(!useApp.getState().relatedOpen)}
          title="Projects that use, or are used by, this repository"
          className="flex h-5 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-[10.5px] font-medium text-mute hover:bg-hover hover:text-fg"
        >
          <Sparkles className="size-3" /> {suggestions.length} related
        </button>
      )}
    </div>
  );
}

function AttachmentChip({ ws, a }: { ws: Workspace; a: Attachment }) {
  const tip = a.editable && a.worktreePath ? `${a.path}\nEditable worktree: ${a.worktreePath}\nBranch: ${a.branch}` : `${a.path}\nRead-only`;
  const Icon = a.editable ? PenLine : Lock;
  return (
    <span className={chipBase} title={tip}>
      <button onClick={() => useApp.getState().setRelatedOpen(true)} className="flex items-center gap-1 hover:text-fg">
        <Folder className="size-3" strokeWidth={2.5} />
        {a.name}
      </button>
      <button
        onClick={() => void useApp.getState().setAttachmentEditable(ws.id, a.id, !a.editable)}
        title={a.editable ? "Editable: click to make read-only (keeps its worktree)" : "Read-only: click to let the agent edit it in a separate worktree"}
        className={cn("grid size-4 place-items-center rounded-[3px] hover:bg-hover", a.editable ? "text-fg" : "text-mute")}
      >
        <Icon className="size-3" />
      </button>
      <button
        onClick={() => void useApp.getState().detachFolder(ws.id, a.id)}
        title="Detach folder"
        className="grid size-4 place-items-center rounded-[3px] hover:bg-hover hover:text-fg"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

const relationLabel: Record<Related["relation"], string> = { dependent: "uses this", dependency: "used by this" };

/** Suggestions from discovery plus "always attach" toggles for what is attached. */
function RelatedPopover({ ws }: { ws: Workspace }) {
  const open = useApp((s) => s.relatedOpen);
  const suggestions = useApp((s) => s.related[ws.id]) ?? [];
  const attachments = useApp((s) => s.attachments[ws.id]) ?? [];
  const defaults = useApp((s) => s.relatedDefaults[ws.repoId]) ?? [];
  const repoName = useApp((s) => s.repos.find((r) => r.id === ws.repoId)?.name ?? "this repo");
  const close = () => useApp.getState().setRelatedOpen(false);

  useEffect(() => {
    if (!open) return;
    void useApp.getState().refreshRelated(ws.id);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, ws.id]);

  if (!open) return null;
  const store = useApp.getState();
  return (
    <>
      <div className="fixed inset-0 z-20" onMouseDown={close} />
      <div className="absolute left-6 top-[52px] z-30 w-[420px] max-w-[calc(100%-3rem)] rounded-[6px] border-[1.5px] border-line-strong bg-raised p-1.5 shadow-hard">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="label flex-1 text-mute">Related projects</span>
          {suggestions.length > 1 && (
            <Button
              onClick={() => {
                for (const r of suggestions) void store.attachFolder(ws.id, r.path);
              }}
              className="h-6"
            >
              Attach all
            </Button>
          )}
        </div>
        {suggestions.length === 0 && <p className="px-2 pb-2 text-[12px] text-mute">No unattached related projects found.</p>}
        <ul>
          {suggestions.map((r) => (
            <li key={r.path} className="flex items-center gap-3 rounded-[3px] px-2 py-1.5 hover:bg-hover">
              <div className="min-w-0 flex-1" title={r.path}>
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[12.5px] font-medium text-fg">{r.name}</span>
                  <span className="shrink-0 text-[11px] text-dim">{relationLabel[r.relation]}</span>
                </div>
                <div className="truncate text-[11px] text-mute">{r.evidence}</div>
              </div>
              <Button onClick={() => void store.attachFolder(ws.id, r.path)} className="h-6 shrink-0">
                Attach
              </Button>
            </li>
          ))}
        </ul>
        {attachments.length > 0 && (
          <>
            <div className="dither-rule my-1.5 bg-line-strong" />
            <div className="label px-2 py-1 text-mute">Always attach for {repoName}</div>
            <ul>
              {attachments.map((a) => {
                const on = defaults.includes(a.path);
                return (
                  <li key={a.id}>
                    <button
                      onClick={() => void store.setRelatedDefault(ws.repoId, a.path, !on)}
                      title={a.path}
                      className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left hover:bg-hover"
                    >
                      <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-[3px] border-[1.5px] border-line-strong", on && "bg-accent text-accent-fg")}>
                        {on && <Check className="size-2.5" strokeWidth={3.5} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-dim">{a.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

/** Header toggle for the Simplify panel; a quiet dither sweep while the pass is working. */
function SimplifyButton({ ws }: { ws: Workspace }) {
  const open = useApp((s) => s.simplifyOpen);
  const phase = useApp((s) => s.simplify[ws.id]?.phase);
  const working = phase === "finding" || phase === "applying";
  return (
    <Button
      onClick={() => useApp.getState().setSimplifyOpen(!open)}
      title="Find and apply simplifications in this workspace's changes"
      className={cn("relative shrink-0 overflow-hidden", open && "bg-raised text-fg")}
    >
      {working && <span className="dither-sweep bg-run opacity-[0.14]" />}
      <Shrink className="size-3.5" /> Simplify
    </Button>
  );
}

/** Header toggle for the Ship panel, with a quiet hint of what is in it (PR + checks, or changed files). */
function ShipButton({ ws }: { ws: Workspace }) {
  const keyLabel = useKeybindingLabels();
  const open = useApp((s) => s.shipOpen);
  const pr = useApp((s) => s.prs[ws.id]);
  const fileCount = useApp((s) => s.changes[ws.id]?.length ?? 0);
  return (
    <Button
      onClick={() => useApp.getState().setShipOpen(!open)}
      title={"Toggle Ship panel" + (keyLabel("workbench.toggleShip") ? ` (${keyLabel("workbench.toggleShip")})` : "")}
      className={cn("relative shrink-0", open && "bg-raised text-fg")}
    >
      <Rocket className="size-3.5" /> Ship
      {pr ? (
        <PrHint pr={pr} />
      ) : (
        fileCount > 0 && (
          <span className="tabular-nums text-mute">
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </span>
        )
      )}
    </Button>
  );
}

function PrHint({ pr }: { pr: PrStatus }) {
  const { passed, failed, pending } = pr.checks;
  const merged = pr.state === "MERGED";
  const dot = failed > 0 ? "bg-bad" : pending > 0 ? "bg-run" : passed > 0 ? "bg-ok" : null;
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("tabular-nums", merged ? "text-merged" : "text-mute")}>#{pr.number}</span>
      {dot && !merged && <span className={cn("size-1.5", dot)} />}
    </span>
  );
}

/** Asks the open chat's composer to show its image picker (palette entry). */
export function requestAttachImage() {
  window.dispatchEvent(new CustomEvent("orbit-attach-image"));
}

function Transcript({ blocks, live, running, loading, wsId }: { blocks: Block[]; live: string; running: boolean; loading: boolean; wsId: string }) {
  const loadError = useApp((s) => s.transcriptErrors[wsId]);
  const rewound = useApp((s) => s.rewound[wsId]);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the stream only while the user is already at the bottom.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks, live, running]);

  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const lastTools = blocks.findLastIndex((b) => b.kind === "tools");
  const awaitingAgent = running && !live && blocks[blocks.length - 1]?.kind === "user";

  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[880px] space-y-5 px-6 py-8">
        <SetupRow wsId={wsId} />
        {loading && loadError && (
          <div className="flex items-start gap-3 rounded-[4px] border-[1.5px] border-bad px-3.5 py-2.5">
            <p className="selectable flex-1 whitespace-pre-wrap text-[12px] font-medium text-bad">Couldn't load this conversation: {loadError}</p>
            <Button onClick={() => void useApp.getState().loadTranscript(wsId)}>Retry</Button>
          </div>
        )}
        {!loading && blocks.length === 0 && (
          <div className="space-y-1 pt-24 text-center">
            <p className="label text-mute">Give the agent a task to get started</p>
            <p className="text-[12px] text-mute">Attach folders or switch profile first if you need to; nothing runs until you send.</p>
          </div>
        )}
        {blocks.map((b, i) => (
          <Fragment key={b.key}>
            <BlockView block={b} wsId={wsId} active={running && i === lastTools && i === blocks.length - 1} />
            {rewound && b.key === String(rewound.seq) && (
              <div data-rewind-divider className="flex items-center gap-3 text-[11px] font-medium text-mute">
                <span className="dither-rule flex-1 bg-line-strong" />
                <span>Rewound to turn {rewound.turn}</span>
                <span className="dither-rule flex-1 bg-line-strong" />
              </div>
            )}
          </Fragment>
        ))}
        {live && (
          <div className="prose-chat streaming-caret selectable whitespace-pre-wrap text-fg">{live}</div>
        )}
        {awaitingAgent && (
          <div className="flex items-center gap-3">
            <span className="dither-march h-2.5 w-14 bg-run" />
            <span className="label text-mute">Thinking</span>
          </div>
        )}
      </div>
    </div>
  );
}

const BlockView = memo(function BlockView({ block, active, wsId }: { block: Block; active: boolean; wsId: string }) {
  switch (block.kind) {
    case "user":
      return (
        <div className="group/user flex items-start justify-end gap-1.5">
          {block.rewindSeq !== undefined && <RewindActions wsId={wsId} seq={block.rewindSeq} />}
          <div data-user-message className="selectable max-w-[80%] whitespace-pre-wrap rounded-[16px] rounded-br-[5px] border border-line bg-hover px-4 py-2.5 text-[14px] leading-relaxed text-fg">
            {block.skill && (
              <span className="mr-1.5 inline-flex items-center gap-1 rounded-[6px] border border-line-strong/60 bg-raised px-1.5 py-px align-[1px] text-[11.5px] font-medium text-dim">
                <Zap className="size-3" />/{block.skill}
              </span>
            )}
            {block.images && block.images.length > 0 && <ImageRow workspaceId={wsId} images={block.images} className={cn("justify-end", (block.text || block.files?.length) && "mb-2")} />}
            {block.files && block.files.length > 0 && <FileRow files={block.files} className={cn("justify-end", block.text && "mb-2")} />}
            {block.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="prose-chat text-fg">
          <Suspense fallback={<span className="whitespace-pre-wrap">{block.text}</span>}>
            <MarkdownText text={block.text} workspaceId={wsId} />
          </Suspense>
        </div>
      );
    case "tools":
      return <ToolGroup calls={block.calls} active={active} wsId={wsId} />;
    case "turnEnd":
      return (
        <div className="flex items-center gap-3 text-[11px] font-medium tabular-nums text-mute">
          {block.interrupted ? (
            <span className="flex items-center gap-1.5 text-mute">
              <Square className="size-2.5 fill-current" /> Interrupted
            </span>
          ) : block.error ? (
            <span className="selectable flex items-start gap-1.5 text-bad">
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              {block.error}
            </span>
          ) : (
            <>
              {block.durationMs !== null && <span>{formatDuration(block.durationMs)}</span>}
              {block.tokens !== null && <span>{formatTokens(block.tokens)} tok</span>}
              {block.costUsd !== null && <span>{formatCost(block.costUsd)}</span>}
            </>
          )}
          <span className="dither-rule flex-1 bg-line-strong" />
        </div>
      );
    case "plan":
      return (
        <div className="text-[11px] font-medium tabular-nums text-mute">
          Updated plan ({block.done}/{block.total})
        </div>
      );
    case "sessionReset":
      return (
        <div className="flex items-center gap-3 text-[11px] font-medium text-mute">
          <span className="dither-rule flex-1 bg-line-strong" />
          <span>New session, context cleared</span>
          <span className="dither-rule flex-1 bg-line-strong" />
        </div>
      );
    case "error":
      return (
        <div className="selectable flex items-start gap-2 whitespace-pre-wrap rounded-[4px] border-[1.5px] border-bad bg-bad/10 px-3 py-2 text-[11.5px] font-medium text-bad">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          {block.message}
        </div>
      );
  }
});

/** The agent's own plan, pinned above the transcript while the turn or session has one. */
function PlanCard({ wsId, running }: { wsId: string; running: boolean }) {
  const plan = useApp((s) => s.plans[wsId]);
  const key = `orbit.planCollapsed.${wsId}`;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  useEffect(() => {
    useApp.getState().ensurePlan(wsId);
  }, [wsId, running]);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(key) === "1"); } catch { setCollapsed(false); }
  }, [wsId, key]);
  if (!plan || plan.items.length === 0) return null;
  const done = plan.items.filter((i) => i.status === "done").length;
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem(key, collapsed ? "0" : "1"); } catch { /* storage unavailable */ }
  };
  return (
    <div data-testid="plan-card" className="shrink-0 border-b-[1.5px] border-line bg-panel px-6 py-2">
      <button onClick={toggle} aria-expanded={!collapsed} className="flex w-full items-center gap-1.5 text-[11px] font-medium tabular-nums text-mute hover:text-fg">
        <ChevronRight className={cn("size-3 transition-transform", !collapsed && "rotate-90")} strokeWidth={2.5} />
        <span>Plan · {done}/{plan.items.length}</span>
      </button>
      {!collapsed && (
        <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
          {plan.items.map((item, i) => (
            <li key={i} className="relative flex items-start gap-2 overflow-hidden text-[12px] leading-5">
              {item.status === "inProgress" && running && <span className="dither-sweep bg-run opacity-20" />}
              <span className="relative mt-[3px] flex size-3.5 shrink-0 items-center justify-center">
                {item.status === "done" ? (
                  <Check className="size-3.5 text-ok" strokeWidth={2.5} />
                ) : item.status === "inProgress" ? (
                  <span className="size-2 bg-run" />
                ) : (
                  <span className="size-2 rounded-full border-[1.5px] border-line-strong" />
                )}
              </span>
              <span className={cn("relative min-w-0", item.status === "done" ? "text-mute line-through" : item.status === "inProgress" ? "text-fg" : "text-dim")}>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Hover actions on one of your messages: restore code and conversation to just before it, or branch from there. */
function RewindActions({ wsId, seq }: { wsId: string; seq: number }) {
  const busy = useApp((s) => s.workspaces.find((w) => w.id === wsId)?.status === "running");
  const btn = "grid size-6 place-items-center rounded-[4px] text-mute hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40";
  return (
    <div className="mt-2 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/user:opacity-100">
      <button type="button" data-rewind-here title={busy ? "Stop the agent to rewind" : "Rewind to here"} aria-label="Rewind to here" disabled={busy} className={btn} onClick={() => void useApp.getState().rewindTo(wsId, seq)}>
        <History className="size-3.5" />
      </button>
      <button type="button" data-branch-here title="Branch from here" aria-label="Branch from here" className={btn} onClick={() => void useApp.getState().branchFromTurn(wsId, seq)}>
        <GitBranch className="size-3.5" />
      </button>
    </div>
  );
}

function ToolGroup({ calls, active, wsId }: { calls: ToolCallView[]; active: boolean; wsId: string }) {
  const [open, setOpen] = useState(false);
  const last = calls[calls.length - 1];
  const failed = calls.filter((c) => c.isError).length;
  const images = calls.flatMap((c) => c.images ?? []);
  return (
    <div className="text-[12.5px]">
      <button onClick={() => setOpen((o) => !o)} className="group flex max-w-full items-center gap-2 text-mute hover:text-fg">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} strokeWidth={2.75} />
        <span className="label shrink-0">
          {calls.length} tool call{calls.length === 1 ? "" : "s"}
        </span>
        {failed > 0 && <span className="label shrink-0 text-bad">· {failed} failed</span>}
        {active && !open && (
          <span className="flex min-w-0 items-center gap-2 truncate font-mono text-[11px] text-dim">
            <span className="dither-march h-2 w-6 shrink-0 bg-run" />
            {last.name} {toolSummary(last.name, last.input)}
          </span>
        )}
      </button>
      {!open && images.length > 0 && <ImageRow workspaceId={wsId} images={images} className="mt-2 pl-5" />}
      {open && (
        <ul className="relative mt-2 space-y-px pl-3.5">
          <span className="dither-50 absolute inset-y-0 left-0 w-0.5 bg-line-strong" />
          {calls.map((c) => (
            <ToolRow key={c.id} call={c} wsId={wsId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function toolIcon(name: string) {
  if (name === "Bash") return SquareTerminal;
  if (name === "Read") return FileText;
  if (name === "ViewImage") return ImageIcon;
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return FilePen;
  if (name === "Grep" || name === "Glob") return Search;
  if (name.startsWith("Web")) return Globe;
  return Wrench;
}

function ToolRow({ call, wsId }: { call: ToolCallView; wsId: string }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(call.name);
  const summary = toolSummary(call.name, call.input);
  const pending = call.output === undefined;
  return (
    <li>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-hover"
      >
        <Icon className="size-3.5 shrink-0 text-mute" />
        <span className="shrink-0 font-medium text-dim">{call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mute">{summary}</span>
        {pending ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-mute" />
        ) : call.isError ? (
          <X className="size-3 shrink-0 text-bad" />
        ) : (
          <Check className="size-3 shrink-0 text-ok/70" />
        )}
      </button>
      {open && call.images && call.images.length > 0 && <ImageRow workspaceId={wsId} images={call.images} className="mb-1.5 ml-6 mt-1" />}
      {open && (call.output || !call.images?.length) && (
        <pre className="selectable mb-1.5 ml-6 mt-1 max-h-72 overflow-auto rounded-md border border-line bg-panel p-2.5 font-mono text-[11px] leading-relaxed text-dim">
          {call.output || JSON.stringify(call.input, null, 2)}
        </pre>
      )}
    </li>
  );
}

/** Ranks skills for `/` autocomplete: id prefix, name prefix, id substring, description substring. */
function rankSkills(skills: Skill[], q: string) {
  const query = q.toLowerCase();
  const score = (s: Skill) => {
    const id = s.id.toLowerCase();
    if (id.startsWith(query)) return 0;
    if (s.name.toLowerCase().startsWith(query)) return 1;
    if (id.includes(query)) return 2;
    if (s.description.toLowerCase().includes(query)) return 3;
    return -1;
  };
  return skills
    .map((s) => [score(s), s] as const)
    .filter(([n]) => n >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].id.localeCompare(b[1].id))
    .map(([, s]) => s);
}

/** `/shipkit:ship` or, when unambiguous, `/ship`. */
function resolveSkill(skills: Skill[], token: string) {
  const exact = skills.find((s) => s.id === token);
  if (exact) return exact;
  const byName = skills.filter((s) => s.name === token);
  return byName.length === 1 ? byName[0] : undefined;
}

function SkillChips({ ws, text, onRun }: { ws: Workspace; text: string; onRun: () => void }) {
  const skills = useApp((s) => s.skills);
  const pins = useApp((s) => s.pins);
  const profiles = useApp((s) => s.profiles);
  const [preview, setPreview] = useState<Skill | null>(null);
  // A profile with its own skills replaces the global pins.
  const own = activeProfile(profiles, ws)?.skills ?? [];
  const pinned = workspacePackItems((own.length > 0 ? own : pins).map((id) => skills.find((s) => s.id === id)).filter((s): s is Skill => !!s), ws);
  const args = text.trim();
  const run = (s: Skill) => {
    setPreview(null);
    void useApp.getState().runSkill(ws.id, s.id, text);
    onRun();
  };
  return (
    <div className="relative mx-auto mb-2.5 max-w-[880px]" onKeyDown={(e) => e.key === "Escape" && setPreview(null)}>
      {preview && (
        <>
          <div className="fixed inset-0 z-10" onMouseDown={() => setPreview(null)} />
          <div className="absolute bottom-full left-0 z-20 mb-2 w-[420px] max-w-full space-y-2.5 rounded-[6px] border-[1.5px] border-line-strong bg-raised p-3.5 shadow-hard" data-skill-preview={preview.id}>
            <div className="flex items-center gap-2">
              <Zap className="size-3.5 text-accent" strokeWidth={2.75} />
              <span className="text-[13px] font-semibold">{preview.name}</span>
              <span className="text-[11px] uppercase text-mute/70">{preview.kind}</span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-dim">{preview.description || "No description."}</p>
            <div>
              <div className="label mb-1 text-mute">Will send to {agentLabel[ws.agent]}</div>
              <code className="selectable block whitespace-pre-wrap break-words rounded-[4px] border border-line bg-bg px-2.5 py-2 text-[12px] leading-relaxed">
                /{preview.id}
                {args ? ` ${args}` : ""}
              </code>
              {!args && preview.argumentHint && <p className="mt-1 text-[11.5px] text-mute">Optional input: {preview.argumentHint}. Type it in the box below first to include it.</p>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => run(preview)}>
                <Zap className="size-3.5" /> Run in this workspace
              </Button>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="label mr-0.5 text-mute">Skills</span>
        {pinned.map((s) => (
          <button
            key={s.id}
            title={`${s.description}

Click to preview what it will do before it runs.`}
            onClick={() => setPreview(preview?.id === s.id ? null : s)}
            aria-expanded={preview?.id === s.id}
            className={cn(
              "group flex h-6 items-center gap-1.5 rounded-[3px] border-[1.5px] px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors hover:border-accent hover:bg-accent hover:text-accent-fg",
              preview?.id === s.id ? "border-accent bg-accent text-accent-fg" : "border-line-strong text-dim",
            )}
          >
            <Zap className={cn("size-3 group-hover:text-accent-fg", preview?.id === s.id ? "text-accent-fg" : "text-accent")} strokeWidth={2.75} />
            {s.name}
          </button>
        ))}
        <button
          onClick={() => useApp.getState().setPacksOpen(true)}
          title="Add or manage skill shortcuts"
          aria-label="Add or manage skill shortcuts"
          className="grid size-6 place-items-center rounded-[3px] text-mute hover:bg-hover hover:text-fg"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Footer label for the workspace's role; click to switch it. */
function ProfileMenu({ ws, running }: { ws: Workspace; running: boolean }) {
  const profiles = useApp((s) => s.profiles);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const current = activeProfile(profiles, ws);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (workspacePackItems(profiles, ws).length === 0) return null;
  return (
    <span ref={ref} className="relative flex items-center gap-1.5">
      <span className="text-mute">·</span>
      <button
        data-profile-trigger
        onClick={() => setOpen((o) => !o)}
        title={`${current?.description ?? "No role set"}\n\nSwitch profile`}
        className="flex items-center gap-1 rounded-[3px] px-1 text-dim hover:bg-hover hover:text-fg"
      >
        {current?.readonly && <Lock className="size-3" />}
        {current?.name ?? "No role"}
      </button>
      {open && (
        <ul className="absolute bottom-full left-0 z-20 mb-2 w-[320px] overflow-hidden rounded-[6px] border-[1.5px] border-line-strong bg-raised p-1 shadow-hard">
          {current && (
            <li>
              <button
                data-profile=""
                disabled={running}
                onClick={() => {
                  setOpen(false);
                  void useApp.getState().setProfile(ws.id, null);
                }}
                className="flex w-full flex-col rounded-[3px] px-2.5 py-1.5 text-left hover:bg-hover disabled:opacity-40"
              >
                <span className="text-[12px] font-medium text-fg">No role</span>
                <span className="truncate text-[11px] font-normal text-mute">Remove the role instructions</span>
              </button>
            </li>
          )}
          {workspacePackItems(profiles, ws).map((p) => (
            <li key={p.id}>
              <button
                data-profile={p.id}
                disabled={running}
                title={running ? "Wait for the current turn to finish" : undefined}
                onClick={() => {
                  setOpen(false);
                  if (p.id !== current?.id) void useApp.getState().setProfile(ws.id, p.id);
                }}
                className={cn(
                  "flex w-full flex-col rounded-[3px] px-2.5 py-1.5 text-left hover:bg-hover disabled:opacity-40",
                  p.id === current?.id && "bg-hover",
                )}
              >
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
                  {p.name}
                  {p.readonly && <Lock className="size-3 text-mute" />}
                </span>
                <span className="truncate text-[11px] font-normal text-mute">{p.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

/** Clock button + popover: turns the composer text into a routine bound to this workspace. */
function ScheduleButton({ ws, text, onScheduled }: { ws: Workspace; text: string; onScheduled: (when: string) => void }) {
  const open = useApp((s) => s.scheduleOpen);
  const skills = useApp((s) => s.skills);
  const [schedule, setSchedule] = useState<Schedule>(() => defaultSchedule("once"));
  const [busy, setBusy] = useState(false);
  const close = () => useApp.getState().setScheduleOpen(false);

  const confirm = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await api.saveRoutine({
        repoId: ws.repoId,
        name: "",
        schedule,
        action: textToAction(text, skills),
        agent: ws.agent,
        model: ws.model,
        profile: ws.profile,
        mode: "standing",
        standingWorkspaceId: ws.id,
        enabled: true,
      });
      void useApp.getState().refreshRoutines();
      close();
      onScheduled(describeShort(schedule));
    } catch (e) {
      useApp.getState().setError(String(e).replace(/^Error:\s*/, ""));
    }
    setBusy(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => useApp.getState().setScheduleOpen(!open)}
        title="Schedule this message"
        aria-label="Schedule this message"
        aria-expanded={open}
        className={cn(
          "grid size-8 place-items-center rounded-[4px] border-[1.5px] text-dim transition-colors hover:bg-hover hover:text-fg",
          open ? "border-fg text-fg" : "border-line-strong",
        )}
      >
        <CalendarClock className="size-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onMouseDown={close} />
          <div
            className="absolute bottom-full right-0 z-20 mb-2 w-[420px] space-y-3 rounded-[6px] border-[1.5px] border-line-strong bg-raised p-3.5 shadow-hard"
            onKeyDown={(e) => e.key === "Escape" && close()}
          >
            <div className="text-[12.5px] font-medium">Send this message later</div>
            <WhenControl schedule={schedule} onChange={setSchedule} />
            <SchedulePreview schedule={schedule} />
            <p className="text-[11.5px] leading-relaxed text-mute">
              {text.trim() ? "It will run in this workspace." : "Write the message in the box first."}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={!text.trim() || busy} onClick={() => void confirm()}>
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <CalendarClock className="size-3.5" />} Schedule
              </Button>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface Pending {
  id: number;
  name: string;
  size: number;
  preview?: string; // object URL for images
  image?: ImageRef;
  file?: FileRef;
  error?: string;
}
let pendingId = 0;

/** Thumbnail strip above the input: images as thumbs, other files as chips. */
function PendingStrip({ items, onRemove }: { items: Pending[]; onRemove: (id: number) => void }) {
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3" data-pending-strip>
      {items.map((p) =>
        p.preview ? (
          <span key={p.id} className="group relative inline-flex" data-pending-image>
            <img
              src={p.preview}
              alt={p.name}
              title={p.name}
              className={cn("size-14 rounded-[4px] border-[1.5px] border-line object-cover", !p.image && !p.error && "opacity-50", p.error && "border-bad")}
            />
            {!p.image && !p.error && <LoaderCircle className="absolute inset-0 m-auto size-4 animate-spin text-fg" />}
            <RemoveX label={p.name} onClick={() => onRemove(p.id)} />
          </span>
        ) : (
          <FileChip key={p.id} file={p} uploading={!p.file && !p.error} error={p.error} onRemove={() => onRemove(p.id)} />
        ),
      )}
    </div>
  );
}

function RemoveX({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Remove ${label}`}
      className="absolute -right-1.5 -top-1.5 hidden size-4 place-items-center rounded-full border border-line-strong bg-raised text-dim hover:text-fg group-hover:grid"
    >
      <X className="size-2.5" strokeWidth={3} />
    </button>
  );
}

/** Drafted diff comments waiting to be sent, shown next to the context meter. */
function ReviewChip({ wsId }: { wsId: string }) {
  const drafts = useReviewComments(wsId);
  if (!drafts.length) return null;
  return (
    <span data-review-chip className="flex items-center gap-1.5 text-[11px] text-mute">
      <span className="font-medium text-dim">Review ({drafts.length})</span>
      <button type="button" onClick={() => void sendReview(wsId)} className="rounded-[3px] border border-line px-1.5 py-0.5 text-fg hover:bg-hover">
        Send
      </button>
      <button type="button" onClick={() => void discardReview(wsId)} className="rounded-[3px] border border-line px-1.5 py-0.5 hover:bg-hover hover:text-fg">
        Discard
      </button>
    </span>
  );
}

function Composer({ ws, running }: { ws: Workspace; running: boolean }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = (files: File[]) => {
    for (const f of files) {
      const id = ++pendingId;
      const isImg = isImageFile(f);
      const item: Pending = { id, name: f.name || "image", size: f.size, preview: isImg ? URL.createObjectURL(f) : undefined };
      if (!isImg && f.size > MAX_FILE_BYTES) {
        setPending((p) => [...p, { ...item, error: `Over ${formatSize(MAX_FILE_BYTES)}` }]);
        continue;
      }
      setPending((p) => [...p, item]);
      void (async () => {
        try {
          if (isImg) {
            const { data, mediaType } = await prepareImage(f);
            const image = await api.saveImage(ws.id, data, mediaType);
            setPending((p) => p.map((x) => (x.id === id ? { ...x, image } : x)));
          } else {
            const data = (await toDataUrl(f)).replace(/^data:[^,]*,/, "");
            const file = await api.saveFile(ws.id, f.name, data, f.type || "application/octet-stream");
            setPending((p) => p.map((x) => (x.id === id ? { ...x, file } : x)));
          }
        } catch (e) {
          setPending((p) => p.map((x) => (x.id === id ? { ...x, error: String(e).replace(/^Error:\s*/, "").slice(0, 60) } : x)));
        }
      })();
    }
  };
  const removePending = (id: number) =>
    setPending((p) => {
      const gone = p.find((x) => x.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return p.filter((x) => x.id !== id);
    });
  const addRef = useRef(addFiles);
  addRef.current = addFiles;

  // Drops on the chat, and the palette's "Attach file…".
  useEffect(() => {
    const onFiles = (e: Event) => {
      const d = (e as CustomEvent<{ workspaceId: string; files: File[] }>).detail;
      if (d.workspaceId === ws.id) addRef.current(d.files);
    };
    const onPick = () => fileInput.current?.click();
    window.addEventListener("orbit-attach-files", onFiles);
    window.addEventListener("orbit-attach-image", onPick);
    return () => {
      window.removeEventListener("orbit-attach-files", onFiles);
      window.removeEventListener("orbit-attach-image", onPick);
    };
  }, [ws.id]);

  // Attachments belong to a workspace; switching away drops unsent ones.
  useEffect(() => () => setPending([]), [ws.id]);
  const [highlight, setHighlight] = useState(0);
  const skills = useApp((s) => s.skills);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Autocomplete only while typing the first token of a slash command.
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const matches = slashQuery === undefined ? [] : rankSkills(workspacePackItems(skills, ws), slashQuery).slice(0, 8);
  useEffect(() => setHighlight(0), [slashQuery]);

  // Draft is per workspace and survives switching away.
  useEffect(() => {
    setText(sessionStorage.getItem(`draft:${ws.id}`) ?? "");
    ref.current?.focus();
  }, [ws.id]);

  useEffect(() => {
    sessionStorage.setItem(`draft:${ws.id}`, text);
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    }
  }, [text, ws.id]);

  const uploading = pending.some((p) => !p.image && !p.file && !p.error);
  const ready = pending.filter((p) => p.image || p.file);
  const slashCmd = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  // Skills are sent as a command: attachments can't ride along.
  const isSkill = !!slashCmd && !!resolveSkill(skills, slashCmd[1]);
  const canSend = (!!text.trim() || ready.length > 0) && !uploading && !(isSkill && ready.length > 0);

  const send = async () => {
    const t = text.trim();
    if (!canSend) return;
    const sent = pending;
    setText("");
    setPending([]);
    const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(t);
    const skill = slash && resolveSkill(skills, slash[1]);
    try {
      // Unknown slash commands pass through untouched (e.g. Claude's own /compact).
      if (skill) await api.runSkill(ws.id, skill.id, slash[2]);
      else {
        const images = sent.flatMap((p) => (p.image ? [p.image] : []));
        const files = sent.flatMap((p) => (p.file ? [p.file] : []));
        await api.sendMessage(ws.id, t, images, files);
      }
      for (const p of sent) if (p.preview) URL.revokeObjectURL(p.preview);
    } catch (e) {
      setText(t);
      setPending(sent);
      useApp.getState().setError(String(e));
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items].flatMap((i) => (i.kind === "file" ? [i.getAsFile()].filter((f): f is File => !!f) : []));
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (matches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => (h + d + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        setText(`/${matches[highlight].id} `);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      void useApp.getState().interrupt(ws.id);
    }
  };

  return (
    <div className="shrink-0 px-6 pb-6">
      <SkillChips ws={ws} text={text} onRun={() => setText("")} />
      {notice && (
        <p role="status" className="mx-auto mb-2 flex max-w-[880px] items-center gap-1.5 text-[12px] font-medium text-mute">
          <Check className="size-3" strokeWidth={3} /> {notice}
        </p>
      )}
      <div className="relative mx-auto max-w-[880px] rounded-[6px] border-[1.5px] border-line-strong bg-raised transition-shadow focus-within:shadow-hard">
        {running && (
          <span className="absolute inset-x-0 -top-[1.5px] h-[3px] overflow-hidden">
            <span className="dither-sweep bg-run" />
          </span>
        )}
        {matches.length > 0 && (
          <ul className="absolute inset-x-0 bottom-full mb-3 overflow-hidden rounded-[6px] border-[1.5px] border-line-strong bg-raised p-1 shadow-hard">
            {matches.map((s, i) => (
              <li key={s.id}>
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setText(`/${s.id} `);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "flex w-full items-baseline gap-3 rounded-[3px] px-2.5 py-1.5 text-left",
                    i === highlight && "bg-accent [&_span]:text-accent-fg",
                  )}
                >
                  <span className="shrink-0 text-[12px] font-semibold text-fg">/{s.id}</span>
                  {s.argumentHint && <span className="shrink-0 text-[11px] text-mute">{s.argumentHint}</span>}
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-mute">{s.description}</span>
                  <span className="shrink-0 text-[10px] uppercase text-mute/70">{s.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {pending.length > 0 && <PendingStrip items={pending} onRemove={removePending} />}
        {isSkill && ready.length > 0 && <p className="px-4 pt-2 text-[11.5px] font-medium text-mute">Skills can't take attachments. Remove them or send as a plain message.</p>}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-attach-input
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={3}
          placeholder={running ? `Steer ${agentLabel[ws.agent]}, sent mid-run…` : `Ask ${agentLabel[ws.agent]} to do something, or type / for skills`}
          className="block w-full resize-none bg-transparent px-4 pt-4 text-[14px] font-medium leading-relaxed text-fg placeholder:text-mute focus:outline-none"
        />
        <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
          <span className="flex items-center gap-1.5 px-1.5 py-1 text-[12px] font-medium text-dim">
            <AgentIcon agent={ws.agent} />
            {agentLabel[ws.agent]}
            {ws.model && <span className="text-mute">· {ws.model}</span>}
            <ProfileMenu ws={ws} running={running} />
          </span>
          <span className="flex-1" />
          <LimitsBadge />
          <ReviewChip wsId={ws.id} />
          <ContextMeter ws={ws} running={running} />
          {running && (
            <span className="flex items-center gap-1.5 text-[11px] text-mute">
              <Kbd>Esc</Kbd> to interrupt
            </span>
          )}
          <button
            onClick={() => fileInput.current?.click()}
            disabled={isSkill}
            title="Attach a file or image (or paste / drop)"
            aria-label="Attach file"
            className="grid size-8 place-items-center rounded-[4px] border-[1.5px] border-line-strong text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-30"
          >
            <ImagePlus className="size-4" />
          </button>
          <ScheduleButton
            ws={ws}
            text={text}
            onScheduled={(when) => {
              setText("");
              setNotice(`Scheduled: ${when}`);
              window.setTimeout(() => setNotice(null), 6000);
            }}
          />
          {running && !text.trim() && pending.length === 0 ? (
            <button
              onClick={() => void useApp.getState().interrupt(ws.id)}
              title="Interrupt (Esc)"
              className="grid size-8 place-items-center rounded-[4px] border-[1.5px] border-line-strong text-fg hover:bg-fg hover:text-bg"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!canSend}
              title="Send (Enter)"
              className="grid size-8 place-items-center rounded-[4px] bg-accent text-accent-fg shadow-hard-sm transition-[transform,box-shadow,opacity] hover:brightness-110 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-25 disabled:shadow-none"
            >
              <ArrowUp className="size-4" strokeWidth={3} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Header control: open the worktree in the external editor; the arrow picks another detected editor for once. */
function EditorButton({ ws }: { ws: Workspace }) {
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [menu, setMenu] = useState(false);
  const command = useApp((s) => s.settings?.editorCommand);
  const keyLabel = useKeybindingLabels();
  useEffect(() => {
    api.listEditors().then(setEditors).catch(() => setEditors([]));
  }, []);
  const open = (editor?: string) => {
    setMenu(false);
    api.openInEditor(ws.path, editor).catch((e) => useApp.getState().setError(String(e).replace(/^Error:\s*/, "")));
  };
  const name = editorLabel(editors, command);
  const kb = keyLabel("workbench.openInEditor");
  return (
    <span className="relative flex shrink-0 items-center" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setMenu(false); }}>
      <Button title={`Open in ${name}` + (kb ? ` (${kb})` : "")} aria-label="Open in editor" className="px-1.5" onClick={() => open()}>
        <SquareArrowOutUpRight className="size-3.5" />
      </Button>
      {editors.length > 1 && (
        <Button title="Open with another editor" aria-label="Choose editor" className="px-0.5" onClick={() => setMenu((m) => !m)}>
          <ChevronDown className="size-3" />
        </Button>
      )}
      {menu && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 min-w-[150px] rounded-[4px] border-[1.5px] border-line-strong bg-panel p-1 shadow-hard-sm">
          {editors.map((e) => (
            <button key={e.id} role="menuitem" onClick={() => open(e.id)} className="block w-full rounded-[3px] px-2 py-1 text-left text-[12px] hover:bg-hover">
              {e.name}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
