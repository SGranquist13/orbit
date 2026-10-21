import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { VoiceModelId } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { useVoice } from "../../stores/voice";
import { Button } from "../ui";

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** Mounted once; closing the overlay never cancels store-owned downloads. */
export function VoiceSetup() {
  const setup = useVoice((s) => s.setup);
  return setup ? <SetupDialog /> : null;
}

function SetupDialog() {
  const models = useVoice((s) => s.models);
  const downloads = useVoice((s) => s.downloads);
  const loading = useVoice((s) => s.setupLoading);
  const error = useVoice((s) => s.setupError);
  const speechId = useApp((s) => s.settings?.voiceModel ?? "base.en");
  const [checked, setChecked] = useState<Partial<Record<VoiceModelId, boolean>>>({ [speechId]: true, kokoro: true });
  const panel = useRef<HTMLDivElement>(null);
  const close = () => useVoice.getState().closeSetup();
  const rows = [
    { id: speechId, title: "Speech recognition", description: `Whisper ${speechId}, understands what you say` },
    { id: "kokoro" as const, title: "Natural voice", description: "Kokoro, reads replies aloud in a human-sounding voice" },
  ];
  const selected = rows.filter((r) => checked[r.id]);
  const pending = selected.filter((r) => !models.find((m) => m.id === r.id)?.installed);
  const busy = rows.some((r) => downloads[r.id] && !downloads[r.id]?.error);
  const ready = !loading && !error && pending.length === 0 &&
    (selected.length > 0 || rows.every((r) => models.find((m) => m.id === r.id)?.installed));
  const total = pending.reduce((sum, r) => sum + (models.find((m) => m.id === r.id)?.sizeBytes ?? 0), 0);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLButtonElement>("[data-voice-primary]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        useVoice.getState().closeSetup();
      } else if (e.key === "Tab") {
        const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
        const first = elements[0], last = elements[elements.length - 1];
        if (e.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) {
          e.preventDefault(); last?.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) {
          e.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const download = () => {
    // Each store action starts immediately; neither pack waits on the other.
    void Promise.all(pending.map((r) => useVoice.getState().download(r.id)));
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay p-4" onMouseDown={close}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="Set up voice" onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] rounded-[6px] border-[1.5px] border-line-strong bg-raised p-5 text-fg shadow-hard">
        <h2 className="text-[16px] font-semibold">Set up voice</h2>
        <p className="mt-2 text-[12px] text-dim">Speech is recognised and spoken on this computer. Two one-time downloads:</p>
        <div className="mt-4 divide-y divide-line">
          {rows.map((row) => {
            const model = models.find((m) => m.id === row.id);
            const dl = downloads[row.id];
            const running = !!dl && !dl.error;
            const pct = dl && dl.total > 0 ? Math.min(100, Math.round(dl.received / dl.total * 100)) : 0;
            return (
              <div key={row.id} className="py-3 first:pt-0">
                <div className="flex items-start gap-2.5">
                  {model?.installed ? <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ok" /> : (
                    <input type="checkbox" aria-label={row.title} checked={!!checked[row.id]} disabled={busy || loading}
                      onChange={(e) => setChecked((s) => ({ ...s, [row.id]: e.target.checked }))}
                      className="mt-0.5 size-4 shrink-0 accent-accent" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 text-[12.5px] font-medium">
                      <span>{row.title}</span>
                      <span className="shrink-0 text-[11px] font-normal tabular-nums text-mute">{model?.installed ? "Installed" : model ? mb(model.sizeBytes) : "…"}</span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-mute">{row.description}</p>
                    {running && <div role="status" className="mt-2 text-[11.5px] tabular-nums text-dim">
                      Downloading… {pct}%
                      <div role="progressbar" aria-label={row.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
                        className="relative mt-1 h-1.5 overflow-hidden rounded-[2px] bg-line">
                        <span className="dither-50 absolute inset-y-0 left-0 bg-run" style={{ width: `${pct}%` }} />
                      </div>
                    </div>}
                    {dl?.error && <div role="alert" className="mt-2 text-[11.5px] text-bad">
                      <span className="selectable">Download failed: {dl.error}</span>{" "}
                      <Button variant="outline" className="h-6" onClick={() => void useVoice.getState().download(row.id)}>Retry</Button>
                    </div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {error && <p role="alert" className="mt-2 text-[12px] text-bad">Could not load voice models: {error}{" "}
          <Button variant="outline" onClick={() => void useVoice.getState().refreshModels()}>Retry</Button>
        </p>}
        {ready && <p role="status" className="mt-3 text-[12px] text-ok">Voice is ready.</p>}
        <div className="mt-5 flex justify-end gap-2">
          {!ready && <Button onClick={close}>{busy ? "Hide" : "Not now"}</Button>}
          <Button data-voice-primary variant="primary" aria-disabled={!ready && (loading || !!error || busy || pending.length === 0)}
            onClick={() => {
              if (ready) useVoice.getState().closeSetup(true);
              else if (!loading && !error && !busy && pending.length > 0) download();
            }} disabled={busy}>
            {busy ? "Downloading…" : ready ? "Done" : loading ? "Loading…" : `Download (${mb(total)})`}
          </Button>
        </div>
      </div>
    </div>, document.body,
  );
}
