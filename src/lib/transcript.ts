// Folds the flat normalized event stream into blocks the chat view renders.
import type { FileRef, ImageRef, StoredEvent } from "./ipc";

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  images?: ImageRef[];
}

export type Block =
  | { kind: "user"; key: string; text: string; skill?: string; images?: ImageRef[]; files?: FileRef[]; rewindSeq?: number }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "tools"; key: string; calls: ToolCallView[] }
  | {
      kind: "turnEnd";
      key: string;
      durationMs: number | null;
      costUsd: number | null;
      /** Total tokens the turn consumed (input + output + cache), from its `usage` event. */
      tokens: number | null;
      error: string | null;
      interrupted: boolean;
    }
  | { kind: "sessionReset"; key: string }
  | { kind: "error"; key: string; message: string };

export function fold(events: StoredEvent[]): Block[] {
  const blocks: Block[] = [];
  const calls = new Map<string, ToolCallView>();
  let turnTokens: number | null = null;
  let lastTurnSeq: number | undefined;

  for (const { seq, event: ev } of events) {
    const key = String(seq);
    const last = blocks[blocks.length - 1];
    switch (ev.type) {
      case "userMessage":
        blocks.push({ kind: "user", key, text: ev.text, skill: ev.skill, images: ev.images, files: ev.files, rewindSeq: lastTurnSeq });
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
          if (ev.images?.length) call.images = ev.images;
        }
        break;
      }
      case "usage":
        turnTokens = turnUsageTokens(ev);
        break;
      case "sessionReset":
        blocks.push({ kind: "sessionReset", key });
        break;
      case "turnCompleted":
        lastTurnSeq = seq;
        blocks.push({
          kind: "turnEnd",
          key,
          durationMs: ev.durationMs,
          costUsd: ev.costUsd,
          tokens: turnTokens,
          error: ev.isError ? (ev.error ?? "Turn failed") : null,
          interrupted: !!ev.interrupted,
        });
        turnTokens = null;
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

/** Tokens a turn added: input + output + cache writes (cache re-reads excluded, see lib/usage.ts). */
export function turnUsageTokens(u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) {
  return u.inputTokens + u.outputTokens + u.cacheWriteTokens;
}

/** 12400 -> "12.4k", 1_500_000 -> "1.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatCost(usd: number): string {
  return usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
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
    case "ViewImage":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      if (Array.isArray(i.files)) return i.files.map((f) => base(String(f))).join(", ");
      return base(str(i.file_path) || str(i.notebook_path) || str(i.path));
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
