import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib/env";
import { installDitherTiles } from "./lib/dither";
import { installTheme } from "./lib/theme";
import "./index.css";

async function boot() {
  // Dev-only: the mock backend is tree-shaken out of production bundles.
  if (import.meta.env.DEV && !isTauri()) {
    (await import("./lib/mock")).installMockBackend();
  }
  installTheme();
  installDitherTiles();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
