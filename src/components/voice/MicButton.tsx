import { CircleAlert, Headphones, LoaderCircle, Mic, X } from "lucide-react";
import { useKeybindingLabels } from "../../lib/useKeybinding";
import { useApp } from "../../stores/app";
import { useVoice } from "../../stores/voice";
import { Button, cn } from "../ui";
import { LevelBar } from "./LevelBar";

const box = "grid size-8 place-items-center rounded-[4px] border-[1.5px] transition-colors";

/** Dictation button for the composer: tap to toggle, hold to talk. Level bar and progress sit to its left. */
export function MicButton({ wsId }: { wsId: string }) {
  const keyLabel = useKeybindingLabels();
  const status = useVoice((s) => s.status);
  const voiceWs = useVoice((s) => s.workspaceId);
  const mode = useVoice((s) => s.mode);
  const level = useVoice((s) => s.level);
  const busyHandsFree = useVoice((s) => s.handsFree.phase !== "off");
  const mine = voiceWs === wsId && mode === "dictate";
  const listening = mine && status === "listening";
  const working = mine && status === "transcribing";
  return (
    <>
      {listening && <LevelBar level={level} />}
      {working && (
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-mute">
          <LoaderCircle className="size-3 animate-spin" /> Transcribing…
        </span>
      )}
      <button
        onClick={() => void useVoice.getState().toggleDictation(wsId)}
        disabled={busyHandsFree || working || (status !== "idle" && status !== "error" && !listening)}
        title={listening ? "Stop and insert (Esc cancels)" : `Dictate (${keyLabel("voice.dictate")}, hold to talk)`}
        aria-label={listening ? "Stop dictation" : "Dictate"}
        aria-pressed={listening}
        className={cn(box, listening ? "border-run bg-run/10 text-run" : "border-line-strong text-dim hover:bg-hover hover:text-fg disabled:opacity-30")}
      >
        <Mic className="size-4" />
      </button>
    </>
  );
}

/** Starts or stops hands-free talking with the agent in this workspace. */
export function HandsFreeButton({ wsId }: { wsId: string }) {
  const keyLabel = useKeybindingLabels();
  const phase = useVoice((s) => s.handsFree.phase);
  const hfWs = useVoice((s) => s.handsFree.workspaceId);
  const status = useVoice((s) => s.status);
  const on = phase !== "off" && hfWs === wsId;
  const blocked = (phase !== "off" && hfWs !== wsId) || (phase === "off" && status !== "idle" && status !== "error");
  return (
    <button
      onClick={() => void useVoice.getState().toggleHandsFree(wsId)}
      disabled={blocked}
      title={on ? "Stop hands-free" : `Hands-free: talk, the agent replies out loud${keyLabel("voice.handsFree") ? ` (${keyLabel("voice.handsFree")})` : ""}`}
      aria-label="Hands-free"
      aria-pressed={on}
      className={cn(box, on ? "border-run bg-run/10 text-run" : "border-line-strong text-dim hover:bg-hover hover:text-fg disabled:opacity-30")}
    >
      <Headphones className="size-4" />
    </button>
  );
}

/** Inline microphone and transcription errors. Model setup lives in the global dialog. */
export function VoiceNotice({ wsId }: { wsId: string }) {
  const error = useVoice((s) => s.error);
  if (!error || error.kind === "noModel" || (error.workspaceId !== wsId && error.workspaceId !== null)) return null;
  return (
    <p role="alert" className="mx-auto mb-2 flex max-w-[880px] flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-medium text-bad">
      <CircleAlert className="size-3.5 shrink-0" />
      <span className="selectable">
        {error.kind === "blocked"
          ? "Microphone access is blocked. Allow it for Orbit in Windows Settings > Privacy > Microphone, then try again."
          : error.kind === "noMic"
            ? "No microphone found. Plug one in or pick another in Settings > Voice."
            : error.message}
      </span>
      {(error.kind === "noMic" || error.kind === "blocked") && (
        <Button variant="outline" className="h-6" onClick={() => useApp.getState().openSettingsAt("voice")}>
          Open Settings &gt; Voice
        </Button>
      )}
      <button onClick={() => useVoice.getState().clearError()} aria-label="Dismiss" className="ml-auto grid size-5 place-items-center rounded-[3px] text-mute hover:bg-hover hover:text-fg">
        <X className="size-3" />
      </button>
    </p>
  );
}
