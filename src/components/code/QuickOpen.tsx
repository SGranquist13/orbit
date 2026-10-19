import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { fuzzyScore } from "../../lib/code/helpers";
import { useCode } from "../../stores/code";

export function QuickOpen() {
  const path = useCode((s) => s.activeRoot),
    files = useCode((s) => (path ? s.files[path] : undefined));
  const [query, setQuery] = useState("");
  const close = () => useCode.getState().setQuickOpen(false);
  useEffect(() => {
    if (path && !useCode.getState().files[path]) void useCode.getState().loadFiles(path);
  }, [path]);
  const matches = (files ?? [])
    .map((rel) => ({ rel, score: fuzzyScore(rel, query) }))
    .filter((f) => f.score >= 0)
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    .slice(0, 150);
  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-overlay pt-[14vh]" onMouseDown={close}>
      <Command
        loop
        shouldFilter={false}
        label="Quick open file"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
        }}
        className="w-[min(560px,90vw)] rounded-[6px] border-[1.5px] border-line-strong bg-raised shadow-pop"
      >
        <Command.Input
          autoFocus
          placeholder="Find a file…"
          value={query}
          onValueChange={setQuery}
          className="h-12 w-full border-b-[1.5px] border-line bg-transparent px-4 text-[14px] outline-none placeholder:text-mute"
        />
        <Command.List className="max-h-[380px] overflow-y-auto p-1.5">
          <Command.Empty className="p-6 text-center text-[12px] text-mute">
            {path ? "No matching files." : "Open a folder first."}
          </Command.Empty>
          {matches.map(({ rel }) => (
            <Command.Item
              key={rel}
              value={rel}
              className="cursor-default rounded-[3px] px-3 py-2 text-[12px] text-dim data-[selected=true]:bg-hover data-[selected=true]:text-fg"
              onSelect={() => {
                close();
                void useCode.getState().openFile(rel, { preview: false });
              }}
            >
              {rel}
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}
