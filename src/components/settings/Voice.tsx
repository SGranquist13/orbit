// Settings > Voice: speech model, microphone, dictation behaviour and read-aloud.
import { Download, LoaderCircle, Trash2, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { voiceApi, type VoiceModel, type VoiceModelId } from "../../lib/ipc";
import * as tts from "../../lib/tts";
import { useApp } from "../../stores/app";
import { useVoice } from "../../stores/voice";
import { Button, cn } from "../ui";
import { Row, Segmented, Select, SubHeading, Toggle, save, useSettings } from "./controls";

const MODEL_NOTES: Record<VoiceModelId, string> = {
  "tiny.en": "Fastest, least accurate",
  "base.en": "Good balance (recommended)",
  "small.en": "Most accurate, slower",
};

function sizeLabel(bytes: number) {
  return `${Math.round(bytes / 1e6)} MB`;
}

function ModelRow({ model, active }: { model: VoiceModel; active: boolean }) {
  const dl = useVoice((s) => s.downloads[model.id]);
  const downloading = !!dl && !dl.error;
  const pct = dl && dl.total > 0 ? Math.round((dl.received / dl.total) * 100) : 0;
  return (
    <div className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0">
      <button
        role="radio"
        aria-checked={active}
        aria-label={`Use ${model.id}`}
        onClick={() => void save({ voiceModel: model.id })}
        className={cn("grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]", active ? "border-fg" : "border-line-strong hover:border-mute")}
      >
        {active && <span className="size-2 rounded-full bg-fg" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium">
          {model.id} <span className="font-normal tabular-nums text-mute">· {sizeLabel(model.sizeBytes)}</span>
        </div>
        <div className="text-[11.5px] text-mute">
          {downloading ? (
            <span className="flex items-center gap-2">
              Downloading… {pct}%
              <span className="relative block h-1.5 w-28 overflow-hidden rounded-[2px] bg-line">
                <span className="dither-50 absolute inset-y-0 left-0 bg-run" style={{ width: `${pct}%` }} />
              </span>
            </span>
          ) : dl?.error ? (
            <span className="selectable text-bad">Download failed: {dl.error}</span>
          ) : (
            <>
              {MODEL_NOTES[model.id]}
              {model.installed ? " · Installed" : ""}
            </>
          )}
        </div>
      </div>
      {model.installed ? (
        <Button variant="outline" onClick={() => void useVoice.getState().deleteModel(model.id)} aria-label={`Delete ${model.id}`}>
          <Trash2 className="size-3.5" /> Delete
        </Button>
      ) : (
        <Button variant="outline" disabled={downloading} onClick={() => void useVoice.getState().download(model.id)}>
          {downloading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          {downloading ? "Downloading" : dl?.error ? "Retry" : "Download"}
        </Button>
      )}
    </div>
  );
}

export function Voice() {
  const s = useSettings();
  const models = useVoice((v) => v.models);
  const [devices, setDevices] = useState<string[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [testing, setTesting] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  useEffect(() => {
    void useVoice.getState().refreshModels();
    voiceApi
      .devices()
      .then((d) => (setDevices(d), setDeviceError(null)))
      .catch((e) => setDeviceError(String(e).replace(/^Error:\s*/, "")));
    void tts.listVoices().then(setVoices);
  }, []);
  useEffect(() => () => tts.cancel(), []);

  if (!s) return null;
  const deviceOptions = [{ value: "", label: "System default" }, ...devices.map((d) => ({ value: d, label: d }))];
  if (s.voiceDevice && !devices.includes(s.voiceDevice)) deviceOptions.push({ value: s.voiceDevice, label: `${s.voiceDevice} (unavailable)` });
  const voiceOptions = [{ value: "", label: "System default" }, ...voices.map((v) => ({ value: v.name, label: `${v.name} (${v.lang})` }))];
  if (s.voiceTtsVoice && !voices.some((v) => v.name === s.voiceTtsVoice)) voiceOptions.push({ value: s.voiceTtsVoice, label: `${s.voiceTtsVoice} (unavailable)` });

  const test = async () => {
    if (testing) return tts.cancel();
    setTesting(true);
    await tts.speak("This is how Orbit will read replies aloud.", { voice: s.voiceTtsVoice || undefined, rate: s.voiceTtsRate });
    setTesting(false);
  };

  return (
    <>
      <SubHeading>Speech recognition</SubHeading>
      <Row
        label="Speech model"
        field="voiceModel"
        stacked
        description="Runs on this computer; your voice is never uploaded. The model downloads once. Larger models are more accurate but slower to transcribe."
      >
        <div role="radiogroup" aria-label="Speech model" className="w-full">
          {models.length === 0 && <p className="py-2 text-[12px] text-mute">Models unavailable.</p>}
          {models.map((m) => (
            <ModelRow key={m.id} model={m} active={s.voiceModel === m.id} />
          ))}
        </div>
      </Row>
      <Row label="Microphone" field="voiceDevice" description={deviceError ? <span className="text-bad">{deviceError}</span> : "Which input to record from."}>
        <Select label="Microphone" value={s.voiceDevice} options={deviceOptions} onChange={(v) => void save({ voiceDevice: v })} className="max-w-[260px]" />
      </Row>

      <SubHeading>Dictation</SubHeading>
      <Row label="Send after dictating" field="voiceAutoSend" description="Send the message as soon as the transcript is inserted. Off leaves it in the composer for you to edit.">
        <Toggle label="Send after dictating" checked={s.voiceAutoSend} onChange={(v) => void save({ voiceAutoSend: v })} />
      </Row>
      <Row label="Silence timeout" field="voiceSilenceMs" description="In hands-free mode, how long a pause ends what you were saying.">
        <input
          type="range"
          aria-label="Silence timeout"
          min={300}
          max={5000}
          step={100}
          value={s.voiceSilenceMs}
          onChange={(e) => useApp.setState((st) => (st.settings ? { settings: { ...st.settings, voiceSilenceMs: Number(e.target.value) } } : {}))}
          onPointerUp={(e) => void save({ voiceSilenceMs: Number((e.target as HTMLInputElement).value) })}
          onKeyUp={(e) => void save({ voiceSilenceMs: Number((e.target as HTMLInputElement).value) })}
          className="w-40 accent-fg"
        />
        <span className="w-12 text-right text-[12px] font-medium tabular-nums text-dim">{(s.voiceSilenceMs / 1000).toFixed(1)} s</span>
      </Row>
      <Row label="Clean up dictation" description="Remove filler words and fix punctuation and file names with a model before inserting. Choose the model in Settings > Models > Voice tidy-up; it is off until you pick one.">
        <Button variant="outline" onClick={() => useApp.getState().openSettingsAt("models")}>
          Open Models
        </Button>
      </Row>

      <SubHeading>Read aloud</SubHeading>
      <Row label="Read replies aloud" field="voiceReadAloud" description="Hands-free only speaks the reply to what you just said. Always reads every finished reply in the workspace you are viewing.">
        <Segmented
          label="Read replies aloud"
          value={s.voiceReadAloud}
          options={[
            { value: "off", label: "Off" },
            { value: "handsfree", label: "Hands-free only" },
            { value: "always", label: "Always" },
          ]}
          onChange={(v) => void save({ voiceReadAloud: v })}
        />
      </Row>
      <Row label="Voice" field="voiceTtsVoice" description={tts.ttsAvailable() ? "Voices come from your operating system." : "This system has no speech synthesis."}>
        <Select label="Voice" value={s.voiceTtsVoice} options={voiceOptions} onChange={(v) => void save({ voiceTtsVoice: v })} className="max-w-[260px]" />
      </Row>
      <Row label="Speed" field="voiceTtsRate">
        <input
          type="range"
          aria-label="Speech speed"
          min={0.5}
          max={2}
          step={0.1}
          value={s.voiceTtsRate}
          onChange={(e) => useApp.setState((st) => (st.settings ? { settings: { ...st.settings, voiceTtsRate: Number(e.target.value) } } : {}))}
          onPointerUp={(e) => void save({ voiceTtsRate: Number((e.target as HTMLInputElement).value) })}
          onKeyUp={(e) => void save({ voiceTtsRate: Number((e.target as HTMLInputElement).value) })}
          className="w-40 accent-fg"
        />
        <span className="w-12 text-right text-[12px] font-medium tabular-nums text-dim">{s.voiceTtsRate.toFixed(1)}x</span>
        <Button variant="outline" onClick={() => void test()} disabled={!tts.ttsAvailable()}>
          <Volume2 className="size-3.5" /> {testing ? "Stop" : "Test voice"}
        </Button>
      </Row>
    </>
  );
}
