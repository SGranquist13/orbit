import { Hexagon, Moon, Sun } from "lucide-react";
import { cn } from "../lib/cn";
import type { AgentKind, WorkspaceStatus } from "../lib/ipc";
import orbitArt from "../assets/orbit.png";
import { resolvedTheme, useTheme } from "../lib/theme";

export { cn };

const statusColor: Record<WorkspaceStatus, string> = {
  idle: "bg-mute/50",
  running: "bg-run animate-pulse-dot",
  done: "bg-ok",
  error: "bg-bad",
};

/** Square "pixel" status marker. */
export function StatusDot({ status, unread }: { status: WorkspaceStatus; unread?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      <span className={cn("size-2", statusColor[status])} />
      {unread && <span className="absolute -right-1 -top-1 size-1.5 bg-info ring-2 ring-panel" />}
    </span>
  );
}

export function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-3.5 text-accent", className)} fill="currentColor" aria-hidden>
      <path d="M12 2.5l1.6 6.2 5.6-3.2-3.2 5.6 6.2 1.6-6.2 1.6 3.2 5.6-5.6-3.2L12 22.9l-1.6-6.2-5.6 3.2 3.2-5.6-6.2-1.6 6.2-1.6-3.2-5.6 5.6 3.2z" />
    </svg>
  );
}

export function AgentIcon({ agent, className }: { agent: AgentKind; className?: string }) {
  return agent === "claude" ? (
    <ClaudeMark className={className} />
  ) : (
    <Hexagon className={cn("size-3.5 text-fg", className)} strokeWidth={2.25} />
  );
}

export const agentLabel: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[3px] border border-line-strong/70 bg-raised px-1 font-sans text-[10px] font-medium leading-4 text-mute">
      {children}
    </kbd>
  );
}

export function DiffStat({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  if (!additions && !deletions) return null;
  return (
    <span className={cn(" text-[11px] font-medium tabular-nums", className)}>
      {additions > 0 && <span className="text-ok">+{additions}</span>}
      {deletions > 0 && <span className="ml-1 text-bad">−{deletions}</span>}
    </span>
  );
}

export function Button({
  variant = "ghost",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "outline" }) {
  return (
    <button
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-[12px] font-medium transition-[background-color,color,box-shadow,transform] duration-100 disabled:pointer-events-none disabled:opacity-40",
        // Primary buttons sit on a hard shadow and press down into it; disabled ones go flat.
        variant === "primary" &&
          "bg-accent text-accent-fg shadow-hard-sm hover:brightness-110 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:bg-hover disabled:text-mute disabled:opacity-100 disabled:shadow-none",
        variant === "ghost" && "text-dim hover:bg-hover hover:text-fg",
        variant === "outline" && "border-[1.5px] border-line-strong text-fg hover:bg-fg hover:text-bg",
        className,
      )}
      {...props}
    />
  );
}

/** Dark/light toggle. */
export function ThemeToggle() {
  const toggle = useTheme((s) => s.toggle);
  useTheme((s) => s.mode); // re-render on mode change
  const dark = resolvedTheme() === "dark";
  return (
    <button
      onClick={toggle}
      title={`Switch to ${dark ? "light" : "dark"} mode (Ctrl Shift L)`}
      className="grid size-7 place-items-center rounded-[4px] text-dim hover:bg-hover hover:text-fg"
    >
      {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </button>
  );
}

/**
 * Orbit's mark: the user's dithered black hole. `zoom` crops into the centre so small
 * renders keep the horizon and disk readable instead of the empty margins.
 */
export function OrbitMark({ size, zoom = 1, className }: { size: number; zoom?: number; className?: string }) {
  return (
    <span className={cn("relative inline-block shrink-0 overflow-hidden", className)} style={{ width: size, height: size }}>
      <img
        src={orbitArt}
        alt=""
        draggable={false}
        className="orbit-art absolute left-1/2 top-1/2 max-w-none -translate-x-1/2 -translate-y-1/2"
        style={{ width: size * zoom, height: size * zoom }}
      />
    </span>
  );
}
