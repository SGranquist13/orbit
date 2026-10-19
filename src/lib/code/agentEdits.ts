import type { AgentEvent } from "../ipc";

/** Canonical lexical paths; never let a tool path escape the open root. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  const source = path.replace(/\\/g, "/");
  for (const part of source.split("/")) {
    if (!part) continue;
    if (part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return (source.startsWith("/") ? "/" : "") + parts.join("/");
}
export const samePath = (a: string, b: string) => {
  const canonical = (s: string) => normalizePath(s).replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
  return canonical(a) === canonical(b);
};

export function editedPaths(event: AgentEvent, cwd: string): string[] {
  if (event.type !== "toolCall" || !event.input || typeof event.input !== "object") return [];
  const input = event.input as Record<string, unknown>;
  let paths: unknown[] = [];
  if (["Write", "Edit", "MultiEdit"].includes(event.name)) paths = [input.file_path];
  if (event.name === "NotebookEdit") paths = [input.notebook_path];
  if (event.name === "Edit" && Array.isArray(input.files))
    paths.push(...input.files.map((file) => (typeof file === "string" ? file : file?.path)));
  const root = normalizePath(cwd);
  return [
    ...new Set(
      paths.flatMap((path) => {
        if (typeof path !== "string" || !path) return [];
        const absolute = /^(?:[a-z]:[/\\]|[/\\])/i.test(path);
        const full = normalizePath(absolute ? path : `${root}/${path}`);
        if (root === "/") return full.startsWith("/") && full.length > 1 ? [full.slice(1)] : [];
        const prefix = full.slice(0, root.length);
        if (!samePath(prefix, root) || full[root.length] !== "/") return [];
        const rel = full.slice(root.length + 1);
        return rel && !rel.includes(":") ? [rel] : [];
      }),
    ),
  ];
}

export function createEditTracker() {
  const pending = new Map<string, string[]>();
  return {
    clear: () => pending.clear(),
    accept(event: AgentEvent, cwd: string): { id: string; paths: string[]; phase: "pending" | "landed" | "failed" } | null {
      if (event.type === "toolCall") {
        const paths = editedPaths(event, cwd);
        if (!paths.length) return null;
        pending.set(event.id, paths);
        return { id: event.id, paths, phase: "pending" };
      }
      if (event.type !== "toolResult") return null;
      const paths = pending.get(event.id);
      if (!paths) return null;
      pending.delete(event.id);
      return { id: event.id, paths, phase: event.isError ? "failed" : "landed" };
    },
  };
}
