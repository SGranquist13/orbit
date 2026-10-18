/** True inside the real Tauri runtime; false in a plain browser (mock backend). */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window || "isTauri" in window;
}
