import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDitherTiles } from "./lib/dither";
import { installTheme } from "./lib/theme";
import "./index.css";

async function boot() {
  if (!("__TAURI_INTERNALS__" in window)) {
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
