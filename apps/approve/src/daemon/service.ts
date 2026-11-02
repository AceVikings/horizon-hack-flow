// Daemon approval endpoints (SPEC §10.1, §11.5): POST /ui/attach, POST /chat/session, POST /strategy/approve.
// Framework-agnostic: each handler takes the parsed JSON body and the caller's token scope and returns
// `{ status, body }`. Lane B mounts them (see routes.ts and apps/daemon/src/approval/index.ts).
import { randomBytes } from "node:crypto";
import type {
  ChatSessionStep1Response,
  ChatSessionStep2Response,
  StrategyApprovalPending,
  StrategyApproveResponse,
  TokenScope,
  UiAttachStep1Response,
  UiAttachStep2Response,
} from "@ate/core";
import { chatSessionPayload, strategyPayload, uiAttachPayload } from "../builders.js";
import type { ApprovalPayload } from "../payload.js";
import type { ApprovalVerifier } from "../verify.js";
import { NonceStore, RateLimiter } from "./nonces.js";
import { TTY_CODE_RE, TtyFallback, type TtyPurpose } from "./tty.js";

export type ApprovalMethod = "secure-enclave" | "tty" | "token";

export interface ApprovalJournalEvent {
  purpose: TtyPurpose;
  method: ApprovalMethod;
  /** nonce / sessionId / changeId — never the code or the signature. */
  ref: string;
  keyId?: string;
}

export interface ApprovalServiceDeps {
  pid: number;
  port: number;
  /** null when no approval key is pinned yet (only the TTY fallback can then work). */
  verifier: ApprovalVerifier | null;
  tty: TtyFallback;
  /** Mints a fresh in-memory `ui` token (32 random bytes). */
  mintUiToken: () => string;
  /** Mints the `session` handle for one `ate chat` session (and the daemon's `chat` token behind it). */
  mintSessionToken: (sessionId: string) => { token: string; expiresAt: number };
  /** Pending loosening change created by `ate_strategy_set` (ATE_APPROVAL_REQUIRED), or undefined. */
  getPendingStrategyChange: (changeId: string) => StrategyApprovalPending | undefined;
  /** Applies it (journals `strategy_change`, triggers /cycle). Called at most once per changeId. */
  applyStrategyChange: (changeId: string, approval: { method: ApprovalMethod; keyId?: string }) => Promise<StrategyApproveResponse>;
  /** Journal hook: every approval use, incl. `approval=tty` (§10.1). */
  journalApproval?: (e: ApprovalJournalEvent) => void;
  now?: () => number;
}

export interface HandlerResult<T = unknown> {
  status: number;
  body: T | { ok: false; error: { code: string; message: string } };
}

const err = (status: number, code: string, message: string): HandlerResult<never> => ({
  status,
  body: { ok: false, error: { code, message } },
});

const isStr = (x: unknown, max = 256): x is string => typeof x === "string" && x.length > 0 && x.length <= max;

export class ApprovalService {
  private readonly now: () => number;
  private readonly attachNonces: NonceStore;
  private readonly sessionNonces: NonceStore<{ sessionId: string }>;
  private readonly attachLimiter: RateLimiter;
  private readonly applied = new Set<string>();

  constructor(private readonly d: ApprovalServiceDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.attachNonces = new NonceStore(this.now);
    this.sessionNonces = new NonceStore(this.now);
    this.attachLimiter = new RateLimiter(this.now, 5);
  }

  get tty(): TtyFallback {
    return this.d.tty;
  }

  /** Signature first, TTY code second (only where §10.1 allows it). */
  private check(payload: ApprovalPayload, purpose: TtyPurpose, approval: string): { ok: true; method: ApprovalMethod; keyId?: string } | { ok: false; status: number; code: string; message: string } {
    if (TTY_CODE_RE.test(approval)) {
      const r = this.d.tty.redeem(purpose, payload.nonce, approval);
      if (r.ok) return { ok: true, method: "tty" };
      return { ok: false, status: 401, code: "ATE_APPROVAL_REQUIRED", message: `TTY code rejected (${r.reason})` };
    }
    if (!this.d.verifier) return { ok: false, status: 401, code: "ATE_APPROVAL_REQUIRED", message: "no approval key pinned; run `ate-approve pubkey` setup" };
    const v = this.d.verifier.verify(payload, approval, this.now());
    if (!v.ok) return { ok: false, status: 401, code: "ATE_APPROVAL_REQUIRED", message: `approval signature rejected (${v.reason})` };
    // A real Secure Enclave approval verified end-to-end: the TTY degradation switches itself off.
    this.d.tty.markApproveGreen();
    return { ok: true, method: "secure-enclave", keyId: this.d.verifier.keyId };
  }

  private journal(purpose: TtyPurpose, method: ApprovalMethod, ref: string, keyId?: string): void {
    this.d.journalApproval?.({ purpose, method, ref, ...(keyId ? { keyId } : {}) });
  }

  /**
   * POST /ui/attach. Step 1 `{}` (the only unauthenticated route; 5 req/min) → `{ nonce, expiresAt }`.
   * Step 2 `{ nonce, approval }` → a fresh `ui` token.
   */
  async uiAttach(body: unknown): Promise<HandlerResult<UiAttachStep1Response | UiAttachStep2Response>> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (Object.keys(b).length === 0) {
      if (!this.attachLimiter.allow()) return err(429, "ATE_RPC_RATE_LIMITED", "ui attach: 5 nonces per minute");
      const n = this.attachNonces.issue(undefined);
      this.d.tty.issue("ui_attach", n.nonce, `UI attach (nonce ${n.nonce.slice(0, 8)}…)`);
      return { status: 200, body: { nonce: n.nonce, expiresAt: n.expiresAt } };
    }
    if (!isStr(b.nonce, 64) || !isStr(b.approval, 200)) return err(400, "ATE_APPROVAL_REQUIRED", "expected { nonce, approval }");
    const n = this.attachNonces.take(b.nonce);
    if (n === undefined) return err(404, "ATE_APPROVAL_REQUIRED", "unknown or used nonce");
    if (n === "expired") return err(410, "ATE_APPROVAL_REQUIRED", "nonce expired");
    const payload = uiAttachPayload({ nonce: n.nonce, expiresAt: n.expiresAt, pid: this.d.pid, port: this.d.port });
    const c = this.check(payload, "ui_attach", b.approval);
    if (!c.ok) return err(c.status, c.code, c.message);
    this.journal("ui_attach", c.method, n.nonce, c.keyId);
    return { status: 200, body: { uiToken: this.d.mintUiToken() } };
  }

  /**
   * POST /chat/session. Step 1 `{}` → `{ sessionId, nonce, expiresAt }`.
   * Step 2 `{ sessionId, nonce, approval }` → `session` handle for that session only.
   */
  async chatSession(body: unknown, scope: TokenScope | null): Promise<HandlerResult<ChatSessionStep1Response | ChatSessionStep2Response>> {
    if (scope !== "agent" && scope !== "ui") return err(403, "ATE_TOOL_NOT_ALLOWED", "chat session requires the agent or ui token");
    const b = (body ?? {}) as Record<string, unknown>;
    if (Object.keys(b).length === 0) {
      // Flow v1 policy: opening a chat session needs no Touch ID. The chat scope's server-enforced allowlist is the
      // protection (chat can never execute, raise a limit or move funds); loosening changes still need a signature.
      // The holder of an agent/ui token gets the session handle directly. Step 2 (signature) stays for old clients.
      const sessionId = `chat_${randomBytes(8).toString("hex")}`;
      const n = this.sessionNonces.issue({ sessionId });
      const t = this.d.mintSessionToken(sessionId);
      this.journal("chat_session", "token", sessionId);
      return { status: 200, body: { sessionId, nonce: n.nonce, expiresAt: n.expiresAt, sessionToken: t.token, sessionExpiresAt: t.expiresAt } as ChatSessionStep1Response };
    }
    if (!isStr(b.sessionId, 64) || !isStr(b.nonce, 64) || !isStr(b.approval, 200)) {
      return err(400, "ATE_APPROVAL_REQUIRED", "expected { sessionId, nonce, approval }");
    }
    const n = this.sessionNonces.take(b.nonce);
    if (n === undefined) return err(404, "ATE_APPROVAL_REQUIRED", "unknown or used nonce");
    if (n === "expired") return err(410, "ATE_APPROVAL_REQUIRED", "nonce expired");
    if (n.meta.sessionId !== b.sessionId) return err(400, "ATE_APPROVAL_REQUIRED", "sessionId does not match nonce");
    const payload = chatSessionPayload({ sessionId: n.meta.sessionId, nonce: n.nonce, expiresAt: n.expiresAt });
    const c = this.check(payload, "chat_session", b.approval);
    if (!c.ok) return err(c.status, c.code, c.message);
    this.journal("chat_session", c.method, n.meta.sessionId, c.keyId);
    const t = this.d.mintSessionToken(n.meta.sessionId);
    return { status: 200, body: { sessionId: n.meta.sessionId, sessionToken: t.token, expiresAt: t.expiresAt } };
  }

  /**
   * Lane B calls this when `ate_strategy_set` returns ATE_APPROVAL_REQUIRED, so a TTY code can be printed
   * under the degradation. Harmless (no-op) when the fallback is disabled.
   */
  onStrategyPending(p: StrategyApprovalPending): void {
    this.d.tty.issue("strategy", p.changeId, `strategy change ${p.changeId}: ${p.renderedDiff.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  /** POST /strategy/approve `{ changeId, approval }` (ui or session scope; §11.5). */
  async strategyApprove(body: unknown, scope: TokenScope | null): Promise<HandlerResult<StrategyApproveResponse>> {
    if (scope !== "ui" && scope !== "session") return err(403, "ATE_TOOL_NOT_ALLOWED", "strategy approval requires the ui or session token");
    const b = (body ?? {}) as Record<string, unknown>;
    if (!isStr(b.changeId, 80) || !isStr(b.approval, 200)) return err(400, "ATE_APPROVAL_REQUIRED", "expected { changeId, approval }");
    if (this.applied.has(b.changeId)) return err(409, "ATE_APPROVAL_REQUIRED", "change already applied");
    const p = this.d.getPendingStrategyChange(b.changeId);
    if (!p) return err(404, "ATE_APPROVAL_REQUIRED", "unknown change");
    if (this.now() > p.expiresAt) return err(410, "ATE_APPROVAL_REQUIRED", "pending change expired (TTL 60 s); re-issue ate_strategy_set");
    const c = this.check(strategyPayload(p), "strategy", b.approval);
    if (!c.ok) return err(c.status, c.code, c.message);
    this.applied.add(b.changeId);
    this.journal("strategy", c.method, b.changeId, c.keyId);
    const res = await this.d.applyStrategyChange(b.changeId, { method: c.method, ...(c.keyId ? { keyId: c.keyId } : {}) });
    return { status: 200, body: res };
  }
}
