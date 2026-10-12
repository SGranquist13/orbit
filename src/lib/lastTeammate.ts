// The last teammate the user looked at: a per-viewer convenience, so storage failures are swallowed.
const KEY = "teammateSelected";

export function rememberedTeammate(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberTeammate(slug: string | null) {
  try {
    if (slug) localStorage.setItem(KEY, slug);
  } catch {
    // Not persisted; the list still works.
  }
}
