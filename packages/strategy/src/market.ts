// Per-market derived quantities from a MarketSnapshot (§11.2/§11.3): prices, gap, cost, impact sizing.

import { createHash } from "node:crypto";
import { MARKETS, maxBig, type GeneratorId, type ImpactPoint, type MarketId, type MarketSnapshot, type Side } from "@ate/core";
import { roundBps, signedBps } from "./units.js";

/**
 * Reference price the spread-revert gap is measured against. Default "oracle": the on-chain Supra feed the
 * vault itself checks (SupraAggregatorAdapter). "twap": the pool's own 300 s TWAP. "cex": HashKey Global mid
 * (optional context only; the earlier reference, off by default). Every fill is on HSKSwap regardless.
 */
export type PriceReference = "oracle" | "twap" | "cex";
export const DEFAULT_REFERENCE: PriceReference = "oracle";
export const REFERENCE_LABEL: Record<PriceReference, string> = { oracle: "the on-chain oracle", twap: "the pool's 300 s TWAP", cex: "the HashKey Global mid" };

export interface MarketView {
  market: MarketId;
  /** Which reference `gapBps` is measured against. */
  reference: PriceReference;
  /** The reference price, 8 dp, or null when it could not be read. */
  refPrice: bigint | null;
  d: 8 | 18;
  /** APRO P, 8 dp. */
  oracle: bigint;
  /** Pool spot S, 8 dp. */
  pool: bigint;
  /** 300 s TWAP T, 8 dp, or null. */
  twap: bigint | null;
  /** Pcap = max(P, T) — what the vault counts sell notional at (§4.2 step 7b). */
  pCap: bigint;
  cexMid: bigint | null;
  /** CEX half-spread; counted in cost only with reference "cex" (an on-chain reference has no book to cross). */
  halfSpreadBps: number;
  feeBps: number;
  /** Signed pool-vs-reference gap in bps: (pool − ref) / ref; negative = pool below the reference. null without one. */
  gapBps: number | null;
}

export function viewOf(snap: MarketSnapshot, reference: PriceReference = DEFAULT_REFERENCE): MarketView {
  const p = snap.price;
  const oracle = BigInt(p.oracle.price);
  const pool = BigInt(p.pool.price);
  const twap = p.pool.twap === null ? null : BigInt(p.pool.twap);
  const cexMid = p.cex ? BigInt(p.cex.mid) : null;
  const refPrice = reference === "cex" ? cexMid : reference === "twap" ? twap : oracle > 0n ? oracle : null;
  return {
    market: snap.market,
    reference,
    refPrice,
    d: MARKETS[snap.market].baseDecimals,
    oracle,
    pool,
    twap,
    pCap: twap === null ? oracle : maxBig(oracle, twap),
    cexMid,
    halfSpreadBps: reference === "cex" ? (p.cex?.halfSpreadBps ?? 0) : 0,
    feeBps: snap.feeBps,
    gapBps: refPrice && refPrice > 0n ? signedBps(pool, refPrice) : null,
  };
}

/**
 * impactBps(size) by linear interpolation over the QuoterV2 samples (through the origin), and
 * proportional extrapolation beyond the last sample (impact grows ~linearly for small sizes).
 */
export function impactAt(points: readonly ImpactPoint[], amountIn: bigint): number {
  if (amountIn <= 0n || points.length === 0) return 0;
  let prevA = 0n;
  let prevI = 0;
  for (const pt of points) {
    const a = BigInt(pt.amountIn);
    if (amountIn <= a) {
      if (a === prevA) return pt.impactBps;
      const f = Number(amountIn - prevA) / Number(a - prevA);
      return roundBps(prevI + f * (pt.impactBps - prevI));
    }
    prevA = a;
    prevI = pt.impactBps;
  }
  if (prevA === 0n) return prevI;
  return roundBps((prevI * Number(amountIn)) / Number(prevA));
}

/** Largest amountIn with impactAt(amountIn) ≤ maxBps (inverse of impactAt). Infinity-like when impact never binds. */
export function sizeForImpact(points: readonly ImpactPoint[], maxBps: number): bigint {
  const HUGE = 10n ** 40n;
  if (points.length === 0) return HUGE;
  if (maxBps <= 0) return 0n;
  let prevA = 0n;
  let prevI = 0;
  for (const pt of points) {
    const a = BigInt(pt.amountIn);
    if (pt.impactBps > maxBps) {
      if (pt.impactBps === prevI) return prevA;
      const f = (maxBps - prevI) / (pt.impactBps - prevI);
      return prevA + BigInt(Math.floor(f * Number(a - prevA)));
    }
    prevA = a;
    prevI = pt.impactBps;
  }
  if (prevI <= 0) return HUGE;
  return BigInt(Math.floor((Number(prevA) * maxBps) / prevI));
}

/** costBps = feeBps + impactBps(size) (+ CEX half-spread only when the reference is "cex") (§11.3). */
export function costBps(v: MarketView, snap: MarketSnapshot, side: Side, amountIn: bigint): { cost: number; impact: number } {
  const impact = impactAt(side === "buy" ? snap.impact.buy : snap.impact.sell, amountIn);
  return { cost: roundBps(v.feeBps + impact + v.halfSpreadBps), impact };
}

/** Direction-adjusted signed edge vs the reference price: positive when the trade is in the favourable direction. */
export function signedEdgeFor(v: MarketView, side: Side): number {
  if (v.gapBps === null) return 0;
  return side === "buy" ? -v.gapBps : v.gapBps;
}

/** Deterministic candidate id: "cand_" + 16 hex of sha256 over the defining fields. */
export function candidateId(parts: { market: MarketId; generator: GeneratorId; side: Side; leg?: string; at: number; maxAmountIn: string; extra?: string }): string {
  const h = createHash("sha256")
    .update([parts.market, parts.generator, parts.leg ?? "", parts.side, String(parts.at), parts.maxAmountIn, parts.extra ?? ""].join("|"))
    .digest("hex");
  return `cand_${h.slice(0, 16)}`;
}
