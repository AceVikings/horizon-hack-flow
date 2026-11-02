// ate-signal — the receiving agent (SPEC §9.1, §9.2, §9.4 Delivery). Merchant side of the HSP order:
// creates the order itself (merchant_name = Vikings, its own pay_to), returns signed PaymentConditions,
// and releases the premium signal once per payment_request_id after `payment-finalized`.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { Address, Hex, LocalAccount } from "viem";
import { AteError } from "@ate/core";
import { canonicalJson } from "@ate/approve";
import {
  SIGNAL_PRODUCT,
  SIGNAL_TTL_SEC,
  conditionsHash,
  newOfferId,
  signConditions,
  type HspClient,
  type PaymentConditions,
} from "@ate/payments";
import type { FairValueSignal } from "./fairvalue.js";
import { HttpError, checkBearer, readJson, send, sendError } from "./http.js";

export interface DeliveredSignal {
  signalId: string;
  offerId: string;
  paymentRequestId: string;
  conditionsHash: Hex;
  validUntil: number;
  signal: FairValueSignal;
  /** EIP-191 by the signal agent over canonical JSON of the fields above. */
  signature: Hex;
}

export interface SignalServiceOptions {
  hsp: HspClient;
  /** Signal agent key (signs conditions and delivered signals). Its address is pinned in ate-pay. */
  account: LocalAccount;
  payTo: Address;
  priceUsd?: string;
  merchantName?: "Vikings";
  /** Worker token, required on every request. */
  token: string;
  computeSignal: () => Promise<FairValueSignal>;
  now?: () => number;
  /** Offer validity, ≤ 300 s (§9.2). */
  offerTtlSec?: number;
}

interface Offer {
  conditions: PaymentConditions;
  conditionsHash: Hex;
}

export class SignalService {
  private readonly offers = new Map<string, Offer>();
  private readonly redeemed = new Map<string, DeliveredSignal>();
  private readonly now: () => number;
  constructor(private readonly o: SignalServiceOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** GET /offers: create_order + signed conditions. */
  async createOffer(): Promise<PaymentConditions> {
    const chain = await this.o.hsp.getChainConfig();
    const priceUsd = this.o.priceUsd ?? "0.02";
    const merchantName = this.o.merchantName ?? "Vikings";
    const order = await this.o.hsp.createOrder({ merchantName, amountUsd: priceUsd, payTo: this.o.payTo, productName: SIGNAL_PRODUCT });
    const conditions = await signConditions(
      {
        offerId: newOfferId(),
        orderId: order.orderId,
        product: SIGNAL_PRODUCT,
        priceUsd,
        payTo: this.o.payTo,
        merchantName,
        network: { chainId: chain.chainId, token: chain.token, decimals: chain.decimals },
        expiresAt: this.now() + Math.min(this.o.offerTtlSec ?? 300, 300),
        signalTtlSec: SIGNAL_TTL_SEC,
      },
      this.o.account,
    );
    this.offers.set(conditions.offerId, { conditions, conditionsHash: conditionsHash(conditions) });
    return conditions;
  }

  /**
   * POST /redeem { payment_request_id, offerId, conditionsHash }: checks query_payment itself, requires
   * payment-finalized (attribution is evidence, not a delivery condition), matches offer + conditions, and
   * releases the signal ONCE per payment_request_id (a repeat returns 409).
   */
  async redeem(body: unknown): Promise<DeliveredSignal> {
    const b = (body ?? {}) as Record<string, unknown>;
    const prId = b.payment_request_id;
    const offerId = b.offerId;
    if (typeof prId !== "string" || typeof offerId !== "string") throw new HttpError(400, "expected { payment_request_id, offerId, conditionsHash }");
    if (this.redeemed.has(prId)) throw new HttpError(409, "signal already released for this payment_request_id");
    const offer = this.offers.get(offerId);
    if (!offer) throw new HttpError(404, "unknown offer");
    if (b.conditionsHash !== undefined && b.conditionsHash !== offer.conditionsHash) {
      throw new AteError("PaymentError", "ATE_PAYMENT_CONDITIONS_INVALID", "conditionsHash does not match the offer");
    }
    const st = await this.o.hsp.queryPayment({ paymentRequestId: prId });
    if (st.status !== "payment-finalized") {
      throw new AteError("PaymentError", "ATE_PAYMENT_UNCERTAIN", `payment not finalized (${st.status})`);
    }
    if (st.orderId !== undefined && st.orderId !== offer.conditions.orderId) {
      throw new AteError("PaymentError", "ATE_PAYMENT_ORDER_MISMATCH", "payment is for a different order");
    }
    // Reserve the slot before the async signal computation so concurrent redeems cannot both deliver.
    const placeholder = {} as DeliveredSignal;
    this.redeemed.set(prId, placeholder);
    try {
      const signal = await this.o.computeSignal();
      const unsigned = {
        signalId: `sigv_${randomBytes(8).toString("hex")}`,
        offerId,
        paymentRequestId: prId,
        conditionsHash: offer.conditionsHash,
        validUntil: this.now() + SIGNAL_TTL_SEC,
        signal,
      };
      const signature = await this.o.account.signMessage({ message: canonicalJson(unsigned) });
      const delivered = { ...unsigned, signature };
      this.redeemed.set(prId, delivered);
      return delivered;
    } catch (e) {
      this.redeemed.delete(prId);
      throw e;
    }
  }

  listen(port: number, host = "127.0.0.1"): Promise<Server> {
    const server = createServer((req, res) => {
      void (async () => {
        try {
          if (!checkBearer(req, this.o.token)) return send(res, 401, { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: "worker token required" } });
          const path = (req.url ?? "").split("?")[0];
          if (req.method === "GET" && path === "/offers") return send(res, 200, { ok: true, data: await this.createOffer() });
          if (req.method === "POST" && path === "/redeem") return send(res, 200, { ok: true, data: await this.redeem(await readJson(req)) });
          if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
          send(res, 404, { ok: false, error: { code: "ATE_INTERNAL", message: "not found" } });
        } catch (e) {
          sendError(res, e);
        }
      })();
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }
}
