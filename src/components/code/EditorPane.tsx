import { editorKeymap, plainBindings } from "../../lib/code/keymap";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Annotation, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, search, gotoLine, openSearchPanel } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { openPath } from "@tauri-apps/plugin-opener";
import { codeApi } from "../../lib/ipc";
import { samePath } from "../../lib/code/agentEdits";
import { agentMarks, setAgentMarks, clearAgentMarks, clearAgentFlash } from "../../lib/code/agentMarks";
import { AskSelection, editorSelection, type SelectionQuestion } from "./AskSelection";
import { gitGutter } from "../../lib/code/gitGutter";
import { DiffView } from "./DiffView";
import { codeTheme } from "../../lib/code/theme";
import { loadLanguage } from "../../lib/code/languages";
import { setTyping, typingDecorations } from "../../lib/code/typingDecorations";
import { minimalChange } from "../../lib/code/helpers";
import { bufferKey, useCode } from "../../stores/code";
import { useApp } from "../../stores/app";
import { Button } from "../ui";

interface CachedEditor {
  state: EditorState;
  top: number;
  left: number;
  settings: Compartment;
  language: Compartment;
  git: Compartment;
  readonly: Compartment;
  markEpoch: number;
  markNonce?: number;
}
const states = new Map<string, CachedEditor>();
const diskReload = Annotation.define<boolean>();
useCode.subscribe((s) => {
  for (const key of states.keys()) if (!s.buffers[key]) states.delete(key);
});

export function EditorPane() {
  const root = useCode((s) => s.activeRoot),
    rel = useCode((s) => s.roots.find((r) => r.path === s.activeRoot)?.activeRel);
  const key = root && rel ? bufferKey(root, rel) : "",
    buffer = useCode((s) => s.buffers[key]);
  const preview = useCode((s) => s.previews[key]);
  const shownText = preview?.text ?? buffer?.text;
  const revision = useCode((s) => s.diffTabs[key]);
  const jump = useCode((s) => s.jump);
  const codeRoot = useCode((s) => s.roots.find((r) => r.path === root));
  const workspace = useApp((s) => s.workspaces.find((w) => w.id === codeRoot?.workspaceId || (!!root && samePath(w.path, root))));
  const turn = useCode((s) => (workspace ? s.turns[workspace.id] : undefined));
  const readonly = !!preview || (codeRoot?.mode === "watch" && (turn?.running || workspace?.status === "running"));
  const marks = useCode((s) => s.marks[key]);
  const epoch = useCode((s) => s.markEpoch);
  const agentDiff = useCode((s) => s.agentDiff);
  const showingAgentDiff = agentDiff?.root === root && agentDiff?.rel === rel;
  const [hint, setHint] = useState(false);
  const [ask, setAsk] = useState<SelectionQuestion | null>(null);
  const settings = useApp((s) => s.settings);
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    currentKey = useRef("");
  const followBottom = useRef(true);
  const fontSize = settings?.editorFontSize ?? 13,
    tabSize = settings?.editorTabSize ?? 2,
    wrap = settings?.editorWordWrap ?? false;
  const openAsk = () => {
    const editor = view.current;
    if (!editor || !root || !rel || !visible) return;
    setAsk(editorSelection(editor, root, rel));
  };
  useEffect(() => {
    const action = (e: Event) => {
      if (!view.current || !currentKey.current) return;
      if ((e as CustomEvent).detail?.selection) {
        setAsk((e as CustomEvent).detail.selection);
        return;
      }
      if ((e as CustomEvent).detail === "Ask about selection") {
        openAsk();
        return;
      }
      view.current.focus();
      if ((e as CustomEvent).detail === "Go to line") gotoLine(view.current);
      else openSearchPanel(view.current);
    };
    window.addEventListener("orbit-code-editor", action);
    return () => window.removeEventListener("orbit-code-editor", action);
  });
  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current });
    view.current = editor;
    let userScroll = false;
    const scrollIntent = () => {
      userScroll = true;
    };
    const wheel = (event: WheelEvent) => {
      userScroll = true;
      if (event.deltaY < 0) followBottom.current = false;
    };
    const scrolled = () => {
      const bottom = editor.scrollDOM.scrollHeight - editor.scrollDOM.scrollTop - editor.scrollDOM.clientHeight < 40;
      if (bottom) {
        followBottom.current = true;
        userScroll = false;
      } else if (userScroll) followBottom.current = false;
    };
    editor.scrollDOM.addEventListener("scroll", scrolled);
    editor.scrollDOM.addEventListener("wheel", wheel, { passive: true });
    editor.scrollDOM.addEventListener("pointerdown", scrollIntent);
    editor.scrollDOM.addEventListener("touchstart", scrollIntent, { passive: true });
    editor.scrollDOM.addEventListener("keydown", scrollIntent);

    return () => {
      const entry = states.get(currentKey.current);
      if (entry) {
        entry.state = editor.state;
        entry.top = editor.scrollDOM.scrollTop;
        entry.left = editor.scrollDOM.scrollLeft;
      }
      editor.scrollDOM.removeEventListener("scroll", scrolled);
      editor.scrollDOM.removeEventListener("wheel", wheel);
      editor.scrollDOM.removeEventListener("pointerdown", scrollIntent);
      editor.scrollDOM.removeEventListener("touchstart", scrollIntent);
      editor.scrollDOM.removeEventListener("keydown", scrollIntent);
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
        language = new Compartment(),
        git = new Compartment(),
        readonly = new Compartment();
      entry = {
        top: 0,
        left: 0,
        settings: config,
        language,
        git,
        readonly,
        markEpoch: -1,
        state: EditorState.create({
          doc: shownText ?? buffer.text,
          extensions: [
            codeTheme,
            agentMarks,
            typingDecorations,
            git.of([]),
            readonly.of([]),
            lineNumbers(),
            foldGutter(),
            history(),
            drawSelection(),
            highlightActiveLine(),
            bracketMatching(),
            closeBrackets(),
            indentOnInput(),
            search({ top: true }),
            config.of([]),
            language.of([]),
            keymap.of([
              ...closeBracketsKeymap,
              ...plainBindings(defaultKeymap),
              ...plainBindings(historyKeymap),
              ...plainBindings(searchKeymap),
              ...plainBindings(foldKeymap),
              indentWithTab,
            ]),
            Prec.highest(
              EditorView.domEventHandlers({
                keydown: (event, editor) => {
                  if (
                    editor.state.readOnly &&
                    ((event.key.length === 1 && !event.ctrlKey && !event.metaKey) ||
                      event.key === "Backspace" ||
                      event.key === "Delete" ||
                      event.key === "Enter")
                  )
                    setHint(true);
                  return false;
                },
                beforeinput: (_event, editor) => {
                  if (editor.state.readOnly) setHint(true);
                  return false;
                },
                paste: (_event, editor) => {
                  if (editor.state.readOnly) setHint(true);
                  return false;
                },
                blur: () => {
                  if (useApp.getState().settings?.editorAutosave === "focus") useCode.getState().autosave(root, rel);
                },
              }),
            ),
            EditorView.updateListener.of((update) => {
              if (update.selectionSet)
                useCode.setState({
                  selection: update.state.sliceDoc(update.state.selection.main.from, update.state.selection.main.to),
                });
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
      followBottom.current = true;
      editor.setState(entry.state);
      useCode.setState({ selection: entry.state.sliceDoc(entry.state.selection.main.from, entry.state.selection.main.to) });
      editor.scrollDOM.scrollTop = entry.top;
      editor.scrollDOM.scrollLeft = entry.left;
      const active = document.activeElement;
      const typingElsewhere =
        active instanceof HTMLElement &&
        (active.matches("input, textarea, select") || active.isContentEditable) &&
        !editor.dom.contains(active);
      if (useApp.getState().view === "code" && !typingElsewhere) editor.focus();
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
        editorKeymap(settings?.keybindings),
        EditorState.tabSize.of(tabSize),
        indentUnit.of(" ".repeat(tabSize)),
        wrap ? EditorView.lineWrapping : [],
        EditorView.theme({ "&": { fontSize: `${fontSize}px` } }),
      ]),
    });
  }, [key, visible, fontSize, tabSize, wrap, settings?.keybindings]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || !buffer || !visible || currentKey.current !== key || shownText === undefined) return;
    const top = editor.scrollDOM.scrollTop,
      left = editor.scrollDOM.scrollLeft;
    editor.dispatch({
      changes: minimalChange(editor.state.doc.toString(), shownText),
      effects: setTyping.of(preview ? { ...preview, label: workspace?.agent === "codex" ? "Codex" : "Claude" } : null),
      annotations: [Transaction.addToHistory.of(false), diskReload.of(true)],
    });
    if (preview && followBottom.current)
      editor.dispatch({ effects: EditorView.scrollIntoView(Math.min(preview.caret, editor.state.doc.length), { y: "end" }) });
    else editor.scrollDOM.scrollTop = top;
    editor.scrollDOM.scrollLeft = left;
  }, [key, shownText, visible, preview, workspace?.agent]);
  useEffect(() => {
    if (!visible || !root || !rel) return;
    let cancelled = false;
    void codeApi
      .fileAt(root, rel, "HEAD")
      .then((baseline) => {
        const cached = states.get(key);
        if (cancelled || !cached) return;
        const effects = cached.git.reconfigure(gitGutter(baseline));
        if (view.current && currentKey.current === key) view.current.dispatch({ effects });
        else cached.state = cached.state.update({ effects }).state;
      })
      .catch((e) => {
        if (!cancelled) useApp.getState().setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [key, visible, buffer?.savedText, buffer?.mtime]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || !visible || !jump || jump.key !== key || revision) return;
    const line = editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, jump.target.line)));
    const from = line.from + Math.min(line.length, Math.max(0, jump.target.start));
    const to = Math.max(from, line.from + Math.min(line.length, Math.max(0, jump.target.end)));
    editor.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    if (!jump.follow) editor.focus();
    useCode.setState({ jump: null });
  }, [key, visible, jump, revision]);
  useLayoutEffect(() => {
    const editor = view.current,
      cached = states.get(key);
    if (editor && cached && visible)
      editor.dispatch({ effects: cached.readonly.reconfigure(EditorState.readOnly.of(!!readonly)) });
    if (!readonly) setHint(false);
  }, [key, visible, readonly]);
  useLayoutEffect(() => {
    const editor = view.current;
    const cached = states.get(key);
    if (editor && visible && cached && cached.markEpoch !== epoch) {
      editor.dispatch({ effects: clearAgentMarks.of(null) });
      cached.markEpoch = epoch;
      cached.markNonce = undefined;
    }
  }, [key, visible, epoch]);
  useLayoutEffect(() => {
    const editor = view.current;
    const cached = states.get(key);
    if (!editor || !visible || !marks || !cached || cached.markNonce === marks.nonce) return;
    cached.markNonce = marks.nonce;
    editor.dispatch({ effects: setAgentMarks.of({ ranges: marks.ranges, flash: true }) });
    const timer = setTimeout(() => {
      if (view.current === editor && currentKey.current === key) editor.dispatch({ effects: clearAgentFlash.of(null) });
    }, 1250);
    return () => clearTimeout(timer);
  }, [key, visible, marks, epoch]);
  useEffect(() => {
    setAsk(null);
  }, [key]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {preview?.virtual && (
        <div role="status" className="border-b border-line px-4 py-1 text-[11px] text-run">
          Being written · not yet on disk
        </div>
      )}
      {hint && readonly && (
        <div role="status" className="flex items-center gap-3 border-b border-line px-4 py-2 text-[12px] text-mute">
          The agent is working. Switch to Manual to edit.
          <Button onClick={() => useCode.getState().setMode(root!, "manual")}>Switch to Manual</Button>
        </div>
      )}
      {ask && (
        <AskSelection
          selection={ask}
          close={() => {
            setAsk(null);
            view.current?.focus();
          }}
        />
      )}
      {buffer?.diskChanged && buffer.dirty && (
        <div role="status" className="flex items-center gap-3 border-b-[1.5px] border-line bg-panel px-4 py-2 text-[12px]">
          <span className="text-warn">
            Changed on disk
            {buffer.changedBy
              ? ` by ${useApp.getState().workspaces.find((w) => w.id === buffer.changedBy)?.name ?? "the agent"}`
              : ""}
            .
          </span>
          <Button onClick={() => void useCode.getState().reloadFromDisk(rel!, root!, true)}>Reload</Button>
          <Button onClick={() => void useCode.getState().keepMine(rel!)}>Keep mine</Button>
          <Button onClick={() => useCode.setState((s) => ({ diffTabs: { ...s.diffTabs, [key]: "disk" } }))}>Compare</Button>
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
      {(visible || showingAgentDiff) && (revision || showingAgentDiff) && root && rel && (
        <DiffView
          key={key}
          root={root}
          rel={rel}
          revision={revision ?? "HEAD"}
          activity={showingAgentDiff ? agentDiff : undefined}
        />
      )}
      <div ref={host} className={visible && !revision && !showingAgentDiff ? "min-h-0 flex-1 overflow-hidden" : "hidden"} />
    </div>
  );
}
