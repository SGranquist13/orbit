// Pure rules for the attention inbox: which workspaces need the user, and why.
import type { PrStatus, Summary, Workspace } from "./ipc";

export type Reason = "error" | "question" | "checksFailed" | "needsSync" | "checks" | "changes" | "done" | "stale" | "teammate";

export type Suggestion =
  | { label: string; kind: "skill"; skillId: string }
  /** Orbit's ship gate (checks + squash) first, then `shipkit:ship`; `anyway` skips the checks. */
  | { label: string; kind: "ship"; anyway: boolean }
  /** Fetch and rebase onto base now. */
  | { label: string; kind: "sync" }
  /** Open the Simplify panel and start the read-only pass. */
  | { label: string; kind: "simplify" }
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

const DAY_MS = 86_400_000;

/** Branch open for `days` or more, or `behind` commits behind base. 0 disables a test. */
export function isStale(
  ws: Pick<Workspace, "createdAt" | "behind">,
  limits: { days: number; behind: number } | undefined,
  now = Date.now(),
) {
  if (!limits) return false;
  return (limits.days > 0 && now - ws.createdAt >= limits.days * DAY_MS) || (limits.behind > 0 && ws.behind >= limits.behind);
}

export function attentionReason(
  ws: Workspace,
  summary: Summary | undefined,
  pr: PrStatus | null | undefined,
  staleLimits?: { days: number; behind: number },
): Reason | null {
  if (!summary || ws.status === "running") return null;
  if (isSnoozed(ws)) return null;
  if (ws.dismissedSeq >= summary.lastSeq) return null;
  const unseen = summary.lastSeq > ws.seenSeq;
  const failed = ws.status === "error" || (!!summary.lastTurnError && !summary.lastTurnInterrupted);
  // PR signals stay until dismissed or new activity, even once the workspace has been seen.
  const open = pr?.state === "OPEN";
  // Priority: error > question > Orbit's checks > needs sync > PR checks > changes > done > stale.
  if (unseen && failed) return "error";
  if (unseen && asksQuestion(summary.lastAssistantText)) return "question";
  if (ws.checksFailed) return "checksFailed";
  if (ws.syncConflicts.length > 0) return "needsSync";
  if (open && pr.checks.failed > 0) return "checks";
  if (open && pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (unseen && summary.lastTurnSeq > ws.seenSeq) return "done";
  if (isStale(ws, staleLimits)) return "stale";
  return null;
}

const meta: Record<Reason, { label: string; tone: string }> = {
  error: { label: "Failed", tone: "text-bad" },
  question: { label: "Asked you", tone: "text-info" },
  checksFailed: { label: "Checks failed", tone: "text-bad" },
  needsSync: { label: "Needs sync", tone: "text-warn" },
  checks: { label: "Checks failing", tone: "text-bad" },
  changes: { label: "Changes requested", tone: "text-warn" },
  done: { label: "Finished", tone: "text-ok" },
  stale: { label: "Stale branch", tone: "text-warn" },
  // Teammate threads that need you; they are not workspaces, so `attentionReason` never returns this.
  teammate: { label: "Teammate", tone: "text-warn" },
};

/** The prompt behind "Fix checks": the command and the tail of its output. */
export function fixChecksPrompt(ws: Pick<Workspace, "checksCommand" | "checksOutput">) {
  const cmd = ws.checksCommand ?? "the check command";
  return (
    `The check command \`${cmd}\` failed in this workspace. Fix the failures and re-run it until it passes, ` +
    `then tell me it is ready to ship.\n\nLast output:\n\`\`\`\n${ws.checksOutput ?? ""}\n\`\`\``
  );
}

/** The prompt behind "Resolve conflicts": a focused rebase brief naming the conflicting files. */
export function resolveConflictsPrompt(ws: Pick<Workspace, "syncConflicts">, baseBranch: string) {
  return (
    `Your branch is behind origin/${baseBranch} and Orbit's automatic rebase hit conflicts in: ${ws.syncConflicts.join(", ")}.\n` +
    `Run \`git fetch origin ${baseBranch}\` and \`git rebase origin/${baseBranch}\`. Resolve each conflict keeping the intent of both sides, ` +
    `\`git add\` the files and \`git rebase --continue\` until it finishes. Then run the project's checks and fix anything the merge broke. ` +
    `Don't push; just tell me when it is done.`
  );
}

/** Changed lines (added + deleted) above which a finished workspace is offered "Simplify". */
export const SIMPLIFY_SUGGEST_LINES = 300;

export function reasonMeta(reason: Reason) {
  return meta[reason];
}

export function ruleSuggestions(
  reason: Reason,
  ctx: { hasPr: boolean; changedFiles: number; changedLines?: number; planner?: boolean; ws?: Workspace; baseBranch?: string },
): Suggestion[] {
  const text = (label: string): Suggestion => ({ label, kind: "text", text: label });
  const skill = (label: string, skillId: string): Suggestion => ({ label, kind: "skill", skillId });
  const ship = (label: string, anyway = false): Suggestion => ({ label, kind: "ship", anyway });
  switch (reason) {
    case "checksFailed":
      return [
        { label: "Fix checks", kind: "text", text: ctx.ws ? fixChecksPrompt(ctx.ws) : "Fix the failing checks" },
        ship("Ship anyway", true),
      ];
    case "needsSync":
      return [
        {
          label: "Resolve conflicts",
          kind: "text",
          text: ctx.ws ? resolveConflictsPrompt(ctx.ws, ctx.baseBranch ?? "main") : "Rebase onto the base branch and resolve conflicts",
        },
      ];
    case "stale":
      return [{ label: "Sync now", kind: "sync" }, text("Keep going")];
    case "teammate":
      return [];
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
      if (ctx.hasPr) out.push(ship("Push updates"));
      else if (ctx.changedFiles > 0) out.push(ship("Ship it"));
      // A big diff is where agents leave residue; offer the cleanup before it goes out.
      if ((ctx.changedLines ?? 0) > SIMPLIFY_SUGGEST_LINES) out.push({ label: "Simplify", kind: "simplify" });
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
