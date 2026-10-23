import { Headphones, Square } from "lucide-react";
import { useEffect } from "react";
import type { HandsFreePhase } from "../../lib/voice";
import { agentLabel, cn } from "../ui";
import { useApp } from "../../stores/app";
import { useVoice } from "../../stores/voice";
import { LevelBar } from "./LevelBar";

/** Slim bar above the composer while hands-free is on for this workspace. */
export function HandsFreeBar({ wsId }: { wsId: string }) {
  const phase = useVoice((s) => s.handsFree.phase);
  const hfWs = useVoice((s) => s.handsFree.workspaceId);
  const heard = useVoice((s) => s.handsFree.heard);
  const level = useVoice((s) => s.level);
  const agent = useApp((s) => s.workspaces.find((w) => w.id === wsId)?.agent);
  const active = phase !== "off" && hfWs === wsId;

  // Esc stops hands-free (unless a dialog or the palette has the focus and wants the key).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [cmdk-root]')) return;
      e.preventDefault();
      e.stopPropagation(); // do not also interrupt the agent
      void useVoice.getState().cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  if (!active) return null;
  const labels: Record<Exclude<HandsFreePhase, "off">, string> = {
    listening: "Listening",
    hearing: "Hearing you",
    transcribing: "Transcribing",
    working: `${agent ? agentLabel[agent] : "The agent"} is working`,
    speaking: "Speaking",
  };
  const label = labels[phase as Exclude<HandsFreePhase, "off">];
  const live = phase === "listening" || phase === "hearing";
  return (
    <div role="status" data-hands-free data-phase={phase} className="mx-auto mb-2 flex max-w-[880px] items-center gap-3 rounded-[6px] border-[1.5px] border-run bg-run/10 px-3 py-1.5 text-[12px] font-medium">
      <Headphones className="size-3.5 shrink-0 text-run" />
      <span className="shrink-0 whitespace-nowrap text-fg">Hands-free</span>
      <span className={cn("shrink-0 whitespace-nowrap text-mute", live && "text-run")}>{label}</span>
      {/* The microphone is open the whole time, so the meter is always there. */}
      <LevelBar level={level} className="shrink-0" />
      <span className={cn("selectable min-w-0 flex-1 truncate text-[11px]", heard?.kind === "error" ? "text-bad" : "text-mute")}>
        {heard?.kind === "sent" ? (
          <>Sent: {heard.text}</>
        ) : heard?.kind === "stop" ? (
          "Stopped"
        ) : heard?.kind === "missed" ? (
          "Didn't catch that"
        ) : heard?.kind === "error" ? (
          heard.text
        ) : (
          'Talk any time. Say "stop" to interrupt. Esc ends hands-free.'
        )}
      </span>
      <button
        onClick={() => void useVoice.getState().cancel()}
        className="flex h-6 shrink-0 items-center gap-1.5 rounded-[4px] border-[1.5px] border-line-strong px-2 text-fg hover:bg-fg hover:text-bg"
      >
        <Square className="size-2.5 fill-current" /> Stop
      </button>
    </div>
  );
}
