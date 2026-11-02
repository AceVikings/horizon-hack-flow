// Settlement state machine (SPEC §9.4). The transition table is data; `transition` is pure.
import { AteError } from "@ate/core";

export const PAYMENT_STATES = [
  "CREATED",
  "PREPARED",
  "SIGN_APPROVED",
  "SIGNED",
  "AUTH_FINALIZED",
  "SUBMIT_APPROVED",
  "SUBMITTED",
  "UNCERTAIN",
  "SAFE",
  "SETTLED",
  "SETTLED_UNATTRIBUTED",
  "EXPIRED",
  "FAILED",
  "FAILED_DENIED",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const PAYMENT_EVENTS = [
  "prepared", // prepare_payment ok (conditions + order verified, cap reserved before)
  "sign_approved", // human approval #1 (signed, digest-bound)
  "sign_denied", // approval #1 denied or timed out (120 s)
  "signed", // OKX / fallback signer signed the typed data
  "finalized", // finalize_payment ok (JWT server-side)
  "submit_approved", // estimate_fee + human approval #2
  "submit_denied", // approval #2 denied or timed out (120 s)
  "submit_ok", // submit_payment ok
  "submit_uncertain", // submit_payment timeout / 5xx
  "query_safe", // query_payment = payment-safe
  "query_finalized_attributed", // payment-finalized and attribution_verified = true
  "query_finalized_unattributed", // payment-finalized and attribution_verified = false
  "quote_expired", // error 30043 / quote expiry
  "query_failed", // definitive failure from query_payment
  "no_definitive_result", // no definitive result after 10 min
] as const;
export type PaymentEvent = (typeof PAYMENT_EVENTS)[number];

export const TERMINAL_STATES: readonly PaymentState[] = ["SETTLED", "SETTLED_UNATTRIBUTED", "EXPIRED", "FAILED", "FAILED_DENIED"];
export const PRE_SUBMITTED_STATES: readonly PaymentState[] = ["CREATED", "PREPARED", "SIGN_APPROVED", "SIGNED", "AUTH_FINALIZED", "SUBMIT_APPROVED"];
const NON_TERMINAL: readonly PaymentState[] = PAYMENT_STATES.filter((s) => !TERMINAL_STATES.includes(s));

export interface TransitionRow {
  from: readonly PaymentState[];
  event: PaymentEvent;
  to: PaymentState;
}

/** §9.4 verbatim, one row per table line. */
export const TRANSITIONS: readonly TransitionRow[] = [
  { from: ["CREATED"], event: "prepared", to: "PREPARED" },
  { from: ["PREPARED"], event: "sign_approved", to: "SIGN_APPROVED" },
  { from: ["PREPARED", "SIGN_APPROVED"], event: "sign_denied", to: "FAILED_DENIED" },
  { from: ["SIGN_APPROVED"], event: "signed", to: "SIGNED" },
  { from: ["SIGNED"], event: "finalized", to: "AUTH_FINALIZED" },
  { from: ["AUTH_FINALIZED"], event: "submit_approved", to: "SUBMIT_APPROVED" },
  { from: ["AUTH_FINALIZED"], event: "submit_denied", to: "FAILED_DENIED" },
  { from: ["SUBMIT_APPROVED"], event: "submit_ok", to: "SUBMITTED" },
  { from: ["SUBMIT_APPROVED"], event: "submit_uncertain", to: "UNCERTAIN" },
  { from: ["SUBMITTED", "UNCERTAIN", "SAFE"], event: "query_safe", to: "SAFE" },
  { from: ["SUBMITTED", "SAFE", "UNCERTAIN"], event: "query_finalized_attributed", to: "SETTLED" },
  { from: ["SUBMITTED", "SAFE", "UNCERTAIN"], event: "query_finalized_unattributed", to: "SETTLED_UNATTRIBUTED" },
  { from: PRE_SUBMITTED_STATES, event: "quote_expired", to: "EXPIRED" },
  { from: NON_TERMINAL, event: "query_failed", to: "FAILED" },
  { from: ["SUBMITTED", "SAFE"], event: "no_definitive_result", to: "UNCERTAIN" },
];

export function nextState(from: PaymentState, event: PaymentEvent): PaymentState | undefined {
  return TRANSITIONS.find((r) => r.event === event && r.from.includes(from))?.to;
}

export function transition(from: PaymentState, event: PaymentEvent): PaymentState {
  const to = nextState(from, event);
  if (!to) throw new AteError("PaymentError", "ATE_INTERNAL", `illegal payment transition ${from} --${event}-->`);
  return to;
}

export const isTerminal = (s: PaymentState): boolean => TERMINAL_STATES.includes(s);

/** Polling: query_payment every 3 s for 120 s, then every 30 s up to 10 min; then UNCERTAIN + 60 s reconcile. */
export function nextPollDelaySec(elapsedSinceSubmitSec: number): number | null {
  if (elapsedSinceSubmitSec < 120) return 3;
  if (elapsedSinceSubmitSec < 600) return 30;
  return null;
}
export const RECONCILE_INTERVAL_SEC = 60;
export const APPROVAL_TIMEOUT_SEC = 120;

/** Cap effect of entering a state (§9.4 last paragraph). `release_when_lapsed`: denial after signing. */
export function capEffect(to: PaymentState, from: PaymentState): "release" | "consume" | "keep" | "release_when_lapsed" {
  switch (to) {
    case "FAILED":
    case "EXPIRED":
      return "release";
    case "FAILED_DENIED":
      // Denied before any signature exists → nothing valid → release; denied at approval #2 → a finalized,
      // unsubmitted authorization stays valid until validUntil → keep reserved until it lapses.
      return from === "AUTH_FINALIZED" ? "release_when_lapsed" : "release";
    case "SETTLED":
    case "SETTLED_UNATTRIBUTED":
      return "consume";
    default:
      return "keep";
  }
}

/** ATE error code for a terminal/failure state (§9.6). */
export function errorCodeForState(s: PaymentState): "ATE_PAYMENT_DENIED" | "ATE_PAYMENT_EXPIRED" | "ATE_PAYMENT_UNCERTAIN" | null {
  if (s === "FAILED_DENIED") return "ATE_PAYMENT_DENIED";
  if (s === "EXPIRED") return "ATE_PAYMENT_EXPIRED";
  if (s === "UNCERTAIN") return "ATE_PAYMENT_UNCERTAIN";
  return null;
}
