import { useEffect, useState } from "react";
import { api, type CheckCommandInfo, type Repo, type Settings } from "../../lib/ipc";
import { normalizePrefix } from "../../lib/settings";
import { useApp } from "../../stores/app";
import { WorktreeSetup } from "./WorktreeSetup";
import { Row, Segmented, Select, SubHeading, TextInput, Toggle, save, useSettings } from "./controls";

/** Preset choices plus the current value if it isn't one of them (e.g. set by hand in the database). */
function numberOptions(current: number, presets: number[], label: (n: number) => string) {
  const all = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
  return all.map((n) => ({ value: String(n), label: label(n) }));
}

export function Git() {
  const s = useSettings();
  const repos = useApp((st) => st.repos);
  const [draftPrefix, setDraftPrefix] = useState<string | null>(null);
  if (!s) return null;
  const prefix = draftPrefix === null ? s.branchPrefix : normalizePrefix(draftPrefix);
  const num = (field: "syncIntervalMinutes" | "staleDays" | "staleBehind") => (v: string) => void save({ [field]: Number(v) } as Partial<Settings>);

  return (
    <>
      <SubHeading>Branches</SubHeading>
      <Row
        label="Branch prefix"
        field="branchPrefix"
        description={
          <>
            Prepended to the branch of every new workspace, for example{" "}
            <span className="font-medium text-dim">{prefix}fix-login-3fa2</span>. Leave empty for none.
          </>
        }
      >
        <TextInput
          label="Branch prefix"
          value={s.branchPrefix}
          placeholder="none"
          onDraft={setDraftPrefix}
          onCommit={(v) => {
            setDraftPrefix(null);
            void save({ branchPrefix: v });
          }}
        />
      </Row>

      <SubHeading>Commits</SubHeading>
      <Row
        label="Save points"
        field="saveCommits"
        description="After each agent turn that changed files, Orbit commits the worktree as a wip: commit. Any turn can then be undone, and work is never only on disk."
      >
        <Toggle label="Save points" checked={s.saveCommits} onChange={(v) => void save({ saveCommits: v })} />
      </Row>
      <Row
        label="Save-point messages"
        field="commitMessages"
        description="How each wip: save point is worded. From the prompt uses the first line of your message. Written by a model reads the staged diff and your message and writes a real subject, using the model chosen for Commit messages in Settings > Models (it can be local). A call slower than the local timeout falls back to the prompt."
      >
        <Segmented<Settings["commitMessages"]>
          label="Save-point messages"
          value={s.commitMessages}
          options={[
            { value: "prompt", label: "From the prompt" },
            { value: "model", label: "Written by a model" },
          ]}
          onChange={(v) => void save({ commitMessages: v })}
        />
      </Row>
      <Row
        label="Squash save points before Ship"
        field="squashWip"
        description="Folds Orbit's unpushed wip: commits back into one staged change so the agent's ship writes clean conventional commits. Commits the agent made itself are never touched."
      >
        <Toggle label="Squash save points before Ship" checked={s.squashWip} onChange={(v) => void save({ squashWip: v })} />
      </Row>

      <SubHeading>Checks</SubHeading>
      <Row
        label="Checks before Ship"
        field="checksMode"
        description="Block refuses to ship a failing branch (the inbox offers Fix checks and Ship anyway). Warn still ships but flags it in the inbox. Off never runs them."
      >
        <Segmented<Settings["checksMode"]>
          label="Checks before Ship"
          value={s.checksMode}
          options={[
            { value: "off", label: "Off" },
            { value: "warn", label: "Warn" },
            { value: "block", label: "Block" },
          ]}
          onChange={(v) => void save({ checksMode: v })}
        />
      </Row>
      <Row
        label="Check timeout"
        field="checkTimeoutMinutes"
        description="A check (or the dependency install before it) that runs longer than this is killed and reported as timed out."
      >
        <Select
          label="Check timeout"
          value={String(s.checkTimeoutMinutes)}
          options={numberOptions(s.checkTimeoutMinutes, [1, 5, 10, 20, 30, 60], (n) => `${n} min`)}
          onChange={(v) => void save({ checkTimeoutMinutes: Number(v) })}
        />
      </Row>
      <Row
        label="Install dependencies before checks"
        field="installBeforeChecks"
        description="A fresh worktree has no node_modules, so a JavaScript check would fail for the wrong reason. Orbit runs the matching install (bun, pnpm, yarn or npm ci) once first. An install failure is reported as such, not as a code failure."
      >
        <Toggle label="Install dependencies before checks" checked={s.installBeforeChecks} onChange={(v) => void save({ installBeforeChecks: v })} />
      </Row>
      {repos.map((r) => (
        <CheckCommandRow key={r.id} repo={r} />
      ))}
      {repos.length === 0 && <p className="py-3 text-[12px] text-mute">Add a repository to set its check command.</p>}

      <WorktreeSetup />

      <SubHeading>Simplify</SubHeading>
      <Row
        label="Model for finding simplifications"
        field="simplifyModel"
        description="The read-only pass that looks over a workspace's changes always runs through Claude, whichever agent the workspace uses. The edits themselves go to the workspace's own agent."
      >
        <Segmented<Settings["simplifyModel"]>
          label="Model for finding simplifications"
          value={s.simplifyModel}
          options={[
            { value: "haiku", label: "Haiku" },
            { value: "sonnet", label: "Sonnet" },
            { value: "opus", label: "Opus" },
          ]}
          onChange={(v) => void save({ simplifyModel: v })}
        />
      </Row>
      <Row label="Most simplifications to list" field="simplifyMaxCandidates" description="Caps how many candidates one pass may return, most valuable first.">
        <Select
          label="Most simplifications to list"
          value={String(s.simplifyMaxCandidates)}
          options={numberOptions(s.simplifyMaxCandidates, [5, 8, 12, 20, 30], (n) => String(n))}
          onChange={(v) => void save({ simplifyMaxCandidates: Number(v) })}
        />
      </Row>
      <Row
        label="Show “Apply all low-risk”"
        field="simplifyLowRiskButton"
        description="A shortcut in the Simplify panel that applies every low-risk candidate in one go. Each is still checked and committed separately."
      >
        <Toggle label="Show Apply all low-risk" checked={s.simplifyLowRiskButton} onChange={(v) => void save({ simplifyLowRiskButton: v })} />
      </Row>

      <SubHeading>Staying close to base</SubHeading>
      <Row
        label="Keep branches in sync with base"
        field="syncMode"
        description="Automatic rebases idle, clean workspaces onto the base branch when it moves (never while an agent is running; conflicts go to the inbox). Suggest only records how far behind each branch is and leaves the rebase to you. Off does nothing."
      >
        <Segmented<Settings["syncMode"]>
          label="Keep branches in sync with base"
          value={s.syncMode}
          options={[
            { value: "off", label: "Off" },
            { value: "suggest", label: "Suggest only" },
            { value: "auto", label: "Automatic" },
          ]}
          onChange={(v) => void save({ syncMode: v })}
        />
      </Row>
      <Row label="Sync interval" field="syncIntervalMinutes" description="How often Orbit fetches the base branch. It also syncs right after one of your workspaces merges.">
        <Select
          label="Sync interval"
          value={String(s.syncIntervalMinutes)}
          options={numberOptions(s.syncIntervalMinutes, [1, 5, 10, 15, 30, 60], (n) => `${n} min`)}
          onChange={num("syncIntervalMinutes")}
        />
      </Row>
      <Row label="Flag stale branches after" field="staleDays" description="Branches open this long show up in the inbox. Short-lived branches merge faster and conflict less.">
        <Select
          label="Stale after days"
          value={String(s.staleDays)}
          options={numberOptions(s.staleDays, [0, 1, 3, 7, 14], (n) => (n === 0 ? "Never" : `${n} day${n === 1 ? "" : "s"}`))}
          onChange={num("staleDays")}
        />
      </Row>
      <Row label="Flag branches behind base by" field="staleBehind" description="Also flagged when this many commits behind the base branch.">
        <Select
          label="Stale when behind"
          value={String(s.staleBehind)}
          options={numberOptions(s.staleBehind, [0, 10, 20, 50, 100], (n) => (n === 0 ? "Never" : `${n} commits`))}
          onChange={num("staleBehind")}
        />
      </Row>

      <SubHeading>Merging</SubHeading>
      <Row label="Merge method" field="mergeMethod" description="Used by the Merge button in the Ship panel.">
        <Segmented<Settings["mergeMethod"]>
          label="Merge method"
          value={s.mergeMethod}
          options={[
            { value: "squash", label: "Squash" },
            { value: "merge", label: "Merge commit" },
            { value: "rebase", label: "Rebase" },
          ]}
          onChange={(v) => void save({ mergeMethod: v })}
        />
      </Row>
      <Row label="Delete remote branch after merge" field="deleteBranchOnMerge" description="Removes the branch on GitHub.">
        <Toggle label="Delete remote branch after merge" checked={s.deleteBranchOnMerge} onChange={(v) => void save({ deleteBranchOnMerge: v })} />
      </Row>
      <Row
        label="Archive after merge"
        field="archiveOnMerge"
        description="Archives the workspace and removes its worktree once its PR merges. Skipped if the worktree has uncommitted or unpushed work."
      >
        <Toggle label="Archive after merge" checked={s.archiveOnMerge} onChange={(v) => void save({ archiveOnMerge: v })} />
      </Row>
      <Row
        label="Delete local branch after merge"
        field="deleteLocalBranch"
        description="Also deletes the local branch when archiving. Off keeps it so the workspace can be restored from Settings > Data."
      >
        <Toggle
          label="Delete local branch after merge"
          checked={s.deleteLocalBranch}
          disabled={!s.archiveOnMerge}
          onChange={(v) => void save({ deleteLocalBranch: v })}
        />
      </Row>
    </>
  );
}

/** One repo's check command: the override if set, otherwise the detected command shown as a placeholder. */
function CheckCommandRow({ repo }: { repo: Repo }) {
  const [info, setInfo] = useState<CheckCommandInfo | null>(null);
  const setError = useApp.getState().setError;
  useEffect(() => {
    api.getCheckCommand(repo.id).then(setInfo).catch((e) => setError(String(e)));
  }, [repo.id, setError]);
  return (
    <Row
      label={`Check command: ${repo.name}`}
      description={
        info?.detected || info?.override
          ? "Run before Ship and by Simplify. Leave empty to use the detected command."
          : "Nothing detected for this repo. Without a command, Ship skips checks."
      }
    >
      <TextInput
        label={`Check command for ${repo.name}`}
        value={info?.override ?? ""}
        placeholder={info?.detected ?? "none detected"}
        className="w-[260px]"
        onCommit={(v) => {
          const cmd = v.trim() || null;
          api
            .setCheckCommand(repo.id, cmd)
            .then(() => setInfo((i) => (i ? { ...i, override: cmd } : i)))
            .catch((e) => setError(String(e)));
        }}
      />
    </Row>
  );
}
