import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { reviewApi } from "../../lib/ipc";
import { usePrReview, type Texts } from "../../stores/prReview";
import MarkdownText from "../MarkdownText";
import { cn } from "../ui";
import type { DiffProps } from "./ReviewDiff";

const IMAGE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif" };
const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
export const isImage = (path: string) => ext(path) in IMAGE;
const isMarkdown = (path: string) => ["md", "markdown", "mdx"].includes(ext(path));
/** Files with a rendered preview next to the source diff. */
export const isRich = (path: string) => isMarkdown(path) || ext(path) === "svg";

type Mode = "2-up" | "swipe" | "onion";
interface Side {
  url: string;
  bytes: number;
}

/** Before/after images: side by side, a swipe divider, or onion skin. */
export function ImageDiff({ opened, file, rangeView }: DiffProps) {
  const [sides, setSides] = useState<{ old: Side | null; new: Side | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("2-up");
  const [mix, setMix] = useState(50);
  useEffect(() => {
    let live = true;
    setSides(null), setError(null);
    const mime = IMAGE[ext(file.path)];
    const wrap = (b64: string | null): Side | null => (b64 ? { url: `data:${mime};base64,${b64}`, bytes: Math.floor((b64.length * 3) / 4) } : null);
    const pr = opened.pr;
    const load = pr
      ? Promise.all([
          file.status === "added" ? null : reviewApi.blob(pr.repo, rangeView?.base ?? pr.mergeBaseSha, file.previousPath ?? file.path),
          file.status === "removed" ? null : reviewApi.blob(pr.repo, rangeView?.head ?? pr.headSha, file.path),
        ])
      : Promise.all([
          file.status === "added" ? null : reviewApi.localBlob(opened.local!.workspaceId, file.path, "old"),
          reviewApi.localBlob(opened.local!.workspaceId, file.path, "new"),
        ]);
    load.then(([o, n]) => live && setSides({ old: wrap(o), new: wrap(n) })).catch((e) => live && setError(String(e).replace(/^Error:\s*/, "")));
    return () => {
      live = false;
    };
  }, [opened.key, opened.pr?.headSha, opened.local?.headSha, rangeView?.base, rangeView?.head, file.path, file.previousPath, file.status]);

  if (error) return <p className="selectable px-6 py-10 text-center text-[12.5px] text-bad">{error}</p>;
  if (!sides) return <Loading label={file.path} />;
  if (!sides.old && !sides.new) return <p className="px-6 py-10 text-center text-[12.5px] text-mute">Image too large to show.</p>;
  const both = sides.old && sides.new;
  return (
    <div className="p-5" data-image-diff={file.path}>
      {both && (
        <div className="mb-4 flex justify-center">
          <Segmented value={mode} onChange={setMode} options={["2-up", "swipe", "onion"]} labels={{ "2-up": "Side by side", swipe: "Swipe", onion: "Onion skin" }} />
        </div>
      )}
      {!both || mode === "2-up" ? (
        <div className="flex flex-wrap items-start justify-center gap-6">
          {sides.old && <Frame side={sides.old} label="Before" tone="bad" />}
          {sides.new && <Frame side={sides.new} label={sides.old ? "After" : "Added"} tone="ok" />}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="checker relative inline-block border-[1.5px] border-line-strong">
            <img src={sides.old!.url} alt="Before" className="block max-h-[60vh] max-w-full" />
            <img
              src={sides.new!.url}
              alt="After"
              className="absolute inset-0 block size-full object-contain"
              style={mode === "swipe" ? { clipPath: `inset(0 ${100 - mix}% 0 0)` } : { opacity: mix / 100 }}
            />
            {mode === "swipe" && <div className="pointer-events-none absolute inset-y-0 w-[1.5px] bg-fg" style={{ left: `${mix}%` }} />}
          </div>
          <label className="flex items-center gap-3 text-[11.5px] text-mute">
            Before
            <input type="range" min={0} max={100} value={mix} onChange={(e) => setMix(Number(e.target.value))} className="w-[240px] accent-[var(--fg)]" aria-label={mode === "swipe" ? "Swipe position" : "Opacity"} />
            After
          </label>
        </div>
      )}
    </div>
  );
}

function Frame({ side, label, tone }: { side: Side; label: string; tone: "ok" | "bad" }) {
  const [dims, setDims] = useState("");
  return (
    <figure className="flex flex-col items-center gap-2">
      <div className={cn("checker border-[1.5px] p-0", tone === "ok" ? "border-ok/70" : "border-bad/70")}>
        <img src={side.url} alt={label} onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} className="block max-h-[60vh] max-w-[40vw]" />
      </div>
      <figcaption className="text-[11.5px] text-mute tabular-nums">
        <span className={cn("font-medium", tone === "ok" ? "text-ok" : "text-bad")}>{label}</span> · {dims} · {kb(side.bytes)}
      </figcaption>
    </figure>
  );
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Rendered Markdown, or an SVG drawn as an image; split layout shows before and after. */
export function RichPreview({ opened, file, layout, rangeView }: DiffProps) {
  const [texts, setTexts] = useState<Texts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setTexts(null), setError(null);
    usePrReview
      .getState()
      .loadTexts(file.path)
      .then((t) => live && setTexts(t))
      .catch((e) => live && setError(String(e).replace(/^Error:\s*/, "")));
    return () => {
      live = false;
    };
  }, [opened.key, opened.pr?.headSha, opened.local?.headSha, rangeView?.base, rangeView?.head, file.path]);
  if (error) return <p className="selectable px-6 py-10 text-center text-[12.5px] text-bad">{error}</p>;
  if (!texts) return <Loading label={file.path} />;
  const svg = ext(file.path) === "svg";
  const render = (text: string | null, label: string, tone: "ok" | "bad") => (
    <div className="min-w-0 flex-1">
      <div className={cn("mb-2 text-[11px] font-medium", tone === "ok" ? "text-ok" : "text-bad")}>{label}</div>
      {text === null ? (
        <p className="text-[12.5px] italic text-mute">{tone === "ok" ? "Removed" : "New file"}</p>
      ) : svg ? (
        <div className="checker inline-block border-[1.5px] border-line-strong">
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} alt={label} className="block max-h-[60vh] max-w-full" />
        </div>
      ) : (
        <div className="prose-chat selectable rounded-[5px] border-[1.5px] border-line bg-panel px-5 py-4 text-[13px] leading-[1.6]">
          <MarkdownText text={text} />
        </div>
      )}
    </div>
  );
  return (
    <div className={cn("flex gap-6 p-5", layout === "unified" && "mx-auto max-w-[860px]")} data-rich-preview={file.path}>
      {layout === "split" && render(texts.old, "Before", "bad")}
      {render(texts.new, layout === "split" ? "After" : "Rendered", "ok")}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="px-6 py-10 text-center text-[12.5px] text-mute">
      <LoaderCircle className="mr-2 inline size-3.5 animate-spin" />
      Loading {label}…
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options, labels }: { value: T; onChange: (v: T) => void; options: T[]; labels: Record<T, string> }) {
  return (
    <div className="flex rounded-[5px] border-[1.5px] border-line p-0.5">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} className={cn("rounded-[3px] px-2.5 py-0.5 text-[11.5px] font-medium", value === o ? "bg-raised text-fg" : "text-mute hover:text-fg")}>
          {labels[o]}
        </button>
      ))}
    </div>
  );
}
