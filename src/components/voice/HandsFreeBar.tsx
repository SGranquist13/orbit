import { Headphones, Square } from "lucide-react";
import { agentLabel, cn } from "../ui";
import { useApp } from "../../stores/app";
import { useVoice } from "../../stores/voice";
import { LevelBar } from "./LevelBar";

/** Slim bar above the composer while hands-free is on for this workspace. */
export function HandsFreeBar({ wsId }: { wsId: string }) {
  const phase = useVoice((s) => s.handsFree.phase);
  const hfWs = useVoice((s) => s.handsFree.workspaceId);
  const level = useVoice((s) => s.level);
  const status = useVoice((s) => s.status);
  const agent = useApp((s) => s.workspaces.find((w) => w.id === wsId)?.agent);
  if (phase === "off" || hfWs !== wsId) return null;
  const label =
    phase === "listening"
      ? "Listening"
      : phase === "transcribing"
        ? "Transcribing"
        : phase === "sending"
          ? "Sending"
          : phase === "speaking"
            ? "Speaking"
            : `Waiting for ${agent ? agentLabel[agent] : "the agent"}`;
  // The mic stays open while waiting (so "stop" works), so the level bar shows whenever it is listening.
  const micOpen = status === "listening";
  return (
    <div role="status" className="mx-auto mb-2 flex max-w-[880px] items-center gap-3 rounded-[6px] border-[1.5px] border-run bg-run/10 px-3 py-1.5 text-[12px] font-medium">
      <Headphones className="size-3.5 shrink-0 text-run" />
      <span className="text-fg">Hands-free</span>
      <span className={cn("text-mute", phase === "listening" && "text-run")}>{label}</span>
      {micOpen && <LevelBar level={level} />}
      <span className="flex-1 text-[11px] text-mute">Say "stop" to interrupt the agent.</span>
      <button
        onClick={() => void useVoice.getState().cancel()}
        className="flex h-6 items-center gap-1.5 rounded-[4px] border-[1.5px] border-line-strong px-2 text-fg hover:bg-fg hover:text-bg"
      >
        <Square className="size-2.5 fill-current" /> Stop
      </button>
    </div>
  );
}
