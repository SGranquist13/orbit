// The smaller Settings sections: GitHub, Inbox, Keyboard shortcuts, About.
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen } from "lucide-react";
import pkg from "../../../package.json";
import { Button, Kbd } from "../ui";
import { Dot, Row, SubHeading, Toggle, save, useSettings } from "./controls";
import { useEnvironment } from "./env";

export function GitHub() {
  const s = useSettings();
  const { info } = useEnvironment();
  if (!s) return null;
  const gh = info?.gh;
  const tone = !gh ? "warn" : gh.user ? "ok" : gh.version ? "warn" : "bad";
  const status = !gh
    ? "Checking…"
    : gh.user
      ? `Signed in as ${gh.user}`
      : gh.version
        ? "Not signed in. Run gh auth login in a terminal."
        : "GitHub CLI (gh) not found on PATH";
  return (
    <>
      <Row label="GitHub CLI" description="Orbit uses gh for pull requests, checks and issues, with your own sign-in.">
        <span className="flex items-center gap-2 text-[12px] font-medium text-dim">
          <Dot tone={tone} /> {status}
        </span>
      </Row>
      {gh && gh.scopes.length > 0 && (
        <Row label="Token scopes" description="Merging and issue creation need repo.">
          <span className="selectable max-w-[320px] text-right text-[11.5px] text-mute">{gh.scopes.join(", ")}</span>
        </Row>
      )}
    </>
  );
}

export function InboxSettings() {
  const s = useSettings();
  if (!s) return null;
  return (
    <>
      <Row label="AI suggestions" field="aiSuggestions" description="Ask a small model for next-prompt ideas on each inbox item. Costs a fraction of a cent per item.">
        <Toggle label="AI suggestions" checked={s.aiSuggestions} onChange={(v) => void save({ aiSuggestions: v })} />
      </Row>
      <Row label="Suggestion model" description="Which model writes them (Claude, or a local one) is set in Settings > Models." />
    </>
  );
}

const SHORTCUTS: { group: string; items: [string[], string][] }[] = [
  {
    group: "Anywhere",
    items: [
      [["Ctrl", "K"], "Command palette"],
      [["Ctrl", "N"], "New workspace"],
      [["Ctrl", "I"], "Inbox"],
      [["Ctrl", "Shift", "G"], "Issues"],
      [["Ctrl", "Shift", "E"], "Routines"],
      [["Ctrl", "Shift", "T"], "Teammates"],
      [["Ctrl", ","], "Settings"],
      [["Ctrl", "1-9"], "Jump to the nth workspace"],
      [["Ctrl", "B"], "Toggle sidebar"],
      [["Ctrl", "\\"], "Toggle focus mode"],
      [["Ctrl", "."], "Toggle Ship panel"],
      [["Ctrl", "Shift", "L"], "Switch dark / light theme"],
      [["Esc"], "Close a dialog, or leave Settings"],
    ],
  },
  {
    group: "Code",
    items: [
      [["Ctrl", "Shift", "O"], "Open Code"],
      [["Ctrl", "P"], "Quick open file"],
      [["Ctrl", "`"], "Toggle terminal"],
      [["Ctrl", "Shift", "F"], "Search in files"],
      [["Ctrl", "Shift", "C"], "Copy terminal selection"],
      [["Ctrl", "Shift", "V"], "Paste into terminal"],
      [["Ctrl", "S"], "Save file"],
      [["Ctrl", "Shift", "S"], "Save all files"],
      [["Ctrl", "W"], "Close file tab"],
    ],
  },
  {
    group: "Chat",
    items: [
      [["Enter"], "Send message"],
      [["Shift", "Enter"], "New line"],
      [["Esc"], "Stop the running turn"],
      [["/"], "Open the skill menu"],
      [["Up"], "Previous skill in the menu"],
      [["Down"], "Next skill in the menu"],
      [["Tab"], "Accept the highlighted skill"],
    ],
  },
  {
    group: "Inbox",
    items: [
      [["J"], "Next item (or Down)"],
      [["K"], "Previous item (or Up)"],
      [["1-6"], "Send the numbered suggestion"],
      [["Enter"], "Open the workspace"],
      [["E"], "Dismiss"],
      [["S"], "Snooze for an hour"],
    ],
  },
  {
    group: "Issues",
    items: [
      [["J"], "Next issue (or Down)"],
      [["K"], "Previous issue (or Up)"],
      [["/"], "Search"],
      [["Enter"], "Start a workspace on the issue"],
      [["P"], "Plan the issue with the Planner"],
    ],
  },
  {
    group: "Dialogs",
    items: [
      [["Ctrl", "Enter"], "Submit (New workspace, New ticket)"],
      [["Esc"], "Close"],
    ],
  },
];

export function Shortcuts() {
  return (
    <>
      {SHORTCUTS.map((g) => (
        <div key={g.group}>
          <SubHeading>{g.group}</SubHeading>
          <div className="border-t border-line">
            {g.items.map(([keys, what]) => (
              <div key={what + keys.join("")} className="flex items-center justify-between border-b border-line py-2 text-[12px]">
                <span className="text-dim">{what}</span>
                <span className="flex items-center gap-1">
                  {keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

export function About() {
  const { info } = useEnvironment();
  const open = (path: string) => void revealItemInDir(path).catch(() => {});
  return (
    <>
      <Row label="Orbit" description="A desktop IDE for running a fleet of coding agents in parallel git worktrees.">
        <span className="text-[12px] font-medium tabular-nums text-dim">v{pkg.version}</span>
      </Row>
      <Row label="Data folder" description={<span className="selectable">{info?.orbitHome ?? "Locating…"}</span>}>
        <Button variant="outline" disabled={!info} onClick={() => info && open(info.orbitHome)}>
          <FolderOpen className="size-3.5" /> Open
        </Button>
      </Row>
      <Row label="Worktrees folder" description="Every workspace lives in its own worktree here.">
        <Button variant="outline" disabled={!info} onClick={() => info && open(`${info.orbitHome}/worktrees`)}>
          <FolderOpen className="size-3.5" /> Open
        </Button>
      </Row>
    </>
  );
}

export { Git } from "./Git";
