import { useEffect, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, search, gotoLine, openSearchPanel } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completeAnyWord } from "@codemirror/autocomplete";
import { openPath } from "@tauri-apps/plugin-opener";
import { codeTheme } from "../../lib/code/theme";
import { loadLanguage } from "../../lib/code/languages";
import { minimalChange } from "../../lib/code/helpers";
import { bufferKey, useCode } from "../../stores/code";
import { useApp } from "../../stores/app";
import { Button } from "../ui";

const states = new Map<string, { state: EditorState; top: number; left: number; settings: Compartment; language: Compartment }>();
const diskReload = Annotation.define<boolean>();
useCode.subscribe((s) => {
  for (const key of states.keys()) if (!s.buffers[key]) states.delete(key);
});

export function EditorPane() {
  const root = useCode((s) => s.activeRoot),
    rel = useCode((s) => s.roots.find((r) => r.path === s.activeRoot)?.activeRel);
  const key = root && rel ? bufferKey(root, rel) : "",
    buffer = useCode((s) => s.buffers[key]);
  const settings = useApp((s) => s.settings);
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    currentKey = useRef("");
  const fontSize = settings?.editorFontSize ?? 13,
    tabSize = settings?.editorTabSize ?? 2,
    wrap = settings?.editorWordWrap ?? false;
  useEffect(() => {
    const action = (e: Event) => {
      if (!view.current || !currentKey.current) return;
      view.current.focus();
      if ((e as CustomEvent).detail === "Go to line") gotoLine(view.current);
      else openSearchPanel(view.current);
    };
    window.addEventListener("orbit-code-editor", action);
    return () => window.removeEventListener("orbit-code-editor", action);
  }, []);
  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current });
    view.current = editor;
    return () => {
      const entry = states.get(currentKey.current);
      if (entry) {
        entry.state = editor.state;
        entry.top = editor.scrollDOM.scrollTop;
        entry.left = editor.scrollDOM.scrollLeft;
      }
      editor.destroy();
      view.current = null;
      currentKey.current = "";
    };
  }, []);
  const visible = !!buffer && !buffer.loading && !buffer.error && !buffer.binary && !buffer.tooLarge;
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const previous = states.get(currentKey.current);
    if (previous && currentKey.current !== key) {
      previous.state = editor.state;
      previous.top = editor.scrollDOM.scrollTop;
      previous.left = editor.scrollDOM.scrollLeft;
    }
    if (!visible || !root || !rel || !buffer) {
      currentKey.current = "";
      return;
    }
    let entry = states.get(key);
    if (!entry) {
      const config = new Compartment(),
        language = new Compartment();
      entry = {
        top: 0,
        left: 0,
        settings: config,
        language,
        state: EditorState.create({
          doc: buffer.text,
          extensions: [
            codeTheme,
            lineNumbers(),
            foldGutter(),
            history(),
            drawSelection(),
            highlightActiveLine(),
            bracketMatching(),
            closeBrackets(),
            indentOnInput(),
            autocompletion({ override: [completeAnyWord] }),
            search({ top: true }),
            config.of([]),
            language.of([]),
            keymap.of([
              { key: "Mod-g", run: gotoLine },
              { key: "Mod-h", run: openSearchPanel },
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...historyKeymap,
              ...searchKeymap,
              ...foldKeymap,
              ...completionKeymap,
              indentWithTab,
            ]),
            EditorView.updateListener.of((update) => {
              const cached = states.get(key);
              if (cached) cached.state = update.state;
              if (update.docChanged && !update.transactions.some((t) => t.annotation(diskReload)))
                useCode.getState().updateText(root, rel, update.state.doc.toString());
            }),
          ],
        }),
      };
      states.set(key, entry);
    }
    if (currentKey.current !== key) {
      currentKey.current = key;
      editor.setState(entry.state);
      editor.scrollDOM.scrollTop = entry.top;
      editor.scrollDOM.scrollLeft = entry.left;
      editor.focus();
    }
    void loadLanguage(rel)
      .then((extension) => {
        const cached = states.get(key);
        if (!cached) return;
        if (view.current && currentKey.current === key)
          view.current.dispatch({ effects: cached.language.reconfigure(extension) });
        else cached.state = cached.state.update({ effects: cached.language.reconfigure(extension) }).state;
      })
      .catch((e) => useApp.getState().setError(String(e)));
  }, [key, visible]);
  useLayoutEffect(() => {
    const editor = view.current,
      cached = states.get(key);
    if (!editor || !visible || !cached || currentKey.current !== key) return;
    editor.dispatch({
      effects: cached.settings.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(" ".repeat(tabSize)),
        wrap ? EditorView.lineWrapping : [],
        EditorView.theme({ "&": { fontSize: `${fontSize}px` } }),
      ]),
    });
  }, [key, visible, fontSize, tabSize, wrap]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || !buffer || !visible || currentKey.current !== key || editor.state.doc.toString() === buffer.text) return;
    const top = editor.scrollDOM.scrollTop,
      left = editor.scrollDOM.scrollLeft;
    editor.dispatch({
      changes: minimalChange(editor.state.doc.toString(), buffer.text),
      annotations: [Transaction.addToHistory.of(false), diskReload.of(true)],
    });
    editor.scrollDOM.scrollTop = top;
    editor.scrollDOM.scrollLeft = left;
  }, [key, buffer?.text, visible]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {buffer?.diskChanged && buffer.dirty && (
        <div role="status" className="flex items-center gap-3 border-b-[1.5px] border-line bg-panel px-4 py-2 text-[12px]">
          <span className="text-warn">Changed on disk.</span>
          <Button onClick={() => void useCode.getState().reloadFromDisk(rel!, root!, true)}>Reload</Button>
          <Button onClick={() => void useCode.getState().keepMine(rel!)}>Keep mine</Button>
          {/* TODO: Compare action when diff panel lands. */}
        </div>
      )}
      {!rel ? (
        <div className="grid flex-1 place-items-center text-[13px] text-mute">Select a file to start editing</div>
      ) : !buffer || buffer.loading ? (
        <div className="p-6 text-[12px] text-mute">Loading file…</div>
      ) : buffer.error ? (
        <div className="p-6 text-[12px]">
          <p className="text-bad">{buffer.error}</p>
          <Button onClick={() => void useCode.getState().reloadFromDisk(rel, root!)}>Retry</Button>
        </div>
      ) : buffer.binary || buffer.tooLarge ? (
        <div className="grid flex-1 place-items-center">
          <div className="rounded-[4px] border-[1.5px] border-line bg-panel p-6 text-center">
            <p className="mb-3 text-[14px] font-medium">Can't show this file here</p>
            <p className="mb-4 text-[12px] text-mute">
              {buffer.binary ? "This is a binary file." : "This file is larger than 5 MB."}
            </p>
            <Button onClick={() => void openPath(`${root}/${rel}`).catch((e) => useApp.getState().setError(String(e)))}>
              Open externally
            </Button>
          </div>
        </div>
      ) : null}
      <div ref={host} className={visible ? "min-h-0 flex-1 overflow-hidden" : "hidden"} />
    </div>
  );
}
