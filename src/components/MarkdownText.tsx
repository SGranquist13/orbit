import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown renderer, kept in its own module so Chat can load it lazily (it is the heaviest dependency). */
export default function MarkdownText({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>;
}
