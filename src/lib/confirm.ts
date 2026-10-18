import { ask } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./env";

// Native "Orbit" confirmation dialog in the app; browser confirm() in mock mode.
export async function confirmAction(message: string, okLabel = "OK"): Promise<boolean> {
  // E2E hook: native dialogs can't be clicked over CDP (and Tauri's invoke can't be patched),
  // so scripts/e2e-harness.mjs sets this page global to answer confirmations. The e2e runs against
  // the Vite dev server (DEV is true there); release builds never honour it.
  if (import.meta.env.DEV) {
    const auto = (window as { __ORBIT_AUTOCONFIRM__?: boolean }).__ORBIT_AUTOCONFIRM__;
    if (auto !== undefined) return auto;
  }
  if (!isTauri()) return window.confirm(message);
  return ask(message, { title: "Orbit", kind: "warning", okLabel, cancelLabel: "Cancel" });
}
