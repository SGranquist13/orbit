// Pure rules for the attention inbox: which workspaces need the user, and why.
import type { PrStatus, Summary, Workspace } from "./ipc";

export type Reason = "error" | "question" | "checks" | "changes" | "done";

export type Suggestion =
  | { label: string; kind: "skill"; skillId: string }
  | { label: string; kind: "text"; text: string }
  /** Switch the workspace to another profile, then send `text`. */
  | { label: string; kind: "handoff"; profileId: string; text: string };

export function isSnoozed(ws: Pick<Workspace, "snoozedUntil">, now = Date.now()) {
  return now < ws.snoozedUntil;
}

/** Snooze choices relative to `now`: an hour, tomorrow 9:00, next Monday 9:00. */
export function snoozeOptions(now = new Date()): { label: string; until: number }[] {
  const at9 = (daysAhead: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + daysAhead);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    { label: "1 hour", until: now.getTime() + 3_600_000 },
    { label: "Until tomorrow 9:00", until: at9(1) },
    { label: "Next week", until: at9(toMonday) },
  ];
}

/** "3:40 PM" for today, "Tue 9:00 AM" otherwise. */
export function formatSnooze(until: number, now = new Date()) {
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** Unread = a turn finished since the user last looked at the workspace. */
export function isUnread(ws: Workspace, summary: Summary | undefined) {
  return !!summary && summary.lastTurnSeq > ws.seenSeq;
}

function asksQuestion(text: string | null) {
  if (!text) return false;
  const trimmed = text.trim();
  const lastLine = trimmed.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (lastLine.endsWith("?")) return true;
  // A sentence-ending "?" after a word, not code like `a ? b` or a URL query string.
  return /[\p{L}\p{N})"'”]\?(\s|$)/u.test(trimmed.slice(-200));
}

export function attentionReason(ws: Workspace, summary: Summary | undefined, pr: PrStatus | null | undefined): Reason | null {
  if (!summary || ws.status === "running") return null;
  if (isSnoozed(ws)) return null;
  if (ws.dismissedSeq >= summary.lastSeq) return null;
  const unseen = summary.lastSeq > ws.seenSeq;
  const failed = ws.status === "error" || (!!summary.lastTurnError && !summary.lastTurnInterrupted);
  // PR signals stay until dismissed or new activity, even once the workspace has been seen.
  const open = pr?.state === "OPEN";
  // Priority: error > question > checks > changes > done.
  if (unseen && failed) return "error";
  if (unseen && asksQuestion(summary.lastAssistantText)) return "question";
  if (open && pr.checks.failed > 0) return "checks";
  if (open && pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (unseen && summary.lastTurnSeq > ws.seenSeq) return "done";
  return null;
}

const meta: Record<Reason, { label: string; tone: string }> = {
  error: { label: "Failed", tone: "text-bad" },
  question: { label: "Asked you", tone: "text-info" },
  checks: { label: "Checks failing", tone: "text-bad" },
  changes: { label: "Changes requested", tone: "text-warn" },
  done: { label: "Finished", tone: "text-ok" },
};

export function reasonMeta(reason: Reason) {
  return meta[reason];
}

export function ruleSuggestions(reason: Reason, ctx: { hasPr: boolean; changedFiles: number; planner?: boolean }): Suggestion[] {
  const text = (label: string): Suggestion => ({ label, kind: "text", text: label });
  const skill = (label: string, skillId: string): Suggestion => ({ label, kind: "skill", skillId });
  switch (reason) {
    case "error":
      return [text("Try that again"), text("Explain what went wrong and propose a fix")];
    case "question":
      return [text("Yes, go ahead"), text("No, stop here and summarize")];
    case "checks":
      return [skill("Fix CI", "shipkit:fix-ci"), text("Explain why CI is failing")];
    case "changes":
      return [skill("Address comments", "shipkit:address-comments")];
    case "done": {
      const out: Suggestion[] = [];
      if (ctx.planner) {
        out.push({ label: "Build this plan", kind: "handoff", profileId: "shipkit:builder", text: "Implement the plan above." });
      }
      if (ctx.hasPr) out.push(skill("Push updates", "shipkit:ship"));
      else if (ctx.changedFiles > 0) out.push(skill("Ship it", "shipkit:ship"));
      out.push(text("Keep going"), text("Summarize what changed"));
      return out.slice(0, 3);
    }
  }
}

export function timeAgo(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
