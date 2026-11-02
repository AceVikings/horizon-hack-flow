// `ate chat` ↔ running daemon (SPEC §10.1, §11.5). Not a command (leading `_`): helpers for chat.ts.
//
//   1. runtime.json (ATE_HOME or ~/.ate) → port + agent token
//   2. POST /chat/session {} → { sessionId, nonce, expiresAt }; sign chatSessionPayload with ate-approve (Touch ID),
//      or — when the helper is unavailable — ask for the 8-digit code printed on the daemon's TTY (armed fallback)
//   3. POST /chat/session { sessionId, nonce, approval } → session handle; POST /chat/token → the session's chat token
//   4. MCP = `ate mcp serve` (the daemon's bin) with ATE_MCP_TOKEN = chat token → chat-scoped stdio proxy
//   5. Loosening changes (ATE_APPROVAL_REQUIRED) → POST /strategy/approve with the session handle
//
// Tokens live only in memory and in the proxy's environment; nothing here prints or writes them.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatSessionStep1Response, ChatSessionStep2Response, RuntimeJson, StrategyApprovalPending, StrategyApproveResponse } from "@ate/core";
import { ApproveError, chatSessionPayload, createApproveClient, strategyPayload, type ApprovalPayload } from "@ate/approve";

export const TTY_CODE = /^\d{8}$/;

export function ateHomeDir(env: NodeJS.ProcessEnv): string {
  return env.ATE_HOME ?? join(homedir(), ".ate");
}

export function readRuntimeJson(env: NodeJS.ProcessEnv): RuntimeJson {
  const p = join(ateHomeDir(env), "runtime.json");
  let rt: RuntimeJson;
  try {
    rt = JSON.parse(readFileSync(p, "utf8")) as RuntimeJson;
  } catch {
    throw new Error(`daemon not running (no ${p}); start it with \`ate daemon start\`, or use --stub`);
  }
  if (!rt.port || !rt.agentToken) throw new Error(`${p} is incomplete`);
  return rt;
}

export class DaemonHttpError extends Error {
  override name = "DaemonHttpError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface DaemonConn {
  base: string;
  fetchImpl?: typeof fetch;
}

/** POST JSON with a bearer; errors (`{error:{code,message}}`, `{ok:false,error}`, `{error:"…"}`) become DaemonHttpError. */
export async function daemonPost<T>(c: DaemonConn, path: string, body: unknown, token: string): Promise<T> {
  return daemonReq<T>(c, "POST", path, token, body);
}

export async function daemonReq<T>(c: DaemonConn, method: "GET" | "POST", path: string, token: string, body?: unknown): Promise<T> {
  const res = await (c.fetchImpl ?? fetch)(c.base + path, {
    method,
    headers: { "content-type": "application/json", origin: "ate://local", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let j: any;
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { error: text.slice(0, 200) };
  }
  if (!res.ok || j?.ok === false) {
    const e = j?.error;
    const code = typeof e === "object" && e ? String(e.code ?? "ATE_INTERNAL") : res.status === 401 ? "ATE_APPROVAL_REQUIRED" : "ATE_INTERNAL";
    const msg = typeof e === "object" && e ? String(e.message ?? code) : String(e ?? `HTTP ${res.status}`);
    throw new DaemonHttpError(res.status, code, `${method} ${path} → ${res.status} ${code}: ${msg}`, typeof e === "object" ? e?.details : undefined);
  }
  return (j && typeof j === "object" && "ok" in j && "data" in j ? j.data : j) as T;
}

// ---------------------------------------------------------------- approvals

export interface ApprovalIo {
  /** Ask the user one line (prompt shown on stderr). */
  ask(question: string): Promise<string>;
  log(line: string): void;
}

/** Touch ID signer; defaults to Lane E's ate-approve client ($ATE_APPROVE_PATH or /usr/local/libexec/ate/ate-approve). */
export type Signer = (p: ApprovalPayload) => Promise<string>;

export const defaultSigner: Signer = async (p) => (await createApproveClient().sign(p)).signature;

/** Helper-side failures that mean "no Secure Enclave signature possible here" (→ TTY code), not "the user said no". */
const UNAVAILABLE = new Set(["not_installed", "unavailable", "no_key", "keychain", "internal", "usage"]);

/**
 * ate-approve signature first; when the helper is unavailable and `allowTty`, the 8-digit code the daemon printed on
 * its own terminal (§10.1 armed fallback). Denied / timed-out prompts are final.
 */
export async function obtainApproval(payload: ApprovalPayload, o: { signer?: Signer; allowTty: boolean; io: ApprovalIo; what: string }): Promise<string> {
  try {
    o.io.log(`Touch ID: approve ${o.what} (ate-approve)…`);
    return await (o.signer ?? defaultSigner)(payload);
  } catch (e) {
    const code = e instanceof ApproveError ? e.code : "internal";
    if (!UNAVAILABLE.has(code) || !o.allowTty) throw new Error(`approval for ${o.what} failed: ${(e as Error).message}`);
    o.io.log(`ate-approve unavailable (${code}). If the daemon runs with --approval-fallback=armed and \`approval-fallback enable\` was typed on its terminal, it printed an 8-digit code there.`);
    const c = (await o.io.ask(`8-digit code for ${o.what} (empty to cancel): `)).trim();
    if (!c) throw new Error(`approval for ${o.what} cancelled`);
    if (!TTY_CODE.test(c)) throw new Error("expected an 8-digit code");
    return c;
  }
}

// ---------------------------------------------------------------- session

export interface ChatDaemonSession {
  rt: RuntimeJson;
  conn: DaemonConn;
  home: string;
  sessionId: string;
  /** `session` handle: /chat, /chat/token, /strategy/approve for this session only. */
  sessionToken: string;
  chatToken: string;
  expiresAt: number;
}

export async function openChatSession(o: { env: NodeJS.ProcessEnv; io: ApprovalIo; signer?: Signer; fetchImpl?: typeof fetch }): Promise<ChatDaemonSession> {
  const rt = readRuntimeJson(o.env);
  const conn: DaemonConn = { base: `http://127.0.0.1:${rt.port}`, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) };
  const s1 = await daemonPost<ChatSessionStep1Response>(conn, "/chat/session", {}, rt.agentToken);
  const approval = await obtainApproval(chatSessionPayload(s1), { allowTty: true, io: o.io, what: `chat session ${s1.sessionId}`, ...(o.signer ? { signer: o.signer } : {}) });
  const s2 = await daemonPost<ChatSessionStep2Response>(conn, "/chat/session", { sessionId: s1.sessionId, nonce: s1.nonce, approval }, rt.agentToken);
  const ct = await daemonPost<{ token: string; expiresAt: number }>(conn, "/chat/token", {}, s2.sessionToken);
  return { rt, conn, home: ateHomeDir(o.env), sessionId: s2.sessionId, sessionToken: s2.sessionToken, chatToken: ct.token, expiresAt: Math.min(s2.expiresAt, ct.expiresAt) };
}

/** Absolute path of @ate/daemon's dist/bin.js (the `ate-daemon` bin; `mcp serve` = stdio proxy). */
export function resolveDaemonBin(): string {
  // Walk the node_modules lookup paths (the package exports only "import", so require.resolve can't be used).
  for (const dir of createRequire(import.meta.url).resolve.paths("@ate/daemon") ?? []) {
    const pkg = join(dir, "@ate", "daemon");
    if (existsSync(join(pkg, "package.json"))) return join(realpathSync(pkg), "dist", "bin.js");
  }
  throw new Error("@ate/daemon is not installed next to @ate/cli; pass --mcp-command instead");
}

/** Chat-scoped stdio proxy: the chat token travels only in the child's environment. */
export function chatMcpSpec(s: Pick<ChatDaemonSession, "home" | "chatToken">, bin = resolveDaemonBin()) {
  return { command: process.execPath, args: [bin, "mcp", "serve"], env: { ATE_MCP_TOKEN: s.chatToken, ATE_HOME: s.home } };
}

// ---------------------------------------------------------------- loosening approvals

export function isPending(x: unknown): x is StrategyApprovalPending {
  const d = x as StrategyApprovalPending;
  return !!d && typeof d.changeId === "string" && Array.isArray(d.diff) && typeof d.expiresAt === "number";
}

/** Pending changeIds (`chg_<16 hex>`, daemon-issued) mentioned in an agent reply. */
export function changeIdsIn(text: string): string[] {
  return [...new Set(text.match(/\bchg_[0-9a-f]{16}\b/g) ?? [])];
}

/**
 * Best effort: the pending change's details for a changeId we only saw in text (LLM path). Needs a daemon route
 * `GET /strategy/pending/:changeId`; when absent the caller degrades to a TTY code (which needs only the changeId).
 */
export async function fetchPending(s: Pick<ChatDaemonSession, "conn" | "sessionToken">, changeId: string): Promise<StrategyApprovalPending | null> {
  try {
    const d = await daemonReq<unknown>(s.conn, "GET", `/strategy/pending/${encodeURIComponent(changeId)}`, s.sessionToken);
    return isPending(d) ? d : null;
  } catch {
    return null;
  }
}

export async function approveStrategyChange(
  s: Pick<ChatDaemonSession, "conn" | "sessionToken">,
  p: { changeId: string; details: StrategyApprovalPending | null },
  o: { io: ApprovalIo; signer?: Signer },
): Promise<StrategyApproveResponse> {
  let approval: string;
  if (p.details) {
    approval = await obtainApproval(strategyPayload(p.details), { allowTty: true, io: o.io, what: `strategy change ${p.changeId}`, ...(o.signer ? { signer: o.signer } : {}) });
  } else {
    o.io.log("The diff for this change is not available to sign here; use the 8-digit code from the daemon's terminal (armed fallback).");
    const c = (await o.io.ask(`8-digit code for strategy change ${p.changeId} (empty to skip): `)).trim();
    if (!c) throw new Error("skipped");
    if (!TTY_CODE.test(c)) throw new Error("expected an 8-digit code");
    approval = c;
  }
  return daemonPost<StrategyApproveResponse>(s.conn, "/strategy/approve", { changeId: p.changeId, approval }, s.sessionToken);
}
