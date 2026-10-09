// Pure helpers over `Settings` (see src-tauri/src/settings.rs for the source of truth).
import type { AgentKind, Settings } from "./ipc";
import { useApp } from "../stores/app";

/** Built-in model ids per agent; blank = the agent's own configured default. */
export const BUILTIN_MODELS: Record<AgentKind, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"],
};

/** Model ids offered in pickers: blank (agent default), built-ins, then the user's extra ids. */
export function modelsFor(agent: AgentKind, settings: Settings | null): string[] {
  const extra = (agent === "claude" ? settings?.extraModelsClaude : settings?.extraModelsCodex) ?? [];
  return ["", ...new Set([...BUILTIN_MODELS[agent], ...extra])];
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
