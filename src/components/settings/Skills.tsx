import { ArrowDown, ArrowUp, Lock, Package, PinOff } from "lucide-react";
import { api } from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { Button } from "../ui";
import { Row, SubHeading } from "./controls";

export function Skills() {
  const packs = useApp((s) => s.packs);
  const skills = useApp((s) => s.skills);
  const profiles = useApp((s) => s.profiles);
  const pins = useApp((s) => s.pins);

  const setPins = (next: string[]) => {
    useApp.setState({ pins: next });
    api.setPins(next).catch((e) => useApp.getState().setError(String(e)));
  };
  const move = (i: number, d: number) => {
    const next = [...pins];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setPins(next);
  };
  const unpinned = skills.filter((s) => !pins.includes(s.id));
  const enabled = packs.filter((p) => p.enabled).length;

  return (
    <>
      <Row
        label="Skill packs"
        description={`${packs.length} installed, ${enabled} enabled. ${skills.length} skills and ${profiles.length} profiles available.`}
      >
        <Button variant="outline" onClick={() => useApp.getState().setPacksOpen(true)}>
          <Package className="size-3.5" /> Manage packs…
        </Button>
      </Row>
      {packs.map((p) => (
        <div key={p.name} className="flex items-center gap-3 border-b border-line py-2 text-[12px]">
          <span className={p.enabled ? "size-2 bg-ok" : "size-2 bg-mute/50"} />
          <span className="font-medium">{p.name}</span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-mute">{p.description}</span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-mute">{p.skillCount + p.commandCount} skills</span>
        </div>
      ))}

      <SubHeading>Pinned skills</SubHeading>
      <p className="pb-2 text-[11.5px] text-mute">Shown as one-click chips above the composer, in this order.</p>
      <div className="border-t border-line">
        {pins.length === 0 && <p className="py-2.5 text-[12px] text-mute">Nothing pinned.</p>}
        {pins.map((id, i) => (
          <div key={id} className="flex items-center gap-2 border-b border-line py-1.5 text-[12px]">
            <span className="min-w-0 flex-1 truncate font-medium">/{id}</span>
            <button aria-label={`Move ${id} up`} disabled={i === 0} onClick={() => move(i, -1)} className="grid size-6 place-items-center rounded-[3px] text-mute hover:bg-hover hover:text-fg disabled:opacity-30">
              <ArrowUp className="size-3.5" />
            </button>
            <button aria-label={`Move ${id} down`} disabled={i === pins.length - 1} onClick={() => move(i, 1)} className="grid size-6 place-items-center rounded-[3px] text-mute hover:bg-hover hover:text-fg disabled:opacity-30">
              <ArrowDown className="size-3.5" />
            </button>
            <button aria-label={`Unpin ${id}`} onClick={() => setPins(pins.filter((p) => p !== id))} className="grid size-6 place-items-center rounded-[3px] text-mute hover:bg-hover hover:text-fg">
              <PinOff className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      {unpinned.length > 0 && (
        <div className="pt-2.5">
          <select
            aria-label="Pin a skill"
            value=""
            onChange={(e) => e.target.value && setPins([...pins, e.target.value])}
            className="h-7 rounded-[4px] border-[1.5px] border-line-strong bg-raised px-2 text-[12px] font-medium text-fg focus:outline-none"
          >
            <option value="">Pin a skill…</option>
            {unpinned.map((s) => (
              <option key={s.id} value={s.id}>
                /{s.id}
              </option>
            ))}
          </select>
        </div>
      )}

      <SubHeading>Profiles</SubHeading>
      <p className="pb-2 text-[11.5px] text-mute">Roles come from skill packs. Read-only roles are enforced by the agent sandbox, not just by prompt.</p>
      <div className="border-t border-line">
        {profiles.map((p) => (
          <div key={p.id} className="flex items-start gap-3 border-b border-line py-2 text-[12px]">
            <span className="flex w-28 shrink-0 items-center gap-1.5 font-medium">
              {p.name}
              {p.readonly && <Lock className="size-3 text-mute" aria-label="Read-only" />}
            </span>
            <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-mute">{p.description}</span>
          </div>
        ))}
      </div>
    </>
  );
}
