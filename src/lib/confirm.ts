// Native "Orbit" confirmation dialog in the app; browser confirm() in mock mode.
// `window.isTauri` is set by the real Tauri runtime only (the mock backend doesn't set it).
export async function confirmAction(message: string, okLabel = "OK"): Promise<boolean> {
  // E2E hook: native dialogs can't be clicked over CDP (and Tauri's invoke can't be patched),
  // so scripts/e2e-harness.mjs sets this page global to answer confirmations.
  const auto = (window as { __ORBIT_AUTOCONFIRM__?: boolean }).__ORBIT_AUTOCONFIRM__;
  if (auto !== undefined) return auto;
  if (!("isTauri" in window)) return window.confirm(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title: "Orbit", kind: "warning", okLabel, cancelLabel: "Cancel" });
}
