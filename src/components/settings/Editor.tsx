import { Row, Select, TextInput, Toggle, save, useSettings } from "./controls";

export function Editor() {
  const s = useSettings();
  if (!s) return null;
  return (
    <>
      <Row label="Font size" field="editorFontSize">
        <Select
          label="Editor font size"
          value={String(s.editorFontSize)}
          options={Array.from({ length: 20 }, (_, i) => ({ value: String(i + 9), label: `${i + 9} px` }))}
          onChange={(v) => void save({ editorFontSize: Number(v) })}
        />
      </Row>
      <Row label="Tab size" field="editorTabSize">
        <Select
          label="Editor tab size"
          value={String(s.editorTabSize)}
          options={Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} spaces` }))}
          onChange={(v) => void save({ editorTabSize: Number(v) })}
        />
      </Row>
      <Row label="Word wrap" field="editorWordWrap">
        <Toggle label="Word wrap" checked={s.editorWordWrap} onChange={(v) => void save({ editorWordWrap: v })} />
      </Row>
      <Row label="Autosave" field="editorAutosave">
        <Select
          label="Autosave"
          value={s.editorAutosave}
          options={[
            { value: "off", label: "Off" },
            { value: "delay", label: "After a pause" },
            { value: "focus", label: "When focus leaves" },
          ]}
          onChange={(v) => void save({ editorAutosave: v })}
        />
      </Row>
      <Row
        label="Follow the agent while it works"
        field="editorFollowAgent"
        description="Workspace folders open in Watch mode while their agent runs"
      >
        <Toggle
          label="Follow the agent while it works"
          checked={s.editorFollowAgent}
          onChange={(v) => void save({ editorFollowAgent: v })}
        />
      </Row>
      <Row label="Terminal shell" field="terminalShell" stacked>
        <TextInput
          label="Terminal shell"
          value={s.terminalShell}
          placeholder="Automatic (pwsh, PowerShell, then cmd)"
          className="w-full"
          onCommit={(v) => void save({ terminalShell: v })}
        />
      </Row>
    </>
  );
}
