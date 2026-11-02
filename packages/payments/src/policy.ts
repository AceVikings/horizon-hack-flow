// Payment policy and economics, enforced in ate-pay (SPEC §9.5). Money is integer micro-USD (1e-6).
import { AteError } from "@ate/core";

export type MicroUsd = bigint;

export function usdToMicro(usd: string): MicroUsd {
  const m = /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(usd.trim());
  if (!m) throw new AteError("PaymentError", "ATE_PAYMENT_CONDITIONS_INVALID", `bad USD amount ${usd}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export function microToUsd(m: MicroUsd): string {
  const int = m / 1_000_000n;
  const frac = (m % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int.toString();
}

/** Token smallest units → micro-USD for a USD-stable token (HSP settles in a USD stablecoin). Rounds up. */
export function rawToMicroUsd(raw: bigint, decimals: number): MicroUsd {
  if (decimals >= 6) {
    const div = 10n ** BigInt(decimals - 6);
    return (raw + div - 1n) / div;
  }
  return raw * 10n ** BigInt(6 - decimals);
}

export interface PaymentPolicyConfig {
  perPaymentCapUsd: string; // "0.10"
  dailyCapUsd: string; // "1.00"
  signalPriceUsd: string; // "0.02"
}

export const DEFAULT_PAYMENT_POLICY: PaymentPolicyConfig = { perPaymentCapUsd: "0.10", dailyCapUsd: "1.00", signalPriceUsd: "0.02" };

export interface BuyContext {
  tradeSizeUsd: string;
  /** Free-path net edge of the borderline candidate (signed bps). */
  netEdgeBps: number;
  entrySpreadBps: number;
}

/**
 * Buy only when tradeSizeUsd × |netEdgeBps| / 10000 ≥ 5 × priceUsd and the free signal is borderline
 * (net edge within ±1.5 × entrySpreadBps). $0.02 at $25 ⇒ ≥ 40 bps disputed edge.
 */
export function shouldBuySignal(ctx: BuyContext, priceUsd: string): { buy: boolean; reason: string } {
  const size = usdToMicro(ctx.tradeSizeUsd);
  const value = (size * BigInt(Math.round(Math.abs(ctx.netEdgeBps) * 100))) / 1_000_000n; // micro-USD
  const need = 5n * usdToMicro(priceUsd);
  if (Math.abs(ctx.netEdgeBps) > 1.5 * ctx.entrySpreadBps) return { buy: false, reason: "free signal not borderline" };
  if (value < need) return { buy: false, reason: `information value ${microToUsd(value)} < 5 × price ${microToUsd(need)}` };
  return { buy: true, reason: `information value ${microToUsd(value)} ≥ 5 × price` };
}

export type CapEntryState = "reserved" | "consumed" | "released";

interface CapEntry {
  paymentId: string;
  day: string;
  amount: MicroUsd;
  state: CapEntryState;
}

/** UTC day key. */
export const dayKey = (unixSec: number): string => new Date(unixSec * 1000).toISOString().slice(0, 10);

/**
 * Daily cap ledger: reservations count against the cap until released (FAILED, EXPIRED, lapsed denial)
 * or consumed (SETTLED*, and UNCERTAIN keeps them).
 */
export class CapLedger {
  private readonly perPayment: MicroUsd;
  private readonly daily: MicroUsd;
  private readonly entries = new Map<string, CapEntry>();

  constructor(cfg: Pick<PaymentPolicyConfig, "perPaymentCapUsd" | "dailyCapUsd">, initial: CapEntry[] = []) {
    this.perPayment = usdToMicro(cfg.perPaymentCapUsd);
    this.daily = usdToMicro(cfg.dailyCapUsd);
    for (const e of initial) this.entries.set(e.paymentId, { ...e });
  }

  usedToday(now: number): MicroUsd {
    const d = dayKey(now);
    let s = 0n;
    for (const e of this.entries.values()) if (e.day === d && e.state !== "released") s += e.amount;
    return s;
  }

  /** Reserve (or raise an existing reservation to) `amount`. Throws ATE_PAYMENT_LIMIT. */
  reserve(paymentId: string, amount: MicroUsd, now: number): void {
    if (amount > this.perPayment) {
      throw new AteError("PaymentError", "ATE_PAYMENT_LIMIT", `payment ${microToUsd(amount)} USD > per-payment cap ${microToUsd(this.perPayment)}`, { retryable: false });
    }
    const existing = this.entries.get(paymentId);
    const prior = existing && existing.state === "reserved" ? existing.amount : 0n;
    const day = existing?.day ?? dayKey(now);
    if (this.usedToday(now) - prior + amount > this.daily) {
      throw new AteError("PaymentError", "ATE_PAYMENT_LIMIT", `daily payment cap ${microToUsd(this.daily)} USD reached`);
    }
    this.entries.set(paymentId, { paymentId, day, amount: amount > prior ? amount : prior, state: "reserved" });
  }

  release(paymentId: string): void {
    const e = this.entries.get(paymentId);
    if (e && e.state === "reserved") e.state = "released";
  }

  consume(paymentId: string): void {
    const e = this.entries.get(paymentId);
    if (e) e.state = "consumed";
  }

  get(paymentId: string): CapEntry | undefined {
    const e = this.entries.get(paymentId);
    return e ? { ...e } : undefined;
  }

  snapshot(): CapEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }
}
