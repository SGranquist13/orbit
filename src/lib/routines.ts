// Pure helpers for routines: describing schedules in words, templates, and a small client-side
// "next times" calculator used only by the browser mock (the real app asks the Rust core, which
// owns the scheduling maths; see `preview_schedule` in src-tauri/src/routines.rs).
import type { RoutineAction, Schedule, Skill } from "./ipc";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DDTHH:MM" in local time, the format of `Schedule.at` and `datetime-local` inputs. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tomorrow at 09:00, a sensible default for a one-off. */
export function defaultOnce(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return toLocalInput(d);
}

export function defaultSchedule(kind: Schedule["kind"] = "daily"): Schedule {
  switch (kind) {
    case "once":
      return { kind, at: defaultOnce() };
    case "hourly":
      return { kind };
    case "weekly":
      return { kind, weekday: 1, time: "09:00" };
    case "cron":
      return { kind, cron: "0 9 * * 1-5" };
    default:
      return { kind, time: "09:00" };
  }
}

function formatAt(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Weekdays at 09:00", "Mondays at 09:00", "Once on Mon, Oct 12 at 15:00". */
export function describeSchedule(s: Schedule): string {
  const time = s.time ?? "09:00";
  switch (s.kind) {
    case "once":
      return s.at ? `Once on ${formatAt(s.at)}` : "Once";
    case "hourly":
      return s.time && s.time !== "00:00" ? `Every hour at :${s.time.slice(3)}` : "Every hour";
    case "daily":
      return `Every day at ${time}`;
    case "weekdays":
      return `Weekdays at ${time}`;
    case "weekly":
      return `${WEEKDAYS[s.weekday ?? 1]}s at ${time}`;
    case "cron":
      return `Cron ${s.cron ?? ""}`.trim();
  }
}

/** Short form for confirmations: "Mondays at 09:00". Same as `describeSchedule` minus "Every ". */
export function describeShort(s: Schedule): string {
  return describeSchedule(s).replace(/^Every day/, "Daily").replace(/^Every hour/, "Hourly");
}

/** "in 3h", "in 12m", "tomorrow 09:00", "Mon 09:00". */
export function formatNext(ts: number | null, now = Date.now()): string {
  if (!ts) return "";
  const diff = ts - now;
  if (diff <= 0) return "due now";
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 6 * 3_600_000) return `in ${Math.round(diff / 3_600_000)}h`;
  const d = new Date(ts);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** Text shown in the prompt box for an action; a skill reads back as `/skill args`. */
export function actionText(a: RoutineAction): string {
  return a.kind === "prompt" ? a.text : `/${a.skillId} ${a.args}`.trim();
}

/** A leading `/skill args` runs that skill, like in the composer; anything else is a plain message. */
export function textToAction(text: string, skills: Skill[]): RoutineAction {
  const t = text.trim();
  const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(t);
  if (slash) {
    const exact = skills.find((s) => s.id === slash[1]);
    const byName = skills.filter((s) => s.name === slash[1]);
    const skill = exact ?? (byName.length === 1 ? byName[0] : undefined);
    if (skill) return { kind: "skill", skillId: skill.id, args: slash[2] };
  }
  return { kind: "prompt", text: t };
}

export interface RoutineTemplate {
  label: string;
  prompt: string;
  schedule: Schedule;
}

/** Pre-filled prompts offered on "New routine". Nothing is created until the user saves. */
export const TEMPLATES: RoutineTemplate[] = [
  {
    label: "Triage new issues",
    prompt:
      "Look at the open GitHub issues that are new since yesterday (use `gh issue list`). For each one, add suitable labels, flag duplicates, and note which look like quick wins. Don't change any code. Finish with a short list of what needs a human.",
    schedule: { kind: "weekdays", time: "09:00" },
  },
  {
    label: "Nightly checks",
    prompt:
      "Run this project's checks (tests, type check, lint). If anything fails, fix it with the smallest correct change, commit, and open a draft PR describing what you fixed. If everything passes, say so in one line.",
    schedule: { kind: "daily", time: "02:00" },
  },
  {
    label: "Stale branch sweep",
    prompt:
      "List local and remote branches with no commits in the last 30 days and no open PR. Don't delete anything; report each with its last commit date and author so a human can decide.",
    schedule: { kind: "weekly", weekday: 1, time: "09:00" },
  },
];

// ---- mock-only next-times calculator (the Rust core is the source of truth in the real app)

function cronField(src: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) [lo, hi] = range.split("-").map(Number);
    else {
      lo = Number(range);
      hi = stepStr ? max : lo;
    }
    if (![lo, hi, step].every(Number.isFinite) || step < 1 || lo < min || hi > max || lo > hi) throw new Error(`invalid cron field "${src}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Throws on invalid input; returns up to `count` upcoming times (ms epoch). */
export function previewTimes(s: Schedule, count = 3, from = Date.now()): number[] {
  const out: number[] = [];
  const t = (s.time ?? "00:00").split(":").map(Number);
  if (s.kind === "once") {
    if (!s.at) throw new Error("pick a date and time");
    const at = new Date(s.at).getTime();
    return at > from ? [at] : [];
  }
  let matches: (d: Date) => boolean;
  if (s.kind === "cron") {
    const f = (s.cron ?? "").trim().split(/\s+/);
    if (f.length !== 5) throw new Error("cron needs 5 fields (minute hour day month weekday)");
    const [mi, ho, dom, mo, dow] = [cronField(f[0], 0, 59), cronField(f[1], 0, 23), cronField(f[2], 1, 31), cronField(f[3], 1, 12), cronField(f[4], 0, 7)];
    if (dow.has(7)) dow.add(0);
    const [domStar, dowStar] = [f[2].startsWith("*"), f[4].startsWith("*")];
    matches = (d) => {
      if (!mi.has(d.getMinutes()) || !ho.has(d.getHours()) || !mo.has(d.getMonth() + 1)) return false;
      const a = dom.has(d.getDate());
      const b = dow.has(d.getDay());
      return domStar && dowStar ? true : domStar ? b : dowStar ? a : a || b;
    };
  } else {
    matches = (d) => {
      if (s.kind === "hourly") return d.getMinutes() === (t[1] || 0);
      if (d.getHours() !== t[0] || d.getMinutes() !== t[1]) return false;
      if (s.kind === "weekdays") return d.getDay() >= 1 && d.getDay() <= 5;
      if (s.kind === "weekly") return d.getDay() === (s.weekday ?? 1);
      return true;
    };
  }
  const d = new Date(from);
  d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 14 && out.length < count; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (matches(d)) out.push(d.getTime());
  }
  return out;
}
