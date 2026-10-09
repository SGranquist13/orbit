import { useState } from "react";
import type { AgentKind } from "../../lib/ipc";
import { defaultModelFor, modelsFor, normalizePrefix } from "../../lib/settings";
import { useTheme, type ThemeMode } from "../../lib/theme";
import { Row, Segmented, Select, TextInput, Toggle, save, useSettings } from "./controls";

export function General() {
  const s = useSettings();
  const mode = useTheme((t) => t.mode);
  const [draftPrefix, setDraftPrefix] = useState<string | null>(null);
  if (!s) return null;
  const prefix = draftPrefix === null ? s.branchPrefix : normalizePrefix(draftPrefix);

  const modelSelect = (agent: AgentKind) => {
    const current = defaultModelFor(agent, s);
    const options = modelsFor(agent, s);
    if (!options.includes(current)) options.push(current);
    const field = agent === "claude" ? "defaultModelClaude" : "defaultModelCodex";
    return (
      <Row label={`Default ${agent === "claude" ? "Claude" : "Codex"} model`} field={field}>
        <Select
          label={`Default ${agent} model`}
          value={current}
          options={options.map((m) => ({ value: m, label: m || "Agent default" }))}
          onChange={(v) => void save({ [field]: v })}
        />
      </Row>
    );
  };

  return (
    <>
      <Row label="Theme" description="System follows your OS. Ctrl Shift L flips between dark and light.">
        <Segmented<ThemeMode>
          label="Theme"
          value={mode}
          options={[
            { value: "system", label: "System" },
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
          onChange={(v) => useTheme.getState().setMode(v)}
        />
      </Row>
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
      <Row label="Default agent" field="defaultAgent" description="Pre-selected in New workspace, and used by Issues and New ticket.">
        <Segmented<AgentKind>
          label="Default agent"
          value={s.defaultAgent}
          options={[
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
          ]}
          onChange={(v) => void save({ defaultAgent: v })}
        />
      </Row>
      {modelSelect("claude")}
      {modelSelect("codex")}
      <Row label="Desktop notifications" field="notifications" description="Notify when an agent finishes a turn or fails.">
        <Toggle label="Desktop notifications" checked={s.notifications} onChange={(v) => void save({ notifications: v })} />
      </Row>
      <Row label="Only when Orbit is not focused" field="notifyOnlyUnfocused" description="Skip notifications while you are looking at the window.">
        <Toggle
          label="Only when Orbit is not focused"
          disabled={!s.notifications}
          checked={s.notifyOnlyUnfocused}
          onChange={(v) => void save({ notifyOnlyUnfocused: v })}
        />
      </Row>
    </>
  );
}
