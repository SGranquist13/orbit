import { describe, expect, test } from "bun:test";
import { needsSetup, classifyUtterance, f32ToBase64, handsFreePhase, hfInitial, hfReduce, insertAtCursor, isStopWord, resampleLinear, rms, speakable, type HfEffect, type HfEvent, type HfState } from "./voice";

/** Runs events through the reducer, returning the final state and every effect in order. */
function run(events: HfEvent[], start: HfState = { ...hfInitial, on: true }) {
  let state = start;
  const effects: HfEffect[] = [];
  for (const e of events) {
    const r = hfReduce(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects, phase: handsFreePhase(state) };
}
const say = (text: string, dropped = false): HfEvent[] => [{ type: "speechStart", bargeIn: true }, { type: "speechEnd" }, { type: "transcribed", text, dropped }];

describe("hands-free loop", () => {
  test("starts listening and stops from anywhere", () => {
    expect(run([{ type: "start" }], hfInitial).phase).toBe("listening");
    const r = run([{ type: "turnCompleted", reply: "Done." }, { type: "stop" }]);
    expect(r.state).toEqual(hfInitial);
    expect(r.effects).toContainEqual({ type: "stopSpeech" });
  });
  test("an utterance goes hearing -> transcribing -> working with one send", () => {
    expect(run([{ type: "speechStart", bargeIn: true }]).phase).toBe("hearing");
    expect(run([{ type: "speechStart", bargeIn: true }, { type: "speechEnd" }]).phase).toBe("transcribing");
    const r = run(say("add a test"));
    expect(r.effects).toEqual([{ type: "send", text: "add a test" }]);
    expect(r.phase).toBe("working");
  });
  test("speaking the reply returns to listening", () => {
    const r = run([...say("go"), { type: "turnCompleted", reply: "All done." }]);
    expect(r.phase).toBe("speaking");
    expect(r.effects).toContainEqual({ type: "speak", text: "All done." });
    expect(run([...say("go"), { type: "turnCompleted", reply: "All done." }, { type: "speechDone" }]).phase).toBe("listening");
  });
  test("no reply to speak goes straight back to listening", () => {
    expect(run([...say("go"), { type: "turnCompleted", reply: null }]).phase).toBe("listening");
  });
  test("a failed transcription or send never leaves the loop deaf", () => {
    expect(run([{ type: "speechStart", bargeIn: true }, { type: "speechEnd" }, { type: "transcribeFailed" }]).phase).toBe("listening");
    const r = run([...say("go"), { type: "sendFailed" }]);
    expect(r.phase).toBe("listening");
    expect(r.state.on).toBe(true);
    // ...and the next utterance is still heard
    expect(run([...say("go"), { type: "sendFailed" }, ...say("again")]).effects.filter((e) => e.type === "send").length).toBe(2);
  });
});

describe("dropped and empty transcripts", () => {
  test("a dropped transcript does nothing", () => {
    const r = run(say("Thank you.", true));
    expect(r.effects).toEqual([]);
    expect(r.phase).toBe("listening");
    expect(r.state.working).toBe(false);
  });
  test("an empty transcript does nothing", () => {
    expect(run(say("   ")).effects).toEqual([]);
  });
  test("a misfire (too short to be speech) returns to listening", () => {
    const r = run([{ type: "speechStart", bargeIn: true }, { type: "speechMisfire" }]);
    expect(r.phase).toBe("listening");
    expect(r.effects).toEqual([]);
  });
});

describe("stop words", () => {
  test("recognised alone, ignoring case and punctuation", () => {
    for (const t of ["stop", "Stop.", " CANCEL! ", "wait", "Wait...", "hold on", "Hold on!"]) expect(isStopWord(t)).toBe(true);
    for (const t of ["stop the build", "wait for the tests", "hold on to that", "", "don't stop", "waiting"]) expect(isStopWord(t)).toBe(false);
  });
  test("classify", () => {
    expect(classifyUtterance("stop", false)).toBe("stop");
    expect(classifyUtterance("fix the bug", false)).toBe("send");
    expect(classifyUtterance("fix the bug", true)).toBe("ignore");
    expect(classifyUtterance("", false)).toBe("ignore");
  });
  test("a stop word interrupts the agent and speech, and sends nothing", () => {
    const working = run(say("do the thing"));
    const r = run(say("stop"), working.state);
    expect(r.effects).toEqual([{ type: "interrupt" }]);
    expect(r.state.working).toBe(false);
    expect(r.phase).toBe("listening");
    const speaking = run([...say("go"), { type: "turnCompleted", reply: "Hello there." }]);
    const s2 = run([{ type: "speechStart", bargeIn: false }, { type: "speechEnd" }, { type: "transcribed", text: "wait", dropped: false }], speaking.state);
    expect(s2.effects).toContainEqual({ type: "interrupt" });
    expect(s2.effects).toContainEqual({ type: "stopSpeech" });
  });
});

describe("sending while the agent works", () => {
  test("each utterance is sent, one after the other", () => {
    const r = run([...say("first part"), ...say("and second part"), ...say("and a third")]);
    expect(r.effects.filter((e) => e.type === "send")).toEqual([
      { type: "send", text: "first part" },
      { type: "send", text: "and second part" },
      { type: "send", text: "and a third" },
    ]);
    expect(r.phase).toBe("working");
  });
  test("a turn that started elsewhere still marks the agent as working", () => {
    expect(run([{ type: "turnStarted" }]).phase).toBe("working");
  });
  test("speech is heard even while a turn is running", () => {
    const r = run([{ type: "turnStarted" }, ...say("also rename it")]);
    expect(r.effects).toEqual([{ type: "send", text: "also rename it" }]);
  });
});

describe("barge-in", () => {
  const speaking = () => run([...say("go"), { type: "turnCompleted", reply: "A long answer." }]).state;
  test("speech start while Orbit speaks cuts the speech immediately", () => {
    const r = run([{ type: "speechStart", bargeIn: true }], speaking());
    expect(r.effects).toEqual([{ type: "stopSpeech" }]);
    expect(r.state.speaking).toBe(false);
    expect(r.phase).toBe("hearing");
  });
  test("the barged-in utterance is then sent normally", () => {
    const r = run([{ type: "speechStart", bargeIn: true }, { type: "speechEnd" }, { type: "transcribed", text: "actually use tabs", dropped: false }], speaking());
    expect(r.effects).toEqual([{ type: "stopSpeech" }, { type: "send", text: "actually use tabs" }]);
  });
  test("with barge-in off, speech during Orbit's reply is ignored and the reply keeps playing", () => {
    const r = run([{ type: "speechStart", bargeIn: false }, { type: "speechEnd" }], speaking());
    expect(r.effects).toEqual([]);
    expect(r.state.speaking).toBe(true);
    expect(r.state.transcribing).toBe(0);
    expect(r.phase).toBe("speaking");
  });
  test("with barge-in off, the user can still start speaking once Orbit is done", () => {
    const r = run([{ type: "speechDone" }, ...say("next")], speaking());
    expect(r.effects).toEqual([{ type: "send", text: "next" }]);
  });
  test("speech start when Orbit is silent has nothing to cut", () => {
    expect(run([{ type: "speechStart", bargeIn: true }]).effects).toEqual([]);
  });
});

describe("a reply that finishes while the user is talking", () => {
  const midUtterance: HfEvent[] = [{ type: "speechStart", bargeIn: true }];
  test("waits until they finish", () => {
    const r = run([...midUtterance, { type: "turnCompleted", reply: "Done." }]);
    expect(r.effects).toEqual([]);
    expect(r.state.pending).toBe("Done.");
    expect(r.phase).toBe("hearing");
  });
  test("is spoken after a misfire or a dropped utterance", () => {
    expect(run([...midUtterance, { type: "turnCompleted", reply: "Done." }, { type: "speechMisfire" }]).effects).toEqual([{ type: "speak", text: "Done." }]);
    const dropped = run([...midUtterance, { type: "turnCompleted", reply: "Done." }, { type: "speechEnd" }, { type: "transcribed", text: "um", dropped: true }]);
    expect(dropped.effects).toEqual([{ type: "speak", text: "Done." }]);
    expect(dropped.phase).toBe("speaking");
  });
  test("is skipped when they then send something new", () => {
    const r = run([...midUtterance, { type: "turnCompleted", reply: "Done." }, { type: "speechEnd" }, { type: "transcribed", text: "one more thing", dropped: false }]);
    expect(r.effects).toEqual([{ type: "send", text: "one more thing" }]);
    expect(r.state.pending).toBeNull();
    expect(r.phase).toBe("working");
  });
  test("waits while a transcription is still in flight", () => {
    const r = run([{ type: "speechStart", bargeIn: true }, { type: "speechEnd" }, { type: "turnCompleted", reply: "Done." }]);
    expect(r.effects).toEqual([]);
    expect(r.state.pending).toBe("Done.");
  });
  test("is skipped when they say stop", () => {
    const r = run([...midUtterance, { type: "turnCompleted", reply: "Done." }, { type: "speechEnd" }, { type: "transcribed", text: "stop", dropped: false }]);
    expect(r.effects).toEqual([{ type: "interrupt" }]);
    expect(r.state.pending).toBeNull();
  });
});

describe("events are ignored while off", () => {
  test("nothing happens", () => {
    expect(hfReduce(hfInitial, { type: "turnCompleted", reply: "x" })).toEqual({ state: hfInitial, effects: [] });
    expect(hfReduce(hfInitial, { type: "speechStart", bargeIn: true }).effects).toEqual([]);
  });
});

describe("audio helpers", () => {
  test("f32ToBase64 is little-endian float32", () => {
    expect(f32ToBase64(new Float32Array([1, -2]))).toBe("AACAPwAAAMA=");
    expect(f32ToBase64(new Float32Array([]))).toBe("");
  });
  test("resampleLinear changes the length by the rate ratio and keeps equal rates untouched", () => {
    const a = new Float32Array(48000).fill(0.5);
    expect(resampleLinear(a, 48000, 16000).length).toBe(16000);
    expect(resampleLinear(a, 16000, 16000)).toBe(a);
    expect(Array.from(resampleLinear(new Float32Array([0, 1, 0, 1]), 4, 2))).toEqual([0.5, 0.5]);
    expect(Array.from(resampleLinear(new Float32Array([0, 1]), 1, 2)).length).toBe(4);
  });
  test("rms", () => {
    expect(rms(new Float32Array([]))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

describe("speakable", () => {
  test("strips markdown", () => {
    expect(speakable("## Title\n\nSome **bold** and _italic_ text.")).toBe("Title Some bold and italic text.");
    expect(speakable("- one\n- two\n1. three")).toBe("one two three");
  });
  test("links and inline code become their text", () => {
    expect(speakable("See [the docs](https://x.dev/a) and run `bun test`.")).toBe("See the docs and run bun test.");
  });
  test("fenced code blocks are summarised", () => {
    expect(speakable("Before\n```ts\nconst a = 1;\nconst b = 2;\n```\nAfter")).toBe("Before code block, 2 lines After");
    expect(speakable("```\nx\n```")).toBe("code block, 1 line");
  });
  test("collapses whitespace", () => {
    expect(speakable("a\n\n\n  b \t c")).toBe("a b c");
  });
});

describe("insertAtCursor", () => {
  test("into empty text", () => {
    expect(insertAtCursor("", 0, 0, "hello")).toEqual({ value: "hello", cursor: 5 });
  });
  test("adds a space after existing text", () => {
    expect(insertAtCursor("fix this", 8, 8, "and that")).toEqual({ value: "fix this and that", cursor: 17 });
  });
  test("adds spaces on both sides mid-text and keeps surrounding text", () => {
    const r = insertAtCursor("ab", 1, 1, "X");
    expect(r.value).toBe("a X b");
    expect(r.cursor).toBe(4);
  });
  test("no extra space next to whitespace", () => {
    expect(insertAtCursor("hello ", 6, 6, "world").value).toBe("hello world");
    expect(insertAtCursor("a\nb", 2, 2, "x").value).toBe("a\nx b");
  });
  test("replaces only the selection", () => {
    expect(insertAtCursor("one two three", 4, 7, "2").value).toBe("one 2 three");
  });
  test("ignores empty insert and clamps", () => {
    expect(insertAtCursor("abc", 1, 1, "  ")).toEqual({ value: "abc", cursor: 1 });
    expect(insertAtCursor("abc", 99, 99, "d").value).toBe("abc d");
  });
});


describe("voice setup prompting", () => {
  for (const action of ["dictate", "handsfree", "readAloud"] as const) {
    for (const sttInstalled of [false, true]) {
      for (const ttsInstalled of [false, true]) {
        for (const dismissed of [false, true]) {
          test(`${action}: speech=${sttInstalled}, natural=${ttsInstalled}, dismissed=${dismissed}`, () => {
            const expected = action === "readAloud"
              ? !ttsInstalled && !dismissed
              : !sttInstalled || (!ttsInstalled && !dismissed);
            expect(needsSetup({ sttInstalled, ttsInstalled, dismissed, action })).toBe(expected);
          });
        }
      }
    }
  }
});
