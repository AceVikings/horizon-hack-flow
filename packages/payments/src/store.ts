// Payment persistence. The mandate is persisted BEFORE any signature (§9.3); every transition is saved
// before the side effect it authorises, so a crash never causes a second prepare or a resubmit.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import type { PaymentConditions } from "./conditions.js";
import type { TypedDataPayload } from "./hsp.js";
import type { PaymentApproval } from "@ate/approve";
import type { PaymentEvent, PaymentState } from "./state.js";

/** §9.3: `{ conditionsHash, orderId, flow_id, payment_request_id, typedDataDigest, amountRaw, validUntil }`. */
export interface PaymentMandate {
  conditionsHash: Hex;
  orderId: string;
  flowId: string;
  paymentRequestId: string;
  typedDataDigest: Hex;
  amountRaw: string;
  validUntil: number;
}

export interface PaymentRecord {
  id: string;
  offerId: string;
  conditions: PaymentConditions;
  conditionsHash: Hex;
  orderId: string;
  payer: Address;
  network: { chainId: number; token: Address; decimals: number; tokenSymbol: string };
  state: PaymentState;
  /** Reason for FAILED / FAILED_DENIED / EXPIRED. */
  reason?: string;
  mandate?: PaymentMandate;
  typedData?: TypedDataPayload;
  /** Approval the agent is waiting for (built server-side; verifier never trusts caller payloads). */
  awaiting?: { stage: "sign" | "submit"; payload: PaymentApproval; since: number };
  approvals: { sign?: { at: number; keyId: string }; submit?: { at: number; keyId: string } };
  /** Digest of the wallet signature (the signature itself is never stored or logged). */
  signatureDigest?: Hex;
  fee?: { feeRaw: string; gasFeeAdvanced: boolean };
  gatewayTx?: Hex;
  attributionVerified?: boolean;
  submittedAt?: number;
  lastPolledAt?: number;
  /** Denied at approval #2: the cap stays reserved until this time (mandate.validUntil). */
  releaseCapAt?: number;
  signalId?: string;
  createdAt: number;
  updatedAt: number;
  history: { at: number; from: PaymentState; event: PaymentEvent; to: PaymentState }[];
}

export interface PaymentStore {
  get(id: string): PaymentRecord | undefined;
  put(r: PaymentRecord): void;
  all(): PaymentRecord[];
}

export class MemoryPaymentStore implements PaymentStore {
  protected readonly items = new Map<string, PaymentRecord>();
  get(id: string): PaymentRecord | undefined {
    const r = this.items.get(id);
    return r ? structuredClone(r) : undefined;
  }
  put(r: PaymentRecord): void {
    this.items.set(r.id, structuredClone(r));
  }
  all(): PaymentRecord[] {
    return [...this.items.values()].map((r) => structuredClone(r));
  }
}

/** Atomic JSON-file store (worker-local, mode 0600). Fine for a handful of payments per day. */
export class JsonFilePaymentStore extends MemoryPaymentStore {
  constructor(private readonly path: string) {
    super();
    try {
      const rows = JSON.parse(readFileSync(path, "utf8")) as PaymentRecord[];
      for (const r of rows) this.items.set(r.id, r);
    } catch {
      // new store
    }
  }
  override put(r: PaymentRecord): void {
    super.put(r);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.items.values()], (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
