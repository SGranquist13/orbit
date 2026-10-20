import { api, type EditorInfo } from "./ipc";
import { useApp } from "../stores/app";

/** Display name for the editor the setting resolves to (custom command lines show as "your editor"). */
export function editorLabel(editors: EditorInfo[], command: string | null | undefined): string {
  if (!command) return editors[0]?.name ?? "editor";
  return editors.find((e) => e.id === command)?.name ?? "custom editor";
}

/** Open the selected workspace's worktree in the external editor; failures go to the error toast. */
export function openSelectedInEditor(editor?: string) {
  const s = useApp.getState();
  const ws = s.workspaces.find((w) => w.id === s.selectedId);
  if (!ws) return;
  api.openInEditor(ws.path, editor).catch((e) => s.setError(String(e).replace(/^Error:\s*/, "")));
}
