import { useEffect, useState } from "react";
import { api, type EditorInfo } from "../../lib/ipc";
import { Row, Select, TextInput, Toggle, save, useSettings } from "./controls";

export function Editor() {
  const s = useSettings();
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  useEffect(() => {
    api.listEditors().then(setEditors).catch(() => setEditors([]));
  }, []);
  if (!s) return null;
  const cmd = s.editorCommand;
  const isCustom = cmd != null && !editors.some((e) => e.id === cmd);
  const choice = cmd == null ? "" : isCustom ? "__custom" : cmd;
  return (
    <>
      <Row
        label="External editor"
        field="editorCommand"
        description="Used by Open in editor. Custom: a command line; {path} marks where the folder goes (added at the end if missing)"
      >
        <div className="flex flex-col items-end gap-1.5">
          <Select
            label="External editor"
            value={choice}
            options={[
              { value: "", label: "Auto (first detected)" },
              ...editors.map((e) => ({ value: e.id, label: e.name })),
              { value: "__custom", label: "Custom…" },
            ]}
            onChange={(v) => void save({ editorCommand: v === "" ? null : v === "__custom" ? (isCustom ? cmd : "code {path}") : v })}
          />
          {choice === "__custom" && (
            <TextInput label="Custom editor command" value={cmd ?? ""} placeholder="code {path}" className="w-[260px]" onCommit={(v) => void save({ editorCommand: v.trim() === "" ? null : v })} />
          )}
        </div>
      </Row>
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
      <Row label="Show agent edits as they are typed" field="editorLiveTyping">
        <Select
          label="Show agent edits as they are typed"
          value={s.editorLiveTyping ?? "stream"}
          options={[
            { value: "stream", label: "Live typing" },
            { value: "instant", label: "Instant" },
          ]}
          onChange={(v) => void save({ editorLiveTyping: v })}
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
