import { Clock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeProfile } from "../lib/ipc";
import { attentionReason, formatSnooze, isSnoozed, reasonMeta, ruleSuggestions, snoozeOptions, timeAgo, type Reason, type Suggestion } from "../lib/attention";
import { api, type Summary, type TeammateView, type Workspace } from "../lib/ipc";
import { diffTotals, useApp } from "../stores/app";
import { TeammateAvatar } from "./TeammateAvatar";
import { AgentIcon, Button, Kbd, StatusDot, TeammateDot, agentLabel, cn } from "./ui";

type Tab = "needs" | "all";
interface Row {
  ws: Workspace;
  summary: Summary | undefined;
  reason: Reason | null;
}
interface Chips {
  items: Suggestion[];
  loading: boolean;
}

const MAX_CHIPS = 6;
/** AI suggestions by `${id}:${lastSeq}`; an empty array means the call failed. */
const aiCache = new Map<string, string[]>();
const aiInflight = new Set<string>();

export function Inbox() {
  const workspaces = useApp((s) => s.workspaces);
  const repos = useApp((s) => s.repos);
  const summaries = useApp((s) => s.summaries);
  const prs = useApp((s) => s.prs);
  const changes = useApp((s) => s.changes);
  const settings = useApp((s) => s.settings);
  const staleLimits = useMemo(
    () => (settings ? { days: settings.staleDays, behind: settings.staleBehind } : undefined),
    [settings?.staleDays, settings?.staleBehind], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const teammates = useApp((s) => s.teammates);
  const [tab, setTab] = useState<Tab>("needs");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [, bump] = useState(0);

  // PR state drives two of the reasons, so keep it fresh while the inbox is open.
  useEffect(() => {
    let cancelled = false;
    const refreshAll = async () => {
      for (const w of useApp.getState().workspaces) {
        if (cancelled) return;
        await useApp.getState().refreshPr(w.id);
      }
    };
    void refreshAll();
    const t = window.setInterval(() => void refreshAll(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const all: Row[] = useMemo(
    () =>
      workspaces
        .map((ws) => ({ ws, summary: summaries[ws.id], reason: attentionReason(ws, summaries[ws.id], prs[ws.id], staleLimits) }))
        .sort((a, b) => (b.summary?.lastActivityTs ?? 0) - (a.summary?.lastActivityTs ?? 0)),
    [workspaces, summaries, prs, staleLimits],
  );
  const needs = useMemo(() => all.filter((r) => r.reason), [all]);
  const rows = tab === "needs" ? needs : all;
  // Teammate threads that need you (or all of them, on the All tab), newest activity first.
  const needsTeammates = useMemo(() => teammates.filter((t) => t.status === "needsYou"), [teammates]);
  const teammateRows = useMemo(
    () => [...(tab === "needs" ? needsTeammates : teammates)].sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0)),
    [tab, needsTeammates, teammates],
  );
  // When the focused row leaves the list (dismissed, snoozed, sent), focus the row that now sits
  // at the same index (the next one, or the previous if it was last) instead of jumping to the top.
  const lastIndex = useRef(0);
  const found = rows.findIndex((r) => r.ws.id === focusedId);
  const focused = rows[found >= 0 ? found : Math.min(lastIndex.current, rows.length - 1)] ?? null;
  useEffect(() => {
    const i = rows.findIndex((r) => r.ws.id === focused?.ws.id);
    if (i >= 0) lastIndex.current = i;
  }, [rows, focused]);
  const fid = focused?.ws.id ?? "";

  const baseBranch = repos.find((r) => r.id === focused?.ws.repoId)?.baseBranch;
  const totals = diffTotals(changes[fid]);
  const chips = useChips(focused, changes[fid]?.length ?? 0, totals.additions + totals.deletions, !!prs[fid], baseBranch, () => bump((n) => n + 1));

  const move = useCallback(
    (delta: number) => {
      if (!rows.length) return;
      const i = Math.max(0, rows.findIndex((r) => r.ws.id === focused?.ws.id));
      setFocusedId(rows[Math.min(rows.length - 1, Math.max(0, i + delta))].ws.id);
    },
    [rows, focused],
  );

  // Dismissing or snoozing drops the row from "Needs you" once the call lands; focus then falls
  // through to the same index via `lastIndex` above.
  const dismiss = useCallback((row: Row) => void useApp.getState().dismiss(row.ws.id), []);
  const snooze = useCallback((row: Row, until: number) => void useApp.getState().snooze(row.ws.id, until), []);

  const send = useCallback(
    async (row: Row, chip: Suggestion | string) => {
      const id = row.ws.id;
      // Hand focus to the next row first: this one leaves "Needs you" once the agent starts.
      const i = rows.findIndex((r) => r.ws.id === id);
      setFocusedId((rows[i + 1] ?? rows[i - 1])?.ws.id ?? null);
      try {
        if (typeof chip === "string") await api.sendMessage(id, chip);
        else if (chip.kind === "skill") await api.runSkill(id, chip.skillId, "");
        else if (chip.kind === "ship") await useApp.getState().ship(id, chip.anyway);
        else if (chip.kind === "sync") await useApp.getState().syncNow(id);
        else if (chip.kind === "simplify") {
          const s = useApp.getState();
          s.select(id);
          s.setSimplifyOpen(true);
          await s.simplifyFind(id);
        }
        else if (chip.kind === "handoff") {
          if (await useApp.getState().setProfile(id, chip.profileId)) await api.sendMessage(id, chip.text);
        }
        else await api.sendMessage(id, chip.text);
      } catch (e) {
        useApp.getState().setError(String(e));
      }
    },
    [rows],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = useApp.getState();
      if (s.paletteOpen || s.newWorkspaceOpen || s.packsOpen || s.ticketOpen) return;
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (/^[1-6]$/.test(e.key) && focused) {
        const chip = chips.items[Number(e.key) - 1];
        if (!chip) return;
        void send(focused, chip);
      } else if (e.key === "Enter" && focused) s.select(focused.ws.id);
      else if (e.key.toLowerCase() === "e" && focused) dismiss(focused);
      else if (e.key.toLowerCase() === "s" && focused) snooze(focused, snoozeOptions()[0].until);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, send, dismiss, snooze, focused, chips]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="relative flex h-12 shrink-0 items-center gap-5 px-6" data-tauri-drag-region>
        <h1 className="text-[15px] font-semibold tracking-[-0.02em]">Inbox</h1>
        <div className="flex items-center gap-1">
          <TabButton active={tab === "needs"} onClick={() => setTab("needs")}>
            Needs you
            <span className="tabular-nums text-mute">{needs.length + needsTeammates.length}</span>
          </TabButton>
          <TabButton active={tab === "all"} onClick={() => setTab("all")}>
            All
          </TabButton>
        </div>
      </header>
      <div className="dither-rule bg-line-strong" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && teammateRows.length === 0 ? (
          <div className="grid h-full place-items-center">
            <div className="text-center">
              <p className="label text-mute">Nothing needs you</p>
              <p className="mt-1.5 text-[12.5px] text-mute">Agents that finish, fail, or ask something show up here.</p>
            </div>
          </div>
        ) : (
          <>
          {teammateRows.length > 0 && (
            <ul className="mx-auto max-w-[880px] space-y-1 px-6 pt-4" data-inbox-teammates>
              {teammateRows.map((t) => (
                <TeammateInboxRow key={t.slug} t={t} />
              ))}
            </ul>
          )}
          {rows.length > 0 && (
          <ul className="mx-auto max-w-[880px] space-y-1 px-6 py-4">
            {rows.map((r) => (
              <InboxRow
                key={r.ws.id}
                row={r}
                repo={repos.find((x) => x.id === r.ws.repoId)?.name}
                focused={r.ws.id === focused?.ws.id}
                chips={r.ws.id === focused?.ws.id ? chips : null}
                onFocus={() => setFocusedId(r.ws.id)}
                onSend={(c) => void send(r, c)}
                onDismiss={() => dismiss(r)}
                onSnooze={(until) => snooze(r, until)}
              />
            ))}
          </ul>
          )}
          </>
        )}
      </div>
    </div>
  );
}

/** A teammate that reported back or is waiting on you; opens its thread. */
function TeammateInboxRow({ t }: { t: TeammateView }) {
  const needs = t.status === "needsYou";
  const snippet = t.lastMessage?.text.replace(/\s+/g, " ").trim();
  return (
    <li>
      <button
        onClick={() => useApp.getState().openTeammate(t.slug)}
        className="block w-full rounded-[5px] border-[1.5px] border-transparent px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-panel"
      >
        <div className="flex items-center gap-2.5">
          <TeammateAvatar avatar={t.avatar} name={t.name} size={20} />
          <span className="truncate text-[13px] font-medium">{t.name}</span>
          <span className="truncate text-[12px] text-mute">Teammate</span>
          <span className="ml-auto flex shrink-0 items-center gap-3">
            <span className={cn("flex items-center gap-1.5 text-[11.5px] font-medium", needs ? reasonMeta("teammate").tone : t.status === "working" ? "text-run" : "text-mute")}>
              <TeammateDot status={t.status} failed={t.lastMessage?.kind === "error"} />
              {needs ? (t.unseen ? "Reported back" : "Waiting on you") : t.status === "working" ? "Working…" : "Idle"}
            </span>
            {t.lastMessage && <span className="text-[11.5px] tabular-nums text-mute">{timeAgo(t.lastMessage.ts)}</span>}
          </span>
        </div>
        {snippet && <p className="mt-1 truncate pl-[28px] text-[12.5px] text-dim">{snippet}</p>}
      </button>
    </li>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-[12.5px] font-medium transition-colors",
        active ? "bg-raised text-fg" : "text-dim hover:bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** Rule suggestions first, then (lazily fetched, cached) AI ones, de-duplicated and capped. */
function useChips(row: Row | null, changedFiles: number, changedLines: number, hasPr: boolean, baseBranch: string | undefined, refresh: () => void): Chips {
  const id = row?.ws.id;
  const reason = row?.reason ?? null;
  const key = `${id}:${row?.summary?.lastSeq ?? 0}`;
  const cached = aiCache.get(key);
  // Settings load async; until they do (null), suggestions are not fetched either.
  const aiEnabled = useApp((s) => s.settings?.aiSuggestions === true);
  const profiles = useApp((s) => s.profiles);
  const profile = row ? activeProfile(profiles, row.ws) : undefined;
  const planner = !!profile?.readonly && profile.id.endsWith(":planner");

  useEffect(() => {
    if (!id || !aiEnabled || aiCache.has(key) || aiInflight.has(key)) return;
    aiInflight.add(key);
    // Tell the model what the rule chips already offer so it suggests something new.
    const offered = (reason ? ruleSuggestions(reason, { hasPr, changedFiles, changedLines, planner, ws: row?.ws, baseBranch }) : []).map((c) => c.label);
    api
      .suggestPrompts(id, reason ?? "idle", offered)
      .then((r) => aiCache.set(key, r))
      .catch(() => aiCache.set(key, []))
      .finally(() => {
        aiInflight.delete(key);
        refresh();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, aiEnabled]);

  return useMemo(() => {
    if (!id) return { items: [], loading: false };
    const rules = reason ? ruleSuggestions(reason, { hasPr, changedFiles, changedLines, planner, ws: row?.ws, baseBranch }) : [];
    const ai = (cached ?? []).map((text): Suggestion => ({ label: text, kind: "text", text }));
    const seen = new Set<string>();
    const items = [...rules, ...ai]
      .filter((c) => {
        const k = c.label.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, MAX_CHIPS);
    return { items, loading: aiEnabled && !cached };
  }, [id, reason, hasPr, changedFiles, changedLines, planner, cached, aiEnabled, row?.ws, baseBranch]);
}

function InboxRow({
  row,
  repo,
  focused,
  chips,
  onFocus,
  onSend,
  onDismiss,
  onSnooze,
}: {
  row: Row;
  repo: string | undefined;
  focused: boolean;
  chips: Chips | null;
  onFocus: () => void;
  onSend: (chip: Suggestion | string) => void;
  onDismiss: () => void;
  onSnooze: (until: number) => void;
}) {
  const { ws, summary, reason } = row;
  const routineName = useApp((s) => s.routines.find((r) => r.id === ws.routineId)?.name) ?? summary?.routineName;
  const snoozed = isSnoozed(ws);
  const running = ws.status === "running";
  const days = Math.floor((Date.now() - ws.createdAt) / 86_400_000);
  const snippet =
    reason === "checksFailed"
      ? `${ws.checksCommand ?? "Checks"} failed: ${(ws.checksOutput ?? "").trim().split("\n").pop() ?? ""}`
      : reason === "needsSync"
        ? `Conflicts with base in ${ws.syncConflicts.join(", ")}`
        : reason === "stale"
          ? `${ws.behind} commit${ws.behind === 1 ? "" : "s"} behind base, open ${days} day${days === 1 ? "" : "s"}`
          : reason === "error"
            ? (summary?.lastTurnError ?? summary?.lastAssistantText)
            : summary?.lastAssistantText;

  return (
    <li
      onMouseEnter={onFocus}
      className={cn(
        "relative rounded-[5px] border-[1.5px] px-4 py-3 transition-colors",
        focused ? "border-line-strong bg-panel" : "border-transparent",
      )}
    >
      <div className="flex items-center gap-2.5">
        <StatusDot status={ws.status} />
        <span className="truncate text-[13px] font-medium">{ws.name}</span>
        {repo && <span className="truncate text-[12px] text-mute">{repo}</span>}
        {(ws.routineId || summary?.routineName) && (
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-mute">
            <Clock className="size-3" /> {routineName ?? "Routine"}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {reason ? (
            <span className={cn("text-[11.5px] font-medium", reasonMeta(reason).tone)}>{reasonMeta(reason).label}</span>
          ) : snoozed ? (
            <span className="flex items-center gap-1 text-[11.5px] font-medium text-mute">
              <Clock className="size-3" />
              Snoozed until {formatSnooze(ws.snoozedUntil)}
            </span>
          ) : (
            <span className={cn("text-[11.5px] font-medium", running ? "text-run" : "text-mute")}>
              {running ? "Working…" : "Idle"}
            </span>
          )}
          {summary && <span className="text-[11.5px] tabular-nums text-mute">{timeAgo(summary.lastActivityTs)}</span>}
          <AgentIcon agent={ws.agent} className="size-3 opacity-70" />
        </span>
      </div>
      {snippet && (
        <p className={cn("mt-1 truncate pl-[18px] text-[12.5px]", reason === "error" || reason === "checksFailed" ? "text-bad" : "text-dim")}>
          {snippet.replace(/\s+/g, " ")}
        </p>
      )}
      {focused && chips && <Expanded row={row} chips={chips} onSend={onSend} onDismiss={onDismiss} onSnooze={onSnooze} />}
    </li>
  );
}

function Expanded({
  row,
  chips,
  onSend,
  onDismiss,
  onSnooze,
}: {
  row: Row;
  chips: Chips;
  onSend: (chip: Suggestion | string) => void;
  onDismiss: () => void;
  onSnooze: (until: number) => void;
}) {
  const { ws } = row;
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-3 space-y-3 pl-[18px]">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.items.map((c, i) => (
          <button
            key={c.label}
            onClick={() => onSend(c)}
            className="flex h-7 items-center gap-2 rounded-[4px] border-[1.5px] border-line-strong px-2 text-[12px] font-medium text-fg transition-colors hover:bg-fg hover:text-bg"
          >
            <Kbd>{i + 1}</Kbd>
            {c.label}
          </button>
        ))}
        {chips.loading && (
          <span className="flex items-center gap-2 pl-1 text-[11.5px] text-mute">
            <span className="dither-march h-2 w-10 bg-run" />
            Thinking of suggestions
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") inputRef.current?.blur();
            else if (e.key === "Enter" && text.trim()) {
              onSend(text.trim());
              setText("");
            }
          }}
          placeholder={`Reply to ${agentLabel[ws.agent]}…`}
          className="h-8 min-w-0 flex-1 rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 text-[12.5px] placeholder:text-mute focus:border-line-strong focus:outline-none"
        />
        <Button variant="ghost" onClick={() => useApp.getState().select(ws.id)}>
          Open <Kbd>Enter</Kbd>
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss <Kbd>E</Kbd>
        </Button>
        <div className="relative">
          <Button variant="ghost" onClick={() => setMenu((m) => !m)}>
            Snooze <Kbd>S</Kbd>
          </Button>
          {menu && (
            <>
              <div className="fixed inset-0 z-10" onMouseDown={() => setMenu(false)} />
              <div
                className="absolute bottom-full right-0 z-20 mb-1 w-[176px] rounded-[4px] border-[1.5px] border-line-strong bg-raised p-1 shadow-hard-sm"
                onKeyDown={(e) => e.key === "Escape" && setMenu(false)}
              >
                {snoozeOptions().map((o) => (
                  <button
                    key={o.label}
                    onClick={() => {
                      setMenu(false);
                      onSnooze(o.until);
                    }}
                    className="flex h-7 w-full items-center rounded-[3px] px-2 text-left text-[12px] font-medium text-dim hover:bg-hover hover:text-fg"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
