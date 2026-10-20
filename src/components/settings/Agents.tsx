import { LoaderCircle, Lock, RefreshCw } from "lucide-react";
import type { EnvironmentInfo } from "../../lib/ipc";
import { Button } from "../ui";
import { Cards, Dot, Row, Select, SubHeading, TagInput, save, useSettings } from "./controls";
import { useEnvironment } from "./env";
import { useApp } from "../../stores/app";

type Tone = "ok" | "warn" | "bad";

function ToolRow({ name, tone, status, detail }: { name: string; tone: Tone; status: string; detail?: string | null }) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-2.5 text-[12px]">
      <Dot tone={tone} />
      <span className="w-24 shrink-0 font-medium">{name}</span>
      <span className="shrink-0 font-medium text-dim">{status}</span>
      {detail && <span className="selectable min-w-0 flex-1 truncate text-right text-[11.5px] text-mute" title={detail}>{detail}</span>}
    </div>
  );
}

export function claudeTone(i: EnvironmentInfo["claude"]): Tone {
  return i.ok ? "ok" : i.path ? "warn" : "bad";
}
export function codexTone(i: EnvironmentInfo["codex"]): Tone {
  return !i.path ? "bad" : i.loggedIn ? "ok" : "warn";
}

export function Agents() {
  const s = useSettings();
  const modelsLoading = useApp((s) => s.modelsLoading);
  const { info, loading, error, refresh } = useEnvironment();
  if (!s) return null;
  return (
    <>
      <Row
        stacked
        field="claudePermissionMode"
        label="Claude permissions"
        description="How Claude Code treats tool use in non-read-only workspaces. Applies to new and restarted sessions."
      >
        <Cards
          label="Claude permission mode"
          value={s.claudePermissionMode}
          options={[
            { value: "bypassPermissions", label: "Run unattended", hint: "Every tool call is allowed. Fastest, and safe enough inside an isolated worktree." },
            { value: "acceptEdits", label: "Accept edits only", hint: "File edits are allowed; other tools such as shell commands are denied, since nobody is there to approve." },
          ]}
          onChange={(v) => void save({ claudePermissionMode: v })}
        />
      </Row>
      <Row
        stacked
        field="codexSandbox"
        label="Codex sandbox"
        description="How much of your machine Codex can touch in non-read-only workspaces. Applies to new and restarted sessions."
      >
        <Cards
          label="Codex sandbox"
          value={s.codexSandbox}
          options={[
            { value: "danger-full-access", label: "Full access", hint: "No sandbox, network included. Needed for git push and gh from inside the agent." },
            { value: "workspace-write", label: "Workspace write", hint: "Writes limited to the worktree. Pushing and other network use may fail." },
          ]}
          onChange={(v) => void save({ codexSandbox: v })}
        />
      </Row>
      <p className="flex items-center gap-1.5 border-b border-line py-2.5 text-[11.5px] text-mute">
        <Lock className="size-3 shrink-0" /> Read-only profiles (Planner, Reviewer, Ticket writer) are always enforced, whatever is chosen above.
      </p>

      <SubHeading>Routines</SubHeading>
      <Row
        field="routineConcurrency"
        label="Concurrent routine runs"
        description="Scheduled runs wait their turn when this many are already going. Routines only run while Orbit is open."
      >
        <Select
          label="Concurrent routine runs"
          className="min-w-[80px]"
          value={String(s.routineConcurrency)}
          options={[1, 2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(v) => void save({ routineConcurrency: Number(v) })}
        />
      </Row>

      <div className="flex flex-wrap items-center justify-between gap-2 pb-1 pt-5">
        <h3 className="label text-mute">Extra models</h3>
        <Button variant="outline" disabled={modelsLoading} onClick={() => void useApp.getState().loadModels(true)}>
          {modelsLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {modelsLoading ? "Loading models…" : "Refresh models"}
        </Button>
      </div>
      <Row stacked field="extraModelsClaude" label="Claude model ids" description="Added to the model pickers, for example a dated snapshot. Press Enter to add.">
        <TagInput label="Extra Claude models" values={s.extraModelsClaude} placeholder="claude-opus-4-1-20250805" onChange={(v) => void save({ extraModelsClaude: v })} />
      </Row>
      <Row stacked field="extraModelsCodex" label="Codex model ids" description="Added to the model pickers. Press Enter to add.">
        <TagInput label="Extra Codex models" values={s.extraModelsCodex} placeholder="gpt-6-sol-mini" onChange={(v) => void save({ extraModelsCodex: v })} />
      </Row>

      <div className="flex items-center justify-between pb-1 pt-5">
        <h3 className="label text-mute">Diagnostics</h3>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
          {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Re-check
        </Button>
      </div>
      <div className="border-t border-line">
        {error && <p className="py-2.5 text-[12px] text-bad">{error}</p>}
        {!info && !error && <p className="py-2.5 text-[12px] text-mute">Checking installed tools…</p>}
        {info && (
          <>
            <ToolRow
              name="Claude Code"
              tone={claudeTone(info.claude)}
              status={info.claude.ok ? `v${info.claude.version ?? "?"}` : info.claude.path ? "Found, but did not run" : info.claude.error ? "Not verified" : "Not found on PATH"}
              detail={info.claude.path ?? info.claude.error}
            />
            <ToolRow
              name="Codex"
              tone={codexTone(info.codex)}
              status={!info.codex.path ? (info.codex.error ? "Not verified" : "Not found on PATH") : `${info.codex.version ? `v${info.codex.version}` : "Installed"}, ${info.codex.loggedIn ? "signed in" : "not signed in"}`}
              detail={info.codex.path ?? info.codex.error}
            />
            <ToolRow name="git" tone={info.git.version ? "ok" : "bad"} status={info.git.version ? `v${info.git.version}` : "Not found on PATH"} detail={info.git.path} />
          </>
        )}
      </div>
    </>
  );
}
