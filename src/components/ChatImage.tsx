import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, ImageOff, LoaderCircle, X } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { api, type FileRef, type ImageRef } from "../lib/ipc";
import { formatSize, middleTruncate } from "../lib/images";
import { useApp } from "../stores/app";
import { cn } from "./ui";

// Promise-deduped cache: one read per workspace+path for the life of the page.
const cache = new Map<string, Promise<string>>();

export function loadImage(workspaceId: string, path: string): Promise<string> {
  const key = `${workspaceId}\u0000${path}`;
  let p = cache.get(key);
  if (!p) {
    p = api.readImage(workspaceId, path);
    cache.set(key, p);
    // Don't cache failures: the file may appear later.
    p.catch(() => cache.delete(key));
  }
  return p;
}

/** Seeds the cache, e.g. with a just-uploaded image's local preview. */
export function primeImage(workspaceId: string, path: string, src: string) {
  cache.set(`${workspaceId}\u0000${path}`, Promise.resolve(src));
}

export function useImageSrc(workspaceId: string, path: string) {
  const [state, setState] = useState<{ src?: string; failed?: boolean }>({});
  useEffect(() => {
    let live = true;
    setState({});
    loadImage(workspaceId, path).then(
      (src) => live && setState({ src }),
      () => live && setState({ failed: true }),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, path]);
  return state;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** A clickable thumbnail that opens the lightbox. */
export function ChatImage({ workspaceId, image, className }: { workspaceId: string; image: ImageRef; className?: string }) {
  const { src, failed } = useImageSrc(workspaceId, image.path);
  const [open, setOpen] = useState(false);
  const name = fileName(image.path);
  if (failed)
    return (
      <span title={image.path} className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-line px-2 text-[11px] font-medium text-mute">
        <ImageOff className="size-3.5" /> {name}
      </span>
    );
  return (
    <>
      <button
        type="button"
        data-chat-image
        title={name}
        onClick={() => src && setOpen(true)}
        className={cn(
          "block overflow-hidden rounded-[4px] border-[1.5px] border-line bg-panel hover:border-line-strong",
          !src && "h-[72px] w-[96px] animate-pulse",
          className,
        )}
      >
        {src && <img src={src} alt={name} className="block h-[120px] max-h-[177px] max-w-[237px] object-cover" draggable={false} />}
      </button>
      {open && src && <Lightbox src={src} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

export function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div data-lightbox className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-overlay p-6" onMouseDown={onClose}>
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 grid size-8 place-items-center rounded-[4px] border-[1.5px] border-line-strong bg-raised text-dim hover:text-fg"
      >
        <X className="size-4" />
      </button>
      <img
        src={src}
        alt={name}
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[90vw] rounded-[4px] border-[1.5px] border-line-strong bg-panel object-contain shadow-hard"
      />
      <span className="rounded-[3px] bg-raised px-2 py-0.5 text-[11.5px] font-medium text-dim">{name}</span>
    </div>,
    document.body,
  );
}

/** A file attachment chip; clicking opens it with the OS default app. */
export function FileChip({ file, uploading, onRemove, error }: { file: { name: string; size: number; path?: string }; uploading?: boolean; error?: string; onRemove?: () => void }) {
  const body = (
    <>
      {uploading ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-mute" /> : <FileText className="size-3.5 shrink-0 text-mute" />}
      <span className="min-w-0 truncate text-[12px] font-medium text-dim">{middleTruncate(file.name)}</span>
      <span className={cn("shrink-0 text-[11px] tabular-nums", error ? "text-bad" : "text-mute")}>{error ?? formatSize(file.size)}</span>
    </>
  );
  const cls = "flex h-7 max-w-[260px] items-center gap-1.5 rounded-[4px] border-[1.5px] border-line bg-panel px-2";
  return (
    <span className="group relative inline-flex" data-file-chip>
      {file.path && !onRemove ? (
        <button
          type="button"
          title={`${file.path}\nOpen`}
          onClick={() => void openPath(file.path!).catch((e) => useApp.getState().setError(String(e)))}
          className={cn(cls, "hover:border-line-strong")}
        >
          {body}
        </button>
      ) : (
        <span title={file.name} className={cls}>
          {body}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          className="absolute -right-1.5 -top-1.5 hidden size-4 place-items-center rounded-full border border-line-strong bg-raised text-dim hover:text-fg group-hover:grid"
        >
          <X className="size-2.5" strokeWidth={3} />
        </button>
      )}
    </span>
  );
}

export function FileRow({ files, className }: { files: FileRef[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {files.map((f, i) => (
        <FileChip key={`${f.path}:${i}`} file={f} />
      ))}
    </div>
  );
}

export function ImageRow({ workspaceId, images, className }: { workspaceId: string; images: ImageRef[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {images.map((im, i) => (
        <ChatImage key={`${im.path}:${i}`} workspaceId={workspaceId} image={im} />
      ))}
    </div>
  );
}
