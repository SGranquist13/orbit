import { useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatImage, Lightbox, useImageSrc } from "./ChatImage";

// react-markdown's default urlTransform drops data: URLs; images need them.
const urlTransform = (url: string, key: string) => (key === "src" && /^data:image\//i.test(url) ? url : defaultTransform(url));
const defaultTransform = (url: string) => (/^(https?|mailto|tel):/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url) || /^[a-z]:[\\/]/i.test(url) ? url : "");

const remote = /^(https?:|data:image\/)/i;

function Fallback({ alt, src }: { alt: string; src: string }) {
  return (
    <code className="selectable" title={src}>
      {alt || src}
    </code>
  );
}

function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return <Fallback alt={alt} src={src} />;
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        onError={() => setFailed(true)}
        className="inline-block max-h-[320px] max-w-full cursor-zoom-in rounded-[4px] border-[1.5px] border-line"
      />
      {open && <Lightbox src={src} name={alt || "image"} onClose={() => setOpen(false)} />}
    </>
  );
}

function LocalImage({ workspaceId, src, alt }: { workspaceId: string; src: string; alt: string }) {
  const { failed } = useImageSrc(workspaceId, src);
  if (failed) return <Fallback alt={alt} src={src} />;
  return <ChatImage workspaceId={workspaceId} image={{ path: src, mediaType: "" }} className="inline-block align-bottom" />;
}

/** Markdown renderer, kept in its own module so Chat can load it lazily (it is the heaviest dependency). */
export default function MarkdownText({ text, workspaceId }: { text: string; workspaceId?: string }) {
  const components: Components = {
    img: ({ src, alt }) => {
      const s = typeof src === "string" ? src : "";
      if (!s) return <Fallback alt={alt ?? ""} src="" />;
      if (remote.test(s)) return <RemoteImage src={s} alt={alt ?? ""} />;
      if (!workspaceId) return <Fallback alt={alt ?? ""} src={s} />;
      let path = s;
      try {
        path = decodeURI(s);
      } catch {
        /* keep the raw path */
      }
      return <LocalImage workspaceId={workspaceId} src={path} alt={alt ?? ""} />;
    },
  };
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
      {text}
    </Markdown>
  );
}
