// Web entry (Flow cloud): sign in, then the same React app as the desktop over the web bridge.
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { installBridge, setCsrf } from "./bridge";
import Login from "./Login";
import "../src/styles.css";

async function boot() {
  const s = (await fetch("/auth/state", { credentials: "same-origin" }).then((r) => r.json())) as { authenticated: boolean; csrf?: string; passkeys: number; password: boolean };
  if (!s.authenticated) {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Login passkeys={s.passkeys} password={s.password} />
      </StrictMode>,
    );
    return;
  }
  setCsrf(s.csrf ?? "");
  installBridge();
  if (!location.hash || location.hash === "#/") location.hash = "#/unlock";
  await import("../src/main");
}
void boot();
