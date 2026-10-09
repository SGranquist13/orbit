// Small form primitives for the Settings page. Every control saves immediately (no Save button);
// `Row` shows a brief "Saved" tick next to a row whose `field` was just persisted.
import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { Settings } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { cn } from "../ui";

interface SavedState {
  at: Record<string, number>;
}
const useSaved = create<SavedState>(() => ({ at: {} }));

function flash(keys: string[]) {
  const now = Date.now();
  useSaved.setState((s) => ({ at: { ...s.at, ...Object.fromEntries(keys.map((k) => [k, now])) } }));
  window.setTimeout(() => {
    useSaved.setState((s) => {
      const at = { ...s.at };
      for (const k of keys) if (at[k] === now) delete at[k];
      return { at };
    });
  }, 1500);
}

/** Persists a partial update and flashes "Saved" on the rows for the fields that changed. */
export async function save(patch: Partial<Settings>) {
  if (await useApp.getState().updateSettings(patch)) flash(Object.keys(patch));
}

export function useSettings(): Settings | null {
  return useApp((s) => s.settings);
}

export function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section id={`settings-${id}`} data-section={id} className="scroll-mt-4 pb-10">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      {description && <p className="mt-1 text-[12px] leading-relaxed text-mute">{description}</p>}
      <div className="mt-2 border-t-[1.5px] border-line">{children}</div>
    </section>
  );
}

export function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="label pb-1 pt-5 text-mute">{children}</h3>;
}

/** Label + description on the left, control on the right. `field` enables the "Saved" tick. */
export function Row({
  label,
  description,
  field,
  stacked,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  field?: keyof Settings;
  /** Control goes below the text (wide controls such as tag inputs and cards). */
  stacked?: boolean;
  children?: React.ReactNode;
}) {
  const saved = useSaved((s) => (field ? s.at[field] !== undefined : false));
  return (
    <div className={cn("border-b border-line py-3", stacked ? "space-y-2.5" : "flex items-start justify-between gap-6")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12.5px] font-medium">
          {label}
          {field && (
            <span
              role="status"
              aria-hidden={!saved}
              className={cn("flex items-center gap-0.5 text-[11px] font-medium text-ok transition-opacity duration-300", saved ? "opacity-100" : "opacity-0")}
            >
              <Check className="size-3" strokeWidth={3} /> Saved
            </span>
          )}
        </div>
        {description && <div className="mt-0.5 text-[11.5px] leading-relaxed text-mute">{description}</div>}
      </div>
      {children !== undefined && <div className={cn("flex shrink-0 items-center gap-2", stacked && "w-full")}>{children}</div>}
    </div>
  );
}

const field =
  "h-7 rounded-[4px] border-[1.5px] border-line-strong bg-raised px-2 text-[12px] font-medium text-fg transition-colors hover:border-mute focus:border-fg focus:outline-none";

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[20px] w-9 rounded-[4px] border-[1.5px] transition-colors disabled:pointer-events-none disabled:opacity-40",
        checked ? "border-accent bg-accent" : "border-line-strong bg-raised",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] size-3 rounded-[2px] transition-[left,background-color]",
          checked ? "left-[18px] bg-accent-fg" : "left-[2px] bg-mute",
        )}
      />
    </button>
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
}

export function Select<T extends string>({ value, options, onChange, label, className }: { value: T; options: Option<T>[]; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} className={cn(field, "min-w-[150px]", className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Option<T>[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-[4px] border-[1.5px] border-line-strong p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => value !== o.value && onChange(o.value)}
          className={cn(
            "h-6 rounded-[2px] px-2.5 text-[12px] font-medium transition-colors",
            value === o.value ? "bg-fg text-bg" : "text-mute hover:text-dim",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Saves on blur or Enter; Escape reverts. `onDraft` reports the text while typing (live previews). */
export function TextInput({
  value,
  onCommit,
  onDraft,
  placeholder,
  label,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  onDraft?: (v: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onFocus={() => (focused.current = true)}
      onChange={(e) => {
        setDraft(e.target.value);
        onDraft?.(e.target.value);
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
          onDraft?.(value);
          e.currentTarget.blur();
        }
      }}
      className={cn(field, "w-[220px] placeholder:text-mute", className)}
    />
  );
}

/** Chips plus an input: Enter or comma adds, Backspace on empty removes the last, x removes one. */
export function TagInput({ values, onChange, placeholder, label }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; label: string }) {
  const [text, setText] = useState("");
  const add = () => {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    setText("");
    const next = [...new Set([...values, ...parts])];
    if (next.length !== values.length) onChange(next);
  };
  return (
    <div className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-[4px] border-[1.5px] border-line-strong bg-raised px-1.5 py-1 focus-within:border-fg">
      {values.map((v) => (
        <span key={v} className="flex h-5 items-center gap-1 rounded-[3px] bg-hover pl-1.5 pr-0.5 text-[11.5px] font-medium">
          {v}
          <button aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="grid size-4 place-items-center rounded-[2px] text-mute hover:text-fg">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        value={text}
        placeholder={values.length ? "" : placeholder}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
          else if (e.key === "Escape") {
            e.stopPropagation();
            setText("");
            e.currentTarget.blur();
          }
        }}
        className="h-5 min-w-[120px] flex-1 bg-transparent px-1 text-[12px] font-medium placeholder:text-mute focus:outline-none"
      />
    </div>
  );
}

/** Radio cards: a choice with a one-line trade-off under each title. */
export function Cards<T extends string>({ value, options, onChange, label }: { value: T; options: (Option<T> & { hint: string })[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid w-full gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => value !== o.value && onChange(o.value)}
          className={cn(
            "rounded-[4px] border-[1.5px] p-2.5 text-left transition-colors",
            value === o.value ? "border-fg bg-raised" : "border-line-strong hover:border-mute",
          )}
        >
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            <span className={cn("grid size-3.5 place-items-center rounded-full border-[1.5px]", value === o.value ? "border-fg" : "border-mute")}>
              {value === o.value && <span className="size-1.5 rounded-full bg-fg" />}
            </span>
            {o.label}
          </div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-mute">{o.hint}</div>
        </button>
      ))}
    </div>
  );
}

/** Square status marker, matching the sidebar's pixel dots. */
export function Dot({ tone }: { tone: "ok" | "warn" | "bad" }) {
  return <span className={cn("size-2 shrink-0", tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-bad")} />;
}
