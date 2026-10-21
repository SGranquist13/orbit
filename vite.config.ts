import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import fs from "node:fs";
// @ts-expect-error type error without @types/node package
import { fileURLToPath } from "node:url";
const host = process.env.TAURI_DEV_HOST;

// Speech runtime assets (Silero VAD model + worklet, onnxruntime-web wasm) are served from the app itself so
// Orbit works offline: dev serves them straight from node_modules, `vite build` emits them under dist/speech/
// with stable names (the libraries build the URLs themselves, so they cannot be content-hashed).
const SPEECH_ASSETS: Record<string, string> = {
  "speech/silero_vad_v5.onnx": "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx",
  "speech/vad.worklet.bundle.min.js": "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
  "speech/ort-wasm-simd-threaded.wasm": "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
  "speech/ort-wasm-simd-threaded.mjs": "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
};
const speechAssets = (): Plugin => {
  const source = (rel: string): string => fileURLToPath(new URL(`./${SPEECH_ASSETS[rel]}`, import.meta.url));
  const types: Record<string, string> = { ".onnx": "application/octet-stream", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
  return {
    name: "orbit-speech-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rel = (req.url ?? "").split("?")[0].replace(/^\//, "");
        if (!(rel in SPEECH_ASSETS)) return next();
        res.setHeader("Content-Type", types[rel.slice(rel.lastIndexOf("."))] ?? "application/octet-stream");
        fs.createReadStream(source(rel)).pipe(res);
      });
    },
    generateBundle(_options, bundle) {
      // onnxruntime-web references its wasm by import.meta.url, which makes the bundler emit a hashed copy;
      // we always point it at speech/ explicitly, so the duplicate (14 MB) is dropped.
      for (const key of Object.keys(bundle)) if (/^assets\/ort-wasm-simd-threaded.*\.wasm$/.test(key)) delete bundle[key];
      for (const rel of Object.keys(SPEECH_ASSETS)) this.emitFile({ type: "asset", fileName: rel, source: fs.readFileSync(source(rel)) });
    },
  };
};

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), speechAssets()],

  // The Kokoro synthesis worker is an ES module that imports onnxruntime-web.
  worker: { format: "es" as const },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
