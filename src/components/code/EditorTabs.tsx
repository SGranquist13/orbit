import { X } from "lucide-react";
import { bufferKey, useCode } from "../../stores/code";
import { cn } from "../ui";

export function EditorTabs() {
  const root = useCode((s) => s.roots.find((r) => r.path === s.activeRoot)), buffers = useCode((s) => s.buffers);
  return <div role="tablist" aria-label="Open files" className="flex h-9 shrink-0 overflow-x-auto border-b-[1.5px] border-line bg-panel">
    {root?.tabs.map((t) => <div key={t.rel} className={cn("group flex shrink-0 items-center gap-2 border-r-[1.5px] border-line px-3 text-[12px]", root.activeRel === t.rel ? "bg-bg text-fg" : "text-dim hover:bg-hover")} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void useCode.getState().closeTab(t.rel); } }}>
      <button role="tab" aria-selected={root.activeRel === t.rel} title={t.rel} className={cn("h-full", t.preview && "italic")} onClick={() => useCode.getState().setActive(t.rel)} onDoubleClick={() => useCode.getState().pin(t.rel)}>{t.rel.split("/").pop()}</button>
      {buffers[bufferKey(root.path, t.rel)]?.dirty && <span aria-label="Unsaved" className="size-1.5 rounded-full bg-fg" />}
      <button aria-label={`Close ${t.rel}`} className="rounded-[3px] p-0.5 text-mute opacity-0 hover:bg-hover hover:text-fg focus:opacity-100 group-hover:opacity-100" onClick={() => void useCode.getState().closeTab(t.rel)}><X className="size-3" /></button>
    </div>)}
  </div>;
}
