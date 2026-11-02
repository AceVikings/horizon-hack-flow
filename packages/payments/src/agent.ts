// The payment agent (ate-pay core): mandate builder (§9.3) + settlement state machine driver (§9.4) +
// failure/idempotency rules (§9.6) + policy and caps (§9.5). Transport-agnostic; apps/worker serves it.
import { randomBytes } from "node:crypto";
import { AteError } from "@ate/core";
import { paymentPayload, type ApprovalVerifier, type PaymentApproval } from "@ate/approve";
import { keccak256, type Address, type Hex } from "viem";
import { verifyConditions, type PaymentConditions } from "./conditions.js";
import { HspError, type HspClient } from "./hsp.js";
import { CapLedger, rawToMicroUsd, usdToMicro } from "./policy.js";
import type { TypedDataSigner } from "./signer.js";
import { typedDataDigest } from "./signer.js";
import {
  APPROVAL_TIMEOUT_SEC,
  PRE_SUBMITTED_STATES,
  RECONCILE_INTERVAL_SEC,
  capEffect,
  isTerminal,
  nextPollDelaySec,
  transition,
  type PaymentEvent,
} from "./state.js";
import type { PaymentRecord, PaymentStore } from "./store.js";

/** A table event, or a persisted change that is not a transition. */
export type UpdateEvent = PaymentEvent | "created" | "polled" | "updated";

export interface PaymentAgentDeps {
  hsp: HspClient;
  signer: TypedDataSigner;
  store: PaymentStore;
  caps: CapLedger;
  /** Verifies ate-approve signatures (audience "ate-pay") against the pinned key. */
  verifier: ApprovalVerifier;
  /** Address whose EIP-191 signature the conditions must carry. */
  signalAgent: Address;
  /** Configured `payTo` of the signal agent (§9.5). */
  signalPayTo: Address;
  merchantName: string;
  balanceOf: (token: Address, owner: Address) => Promise<bigint>;
  /** No purchases while Vault-HSK is paused (§9.5). */
  isVaultPaused: () => Promise<boolean>;
  now?: () => number;
  /** Every persisted transition (→ journal `payment` / `payment_update`, /events `payment.state`). */
  onUpdate?: (r: PaymentRecord, event: UpdateEvent) => void;
}

const perr = (code: ConstructorParameters<typeof AteError>[1], msg: string, context?: Record<string, unknown>) =>
  new AteError("PaymentError", code, msg, context ? { context } : {});

export class PaymentAgent {
  private readonly now: () => number;
  constructor(private readonly d: PaymentAgentDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get(id: string): PaymentRecord | undefined {
    return this.d.store.get(id);
  }

  list(): PaymentRecord[] {
    return this.d.store.all();
  }

  private save(r: PaymentRecord, event: UpdateEvent): PaymentRecord {
    r.updatedAt = this.now();
    this.d.store.put(r);
    this.d.onUpdate?.(structuredClone(r), event);
    return r;
  }

  /** Applies one table transition + its cap effect, persists, returns the record. */
  private step(r: PaymentRecord, event: PaymentEvent, reason?: string): PaymentRecord {
    const from = r.state;
    const to = transition(from, event);
    r.state = to;
    r.history.push({ at: this.now(), from, event, to });
    if (reason !== undefined) r.reason = reason;
    switch (capEffect(to, from)) {
      case "release":
        this.d.caps.release(r.id);
        break;
      case "consume":
        this.d.caps.consume(r.id);
        break;
      case "release_when_lapsed":
        r.releaseCapAt = r.mandate?.validUntil ?? this.now();
        break;
      case "keep":
        break;
    }
    if (isTerminal(to)) delete r.awaiting;
    return this.save(r, event);
  }

  private approvalPayload(r: PaymentRecord, stage: "sign" | "submit"): PaymentApproval {
    const m = r.mandate!;
    return paymentPayload({
      issuedAt: this.now(),
      body: {
        stage,
        paymentId: r.id,
        paymentRequestId: m.paymentRequestId,
        amountRaw: m.amountRaw,
        decimals: r.network.decimals,
        token: r.network.token,
        tokenSymbol: r.network.tokenSymbol,
        payTo: r.conditions.payTo,
        payer: r.payer,
        chainId: r.network.chainId,
        typedDataDigest: m.typedDataDigest,
        validUntil: m.validUntil,
        ...(stage === "submit" && r.fee ? { feeRaw: r.fee.feeRaw } : {}),
      },
    });
  }

  /**
   * §9.3: verify conditions → get_order → policy + reserve → prepare_payment → balance → mandate.
   * Returns the record in PREPARED with `awaiting.payload` = approval #1 for ate-approve.
   * Idempotent per offer: an in-flight payment for the same offer/order is returned, never re-prepared.
   */
  async start(conditions: PaymentConditions): Promise<PaymentRecord> {
    const now = this.now();
    const inflight = this.d.store.all().find((p) => !isTerminal(p.state) && (p.offerId === conditions.offerId || p.orderId === conditions.orderId));
    if (inflight) {
      // §9.6: never re-prepare while a signed authorization may be live — query first.
      if (["SIGNED", "AUTH_FINALIZED", "SUBMIT_APPROVED", "SUBMITTED", "SAFE", "UNCERTAIN"].includes(inflight.state)) await this.poll(inflight.id);
      return this.d.store.get(inflight.id)!;
    }
    if (await this.d.isVaultPaused()) throw new AteError("PaymentError", "ATE_POLICY_PAUSED", "no signal purchases while Vault-HSK is paused");

    let chain;
    try {
      chain = await this.d.hsp.getChainConfig();
    } catch (e) {
      throw perr("ATE_PAYMENT_UNAVAILABLE", `get_chain_config failed: ${(e as Error).message}`);
    }
    const { conditionsHash } = await verifyConditions(conditions, { signalAgent: this.d.signalAgent, chain, now });
    if (conditions.payTo.toLowerCase() !== this.d.signalPayTo.toLowerCase()) {
      throw perr("ATE_PAYMENT_CONDITIONS_INVALID", "payTo is not the configured signal agent");
    }

    let order;
    try {
      order = await this.d.hsp.getOrder(conditions.orderId);
    } catch (e) {
      throw perr("ATE_PAYMENT_UNAVAILABLE", `get_order failed: ${(e as Error).message}`);
    }
    const mismatch: string[] = [];
    if (order.orderId !== conditions.orderId) mismatch.push("orderId");
    if (usdToMicro(order.amount) !== usdToMicro(conditions.priceUsd)) mismatch.push("amount");
    if (order.currency.toUpperCase() !== "USD") mismatch.push("currency");
    if (order.payTo.toLowerCase() !== conditions.payTo.toLowerCase()) mismatch.push("pay_to");
    if (order.merchantName !== conditions.merchantName || order.merchantName !== this.d.merchantName) mismatch.push("merchant_name");
    if (mismatch.length) throw perr("ATE_PAYMENT_ORDER_MISMATCH", `get_order disagrees with conditions: ${mismatch.join(", ")}`, { mismatch });

    const payer = await this.d.signer.address();
    const id = `pay_${randomBytes(8).toString("hex")}`;
    // Step 3: policy + reserve (throws ATE_PAYMENT_LIMIT before anything is created).
    this.d.caps.reserve(id, usdToMicro(conditions.priceUsd), now);
    const r: PaymentRecord = {
      id,
      offerId: conditions.offerId,
      conditions,
      conditionsHash,
      orderId: conditions.orderId,
      payer,
      network: { chainId: chain.chainId, token: chain.token, decimals: chain.decimals, tokenSymbol: chain.tokenSymbol },
      state: "CREATED",
      approvals: {},
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.save(r, "created");

    // Step 4: prepare_payment → typed data + quote.
    let prep;
    try {
      prep = await this.d.hsp.preparePayment({ orderId: conditions.orderId, payer });
    } catch (e) {
      if (e instanceof HspError && e.quoteExpired) {
        this.step(r, "quote_expired", "30043 at prepare");
        throw perr("ATE_PAYMENT_EXPIRED", "quote expired at prepare_payment");
      }
      this.d.caps.release(id);
      r.reason = `prepare_payment failed: ${(e as Error).message}`;
      // No HSP state exists yet; record as failed via the definitive-failure row.
      this.step(r, "query_failed");
      throw perr("ATE_PAYMENT_UNAVAILABLE", r.reason);
    }
    const totalMicro = rawToMicroUsd(prep.tokenTotalRaw, chain.decimals);
    try {
      this.d.caps.reserve(id, totalMicro, now); // raise the reservation to the quoted total incl. fees
    } catch (e) {
      this.step(r, "query_failed", (e as Error).message);
      throw e;
    }
    const balance = await this.d.balanceOf(chain.token, payer);
    if (balance < prep.tokenTotalRaw) {
      this.step(r, "query_failed", `payer balance ${balance} < token_total_raw ${prep.tokenTotalRaw}`);
      throw new AteError("PaymentError", "ATE_INSUFFICIENT_BALANCE", r.reason!);
    }
    // The Payment Mandate, persisted before any signature.
    r.typedData = prep.typedData;
    r.mandate = {
      conditionsHash,
      orderId: conditions.orderId,
      flowId: prep.flowId,
      paymentRequestId: prep.paymentRequestId,
      typedDataDigest: typedDataDigest(prep.typedData),
      amountRaw: prep.tokenTotalRaw.toString(),
      validUntil: prep.validUntil,
    };
    this.step(r, "prepared");
    r.awaiting = { stage: "sign", payload: this.approvalPayload(r, "sign"), since: this.now() };
    return this.save(r, "updated");
  }

  private expireIfLapsed(r: PaymentRecord): boolean {
    if (r.mandate && PRE_SUBMITTED_STATES.includes(r.state) && this.now() > r.mandate.validUntil) {
      this.step(r, "quote_expired", "quote validity lapsed");
      return true;
    }
    return false;
  }

  /**
   * Human approval (#1 sign / #2 submit): an ate-approve signature over `awaiting.payload`, which the agent
   * built itself. A re-prepared mandate has a new digest, so an old approval cannot verify.
   */
  async approve(id: string, stage: "sign" | "submit", signatureB64: string): Promise<PaymentRecord> {
    const r = this.d.store.get(id);
    if (!r) throw perr("ATE_PAYMENT_DENIED", `unknown payment ${id}`);
    if (!r.awaiting || r.awaiting.stage !== stage) throw perr("ATE_PAYMENT_DENIED", `payment ${id} is not awaiting approval '${stage}' (state ${r.state})`);
    if (this.now() - r.awaiting.since > APPROVAL_TIMEOUT_SEC) {
      this.step(r, stage === "sign" ? "sign_denied" : "submit_denied", "approval timed out (120 s)");
      throw perr("ATE_PAYMENT_DENIED", "approval timed out");
    }
    if (this.expireIfLapsed(r)) throw perr("ATE_PAYMENT_EXPIRED", "quote expired before approval");
    const v = this.d.verifier.verify(r.awaiting.payload, signatureB64, this.now());
    if (!v.ok) throw new AteError("AuthError", "ATE_PAYMENT_DENIED", `approval signature rejected (${v.reason})`, { retryable: true });
    if (stage === "sign") return this.afterSignApproval(r);
    return this.afterSubmitApproval(r);
  }

  private async afterSignApproval(r: PaymentRecord): Promise<PaymentRecord> {
    r.approvals.sign = { at: this.now(), keyId: this.d.verifier.keyId };
    this.step(r, "sign_approved");
    let signature: Hex;
    try {
      // Digest re-check right before signing: the typed data must be the one approved.
      if (typedDataDigest(r.typedData!) !== r.mandate!.typedDataDigest) throw new Error("typed data changed since approval");
      signature = await this.d.signer.signTypedData(r.typedData!);
    } catch (e) {
      // Stays SIGN_APPROVED; with no signature the 120 s timeout moves it to FAILED(denied).
      r.reason = `signer: ${(e as Error).message}`;
      this.save(r, "updated");
      throw new AteError("WalletError", "ATE_PAYMENT_UNAVAILABLE", r.reason);
    }
    delete r.awaiting;
    r.signatureDigest = keccak256(signature);
    this.step(r, "signed");
    try {
      await this.d.hsp.finalizePayment({ flowId: r.mandate!.flowId, paymentRequestId: r.mandate!.paymentRequestId, signature });
    } catch (e) {
      if (e instanceof HspError && e.quoteExpired) {
        this.step(r, "quote_expired", "30043 at finalize_payment");
        throw perr("ATE_PAYMENT_EXPIRED", "quote expired at finalize_payment");
      }
      r.reason = `finalize_payment: ${(e as Error).message}`;
      this.save(r, "updated");
      throw perr("ATE_PAYMENT_UNAVAILABLE", r.reason);
    }
    this.step(r, "finalized");
    try {
      const fee = await this.d.hsp.estimateFee({ flowId: r.mandate!.flowId, paymentRequestId: r.mandate!.paymentRequestId });
      r.fee = { feeRaw: fee.feeRaw.toString(), gasFeeAdvanced: fee.gasFeeAdvanced };
    } catch (e) {
      if (e instanceof HspError && e.quoteExpired) {
        this.step(r, "quote_expired", "30043 at estimate_fee");
        throw perr("ATE_PAYMENT_EXPIRED", "quote expired at estimate_fee");
      }
      r.reason = `estimate_fee: ${(e as Error).message}`;
    }
    r.awaiting = { stage: "submit", payload: this.approvalPayload(r, "submit"), since: this.now() };
    return this.save(r, "updated");
  }

  private async afterSubmitApproval(r: PaymentRecord): Promise<PaymentRecord> {
    r.approvals.submit = { at: this.now(), keyId: this.d.verifier.keyId };
    delete r.awaiting;
    // Persisted before the call: after a crash a SUBMIT_APPROVED record is resolved by query, never resubmitted.
    this.step(r, "submit_approved");
    try {
      const s = await this.d.hsp.submitPayment({ flowId: r.mandate!.flowId, paymentRequestId: r.mandate!.paymentRequestId });
      if (s.gatewayTx) r.gatewayTx = s.gatewayTx;
      r.submittedAt = this.now();
      this.step(r, "submit_ok");
    } catch (e) {
      if (e instanceof HspError && e.quoteExpired) {
        this.step(r, "quote_expired", "30043 at submit_payment");
        throw perr("ATE_PAYMENT_EXPIRED", "quote expired at submit_payment");
      }
      // Timeout / 5xx / any non-definitive answer: UNCERTAIN, resolved only by query_payment.
      r.submittedAt = this.now();
      this.step(r, "submit_uncertain", `submit_payment: ${(e as Error).message}`);
    }
    return this.d.store.get(r.id)!;
  }

  async deny(id: string, stage: "sign" | "submit", reason = "denied by user"): Promise<PaymentRecord> {
    const r = this.d.store.get(id);
    if (!r) throw perr("ATE_PAYMENT_DENIED", `unknown payment ${id}`);
    if (!r.awaiting || r.awaiting.stage !== stage) throw perr("ATE_PAYMENT_DENIED", `payment ${id} is not awaiting '${stage}'`);
    return this.step(r, stage === "sign" ? "sign_denied" : "submit_denied", reason);
  }

  /** One query_payment; applies safe / finalized / failed. Never resubmits. */
  async poll(id: string): Promise<PaymentRecord> {
    const r = this.d.store.get(id);
    if (!r || !r.mandate || isTerminal(r.state)) return r!;
    r.lastPolledAt = this.now();
    let s;
    try {
      s = await this.d.hsp.queryPayment({ paymentRequestId: r.mandate.paymentRequestId, flowId: r.mandate.flowId });
    } catch {
      return this.save(r, "polled"); // transport error: try again later
    }
    if (s.gatewayTx) r.gatewayTx = s.gatewayTx;
    const postSubmit = ["SUBMITTED", "SAFE", "UNCERTAIN"].includes(r.state);
    if (s.status === "payment-failed") return this.step(r, "query_failed", s.failureReason ?? "payment-failed");
    if (!postSubmit) return this.save(r, "polled");
    if (s.status === "payment-finalized") {
      r.attributionVerified = s.attributionVerified;
      return this.step(r, s.attributionVerified ? "query_finalized_attributed" : "query_finalized_unattributed");
    }
    if (s.status === "payment-safe" && r.state !== "SAFE") return this.step(r, "query_safe");
    return this.save(r, "polled");
  }

  /**
   * Housekeeping, called every few seconds: approval timeouts (120 s), quote lapses, delayed cap releases,
   * the polling schedule (3 s → 30 s → UNCERTAIN after 10 min → 60 s reconcile).
   */
  async tick(): Promise<void> {
    const now = this.now();
    for (const r of this.d.store.all()) {
      if (r.releaseCapAt !== undefined && now > r.releaseCapAt) {
        this.d.caps.release(r.id);
        delete r.releaseCapAt;
        this.save(r, "updated");
      }
      if (isTerminal(r.state)) continue;
      if (r.awaiting && now - r.awaiting.since > APPROVAL_TIMEOUT_SEC) {
        this.step(r, r.awaiting.stage === "sign" ? "sign_denied" : "submit_denied", "approval timed out (120 s)");
        continue;
      }
      if (this.expireIfLapsed(r)) continue;
      if (["SUBMITTED", "SAFE", "UNCERTAIN"].includes(r.state)) {
        const elapsed = now - (r.submittedAt ?? r.updatedAt);
        if (r.state !== "UNCERTAIN" && elapsed >= 600) {
          this.step(r, "no_definitive_result", "no definitive result after 10 min");
          continue;
        }
        const delay = r.state === "UNCERTAIN" ? RECONCILE_INTERVAL_SEC : (nextPollDelaySec(elapsed) ?? RECONCILE_INTERVAL_SEC);
        if (r.lastPolledAt === undefined || now - r.lastPolledAt >= delay) await this.poll(r.id);
      }
    }
  }

  /** Startup recovery: a SUBMIT_APPROVED record means submit may have gone out — UNCERTAIN, never resubmit. */
  recover(): void {
    for (const r of this.d.store.all()) {
      if (r.state === "SUBMIT_APPROVED") {
        r.submittedAt ??= this.now();
        this.step(r, "submit_uncertain", "recovered after restart: submit outcome unknown");
      }
    }
  }
}
