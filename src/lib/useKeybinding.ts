import { useApp } from "../stores/app";
import { bindings, displayBinding } from "./keybindings";
export function useKeybinding(id: string): string {
  const overrides = useApp((s) => s.settings?.keybindings);
  return bindings(id, overrides).map(displayBinding).join(" / ");
}
export function keybindingLabel(id: string): string {
  return bindings(id, useApp.getState().settings?.keybindings).map(displayBinding).join(" / ");
}
export function useKeybindingLabels() {
  useApp((s) => s.settings?.keybindings);
  return keybindingLabel;
}
