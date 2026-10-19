// Capture before mockIPC installs __TAURI_INTERNALS__ in a plain browser.
const nativeRuntime = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "isTauri" in window);

/** True inside the real Tauri runtime; false in a plain browser (mock backend). */
export function isTauri(): boolean {
  return nativeRuntime;
}
