// The smaller Settings sections: GitHub, Inbox, Keyboard shortcuts, About.
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen } from "lucide-react";
import pkg from "../../../package.json";
import { Button } from "../ui";
import { Dot, Row, Toggle, save, useSettings } from "./controls";
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

export { Shortcuts } from "./Shortcuts";

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
