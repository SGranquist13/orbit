import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { codeApi } from "../../lib/ipc";
import { codeTheme } from "../../lib/code/theme";
import { loadLanguage } from "../../lib/code/languages";
import { minimalChange } from "../../lib/code/helpers";
import { bufferKey, useCode } from "../../stores/code";
import { useApp } from "../../stores/app";
import { Button } from "../ui";
import { Segmented } from "../settings/controls";

const external = Annotation.define<boolean>();
export function DiffView({ root, rel, revision }: { root: string; rel: string; revision: "HEAD" | "base" | "disk" }) {
  const key = bufferKey(root, rel),
    buffer = useCode((s) => s.buffers[key]),
    settings = useApp((s) => s.settings);
  const leftConfig = useRef(new Compartment()),
    host = useRef<HTMLDivElement>(null),
    merge = useRef<MergeView | null>(null),
    config = useRef(new Compartment());
  const [left, setLeft] = useState<{ text: string; missing: boolean } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setError("");
    const request =
      revision === "disk"
        ? codeApi.readFile(root, rel).then((f) => {
            if (f.text === null) throw new Error("Disk version cannot be displayed");
            return f.text;
          })
        : codeApi.fileAt(root, rel, revision);
    void request
      .then((text) => {
        if (!cancelled) setLeft({ text: text ?? "", missing: text === null });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [root, rel, revision, buffer?.mtime]);
  const ready = !!left;
  useLayoutEffect(() => {
    if (!host.current || !left) return;
    const language = [new Compartment(), new Compartment()];
    const view = new MergeView({
      parent: host.current,
      collapseUnchanged: { margin: 3, minSize: 8 },
      highlightChanges: true,
      a: {
        doc: left.text,
        extensions: [
          codeTheme,
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          language[0].of([]),
          leftConfig.current.of([]),
        ],
      },
      b: {
        doc: useCode.getState().buffers[key]?.text ?? "",
        extensions: [
          codeTheme,
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          language[1].of([]),
          config.current.of([]),
          EditorView.domEventHandlers({
            blur: () => {
              if (useApp.getState().settings?.editorAutosave === "focus") useCode.getState().autosave(root, rel);
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet)
              useCode.setState({ selection: u.state.sliceDoc(u.state.selection.main.from, u.state.selection.main.to) });
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external)))
              useCode.getState().updateText(root, rel, u.state.doc.toString());
          }),
        ],
      },
    });
    merge.current = view;
    let live = true;
    void loadLanguage(rel)
      .then((extension) => {
        if (live) {
          view.a.dispatch({ effects: language[0].reconfigure(extension) });
          view.b.dispatch({ effects: language[1].reconfigure(extension) });
        }
      })
      .catch((e) => useApp.getState().setError(String(e)));
    return () => {
      live = false;
      view.destroy();
      merge.current = null;
    };
    // Baseline refreshes update the left editor below, preserving the live editor's history and focus.
  }, [key, revision, ready]);
  useLayoutEffect(() => {
    const view = merge.current;
    if (!view) return;
    const font = EditorView.theme({ "&": { fontSize: `${settings?.editorFontSize ?? 13}px` } }),
      tabSize = settings?.editorTabSize ?? 2,
      wrap = settings?.editorWordWrap ? EditorView.lineWrapping : [];
    view.b.dispatch({
      effects: config.current.reconfigure([font, EditorState.tabSize.of(tabSize), indentUnit.of(" ".repeat(tabSize)), wrap]),
    });
    view.a.dispatch({ effects: leftConfig.current.reconfigure([font, EditorState.tabSize.of(tabSize), wrap]) });
  }, [ready, revision, settings?.editorFontSize, settings?.editorTabSize, settings?.editorWordWrap]);
  useLayoutEffect(() => {
    const editor = merge.current?.a;
    if (editor && left && editor.state.doc.toString() !== left.text)
      editor.dispatch({ changes: minimalChange(editor.state.doc.toString(), left.text) });
  }, [left]);
  useLayoutEffect(() => {
    const editor = merge.current?.b;
    if (editor && buffer && editor.state.doc.toString() !== buffer.text)
      editor.dispatch({
        changes: minimalChange(editor.state.doc.toString(), buffer.text),
        annotations: [external.of(true), Transaction.addToHistory.of(false)],
      });
  }, [buffer?.text, ready, revision]);
  const close = () =>
    useCode.setState((s) => {
      const diffTabs = { ...s.diffTabs };
      delete diffTabs[key];
      return { diffTabs };
    });
  const resolve = (action: Promise<void>) =>
    void action.then(() => {
      if (!useCode.getState().buffers[key]?.diskChanged) close();
    });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-3 py-1 text-[12px] text-mute">
        {revision === "disk" ? (
          <>
            <span>Disk version / Your changes</span>
            <Button onClick={() => resolve(useCode.getState().reloadFromDisk(rel, root, true))}>Use disk version</Button>
            <Button onClick={() => resolve(useCode.getState().keepMine(rel))}>Keep mine</Button>
          </>
        ) : (
          <>
            <Segmented
              label="Compare revision"
              value={revision}
              options={[
                { value: "HEAD", label: "vs HEAD" },
                { value: "base", label: "vs base" },
              ]}
              onChange={(rev) => useCode.setState((s) => ({ diffTabs: { ...s.diffTabs, [key]: rev } }))}
            />
            <span>{left?.missing ? "New file / Working copy" : "Revision / Working copy"}</span>
          </>
        )}
      </div>
      {error && <p className="p-3 text-[12px] text-bad">{error}</p>}
      {!left && !error && <p className="p-3 text-[12px] text-mute">Loading comparison…</p>}
      <div ref={host} className="code-diff min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
