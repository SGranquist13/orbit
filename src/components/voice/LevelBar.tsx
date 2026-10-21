import { cn } from "../ui";

/** Microphone level as a dithered bar (colour is `run`: it only shows while listening). */
export function LevelBar({ level, className }: { level: number; className?: string }) {
  // The raw RMS of speech sits low; stretch it so normal talking fills most of the bar.
  const fill = Math.min(1, Math.sqrt(Math.max(0, level)) * 1.2);
  return (
    <span role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(fill.toFixed(2))} className={cn("relative block h-2 w-16 overflow-hidden rounded-[2px] bg-line", className)}>
      <span className="dither-50 absolute inset-y-0 left-0 bg-run transition-[width] duration-75" style={{ width: `${fill * 100}%` }} />
    </span>
  );
}
