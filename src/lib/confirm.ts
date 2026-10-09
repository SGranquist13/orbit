// Native "Orbit" confirmation dialog in the app; browser confirm() in mock mode.
// `window.isTauri` is set by the real Tauri runtime only (the mock backend doesn't set it).
export async function confirmAction(message: string, okLabel = "OK"): Promise<boolean> {
  if (!("isTauri" in window)) return window.confirm(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title: "Orbit", kind: "warning", okLabel, cancelLabel: "Cancel" });
}
