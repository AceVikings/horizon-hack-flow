import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { App } from "./App";

/** Build-time render: scripts/prerender.mjs puts this HTML into dist/index.html so the page reads without JS. */
export function render(): string {
  return renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
