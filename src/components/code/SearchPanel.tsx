import { useEffect, useRef, useState } from "react";
import { codeApi, type SearchOptions, type SearchMatch, type SearchResult } from "../../lib/ipc";
import { useCode } from "../../stores/code";
import { cn } from "../ui";

const field =
  "h-7 min-w-0 rounded-[3px] border border-line-strong bg-bg px-2 text-[12px] placeholder:text-mute focus:outline-none focus:border-fg";
const toggles = [
  ["regex", ".*", "Regular expression"],
  ["caseSensitive", "Aa", "Match case"],
  ["wholeWord", "ab", "Whole word"],
] as const;
export function SearchPanel() {
  const root = useCode((s) => s.activeRoot),
    query = useCode((s) => s.searchQuery),
    focus = useCode((s) => s.searchFocus);
  const input = useRef<HTMLInputElement>(null),
    generation = useRef(0);
  const [options, setOptions] = useState<SearchOptions>({
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    include: "",
    exclude: "",
  });
  const [result, setResult] = useState<SearchResult | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (focus) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focus]);
  useEffect(() => {
    const current = ++generation.current;
    setResult(null);
    setError("");
    setBusy(!!root && !!query);
    if (!root || !query) return;
    const timer = setTimeout(() => {
      void codeApi
        .search(root, query, options, current)
        .then((r) => {
          if (generation.current === current && r.generation === current) {
            setResult(r);
            setBusy(false);
          }
        })
        .catch((e) => {
          if (generation.current === current) {
            setError(String(e));
            setBusy(false);
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [root, query, options]);
  const groups = new Map<string, SearchMatch[]>();
  for (const match of result?.matches ?? []) {
    const group = groups.get(match.rel) ?? [];
    group.push(match);
    groups.set(match.rel, group);
  }
  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <input
          ref={input}
          aria-label="Search in files"
          placeholder="Search in files"
          value={query}
          onChange={(e) => useCode.setState({ searchQuery: e.target.value })}
          className={cn(field, "min-w-[180px] flex-1")}
        />
        {toggles.map(([key, text, label]) => (
          <button
            key={key}
            aria-label={label}
            aria-pressed={options[key]}
            className={cn(
              "h-7 rounded-[3px] border px-2",
              options[key] ? "border-fg bg-hover text-fg" : "border-line text-mute hover:text-fg",
            )}
            onClick={() => setOptions((o) => ({ ...o, [key]: !o[key] }))}
          >
            {text}
          </button>
        ))}
        <input
          aria-label="Include globs"
          placeholder="Include: src/**, *.ts"
          value={options.include}
          className={cn(field, "w-44")}
          onChange={(e) => setOptions((o) => ({ ...o, include: e.target.value }))}
        />
        <input
          aria-label="Exclude globs"
          placeholder="Exclude: **/test/**"
          value={options.exclude}
          className={cn(field, "w-44")}
          onChange={(e) => setOptions((o) => ({ ...o, exclude: e.target.value }))}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2" aria-live="polite">
        {error && <p className="text-bad">{error}</p>}
        {busy && <p className="text-mute">Searching…</p>}
        {!query && <p className="text-mute">Search across this folder.</p>}
        {result && !result.matches.length && <p className="text-mute">No matches.</p>}
        {[...groups].map(([rel, matches]) => (
          <details key={`${root}|${rel}`} open className="mb-2">
            <summary className="cursor-pointer py-1 text-dim">
              {rel} <span className="ml-2 text-mute">{matches.length}</span>
            </summary>
            {matches.map((m, i) => (
              <button
                key={i}
                className="flex w-full gap-3 rounded-[3px] px-3 py-0.5 text-left hover:bg-hover"
                onClick={() => void useCode.getState().openFileAt(rel, m, root!)}
              >
                <span className="w-10 shrink-0 text-right tabular-nums text-mute">{m.line}</span>
                <code className="min-w-0 truncate whitespace-pre font-mono text-dim">
                  {m.text.slice(0, m.start)}
                  <mark className="bg-warn/20 text-fg">{m.text.slice(m.start, m.end)}</mark>
                  {m.text.slice(m.end)}
                </code>
              </button>
            ))}
          </details>
        ))}
        {result?.truncated && <p className="py-2 text-warn">Truncated at 2,000 matches</p>}
      </div>
    </div>
  );
}
