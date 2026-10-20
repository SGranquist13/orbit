import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { commands, bindings, conflicts, displayBinding, normalizeEvent, type Command } from "../../lib/keybindings";
import { setRecordingKeys } from "../../lib/keybindingRuntime";
import { confirmAction } from "../../lib/confirm";
import { Button, Kbd } from "../ui";
import { SubHeading, save, useSettings } from "./controls";

const groups = ["General", "Views", "Code", "Editor", "Terminal", "Agent"];
const chatKeys = [
  ["Enter", "Send message"],
  ["Shift Enter", "New line"],
  ["Esc", "Stop the running turn"],
  ["/", "Open skill menu"],
  ["↑ / ↓", "Navigate menus"],
  ["Tab", "Accept highlighted skill"],
];

function Chips({ binding }: { binding: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      {binding.split(" ").map((part, i) => (
        <span key={i} className="inline-flex gap-0.5">
          {displayBinding(part)
            .split(" ")
            .map((key, j) => (
              <Kbd key={j}>{key}</Kbd>
            ))}
        </span>
      ))}
    </span>
  );
}

export function Shortcuts() {
  const settings = useSettings();
  const [search, setSearch] = useState("");
  const [record, setRecord] = useState<{ command: Command; add: boolean } | null>(null);
  const [value, setValue] = useState("");
  const started = useRef(0),
    recorded = useRef("");
  const overrides = settings?.keybindings ?? {};
  const change = (command: Command, add = false) => {
    recorded.current = "";
    started.current = 0;
    setValue("");
    setRecordingKeys(true);
    setRecord({ command, add });
  };
  const closeRecorder = () => {
    setRecordingKeys(false);
    setRecord(null);
  };
  useEffect(() => {
    if (!record) return;
    const capture = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.key === "Escape") {
        closeRecorder();
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && recorded.current) {
        const key = recorded.current;
        const next = record.add ? [...new Set([...bindings(record.command.id, overrides), key])] : [key];
        void save({ keybindings: { ...overrides, [record.command.id]: next } });
        closeRecorder();
        return;
      }
      const key = normalizeEvent(e);
      if (!key) return;
      if (recorded.current && !recorded.current.includes(" ") && Date.now() - started.current < 1000) {
        recorded.current += " " + key;
      } else {
        recorded.current = key;
        started.current = Date.now();
      }
      setValue(recorded.current);
    };
    window.addEventListener("keydown", capture, true);
    return () => {
      window.removeEventListener("keydown", capture, true);
      setRecordingKeys(false);
    };
  }, [record, overrides]);
  const reset = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    void save({ keybindings: next });
  };
  const resetAll = () => {
    void confirmAction("Reset all keyboard shortcuts to defaults?", "Reset all").then((ok) => {
      if (ok) return save({ keybindings: {} });
    });
  };
  const matches = commands.filter((c) => {
    const keys = bindings(c.id, overrides);
    return `${c.title} ${c.id} ${keys.join(" ")} ${keys.map(displayBinding).join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase());
  });
  const others = record && value ? conflicts(record.command.id, value, overrides) : [];

  return (
    <>
      <div className="flex items-center gap-3 py-3">
        <input
          aria-label="Search keyboard shortcuts"
          placeholder="Search commands or keybindings"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1 rounded-[4px] border border-line bg-raised px-3 py-2 text-[12px] focus:outline-accent"
        />
        <Button onClick={resetAll}>Reset all</Button>
      </div>
      <p className="text-[12px] text-mute">
        Double-click a command to change its keybinding. A second key within one second records a chord.
      </p>
      {groups.map((group) => {
        const rows = matches.filter((c) => c.group === group);
        if (!rows.length) return null;
        return (
          <div key={group} className="overflow-x-auto">
            <SubHeading>{group}</SubHeading>
            <table className="w-full min-w-[580px] table-fixed text-left text-[12px]">
              <thead className="border-y border-line text-[11px] text-mute">
                <tr>
                  <th scope="col" className="w-[35%] py-2 font-medium">
                    Command
                  </th>
                  <th scope="col" className="w-[29%] font-medium">
                    Keybinding
                  </th>
                  <th scope="col" className="w-[12%] font-medium">
                    When
                  </th>
                  <th scope="col" className="font-medium">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    data-command={c.id}
                    onDoubleClick={() => change(c)}
                    className="border-b border-line hover:bg-hover"
                  >
                    <td className="py-2.5 pr-2 text-dim" title={c.id}>
                      {c.title}
                    </td>
                    <td className="py-2">
                      <span className="flex flex-wrap gap-2">
                        {bindings(c.id, overrides).map((key) => (
                          <Chips key={key} binding={key} />
                        ))}
                      </span>
                    </td>
                    <td className="text-mute">{c.when}</td>
                    <td>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-mute">
                        <span>{Object.hasOwn(overrides, c.id) ? "User" : "Default"}</span>
                        <button
                          aria-label={`Change ${c.title}`}
                          title="Change"
                          onClick={() => change(c)}
                          className="p-1 hover:text-fg"
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button onClick={() => change(c, true)} className="hover:text-fg">
                          Add another
                        </button>
                        <button
                          onClick={() => void save({ keybindings: { ...overrides, [c.id]: [] } })}
                          className="hover:text-fg"
                        >
                          Remove
                        </button>
                        {Object.hasOwn(overrides, c.id) && (
                          <button onClick={() => reset(c.id)} className="hover:text-fg">
                            Reset to default
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {!matches.length && <p className="py-6 text-[12px] text-mute">No matching commands.</p>}
      <SubHeading>Chat</SubHeading>
      <table className="w-full text-[12px]">
        <tbody>
          {chatKeys
            .filter(([key, title]) => `${key} ${title}`.toLowerCase().includes(search.toLowerCase()))
            .map(([key, title]) => (
              <tr key={title} className="border-b border-line">
                <td className="py-2 text-dim">{title}</td>
                <td>
                  <Kbd>{key}</Kbd>
                </td>
                <td className="text-mute">chat</td>
                <td className="text-mute">Fixed</td>
              </tr>
            ))}
        </tbody>
      </table>
      {record && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-overlay" onMouseDown={closeRecorder}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Record keybinding"
            onMouseDown={(e) => e.stopPropagation()}
            className="w-[480px] max-w-[90vw] rounded-[6px] border-[1.5px] border-line-strong bg-raised p-5 shadow-pop"
          >
            <h3 className="text-[15px] font-semibold">Press desired key combination and then press Enter</h3>
            <p className="mt-2 text-[12px] text-mute">{record.command.title} · Escape to cancel</p>
            <div aria-live="polite" className="my-5 min-h-6">
              {value && <Chips binding={value} />}
            </div>
            <p className="text-[12px] text-mute">
              {others.length} other commands have this keybinding
              {others.length ? `: ${others.map((c) => c.title).join(", ")}` : "."}
            </p>
            <Button className="mt-4" onClick={closeRecorder}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
