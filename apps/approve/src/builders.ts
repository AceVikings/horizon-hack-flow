// Deterministic payload builders shared by the requester (Electron main, `ate chat`, ate-pay UI) and the
// verifier (daemon, ate-pay). Both sides build the same payload from the same server-issued data, so the
// verifier never trusts caller-supplied payload bytes.
import type { StrategyApprovalPending } from "@ate/core";
import {
  APPROVAL_PAYLOAD_VERSION,
  type ChatSessionApproval,
  type ConfigApproval,
  type ConfigApprovalBody,
  type PaymentApproval,
  type PaymentApprovalBody,
  type StrategyApproval,
  type TradeApproval,
  type TradeApprovalBody,
  type UiAttachApproval,
} from "./payload.js";

/** All daemon nonces live 60 s (§10.1); issuedAt is derived so both sides agree without a clock exchange. */
export const APPROVAL_TTL_SEC = 60;

export function uiAttachPayload(a: { nonce: string; expiresAt: number; pid: number; port: number }): UiAttachApproval {
  return {
    v: APPROVAL_PAYLOAD_VERSION,
    kind: "ui_attach",
    aud: "ate-daemon",
    nonce: a.nonce,
    issuedAt: a.expiresAt - APPROVAL_TTL_SEC,
    expiresAt: a.expiresAt,
    body: { pid: a.pid, port: a.port },
  };
}

export function chatSessionPayload(a: { sessionId: string; nonce: string; expiresAt: number }): ChatSessionApproval {
  return {
    v: APPROVAL_PAYLOAD_VERSION,
    kind: "chat_session",
    aud: "ate-daemon",
    nonce: a.nonce,
    issuedAt: a.expiresAt - APPROVAL_TTL_SEC,
    expiresAt: a.expiresAt,
    body: { sessionId: a.sessionId },
  };
}

/** From the `error.details` of ATE_APPROVAL_REQUIRED (§11.5): signs every field before → after. */
export function strategyPayload(p: Pick<StrategyApprovalPending, "changeId" | "diff" | "expiresAt">): StrategyApproval {
  return {
    v: APPROVAL_PAYLOAD_VERSION,
    kind: "strategy",
    aud: "ate-daemon",
    nonce: p.changeId,
    issuedAt: p.expiresAt - APPROVAL_TTL_SEC,
    expiresAt: p.expiresAt,
    body: {
      changeId: p.changeId,
      changes: p.diff.map((c) => ({ scope: String(c.scope), field: String(c.field), before: c.before ?? null, after: c.after ?? null })),
    },
  };
}

export function tradePayload(a: { nonce: string; expiresAt: number } & TradeApprovalBody): TradeApproval {
  const { nonce, expiresAt, ...body } = a;
  return { v: APPROVAL_PAYLOAD_VERSION, kind: "trade", aud: "ate-daemon", nonce, issuedAt: expiresAt - APPROVAL_TTL_SEC, expiresAt, body };
}

/** Payment approvals (#1 sign, #2 submit) are verified by ate-pay; window = 120 s (§9.4). */
export const PAYMENT_APPROVAL_TTL_SEC = 120;

export function paymentPayload(a: { issuedAt: number; body: PaymentApprovalBody }): PaymentApproval {
  return {
    v: APPROVAL_PAYLOAD_VERSION,
    kind: "payment",
    aud: "ate-pay",
    nonce: `${a.body.paymentId}:${a.body.stage}`,
    issuedAt: a.issuedAt,
    expiresAt: a.issuedAt + PAYMENT_APPROVAL_TTL_SEC,
    body: a.body,
  };
}

/** Settings save (desktop, Flow 90): every changed config key before → after, bound to a daemon nonce. */
export function configPayload(a: { nonce: string; expiresAt: number; changes: ConfigApprovalBody["changes"] }): ConfigApproval {
  return {
    v: APPROVAL_PAYLOAD_VERSION,
    kind: "config",
    aud: "ate-daemon",
    nonce: a.nonce,
    issuedAt: a.expiresAt - APPROVAL_TTL_SEC,
    expiresAt: a.expiresAt,
    body: { changes: a.changes },
  };
}
