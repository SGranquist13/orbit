import { ChevronRight, Clock, LoaderCircle, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { confirmAction } from "../lib/confirm";
import { DEFAULT_PROFILE, api, type AgentKind, type Routine, type RoutineMode, type RoutineRun, type RunStatus, type Schedule } from "../lib/ipc";
import { SIMPLIFY_NAME, TEMPLATES, actionText, defaultSchedule, describeSchedule, formatNext, textToAction } from "../lib/routines";
import { defaultAgentModel, modelLabelFor, modelsFor } from "../lib/settings";
import { timeAgo } from "../lib/attention";
import { useApp } from "../stores/app";
import { Segmented, Select, Toggle } from "./settings/controls";
import { WhenControl, SchedulePreview, field } from "./ScheduleControls";
import { Button, agentLabel, cn } from "./ui";

const runTone: Record<RunStatus, string> = {
  running: "bg-run animate-pulse-dot",
  done: "bg-ok",
  error: "bg-bad",
  quiet: "bg-mute/50",
  skipped: "bg-warn",
};
const runLabel: Record<RunStatus, string> = { running: "Running", done: "Done", error: "Failed", quiet: "Nothing to do", skipped: "Skipped" };

/** Square status marker for a run; hollow when the routine has never run. */
function RunDot({ status }: { status: RunStatus | null }) {
  return <span className={cn("size-2 shrink-0", status ? runTone[status] : "border border-line-strong")} title={status ? runLabel[status] : "Never run"} />;
}

// ---------------------------------------------------------------- view

export function Routines() {
  const routines = useApp((s) => s.routines);
  const selected = useApp((s) => s.selectedRoutine);
  const repos = useApp((s) => s.repos);
  const current = selected && selected !== "new" ? routines.find((r) => r.id === selected) : undefined;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="relative flex h-12 shrink-0 items-center gap-4 px-6" data-tauri-drag-region>
        <h1 className="text-[15px] font-semibold tracking-[-0.02em]">Routines</h1>
        <span className="text-[12px] text-mute">Messages that run on a schedule, while Orbit is open</span>
        <Button variant="outline" className="ml-auto" onClick={() => useApp.getState().newRoutine()}>
          <Plus className="size-3.5" /> New routine
        </Button>
      </header>
      <div className="border-t-[1.5px] border-line" />
      <div className="flex min-h-0 flex-1">
        <div className="w-[360px] shrink-0 overflow-y-auto border-r-[1.5px] border-line">
          {routines.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="label text-mute">No routines yet</p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-mute">
                "Every Monday at 9, triage issues" or "tomorrow at 3pm, run the checks". You can also schedule a message straight from the chat.
              </p>
            </div>
          ) : (
            <ul className="space-y-0.5 p-2">
              {routines.map((r) => (
                <RoutineRow key={r.id} routine={r} repo={repos.find((x) => x.id === r.repoId)?.name} selected={r.id === selected} now={now} />
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected === "new" ? (
            <Editor key="new" routine={null} />
          ) : current ? (
            <Editor key={current.id} routine={current} />
          ) : (
            <div className="grid h-full place-items-center">
              <p className="text-[12.5px] text-mute">Pick a routine, or create one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RoutineRow({ routine: r, repo, selected, now }: { routine: Routine; repo: string | undefined; selected: boolean; now: number }) {
  const [busy, setBusy] = useState(false);
  const owner = useApp((s) => s.teammates.find((t) => t.slug === r.teammate));
  const finishedOnce = r.schedule.kind === "once" && !r.enabled && r.lastStatus;
  const next = r.enabled && r.nextRunAt ? `Next ${formatNext(r.nextRunAt, now)}` : finishedOnce ? "Done" : "Off";
  const runNow = async () => {
    setBusy(true);
    try {
      await api.runRoutineNow(r.id);
      await useApp.getState().refreshRoutines();
    } catch (e) {
      useApp.getState().setError(String(e));
    }
    setBusy(false);
  };
  return (
    <li>
      <div
        onClick={() => useApp.getState().setSelectedRoutine(r.id)}
        className={cn(
          "group flex cursor-default items-center gap-2.5 rounded-[4px] px-2.5 py-2 transition-colors",
          selected ? "bg-raised" : "hover:bg-hover/70",
        )}
      >
        <RunDot status={r.lastStatus} />
        <div className={cn("min-w-0 flex-1", !r.enabled && "opacity-60")}>
          <div className="truncate text-[12.5px] font-medium">{r.name}</div>
          <div className="truncate text-[11.5px] tabular-nums text-mute">
            {describeSchedule(r.schedule)}
            {repo && <> · {repo}</>}
            {owner && <> · {owner.name}</>}
          </div>
          <div className="text-[11.5px] tabular-nums text-mute">{next}</div>
        </div>
        <button
          title="Run now"
          aria-label={`Run ${r.name} now`}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            void runNow();
          }}
          className="grid size-7 shrink-0 place-items-center rounded-[4px] text-mute hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
        </button>
        <span onClick={(e) => e.stopPropagation()}>
          <Toggle
            label={`${r.name} enabled`}
            checked={r.enabled}
            onChange={(v) =>
              void api
                .setRoutineEnabled(r.id, v)
                .then(() => useApp.getState().refreshRoutines())
                .catch((e) => useApp.getState().setError(String(e)))
            }
          />
        </span>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- editor

function Editor({ routine }: { routine: Routine | null }) {
  const repos = useApp((s) => s.repos);
  const skills = useApp((s) => s.skills);
  const profiles = useApp((s) => s.profiles);
  const settings = useApp((s) => s.settings);
  const teammates = useApp((s) => s.teammates);
  const selectedRepo = useApp((s) => s.workspaces.find((w) => w.id === s.selectedId)?.repoId);
  const initial = useMemo(() => defaultAgentModel(), []);

  const [what, setWhat] = useState<"message" | "simplify">(routine?.action.kind === "simplify" ? "simplify" : "message");
  const [prompt, setPrompt] = useState(routine && routine.action.kind !== "simplify" ? actionText(routine.action) : "");
  const [name, setName] = useState(routine && routine.name !== autoName(actionText(routine.action)) ? routine.name : "");
  const [repoId, setRepoId] = useState(routine?.repoId ?? localStorage.getItem("lastRepo") ?? selectedRepo ?? repos[0]?.id ?? "");
  const [schedule, setSchedule] = useState<Schedule>(routine?.schedule ?? defaultSchedule("weekdays"));
  const [agent, setAgent] = useState<AgentKind>(routine?.agent ?? initial.agent);
  const [model, setModel] = useState(routine ? (routine.model ?? "") : initial.model);
  const [profile, setProfile] = useState(routine?.profile ?? "");
  const [mode, setMode] = useState<RoutineMode>(routine?.mode ?? "fresh");
  const [owner, setOwner] = useState(routine?.teammate ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const ownerTeammate = teammates.find((t) => t.slug === owner);

  // An owner runs the routine as a task in its thread, with its own agent and model: message routines only.
  const pickOwner = (slug: string) => {
    setOwner(slug);
    const t = teammates.find((x) => x.slug === slug);
    if (!t) return;
    setWhat("message");
    setAgent(t.agent);
    setModel(t.model ?? "");
    setProfile(t.profile ?? "");
    setMode("fresh");
  };

  const modelLists = useApp((s) => s.agentModels);
  const models = modelsFor(agent, settings, modelLists);
  if (model && !models.includes(model)) models.push(model);
  const canSave = (what === "simplify" || !!prompt.trim()) && !!repoId && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      // A finished one-off switches itself off; picking a new time re-arms it.
      const rearm = !!routine && !routine.enabled && schedule.kind === "once" && routine.schedule.at !== schedule.at;
      const saved = await api.saveRoutine({
        id: routine?.id ?? null,
        repoId,
        name: name.trim(),
        schedule,
        action: what === "simplify" ? { kind: "simplify" } : owner ? { kind: "prompt", text: prompt.trim() } : textToAction(prompt, skills),
        agent,
        model: model || null,
        profile: profile || null,
        mode,
        enabled: rearm || (routine?.enabled ?? true),
        teammate: owner || null,
      });
      localStorage.setItem("lastRepo", repoId);
      await useApp.getState().refreshRoutines();
      useApp.getState().setSelectedRoutine(saved.id);
    } catch (e) {
      useApp.getState().setError(String(e).replace(/^Error:\s*/, ""));
    }
    setSaving(false);
  };

  const remove = async () => {
    if (!routine || !(await confirmAction(`Delete "${routine.name}" and its run history? Workspaces it created are kept.`, "Delete"))) return;
    try {
      await api.deleteRoutine(routine.id);
      await useApp.getState().refreshRoutines();
      useApp.getState().setSelectedRoutine(null);
    } catch (e) {
      useApp.getState().setError(String(e));
    }
  };

  const pickTemplate = (t: (typeof TEMPLATES)[number]) => {
    setWhat(t.what);
    setPrompt(t.prompt);
    setSchedule(t.schedule);
    setName(t.label);
  };

  return (
    <div className="mx-auto max-w-[640px] space-y-4 px-6 py-5">
      {!routine && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="label mr-1 text-mute">Start from</span>
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              onClick={() => pickTemplate(t)}
              className="h-7 rounded-[4px] border-[1.5px] border-line-strong px-2 text-[12px] font-medium text-dim transition-colors hover:bg-fg hover:text-bg"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2.5">
        <span className="label text-mute">What</span>
        <Segmented<"message" | "simplify">
          label="What the routine does"
          value={what}
          options={[
            { value: "message", label: "Message" },
            { value: "simplify", label: SIMPLIFY_NAME },
          ]}
          onChange={(w) => {
            setWhat(w);
            if (w === "simplify") setOwner("");
          }}
        />
      </div>

      {what === "message" ? (
        <textarea
          aria-label="Message"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          autoFocus={!routine}
          placeholder="What should the agent do? Starts like a chat message; a leading /skill works too."
          className="block w-full resize-y rounded-[6px] border-[1.5px] border-line-strong bg-raised px-3.5 py-3 text-[13.5px] font-medium leading-relaxed text-fg placeholder:text-mute focus:border-fg focus:outline-none"
        />
      ) : (
        <p className="rounded-[6px] border-[1.5px] border-line bg-raised px-3.5 py-3 text-[12.5px] leading-relaxed text-dim">
          Looks over what landed on the base branch in the last 7 days and applies the low-risk simplifications, each one checked and committed on its own. If
          anything stuck, it opens a draft PR from a <span className="font-medium text-fg">refactor/</span> branch. Nothing to simplify means a quiet run.
        </p>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Select
            label="Repository"
            className="min-w-[140px]"
            value={repoId}
            options={repos.map((r) => ({ value: r.id, label: r.name }))}
            onChange={setRepoId}
          />
          <WhenControl schedule={schedule} onChange={setSchedule} />
        </div>
        <SchedulePreview schedule={schedule} />
        {what === "message" && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-routine-owner>
            <Select
              label="Owner"
              className="min-w-[160px]"
              value={owner}
              options={[{ value: "", label: "Owner: none" }, ...teammates.filter((t) => t.slug !== "chief").map((t) => ({ value: t.slug, label: `Owner: ${t.name}` }))]}
              onChange={pickOwner}
            />
            <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-mute">
              {ownerTeammate
                ? `Each run is a new task in ${ownerTeammate.name}'s thread, with its agent and model.`
                : "A teammate can own a routine: its runs show up in their thread, marked as scheduled."}
            </span>
          </div>
        )}
      </div>

      <input
        aria-label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        spellCheck={false}
        placeholder={what === "simplify" ? `Name (optional): ${SIMPLIFY_NAME}` : prompt.trim() ? `Name (optional): ${autoName(prompt)}` : "Name (optional)"}
        className={cn(field, "w-full placeholder:text-mute")}
      />

      <div>
        <button onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1 text-[12px] font-medium text-mute hover:text-dim">
          <ChevronRight className={cn("size-3 transition-transform", advanced && "rotate-90")} strokeWidth={3} /> Advanced
        </button>
        {advanced && (
          <div className="mt-2 space-y-3 border-l-[1.5px] border-line pl-4">
            <Labeled label="Agent">
              <Select
                label="Agent"
                className={ownerTeammate ? "pointer-events-none opacity-50" : ""}
                value={agent}
                options={(["claude", "codex"] as const).map((a) => ({ value: a, label: agentLabel[a] }))}
                onChange={(a) => {
                  setAgent(a);
                  setModel(a === agent ? model : "");
                }}
              />
              <Select label="Model" className={ownerTeammate ? "pointer-events-none opacity-50" : ""} value={model} options={models.map((m) => ({ value: m, label: modelLabelFor(agent, m, modelLists) || "Default model" }))} onChange={setModel} />
            </Labeled>
            <Labeled label="Profile">
              <Select
                label="Profile"
                className="min-w-[220px]"
                value={profile}
                options={[{ value: "", label: "Builder (default)" }, ...profiles.filter((p) => p.id !== DEFAULT_PROFILE).map((p) => ({ value: p.id, label: p.name }))]}
                onChange={setProfile}
              />
            </Labeled>
            <Labeled label="Workspace">
              <Segmented
                label="Workspace per run"
                value={ownerTeammate ? "fresh" : mode}
                options={[
                  { value: "fresh", label: "New each run" },
                  { value: "standing", label: "One standing workspace" },
                ]}
                onChange={(m) => !ownerTeammate && setMode(m)}
              />
            </Labeled>
            <p className="text-[11.5px] leading-relaxed text-mute">
              {mode === "fresh"
                ? "Each run gets its own worktree and branch. Runs that change nothing archive themselves."
                : "Every run continues in the same workspace, so the agent sees earlier runs. Skipped if the last run is still going."}
            </p>
            <Labeled label="Cron">
              <input
                aria-label="Cron expression"
                value={schedule.kind === "cron" ? (schedule.cron ?? "") : ""}
                spellCheck={false}
                placeholder="0 9 * * 1-5   (minute hour day month weekday)"
                onChange={(e) => {
                  const v = e.target.value;
                  setSchedule(v.trim() ? { kind: "cron", cron: v } : defaultSchedule("weekdays"));
                }}
                className={cn(field, "w-[320px] font-mono placeholder:font-sans placeholder:text-mute")}
              />
            </Labeled>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
          {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Clock className="size-3.5" />}
          {routine ? "Save" : "Create routine"}
        </Button>
        {routine && (
          <Button variant="ghost" className="ml-auto" onClick={() => void remove()}>
            <Trash2 className="size-3.5" /> Delete
          </Button>
        )}
      </div>

      {routine && <History routine={routine} />}
    </div>
  );
}

/** Mirrors the backend default: the first line of the prompt, trimmed. */
function autoName(prompt: string) {
  const line = prompt.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[72px] shrink-0 text-[12px] font-medium text-dim">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function History({ routine }: { routine: Routine }) {
  const tick = useApp((s) => s.routinesTick);
  const workspaces = useApp((s) => s.workspaces);
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .routineRuns(routine.id, 8)
      .then((r) => live && setRuns(r))
      .catch(() => live && setRuns([]));
    return () => {
      live = false;
    };
  }, [routine.id, tick]);
  return (
    <section className="pt-3">
      <h3 className="label border-b-[1.5px] border-line pb-1.5 text-mute">History</h3>
      {runs && runs.length === 0 && <p className="py-3 text-[12px] text-mute">No runs yet.</p>}
      <ul>
        {(runs ?? []).map((run) => {
          const open = run.workspaceId && workspaces.some((w) => w.id === run.workspaceId);
          return (
            <li key={run.id} className="flex items-baseline gap-2.5 border-b border-line py-2 text-[12px]">
              <span className="translate-y-px">
                <RunDot status={run.status} />
              </span>
              <span className="w-[88px] shrink-0 tabular-nums text-mute" title={new Date(run.startedAt).toLocaleString()}>
                {timeAgo(run.startedAt) === "now" ? "just now" : `${timeAgo(run.startedAt)} ago`}
              </span>
              <span className="w-[92px] shrink-0 font-medium text-dim">{runLabel[run.status]}</span>
              <span className="min-w-0 flex-1 truncate text-mute" title={run.summary ?? ""}>
                {run.summary?.replace(/\s+/g, " ")}
              </span>
              {open && (
                <button onClick={() => useApp.getState().select(run.workspaceId!)} className="shrink-0 font-medium text-dim hover:text-fg">
                  Open
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
