import { Plus, X, ChevronDown } from "lucide-react";
import { useCode } from "../../stores/code";
import { TerminalView } from "./TerminalView";
import { SearchPanel } from "./SearchPanel";
import { cn } from "../ui";

export function BottomPanel() {
  const open = useCode((s) => s.bottomOpen),
    height = useCode((s) => s.bottomHeight),
    active = useCode((s) => s.activeBottomTab),
    terminals = useCode((s) => s.terminals);
  const setHeight = (height: number) =>
    useCode.setState({ bottomHeight: Math.max(120, Math.min(window.innerHeight * 0.75, height)) });
  return (
    <section
      aria-label="Bottom panel"
      inert={!open}
      style={{ height: open ? height : 0 }}
      className={cn("flex shrink-0 flex-col overflow-hidden bg-panel", open && "border-t-[1.5px] border-line")}
    >
      <div
        role="separator"
        aria-label="Bottom panel height"
        aria-orientation="horizontal"
        aria-valuenow={height}
        aria-valuemin={120}
        aria-valuemax={Math.round(window.innerHeight * 0.75)}
        tabIndex={open ? 0 : -1}
        className="h-[4px] shrink-0 cursor-row-resize hover:bg-line-strong focus:bg-line-strong"
        onKeyDown={(e) => {
          if (["ArrowUp", "ArrowDown"].includes(e.key)) {
            e.preventDefault();
            setHeight(height + (e.key === "ArrowUp" ? 16 : -16));
          }
        }}
        onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) setHeight(useCode.getState().bottomHeight - e.movementY);
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      />
      <div className="flex h-8 shrink-0 items-center border-b-[1.5px] border-line text-[12px]">
        <div role="tablist" aria-label="Bottom panels" className="flex min-w-0 flex-1 overflow-x-auto">
          {terminals.map((t) => (
            <div key={t.id} className="flex shrink-0 items-center">
              <button
                role="tab"
                aria-selected={active === t.id}
                title={t.root}
                className={cn("px-3 py-1", active === t.id ? "text-fg" : "text-mute hover:text-fg")}
                onClick={() => useCode.setState({ activeBottomTab: t.id })}
              >
                {t.title}
                {t.exited ? " (exited)" : ""}
              </button>
              <button
                aria-label={`Close ${t.title}`}
                className="p-1 text-mute hover:text-fg"
                onClick={() => useCode.getState().closeTerminal(t.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <button
            role="tab"
            aria-selected={active === "search"}
            className={cn("px-3 py-1", active === "search" ? "text-fg" : "text-mute hover:text-fg")}
            onClick={() => useCode.getState().openSearch()}
          >
            Search
          </button>
        </div>
        <button
          aria-label="New terminal"
          className="p-2 text-mute hover:text-fg"
          onClick={() => useCode.getState().newTerminal()}
        >
          <Plus className="size-3.5" />
        </button>
        <button
          aria-label="Hide bottom panel"
          className="p-2 text-mute hover:text-fg"
          onClick={() => useCode.setState({ bottomOpen: false })}
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {terminals.map((t) => (
          <TerminalView key={t.id} terminal={t} active={open && active === t.id} />
        ))}
        <div className={open && active === "search" ? "h-full" : "hidden"}>
          <SearchPanel />
        </div>
      </div>
    </section>
  );
}
