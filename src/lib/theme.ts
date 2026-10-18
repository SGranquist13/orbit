import { create } from "zustand";
import { isTauri } from "./env";

export type ThemeMode = "system" | "dark" | "light";

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice just won't persist.
  }
};

const media = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(mode: ThemeMode): "dark" | "light" {
  return mode === "system" ? (media.matches ? "dark" : "light") : mode;
}

function apply(mode: ThemeMode) {
  const resolved = resolve(mode);
  document.documentElement.dataset.theme = resolved;
  // Match the native title bar (no-op outside Tauri).
  if (isTauri()) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(resolved))
      .catch(() => {});
  }
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Flips between dark and light (leaving "system"). */
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  // Dark by default; light stays available via the toggle.
  mode: (read("theme") as ThemeMode) ?? "dark",
  setMode: (mode) => {
    write("theme", mode);
    set({ mode });
    apply(mode);
  },
  toggle: () => get().setMode(resolve(get().mode) === "dark" ? "light" : "dark"),
}));

export function installTheme() {
  apply(useTheme.getState().mode);
  media.addEventListener("change", () => {
    const { mode } = useTheme.getState();
    if (mode === "system") apply(mode);
  });
}

export const resolvedTheme = () => resolve(useTheme.getState().mode);
