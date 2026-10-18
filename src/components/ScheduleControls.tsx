import { useEffect, useState } from "react";
import { api, type Schedule } from "../lib/ipc";
import { WEEKDAYS, defaultOnce, defaultSchedule, toLocalInput } from "../lib/routines";
import { Select } from "./settings/controls";
import { cn } from "./ui";

export const field =
  "h-7 rounded-[4px] border-[1.5px] border-line-strong bg-raised px-2 text-[12px] font-medium text-fg transition-colors hover:border-mute focus:border-fg focus:outline-none";

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
