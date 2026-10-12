// Phase 2 of AI teammates: Chief's plan card, hand-off chips, "from X" / "Scheduled" labels, and the
// teammate thread's schedule button + routines line. Rendered by Teammates.tsx.
import { ArrowRight, CalendarClock, Clock, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type PartState, type PlanView, type Schedule, type Teammate, type TeammateTask, type TeammateView } from "../lib/ipc";
import { defaultSchedule, describeShort } from "../lib/routines";
import { useApp } from "../stores/app";
import { SchedulePreview, WhenControl } from "./Routines";
import { TeammateAvatar } from "./TeammateAvatar";
import { Button, cn } from "./ui";

const fail = (e: unknown) => useApp.getState().setError(String(e).replace(/^Error:\s*/, ""));

function useTeammate(slug: string | null | undefined): TeammateView | undefined {
  return useApp((s) => s.teammates.find((t) => t.slug === slug));
}

// ---------------------------------------------------------------- origin labels

/** "from Chief" / "from Builder" / "Scheduled · Weekly triage" on a task's Started card. */
export function OriginLabel({ task }: { task: TeammateTask | undefined }) {
  const from = useTeammate(task?.originKind === "routine" ? null : task?.originRef);
  if (!task?.originKind) return null;
  if (task.originKind === "routine") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-mute" title={`Started by the routine "${task.originRef}"`} data-origin="routine">
        <Clock className="size-3" strokeWidth={2.25} /> Scheduled{task.originRef ? ` · ${task.originRef}` : ""}
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-mute" data-origin={task.originKind}>
      {from && <TeammateAvatar avatar={from.avatar} name={from.name} size={16} />}
      from {from?.name ?? task.originRef}
    </span>
  );
}

// ---------------------------------------------------------------- hand-off chips

/** Rule-based chips from the backend plus a "Hand to…" picker; a hand-off opens a new task for the target. */
export function HandoffChips({ task, selfSlug }: { task: TeammateTask; selfSlug: string }) {
  const teammates = useApp((s) => s.teammates);
  const [busy, setBusy] = useState<string | null>(null);
  const hand = async (to: string) => {
    if (busy) return;
    setBusy(to);
    try {
      await api.teammateHandoff(task.id, to);
      await useApp.getState().refreshTeammates();
    } catch (e) {
      fail(e);
    }
    setBusy(null);
  };
  const others = teammates.filter((t) => t.slug !== selfSlug && t.slug !== "chief");
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" data-handoff-chips>
      {task.handoffs.map((c) => (
        <button
          key={c.to}
          onClick={() => void hand(c.to)}
          disabled={!!busy}
          data-handoff-to={c.to}
          className="flex h-7 items-center gap-1.5 rounded-[4px] border-[1.5px] border-line-strong px-2 text-[12px] font-medium text-dim transition-colors hover:bg-fg hover:text-bg disabled:opacity-50"
        >
          {busy === c.to ? <LoaderCircle className="size-3 animate-spin" /> : <ArrowRight className="size-3" strokeWidth={2.5} />}
          {c.label}
        </button>
      ))}
      <select
        aria-label="Hand to a teammate"
        value=""
        disabled={!!busy}
        onChange={(e) => e.target.value && void hand(e.target.value)}
        className="h-7 rounded-[4px] border-[1.5px] border-line bg-bg px-2 text-[12px] font-medium text-mute hover:text-dim focus:outline-none"
      >
        <option value="">Hand to…</option>
        {others.map((t) => (
          <option key={t.slug} value={t.slug}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** "→ Handed to Reviewer" line in the source thread. */
export function HandoffLine({ slug, text }: { slug: string | null; text: string }) {
  const to = useTeammate(slug);
  return (
    <div className="flex items-center gap-1.5 text-[12px] font-medium text-mute" data-handoff-line>
      <ArrowRight className="size-3" strokeWidth={2.5} />
      {to ? (
        <button onClick={() => useApp.getState().openTeammate(to.slug)} className="flex items-center gap-1.5 hover:text-fg">
          Handed to <TeammateAvatar avatar={to.avatar} name={to.name} size={16} /> <span className="underline decoration-line-strong underline-offset-2">{to.name}</span>
        </button>
      ) : (
        text
      )}
    </div>
  );
}

/** The brief a delegated task started from, collapsed to a few lines. */
export function BriefBlock({ text, task }: { text: string; task: TeammateTask | undefined }) {
  const [open, setOpen] = useState(false);
  const from = useTeammate(task?.originKind === "routine" ? null : task?.originRef);
  const label = task?.originKind === "routine" ? `Scheduled message · ${task.originRef ?? ""}` : `Brief from ${from?.name ?? task?.originRef ?? "a teammate"}`;
  return (
    <div className="rounded-[4px] border-[1.5px] border-dashed border-line px-3.5 py-2.5" data-brief>
      <div className="flex items-center gap-2">
        <span className="label text-mute">{label}</span>
        <button onClick={() => setOpen((o) => !o)} className="ml-auto text-[11.5px] font-medium text-mute hover:text-dim">
          {open ? "Less" : "More"}
        </button>
      </div>
      <p className={cn("selectable mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-dim", !open && "line-clamp-3")}>{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------- Chief's plan card

const planTone: Record<PlanView["status"], { label: string; tone: string; box: string }> = {
  planning: { label: "Planning", tone: "text-run", box: "bg-run animate-pulse-dot" },
  proposed: { label: "Waiting for you", tone: "text-warn", box: "bg-warn" },
  running: { label: "In progress", tone: "text-run", box: "bg-run animate-pulse-dot" },
  done: { label: "Done", tone: "text-ok", box: "bg-ok" },
  cancelled: { label: "Cancelled", tone: "text-mute", box: "bg-mute/50" },
  failed: { label: "Couldn't plan", tone: "text-bad", box: "bg-bad" },
};

const partTone: Record<PartState, { label: string; tone: string; box: string }> = {
  pending: { label: "Waiting", tone: "text-mute", box: "border border-line-strong" },
  running: { label: "Working", tone: "text-run", box: "bg-run animate-pulse-dot" },
  waiting: { label: "Needs you", tone: "text-warn", box: "bg-warn" },
  done: { label: "Done", tone: "text-ok", box: "bg-ok" },
  failed: { label: "Failed", tone: "text-bad", box: "bg-bad" },
};

function Chip({ c }: { c: { label: string; tone: string; box: string } }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium", c.tone)}>
      <span className={cn("size-1.5", c.box)} />
      {c.label}
    </span>
  );
}

interface Draft {
  teammate: string;
  title: string;
  brief: string;
  dependsOn: number[];
}

export function PlanCard({ plan, onChanged }: { plan: PlanView; onChanged: () => void }) {
  const teammates = useApp((s) => s.teammates);
  const workspaces = useApp((s) => s.workspaces);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ summary: string; parts: Draft[] } | null>(null);
  const status = planTone[plan.status];
  const nameOf = (slug: string) => teammates.find((t) => t.slug === slug)?.name ?? slug;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };

  if (draft) return <PlanEditor draft={draft} setDraft={setDraft} busy={busy} onSave={() => run(async () => { await api.chiefPlanEdit(plan.id, draft); setDraft(null); })} />;

  return (
    <div className="rounded-[4px] border-[1.5px] border-line bg-panel px-3.5 py-2.5" data-plan={plan.id} data-plan-status={plan.status}>
      <div className="flex items-center gap-2.5">
        <span className="label text-mute">Plan</span>
        <Chip c={status} />
        {plan.status === "planning" && <LoaderCircle className="size-3 animate-spin text-mute" />}
      </div>
      {plan.summary && plan.status !== "planning" && (
        <p className={cn("selectable mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed", plan.status === "failed" ? "text-bad" : "text-fg")}>{plan.summary}</p>
      )}
      {plan.views.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {plan.views.map((p, i) => {
            const t = teammates.find((x) => x.slug === p.teammate);
            const waitsOn = p.dependsOn.map((d) => plan.views[d]?.title).filter(Boolean);
            const open = p.workspaceId && workspaces.some((w) => w.id === p.workspaceId);
            const state = plan.status === "proposed" || plan.status === "cancelled" ? undefined : p.state;
            return (
              <li key={i} className="flex gap-2.5 py-2" data-plan-part={i} data-part-state={p.state}>
                {t ? <TeammateAvatar avatar={t.avatar} name={t.name} size={24} className="mt-0.5" /> : <span className="size-6" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium">{p.title}</span>
                    <span className="shrink-0 text-[11.5px] text-mute">{nameOf(p.teammate)}</span>
                  </div>
                  {state === "done" || state === "failed" || state === "waiting" ? (
                    p.summary && <p className="selectable mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-dim">{p.summary}</p>
                  ) : (
                    <p className="selectable mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-dim">{p.brief}</p>
                  )}
                  {waitsOn.length > 0 && <p className="mt-0.5 text-[11.5px] text-mute">After: {waitsOn.join(", ")}</p>}
                </div>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {state && <Chip c={partTone[state]} />}
                  {open && (
                    <button onClick={() => useApp.getState().select(p.workspaceId!)} className="text-[11.5px] font-medium text-mute underline decoration-line-strong underline-offset-2 hover:text-fg">
                      Open
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {(plan.status === "proposed" || plan.status === "running") && (
        <div className="mt-2.5 flex items-center gap-2">
          {plan.status === "proposed" && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => void run(() => api.chiefPlanStart(plan.id))} data-plan-start>
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />} Start all
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setDraft({ summary: plan.summary, parts: plan.parts.map((p) => ({ teammate: p.teammate, title: p.title, brief: p.brief, dependsOn: [...p.dependsOn] })) })}>
                Edit
              </Button>
            </>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.chiefPlanCancel(plan.id))}>
            Cancel
          </Button>
          {plan.status === "running" && <span className="text-[11.5px] text-mute">Cancelling stops new parts from starting; running ones finish.</span>}
        </div>
      )}
    </div>
  );
}

function PlanEditor({ draft, setDraft, busy, onSave }: { draft: { summary: string; parts: Draft[] }; setDraft: (d: { summary: string; parts: Draft[] } | null) => void; busy: boolean; onSave: () => void }) {
  const all = useApp((s) => s.teammates);
  const teammates = all.filter((t) => t.slug !== "chief");
  const set = (i: number, patch: Partial<Draft>) => setDraft({ ...draft, parts: draft.parts.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const remove = (i: number) =>
    setDraft({
      ...draft,
      parts: draft.parts.filter((_, j) => j !== i).map((p) => ({ ...p, dependsOn: p.dependsOn.filter((d) => d !== i).map((d) => (d > i ? d - 1 : d)) })),
    });
  const field = "h-7 rounded-[4px] border-[1.5px] border-line bg-bg px-2 text-[12.5px] focus:border-line-strong focus:outline-none";
  return (
    <div className="rounded-[4px] border-[1.5px] border-line-strong bg-panel px-3.5 py-3" data-plan-editor>
      <div className="label mb-2 text-mute">Edit plan</div>
      <ul className="space-y-3">
        {draft.parts.map((p, i) => (
          <li key={i} className="space-y-1.5 border-l-[1.5px] border-line pl-3">
            <div className="flex items-center gap-2">
              <span className="w-4 shrink-0 text-[11.5px] tabular-nums text-mute">{i + 1}</span>
              <select aria-label={`Part ${i + 1} teammate`} value={p.teammate} onChange={(e) => set(i, { teammate: e.target.value })} className={cn(field, "font-medium")}>
                {teammates.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
              <input aria-label={`Part ${i + 1} title`} value={p.title} onChange={(e) => set(i, { title: e.target.value })} placeholder="Title" className={cn(field, "min-w-0 flex-1")} />
              <button onClick={() => remove(i)} title="Remove this part" aria-label={`Remove part ${i + 1}`} className="grid size-7 place-items-center rounded-[4px] text-mute hover:bg-hover hover:text-bad">
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <textarea
              aria-label={`Part ${i + 1} brief`}
              value={p.brief}
              rows={3}
              onChange={(e) => set(i, { brief: e.target.value })}
              className="block w-full resize-y rounded-[4px] border-[1.5px] border-line bg-bg px-2 py-1.5 text-[12.5px] leading-relaxed focus:border-line-strong focus:outline-none"
            />
            {draft.parts.length > 1 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[11.5px] text-mute">Starts after</span>
                {draft.parts.map((_, j) =>
                  j === i ? null : (
                    <button
                      key={j}
                      onClick={() => set(i, { dependsOn: p.dependsOn.includes(j) ? p.dependsOn.filter((d) => d !== j) : [...p.dependsOn, j].sort() })}
                      aria-pressed={p.dependsOn.includes(j)}
                      className={cn("h-5 min-w-5 rounded-[3px] border-[1.5px] px-1.5 text-[11.5px] font-medium tabular-nums", p.dependsOn.includes(j) ? "border-fg bg-fg text-bg" : "border-line-strong text-mute hover:text-dim")}
                    >
                      {j + 1}
                    </button>
                  ),
                )}
                {p.dependsOn.length === 0 && <span className="text-[11.5px] text-mute">(nothing: starts right away)</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="ghost" onClick={() => setDraft({ ...draft, parts: [...draft.parts, { teammate: teammates[0]?.slug ?? "", title: "", brief: "", dependsOn: [] }] })}>
          <Plus className="size-3.5" /> Add part
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => setDraft(null)}>
          Back
        </Button>
        <Button variant="primary" disabled={busy || draft.parts.length === 0} onClick={onSave} data-plan-save>
          {busy && <LoaderCircle className="size-3.5 animate-spin" />} Save plan
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- schedule + routines line

/** Clock button + popover in a teammate's composer: the composer text becomes a routine the teammate owns. */
export function ScheduleButton({ teammate, repoId, text, onScheduled }: { teammate: Teammate; repoId: string; text: string; onScheduled: (when: string) => void }) {
  const [open, setOpen] = useState(false);
  const [schedule, setSchedule] = useState<Schedule>(() => defaultSchedule("once"));
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (!text.trim() || !repoId || busy) return;
    setBusy(true);
    try {
      await api.saveRoutine({
        repoId,
        name: "",
        schedule,
        action: { kind: "prompt", text: text.trim() },
        agent: teammate.agent,
        model: teammate.model,
        profile: teammate.profile,
        mode: "fresh",
        enabled: true,
        teammate: teammate.slug,
      });
      void useApp.getState().refreshRoutines();
      setOpen(false);
      onScheduled(describeShort(schedule));
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Schedule…"
        aria-label="Schedule this message"
        aria-expanded={open}
        data-schedule-button
        className={cn("grid size-7 place-items-center rounded-[4px] border-[1.5px] text-dim transition-colors hover:bg-hover hover:text-fg", open ? "border-fg text-fg" : "border-line-strong")}
      >
        <CalendarClock className="size-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onMouseDown={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-2 w-[420px] max-w-[88vw] space-y-3 rounded-[6px] border-[1.5px] border-line-strong bg-raised p-3.5 shadow-hard" onKeyDown={(e) => e.key === "Escape" && setOpen(false)} data-schedule-popover>
            <div className="text-[12.5px] font-medium">Give {teammate.name} this task later</div>
            <WhenControl schedule={schedule} onChange={setSchedule} />
            <SchedulePreview schedule={schedule} />
            <p className="text-[11.5px] leading-relaxed text-mute">{text.trim() ? `Each run is a new task in this thread, marked as scheduled.` : "Write the task in the box first."}</p>
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={!text.trim() || !repoId || busy} onClick={() => void confirm()}>
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <CalendarClock className="size-3.5" />} Schedule
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** "Routines: Weekly triage · Nightly checks" under the thread header; opens the Routines view. */
export function RoutinesLine({ slug }: { slug: string }) {
  const all = useApp((s) => s.routines);
  const routines = all.filter((r) => r.teammate === slug);
  if (routines.length === 0) return null;
  return (
    <div className="flex items-center gap-2 px-6 pb-2 text-[12px] text-mute" data-routines-line>
      <Clock className="size-3 shrink-0" strokeWidth={2.25} />
      <span className="shrink-0 font-medium">Routines</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {routines.map((r) => (
          <button
            key={r.id}
            onClick={() => {
              useApp.getState().setView("routines");
              useApp.getState().setSelectedRoutine(r.id);
            }}
            className={cn("truncate underline decoration-line-strong underline-offset-2 hover:text-fg", !r.enabled && "opacity-60")}
            title="Open in Routines"
          >
            {r.name}
          </button>
        ))}
      </span>
    </div>
  );
}
