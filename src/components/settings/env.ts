import { useEffect } from "react";
import { create } from "zustand";
import { api, type EnvironmentInfo } from "../../lib/ipc";

interface EnvState {
  info: EnvironmentInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Diagnostics of the local toolchain; shared by the Agents, GitHub and Data sections. */
export const useEnv = create<EnvState>((set, get) => ({
  info: null,
  loading: false,
  error: null,
  refresh: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      set({ info: await api.environmentInfo(), loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
}));

/** Loads diagnostics once on first use. */
export function useEnvironment() {
  const env = useEnv();
  useEffect(() => {
    if (!useEnv.getState().info) void useEnv.getState().refresh();
  }, []);
  return env;
}
