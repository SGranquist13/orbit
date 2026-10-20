import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../stores/app";
import { Button, Kbd, cn } from "./ui";
import { Editor } from "./settings/Editor";
import { Agents } from "./settings/Agents";
import { Section } from "./settings/controls";
import { Data } from "./settings/Data";
import { General } from "./settings/General";
import { Models } from "./settings/Models";
import { Mobile } from "./settings/Mobile";
import { About, Git, GitHub, InboxSettings, Shortcuts } from "./settings/sections";
import { Skills } from "./settings/Skills";
import { UsageSection } from "./settings/UsageSection";

const SECTIONS = [
  { id: "general", title: "General", body: <General /> },
  { id: "editor", title: "Editor", body: <Editor />, description: "The Code view: editor, autosave, terminal." },
  { id: "agents", title: "Agents", body: <Agents />, description: "Permissions, models and the tools Orbit drives." },
  { id: "git", title: "Git", body: <Git />, description: "How Orbit handles commits, checks, syncing and merging. Defaults follow trunk-based practice; every piece can be changed or switched off." },
  { id: "github", title: "GitHub", body: <GitHub /> },
  { id: "skills", title: "Skills & profiles", body: <Skills /> },
  { id: "inbox", title: "Inbox", body: <InboxSettings /> },
  { id: "models", title: "Models", body: <Models />, description: "Which model runs Orbit's small background tasks, and the optional local server." },
  { id: "mobile", title: "Mobile", body: <Mobile />, description: "Watch and steer your workspaces from the Orbit phone app." },
  { id: "usage", title: "Usage", body: <UsageSection /> },
  { id: "data", title: "Data", body: <Data /> },
  { id: "shortcuts", title: "Keyboard shortcuts", body: <Shortcuts /> },
  { id: "about", title: "About", body: <About /> },
];

export function Settings() {
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(SECTIONS[0].id);
  const settingsLoaded = useApp((s) => s.settings !== null);
  const settingsError = useApp((s) => s.settingsError);

  const requestedSection = useApp((s) => s.settingsSection);
  useLayoutEffect(() => {
    if (!settingsLoaded || !requestedSection) return;
    scroller.current?.querySelector(`[data-section="${requestedSection}"]`)?.scrollIntoView({ block: "start" });
    setActive(requestedSection);
    useApp.setState({ settingsSection: null });
  }, [settingsLoaded, requestedSection]);

  // Highlight the last section whose top has passed the upper part of the viewport.
  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top + 120;
    let current = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const el = box.querySelector<HTMLElement>(`[data-section="${s.id}"]`);
      if (el && el.getBoundingClientRect().top <= top) current = s.id;
    }
    // At the very bottom the last section may be too short to reach the threshold.
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) current = SECTIONS[SECTIONS.length - 1].id;
    setActive(current);
  };

  const jump = (id: string) => {
    scroller.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = useApp.getState();
      if (s.paletteOpen || s.packsOpen || s.newWorkspaceOpen) return;
      const t = e.target as HTMLElement | null;
      // Escape inside a field only leaves the field.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
        t.blur();
        return;
      }
      s.closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b-[1.5px] border-line px-5" data-tauri-drag-region>
        <h1 className="text-[14px] font-semibold tracking-[-0.01em]">Settings</h1>
        <span className="flex-1" />
        <button onClick={() => useApp.getState().closeSettings()} className="flex items-center gap-1.5 text-[12px] font-medium text-mute hover:text-fg">
          Close <Kbd>Esc</Kbd>
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="w-[200px] shrink-0 space-y-0.5 overflow-y-auto border-r-[1.5px] border-line px-2 py-3">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => jump(s.id)}
              aria-current={active === s.id ? "true" : undefined}
              className={cn(
                "flex h-7 w-full items-center rounded-[4px] px-2.5 text-left text-[12.5px] font-medium transition-colors",
                active === s.id ? "bg-raised text-fg" : "text-dim hover:bg-hover hover:text-fg",
              )}
            >
              {s.title}
            </button>
          ))}
        </nav>
        <div ref={scroller} onScroll={onScroll} className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[720px] px-8 pb-24 pt-6">
            {!settingsLoaded && !settingsError && <p className="py-6 text-[12px] text-mute">Loading settings…</p>}
            {!settingsLoaded && settingsError && (
              <div className="flex items-start gap-3 py-6">
                <p className="selectable flex-1 whitespace-pre-wrap text-[12px] font-medium text-bad">Couldn't load settings: {settingsError}</p>
                <Button onClick={() => void useApp.getState().loadSettings()}>Retry</Button>
              </div>
            )}
            {SECTIONS.map((s) => (
              <Section key={s.id} id={s.id} title={s.title} description={s.description}>
                {s.body}
              </Section>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
