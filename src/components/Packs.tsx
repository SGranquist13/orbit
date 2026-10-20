import { openUrl } from "@tauri-apps/plugin-opener";
import { LoaderCircle, Package, Pin, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { confirmAction } from "../lib/confirm";
import { api, type Pack, type Workspace } from "../lib/ipc";
import { useApp } from "../stores/app";
import { Button, cn } from "./ui";

export function Packs() {
  const packs = useApp((s) => s.packs);
  const skills = useApp((s) => s.skills);
  const pins = useApp((s) => s.pins);
  const workspace = useApp((s) => s.workspaces.find((w) => w.id === s.selectedId));
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const close = () => useApp.getState().setPacksOpen(false);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await useApp.getState().loadSkills();
    } catch (e) {
      useApp.getState().setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const install = (u: string) =>
    act(`install:${u}`, async () => {
      await api.installPack(u);
      setUrl("");
    });

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const list = q
      ? skills.filter((s) => s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      : skills;
    // Pinned first so the chip set is easy to review.
    return [...list].sort((a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id)));
  }, [skills, query, pins]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-overlay" onMouseDown={close}>
      <div
        className="flex h-[min(720px,88vh)] w-[min(980px,92vw)] overflow-hidden rounded-[6px] border-[1.5px] border-line-strong bg-raised shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        {/* Packs */}
        <section className="flex w-[400px] shrink-0 flex-col border-r border-line">
          <header className="flex h-12 items-center gap-2 border-b border-line px-4">
            <Package className="size-4 text-accent" />
            <h2 className="text-[14px] font-semibold tracking-[-0.01em]">Skill packs</h2>
          </header>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {workspace && (
              <div className="px-1 pb-2 text-[11.5px] leading-relaxed text-mute">
                <p className="truncate text-fg" title={workspace.name}>{workspace.name}</p>
                <p>Turn packs off for this workspace only. Applies from your next message.</p>
              </div>
            )}
            {packs.map((p) => (
              <PackRow key={p.name} pack={p} workspace={workspace} busy={busy} act={act} />
            ))}

            <p className="label px-1 pt-3 text-mute">Install a pack from git</p>
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (url.trim()) void install(url.trim());
              }}
            >
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/skills-repo"
                className="h-7 min-w-0 flex-1 rounded-[4px] border-[1.5px] border-line-strong bg-bg px-2 text-[11.5px] placeholder:text-mute focus:border-accent"
              />
              <Button variant="outline" type="submit" disabled={!url.trim() || !!busy}>
                {busy === `install:${url.trim()}` && <LoaderCircle className="size-3.5 animate-spin" />}
                Add
              </Button>
            </form>
            <p className="px-1 text-[11px] leading-relaxed text-mute">
              Packs use the standard Claude plugin layout (<code className="font-mono">skills/*/SKILL.md</code>,{" "}
              <code className="font-mono">commands/*.md</code>). Only install packs you trust: their hooks can run commands
              in Claude sessions.
            </p>
          </div>
        </section>

        {/* Skills */}
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 items-center gap-2 border-b border-line px-4">
            <Search className="size-3.5 text-mute" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${skills.length} skills & commands…`}
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-mute"
            />
            <button onClick={close} className="text-mute hover:text-fg">
              <X className="size-4" />
            </button>
          </header>
          <ul className="min-h-0 flex-1 overflow-y-auto p-2">
            {filtered.slice(0, 300).map((s) => {
              const pinned = pins.includes(s.id);
              return (
                <li key={s.id} className="group flex items-start gap-3 rounded-[4px] px-2.5 py-2 hover:bg-hover">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className=" text-[12px] font-semibold text-fg">/{s.id}</span>
                      <span className=" text-[10px] uppercase text-mute/70">{s.kind}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-mute">{s.description}</p>
                  </div>
                  <button
                    onClick={() => void useApp.getState().togglePin(s.id)}
                    title={pinned ? "Unpin from composer" : "Pin to composer"}
                    className={cn(
                      "mt-0.5 grid size-6 shrink-0 place-items-center rounded-md transition-colors",
                      pinned ? "text-accent" : "text-mute opacity-0 hover:text-fg group-hover:opacity-100",
                    )}
                  >
                    <Pin className={cn("size-3.5", pinned && "fill-current")} />
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && <p className="p-6 text-center text-[12px] text-mute">No skills match.</p>}
          </ul>
        </section>
      </div>
    </div>
  );
}

function PackRow({ pack, workspace, busy, act }: { pack: Pack; workspace?: Workspace; busy: string | null; act: (key: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const key = (k: string) => `${k}:${pack.name}`;
  return (
    <div className={cn("rounded-[4px] border-[1.5px] border-line-strong bg-bg p-3", !pack.enabled && "opacity-60")}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">{pack.name}</span>
        {pack.builtin && <span className="label rounded-[2px] bg-accent px-1 text-[9.5px] text-accent-fg">built-in</span>}
        <span className="flex-1" />
        {!pack.builtin && (
          <>
            <IconBtn title="Update (git pull)" onClick={() => void act(key("update"), () => api.updatePack(pack.name))}>
              <RefreshCw className={cn("size-3.5", busy === key("update") && "animate-spin")} />
            </IconBtn>
            <IconBtn
              title="Remove pack"
              onClick={async () => {
                if (await confirmAction(`Remove the ${pack.name} pack? Its folder is deleted.`, "Remove")) {
                  void act(key("remove"), () => api.removePack(pack.name));
                }
              }}
            >
              <Trash2 className="size-3.5" />
            </IconBtn>
          </>
        )}
        <Toggle label={`Enable ${pack.name} globally`} disabled={!!busy} on={pack.enabled} onChange={(on) => void act(key("toggle"), () => api.setPackEnabled(pack.name, on))} />
      </div>
      {workspace && (
        <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[11.5px] text-mute">
          <span>This workspace</span>
          {pack.enabled ? (
            <Toggle
              label={`Enable ${pack.name} in this workspace`}
              title={workspace.status === "running" ? "Wait for the current turn to finish" : undefined}
              disabled={!!busy || workspace.status === "running"}
              on={!workspace.disabledPacks.includes(pack.name)}
              onChange={(on) => void act(key("workspace"), async () => {
                const disabled = workspace.disabledPacks.filter((name) => name !== pack.name);
                if (!on) disabled.push(pack.name);
                useApp.getState().upsertWorkspace(await api.setWorkspacePacks(workspace.id, disabled));
              })}
            />
          ) : <span>Off globally</span>}
        </div>
      )}
      {pack.description && <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-mute">{pack.description}</p>}
      <div className="mt-1.5 flex items-center gap-3 text-[10.5px] text-mute">
        <span>{pack.skillCount} skills</span>
        <span>{pack.commandCount} commands</span>
        <span>/{pack.plugin}:…</span>
        {pack.source && (
          <button className="truncate hover:text-dim" onClick={() => void openUrl(pack.source!.replace(/\.git$/, ""))}>
            source ↗
          </button>
        )}
      </div>
    </div>
  );
}

function IconBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="grid size-6 place-items-center rounded-md text-mute hover:bg-hover hover:text-fg" />;
}

function Toggle({ on, onChange, label, title, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; title?: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-label={label}
      title={title}
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn("relative h-4 w-7 shrink-0 rounded-[3px] transition-colors disabled:opacity-40", on ? "bg-accent" : "bg-line-strong")}
    >
      <span className={cn("absolute top-0.5 size-3 rounded-[2px] bg-paper transition-all", on ? "left-3.5" : "left-0.5")} />
    </button>
  );
}
