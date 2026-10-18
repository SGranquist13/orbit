import { LoaderCircle, QrCode } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { timeAgo } from "../../lib/attention";
import { api, type RemoteDevice, type RemotePairing, type RemoteStatus } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { Button } from "../ui";
import { Dot, Row, SubHeading, TextInput, Toggle, save, useSettings } from "./controls";

function useCountdown(expiresAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
}

function PairingPanel({ pairing, onRefresh, onClose }: { pairing: RemotePairing; onRefresh: () => void; onClose: () => void }) {
  const left = useCountdown(pairing.expiresAt);
  const expired = left <= 0;
  return (
    <div className="flex flex-wrap items-start gap-5 border-b border-line py-4">
      {/* Functional exception to the greyscale rule: a QR code needs dark-on-light contrast to scan. */}
      <div
        aria-label="Pairing QR code"
        role="img"
        className={`size-[220px] shrink-0 rounded-[4px] border-[1.5px] border-line-strong bg-white p-0 [&>svg]:size-full ${expired ? "opacity-20" : ""}`}
        dangerouslySetInnerHTML={{ __html: pairing.svg }}
      />
      <div className="min-w-0 flex-1 space-y-2.5 text-[12px]">
        <p className="leading-relaxed text-dim">Open Orbit on your phone and scan this code. It works once.</p>
        <p className="font-medium tabular-nums text-dim">
          {expired ? "Expired" : `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
        </p>
        <p className="selectable break-all text-[11.5px] leading-relaxed text-mute">{pairing.uri}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onRefresh}>
            New code
          </Button>
          <Button variant="outline" onClick={onClose}>
            Hide
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Mobile() {
  const s = useSettings();
  const setError = useApp.getState().setError;
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const enabled = s?.remoteEnabled;
  const port = s?.remotePort;

  const refresh = useCallback(() => {
    api
      .remoteStatus()
      .then((st) => (setStatus(st), setLoadError(null)))
      .catch((e) => setLoadError(String(e)));
    api
      .remoteDevices()
      .then(setDevices)
      .catch((e) => setLoadError(String(e)));
  }, []);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 3000);
    return () => window.clearInterval(t);
  }, [refresh, enabled, port]);

  // A freshly paired phone ends the pairing step.
  const deviceCount = devices.length;
  const [seenCount, setSeenCount] = useState<number | null>(null);
  useEffect(() => {
    if (!pairing) {
      setSeenCount(null);
      return;
    }
    if (seenCount === null) setSeenCount(deviceCount);
    else if (deviceCount > seenCount) setPairing(null);
  }, [deviceCount, pairing, seenCount]);

  // Turning the bridge off invalidates any visible code.
  useEffect(() => {
    if (enabled === false) setPairing(null);
  }, [enabled]);

  const showPairing = async () => {
    setPairingBusy(true);
    try {
      setPairing(await api.remotePairing());
      setSeenCount(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setPairingBusy(false);
    }
  };

  const revoke = async (d: RemoteDevice) => {
    try {
      await api.remoteRevoke(d.id);
      setDevices((list) => list.filter((x) => x.id !== d.id));
    } catch (e) {
      setError(String(e));
    }
  };

  if (!s) return null;
  const tone = loadError || status?.error ? "bad" : status?.running ? "ok" : "warn";
  const statusText = loadError
    ? `Couldn't reach the phone bridge: ${loadError}`
    : !status
    ? "Checking…"
    : status.error
      ? status.error
      : status.running
        ? `Listening on port ${status.port}`
        : "Off";

  return (
    <>
      <p className="pb-2 text-[12px] text-mute">Experimental: the companion iPhone app isn't publicly released yet.</p>
      <Row
        label="Allow phone connections"
        field="remoteEnabled"
        description="Lets the Orbit phone app watch and drive your workspaces. Everything is end-to-end encrypted and only paired phones can connect."
      >
        <Toggle label="Allow phone connections" checked={s.remoteEnabled} onChange={(v) => void save({ remoteEnabled: v })} />
      </Row>
      <Row label="Port" field="remotePort" description="TCP port Orbit listens on (1024-65535). Your firewall may ask to allow it.">
        <TextInput
          label="Port"
          className="w-24 tabular-nums"
          value={String(s.remotePort)}
          onCommit={(v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 1024 && n <= 65535) void save({ remotePort: n });
            else setError("Port must be a number from 1024 to 65535");
          }}
        />
      </Row>
      <Row
        label="Status"
        description={
          status?.running && status.addresses.length > 0 ? (
            <>
              <span className="selectable tabular-nums">{status.addresses.map((a) => `${a}:${status.port}`).join("   ")}</span>
              <br />
              Use the Tailscale address (100.x) to connect away from home.
            </>
          ) : undefined
        }
      >
        <span className="flex items-center gap-2 text-[12px] font-medium text-dim">
          <Dot tone={tone} /> {statusText}
        </span>
      </Row>

      <SubHeading>Paired phones</SubHeading>
      <Row label="Pair a phone" description={s.remoteEnabled ? "Shows a QR code for the Orbit app to scan." : "Turn on “Allow phone connections” first."}>
        <Button variant="outline" disabled={!s.remoteEnabled || !status?.running || pairingBusy} onClick={() => void showPairing()}>
          {pairingBusy ? <LoaderCircle className="size-3.5 animate-spin" /> : <QrCode className="size-3.5" />} Pair a phone
        </Button>
      </Row>
      {pairing && <PairingPanel pairing={pairing} onRefresh={() => void showPairing()} onClose={() => setPairing(null)} />}
      <div className="border-b border-line">
        {devices.length === 0 && !loadError && <p className="py-2.5 text-[12px] text-mute">No phones paired yet.</p>}
        {devices.length === 0 && loadError && <p className="selectable py-2.5 text-[12px] text-bad">Couldn't load paired phones: {loadError}</p>}
        {devices.map((d) => (
          <div key={d.id} className="flex items-center gap-3 border-b border-line py-2 text-[12px] last:border-b-0">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{d.name}</span>
              <span className="block truncate text-[11.5px] text-mute">
                Last seen {timeAgo(d.lastSeenAt)} · paired {new Date(d.pairedAt).toLocaleDateString()}
                {d.pushToken ? " · notifications on" : ""}
              </span>
            </span>
            <Button variant="outline" onClick={() => void revoke(d)}>
              Revoke
            </Button>
          </div>
        ))}
      </div>

      <Row
        label="Push notifications"
        field="remotePush"
        description="Notify paired phones when a turn finishes. Only the workspace name and whether it finished or failed are sent, through Expo's push service."
      >
        <Toggle label="Push notifications" checked={s.remotePush} onChange={(v) => void save({ remotePush: v })} />
      </Row>
    </>
  );
}
