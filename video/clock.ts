import { create } from "zustand";
import type { Aspect } from "./lib";

/** The single clock: every visual is a pure function of `t`. */
export const useClock = create<{ t: number; aspect: Aspect }>(() => ({ t: 0, aspect: "16x9" }));
