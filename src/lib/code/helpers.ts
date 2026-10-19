/** Smallest single replacement, preserving positions outside the changed range. */
export function minimalChange(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let end = before.length, nextEnd = after.length;
  while (end > from && nextEnd > from && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return { from, to: end, insert: after.slice(from, nextEnd) };
}

/** Subsequence matching with bonuses for consecutive characters and path boundaries. */
export function fuzzyScore(path: string, query: string): number {
  const value = path.toLowerCase(), needle = query.toLowerCase().trim();
  let cursor = 0, score = 0, previous = -2;
  for (const char of needle) {
    const at = value.indexOf(char, cursor);
    if (at < 0) return -1;
    score += 10 + (at === previous + 1 ? 8 : 0) + (at === 0 || /[/_.-]/.test(value[at - 1]) ? 12 : 0);
    previous = at; cursor = at + 1;
  }
  return score + 1 / (path.length + 1);
}
