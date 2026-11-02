// Web bridge (Flow cloud): implements the preload's `window.ate` over HTTPS + WebSocket against apps/cloud. Every call
// is POST /api/rpc { method, args } with the session cookie and the CSRF header. A call that needs approval answers
// with a ticket; we show what is being approved, the user taps Approve, the browser signs with the passkey, and the
// same call resumes on the server. Electron-only features (Touch ID helper, local proxy, file dialogs) degrade.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { DaemonEvent } from "@ate/core";
import { IPC_METHODS } from "../../shared/bridge";
import { SETUP_IPC } from "../../shared/setup-bridge";

let csrf = "";
export const setCsrf = (t: string) => (csrf = t);

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-flow-csrf": csrf }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) location.reload();
  if (!r.ok) return { result: { ok: false, error: { code: "ATE_INTERNAL", message: j.error ?? `HTTP ${r.status}` } } };
  return j;
}

/** Shows what the passkey approves; resolves true when the user taps Approve (a user gesture for WebAuthn). */
function confirmDialog(prompt: string): Promise<boolean> {
  return new Promise((res) => {
    const wrap = document.createElement("div");
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(10,14,11,.55);display:grid;place-items:center;z-index:9999";
    const box = document.createElement("div");
    box.style.cssText = "background:#fbfaf6;color:#171e19;border-radius:14px;padding:26px 28px;max-width:440px;font:15px/1.5 system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.25)";
    const h = document.createElement("div");
    h.textContent = "Approve with your passkey";
    h.style.cssText = "font-weight:700;font-size:18px;margin-bottom:10px";
    const p = document.createElement("div");
    p.textContent = prompt;
    p.style.cssText = "white-space:pre-wrap;word-break:break-word";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;justify-content:flex-end;margin-top:20px";
    const mk = (t: string, pri: boolean) => {
      const b = document.createElement("button");
      b.textContent = t;
      b.style.cssText = `border:0;border-radius:9px;padding:9px 16px;font:600 14px system-ui;cursor:pointer;${pri ? "background:#171e19;color:#fff" : "background:#e9e6dc;color:#171e19"}`;
      return b;
    };
    const no = mk("Cancel", false);
    const yes = mk("Approve", true);
    const done = (v: boolean) => (wrap.remove(), res(v));
    no.onclick = () => done(false);
    yes.onclick = () => done(true);
    row.append(no, yes);
    box.append(h, p, row);
    wrap.append(box);
    document.body.append(wrap);
    yes.focus();
  });
}

async function settle(j: any): Promise<unknown> {
  while (j && j.ticket) {
    let response: unknown = null;
    if (await confirmDialog(String(j.prompt ?? ""))) {
      try {
        response = await startAuthentication({ optionsJSON: j.options });
      } catch {
        response = null;
      }
    }
    j = await post("/api/approve", { ticket: j.ticket, response });
  }
  return j?.result;
}

export const rpc = async (method: string, ...args: unknown[]) => settle(await post("/api/rpc", { method, args: args.length && args[args.length - 1] === undefined ? args.slice(0, -1) : args }));

function events(handler: (e: DaemonEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`);
    ws.onmessage = (m) => {
      try {
        handler(JSON.parse(String(m.data)) as DaemonEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => void (!closed && setTimeout(open, 3000));
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}

export async function addPasskey(): Promise<{ ok: boolean; message?: string }> {
  const o = await post("/auth/passkey/register/options", {});
  if (!o.options) return { ok: false, message: o.result?.error?.message ?? "could not start" };
  let response;
  try {
    response = await startRegistration({ optionsJSON: o.options });
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const r = (await settle(await post("/auth/passkey/register", { flow: o.flow, response }))) as { ok?: boolean; error?: { message: string } } | undefined;
  return r?.ok ? { ok: true } : { ok: false, message: r?.error?.message ?? "the passkey was not registered" };
}

export function installBridge(): void {
  const ns: Record<string, Record<string, unknown>> = {};
  const put = (m: string, fn: (...a: unknown[]) => unknown) => {
    const [n, f] = m.split(".") as [string, string];
    (ns[n] ??= {})[f] = fn;
  };
  for (const m of [...IPC_METHODS, ...SETUP_IPC]) if (m.includes(".")) put(m, (...a) => rpc(m, ...a));
  for (const f of ["status", "createVaults", "setAgent", "setLimits", "unpause"]) put(`owner.${f}`, (...a) => rpc(`owner.${f}`, ...a));
  put("engine.confirm", (id, nonce, code) => rpc("engine.confirm", id, { nonce, code }));
  put("setup.open", async (url) => void window.open(String(url), "_blank", "noopener,noreferrer"));
  put("setup.saveJson", async (name, data) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = String(name).replace(/[^\w.-]/g, "_");
    a.click();
    return { ok: true, data: { path: a.download } };
  });
  put("cloud.addPasskey", () => addPasskey());
  put("cloud.signOut", async () => (await post("/auth/logout", {}), location.reload()));
  const ate = {
    fixtures: false,
    web: true,
    connection: () => rpc("connection"),
    ...Object.fromEntries(Object.entries(ns).map(([k, v]) => [k, Object.freeze(v)])),
    events: Object.freeze({ subscribe: events }),
  };
  Object.defineProperty(window, "ate", { value: Object.freeze(ate), writable: false });
}
