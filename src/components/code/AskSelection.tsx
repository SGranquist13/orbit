import { useState } from "react";
import type { EditorView } from "@codemirror/view";
import { selectionMessage } from "../../lib/code/helpers";
import { api } from "../../lib/ipc";
import { samePath } from "../../lib/code/agentEdits";
import { useApp } from "../../stores/app";
import { useCode } from "../../stores/code";
import { Button } from "../ui";

export interface SelectionQuestion {
  root: string;
  rel: string;
  from: number;
  to: number;
  text: string;
  x: number;
  y: number;
}
export function editorSelection(editor: EditorView, root: string, rel: string): SelectionQuestion {
  const selection = editor.state.selection.main;
  const from = editor.state.doc.lineAt(selection.from);
  const to = editor.state.doc.lineAt(selection.to > selection.from ? selection.to - 1 : selection.to);
  const coords = editor.coordsAtPos(selection.to);
  return {
    root,
    rel,
    from: from.number,
    to: to.number,
    text: selection.empty ? from.text : editor.state.sliceDoc(selection.from, selection.to),
    x: Math.max(12, Math.min(coords?.left ?? 300, window.innerWidth - 380)),
    y: Math.max(12, Math.min((coords?.bottom ?? 200) + 6, window.innerHeight - 250)),
  };
}
export function AskSelection({ selection, close }: { selection: SelectionQuestion; close: () => void }) {
  const root = useCode((s) => s.roots.find((r) => r.path === selection.root));
  const workspace = useApp((s) => s.workspaces.find((w) => w.id === root?.workspaceId || samePath(w.path, selection.root)));
  const [target, setTarget] = useState(workspace?.id ?? "new");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    if (!question.trim() || busy) return;
    const message = selectionMessage(selection, question);
    if (target === "new") {
      const repo = useApp.getState().repos.find((r) => r.id === workspace?.repoId || samePath(r.path, selection.root));
      useApp.setState({ newWorkspacePrefill: { prompt: message, repoId: repo?.id }, newWorkspaceOpen: true });
      close();
      return;
    }
    setBusy(true);
    try {
      await api.sendMessage(target, message);
      useCode.getState().setMode(selection.root, "watch");
      close();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <div
      role="dialog"
      aria-label="Ask about selection"
      style={{ left: selection.x, top: selection.y }}
      className="fixed z-40 w-[360px] max-w-[calc(100vw-24px)] rounded-[4px] border-[1.5px] border-line-strong bg-raised p-3 shadow-hard"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
        if (e.target instanceof HTMLTextAreaElement && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void send();
        }
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-[12px] text-mute">
        <span>
          {selection.to !== selection.from ? `Lines ${selection.from}–${selection.to}` : `Line ${selection.from}`}
        </span>
        <select
          aria-label="Target workspace"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="min-w-0 max-w-52 rounded-[3px] border border-line bg-panel px-2 py-1 text-fg"
        >
          {workspace && <option value={workspace.id}>{workspace.name}</option>}
          <option value="new">New workspace</option>
        </select>
      </div>
      <textarea
        autoFocus
        aria-label="Question about selection"
        placeholder="Ask or instruct the agent about these lines..."
        rows={3}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        className="w-full resize-y rounded-[3px] border border-line bg-bg p-2 text-[13px] outline-none focus:border-line-strong"
      />
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-bad">
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="mr-auto text-[11px] text-mute">Enter to send · Shift Enter for a new line</span>
        <Button onClick={close}>Cancel</Button>
        <Button disabled={busy || !question.trim()} onClick={() => void send()}>
          {target === "new" ? "Continue" : "Send"}
        </Button>
      </div>
    </div>
  );
}
