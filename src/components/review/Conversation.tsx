import { useMemo, useState } from "react";
import type { PrDetail, PrReviewSummary } from "../../lib/ipc";
import { usePrReview } from "../../stores/prReview";
import { Button, cn } from "../ui";
import { Avatar, CommentBody, ago } from "./ThreadCard";

const VERB: Record<PrReviewSummary["state"], [string, string]> = {
  APPROVED: ["approved these changes", "text-ok"],
  CHANGES_REQUESTED: ["requested changes", "text-warn"],
  COMMENTED: ["reviewed", "text-dim"],
  DISMISSED: ["review was dismissed", "text-mute"],
  PENDING: ["has a pending review", "text-mute"],
};

type Entry = { at: string; author: string; avatarUrl: string; body: string; verb?: [string, string]; id: string };

/** Description, reviews and timeline comments in time order, with a box to add a comment. */
export function Conversation({ pr }: { pr: PrDetail }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      ...pr.comments.map((c) => ({ id: `c${c.id}`, at: c.createdAt, author: c.author, avatarUrl: c.avatarUrl, body: c.body })),
      ...pr.reviews.filter((r) => r.submittedAt && (r.body.trim() || r.state !== "COMMENTED")).map((r) => ({ id: r.id, at: r.submittedAt!, author: r.author, avatarUrl: r.avatarUrl, body: r.body, verb: VERB[r.state] })),
    ];
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [pr]);
  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    if (await usePrReview.getState().converse(text.trim())) setText("");
    setSending(false);
  };
  return (
    <div className="mx-auto max-w-[820px] px-6 py-5">
      <Card author={pr.author} avatarUrl={pr.authorAvatarUrl} at={pr.createdAt} verb={["opened this pull request", "text-dim"]}>
        {pr.body.trim() ? <CommentBody body={pr.body} /> : <p className="text-[12.5px] italic text-mute">No description.</p>}
      </Card>
      {entries.map((e) => (
        <Card key={e.id} author={e.author} avatarUrl={e.avatarUrl} at={e.at} verb={e.verb}>
          {e.body.trim() && <CommentBody body={e.body} />}
        </Card>
      ))}
      {pr.state === "OPEN" && (
        <div className="mt-5 rounded-[5px] border-[1.5px] border-line-strong bg-panel p-2.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
            }}
            rows={4}
            placeholder="Add a comment (Markdown; Ctrl+Enter to send)"
            className="selectable w-full resize-y rounded-[4px] border-[1.5px] border-line bg-bg px-2.5 py-1.5 text-[12.5px] focus:border-line-strong focus:outline-none"
          />
          <div className="mt-1.5 flex justify-end">
            <Button variant="primary" disabled={!text.trim() || sending} onClick={() => void send()}>
              {sending ? "Sending…" : "Comment"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ author, avatarUrl, at, verb, children }: { author: string; avatarUrl: string; at: string; verb?: [string, string]; children: React.ReactNode }) {
  return (
    <div className="relative flex gap-3 pb-5 before:absolute before:bottom-0 before:left-[13px] before:top-8 before:w-[1.5px] before:bg-line last:before:hidden">
      <Avatar login={author} url={avatarUrl} size={28} />
      <div className="min-w-0 flex-1 rounded-[5px] border-[1.5px] border-line bg-panel">
        <div className="flex items-baseline gap-1.5 border-b border-line px-3 py-1.5 text-[12px]">
          <span className="font-semibold">{author}</span>
          {verb && <span className={cn(verb[1])}>{verb[0]}</span>}
          <span className="ml-auto text-[11px] text-mute">{ago(at)}</span>
        </div>
        {children ? <div className="px-3 py-2.5">{children}</div> : null}
      </div>
    </div>
  );
}
