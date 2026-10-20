import { useKeybindingLabels } from "../../lib/useKeybinding";
import type { AgentKind } from "../../lib/ipc";
import { defaultModelFor, modelLabelFor, modelsFor } from "../../lib/settings";
import { useTheme, type ThemeMode } from "../../lib/theme";
import { Row, Segmented, Select, Toggle, save, useSettings } from "./controls";
import { useApp } from "../../stores/app";

export function General() {
  const modelLists = useApp((s) => s.agentModels);
  const keyLabel = useKeybindingLabels();
  const s = useSettings();
  const mode = useTheme((t) => t.mode);
  if (!s) return null;

  const modelSelect = (agent: AgentKind) => {
    const current = defaultModelFor(agent, s);
    const options = modelsFor(agent, s, modelLists);
    if (!options.includes(current)) options.push(current);
    const field = agent === "claude" ? "defaultModelClaude" : "defaultModelCodex";
    return (
      <Row label={`Default ${agent === "claude" ? "Claude" : "Codex"} model`} field={field}>
        <Select
          label={`Default ${agent} model`}
          value={current}
          options={options.map((m) => ({ value: m, label: modelLabelFor(agent, m, modelLists) || "Agent default" }))}
          onChange={(v) => void save({ [field]: v })}
        />
      </Row>
    );
  };

  return (
    <>
      <Row label="Theme" description={"System follows your OS." + (keyLabel("workbench.theme") ? ` ${keyLabel("workbench.theme")} flips between dark and light.` : "")}>
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
