// Folds the flat normalized event stream into blocks the chat view renders.
import type { StoredEvent } from "./ipc";

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
}

export type Block =
  | { kind: "user"; key: string; text: string; skill?: string }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "tools"; key: string; calls: ToolCallView[] }
  | { kind: "turnEnd"; key: string; durationMs: number | null; costUsd: number | null; error: string | null; interrupted: boolean }
  | { kind: "error"; key: string; message: string };

export function fold(events: StoredEvent[]): Block[] {
  const blocks: Block[] = [];
  const calls = new Map<string, ToolCallView>();

  for (const { seq, event: ev } of events) {
    const key = String(seq);
    const last = blocks[blocks.length - 1];
    switch (ev.type) {
      case "userMessage":
        blocks.push({ kind: "user", key, text: ev.text, skill: ev.skill });
        break;
      case "message":
        if (ev.text.trim()) blocks.push({ kind: "assistant", key, text: ev.text });
        break;
      case "toolCall": {
        const call: ToolCallView = { id: ev.id, name: ev.name, input: ev.input };
        calls.set(ev.id, call);
        // Consecutive tool calls collapse into one group, like "5 tool calls".
        if (last?.kind === "tools") last.calls.push(call);
        else blocks.push({ kind: "tools", key, calls: [call] });
        break;
      }
      case "toolResult": {
        const call = calls.get(ev.id);
        if (call) {
          call.output = ev.output;
          call.isError = ev.isError;
        }
        break;
      }
      case "turnCompleted":
        blocks.push({
          kind: "turnEnd",
          key,
          durationMs: ev.durationMs,
          costUsd: ev.costUsd,
          error: ev.isError ? (ev.error ?? "Turn failed") : null,
          interrupted: !!ev.interrupted,
        });
        break;
      case "error":
        blocks.push({ kind: "error", key, message: ev.message });
        break;
      case "exited":
        if (ev.code !== null && ev.code !== 0) {
          blocks.push({
            kind: "error",
            key,
            message: `Agent exited with code ${ev.code}${ev.stderr ? `\n${ev.stderr}` : ""}`,
          });
        }
        break;
    }
  }
  return blocks;
}

/** One-line summary of a tool call's input, e.g. the command or file it touched. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
  switch (name) {
    case "Bash":
      return str(i.command);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      if (Array.isArray(i.files)) return i.files.map((f) => base(String(f))).join(", ");
      return base(str(i.file_path) || str(i.notebook_path));
    case "Grep":
    case "Glob":
      return str(i.pattern);
    case "WebSearch":
      return str(i.query);
    case "WebFetch":
      return str(i.url);
    case "Task":
    case "Agent":
      return str(i.description);
    case "TodoWrite":
      return Array.isArray(i.todos) ? `${i.todos.length} todos` : "";
    default:
      return "";
  }
}

export function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
