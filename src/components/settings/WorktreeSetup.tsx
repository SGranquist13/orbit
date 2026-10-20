import { useEffect, useRef, useState } from "react";
import { api, type RepoScripts } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { cn } from "../ui";
import { Row, Select, SubHeading, save, useSettings } from "./controls";

const area =
  "w-full resize-y rounded-[4px] border-[1.5px] border-line-strong bg-raised px-2 py-1.5 font-mono text-[12px] leading-relaxed text-fg placeholder:text-mute transition-colors hover:border-mute focus:border-fg focus:outline-none";

const EMPTY: RepoScripts = { setupScript: null, runScript: null, copyGlobs: [] };

/** Multi-line mono text that saves on blur (Escape reverts). */
function ScriptArea({ label, value, placeholder, rows, onCommit }: { label: string; value: string; placeholder: string; rows: number; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return (
    <textarea
      aria-label={label}
      value={draft}
      rows={rows}
      placeholder={placeholder}
      spellCheck={false}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      className={area}
    />
  );
}

/** Per-repo setup script, run script and files copied into each new worktree. */
export function WorktreeSetup() {
  const s = useSettings();
  const repos = useApp((st) => st.repos);
  const setError = useApp.getState().setError;
  const [repoId, setRepoId] = useState<string | null>(null);
  const [scripts, setScripts] = useState<RepoScripts>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const id = repoId && repos.some((r) => r.id === repoId) ? repoId : repos[0]?.id ?? null;

  useEffect(() => {
    setProblem(null);
    if (!id) return;
    let cancelled = false;
    api
      .getRepoScripts(id)
      .then((v) => !cancelled && setScripts(v))
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [id, setError]);

  if (!s) return null;

  const commit = (patch: Partial<RepoScripts>) => {
    if (!id) return;
    const next = { ...scripts, ...patch };
    api
      .setRepoScripts(id, next)
      .then(() => {
        setScripts(next);
        setProblem(null);
      })
      .catch((e) => setProblem(String(e)));
  };
  const text = (v: string) => (v.trim() ? v : null);

  return (
    <>
      <SubHeading>Worktree setup</SubHeading>
      {repos.length === 0 ? (
        <p className="py-3 text-[12px] text-mute">Add a repository to set up its worktrees.</p>
      ) : (
        <>
          <Row label="Repository" description="Setup and run scripts belong to one repository.">
            <Select label="Repository" value={id ?? ""} options={repos.map((r) => ({ value: r.id, label: r.name }))} onChange={setRepoId} />
          </Row>
          <Row
            stacked
            label="Setup script"
            description="Runs once in every new worktree, before the agent's first message is sent (for example installing dependencies). If it fails, the agent is told."
          >
            <ScriptArea label="Setup script" rows={3} value={scripts.setupScript ?? ""} placeholder="bun install" onCommit={(v) => commit({ setupScript: text(v) })} />
          </Row>
          <Row
            stacked
            label="Run script"
            description={
              <>
                Starts the dev server from the chat header. Orbit picks a free port and passes it as <code className="font-mono text-dim">$PORT</code>.
              </>
            }
          >
            <ScriptArea label="Run script" rows={2} value={scripts.runScript ?? ""} placeholder="bun run dev -- --port $PORT" onCommit={(v) => commit({ runScript: text(v) })} />
          </Row>
          <Row
            stacked
            label="Copy files"
            description="One glob per line. Matching files that git ignores or doesn't track, such as .env, are copied from the main checkout into each new worktree."
          >
            <ScriptArea
              label="Copy files"
              rows={3}
              value={scripts.copyGlobs.join("\n")}
              placeholder=".env*"
              onCommit={(v) => commit({ copyGlobs: v.split("\n").map((l) => l.trim()).filter(Boolean) })}
            />
          </Row>
          {problem && <p className={cn("selectable whitespace-pre-wrap border-b border-line py-2 text-[12px] font-medium text-bad")}>{problem}</p>}
        </>
      )}
      <Row label="Setup timeout" field="setupTimeoutMinutes" description="A setup script that runs longer than this is killed and reported to the agent as timed out.">
        <Select
          label="Setup timeout"
          value={String(s.setupTimeoutMinutes)}
          options={[1, 5, 10, 20, 30, 60].includes(s.setupTimeoutMinutes) ? [1, 5, 10, 20, 30, 60].map((n) => ({ value: String(n), label: `${n} min` })) : [1, 5, 10, 20, 30, 60, s.setupTimeoutMinutes].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `${n} min` }))}
          onChange={(v) => void save({ setupTimeoutMinutes: Number(v) })}
        />
      </Row>
    </>
  );
}
