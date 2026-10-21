import { Square, Volume2 } from "lucide-react";
import { ttsAvailable } from "../../lib/tts";
import { useVoice } from "../../stores/voice";
import { cn } from "../ui";

/** Speaker icon on an assistant reply; toggles to a stop square while that reply is read. */
export function ReadAloudButton({ id, text, className }: { id: string; text: string; className?: string }) {
  const speaking = useVoice((s) => s.speakingId === id);
  if (!ttsAvailable()) return null;
  return (
    <button
      onClick={() => useVoice.getState().readAloud(id, text)}
      title={speaking ? "Stop reading" : "Read aloud"}
      aria-label={speaking ? "Stop reading" : "Read aloud"}
      className={cn(
        "grid size-6 place-items-center rounded-[3px] text-mute transition-opacity hover:bg-hover hover:text-fg",
        speaking ? "text-run opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover/reply:opacity-100",
        className,
      )}
    >
      {speaking ? <Square className="size-3 fill-current" /> : <Volume2 className="size-3.5" />}
    </button>
  );
}
