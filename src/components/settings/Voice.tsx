// Settings > Voice: speech model, microphone, dictation, hands-free behaviour, and the voice replies are read in.
import { Download, LoaderCircle, Trash2, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { KokoroVoiceId, Settings, VoiceModel, VoiceModelId } from "../../lib/ipc";
import * as tts from "../../lib/tts";
import { KOKORO_VOICES } from "../../lib/tts/voices";
import { grantMicLabels, listInputDevices, type InputDevice } from "../../lib/voice/mic";
import { useApp } from "../../stores/app";
import { useVoice } from "../../stores/voice";
import { Button, cn } from "../ui";
import { Row, Segmented, Select, SubHeading, Toggle, save, useSettings } from "./controls";

const MODEL_NOTES: Record<string, string> = {
  "tiny.en": "Fastest, least accurate",
  "base.en": "Good balance (recommended)",
  "small.en": "Most accurate, slower",
  kokoro: "Natural-sounding voices that run on this computer",
};

function sizeLabel(bytes: number) {
  return `${Math.round(bytes / 1e6)} MB`;
}

/** One downloadable pack: progress while it downloads, Delete once installed. A radio picks the active speech model. */
function PackRow({ model, title, active, onSelect }: { model: VoiceModel; title: string; active?: boolean; onSelect?: () => void }) {
  const dl = useVoice((s) => s.downloads[model.id]);
  const downloading = !!dl && !dl.error;
  const pct = dl && dl.total > 0 ? Math.round((dl.received / dl.total) * 100) : 0;
  return (
    <div className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0">
      {onSelect && (
        <button
          role="radio"
          aria-checked={!!active}
          aria-label={`Use ${model.id}`}
          onClick={onSelect}
          className={cn("grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]", active ? "border-fg" : "border-line-strong hover:border-mute")}
        >
          {active && <span className="size-2 rounded-full bg-fg" />}
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium">
          {title} <span className="font-normal tabular-nums text-mute">· {sizeLabel(model.sizeBytes)}</span>
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

/** A range input that shows the value live and saves when released. */
function Slider({ label, field, min, max, step, format }: { label: string; field: keyof Settings & ("voiceSilenceMs" | "voiceMinSpeechMs" | "voiceTtsRate"); min: number; max: number; step: number; format: (v: number) => string }) {
  const s = useSettings();
  if (!s) return null;
  const value = s[field] as number;
  const commit = (el: HTMLInputElement) => void save({ [field]: Number(el.value) } as Partial<Settings>);
  return (
    <>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => useApp.setState((st) => (st.settings ? { settings: { ...st.settings, [field]: Number(e.target.value) } } : {}))}
        onPointerUp={(e) => commit(e.target as HTMLInputElement)}
        onKeyUp={(e) => commit(e.target as HTMLInputElement)}
        className="w-40 accent-fg"
      />
      <span className="w-12 text-right text-[12px] font-medium tabular-nums text-dim">{format(value)}</span>
    </>
  );
}

export function Voice() {
  const s = useSettings();
  const models = useVoice((v) => v.models);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [labelled, setLabelled] = useState(true);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);

  const refreshDevices = () =>
    listInputDevices()
      .then((r) => (setDevices(r.devices), setLabelled(r.labelled || r.devices.length === 0), setDeviceError(null)))
      .catch((e) => setDeviceError(String(e).replace(/^Error:\s*/, "")));

  useEffect(() => {
    void useVoice.getState().refreshModels();
    void refreshDevices();
    void tts.listVoices().then(setVoices);
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, []);
  useEffect(() => () => tts.stop(), []);

  if (!s) return null;
  const stt = models.filter((m) => m.kind === "stt");
  const kokoro = models.find((m) => m.id === "kokoro");
  const natural = s.voiceTtsEngine === "kokoro";

  const deviceOptions = [{ value: "", label: "System default" }, ...devices.map((d) => ({ value: d.id, label: d.label }))];
  if (s.voiceDevice && !devices.some((d) => d.id === s.voiceDevice)) deviceOptions.push({ value: s.voiceDevice, label: "Saved microphone (unavailable)" });
  const systemOptions = [{ value: "", label: "System default" }, ...voices.map((v) => ({ value: v.name, label: `${v.name} (${v.lang})` }))];
  if (s.voiceTtsVoice && !voices.some((v) => v.name === s.voiceTtsVoice)) systemOptions.push({ value: s.voiceTtsVoice, label: `${s.voiceTtsVoice} (unavailable)` });

  const test = async () => {
    if (testing) return tts.stop();
    setTesting(true);
    setTestNote(null);
    try {
      const r = await tts.speak("This is how Orbit will read replies aloud.", {
        engine: s.voiceTtsEngine,
        kokoroVoice: s.voiceKokoroVoice,
        systemVoice: s.voiceTtsVoice,
        speed: s.voiceTtsRate,
      });
      if (r.fellBack) setTestNote(r.fellBack.notInstalled ? "The natural voice isn't downloaded yet, so that was your system voice." : `The natural voice failed to load (${r.fellBack.message}), so that was your system voice.`);
    } finally {
      setTesting(false);
    }
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
          {stt.length === 0 && <p className="py-2 text-[12px] text-mute">Models unavailable.</p>}
          {stt.map((m) => (
            <PackRow key={m.id} model={m} title={m.id} active={s.voiceModel === m.id} onSelect={() => void save({ voiceModel: m.id as VoiceModelId })} />
          ))}
        </div>
      </Row>
      <Row
        label="Microphone"
        field="voiceDevice"
        description={
          deviceError ? (
            <span className="text-bad">{deviceError}</span>
          ) : labelled ? (
            "Which input to record from."
          ) : (
            "Allow microphone access once to see your devices by name."
          )
        }
      >
        <Select label="Microphone" value={s.voiceDevice} options={deviceOptions} onChange={(v) => void save({ voiceDevice: v })} className="max-w-[260px]" />
        {!labelled && (
          <Button variant="outline" onClick={() => void grantMicLabels().then(refreshDevices, (e) => setDeviceError(String(e?.message ?? e)))}>
            Show names
          </Button>
        )}
      </Row>

      <SubHeading>Dictation</SubHeading>
      <Row label="Send after dictating" field="voiceAutoSend" description="Send the message as soon as the transcript is inserted. Off leaves it in the composer for you to edit.">
        <Toggle label="Send after dictating" checked={s.voiceAutoSend} onChange={(v) => void save({ voiceAutoSend: v })} />
      </Row>
      <Row label="Clean up dictation" description="Remove filler words and fix punctuation and file names with a model before inserting. Choose the model in Settings > Models > Voice tidy-up; it is off until you pick one.">
        <Button variant="outline" onClick={() => useApp.getState().openSettingsAt("models")}>
          Open Models
        </Button>
      </Row>

      <SubHeading>Hands-free</SubHeading>
      <Row label="Stop speaking when I talk" field="voiceBargeIn" description="Orbit stops talking the moment you start. Off lets it finish its reply; you can still interrupt by saying stop.">
        <Toggle label="Stop speaking when I talk" checked={s.voiceBargeIn} onChange={(v) => void save({ voiceBargeIn: v })} />
      </Row>
      <Row label="Pause before sending" field="voiceSilenceMs" description="How long you have to stop talking before what you said is sent. Applies the next time hands-free starts.">
        <Slider label="Pause before sending" field="voiceSilenceMs" min={500} max={5000} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} />
      </Row>
      <Row label="Ignore sounds shorter than" field="voiceMinSpeechMs" description="Coughs, clicks and short noises under this length are not treated as speech. Applies the next time hands-free starts.">
        <Slider label="Ignore sounds shorter than" field="voiceMinSpeechMs" min={100} max={2000} step={50} format={(v) => `${(v / 1000).toFixed(2)} s`} />
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
      <Row label="Voice engine" field="voiceTtsEngine" description={natural ? "Natural voices that run on this computer. Until the download finishes, replies use your Windows voice." : "The voices that come with Windows."}>
        <Segmented
          label="Voice engine"
          value={s.voiceTtsEngine}
          options={[
            { value: "kokoro", label: "Natural voice" },
            { value: "system", label: "Windows voices" },
          ]}
          onChange={(v) => void save({ voiceTtsEngine: v })}
        />
      </Row>
      {natural && kokoro && (
        <Row label="Natural voice" stacked description="The voice model and its eight voices download together once and run entirely on this computer.">
          <div className="w-full">
            <PackRow model={kokoro} title="Natural voice" />
          </div>
        </Row>
      )}
      {natural ? (
        <Row label="Voice" field="voiceKokoroVoice" description={testNote ?? undefined}>
          <Select label="Voice" value={s.voiceKokoroVoice} options={KOKORO_VOICES.map((v) => ({ value: v.id, label: v.label }))} onChange={(v) => void save({ voiceKokoroVoice: v as KokoroVoiceId })} className="max-w-[200px]" />
          <Button variant="outline" onClick={() => void test()}>
            <Volume2 className="size-3.5" /> {testing ? "Stop" : "Test voice"}
          </Button>
        </Row>
      ) : (
        <Row label="Voice" field="voiceTtsVoice" description={testNote ?? (tts.ttsAvailable() ? "Voices come from your operating system." : "This system has no speech synthesis.")}>
          <Select label="Voice" value={s.voiceTtsVoice} options={systemOptions} onChange={(v) => void save({ voiceTtsVoice: v })} className="max-w-[260px]" />
          <Button variant="outline" onClick={() => void test()} disabled={!tts.ttsAvailable()}>
            <Volume2 className="size-3.5" /> {testing ? "Stop" : "Test voice"}
          </Button>
        </Row>
      )}
      <Row label="Speed" field="voiceTtsRate">
        <Slider label="Speech speed" field="voiceTtsRate" min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}x`} />
      </Row>
    </>
  );
}
