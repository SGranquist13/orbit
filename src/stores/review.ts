import { create } from "zustand";
import { confirmAction } from "../lib/confirm";
import { api } from "../lib/ipc";
import { useApp } from "./app";

export interface ReviewComment {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  side: "new";
  text: string;
  /** The commented source lines, verbatim. */
  excerpt: string;
}

const STORAGE = "orbit.reviewComments";

function load(): Record<string, ReviewComment[]> {
  try {
    const raw = localStorage.getItem(STORAGE);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function save(drafts: Record<string, ReviewComment[]>) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(drafts));
  } catch {
    /* storage unavailable: drafts stay in memory */
  }
}

interface ReviewState {
  drafts: Record<string, ReviewComment[]>;
  add: (ws: string, c: Omit<ReviewComment, "id">) => string;
  update: (ws: string, id: string, text: string) => void;
  remove: (ws: string, id: string) => void;
  clear: (ws: string) => void;
}

export const useReview = create<ReviewState>((set, get) => {
  const commit = (drafts: Record<string, ReviewComment[]>) => {
    save(drafts);
    set({ drafts });
  };
  return {
    drafts: load(),
    add: (ws, c) => {
      const id = `rc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      commit({ ...get().drafts, [ws]: [...(get().drafts[ws] ?? []), { ...c, id }] });
      return id;
    },
    update: (ws, id, text) =>
      commit({ ...get().drafts, [ws]: (get().drafts[ws] ?? []).map((c) => (c.id === id ? { ...c, text } : c)) }),
    remove: (ws, id) => {
      const list = (get().drafts[ws] ?? []).filter((c) => c.id !== id);
      const drafts = { ...get().drafts };
      if (list.length) drafts[ws] = list;
      else delete drafts[ws];
      commit(drafts);
    },
    clear: (ws) => {
      const drafts = { ...get().drafts };
      delete drafts[ws];
      commit(drafts);
    },
  };
});

const EMPTY: ReviewComment[] = [];
export const useReviewComments = (ws: string | undefined) => useReview((s) => (ws ? (s.drafts[ws] ?? EMPTY) : EMPTY));

/** One message for all drafts, in file and line order. */
export function reviewMessage(comments: ReviewComment[]): string {
  const fence = (text: string) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const items = comments.map((c, i) => {
    const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
    const f = fence(c.excerpt);
    return `${i + 1}. \`${c.path}:${range}\`\n${f}\n${c.excerpt.replace(/\n+$/, "")}\n${f}\n${c.text.trim()}`;
  });
  return `Review comments on your changes:\n\n${items.join("\n\n")}`;
}

export async function sendReview(ws: string): Promise<boolean> {
  const comments = useReview.getState().drafts[ws] ?? [];
  if (!comments.length) return false;
  try {
    await api.sendMessage(ws, reviewMessage(comments));
  } catch (e) {
    useApp.getState().setError(String(e));
    return false;
  }
  useReview.getState().clear(ws);
  return true;
}

export async function discardReview(ws: string): Promise<boolean> {
  const n = useReview.getState().drafts[ws]?.length ?? 0;
  if (!n) return false;
  if (!(await confirmAction(`Discard ${n} review comment${n === 1 ? "" : "s"}?`, "Discard"))) return false;
  useReview.getState().clear(ws);
  return true;
}

// Dev-only hook so the real-app e2e does not depend on CodeMirror gutter clicks over CDP.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__ORBIT_REVIEW__ = {
    add: (ws: string, c: Omit<ReviewComment, "id" | "side">) => useReview.getState().add(ws, { ...c, side: "new" }),
    send: (ws: string) => sendReview(ws),
    list: (ws: string) => useReview.getState().drafts[ws] ?? [],
  };
}

/** The workspace review commands act on: the one with drafts that is selected, else the only one with drafts. */
export function reviewTarget(): string | null {
  const drafts = useReview.getState().drafts;
  const selected = useApp.getState().selectedId;
  if (selected && drafts[selected]?.length) return selected;
  const ids = Object.keys(drafts).filter((id) => drafts[id].length);
  return ids.length === 1 ? ids[0] : null;
}
