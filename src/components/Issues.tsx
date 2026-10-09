import { CircleDot, LoaderCircle, MessageSquare, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { timeAgo } from "../lib/attention";
import { DEFAULT_PROFILE, api, type AgentKind, type Issue } from "../lib/ipc";
import { useApp } from "../stores/app";
import { Button, Kbd, agentLabel, AgentIcon, cn } from "./ui";

const PLANNER = "shipkit:planner";
const TICKET_WRITER = "shipkit:ticket-writer";

function lastAgent(): AgentKind {
  try {
    return localStorage.getItem("lastAgent") === "codex" ? "codex" : "claude";
  } catch {
    return "claude";
  }
}

interface Loaded {
  issues: Issue[];
  error: string | null;
}
/** Last result per repo so reopening the view is instant; every open still refetches. */
const cache = new Map<string, Loaded>();

export function Issues() {
  const repos = useApp((s) => s.repos);
  const workspaces = useApp((s) => s.workspaces);
  const [repoId, setRepoId] = useState(() => {
    const saved = localStorage.getItem("lastRepo");
    return repos.find((r) => r.id === saved)?.id ?? repos[0]?.id ?? "";
  });
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<Loaded | undefined>(() => cache.get(repoId));
  const [loading, setLoading] = useState(false);
  const [focusedNumber, setFocusedNumber] = useState<number | null>(null);
  const [starting, setStarting] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const repoRef = useRef(repoId);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    let result: Loaded;
    try {
      result = { issues: await api.listIssues(id), error: null };
    } catch (e) {
      result = { issues: [], error: String(e).replace(/^Error:\s*/, "") };
    }
    cache.set(id, result);
    // Ignore a slow response for a repo the user has since left.
    setLoaded((prev) => (repoRef.current === id ? result : prev));
    setLoading(false);
  }, []);

  useEffect(() => {
    repoRef.current = repoId;
    setLoaded(cache.get(repoId));
    setFocusedNumber(null);
    void load(repoId);
  }, [repoId, load]);

  const issues = loaded?.issues;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    if (!q || !issues) return issues ?? [];
    return issues.filter(
      (i) => String(i.number).includes(q) || i.title.toLowerCase().includes(q) || i.labels.some((l) => l.toLowerCase().includes(q)),
    );
  }, [issues, query]);

  const focusedIndex = Math.max(0, visible.findIndex((i) => i.number === focusedNumber));
  const focused = visible[focusedIndex] as Issue | undefined;
  const workspaceFor = useCallback(
    (n: number) => workspaces.find((w) => w.repoId === repoId && w.issueNumber === n),
    [workspaces, repoId],
  );

  const start = useCallback(
    async (issue: Issue, profile: string) => {
      if (starting !== null) return;
      setStarting(issue.number);
      try {
        const ws = await api.startIssue({ repoId, number: issue.number, title: issue.title, profile, agent: lastAgent(), model: null });
        useApp.getState().upsertWorkspace(ws);
        useApp.getState().select(ws.id);
      } catch (e) {
        useApp.getState().setError(String(e));
      } finally {
        setStarting(null);
      }
    },
    [repoId, starting],
  );

  const act = useCallback(
    (issue: Issue, profile: string) => {
      const existing = workspaceFor(issue.number);
      if (existing) useApp.getState().select(existing.id);
      else void start(issue, profile);
    },
    [workspaceFor, start],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = useApp.getState();
      if (s.paletteOpen || s.newWorkspaceOpen || s.packsOpen || s.ticketOpen) return;
      const move = (delta: number) => {
        if (!visible.length) return;
        setFocusedNumber(visible[Math.min(visible.length - 1, Math.max(0, focusedIndex + delta))].number);
      };
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (e.key === "/") searchRef.current?.focus();
      else if (e.key === "Enter" && focused) act(focused, DEFAULT_PROFILE);
      else if (e.key.toLowerCase() === "p" && focused && !workspaceFor(focused.number)) void start(focused, PLANNER);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, focusedIndex, focused, act, start, workspaceFor]);

  const noRemote = loaded?.error?.startsWith("No GitHub remote");

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="relative flex h-12 shrink-0 items-center gap-4 px-6" data-tauri-drag-region>
        <h1 className="text-[15px] font-semibold tracking-[-0.02em]">Issues</h1>
        {repos.length > 1 && (
          <select
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            className="h-7 rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] font-medium text-fg focus:outline-none"
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (setQuery(""), searchRef.current?.blur())}
          placeholder="Search title, #number, label…"
          className="h-7 w-[260px] min-w-0 rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 text-[12.5px] placeholder:text-mute focus:border-line-strong focus:outline-none"
        />
        <span className="flex-1" />
        <button
          onClick={() => void load(repoId)}
          disabled={!repoId || loading}
          title="Refresh"
          className="grid size-7 place-items-center rounded-[4px] text-mute hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <Button variant="primary" disabled={!repoId} onClick={() => useApp.getState().setTicketOpen(true)}>
          <Plus className="size-3.5" /> New ticket
        </Button>
      </header>
      <div className="dither-rule bg-line-strong" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!repoId ? (
          <Message title="No repository" body="Add a repository to see its GitHub issues." />
        ) : loaded === undefined ? (
          <Message title="Loading issues…" body="" />
        ) : noRemote ? (
          <Message title="This repo has no GitHub remote" body="Add one with git remote add origin <url> to list its issues here." />
        ) : loaded.error ? (
          <div className="grid h-full place-items-center px-6">
            <p className="selectable max-w-[520px] whitespace-pre-wrap text-center text-[12.5px] font-medium text-bad">{loaded.error}</p>
          </div>
        ) : visible.length === 0 ? (
          <Message
            title={query ? "No matching issues" : "No open issues"}
            body={query ? "Try a different search." : "Issues you open on GitHub show up here."}
          />
        ) : (
          <ul className="mx-auto max-w-[880px] space-y-1 px-6 py-4">
            {visible.map((issue) => (
              <IssueRow
                key={issue.number}
                issue={issue}
                focused={issue.number === focused?.number}
                workspaceId={workspaceFor(issue.number)?.id}
                starting={starting === issue.number}
                disabled={starting !== null}
                onFocus={() => setFocusedNumber(issue.number)}
                onStart={() => act(issue, DEFAULT_PROFILE)}
                onPlan={() => act(issue, PLANNER)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <p className="label text-mute">{title}</p>
        {body && <p className="mt-1.5 text-[12.5px] text-mute">{body}</p>}
      </div>
    </div>
  );
}

function IssueRow({
  issue,
  focused,
  workspaceId,
  starting,
  disabled,
  onFocus,
  onStart,
  onPlan,
}: {
  issue: Issue;
  focused: boolean;
  workspaceId: string | undefined;
  starting: boolean;
  disabled: boolean;
  onFocus: () => void;
  onStart: () => void;
  onPlan: () => void;
}) {
  const updated = Date.parse(issue.updatedAt);
  return (
    <li
      onMouseEnter={onFocus}
      className={cn(
        "relative rounded-[5px] border-[1.5px] px-4 py-3 transition-colors",
        focused ? "border-line-strong bg-panel" : "border-transparent",
      )}
    >
      <div className="flex items-center gap-2.5">
        <CircleDot className="size-3.5 shrink-0 text-mute" />
        <span className="text-[12px] tabular-nums text-mute">#{issue.number}</span>
        <span className="truncate text-[13px] font-medium">{issue.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {issue.comments > 0 && (
            <span className="flex items-center gap-1 text-[11.5px] tabular-nums text-mute">
              <MessageSquare className="size-3" />
              {issue.comments}
            </span>
          )}
          <span className="text-[11.5px] text-mute">{issue.author}</span>
          {!Number.isNaN(updated) && <span className="text-[11.5px] tabular-nums text-mute">{timeAgo(updated)}</span>}
        </span>
      </div>
      {issue.labels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-[24px]">
          {issue.labels.map((l) => (
            <span key={l} className="rounded-[3px] border border-line px-1.5 py-px text-[10.5px] font-medium text-mute">
              {l}
            </span>
          ))}
        </div>
      )}
      {(focused || starting) && (
        <div className="mt-3 flex items-center gap-2 pl-[24px]">
          {workspaceId ? (
            <Button variant="outline" onClick={() => useApp.getState().select(workspaceId)}>
              Open workspace <Kbd>Enter</Kbd>
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={disabled} onClick={onStart}>
                {starting && <LoaderCircle className="size-3.5 animate-spin" />}
                Start <Kbd>Enter</Kbd>
              </Button>
              <Button variant="ghost" disabled={disabled} onClick={onPlan}>
                Plan <Kbd>P</Kbd>
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** First line of the notes, trimmed to a sidebar-friendly title. */
function titleFrom(notes: string) {
  const line = notes.trim().split("\n")[0].replace(/\s+/g, " ");
  return `Ticket: ${line.length > 40 ? `${line.slice(0, 39)}…` : line}`;
}

/** Rough notes in, a well-formed GitHub issue out: runs `shipkit:write-ticket` under the Ticket writer profile. */
export function NewTicket() {
  const repos = useApp((s) => s.repos);
  const [repoId, setRepoId] = useState(() => {
    const saved = localStorage.getItem("lastRepo");
    return repos.find((r) => r.id === saved)?.id ?? repos[0]?.id ?? "";
  });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const close = () => useApp.getState().setTicketOpen(false);
  const submit = async () => {
    const text = notes.trim();
    if (!repoId || !text || busy) return;
    setBusy(true);
    const agent = lastAgent();
    try {
      const ws = await api.createWorkspace({ repoId, name: titleFrom(text), agent, model: null, profile: TICKET_WRITER });
      useApp.getState().upsertWorkspace(ws);
      await api.runSkill(ws.id, "shipkit:write-ticket", text);
      useApp.getState().select(ws.id);
      close();
    } catch (e) {
      useApp.getState().setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-overlay pt-[14vh]" onMouseDown={close}>
      <div
        className="w-[560px] overflow-hidden rounded-[6px] border-[1.5px] border-line-strong bg-raised shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">New ticket</span>
          <span className="text-[12px] text-mute">— a read-only agent checks the code and files the issue</span>
        </div>
        <textarea
          ref={ref}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={6}
          placeholder="Describe the bug or feature roughly…"
          className="block w-full resize-none bg-transparent px-4 py-3 text-[15px] font-medium leading-relaxed placeholder:text-mute focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
          {repos.length > 1 && (
            <select
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className="h-7 rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] font-medium text-fg focus:outline-none"
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <span className="flex items-center gap-1.5 text-[11.5px] text-mute">
            <AgentIcon agent={lastAgent()} className="size-3" />
            {agentLabel[lastAgent()]}
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1 text-[11px] text-mute">
            <Kbd>Ctrl</Kbd>
            <Kbd>Enter</Kbd>
          </span>
          <Button variant="primary" onClick={() => void submit()} disabled={!repoId || !notes.trim() || busy}>
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            Write ticket
          </Button>
        </div>
      </div>
    </div>
  );
}
