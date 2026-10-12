// Settings > Models: where Orbit's small background model calls run (Claude by default, or a local
// Ollama / OpenAI-compatible server). Coding agents are not affected, except the experimental toggle.
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type LocalStatus, type LocalTestResult, type Settings } from "../../lib/ipc";
import { Button } from "../ui";
import { Dot, Row, Segmented, Select, SubHeading, TextInput, Toggle, save, useSettings } from "./controls";

/** Small instruct model that returned valid JSON in our tests, ~2 GB. */
const SUGGESTED_MODEL = "llama3.2:3b";

type TaskField = "modelSuggestions" | "modelWorkspaceName" | "modelCommitMessage" | "modelRoutineSummary" | "modelPrDescription" | "modelTeammateReport" | "modelChiefPlan";

const TASKS: { field: TaskField; label: string; description: string; optional: boolean }[] = [
  { field: "modelSuggestions", label: "Inbox suggestions", description: "Next-prompt ideas on each inbox item.", optional: true },
  { field: "modelWorkspaceName", label: "Workspace names", description: "A short name from your first prompt. Off keeps the first line of the prompt.", optional: true },
  { field: "modelCommitMessage", label: "Commit messages", description: "Save-point messages, when Settings > Git > Save-point messages is Written by a model.", optional: false },
  { field: "modelRoutineSummary", label: "Routine summaries", description: "The one-line summary of each routine run, and whether it had nothing to do.", optional: false },
  { field: "modelPrDescription", label: "PR description drafts", description: "Only used with a local model: on Ship, Orbit drafts the PR title and body from the diff and hands it to the agent as a starting point. At Default the agent writes the PR itself.", optional: false },
  { field: "modelTeammateReport", label: "Teammate reports", description: "The short report a teammate posts in its thread when a task turn ends, and whether it needs you.", optional: false },
  { field: "modelChiefPlan", label: "Chief's plans", description: "Splits a request into parts for your teammates when you message Chief. Also used for Chief's combined report (Teammate reports).", optional: false },
];

export function formatBytes(n: number): string {
  if (n <= 0) return "";
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

function useLocalStatus(deps: unknown[]) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.localModelsStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void refresh(), [refresh, ...deps]);
  return { status, loading, refresh };
}

function describe(s: Settings, status: LocalStatus | null, loading: boolean): { tone: "ok" | "warn" | "bad"; text: string } {
  if (!status) return { tone: "warn", text: loading ? "Checking…" : "Status unavailable" };
  if (s.localProvider === "openai") {
    const o = status.openaiCompat;
    return o.reachable
      ? { tone: "ok", text: `Connected · ${o.models.length} ${o.models.length === 1 ? "model" : "models"}` }
      : { tone: "bad", text: `Not reachable at ${o.url}` };
  }
  const o = status.ollama;
  return o.running
    ? { tone: "ok", text: `Connected · Ollama ${o.version ?? ""} · ${o.models.length} ${o.models.length === 1 ? "model" : "models"}` }
    : { tone: "bad", text: "Not running" };
}

function ModelRow({ name, detail, backend }: { name: string; detail: string; backend: "ollama" | "openaiCompat" }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LocalTestResult | null>(null);
  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.testLocalModel(backend, name));
    } catch (e) {
      setResult({ ok: false, latencyMs: 0, output: null, error: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 border-b border-line py-2 text-[12px]">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        <div className="truncate text-[11.5px] tabular-nums text-mute">{detail}</div>
      </div>
      {result && (
        <span className="flex max-w-[260px] items-center gap-1.5 truncate text-[11.5px] font-medium tabular-nums text-dim" title={result.error ?? result.output ?? ""}>
          <Dot tone={result.ok ? "ok" : "bad"} />
          {result.ok ? `${(result.latencyMs / 1000).toFixed(1)} s` : (result.error ?? "Failed")}
        </span>
      )}
      <Button variant="outline" disabled={busy} onClick={() => void test()} aria-label={`Test ${name}`}>
        {busy && <LoaderCircle className="size-3.5 animate-spin" />}
        Test
      </Button>
    </div>
  );
}

export function Models() {
  const s = useSettings();
  const { status, loading, refresh } = useLocalStatus([s?.localProvider, s?.localUrl, s?.localApiKey]);
  if (!s) return null;
  const openai = s.localProvider === "openai";
  const state = describe(s, status, loading);
  const installed = openai ? (status?.openaiCompat.models ?? []) : (status?.ollama.models.map((m) => m.name) ?? []);
  const serverUp = openai ? !!status?.openaiCompat.reachable : !!status?.ollama.running;
  const defaultLocal = s.localDefaultModel || installed[0] || "";

  const optionsFor = (field: TaskField, optional: boolean) => {
    const current = s[field];
    const opts = [
      { value: "default", label: `Default (Claude ${s.suggestionModel})` },
      ...installed.map((m) => ({ value: `local:${m}`, label: `Local: ${m}` })),
    ];
    if (current.startsWith("local:") && !installed.includes(current.slice(6))) opts.push({ value: current, label: `Local: ${current.slice(6)} (unavailable)` });
    if (optional) opts.push({ value: "off", label: "Off" });
    return opts;
  };

  const useLocalForAll = () => {
    if (!defaultLocal) return;
    const value = `local:${defaultLocal}`;
    void save({ localDefaultModel: defaultLocal, modelSuggestions: value, modelWorkspaceName: value, modelCommitMessage: value, modelRoutineSummary: value, modelPrDescription: value, modelTeammateReport: value, modelChiefPlan: value });
  };

  return (
    <>
      <p className="py-3 text-[12px] leading-relaxed text-mute">
        Orbit makes small background calls around your agents, like inbox suggestions and commit messages. Run them on a local model and they are free and private, but slower and less accurate than Claude. Coding always stays on Claude or Codex.
      </p>

      <SubHeading>Local server</SubHeading>
      <div className="border-t border-line">
        <Row label="Provider" field="localProvider" description="Ollama, or any server with an OpenAI-compatible API (LM Studio, llama.cpp, vLLM).">
          <Segmented<"ollama" | "openai">
            label="Provider"
            value={s.localProvider}
            options={[
              { value: "ollama", label: "Ollama" },
              { value: "openai", label: "OpenAI-compatible" },
            ]}
            onChange={(v) => void save({ localProvider: v, localDefaultModel: "" })}
          />
        </Row>
        <Row label="URL" field="localUrl" description={`Leave empty for ${openai ? "http://localhost:1234" : "http://localhost:11434"}.`}>
          <TextInput label="Server URL" value={s.localUrl} placeholder={openai ? "http://localhost:1234" : "http://localhost:11434"} onCommit={(v) => void save({ localUrl: v })} />
        </Row>
        {openai && (
          <Row label="API key" field="localApiKey" description="Optional. Stored in Orbit's settings database and sent only to this server.">
            <TextInput label="API key" type="password" value={s.localApiKey} placeholder="none" onCommit={(v) => void save({ localApiKey: v })} />
          </Row>
        )}
        <Row label="Timeout" field="localTimeoutSecs" description="After this, a task falls back to its default (or is skipped). The first call after loading a model is slowest.">
          <Select<string>
            label="Timeout"
            value={String(s.localTimeoutSecs)}
            options={[15, 30, 60, 120, 300].map((n) => ({ value: String(n), label: `${n} seconds` }))}
            onChange={(v) => void save({ localTimeoutSecs: Number(v) })}
            className="tabular-nums"
          />
        </Row>
        <Row label="Status" description={status?.lastErrors[openai ? "openaiCompat" : "ollama"] ? `Last problem: ${status.lastErrors[openai ? "openaiCompat" : "ollama"]}` : undefined}>
          <span className="flex items-center gap-2 text-[12px] font-medium text-dim">
            <Dot tone={state.tone} /> {state.text}
          </span>
          <Button variant="outline" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} /> Refresh
          </Button>
        </Row>
      </div>

      {serverUp ? (
        <>
          <SubHeading>Installed models</SubHeading>
          <div className="border-t border-line">
            {installed.length === 0 && <p className="border-b border-line py-3 text-[11.5px] text-mute">No models yet. Try <code>ollama pull {SUGGESTED_MODEL}</code>.</p>}
            {!openai &&
              status?.ollama.models.map((m) => (
                <ModelRow
                  key={m.name}
                  name={m.name}
                  backend="ollama"
                  detail={[formatBytes(m.sizeBytes), m.parameterSize && `${m.parameterSize} params`, m.quantization].filter(Boolean).join(" · ")}
                />
              ))}
            {openai && status?.openaiCompat.models.map((m) => <ModelRow key={m} name={m} backend="openaiCompat" detail="" />)}
          </div>
        </>
      ) : (
        status && (
          <p className="border-b border-line py-3 text-[11.5px] leading-relaxed text-mute">
            {openai ? "Start your server and check the URL above." : <>Install Ollama, then run <code>ollama pull {SUGGESTED_MODEL}</code> (about 2 GB).</>}
          </p>
        )
      )}

      <SubHeading>Model per task</SubHeading>
      <div className="border-t border-line">
        <Row label="Default Claude model" field="suggestionModel" description="Used by every task set to Default, and as the fallback when a local model fails.">
          <Segmented<"haiku" | "sonnet">
            label="Default Claude model"
            value={s.suggestionModel}
            options={[
              { value: "haiku", label: "Haiku" },
              { value: "sonnet", label: "Sonnet" },
            ]}
            onChange={(v) => void save({ suggestionModel: v })}
          />
        </Row>
        {TASKS.map((t) => (
          <Row key={t.field} label={t.label} field={t.field} description={t.description}>
            <Select<string> label={t.label} value={s[t.field]} options={optionsFor(t.field, t.optional)} onChange={(v) => void save({ [t.field]: v })} className="min-w-[220px]" />
          </Row>
        ))}
        <Row label="Use local for all utility tasks" description="Points every task above at one local model. You can still change them one by one.">
          <Select<string>
            label="Local model for all tasks"
            value={defaultLocal}
            options={installed.length ? installed.map((m) => ({ value: m, label: m })) : [{ value: "", label: "No local models" }]}
            onChange={(v) => void save({ localDefaultModel: v })}
          />
          <Button variant="outline" disabled={!defaultLocal} onClick={useLocalForAll}>
            Apply
          </Button>
        </Row>
      </div>

      <SubHeading>Experimental</SubHeading>
      <div className="border-t border-line">
        <Row
          label="Run agents on local models"
          field="localAgents"
          description="Adds Local models to the model picker in New workspace, for both Claude Code and Codex, through Ollama only. Agents need tool use and a big context window: pick a tool-capable model and start Ollama with OLLAMA_CONTEXT_LENGTH=16384 or more. Small models often fail to call tools."
        >
          <Toggle label="Run agents on local models" checked={s.localAgents} onChange={(v) => void save({ localAgents: v })} />
        </Row>
      </div>
    </>
  );
}
