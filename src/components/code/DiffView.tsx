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

import { samePath } from "../../lib/code/agentEdits";

import { baselineKey, bufferKey, useCode, type AgentActivity } from "../../stores/code";

import { useApp } from "../../stores/app";

import { Button } from "../ui";

import { editorSelection } from "./AskSelection";

import { Segmented } from "../settings/controls";

const external = Annotation.define<boolean>();

export function DiffView({
  root,
  rel,
  revision,
  activity,
}: {
  root: string;
  rel: string;
  revision: "HEAD" | "base" | "disk";
  activity?: AgentActivity;
}) {
  const key = bufferKey(root, rel),
    buffer = useCode((s) => s.buffers[key]),
    settings = useApp((s) => s.settings);

  const baseline = useCode((s) => (activity ? s.baselines[baselineKey(activity)] : undefined));

  const codeRoot = useCode((s) => s.roots.find((r) => r.path === root));

  const ws = useApp((s) => s.workspaces.find((w) => w.id === codeRoot?.workspaceId || samePath(w.path, root)));

  const turn = useCode((s) => (ws ? s.turns[ws.id] : undefined));

  const readonly = !!activity || (codeRoot?.mode === "watch" && (turn?.running ?? ws?.status === "running"));

  const leftConfig = useRef(new Compartment()),
    host = useRef<HTMLDivElement>(null),
    merge = useRef<MergeView | null>(null),
    config = useRef(new Compartment());

  const [left, setLeft] = useState<{ text: string; missing: boolean } | null>(null),
    [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    setError("");

    const request = activity
      ? Promise.resolve(baseline ?? "")
      : revision === "disk"
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
  }, [root, rel, revision, buffer?.mtime, baseline, activity]);

  const ready = !!left;

  const askKey = EditorView.domEventHandlers({
    keydown: (event, editor) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" || event.shiftKey || event.altKey) return false;

      event.preventDefault();
      event.stopPropagation();

      window.dispatchEvent(new CustomEvent("orbit-code-editor", { detail: { selection: editorSelection(editor, root, rel) } }));

      return true;
    },
  });

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

          askKey,

          lineNumbers(),

          EditorState.readOnly.of(true),

          EditorView.editable.of(false),

          language[0].of([]),

          leftConfig.current.of([]),
        ],
      },

      b: {
        doc: activity?.removed ? "" : (useCode.getState().buffers[key]?.text ?? ""),

        extensions: [
          codeTheme,

          askKey,

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
      effects: config.current.reconfigure([
        EditorState.readOnly.of(!!readonly),
        font,
        EditorState.tabSize.of(tabSize),
        indentUnit.of(" ".repeat(tabSize)),
        wrap,
      ]),
    });

    view.a.dispatch({ effects: leftConfig.current.reconfigure([font, EditorState.tabSize.of(tabSize), wrap]) });
  }, [ready, revision, readonly, settings?.editorFontSize, settings?.editorTabSize, settings?.editorWordWrap]);

  useLayoutEffect(() => {
    const editor = merge.current?.a;

    if (editor && left && editor.state.doc.toString() !== left.text)
      editor.dispatch({ changes: minimalChange(editor.state.doc.toString(), left.text) });
  }, [left]);

  useLayoutEffect(() => {
    const editor = merge.current?.b;

    const text = activity?.removed ? "" : buffer?.text;
    if (editor && text !== undefined && editor.state.doc.toString() !== text)
      editor.dispatch({
        changes: minimalChange(editor.state.doc.toString(), text),

        annotations: [external.of(true), Transaction.addToHistory.of(false)],
      });
  }, [buffer?.text, ready, revision, activity?.removed]);

  const close = () =>
    useCode.setState((s) => {
      const diffTabs = { ...s.diffTabs };

      delete diffTabs[key];

      return { diffTabs, agentDiff: null };
    });

  const resolve = (action: Promise<void>) =>
    void action.then(() => {
      if (!useCode.getState().buffers[key]?.diskChanged) close();
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-3 py-1 text-[12px] text-mute">
        <Button onClick={close}>Back to file</Button>

        {activity ? (
          <span>Agent changes · Turn {activity.turn} / Current file</span>
        ) : revision === "disk" ? (
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
