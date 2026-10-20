// Pure helpers over `Settings` (see src-tauri/src/settings.rs for the source of truth).
import type { AgentKind, ModelInfo, Settings } from "./ipc";
import { useApp } from "../stores/app";

/** Built-in model ids per agent; blank = the agent's own configured default. */
export const BUILTIN_MODELS: Record<AgentKind, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"],
};

/** Model ids offered in pickers: agent default, discovered models, then extra ids. */
export function modelsFor(agent: AgentKind, settings: Settings | null, lists = useApp.getState().agentModels): string[] {
  const extra = (agent === "claude" ? settings?.extraModelsClaude : settings?.extraModelsCodex) ?? [];
  const ids = lists[agent]?.map((m) => m.id) ?? BUILTIN_MODELS[agent];
  return ["", ...new Set([...ids, ...extra].filter(Boolean))];
}

export function modelLabelFor(agent: AgentKind, id: string, lists: Partial<Record<AgentKind, ModelInfo[]>>): string {
  return lists[agent]?.find((m) => m.id === id)?.label ?? id;
}

export function defaultModelFor(agent: AgentKind, settings: Settings | null): string {
  const m = (agent === "claude" ? settings?.defaultModelClaude : settings?.defaultModelCodex) ?? "";
  return m;
}

/** The agent/model a new workspace should start with, from settings. */
export function defaultAgentModel(): { agent: AgentKind; model: string } {
  const settings = useApp.getState().settings;
  const agent = settings?.defaultAgent ?? "claude";
  return { agent, model: defaultModelFor(agent, settings) };
}

/** Mirrors `normalize_prefix` in settings.rs so the live example matches what gets saved. */
export function normalizePrefix(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9/_-]/g, "-")
    .replace(/^[/-]+|[/-]+$/g, "")
    .split("/")
    .filter(Boolean)
    .join("/");
  return cleaned ? `${cleaned}/` : "";
}
