import { LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { confirmAction } from "../../lib/confirm";
import { api, type McpServer } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { Button } from "../ui";
import { Toggle } from "./controls";

type Pair = { key: string; value: string };
type Draft = { id: string; name: string; transport: "stdio" | "http"; command: string; args: string; env: Pair[]; url: string; headers: Pair[]; enabled: boolean };

const blank = (): Draft => ({ id: "", name: "", transport: "stdio", command: "", args: "", env: [], url: "", headers: [], enabled: true });
const pairs = (m: Record<string, string>): Pair[] => Object.entries(m).map(([key, value]) => ({ key, value }));
const toMap = (p: Pair[]) => Object.fromEntries(p.filter((x) => x.key.trim()).map((x) => [x.key.trim(), x.value]));
const toDraft = (s: McpServer): Draft => ({ id: s.id, name: s.name, transport: s.transport, command: s.command, args: s.args.join("\n"), env: pairs(s.env), url: s.url ?? "", headers: pairs(s.headers), enabled: s.enabled });
const toServer = (d: Draft): McpServer => ({
  id: d.id, name: d.name.trim(), transport: d.transport, enabled: d.enabled,
  command: d.transport === "stdio" ? d.command.trim() : "",
  args: d.transport === "stdio" ? d.args.split("\n").filter((a) => a.trim()) : [],
  env: d.transport === "stdio" ? toMap(d.env) : {},
  url: d.transport === "http" ? d.url.trim() : null,
  headers: d.transport === "http" ? toMap(d.headers) : {},
});

const field = "h-7 min-w-0 rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] placeholder:text-mute focus:border-accent";

function PairRows({ label, rows, onChange }: { label: string; rows: Pair[]; onChange: (r: Pair[]) => void }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11.5px] text-mute">
        <span>{label}</span>
        <button className="hover:text-fg" onClick={() => onChange([...rows, { key: "", value: "" }])}>+ Add</button>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-1.5">
          <input aria-label={`${label} name`} className={`${field} w-[35%]`} value={r.key} placeholder="Name" onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
          <input aria-label={`${label} value`} className={`${field} flex-1`} value={r.value} placeholder="Value" onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button aria-label="Remove row" className="text-mute hover:text-fg" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="size-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

function Form({ initial, onDone }: { initial: Draft; onDone: () => void }) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const submit = async () => {
    setBusy(true);
    try {
      await api.saveMcpServer(toServer(d));
      onDone();
    } catch (e) {
      useApp.getState().setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 border-b border-line py-4">
      <div className="flex gap-2">
        <input aria-label="Server name" className={`${field} w-[200px]`} placeholder="name (a-z, 0-9, - _)" value={d.name} onChange={(e) => set({ name: e.target.value })} />
        <select aria-label="Transport" className={field} value={d.transport} onChange={(e) => set({ transport: e.target.value as Draft["transport"] })}>
          <option value="stdio">stdio (command)</option>
          <option value="http">HTTP (URL)</option>
        </select>
      </div>
      {d.transport === "stdio" ? (
        <>
          <input aria-label="Command" className={`${field} w-full font-mono`} placeholder="Command, e.g. npx" value={d.command} onChange={(e) => set({ command: e.target.value })} />
          <textarea aria-label="Arguments" rows={3} className={`${field} h-auto w-full py-1 font-mono`} placeholder="Arguments, one per line" value={d.args} onChange={(e) => set({ args: e.target.value })} />
          <PairRows label="Environment" rows={d.env} onChange={(env) => set({ env })} />
        </>
      ) : (
        <>
          <input aria-label="URL" className={`${field} w-full font-mono`} placeholder="https://example.com/mcp" value={d.url} onChange={(e) => set({ url: e.target.value })} />
          <PairRows label="Headers" rows={d.headers} onChange={(headers) => set({ headers })} />
        </>
      )}
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy && <LoaderCircle className="size-3.5 animate-spin" />}Save</Button>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

export function Mcp() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string } | "busy">>({});
  const [candidates, setCandidates] = useState<McpServer[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const setError = useApp.getState().setError;
  const reload = useCallback(() => api.listMcpServers().then(setServers).catch((e) => setError(String(e))), [setError]);
  useEffect(() => { void reload(); }, [reload]);

  const test = async (s: McpServer) => {
    setResults((r) => ({ ...r, [s.id]: "busy" }));
    try {
      const i = await api.testMcpServer(s);
      setResults((r) => ({ ...r, [s.id]: { ok: true, text: `${i.name} ${i.version}` } }));
    } catch (e) {
      setResults((r) => ({ ...r, [s.id]: { ok: false, text: String(e) } }));
    }
  };
  const startImport = async () => {
    try {
      const found = (await api.importClaudeMcp()).filter((c) => !servers.some((s) => s.name === c.name));
      setCandidates(found);
      setPicked(new Set(found.map((c) => c.id)));
    } catch (e) { setError(String(e)); }
  };
  const doImport = async () => {
    try {
      for (const c of candidates ?? []) if (picked.has(c.id)) await api.saveMcpServer({ ...c, id: "" });
    } catch (e) { setError(String(e)); }
    setCandidates(null);
    void reload();
  };

  return (
    <div>
      <div className="flex gap-2 py-3">
        <Button variant="outline" onClick={() => setEditing(blank())}><Plus className="size-3.5" />Add server</Button>
        <Button variant="outline" onClick={() => void startImport()}>Import from Claude</Button>
      </div>
      <p className="pb-2 text-[11.5px] leading-relaxed text-mute">Servers are given to both Claude and Codex in every workspace. Changes apply to new sessions; turn them off per workspace from the skill packs dialog.</p>
      {editing && <Form key={editing.id || "new"} initial={editing} onDone={() => { setEditing(null); void reload(); }} />}
      {candidates && (
        <div className="space-y-2 border-b border-line py-4 text-[12px]">
          {candidates.length === 0 && <p className="text-mute">No new servers found in ~/.claude.json.</p>}
          {candidates.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <input type="checkbox" checked={picked.has(c.id)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
              <span className="font-medium">{c.name}</span>
              <span className="text-mute">{c.transport}</span>
              <span className="truncate font-mono text-[11px] text-mute">{c.transport === "http" ? c.url : [c.command, ...c.args].join(" ")}</span>
            </label>
          ))}
          <div className="flex gap-2">
            <Button variant="primary" disabled={picked.size === 0} onClick={() => void doImport()}>Import selected</Button>
            <Button variant="outline" onClick={() => setCandidates(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {servers.length === 0 && !editing && <p className="py-4 text-[12px] text-mute">No MCP servers yet.</p>}
      {servers.map((s) => {
        const r = results[s.id];
        return (
          <div key={s.id} className="border-b border-line py-3">
            <div className="flex items-center gap-3">
              <span className="text-[13px] font-medium">{s.name}</span>
              <span className="label text-mute">{s.transport}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mute">{s.transport === "http" ? s.url : [s.command, ...s.args].join(" ")}</span>
              <Button variant="outline" onClick={() => void test(s)} disabled={r === "busy"}>{r === "busy" && <LoaderCircle className="size-3.5 animate-spin" />}Test</Button>
              <button aria-label={`Edit ${s.name}`} className="text-mute hover:text-fg" onClick={() => setEditing(toDraft(s))}><Pencil className="size-3.5" /></button>
              <button aria-label={`Delete ${s.name}`} className="text-mute hover:text-fg" onClick={async () => { if (await confirmAction(`Delete the ${s.name} MCP server?`, "Delete")) { await api.deleteMcpServer(s.id); void reload(); } }}><Trash2 className="size-3.5" /></button>
              <Toggle label={`Enable ${s.name}`} checked={s.enabled} onChange={(enabled) => void api.saveMcpServer({ ...s, enabled }).then(reload).catch((e) => setError(String(e)))} />
            </div>
            {r && r !== "busy" && <p className={`mt-1 text-[11.5px] ${r.ok ? "text-ok" : "text-bad"}`}>{r.ok ? `Connected: ${r.text}` : r.text}</p>}
          </div>
        );
      })}
    </div>
  );
}
