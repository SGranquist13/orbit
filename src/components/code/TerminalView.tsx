import { isNonTerminalKey, registerHandler } from "../../lib/keybindings";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { codeEvents, ptyApi } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { useCode, type CodeTerminal } from "../../stores/code";
import { Button } from "../ui";
import "@xterm/xterm/css/xterm.css";

const report = (e: unknown) => useApp.getState().setError(String(e));
export function TerminalView({ terminal, active }: { terminal: CodeTerminal; active: boolean }) {
  const host = useRef<HTMLDivElement>(null),
    instance = useRef<Terminal | null>(null),
    fitRef = useRef<() => void>(() => {});
  const [restart, setRestart] = useState(0);
  const fontSize = useApp((s) => s.settings?.editorFontSize ?? 13);
  useEffect(() => {
    if (!host.current) return;
    let opening = true,
      disposed = false,
      id: string | undefined;
    // Keystrokes typed before the shell has an id are sent once it does.
    let earlyInput = "";
    const unlisten: (() => void)[] = [];
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", monospace',
      fontSize: useApp.getState().settings?.editorFontSize ?? 13,
      cursorBlink: true,
    });
    instance.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, url) => void openUrl(url).catch(report)));
    term.open(host.current);
    const theme = () => {
      const css = getComputedStyle(document.documentElement),
        color = (name: string) => css.getPropertyValue(`--${name}`).trim();
      term.options.theme = {
        background: color("panel"),
        foreground: color("fg"),
        cursor: color("fg"),
        selectionBackground: color("hover"),
        black: color("bg"),
        red: color("bad"),
        green: color("ok"),
        yellow: color("warn"),
        blue: color("info"),
        magenta: color("merged"),
        cyan: color("run"),
        white: color("fg"),
        brightBlack: color("mute"),
        brightRed: color("bad"),
        brightGreen: color("ok"),
        brightYellow: color("warn"),
        brightBlue: color("info"),
        brightMagenta: color("merged"),
        brightCyan: color("run"),
        brightWhite: color("fg"),
      };
    };
    theme();
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const resize = () => {
      if (!host.current?.clientWidth || !host.current.clientHeight || disposed) return;
      fit.fit();
      if (id) void ptyApi.resize(id, term.cols, term.rows).catch(report);
    };
    fitRef.current = resize;
    const ro = new ResizeObserver(resize);
    ro.observe(host.current);
    resize();
    const terminalOff = [
      registerHandler("terminal.copy", () => {
        if (useApp.getState().view !== "code" || useCode.getState().activeBottomTab !== terminal.id) return false;
        void navigator.clipboard.writeText(term.getSelection()).catch(report);
      }),
      registerHandler("terminal.paste", () => {
        if (useApp.getState().view !== "code" || useCode.getState().activeBottomTab !== terminal.id) return false;
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (!disposed) term.paste(text);
          })
          .catch(report);
      }),
    ];
    term.attachCustomKeyEventHandler((event) => !isNonTerminalKey(event, useApp.getState().settings?.keybindings));
    const input = term.onData((data) => {
      if (disposed) return;
      if (id) void ptyApi.write(id, data).catch(report);
      else if (opening) earlyInput += data;
    });
    // Subscribe before spawning: shells may produce output before open returns its id.
    const earlyData: { id: string; data: string }[] = [],
      earlyExit: { id: string; code: number | null }[] = [];
    const exited = (code: number | null) => {
      term.writeln(`\r\n[process exited with code ${code ?? "unknown"}]`);
      id = undefined;
      opening = false;
      useCode.setState((s) => ({
        terminals: s.terminals.map((t) => (t.id === terminal.id ? { ...t, exited: true } : t)),
      }));
    };
    const register = async (promise: Promise<() => void>) => {
      const off = await promise;
      if (disposed) off();
      else unlisten.push(off);
    };
    void (async () => {
      await Promise.all([
        register(
          codeEvents.onPtyData((e) => {
            // Output can still arrive after close; writing into a disposed xterm throws.
            if (disposed) return;
            if (id === e.id) term.write(e.data);
            else if (opening) earlyData.push(e);
          }),
        ),
        register(
          codeEvents.onPtyExit((e) => {
            if (disposed) return;
            if (id === e.id) exited(e.code);
            else if (opening) earlyExit.push(e);
          }),
        ),
      ]);
      if (disposed) return;
      const opened = await ptyApi.open(terminal.root, term.cols, term.rows);
      if (disposed) {
        await ptyApi.close(opened);
        return;
      }
      id = opened;
      opening = false;
      for (const e of earlyData) if (e.id === id) term.write(e.data);
      for (const e of earlyExit) if (e.id === id) exited(e.code);
      earlyData.length = earlyExit.length = 0;
      if (earlyInput && id) void ptyApi.write(id, earlyInput).catch(report);
      earlyInput = "";
      resize();
    })().catch((e) => {
      if (!disposed) {
        term.writeln(`\r\n${String(e)}`);
        exited(null);
      }
    });
    return () => {
      disposed = true;
      unlisten.forEach((off) => off());
      input.dispose();
      observer.disconnect();
      ro.disconnect();
      if (id) void ptyApi.close(id).catch(report);
      terminalOff.forEach((off) => off());
      term.dispose();
      instance.current = null;
    };
  }, [terminal.id, terminal.root, restart]);
  useLayoutEffect(() => {
    if (instance.current) instance.current.options.fontSize = fontSize;
    fitRef.current();
  }, [fontSize]);
  useEffect(() => {
    if (active) {
      fitRef.current();
      instance.current?.focus();
    }
  }, [active, restart]);
  return (
    <div className={active ? "flex h-full min-h-0 flex-col" : "hidden"}>
      {terminal.exited && (
        <div className="flex items-center gap-3 px-3 py-1 text-[12px] text-mute">
          Shell exited
          <Button
            onClick={() => {
              useCode.setState((s) => ({
                terminals: s.terminals.map((t) => (t.id === terminal.id ? { ...t, exited: false } : t)),
              }));
              setRestart((n) => n + 1);
            }}
          >
            Restart
          </Button>
        </div>
      )}
      <div ref={host} className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  );
}
