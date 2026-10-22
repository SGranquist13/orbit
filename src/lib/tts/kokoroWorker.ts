// Kokoro-82M inference in a Web Worker (onnxruntime-web, CPU/wasm), so synthesis never blocks the UI.
// Protocol (all replies carry the request `id`):
//   -> { type: "init", id, model: ArrayBuffer, paths: {mjs, wasm}, threads }   <- { type: "ready", id }
//   -> { type: "synth", id, ids: number[], style: Float32Array(256), speed }   <- { type: "audio", id, samples: Float32Array }
//   <- { type: "error", id, message } for either
import * as ort from "onnxruntime-web/wasm";

export type WorkerRequest =
  | { type: "init"; id: number; model: ArrayBuffer; paths: { mjs: string; wasm: string }; threads: number }
  | { type: "synth"; id: number; ids: number[]; style: Float32Array; speed: number };
export type WorkerReply = { type: "ready"; id: number } | { type: "audio"; id: number; samples: Float32Array } | { type: "error"; id: number; message: string };

let session: ort.InferenceSession | null = null;

const scope = self as unknown as { postMessage: (m: WorkerReply, transfer?: Transferable[]) => void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };

scope.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      ort.env.logLevel = "error";
      ort.env.wasm.numThreads = msg.threads;
      ort.env.wasm.wasmPaths = msg.paths as unknown as string;
      session = await ort.InferenceSession.create(new Uint8Array(msg.model), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      scope.postMessage({ type: "ready", id: msg.id });
    } else if (msg.type === "synth") {
      if (!session) throw new Error("synthesis model not loaded");
      const ids = BigInt64Array.from(msg.ids, (n) => BigInt(n));
      const out = await session.run({
        input_ids: new ort.Tensor("int64", ids, [1, ids.length]),
        style: new ort.Tensor("float32", msg.style, [1, msg.style.length]),
        speed: new ort.Tensor("float32", new Float32Array([msg.speed]), [1]),
      });
      const wave = (out.waveform ?? out[session.outputNames[0]]).data as Float32Array;
      const samples = new Float32Array(wave); // own the memory so it can be transferred
      scope.postMessage({ type: "audio", id: msg.id, samples }, [samples.buffer]);
    }
  } catch (err) {
    scope.postMessage({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
