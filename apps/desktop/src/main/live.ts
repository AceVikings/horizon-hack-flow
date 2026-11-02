// Live approval flows in main (SPEC §10.1, §11.5, FREEZE-NOTES L.5). Signatures come from ate-approve (Touch ID);
// payloads are rebuilt from daemon/worker-issued data with Lane E's builders, never from renderer input.
import type { StrategyApprovalPending, StrategyApproveResponse } from "@ate/core";
import { decodePayload, renderReason, strategyPayload, tradePayload, type ApprovalPayload, type TradeApprovalBody as TB } from "@ate/approve";
import type { PaymentRow, PaymentsList, Res } from "../shared/bridge";
import type { DaemonClient } from "./daemon";
import { signApproval } from "./approve";

const TTY_CODE = /^\d{8}$/;
const err = <T>(code: string, message: string, hint?: string): Res<T> => ({ ok: false, error: { code: code as never, message, ...(hint ? { hint } : {}) } });

// ---------------------------------------------------------------- confirm-mode trades

/** Two-step POST /trade/approve: daemon nonce + trade body → ate-approve over tradePayload → approved (human). */
export async function approveTrade(d: DaemonClient, proposalId: string): Promise<Res<{ approved: true }>> {
  const s1 = await d.call<{ nonce: string; expiresAt: number; body: TB }>("POST", "/trade/approve", { proposalId });
  if (!s1.ok) return s1;
  const sig = await signApproval(tradePayload({ nonce: s1.data.nonce, expiresAt: s1.data.expiresAt, ...s1.data.body }));
  if (!sig.ok) {
    return err("ATE_APPROVAL_REQUIRED", `Touch ID approval failed (${sig.code}): ${sig.message}`, sig.unavailable ? "confirm-mode trades need ate-approve; TTY codes are not accepted (§10.1)" : undefined);
  }
  const s2 = await d.call<{ proposalId: string; status: string }>("POST", "/trade/approve", { proposalId, nonce: s1.data.nonce, approval: sig.signature });
  return s2.ok ? { ok: true, data: { approved: true } } : s2;
}

// ---------------------------------------------------------------- loosening strategy changes

/** Pending loosening changes seen by main (from strategy.set, chat.tool results, or the daemon). */
export const pendingChanges = new Map<string, StrategyApprovalPending>();

export function rememberPending(x: unknown): void {
  const d = x as StrategyApprovalPending;
  if (d && typeof d.changeId === "string" && Array.isArray(d.diff) && typeof d.expiresAt === "number") pendingChanges.set(d.changeId, d);
}

export async function approveStrategy(d: DaemonClient, changeId: string, ttyCode?: string): Promise<Res<StrategyApproveResponse>> {
  if (typeof changeId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(changeId)) return err("ATE_APPROVAL_REQUIRED", "bad changeId");
  let approval: string;
  if (ttyCode !== undefined && ttyCode !== null && ttyCode !== "") {
    if (!TTY_CODE.test(String(ttyCode))) return err("ATE_APPROVAL_REQUIRED", "expected the 8-digit code printed on the daemon's terminal");
    approval = String(ttyCode);
  } else {
    let p = pendingChanges.get(changeId) ?? null;
    if (!p) {
      // Best effort (needs a daemon route): chat-originated changes reach main only as a changeId in the reply text.
      const r = await d.call<StrategyApprovalPending>("GET", `/strategy/pending/${encodeURIComponent(changeId)}`);
      if (r.ok) rememberPending(r.data);
      p = pendingChanges.get(changeId) ?? null;
    }
    if (!p) return err("ATE_APPROVAL_REQUIRED", "The diff for this change is not available to sign here.", "Enter the 8-digit code from the daemon's terminal (--approval-fallback=armed), or re-issue the change from the Agents view.");
    const sig = await signApproval(strategyPayload(p));
    if (!sig.ok) {
      return err("ATE_APPROVAL_REQUIRED", `Touch ID approval failed (${sig.code}): ${sig.message}`, sig.unavailable ? "ate-approve is unavailable: enter the 8-digit code printed on the daemon's terminal (armed fallback)." : undefined);
    }
    approval = sig.signature;
  }
  const r = await d.call<StrategyApproveResponse>("POST", "/strategy/approve", { changeId, approval });
  if (r.ok) pendingChanges.delete(changeId);
  return r;
}

// ---------------------------------------------------------------- payments (ate-pay worker API, FREEZE-NOTES L.5)

interface WorkerPayment {
  id: string;
  state: string;
  offerId: string;
  createdAt: number;
  gatewayTx?: string;
  offer?: { offerId: string; priceUsd: string; payTo: string };
  approvalRequest: { stage: "sign" | "submit"; payload: string; prompt: string; expiresAt: number } | null;
}

export function payConfig(): { url: string; token: string } | null {
  const url = process.env.ATE_PAY_URL?.replace(/\/+$/, "");
  const token = process.env.ATE_PAY_TOKEN;
  return url && token ? { url, token } : null;
}

const NOT_CONFIGURED = "ate-pay is not configured: set ATE_PAY_URL (e.g. the SSM-forwarded worker, http://127.0.0.1:8790) and ATE_PAY_TOKEN (worker bearer) before starting the app.";

async function pay<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Res<T>> {
  const c = payConfig();
  if (!c) return err("ATE_PAYMENT_UNAVAILABLE", NOT_CONFIGURED);
  try {
    const res = await fetch(c.url + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: { code?: string; message?: string } };
    if (!res.ok || j.ok === false) return err(j.error?.code ?? "ATE_PAYMENT_UNAVAILABLE", j.error?.message ?? `ate-pay HTTP ${res.status}`);
    return { ok: true, data: j.data as T };
  } catch (e) {
    return err("ATE_PAYMENT_UNAVAILABLE", `ate-pay unreachable: ${(e as Error).message}`);
  }
}

function row(p: WorkerPayment): PaymentRow {
  let digest: string | undefined;
  let prompt: string | undefined;
  if (p.approvalRequest) {
    try {
      const pl = decodePayload(p.approvalRequest.payload);
      if (pl.kind === "payment") digest = pl.body.typedDataDigest;
      prompt = renderReason(pl);
    } catch {
      prompt = undefined;
    }
  }
  return {
    paymentId: p.id,
    state: p.state,
    amountUsd: p.offer?.priceUsd ?? "0",
    payTo: p.offer?.payTo ?? "",
    offerId: p.offerId,
    at: p.createdAt,
    ...(p.approvalRequest ? { needsApproval: p.approvalRequest.stage === "sign" ? (1 as const) : (2 as const) } : {}),
    ...(p.gatewayTx ? { gatewayTx: p.gatewayTx } : {}),
    ...(prompt ? { approvalPrompt: prompt } : {}),
    ...(digest ? { digest } : {}),
  };
}

export async function listPayments(fallback: PaymentsList): Promise<Res<PaymentsList>> {
  if (!payConfig()) return { ok: true, data: fallback };
  const r = await pay<WorkerPayment[]>("GET", "/payments");
  return r.ok ? { ok: true, data: { gate: "go", rows: r.data.map(row) } } : r;
}

/** Re-reads the worker's approval request, checks the digest the user saw, signs the decoded payload, posts it. */
export async function approvePayment(id: string, digest: string): Promise<Res<{ approved: true }>> {
  if (!/^pay_[0-9a-f]{16}$/.test(String(id))) return err("ATE_PAYMENT_DENIED", "bad payment id");
  const g = await pay<WorkerPayment>("GET", `/payments/${id}`);
  if (!g.ok) return g;
  const req = g.data.approvalRequest;
  if (!req) return err("ATE_PAYMENT_DENIED", `payment ${id} is ${g.data.state}; nothing awaits approval`);
  let payload: ApprovalPayload;
  try {
    payload = decodePayload(req.payload);
  } catch (e) {
    return err("ATE_PAYMENT_CONDITIONS_INVALID", `worker approval payload invalid: ${(e as Error).message}`);
  }
  if (payload.kind !== "payment" || payload.aud !== "ate-pay") return err("ATE_PAYMENT_CONDITIONS_INVALID", "not a payment approval");
  if (digest && digest !== payload.body.typedDataDigest) return err("ATE_PAYMENT_ORDER_MISMATCH", "the typed-data digest changed since it was shown; review it again");
  const sig = await signApproval(payload);
  if (!sig.ok) return err("ATE_PAYMENT_DENIED", `Touch ID approval failed (${sig.code}): ${sig.message}`, "Payments accept only an ate-approve signature (no TTY codes, §10.1).");
  const r = await pay<WorkerPayment>("POST", `/payments/${id}/approve`, { stage: req.stage, approval: sig.signature });
  return r.ok ? { ok: true, data: { approved: true } } : r;
}

export async function denyPayment(id: string): Promise<Res<{ denied: true }>> {
  if (!/^pay_[0-9a-f]{16}$/.test(String(id))) return err("ATE_PAYMENT_DENIED", "bad payment id");
  const g = await pay<WorkerPayment>("GET", `/payments/${id}`);
  if (!g.ok) return g;
  const stage = g.data.approvalRequest?.stage;
  if (!stage) return err("ATE_PAYMENT_DENIED", `payment ${id} is ${g.data.state}; nothing awaits approval`);
  const r = await pay<WorkerPayment>("POST", `/payments/${id}/deny`, { stage });
  return r.ok ? { ok: true, data: { denied: true } } : r;
}
