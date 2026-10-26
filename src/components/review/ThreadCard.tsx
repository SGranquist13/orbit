import { Check, ChevronRight, CornerDownRight, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import type { PrComment, PrThread } from "../../lib/ipc";
import { usePrReview } from "../../stores/prReview";
import type { ReviewComment } from "../../stores/review";
import MarkdownText from "../MarkdownText";
import { Button, cn } from "../ui";

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function Avatar({ login, url, size = 20 }: { login: string; url?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (url && !failed) return <img src={url} alt="" style={style} onError={() => setFailed(true)} className="shrink-0 rounded-full border border-line" />;
  return (
    <span style={{ ...style, fontSize: size * 0.45 }} className="grid shrink-0 place-items-center rounded-full border border-line-strong bg-raised font-semibold uppercase text-dim">
      {(login || "?").slice(0, 1)}
    </span>
  );
}

const SUGGESTION = /```suggestion[^\n]*\n([\s\S]*?)```/g;

/** Markdown, with GitHub ```suggestion blocks shown as a small before/after diff of the commented lines. */
export function CommentBody({ body, original }: { body: string; original?: string[] }) {
  const parts: { md?: string; suggestion?: string[] }[] = [];
  let last = 0;
  for (const m of body.matchAll(SUGGESTION)) {
    if (m.index! > last) parts.push({ md: body.slice(last, m.index) });
    parts.push({ suggestion: m[1].replace(/\n$/, "").split("\n") });
    last = m.index! + m[0].length;
  }
  if (last < body.length) parts.push({ md: body.slice(last) });
  return (
    <div className="space-y-2">
      {parts.map((p, i) =>
        p.suggestion ? (
          <div key={i} className="overflow-hidden rounded-[4px] border-[1.5px] border-line">
            <div className="border-b border-line bg-raised px-2 py-1 text-[11px] font-medium text-mute">Suggested change</div>
            <div className="rv-code overflow-x-auto py-1">
              <div className="w-max min-w-full">
                {(original ?? []).map((l, k) => (
                  <div key={`o${k}`} className="rv-del flex px-2"><span className="w-4 shrink-0 text-mute">−</span><span className="whitespace-pre">{l || " "}</span></div>
                ))}
                {p.suggestion.map((l, k) => (
                  <div key={`n${k}`} className="rv-add flex px-2"><span className="w-4 shrink-0 text-mute">+</span><span className="whitespace-pre">{l || " "}</span></div>
                ))}
              </div>
            </div>
          </div>
        ) : p.md!.trim() ? (
          <div key={i} className="prose-chat selectable text-[12.5px] leading-[1.55]">
            <MarkdownText text={p.md!} />
          </div>
        ) : null,
      )}
    </div>
  );
}

function CommentItem({ c, original }: { c: PrComment; original?: string[] }) {
  return (
    <div className="flex gap-2.5">
      <Avatar login={c.author} url={c.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-2 text-[11.5px]">
          <span className="font-semibold text-fg">{c.author}</span>
          <span className="text-mute">{ago(c.createdAt)}</span>
        </div>
        <CommentBody body={c.body} original={original} />
      </div>
    </div>
  );
}

const cardCls = "mx-3 my-1.5 rounded-[5px] border-[1.5px] border-line-strong bg-panel font-sans text-fg shadow-hard-sm";

/** A GitHub review thread: its comments, a reply box and Resolve. Resolved threads start collapsed. */
export function ThreadCard({ thread, original }: { thread: PrThread; original?: string[] }) {
  const [open, setOpen] = useState(!thread.isResolved);
  const [reply, setReply] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { reply: send, resolve } = usePrReview.getState();
  const first = thread.comments[0];
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className={cn(cardCls, "flex w-[calc(100%-24px)] items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-mute hover:text-fg")}>
        <ChevronRight className="size-3.5" />
        {thread.isResolved && <Check className="size-3.5 text-ok" />}
        <span className="font-medium">{thread.isResolved ? "Resolved" : "Collapsed"}</span>
        <span className="min-w-0 truncate">
          {first?.author}: {first?.body.replace(/\s+/g, " ")}
        </span>
        <span className="ml-auto tabular-nums">{thread.comments.length}</span>
      </button>
    );
  const submit = async () => {
    if (!reply?.trim() || !first) return;
    setSending(true);
    if (await send(first.id, reply.trim())) setReply(null);
    setSending(false);
  };
  return (
    <div className={cardCls} data-thread={thread.id}>
      {(thread.isOutdated || thread.isResolved) && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-mute">
          {thread.isOutdated && <span className="rounded-[3px] border border-line-strong px-1.5 font-medium">Outdated</span>}
          {thread.isResolved && <span className="flex items-center gap-1 font-medium"><Check className="size-3 text-ok" /> Resolved</span>}
          <button onClick={() => setOpen(false)} className="ml-auto hover:text-fg">Hide</button>
        </div>
      )}
      <div className="space-y-3 px-3 py-2.5">
        {thread.comments.map((c, i) => (
          <CommentItem key={c.id} c={c} original={i === 0 ? original : undefined} />
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-3 py-2">
        {reply === null ? (
          <button onClick={() => setReply("")} className="flex h-7 flex-1 items-center gap-1.5 rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 text-left text-[12px] text-mute hover:border-line-strong">
            <CornerDownRight className="size-3.5" /> Reply…
          </button>
        ) : (
          <div className="flex-1 space-y-2">
            <textarea
              autoFocus
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setReply(null);
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
              }}
              rows={3}
              placeholder="Reply (Markdown; Ctrl+Enter to send)"
              className="selectable w-full resize-y rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 py-1.5 text-[12.5px] focus:border-line-strong focus:outline-none"
            />
            <div className="flex justify-end gap-1.5">
              <Button onClick={() => setReply(null)}>Cancel</Button>
              <Button variant="primary" disabled={!reply.trim() || sending} onClick={() => void submit()}>
                {sending ? "Sending…" : "Reply"}
              </Button>
            </div>
          </div>
        )}
        {thread.canResolve && reply === null && (
          <Button variant="outline" onClick={() => void resolve(thread.id, !thread.isResolved)}>
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** One of your pending comments: GitHub: part of your pending review (also visible on github.com); local: goes to the agent. */
export function DraftCard({ c, github, original, onEdit, onDelete }: { c: ReviewComment; github: boolean; original?: string[]; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className={cardCls} data-draft={c.id}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-mute">
        <span className="rounded-[3px] border border-warn/60 px-1.5 font-medium text-warn" title={github ? "Saved on GitHub as part of your pending review; nobody sees it until you submit" : "Sent to the agent with Send to agent"}>Pending</span>
        <span>{c.startLine === c.endLine ? `Line ${c.startLine}` : `Lines ${c.startLine}–${c.endLine}`}{c.side === "old" ? " (base)" : ""}</span>
        <span className="ml-auto flex gap-1">
          <button onClick={onEdit} title="Edit" className="grid size-6 place-items-center rounded-[3px] hover:bg-hover hover:text-fg"><Pencil className="size-3.5" /></button>
          <button onClick={onDelete} title="Delete" className="grid size-6 place-items-center rounded-[3px] hover:bg-hover hover:text-bad"><Trash2 className="size-3.5" /></button>
        </span>
      </div>
      <div className="px-3 py-2.5">
        <CommentBody body={c.text} original={original} />
      </div>
    </div>
  );
}

/** The comment box under a line range. `github` adds "Add single comment" next to the review draft. */
export function Composer({
  label,
  initial,
  github,
  canSuggest,
  selected,
  onCancel,
  onDraft,
  onPostNow,
  saving,
}: {
  label: string;
  initial: string;
  github: boolean;
  canSuggest: boolean;
  selected: string[];
  onCancel: () => void;
  onDraft: (text: string) => void;
  onPostNow?: (text: string) => Promise<boolean>;
  saving?: boolean;
}) {
  const [text, setText] = useState(initial);
  const [posting, setPosting] = useState(false);
  const busy = usePrReview((s) => s.busy);
  const suggest = () => setText((t) => `${t}${t && !t.endsWith("\n") ? "\n" : ""}\`\`\`suggestion\n${selected.join("\n")}\n\`\`\`\n`);
  return (
    <div className={cn(cardCls, "p-2.5")} data-composer="">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-mute">
        <span className="font-medium">{label}</span>
        {canSuggest && (
          <button onClick={suggest} title="Insert the selected lines as a suggestion" className="ml-auto rounded-[3px] border border-line px-1.5 py-0.5 font-medium hover:border-line-strong hover:text-fg">
            ± Suggest change
          </button>
        )}
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) onDraft(text.trim());
        }}
        rows={4}
        placeholder={github ? "Leave a comment (Markdown; Ctrl+Enter adds it to your review)" : "Comment for the agent (Ctrl+Enter to add)"}
        className="selectable w-full resize-y rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 py-1.5 font-sans text-[12.5px] focus:border-line-strong focus:outline-none"
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <Button onClick={onCancel}>Cancel</Button>
        {github && onPostNow && (
          <Button
            variant="outline"
            disabled={!text.trim() || posting || busy !== null}
            onClick={async () => {
              setPosting(true);
              if (await onPostNow(text.trim())) onCancel();
              setPosting(false);
            }}
          >
            {posting ? "Posting…" : "Add single comment"}
          </Button>
        )}
        <Button variant="primary" disabled={!text.trim() || saving} onClick={() => onDraft(text.trim())}>
          {saving ? "Saving…" : initial ? "Save" : github ? "Add review comment" : "Add comment"}
        </Button>
      </div>
    </div>
  );
}
