// @ts-nocheck
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Separate entry for the launch film. Not referenced by the app build (`bun run build`).
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@src": path.resolve(here, "../src") } },
  clearScreen: false,
  server: { port: 1430, strictPort: true, fs: { allow: [path.resolve(here, "..")] } },
  build: { outDir: path.resolve(here, "dist"), emptyOutDir: true },
});
