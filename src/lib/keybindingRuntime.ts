import { useApp } from "../stores/app";
import { useCode } from "../stores/code";
import { useTheme } from "./theme";
import { registerHandler, createDispatcher, normalizeEvent } from "./keybindings";
import { explorerAction } from "../components/code/Explorer";
import { openCodeFolder } from "../components/code/FolderSwitcher";
import { discardReview, reviewTarget, sendReview } from "../stores/review";

export let recordingKeys = false;
export function setRecordingKeys(value: boolean) {
  recordingKeys = value;
}

export async function showCode(explorer = false, quick = false) {
  const s = useApp.getState(),
    code = useCode.getState(),
    ws = s.workspaces.find((w) => w.id === s.selectedId);
  if (!code.activeRoot && ws) await code.openRoot(ws.path, { workspaceId: ws.id });
  s.setView("code");
  if (quick) code.setQuickOpen(true);
  if (explorer) useCode.setState({ explorerHidden: false, explorerFocus: Date.now() });
}

export function installKeybindings(hint: (message: string) => void) {
  const off: (() => void)[] = [];
  const add = (id: string, fn: () => unknown) => off.push(registerHandler(id, fn));
  add("workbench.commandPalette", () => useApp.getState().setPaletteOpen(true));
  add("code.quickOpen", () => void showCode(false, true));
  add("code.focusExplorer", () => void showCode(true));
  for (const v of ["inbox", "code", "routines", "teammates", "issues"] as const) {
    add(`views.${v}`, () => (v === "code" ? void showCode() : useApp.getState().setView(v === "teammates" ? "teammate" : v)));
  }
  add("workbench.newWorkspace", () => useApp.getState().setNewWorkspaceOpen(true));
  for (let i = 1; i <= 9; i++) {
    add(`workbench.workspace${i}`, () => {
      const s = useApp.getState(),
        ws = s.repos.flatMap((r) => s.workspaces.filter((w) => w.repoId === r.id))[i - 1];
      if (!ws) return false;
      s.select(ws.id);
    });
  }
  add("review.send", () => {
    const id = reviewTarget();
    if (id) void sendReview(id);
    return !!id;
  });
  add("review.discard", () => {
    const id = reviewTarget();
    if (id) void discardReview(id);
    return !!id;
  });
  add("workbench.settings", () => useApp.getState().openSettings());
  add("workbench.keyboardShortcuts", () => {
    useApp.getState().openSettings();
    useApp.setState({ settingsSection: "shortcuts" });
  });
  add("workbench.theme", () => useTheme.getState().toggle());
  add("workbench.focusMode", () => {
    const s = useApp.getState();
    s.setFocusMode(!s.focusMode);
  });
  add("workbench.toggleShip", () => {
    const s = useApp.getState();
    s.setShipOpen(!s.shipOpen);
  });
  add("workbench.toggleSidebar", () => {
    if (useApp.getState().view === "code") useCode.setState((s) => ({ explorerHidden: !s.explorerHidden }));
    else {
      const s = useApp.getState();
      s.setSidebarCollapsed(!s.sidebarCollapsed);
    }
  });
  add("code.toggleActivity", () => useCode.setState((s) => ({ activityOpen: !s.activityOpen })));
  add("agent.openChat", () => {
    const s = useApp.getState(),
      c = useCode.getState();
    const id = s.view === "code" ? c.roots.find((r) => r.path === c.activeRoot)?.workspaceId : s.selectedId;
    if (!id) return false;
    s.select(id);
    s.setView("workspace");
  });
  const activeRel = () => {
    const s = useCode.getState();
    return s.roots.find((r) => r.path === s.activeRoot)?.activeRel;
  };
  const codeActions: Record<string, () => unknown> = {
    newFile: () => {
      useCode.setState({ explorerHidden: false });
      explorerAction("new-file");
    },
    openFolder: () => void openCodeFolder(),
    save: () => {
      const rel = activeRel();
      if (rel) void useCode.getState().save(rel);
    },
    saveAll: () => void useCode.getState().saveAll(),
    closeTab: () => {
      const rel = activeRel();
      if (rel) void useCode.getState().closeTab(rel);
    },
    closeAll: () => void useCode.getState().closeAllTabs(),
    reopenTab: () => void useCode.getState().reopenTab(),
    nextTab: () => useCode.getState().cycleTab(1),
    previousTab: () => useCode.getState().cycleTab(-1),
    toggleTerminal: () => useCode.getState().toggleTerminal(),
    newTerminal: () => useCode.getState().newTerminal(),
    togglePanel: () => useCode.setState((s) => ({ bottomOpen: !s.bottomOpen })),
    search: () => useCode.getState().openSearch(),
    toggleMode: () => useCode.getState().toggleMode(),
    toggleDiff: () => useCode.getState().toggleDiff(),
  };
  for (const [id, fn] of Object.entries(codeActions)) {
    add(`code.${id}`, () => (useApp.getState().view === "code" ? fn() : false));
  }
  const dispatcher = createDispatcher();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onKey = (e: KeyboardEvent) => {
    if (recordingKeys || e.isComposing || e.key === "Dead") return;
    const key = normalizeEvent(e);
    if (!key) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    const editor = !!target?.closest(".cm-editor"),
      terminal = !!target?.closest(".xterm");
    if (
      !dispatcher.pending &&
      !editor &&
      !terminal &&
      target?.closest("input, textarea, select, [contenteditable=true]") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !/^F\d+$/.test(e.key)
    )
      return;
    const context = { code: useApp.getState().view === "code", editor, terminal };
    const result = dispatcher.press(key, context, useApp.getState().settings?.keybindings ?? {});
    if (result.handled) {
      e.preventDefault();
      e.stopPropagation();
    }
    clearTimeout(timer);
    hint(result.hint);
    if (result.hint && !dispatcher.pending) timer = setTimeout(() => hint(""), 2000);
  };
  const cancel = () => {
    dispatcher.cancel();
    hint("");
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", cancel);
  return () => {
    off.forEach((fn) => fn());
    clearTimeout(timer);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", cancel);
  };
}
