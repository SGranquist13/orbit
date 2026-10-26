import type { ReviewQueueSource } from "../../lib/ipc";
import { Row, Segmented, Select, Toggle, save, useSettings } from "./controls";

const SOURCES: { value: ReviewQueueSource; label: string; hint: string }[] = [
  { value: "requested", label: "Review requested", hint: "PRs waiting on your review" },
  { value: "mine", label: "Your pull requests", hint: "PRs you opened" },
  { value: "involves", label: "Involves you", hint: "PRs that mention you or that you commented on" },
];

export function ReviewSettings() {
  const s = useSettings();
  if (!s) return null;
  const sources = s.reviewQueueSources;
  const toggle = (v: ReviewQueueSource, on: boolean) =>
    void save({ reviewQueueSources: on ? [...new Set([...sources, v])] : sources.filter((x) => x !== v) });
  return (
    <>
      <Row label="Diff layout" field="reviewDiffLayout" description="The toolbar in the Review view switches it for the current session">
        <Segmented
          label="Diff layout"
          value={s.reviewDiffLayout}
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
          onChange={(v) => void save({ reviewDiffLayout: v })}
        />
      </Row>
      <Row label="Context lines" field="reviewContextLines" description="Unchanged lines shown around each change before the rest collapses">
        <Select
          label="Context lines"
          value={String(s.reviewContextLines)}
          options={[0, 1, 2, 3, 5, 8, 12, 20].map((n) => ({ value: String(n), label: `${n} line${n === 1 ? "" : "s"}` }))}
          onChange={(v) => void save({ reviewContextLines: Number(v) })}
        />
      </Row>
      <Row label="Wrap long lines" field="reviewWrapLines">
        <Toggle label="Wrap long lines" checked={s.reviewWrapLines} onChange={(v) => void save({ reviewWrapLines: v })} />
      </Row>
      <Row label="Mark viewed on next file" field="reviewMarkViewedOnNext" description="Moving to the next file with ] marks the one you leave as viewed">
        <Toggle label="Mark viewed on next file" checked={s.reviewMarkViewedOnNext} onChange={(v) => void save({ reviewMarkViewedOnNext: v })} />
      </Row>
      {SOURCES.map((o) => (
        <Row key={o.value} label={`Queue: ${o.label}`} field="reviewQueueSources" description={o.hint}>
          <Toggle label={`Show ${o.label} in the Review queue`} checked={sources.includes(o.value)} onChange={(v) => toggle(o.value, v)} />
        </Row>
      ))}
    </>
  );
}
