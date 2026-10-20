import { FolderPlus, Lock, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_PROFILE, api, type AgentKind, type Profile } from "../lib/ipc";
import { defaultModelFor, modelLabelFor, modelsFor } from "../lib/settings";
import { useApp } from "../stores/app";
import { pickRepo } from "./Sidebar";
import { AgentIcon, Button, Kbd, agentLabel, cn } from "./ui";

/** First line of the prompt, trimmed to a sidebar-friendly title. */
function titleFrom(prompt: string) {
  const line = prompt.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

export function NewWorkspace() {
  const repos = useApp((s) => s.repos);
  const selectedRepo = useApp((s) => s.workspaces.find((w) => w.id === s.selectedId)?.repoId);
  const [repoId, setRepoId] = useState(() => useApp.getState().newWorkspacePrefill?.repoId ?? localStorage.getItem("lastRepo") ?? "");
  const settings = useApp((s) => s.settings);
  // Agent and model start from Settings; only the last repo is remembered between uses.
  const [agent, setAgent] = useState<AgentKind>(() => settings?.defaultAgent ?? "claude");
  const [model, setModel] = useState(() => defaultModelFor(settings?.defaultAgent ?? "claude", settings));
  const modelLists = useApp((s) => s.agentModels);
  const models = modelsFor(agent, settings, modelLists);
  // Experimental: installed Ollama models, offered for both agents (`local:<name>` in the workspace's model).
  const [localModels, setLocalModels] = useState<string[]>([]);
  useEffect(() => {
    if (!settings?.localAgents) return setLocalModels([]);
    let live = true;
    api.localModelsStatus().then((s) => live && setLocalModels(s.ollama.running ? s.ollama.models.map((m) => m.name) : []), () => {});
    return () => {
      live = false;
    };
  }, [settings?.localAgents]);
  if (model && !models.includes(model) && !model.startsWith("local:")) models.push(model);
  const profiles = useApp((s) => s.profiles);
  // Always start from Builder: silently inheriting a read-only profile from last time is a trap.
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles.find((p) => p.id === DEFAULT_PROFILE);
  const [prompt, setPrompt] = useState(() => useApp.getState().newWorkspacePrefill?.prompt ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!repos.some((r) => r.id === repoId)) setRepoId(selectedRepo ?? repos[0]?.id ?? "");
  }, [repos, repoId, selectedRepo]);
  useEffect(() => ref.current?.focus(), []);

  // A profile's preferred agent/model pre-selects them; the user can still change both.
  const pickProfile = (p: Profile) => {
    setProfileId(p.id);
    const nextAgent = p.agent ?? agent;
    if (p.agent) setAgent(p.agent);
    if (p.agent && p.agent !== agent) setModel(defaultModelFor(nextAgent, settings));
    if (p.model && modelsFor(nextAgent, settings, modelLists).includes(p.model)) setModel(p.model);
  };

  const close = () => useApp.getState().setNewWorkspaceOpen(false);

  const create = async () => {
    if (!repoId || busy) return;
    setBusy(true);
    localStorage.setItem("lastRepo", repoId);
    try {
      // No prompt = set the workspace up first: the worktree exists, the agent starts with your first message.
      const ws = await api.createWorkspace({
        repoId,
        name: name.trim() || titleFrom(prompt) || "New workspace",
        agent,
        model: model || null,
        prompt: prompt.trim() ? prompt : null,
        profile: profile?.id ?? null,
      });
      useApp.getState().upsertWorkspace(ws);
      useApp.getState().select(ws.id);
      close();
    } catch (e) {
      useApp.getState().setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-overlay pt-[12vh]" onMouseDown={close}>
      <div
        className="w-[600px] overflow-hidden rounded-[6px] border-[1.5px] border-line-strong bg-raised shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void create();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">New workspace</span>
          <span className="text-[12px] text-mute">
            {prompt.trim() ? "— fresh worktree + branch, agent starts immediately" : "— fresh worktree + branch; add a task now or later"}
          </span>
        </div>

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
          className="block w-full border-b border-line bg-transparent px-4 py-2 text-[13px] font-medium placeholder:text-mute focus:outline-none"
        />

        <textarea
          ref={ref}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder="Describe the task, or leave empty to set the workspace up first…"
          className="block w-full resize-none bg-transparent px-4 py-3 text-[15px] font-medium leading-relaxed placeholder:text-mute focus:outline-none"
        />

        {profiles.length > 0 && (
          <div className="border-t border-line px-3 py-2.5">
            <div className="flex flex-wrap gap-1">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  data-profile={p.id}
                  onClick={() => pickProfile(p)}
                  title={p.description}
                  className={cn(
                    "flex h-6 items-center gap-1 rounded-[3px] border-[1.5px] px-2 text-[12px] font-medium transition-colors",
                    profile?.id === p.id ? "border-fg bg-fg text-bg [&_svg]:text-bg" : "border-line-strong text-mute hover:text-dim",
                  )}
                >
                  {p.readonly && <Lock className="size-3" />}
                  {p.name}
                </button>
              ))}
            </div>
            {profile && <div className="mt-1.5 truncate text-[11.5px] text-mute">{profile.description}</div>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
          {repos.length > 0 ? (
            <select
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className="h-7 rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] font-medium text-fg focus:outline-none"
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : (
            <Button variant="outline" onClick={() => void pickRepo().then((r) => r && setRepoId(r.id))}>
              <FolderPlus className="size-3.5" /> Add repository
            </Button>
          )}

          <div className="flex rounded-[4px] border-[1.5px] border-line-strong p-0.5">
            {(["claude", "codex"] as const).map((a) => (
              <button
                key={a}
                onClick={() => {
                  setAgent(a);
                  setModel(defaultModelFor(a, settings));
                }}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-[2px] px-2 text-[12px] font-medium transition-colors",
                  agent === a ? "bg-fg text-bg [&_svg]:text-bg" : "text-mute hover:text-dim",
                )}
              >
                <AgentIcon agent={a} className="size-3" />
                {agentLabel[a]}
              </button>
            ))}
          </div>

          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-7 rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] font-medium text-fg focus:outline-none"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {modelLabelFor(agent, m, modelLists) || "default model"}
              </option>
            ))}
            {localModels.length > 0 && (
              <optgroup label="Local (Ollama) · Experimental">
                {localModels.map((m) => (
                  <option key={m} value={`local:${m}`}>
                    Local: {m} (experimental)
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          <span className="flex-1" />
          <span className="flex items-center gap-1 text-[11px] text-mute">
            <Kbd>Ctrl</Kbd>
            <Kbd>Enter</Kbd>
          </span>
          <Button variant="primary" onClick={() => void create()} disabled={!repoId || busy}>
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {prompt.trim() ? "Start" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}
