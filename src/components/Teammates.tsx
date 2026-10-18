// AI teammates (src-tauri/src/teammates.rs): the Teammates view (list + thread) and the editor dialog.
import { LoaderCircle, Plus, Search, SendHorizontal, Shuffle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { timeAgo } from "../lib/attention";
import { confirmAction } from "../lib/confirm";
import { api, type AgentKind, type PlanView, type Teammate, type TeammateMessage, type TeammateTask, type TeammateTaskStatus, type TeammateView } from "../lib/ipc";
import { defaultModelFor, modelsFor } from "../lib/settings";
import { rememberedTeammate } from "../lib/lastTeammate";
import { useApp } from "../stores/app";
import { AVATAR_PORTRAITS, AVATAR_ACCESSORIES, AVATAR_BADGES, AVATAR_COLORS, AVATAR_EXPRESSIONS, AVATAR_SHAPES, formatAvatar, parseAvatar, randomAvatar, type AvatarSpec } from "../lib/avatar";
import { TeammateAvatar } from "./TeammateAvatar";
import { BriefBlock, HandoffChips, HandoffLine, OriginLabel, PlanCard, RoutinesLine, ScheduleButton } from "./TeammateExtras";
import { AgentIcon, Button, Kbd, TeammateDot, agentLabel, cn } from "./ui";

/** One line of the teammate's last message, "You: " when the user spoke last. */
function preview(t: TeammateView) {
  const m = t.lastMessage;
  if (!m) return t.description || "No messages yet";
  const line = m.text.replace(/\s+/g, " ").trim();
  return m.role === "user" ? `You: ${line}` : line;
}

const failed = (t: TeammateView) => t.lastMessage?.kind === "error";

// ---------------------------------------------------------------- view

/** The Teammates view: people on the left (search, "+"), the selected thread on the right. */
export function Teammates() {
  const all = useApp((s) => s.teammates);
  const selected = useApp((s) => s.selectedTeammate);
  const [query, setQuery] = useState("");

  // Starters are offered in the New teammate dialog; one only shows here once you've created it from there
  // or talked to it (e.g. Chief from the palette), so its thread stays reachable.
  const teammates = useMemo(() => all.filter((t) => !t.bundled || t.overridden || !!t.lastMessage || t.slug === selected), [all, selected]);

  // Land on the remembered teammate (or the first) when the view opens without a valid selection.
  useEffect(() => {
    if (!teammates.length || (selected && teammates.some((t) => t.slug === selected))) return;
    const remembered = rememberedTeammate();
    const pick = teammates.find((t) => t.slug === remembered) ?? teammates[0];
    useApp.setState({ selectedTeammate: pick.slug });
  }, [teammates, selected]);

  const q = query.trim().toLowerCase();
  const shown = q ? teammates.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(q)) : teammates;
  const empty = teammates.length === 0;

  return (
    <div className="flex min-w-0 flex-1 bg-bg" data-teammates>
      <aside className="flex w-[300px] shrink-0 flex-col border-r-[1.5px] border-line">
        <header className="flex h-12 shrink-0 items-center gap-2 px-4" data-tauri-drag-region>
          <h1 className="text-[15px] font-semibold tracking-[-0.02em]">Teammates</h1>
          <button
            onClick={() => useApp.getState().setTeammateEditor("new")}
            title="New teammate"
            aria-label="New teammate"
            className="ml-auto grid size-7 place-items-center rounded-[4px] border-[1.5px] border-line-strong text-fg hover:bg-fg hover:text-bg"
          >
            <Plus className="size-3.5" strokeWidth={2.5} />
          </button>
        </header>
        <div className="border-t-[1.5px] border-line" />
        {!empty && (
          <div className="px-3 pb-1 pt-3">
            <label className="flex h-8 items-center gap-2 rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 focus-within:border-line-strong">
              <Search className="size-3.5 shrink-0 text-mute" strokeWidth={2.25} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search teammates"
                aria-label="Search teammates"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] placeholder:text-mute focus:outline-none"
              />
            </label>
          </div>
        )}
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {shown.map((t) => (
            <TeammateRow key={t.slug} t={t} selected={t.slug === selected} />
          ))}
          {shown.length === 0 && !empty && <li className="px-3 py-6 text-center text-[12px] text-mute">No teammate matches.</li>}
        </ul>
      </aside>
      {selected && teammates.some((t) => t.slug === selected) ? (
        <TeammateThread key={selected} slug={selected} />
      ) : (
        <main className="grid min-w-0 flex-1 place-items-center px-6">
          <div className="text-center">
            <p className="text-[18px] font-semibold tracking-[-0.02em]">Create your first teammate</p>
            <p className="mx-auto mt-2 max-w-[380px] text-[13px] leading-relaxed text-mute">
              A teammate is a named coworker with its own instructions and memory. Hand it a task and it works in its own workspace.
            </p>
            <Button variant="primary" className="mt-5" onClick={() => useApp.getState().setTeammateEditor("new")}>
              <Plus className="size-3.5" /> New teammate
            </Button>
          </div>
        </main>
      )}
    </div>
  );
}

function TeammateRow({ t, selected }: { t: TeammateView; selected: boolean }) {
  return (
    <li>
      <button
        onClick={() => useApp.getState().openTeammate(t.slug)}
        data-teammate={t.slug}
        className={cn(
          "group relative flex w-full items-center gap-3 overflow-hidden rounded-[5px] px-2.5 py-2 text-left transition-colors",
          selected ? "bg-raised text-fg" : "text-dim hover:bg-hover/70 hover:text-fg",
        )}
      >
        {t.status === "working" && <span className="dither-sweep bg-run opacity-30" />}
        <span className="relative shrink-0">
          <TeammateAvatar avatar={t.avatar} name={t.name} size={40} blink={t.status === "working"} />
          <TeammateDot status={t.status} failed={failed(t)} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg" />
        </span>
        <span className="relative min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", t.unseen && "text-fg")}>{t.name}</span>
            {t.lastMessage && <span className="shrink-0 text-[10.5px] tabular-nums text-mute">{timeAgo(t.lastMessage.ts)}</span>}
          </span>
          <span className={cn("block truncate text-[11.5px]", t.unseen ? "text-dim" : "text-mute")}>{preview(t)}</span>
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- thread

const OPEN: TeammateTaskStatus[] = ["running", "waiting"];

const statusChip: Record<TeammateTaskStatus, { label: string; tone: string; box: string }> = {
  running: { label: "Working", tone: "text-run", box: "bg-run animate-pulse-dot" },
  done: { label: "Done", tone: "text-ok", box: "bg-ok" },
  waiting: { label: "Needs you", tone: "text-warn", box: "bg-warn" },
  error: { label: "Failed", tone: "text-bad", box: "bg-bad" },
};

function StatusChip({ status }: { status: TeammateTaskStatus }) {
  const c = statusChip[status];
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium", c.tone)}>
      <span className={cn("size-1.5", c.box)} />
      {c.label}
    </span>
  );
}

function WorkspaceLink({ id, fallback }: { id: string | null; fallback: string }) {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === id));
  if (!id || !ws) return <span className="min-w-0 truncate text-[12.5px] font-medium text-dim">{fallback}</span>;
  return (
    <button onClick={() => useApp.getState().select(id)} title="Open the workspace" className="min-w-0 truncate text-left text-[12.5px] font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg">
      {ws.name}
    </button>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[4px] border-[1.5px] border-line bg-panel px-3.5 py-2.5">{children}</div>;
}

function MessageRow({ m, tasks, teammate, plans, latestReport, onPlanChanged }: { m: TeammateMessage; tasks: TeammateTask[]; teammate: Teammate; plans: PlanView[]; latestReport: Set<string>; onPlanChanged: () => void }) {
  if (m.kind === "plan") {
    const plan = plans.find((p) => p.id === m.meta);
    return plan ? <PlanCard plan={plan} onChanged={onPlanChanged} /> : null;
  }
  if (m.kind === "brief") return <BriefBlock text={m.text} task={tasks.find((t) => t.workspaceId === m.workspaceId && t.originKind)} />;
  if (m.kind === "handoff") return <HandoffLine slug={m.meta} text={m.text} />;
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div data-user-message className="selectable max-w-[80%] whitespace-pre-wrap rounded-[16px] rounded-br-[5px] border border-line bg-hover px-4 py-2.5 text-[14px] leading-relaxed text-fg">
          {m.text}
        </div>
      </div>
    );
  }
  if (m.kind === "task_started") {
    const task = tasks.find((t) => t.workspaceId === m.workspaceId);
    const live = task?.status ?? m.status ?? "running";
    return (
      <Card>
        <div className="flex items-center gap-2.5">
          <span className="label text-mute">Started</span>
          <WorkspaceLink id={m.workspaceId} fallback={m.text} />
          <OriginLabel task={task} />
          <span className="ml-auto flex items-center gap-3">
            <StatusChip status={live} />
            <span className="text-[11px] tabular-nums text-mute">{timeAgo(m.ts)}</span>
          </span>
        </div>
      </Card>
    );
  }
  if (m.kind === "task_report") {
    const status = m.status ?? "done";
    const task = m.workspaceId ? tasks.find((t) => t.workspaceId === m.workspaceId) : undefined;
    const chips = task && status === "done" && task.status === "done" && latestReport.has(m.id);
    return (
      <Card>
        <div className="flex items-center gap-2.5">
          <StatusChip status={status} />
          {m.workspaceId ? <WorkspaceLink id={m.workspaceId} fallback="Workspace" /> : <span className="label text-mute">Combined report</span>}
          <span className="ml-auto flex items-center gap-3 text-[11px] tabular-nums text-mute">
            {m.files != null && m.files > 0 && (
              <span>
                {m.files} file{m.files === 1 ? "" : "s"} changed
              </span>
            )}
            <span>{timeAgo(m.ts)}</span>
          </span>
        </div>
        <p className="selectable mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-fg">{m.text}</p>
        {chips && <HandoffChips task={task} selfSlug={teammate.slug} />}
      </Card>
    );
  }
  if (m.kind === "error") {
    return <p className="selectable whitespace-pre-wrap text-[12.5px] font-medium text-bad">{m.text}</p>;
  }
  return (
    <div className="flex items-start gap-2.5">
      <TeammateAvatar avatar={teammate.avatar} name={teammate.name} size={28} className="mt-0.5" />
      <p className="selectable min-w-0 flex-1 whitespace-pre-wrap pt-0.5 text-[14px] leading-relaxed text-fg">{m.text}</p>
    </div>
  );
}

/** A teammate's thread: messages and task cards, with a composer to hand it work. */
export function TeammateThread({ slug }: { slug: string }) {
  const teammate = useApp((s) => s.teammates.find((t) => t.slug === slug));
  const repos = useApp((s) => s.repos);
  const workspaces = useApp((s) => s.workspaces);
  const selectedWs = useApp((s) => s.workspaces.find((w) => w.id === s.selectedId));
  const tick = useApp((s) => s.teammatesTick);
  const focusTick = useApp((s) => s.teammateFocus);
  const [messages, setMessages] = useState<TeammateMessage[]>([]);
  const [tasks, setTasks] = useState<TeammateTask[]>([]);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [newTask, setNewTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [repoId, setRepoId] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const unseen = teammate?.unseen ?? false;

  useEffect(() => {
    let live = true;
    api.teammateThread(slug).then((m) => live && setMessages(m), () => {});
    api.teammateTasks(slug).then((t) => live && setTasks(t), () => {});
    if (slug === "chief") api.teammatePlans(slug).then((p) => live && setPlans(p), () => {});
    return () => {
      live = false;
    };
  }, [slug, tick]);

  // Reading the thread clears "unseen"; only while something is unseen, so marking cannot loop.
  useEffect(() => {
    if (unseen) void api.teammateMarkSeen(slug).catch(() => {});
  }, [slug, unseen]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, slug]);
  useEffect(() => {
    ref.current?.focus();
  }, [slug, focusTick]);
  useEffect(() => {
    setNewTask(false);
    setText("");
    setNotice(null);
  }, [slug]);

  // Hand-off chips belong to the newest report of each workspace only.
  const latestReport = useMemo(() => {
    const newest = new Map<string, string>();
    for (const m of messages) if (m.kind === "task_report" && m.workspaceId) newest.set(m.workspaceId, m.id);
    return new Set(newest.values());
  }, [messages]);
  const refetchPlans = () => void api.teammatePlans(slug).then(setPlans, () => {});

  const pool = useMemo(
    () => (teammate && teammate.repos.length ? repos.filter((r) => teammate.repos.some((a) => a === r.id || a.toLowerCase() === r.name.toLowerCase())) : repos),
    [repos, teammate],
  );
  const isChief = slug === "chief";
  const openTask = isChief ? undefined : tasks.find((t) => OPEN.includes(t.status) && workspaces.some((w) => w.id === t.workspaceId));
  const starting = newTask || !openTask;
  const needsRepo = starting && pool.length > 1;
  // Remembered repo, else the one the user is looking at, else the first allowed.
  useEffect(() => {
    if (pool.some((r) => r.id === repoId)) return;
    const remembered = localStorage.getItem(`teammateRepo:${slug}`);
    setRepoId([remembered, selectedWs?.repoId, pool[0]?.id].find((id) => id && pool.some((r) => r.id === id)) ?? "");
  }, [pool, repoId, slug, selectedWs?.repoId]);

  if (!teammate) return <main className="grid flex-1 place-items-center text-[12.5px] text-mute">This teammate no longer exists.</main>;

  const send = async () => {
    const body = text.trim();
    if (!body || busy || (needsRepo && !repoId)) return;
    setBusy(true);
    try {
      if (needsRepo) localStorage.setItem(`teammateRepo:${slug}`, repoId);
      await api.teammateSend(slug, body, starting ? repoId || null : null, newTask ? true : null);
      setText("");
      setNewTask(false);
      const [m, t] = await Promise.all([api.teammateThread(slug), api.teammateTasks(slug)]);
      setMessages(m);
      setTasks(t);
      if (isChief) refetchPlans();
    } catch (e) {
      useApp.getState().setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const continuing = openTask ? workspaces.find((w) => w.id === openTask.workspaceId)?.name : null;
  const sel = "h-7 rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] font-medium text-fg focus:outline-none";

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-bg" data-teammate-thread={slug}>
      <header className="relative flex h-12 shrink-0 items-center gap-3 px-6" data-tauri-drag-region>
        <TeammateAvatar avatar={teammate.avatar} name={teammate.name} size={36} blink={teammate.status === "working"} />
        <h1 className="shrink-0 text-[15px] font-semibold tracking-[-0.02em]">{teammate.name}</h1>
        <span className="min-w-0 truncate text-[12.5px] text-mute">{teammate.description}</span>
        <span className="flex-1" />
        <span className={cn("flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium", teammate.status === "working" ? "text-run" : teammate.status === "needsYou" ? "text-warn" : "text-mute")}>
          <TeammateDot status={teammate.status} failed={failed(teammate)} />
          {teammate.status === "working" ? "Working" : teammate.status === "needsYou" ? "Needs you" : "Idle"}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-mute">
          <AgentIcon agent={teammate.agent} className="size-3 opacity-70" />
          {teammate.model || agentLabel[teammate.agent]}
        </span>
        <Button variant="outline" onClick={() => useApp.getState().setTeammateEditor(slug)}>
          Edit
        </Button>
      </header>
      <RoutinesLine slug={slug} />
      <div className="border-t-[1.5px] border-line" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] space-y-4 px-6 py-5">
          {messages.length === 0 && (
            <div className="py-16 text-center">
              <TeammateAvatar avatar={teammate.avatar} name={teammate.name} size={64} className="mx-auto" />
              <p className="mt-3 text-[13px] font-medium text-dim">{isChief ? "Tell Chief what you want done." : `Hand ${teammate.name} a task.`}</p>
              <p className="mx-auto mt-1 max-w-[420px] text-[12.5px] leading-relaxed text-mute">
                {isChief
                  ? "Chief splits it into parts, proposes a plan with the right teammate for each, and runs it when you press Start all. It reports back once everything is done."
                  : "It creates its own workspace, does the work there, and reports back here with a link and the result."}
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} m={m} tasks={tasks} teammate={teammate} plans={plans} latestReport={latestReport} onPlanChanged={refetchPlans} />
          ))}
          {teammate.status === "working" && (
            <div className="flex items-center gap-2 text-[12px] text-mute">
              <span className="dither-march h-2 w-10 bg-run" /> Working…
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="shrink-0 border-t-[1.5px] border-line px-6 py-3">
        <div className="mx-auto max-w-[760px]">
          <div className="rounded-[6px] border-[1.5px] border-line-strong bg-panel focus-within:border-fg">
            <textarea
              ref={ref}
              value={text}
              rows={Math.min(8, Math.max(2, text.split("\n").length))}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={`Message ${teammate.name}…`}
              className="block w-full resize-none bg-transparent px-3.5 pt-3 text-[14px] leading-relaxed placeholder:text-mute focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2.5 pt-1">
              {needsRepo && (
                <select value={repoId} onChange={(e) => setRepoId(e.target.value)} className={sel} title="Repository for the new task">
                  {pool.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
              {!isChief && (
                <ScheduleButton
                  teammate={teammate}
                  repoId={repoId}
                  text={text}
                  onScheduled={(when) => {
                    setNotice(`Scheduled: ${when}. It appears under Routines.`);
                    setText("");
                  }}
                />
              )}
              {openTask && (
                <button
                  onClick={() => setNewTask((n) => !n)}
                  aria-pressed={newTask}
                  title="Start a separate task in a new workspace instead of continuing the open one"
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-[4px] border-[1.5px] px-2 text-[12px] font-medium transition-colors",
                    newTask ? "border-fg bg-fg text-bg" : "border-line-strong text-mute hover:text-dim",
                  )}
                >
                  <Plus className="size-3" strokeWidth={2.75} /> New task
                </button>
              )}
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-mute">
                {notice ?? (isChief ? "Chief proposes a plan first; nothing starts until you press Start all" : starting ? "Starts a new task in its own workspace" : `Continues: ${continuing}`)}
              </span>
              <Kbd>Enter</Kbd>
              <Button variant="primary" onClick={() => void send()} disabled={!text.trim() || busy || (needsRepo && !repoId)}>
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <SendHorizontal className="size-3.5" />}
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- editor

type Tab = "definition" | "memory";

/** Create / edit dialog. Saving writes the teammate's markdown file; the Memory tab edits its notes file. */
export function TeammateEditor({ slug }: { slug: string }) {
  const existing = useApp((s) => s.teammates.find((t) => t.slug === slug));
  const repos = useApp((s) => s.repos);
  const profiles = useApp((s) => s.profiles);
  const settings = useApp((s) => s.settings);
  const creating = slug === "new";
  const [tab, setTab] = useState<Tab>("definition");
  const [name, setName] = useState(existing?.name ?? "");
  const [avatar, setAvatar] = useState<AvatarSpec>(() => (existing ? parseAvatar(existing.avatar, existing.name) : randomAvatar()));
  const [description, setDescription] = useState(existing?.description ?? "");
  const [agent, setAgent] = useState<AgentKind>(existing?.agent ?? settings?.defaultAgent ?? "claude");
  const [model, setModel] = useState(existing?.model ?? "");
  const [profile, setProfile] = useState(existing?.profile ?? "shipkit:builder");
  const [allowed, setAllowed] = useState<string[]>(existing?.repos ?? []);
  const [readonly, setReadonly] = useState<"" | "true" | "false">(existing?.readonly == null ? "" : existing.readonly ? "true" : "false");
  const [instructions, setInstructions] = useState(existing?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [starter, setStarter] = useState<string | null>(null);
  const allTeammates = useApp((s) => s.teammates);
  const starters = allTeammates.filter((t) => t.bundled && !t.overridden);
  const [memory, setMemory] = useState<string | null>(null);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const close = () => useApp.getState().setTeammateEditor(null);
  const models = modelsFor(agent, settings);
  if (model && !models.includes(model)) models.push(model);

  useEffect(() => {
    if (creating || tab !== "memory" || memory !== null) return;
    api.teammateMemory(slug).then(setMemory, (e) => useApp.getState().setError(String(e)));
  }, [creating, tab, memory, slug]);

  const applyStarter = (t: Teammate) => {
    setStarter(t.slug);
    setName(t.name);
    setAvatar(parseAvatar(t.avatar, t.name));
    setDescription(t.description);
    setAgent(t.agent);
    setModel(t.model ?? "");
    setProfile(t.profile ?? "shipkit:builder");
    setAllowed(t.repos);
    setReadonly(t.readonly == null ? "" : t.readonly ? "true" : "false");
    setInstructions(t.instructions);
  };

  const isRepoOn = (r: { id: string; name: string }) => allowed.some((a) => a === r.id || a.toLowerCase() === r.name.toLowerCase());
  const toggleRepo = (r: { id: string; name: string }) =>
    setAllowed((cur) => (isRepoOn(r) ? cur.filter((a) => a !== r.id && a.toLowerCase() !== r.name.toLowerCase()) : [...cur, r.name]));

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const saved = await api.saveTeammate({
        slug: creating ? starter : slug,
        name,
        avatar: formatAvatar(avatar),
        description,
        agent,
        model: model || null,
        profile: profile || null,
        repos: allowed,
        readonly: readonly === "" ? null : readonly === "true",
        instructions,
      });
      await useApp.getState().refreshTeammates();
      close();
      if (creating) useApp.getState().openTeammate(saved.slug);
    } catch (e) {
      useApp.getState().setError(String(e));
      setBusy(false);
    }
  };

  const saveMemory = async () => {
    try {
      await api.setTeammateMemory(slug, memory ?? "");
      setMemoryDirty(false);
    } catch (e) {
      useApp.getState().setError(String(e));
    }
  };

  const remove = async () => {
    const reset = !!existing?.bundled;
    const ok = await confirmAction(
      reset ? `Remove ${existing?.name} from your teammates? Your edits are discarded; you can add it again from New teammate.` : `Delete ${existing?.name}? Its thread is removed; workspaces it created stay.`,
      reset ? "Remove" : "Delete",
    );
    if (!ok) return;
    try {
      await api.deleteTeammate(slug);
      await useApp.getState().refreshTeammates();
      if (useApp.getState().selectedTeammate === slug) useApp.setState({ selectedTeammate: null });
      close();
    } catch (e) {
      useApp.getState().setError(String(e));
    }
  };

  const field = "h-8 w-full rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 text-[12.5px] placeholder:text-mute focus:border-line-strong focus:outline-none";
  const sel = "h-8 rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] font-medium text-fg focus:outline-none";
  const label = "label mb-1 block text-mute";

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center overflow-y-auto bg-overlay py-[6vh]" onMouseDown={close}>
      <div
        className="w-[620px] max-w-[94vw] overflow-hidden rounded-[6px] border-[1.5px] border-line-strong bg-raised shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        data-teammate-editor
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <TeammateAvatar spec={avatar} size={28} />
          <span className="text-[14px] font-semibold tracking-[-0.01em]">{creating ? "New teammate" : existing?.name}</span>
          {existing?.overridden && <span className="text-[11.5px] text-mute">edited from the starter</span>}
          <span className="flex-1" />
          {!creating && (
            <div className="flex rounded-[4px] border-[1.5px] border-line-strong p-0.5">
              {(["definition", "memory"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn("h-6 rounded-[2px] px-2 text-[12px] font-medium capitalize transition-colors", tab === t ? "bg-fg text-bg" : "text-mute hover:text-dim")}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {tab === "definition" ? (
          <div className="space-y-3.5 px-4 py-4">
            {creating && starters.length > 0 && (
              <div>
                <label className={label}>Start from a starter</label>
                <div className="flex flex-wrap gap-1.5">
                  {starters.map((t) => (
                    <button
                      key={t.slug}
                      onClick={() => applyStarter(t)}
                      title={t.description}
                      aria-pressed={starter === t.slug}
                      className={cn(
                        "flex h-8 items-center gap-2 rounded-[4px] border-[1.5px] px-2 text-[12px] font-medium transition-colors",
                        starter === t.slug ? "border-fg bg-raised text-fg" : "border-line-strong text-dim hover:text-fg",
                      )}
                    >
                      <TeammateAvatar avatar={t.avatar} name={t.name} size={20} />
                      {t.name}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[11.5px] text-mute">Fills in the form below; change anything before saving.</p>
              </div>
            )}
            <div>
              <label className={label}>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Scout" autoFocus className={field} />
            </div>
            <AvatarPicker value={avatar} onChange={setAvatar} />
            <div>
              <label className={label}>Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it is good at" className={field} />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className={label}>Agent</label>
                <div className="flex rounded-[4px] border-[1.5px] border-line-strong p-0.5">
                  {(["claude", "codex"] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => {
                        setAgent(a);
                        setModel(defaultModelFor(a, settings));
                      }}
                      className={cn("flex h-6 items-center gap-1.5 rounded-[2px] px-2 text-[12px] font-medium transition-colors", agent === a ? "bg-fg text-bg [&_svg]:text-bg" : "text-mute hover:text-dim")}
                    >
                      <AgentIcon agent={a} className="size-3" />
                      {agentLabel[a]}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={label}>Model</label>
                <select value={model} onChange={(e) => setModel(e.target.value)} className={sel}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m || "default model"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Profile for its workspaces</label>
                <select value={profile} onChange={(e) => setProfile(e.target.value)} className={sel}>
                  <option value="">Builder (default)</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.readonly ? " (read-only)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Access</label>
                <select value={readonly} onChange={(e) => setReadonly(e.target.value as typeof readonly)} className={sel}>
                  <option value="">From profile</option>
                  <option value="true">Read-only</option>
                  <option value="false">Can edit</option>
                </select>
              </div>
            </div>
            <div>
              <label className={label}>Repositories it may work in</label>
              <div className="flex flex-wrap gap-1">
                {repos.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => toggleRepo(r)}
                    className={cn(
                      "flex h-6 items-center rounded-[3px] border-[1.5px] px-2 text-[12px] font-medium transition-colors",
                      isRepoOn(r) ? "border-fg bg-fg text-bg" : "border-line-strong text-mute hover:text-dim",
                    )}
                  >
                    {r.name}
                  </button>
                ))}
                {repos.length === 0 && <span className="text-[12px] text-mute">Add a repository first.</span>}
              </div>
              <p className="mt-1 text-[11.5px] text-mute">{allowed.length ? "Only these." : "None selected means any repository."}</p>
            </div>
            <div>
              <label className={label}>Instructions</label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={7}
                placeholder="How it works, what it must never do, what a good report looks like…"
                className="block w-full resize-y rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 py-2 text-[12.5px] leading-relaxed placeholder:text-mute focus:border-line-strong focus:outline-none"
              />
            </div>
          </div>
        ) : (
          <div className="px-4 py-4">
            <p className="mb-2 text-[12px] leading-relaxed text-mute">
              Notes {existing?.name} keeps between tasks. The latest are given to it in every workspace it creates, and it appends durable learnings here when a task ends.
            </p>
            <textarea
              value={memory ?? ""}
              disabled={memory === null}
              onChange={(e) => {
                setMemory(e.target.value);
                setMemoryDirty(true);
              }}
              rows={12}
              className="block w-full resize-y rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 py-2 text-[12.5px] leading-relaxed focus:border-line-strong focus:outline-none"
            />
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
          {!creating && existing && (existing.bundled ? existing.overridden : true) && (
            <Button variant="ghost" onClick={() => void remove()} className={existing.bundled ? "" : "hover:text-bad"}>
              {existing.bundled ? "Remove" : "Delete"}
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {tab === "memory" ? (
            <Button variant="primary" onClick={() => void saveMemory()} disabled={!memoryDirty}>
              Save memory
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void save()} disabled={!name.trim() || busy}>
              {busy && <LoaderCircle className="size-3.5 animate-spin" />}
              Save
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Shape, colour, expression, badge and accessory rows with a live preview and a Shuffle button. */
function AvatarPicker({ value, onChange }: { value: AvatarSpec; onChange: (a: AvatarSpec) => void }) {
  const chip = (on: boolean) => cn("grid place-items-center rounded-[5px] border-[1.5px] transition-colors", on ? "border-fg bg-raised" : "border-transparent hover:bg-hover");
  return (
    <div data-avatar-picker>
      <div className="mb-1 flex items-center">
        <label className="label block text-mute">Avatar</label>
        <Button variant="ghost" className="ml-auto h-6 px-2" onClick={() => onChange(randomAvatar())}>
          <Shuffle className="size-3" /> Shuffle
        </Button>
      </div>
      <div className="flex items-start gap-4 rounded-[5px] border-[1.5px] border-line bg-bg p-3">
        <TeammateAvatar spec={value} size={72} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Role portraits">
            {AVATAR_PORTRAITS.map((portrait) => (
              <button key={portrait} title={portrait} aria-label={`${portrait} portrait`} aria-pressed={value.portrait === portrait} onClick={() => onChange({ ...value, portrait })} className={cn(chip(value.portrait === portrait), "size-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg")}>
                <TeammateAvatar spec={{ ...value, portrait }} size={32} />
              </button>
            ))}
          </div>
          <button className="text-[11px] text-mute underline underline-offset-2 hover:text-fg" aria-expanded={!value.portrait} onClick={() => onChange({ ...value, portrait: value.portrait ? undefined : AVATAR_PORTRAITS[0] })}>
            {value.portrait ? "Customize a classic avatar" : "Use a role portrait"}
          </button>
          {!value.portrait && <>
          <div className="flex flex-wrap gap-1">
            {AVATAR_SHAPES.map((shape) => (
              <button key={shape} title={shape} aria-label={shape} aria-pressed={value.shape === shape} onClick={() => onChange({ ...value, shape })} className={cn(chip(value.shape === shape), "size-9")}>
                <TeammateAvatar spec={{ ...value, shape }} size={26} />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                title={`Colour ${color}`}
                aria-label={`Colour ${color}`}
                aria-pressed={value.color === color}
                onClick={() => onChange({ ...value, color })}
                className={cn("size-6 rounded-full border-[1.5px] p-[2px]", value.color === color ? "border-fg" : "border-transparent hover:border-line-strong")}
              >
                <span className="block size-full rounded-full" style={{ background: `var(--avatar-${color})` }} />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {AVATAR_EXPRESSIONS.map((expression) => (
              <button key={expression} title={expression} aria-label={expression} aria-pressed={value.expression === expression} onClick={() => onChange({ ...value, expression })} className={cn(chip(value.expression === expression), "size-8")}>
                <TeammateAvatar spec={{ ...value, expression, badge: null, accessory: null }} size={22} />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            <button title="No badge" aria-label="No badge" aria-pressed={value.badge === null} onClick={() => onChange({ ...value, badge: null })} className={cn(chip(value.badge === null), "h-8 px-2 text-[11px] text-mute")}>
              No badge
            </button>
            {AVATAR_BADGES.map((badge) => (
              <button key={badge} title={badge} aria-label={badge} aria-pressed={value.badge === badge} onClick={() => onChange({ ...value, badge })} className={cn(chip(value.badge === badge), "size-8")}>
                <TeammateAvatar spec={{ ...value, badge, accessory: null }} size={26} />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            <button title="No accessory" aria-label="No accessory" aria-pressed={value.accessory === null} onClick={() => onChange({ ...value, accessory: null })} className={cn(chip(value.accessory === null), "h-8 px-2 text-[11px] text-mute")}>
              No accessory
            </button>
            {AVATAR_ACCESSORIES.map((accessory) => (
              <button key={accessory} title={accessory} aria-label={accessory} aria-pressed={value.accessory === accessory} onClick={() => onChange({ ...value, accessory })} className={cn(chip(value.accessory === accessory), "size-8")}>
                <TeammateAvatar spec={{ ...value, accessory, badge: null }} size={26} />
              </button>
            ))}
          </div>
          </>}
        </div>
      </div>
    </div>
  );
}
