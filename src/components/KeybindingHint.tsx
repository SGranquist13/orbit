import { useKeybinding } from "../lib/useKeybinding";
import { Kbd } from "./ui";
export function KeybindingHint({ command }: { command: string }) {
  const key = useKeybinding(command);
  return key ? <Kbd>{key}</Kbd> : null;
}
