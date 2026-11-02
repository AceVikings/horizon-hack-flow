// Setup + daemon lifecycle IPC (lane D2). Owns: spawning/adopting the daemon, /ui/attach approval (ate-approve
// Touch ID, else the daemon's one-time code shown in-app), the agent-key passphrase (random, sealed with the
// macOS keychain via safeStorage, released by Touch ID), /setup/* passthrough, and two-step Settings approvals.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dialog, safeStorage, shell, systemPreferences, type BrowserWindow, type IpcMain } from "electron";
import { uiAttachPayload, type ApprovalPayload } from "@ate/approve";
import type { Res } from "../shared/bridge";
import { APPROVAL_RE, SETUP_GET_RE, SETUP_POST_RE, type ApprovalStart, type DaemonState, type SetupIpc, type SetupPath } from "../shared/setup-bridge";
import { signApproval } from "./approve";
import type { DaemonClient } from "./daemon";
import { DaemonSupervisor, ateHome } from "./lifecycle";

const err = <T>(message: string, code = "ATE_INTERNAL"): Res<T> => ({ ok: false, error: { code: code as never, message } });
const PK = /^0x[0-9a-fA-F]{64}$/;
const CODE = /^[0-9]{8}$/;
const OPEN_OK = /^https:\/\/(testnet-explorer\.hskchain\.net|hsk\.blockscout\.com|faucet\.hsk\.xyz|flowverse\.cloud|console\.anthropic\.com)\//;
/** Re-attaches after an app-initiated restart reuse the user's confirmation for this long (the code still flows). */
const CONFIRM_TTL_MS = 15 * 60_000;

/** ate-approve installed and its public key pinned → Touch ID signatures work for daemon approvals. */
function approveAvailable(): boolean {
  const bin = process.env.ATE_APPROVE_PATH ?? "/usr/local/libexec/ate/ate-approve";
  return existsSync(bin) && existsSync(join(homedir(), ".ate", "approve-pubkey.json"));
}
const canTouchId = (): boolean => process.platform === "darwin" && process.env.FLOW_TOUCH_ID !== "off" && systemPreferences.canPromptTouchID();

export function registerSetupIpc(o: { ipcMain: IpcMain; daemon: DaemonClient; appPath: string; win: () => BrowserWindow | null; fixtures: boolean }): { boot(): Promise<void>; shutdown(): Promise<void> } {
  const { daemon } = o;
  const sup = new DaemonSupervisor(o.appPath, () => {
    if (phase !== "stopped") setPhase("error", `daemon exited${sup.lastError ? `: ${sup.lastError}` : ""}`);
  });
  let phase: DaemonState["phase"] = "stopped";
  let detail = "";
  let pendingCode: { code: string | null; purpose: string; expiresAt: number; resolve: (c: string) => void } | null = null;
  let confirmedAt = 0;
  let fallbackOn = false;
  let status: { key?: { exists: boolean; unlocked: boolean; address: string | null }; state?: { step: number; completedAt: number | null } } | null = null;
  let booting: Promise<void> | null = null;
  const setPhase = (p: DaemonState["phase"], d = "") => {
    phase = p;
    detail = d;
  };
  const sealedPath = () => join(ateHome(), "flow-agent.sealed");
  const sealed = (): { keyId: string; blob: string } | null => {
    try {
      return JSON.parse(readFileSync(sealedPath(), "utf8")) as { keyId: string; blob: string };
    } catch {
      return null;
    }
  };

  const state = (): DaemonState => ({
    phase,
    owned: sup.owned,
    home: ateHome(),
    pid: sup.pid,
    port: daemon.connection().port ?? null,
    detail: detail || daemon.connection().detail || "",
    touchId: { approve: approveAvailable(), unlock: canTouchId() },
    code: pendingCode ? { code: pendingCode.code, purpose: pendingCode.purpose, expiresAt: pendingCode.expiresAt } : null,
    agent: status?.key ? { ...status.key, sealed: !!sealed() } : null,
    setupStep: status?.state?.step ?? null,
    setupDone: !!status?.state?.completedAt,
  });

  const nav = (hash: string) => void o.win()?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});

  /** The one-time code for a nonce: the daemon labels attach codes with the nonce prefix. */
  async function codeFor(match: (line: string) => boolean, since: number): Promise<string | null> {
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const c = [...sup.codes].reverse().find((x) => x.at >= since && x.code && match(x.line));
      if (c) return c.code;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  function ensureFallback(): void {
    if (!approveAvailable() && sup.owned && !fallbackOn) fallbackOn = sup.enableFallback();
  }

  // /ui/attach approval: Touch ID (ate-approve) or the daemon's one-time code, shown in-app.
  daemon.attacher = async (a) => {
    if (approveAvailable()) {
      const s = await signApproval(uiAttachPayload(a));
      if (s.ok) return s.signature;
      if (!s.unavailable) throw new Error(`Touch ID: ${s.message}`);
    }
    if (!sup.owned) throw new Error("Touch ID is unavailable and this daemon was started outside the app: use its terminal code or ATE_UI_TOKEN");
    const code = await codeFor((l) => l.includes(a.nonce.slice(0, 8)), Math.floor(Date.now() / 1000) - 5);
    if (!code) throw new Error("the daemon issued no one-time code (approval fallback is off)");
    if (Date.now() - confirmedAt < CONFIRM_TTL_MS) return code;
    setPhase("code", "Confirm this Mac with the one-time code");
    nav("#/unlock");
    const typed = await new Promise<string>((resolve) => (pendingCode = { code, purpose: "Connect Flow to its daemon", expiresAt: a.expiresAt, resolve }));
    pendingCode = null;
    confirmedAt = Date.now();
    setPhase("attaching");
    return typed;
  };

  async function refreshStatus(): Promise<void> {
    const r = await daemon.call<{ key: { exists: boolean; unlocked: boolean; address: string | null }; state: { step: number; completedAt: number | null } }>("GET", "/setup/status");
    if (r.ok) status = r.data;
  }

  async function unlockAgent(): Promise<Res<DaemonState>> {
    await refreshStatus();
    if (!status?.key?.exists) return { ok: true, data: state() };
    if (status.key.unlocked) return { ok: true, data: state() };
    const s = sealed();
    if (!s) return err("The agent key was created outside Flow; its passphrase is not sealed in this app.", "ATE_DAEMON_LOCKED");
    if (canTouchId()) {
      try {
        await systemPreferences.promptTouchID("unlock the Flow agent key");
      } catch {
        return err("Touch ID was cancelled", "ATE_APPROVAL_REQUIRED");
      }
    }
    setPhase("unlocking");
    let pass: string;
    try {
      pass = safeStorage.decryptString(Buffer.from(s.blob, "base64"));
    } catch (e) {
      setPhase("ready");
      return err(`keychain refused: ${(e as Error).message}`, "ATE_DAEMON_LOCKED");
    }
    const r = await daemon.call<{ address: string }>("POST", "/unlock", { passphrase: pass });
    pass = "";
    setPhase("ready");
    await refreshStatus();
    return r.ok ? { ok: true, data: state() } : (r as Res<never>);
  }

  async function connectAndUnlock(): Promise<void> {
    setPhase("starting");
    try {
      await sup.start();
    } catch (e) {
      setPhase("error", (e as Error).message);
      return;
    }
    ensureFallback();
    setPhase("attaching");
    daemon.resetToken();
    const info = await daemon.connect();
    if (info.mode !== "live") {
      setPhase("error", info.detail ?? "attach failed");
      return;
    }
    setPhase("ready");
    await unlockAgent().catch(() => undefined);
  }

  async function restart(): Promise<void> {
    setPhase("starting", "applying settings");
    daemon.close();
    fallbackOn = false;
    await sup.restart();
    await connectAndUnlock();
  }

  const boot = async () => {
    booting ??= connectAndUnlock().finally(() => (booting = null));
    await booting;
  };

  const passthrough = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Res<unknown>> => {
    const r = await daemon.call<Record<string, unknown>>(method, path, body);
    if (r.ok && r.data && (r.data as { restart?: boolean }).restart) await restart();
    if (r.ok && path.startsWith("/setup/state")) await refreshStatus();
    return r;
  };

  async function approveStart(path: string, body: unknown): Promise<Res<ApprovalStart>> {
    ensureFallback();
    const since = Math.floor(Date.now() / 1000) - 1;
    const r1 = await daemon.call<{ nonce?: string; expiresAt?: number; payload?: ApprovalPayload; codeIssued?: boolean; saved?: boolean }>("POST", path, body);
    if (!r1.ok) return r1 as Res<never>;
    if (r1.data.saved || !r1.data.nonce) return { ok: true, data: { nonce: "", expiresAt: 0, applied: true, result: r1.data } }; // first key during setup
    const { nonce, expiresAt, payload } = r1.data as { nonce: string; expiresAt: number; payload: ApprovalPayload };
    if (approveAvailable() && payload?.kind === "config" && nonce) {
      const s = await signApproval(payload);
      if (s.ok) {
        const r2 = await passthrough("POST", path, { nonce, approval: s.signature });
        return r2.ok ? { ok: true, data: { nonce, expiresAt, applied: true, result: r2.data } } : (r2 as Res<never>);
      }
    }
    const code = r1.data.codeIssued ? await codeFor(() => true, since) : null;
    if (!code) return err("Touch ID is unavailable and the daemon issued no one-time code", "ATE_APPROVAL_REQUIRED");
    return { ok: true, data: { nonce, expiresAt, code } };
  }

  const handlers: Partial<Record<SetupIpc, (a: any, b: any) => Promise<unknown>>> = {
    "setup.daemon": async () => {
      if (phase === "ready") await refreshStatus().catch(() => undefined);
      return state();
    },
    "setup.start": async () => {
      if (sup.owned && sup.running) await restart();
      else await boot();
      return state();
    },
    "setup.stop": async () => {
      setPhase("stopped", "stopped from the app");
      daemon.close();
      await sup.stop();
      return state();
    },
    "setup.submitCode": async (code: string) => {
      if (!pendingCode) return err("no code is pending");
      if (!CODE.test(String(code))) return err("enter the 8-digit code");
      pendingCode.resolve(String(code));
      for (let i = 0; i < 60 && (phase === "attaching" || phase === "code"); i++) await new Promise((r) => setTimeout(r, 250));
      return phase === "ready" || phase === "unlocking" ? { ok: true, data: state() } : err(detail || "attach failed", "ATE_APPROVAL_REQUIRED");
    },
    "setup.unlock": () => unlockAgent(),
    "setup.get": async (path: string, query?: Record<string, string>) => {
      if (!SETUP_GET_RE.test(String(path))) return err("path not allowed");
      const q = query && typeof query === "object" ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [String(k), String(v)]))}` : "";
      return daemon.call("GET", path + q);
    },
    "setup.post": async (path: string, body: unknown) => {
      if (!SETUP_POST_RE.test(String(path))) return err("path not allowed");
      return passthrough("POST", path, body);
    },
    "setup.keygen": async (privateKey?: string) => {
      if (privateKey !== undefined && privateKey !== null && !PK.test(String(privateKey))) return err("a private key is 0x followed by 64 hex characters");
      if (!safeStorage.isEncryptionAvailable()) return err("macOS keychain encryption is unavailable");
      if (canTouchId()) {
        try {
          await systemPreferences.promptTouchID(privateKey ? "import the Flow agent key" : "create the Flow agent key");
        } catch {
          return err("Touch ID was cancelled", "ATE_APPROVAL_REQUIRED");
        }
      }
      const passphrase = randomBytes(32).toString("base64url");
      const r = await daemon.call<{ address: string; store: string; keyId: string }>("POST", "/setup/keygen", { passphrase, ...(privateKey ? { privateKey } : {}) });
      if (r.ok) writeFileSync(sealedPath(), JSON.stringify({ keyId: r.data.keyId, blob: safeStorage.encryptString(passphrase).toString("base64") }), { mode: 0o600 });
      await refreshStatus();
      return r;
    },
    "setup.approveStart": (path: string, body: unknown) => (APPROVAL_RE.test(String(path)) ? approveStart(path, body) : Promise.resolve(err("path not allowed"))),
    "setup.approveFinish": async (path: string, nonce: string, code?: unknown) => {
      if (!APPROVAL_RE.test(String(path))) return err("path not allowed");
      if (!CODE.test(String(code))) return err("enter the 8-digit code");
      return passthrough("POST", path, { nonce: String(nonce), approval: String(code) });
    },
    "setup.open": async (url: string) => {
      if (OPEN_OK.test(String(url))) await shell.openExternal(String(url));
    },
    "setup.saveJson": async (name: string, data: unknown) => {
      const w = o.win();
      const r = w ? await dialog.showSaveDialog(w, { defaultPath: String(name).replace(/[^\w.-]/g, "_") }) : { canceled: true, filePath: undefined };
      if (r.canceled || !r.filePath) return err("cancelled");
      writeFileSync(r.filePath, JSON.stringify(data, null, 2));
      return { ok: true, data: { path: r.filePath } };
    },
  };
  /** User-run local proxy management API (CLIProxyAPI-style). Loopback or https only; the key stays in main. */
  handlers["setup.proxy"] = async (q: { baseURL?: string; mgmtKey?: string; op?: string; provider?: string; state?: string }) => {
    let u: URL;
    try {
      u = new URL(String(q?.baseURL ?? ""));
    } catch {
      return err("proxy base URL is not a URL");
    }
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) return err("proxy must be https or on this Mac");
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(q.provider ?? "x")) || !/^[A-Za-z0-9_.-]{0,200}$/.test(String(q.state ?? ""))) return err("bad parameters");
    const base = `${u.origin}/v8/management`;
    const path = q.op === "accounts" ? "/auth-files" : q.op === "auth-url" ? `/oauth/auth-url?provider=${q.provider}` : q.op === "status" ? `/oauth/status${q.state ? `?state=${q.state}` : ""}` : null;
    if (!path) return err("bad op");
    try {
      const r = await fetch(base + path, { headers: { authorization: `Bearer ${String(q.mgmtKey ?? "")}` }, signal: AbortSignal.timeout(8000) });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) return err(`proxy answered HTTP ${r.status}`);
      if (q.op === "auth-url") {
        const url = String(j.url ?? j.auth_url ?? "");
        if (/^https:\/\//.test(url)) await shell.openExternal(url);
        else return err("the proxy returned no login link");
      }
      return { ok: true, data: j };
    } catch (e) {
      return err(`proxy unreachable: ${(e as Error).message}`);
    }
  };
  for (const [ch, fn] of Object.entries(handlers)) {
    // approveFinish takes three arguments; every other handler two.
    o.ipcMain.handle(`ate:${ch}`, (_e, a, b, c) => (o.fixtures ? err("fixtures mode") : ch === "setup.approveFinish" ? (fn as (a: unknown, b: unknown, c: unknown) => Promise<unknown>)(a, b, c) : fn(a, b)));
  }
  return {
    boot,
    shutdown: async () => {
      setPhase("stopped");
      daemon.close();
      if (sup.owned) await sup.stop();
    },
  };
}

export type { SetupPath };
