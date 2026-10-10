import { ChevronRight, Clock, LoaderCircle, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { confirmAction } from "../lib/confirm";
import { DEFAULT_PROFILE, api, type AgentKind, type Routine, type RoutineMode, type RoutineRun, type RunStatus, type Schedule } from "../lib/ipc";
import { TEMPLATES, WEEKDAYS, actionText, defaultOnce, defaultSchedule, describeSchedule, formatNext, textToAction, toLocalInput } from "../lib/routines";
import { defaultAgentModel, modelsFor } from "../lib/settings";
import { timeAgo } from "../lib/attention";
import { useApp } from "../stores/app";
import { Segmented, Select, Toggle } from "./settings/controls";
import { Button, agentLabel, cn } from "./ui";

const field =
  "h-7 rounded-[4px] border-[1.5px] border-line-strong bg-raised px-2 text-[12px] font-medium text-fg transition-colors hover:border-mute focus:border-fg focus:outline-none";

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

// ---------------------------------------------------------------- the "When" control

const KIND_OPTIONS: { value: Schedule["kind"]; label: string }[] = [
  { value: "once", label: "Once" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
];

/** Once / hourly / daily / weekdays / weekly with its time inputs. Shared by the editor and the chat popover. */
export function WhenControl({ schedule, onChange }: { schedule: Schedule; onChange: (s: Schedule) => void }) {
  const kind = schedule.kind;
  const options = kind === "cron" ? [...KIND_OPTIONS, { value: "cron" as const, label: "Custom (cron)" }] : KIND_OPTIONS;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        label="When"
        className="min-w-[120px]"
        value={kind}
        options={options}
        onChange={(k) => onChange(k === "cron" ? schedule : { ...defaultSchedule(k), time: schedule.time ?? defaultSchedule(k).time })}
      />
      {kind === "weekly" && (
        <>
          <span className="text-[12px] text-mute">on</span>
          <Select
            label="Day of the week"
            className="min-w-[110px]"
            value={String(schedule.weekday ?? 1)}
            options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
            onChange={(v) => onChange({ ...schedule, weekday: Number(v) })}
          />
        </>
      )}
      {(kind === "daily" || kind === "weekdays" || kind === "weekly") && (
        <>
          <span className="text-[12px] text-mute">at</span>
          <input
            type="time"
            aria-label="Time"
            value={schedule.time ?? "09:00"}
            onChange={(e) => e.target.value && onChange({ ...schedule, time: e.target.value })}
            className={cn(field, "w-[96px] tabular-nums")}
          />
        </>
      )}
      {kind === "once" && (
        <input
          type="datetime-local"
          aria-label="Date and time"
          value={schedule.at ?? defaultOnce()}
          min={toLocalInput(new Date())}
          onChange={(e) => e.target.value && onChange({ ...schedule, at: e.target.value })}
          className={cn(field, "tabular-nums")}
        />
      )}
      {kind === "cron" && <span className="text-[12px] text-mute">Edit under Advanced</span>}
    </div>
  );
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** One quiet line: the next few times this schedule fires (asked of the Rust core). */
export function SchedulePreview({ schedule }: { schedule: Schedule }) {
  const key = JSON.stringify(schedule);
  const [state, setState] = useState<{ key: string; times: number[]; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      api
        .previewSchedule(schedule, schedule.kind === "once" ? 1 : 3)
        .then((times) => live && setState({ key, times }))
        .catch((e) => live && setState({ key, times: [], error: String(e).replace(/^Error:\s*/, "") }));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!state || state.key !== key) return <p className="h-4 text-[11.5px] text-mute" />;
  if (state.error) return <p className="text-[11.5px] text-bad">{state.error}</p>;
  if (!state.times.length) return <p className="text-[11.5px] text-bad">That time has already passed.</p>;
  return (
    <p className="text-[11.5px] tabular-nums text-mute">
      {schedule.kind === "once" ? "Runs " : "Next: "}
      {state.times.map(fmtTime).join(" · ")}
    </p>
  );
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
      <div className="dither-rule bg-line-strong" />
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
  const selectedRepo = useApp((s) => s.workspaces.find((w) => w.id === s.selectedId)?.repoId);
  const initial = useMemo(() => defaultAgentModel(), []);

  const [prompt, setPrompt] = useState(routine ? actionText(routine.action) : "");
  const [name, setName] = useState(routine && routine.name !== autoName(actionText(routine.action)) ? routine.name : "");
  const [repoId, setRepoId] = useState(routine?.repoId ?? localStorage.getItem("lastRepo") ?? selectedRepo ?? repos[0]?.id ?? "");
  const [schedule, setSchedule] = useState<Schedule>(routine?.schedule ?? defaultSchedule("weekdays"));
  const [agent, setAgent] = useState<AgentKind>(routine?.agent ?? initial.agent);
  const [model, setModel] = useState(routine ? (routine.model ?? "") : initial.model);
  const [profile, setProfile] = useState(routine?.profile ?? "");
  const [mode, setMode] = useState<RoutineMode>(routine?.mode ?? "fresh");
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  const models = modelsFor(agent, settings);
  if (model && !models.includes(model)) models.push(model);

  const save = async () => {
    if (!prompt.trim() || !repoId || saving) return;
    setSaving(true);
    try {
      // A finished one-off switches itself off; picking a new time re-arms it.
      const rearm = !!routine && !routine.enabled && schedule.kind === "once" && routine.schedule.at !== schedule.at;
      const saved = await api.saveRoutine({
        id: routine?.id ?? null,
        repoId,
        name: name.trim(),
        schedule,
        action: textToAction(prompt, skills),
        agent,
        model: model || null,
        profile: profile || null,
        mode,
        enabled: rearm || (routine?.enabled ?? true),
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

      <textarea
        aria-label="Message"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={5}
        autoFocus={!routine}
        placeholder="What should the agent do? Starts like a chat message; a leading /skill works too."
        className="block w-full resize-y rounded-[6px] border-[1.5px] border-line-strong bg-raised px-3.5 py-3 text-[13.5px] font-medium leading-relaxed text-fg placeholder:text-mute focus:border-fg focus:outline-none"
      />

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
      </div>

      <input
        aria-label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        spellCheck={false}
        placeholder={prompt.trim() ? `Name (optional): ${autoName(prompt)}` : "Name (optional)"}
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
                value={agent}
                options={(["claude", "codex"] as const).map((a) => ({ value: a, label: agentLabel[a] }))}
                onChange={(a) => {
                  setAgent(a);
                  setModel(a === agent ? model : "");
                }}
              />
              <Select label="Model" value={model} options={models.map((m) => ({ value: m, label: m || "Default model" }))} onChange={setModel} />
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
                value={mode}
                options={[
                  { value: "fresh", label: "New each run" },
                  { value: "standing", label: "One standing workspace" },
                ]}
                onChange={setMode}
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
        <Button variant="primary" onClick={() => void save()} disabled={!prompt.trim() || !repoId || saving}>
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
