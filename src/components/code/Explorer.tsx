import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { bufferKey, useCode } from "../../stores/code";
import { useApp } from "../../stores/app";
import type { DirEntry } from "../../lib/ipc";
import { cn } from "../ui";

export type ExplorerAction = "new-file" | "new-folder" | "rename" | "delete" | "copy-path" | "reveal";
export function explorerAction(action: ExplorerAction) {
  window.dispatchEvent(new CustomEvent("orbit-code-explorer", { detail: action }));
}
const actions: [ExplorerAction, string][] = [
  ["new-file", "New file"],
  ["new-folder", "New folder"],
  ["rename", "Rename"],
  ["delete", "Delete"],
  ["copy-path", "Copy relative path"],
  ["reveal", "Reveal in Explorer"],
];

export function Explorer() {
  const root = useCode((s) => s.roots.find((r) => r.path === s.activeRoot)),
    dirs = useCode((s) => s.dirs),
    buffers = useCode((s) => s.buffers);
  const [focused, setFocused] = useState(""),
    [menu, setMenu] = useState<{ x: number; y: number; rel: string } | null>(null);
  const [editing, setEditing] = useState<{ from?: string; parent: string; dir: boolean; value: string } | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const rows: (DirEntry & { depth: number })[] = [];
  const visit = (rel: string, depth: number) => {
    for (const entry of dirs[bufferKey(root!.path, rel)] ?? []) {
      rows.push({ ...entry, depth });
      if (entry.dir && root!.expanded.includes(entry.rel)) visit(entry.rel, depth + 1);
    }
  };
  if (root) visit("", 0);
  const act = (action: ExplorerAction, rel = focused || root?.activeRel || "") => {
    if (!root) return;
    const entry = rows.find((r) => r.rel === rel);
    const parent = entry?.dir ? rel : rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    setMenu(null);
    if (action === "new-file" || action === "new-folder") {
      if (parent && !root.expanded.includes(parent)) useCode.getState().toggleDir(parent);
      setEditing({ parent, dir: action === "new-folder", value: "" });
    } else if (action === "rename" && rel)
      setEditing({
        from: rel,
        parent: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
        dir: entry?.dir ?? false,
        value: rel.split("/").pop()!,
      });
    else if (action === "delete" && rel) void useCode.getState().deleteEntry(rel);
    else if (action === "copy-path") void navigator.clipboard.writeText(rel).catch((e) => useApp.getState().setError(String(e)));
    else if (action === "reveal")
      void revealItemInDir(rel ? `${root.path}/${rel}` : root.path).catch((e) => useApp.getState().setError(String(e)));
  };
  useEffect(() => {
    const listener = (e: Event) => act((e as CustomEvent<ExplorerAction>).detail);
    window.addEventListener("orbit-code-explorer", listener);
    return () => window.removeEventListener("orbit-code-explorer", listener);
  });
  useEffect(() => {
    setFocused("");
    setMenu(null);
    setEditing(null);
  }, [root?.path]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);
  const input = editing && (
    <form
      className="px-3 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        const name = editing.value.trim();
        if (!name || name === "." || name === ".." || /[/\\]/.test(name)) return;
        const rel = [editing.parent, name].filter(Boolean).join("/");
        if (editing.from) void useCode.getState().renameEntry(editing.from, rel);
        else void useCode.getState().createEntry(rel, editing.dir);
        setEditing(null);
      }}
    >
      <label className="mb-1 block text-[11px] text-mute">
        {editing.from ? "Rename" : editing.dir ? "New folder" : "New file"}
        {editing.parent ? ` in ${editing.parent}` : ""}
      </label>
      <input
        aria-label={editing.from ? "Rename entry" : "Entry name"}
        autoFocus
        value={editing.value}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setEditing({ ...editing, value: e.target.value })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") setEditing(null);
        }}
        className="h-7 w-full rounded-[3px] border-[1.5px] border-line-strong bg-bg px-2 text-[12px] outline-none"
      />
      <div className="mt-1 flex gap-3 text-[11px] text-dim">
        <button type="submit">Apply</button>
        <button type="button" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b-[1.5px] border-line px-3 text-[11px] font-medium text-mute">
        <span>Explorer</span>
        <button title="New file" className="text-[16px] hover:text-fg" onClick={() => act("new-file")}>
          +
        </button>
      </div>
      {!editing?.from && input}
      <div
        role="tree"
        aria-label="Files"
        ref={tree}
        tabIndex={0}
        aria-activedescendant={focused ? `file-${focused}` : undefined}
        className="min-h-0 flex-1 overflow-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-line-strong"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 230), rel: "" });
        }}
        onKeyDown={(e) => {
          if (!root || editing) return;
          const index = rows.findIndex((r) => r.rel === focused),
            row = rows[index];
          if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "F2"].includes(e.key)) e.preventDefault();
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
            if (next) {
              setFocused(next.rel);
              document.getElementById(`file-${next.rel}`)?.scrollIntoView({ block: "nearest" });
            }
          } else if (row && e.key === "ArrowRight") {
            if (row.dir && !root.expanded.includes(row.rel)) useCode.getState().toggleDir(row.rel);
            else if (rows[index + 1]) setFocused(rows[index + 1].rel);
          } else if (row && e.key === "ArrowLeft") {
            if (row.dir && root.expanded.includes(row.rel)) useCode.getState().toggleDir(row.rel);
            else if (row.rel.includes("/")) setFocused(row.rel.slice(0, row.rel.lastIndexOf("/")));
          } else if (row && e.key === "Enter") {
            if (row.dir) useCode.getState().toggleDir(row.rel);
            else void useCode.getState().openFile(row.rel, { preview: false });
          } else if (e.key === "F2") act("rename");
          else if (e.key === "Escape") setMenu(null);
        }}
      >
        {rows.map((entry) => (
          <div
            role="treeitem"
            aria-level={entry.depth + 1}
            aria-expanded={entry.dir ? root?.expanded.includes(entry.rel) : undefined}
            aria-selected={focused === entry.rel}
            id={`file-${entry.rel}`}
            key={entry.rel}
            style={{ paddingLeft: 10 + entry.depth * 14 }}
            className={cn(
              "flex h-7 cursor-default items-center gap-1.5 pr-3 text-[12px] hover:bg-hover",
              focused === entry.rel ? "bg-hover text-fg" : "text-dim",
              entry.ignored && "opacity-45",
            )}
            onClick={() => {
              setFocused(entry.rel);
              tree.current?.focus();
              if (entry.dir) useCode.getState().toggleDir(entry.rel);
              else void useCode.getState().openFile(entry.rel, { preview: true });
            }}
            onDoubleClick={() => {
              if (!entry.dir) useCode.getState().pin(entry.rel);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setFocused(entry.rel);
              setMenu({
                x: Math.min(e.clientX, window.innerWidth - 200),
                y: Math.min(e.clientY, window.innerHeight - 230),
                rel: entry.rel,
              });
            }}
          >
            {entry.dir ? (
              root?.expanded.includes(entry.rel) ? (
                <ChevronDown className="size-3 shrink-0 text-mute" />
              ) : (
                <ChevronRight className="size-3 shrink-0 text-mute" />
              )
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {entry.dir ? <Folder className="size-3.5 shrink-0 text-mute" /> : <File className="size-3.5 shrink-0 text-mute" />}
            {editing?.from === entry.rel ? (
              <form
                className="min-w-0 flex-1"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = editing.value.trim();
                  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) return;
                  void useCode.getState().renameEntry(editing.from!, [editing.parent, name].filter(Boolean).join("/"));
                  setEditing(null);
                }}
              >
                <input
                  autoFocus
                  aria-label="Rename entry"
                  value={editing.value}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="h-6 w-full rounded-[3px] border-[1.5px] border-line-strong bg-bg px-1 text-[12px] outline-none"
                />
              </form>
            ) : (
              <span className="truncate">{entry.name}</span>
            )}
            {root && buffers[bufferKey(root.path, entry.rel)]?.dirty ? (
              <span aria-label="Unsaved" className="ml-auto size-1.5 shrink-0 rounded-full bg-fg" />
            ) : (
              root?.tabs.some((t) => t.rel === entry.rel) && (
                <span aria-label="Open" className="ml-auto size-1.5 shrink-0 rounded-full border border-mute" />
              )
            )}
          </div>
        ))}
        {root && !dirs[bufferKey(root.path, "")] && <p className="px-3 py-2 text-[12px] text-mute">Loading folder…</p>}
      </div>
      {menu && (
        <div
          role="menu"
          aria-label="File actions"
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-40 w-48 rounded-[4px] border-[1.5px] border-line-strong bg-raised p-1 shadow-hard"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setMenu(null);
              tree.current?.focus();
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              items[(index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
            }
          }}
        >
          {actions.map(([id, label], i) => (
            <button
              autoFocus={i === 0}
              role="menuitem"
              key={id}
              disabled={!menu.rel && (id === "rename" || id === "delete")}
              className="block w-full rounded-[3px] px-2 py-1.5 text-left text-[12px] text-dim outline-none hover:bg-hover focus:bg-hover disabled:opacity-40"
              onClick={() => act(id, menu.rel)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
