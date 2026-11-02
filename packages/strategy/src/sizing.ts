// Entry sizing (§11.3 maxAmountIn) and the exit-reserve arithmetic (§11.4 rule 3b).

import { BPS, sellAmountForUsdCap, type MarketId, type MarketSnapshot, type PortfolioState, type VaultState } from "@ate/core";
import { effectiveMarketParams, epochRemainingE8, epochSpentE8, portfolioExposureE8, positionCapE8, turnoverAllocationE8 } from "./params.js";
import { clampNonNeg, minB, usdE8, usdtToE8 } from "./units.js";

export interface SizeCap {
  capE8: bigint;
  /** Which term binds (for candidate reasons / no_trade rationales). */
  binding: string;
  terms: Record<string, bigint>;
}

function pickMin(terms: Record<string, bigint>): SizeCap {
  let binding = "";
  let capE8: bigint | null = null;
  for (const [k, v] of Object.entries(terms)) {
    if (capE8 === null || v < capE8) {
      capE8 = v;
      binding = k;
    }
  }
  return { capE8: clampNonNeg(capE8 ?? 0n), binding, terms };
}

export function vaultExposureE8(v: VaultState): bigint {
  return BigInt(v.exposureUsdE8);
}

/**
 * Rule 3b: after the trade, maxEpochUsd − spentUsd ≥ exposureUsd × 10⁴ / (10⁴ − maxOracleDeviationBps).
 * Buys add their own notional to exposure first; sells reduce exposure by their notional.
 */
export function exitReserveOk(v: VaultState, now: number, side: "buy" | "sell", notionalE8: bigint): { ok: boolean; requiredE8: bigint; remainingAfterE8: bigint } {
  const dev = BigInt(v.limits.maxOracleDeviationBps);
  const remainingAfter = BigInt(v.limits.maxEpochUsdE8) - epochSpentE8(v, now) - notionalE8;
  const expAfter = clampNonNeg(side === "buy" ? vaultExposureE8(v) + notionalE8 : vaultExposureE8(v) - notionalE8);
  const required = (expAfter * BPS + (BPS - dev) - 1n) / (BPS - dev);
  return { ok: remainingAfter >= required, requiredE8: required, remainingAfterE8: remainingAfter };
}

/** Largest buy notional n with (R − n)(1e4 − dev) ≥ 1e4 (X + n)  ⇒  n ≤ (R(1e4−dev) − 1e4·X) / (2e4 − dev). */
export function exitReserveBuyCapE8(v: VaultState, now: number): bigint {
  const dev = BigInt(v.limits.maxOracleDeviationBps);
  const R = BigInt(v.limits.maxEpochUsdE8) - epochSpentE8(v, now);
  const X = vaultExposureE8(v);
  return clampNonNeg((R * (BPS - dev) - BPS * X) / (2n * BPS - dev));
}

/** Turnover remaining for a market and the portfolio (E8), net of used and reserved. */
export function turnoverRemainingE8(pf: PortfolioState, market: MarketId): { market: bigint; portfolio: bigint } {
  const b = pf.markets[market];
  const alloc = turnoverAllocationE8(market, pf.strategy, b?.vault);
  const mUsed = b ? usdE8(b.turnover.usedUsd) + usdE8(b.turnover.reservedUsd) : 0n;
  const pUsed = usdE8(pf.turnover.usedUsd) + usdE8(pf.turnover.reservedUsd);
  const budget = minB(usdE8(pf.turnover.budgetUsd), usdE8(pf.strategy.portfolio.maxDailyTurnoverUsd));
  return { market: clampNonNeg(alloc - mUsed), portfolio: clampNonNeg(budget - pUsed) };
}

/** maxAmountIn for an entry buy (E8 USD), §11.3 + rule 2 + rule 3 + rule 3b + balance. */
export function entryBuyCap(snap: MarketSnapshot, pf: PortfolioState): SizeCap {
  const market = snap.market;
  const m = effectiveMarketParams(market, pf.strategy.markets[market]);
  const v = snap.vault;
  const now = snap.at;
  const dev = BigInt(v.limits.maxOracleDeviationBps);
  const bookExp = pf.markets[market] ? usdE8(pf.markets[market].exposureUsd) : 0n;
  const exp = vaultExposureE8(v) > bookExp ? vaultExposureE8(v) : bookExp;
  const posHeadroom = clampNonNeg(positionCapE8(m, v) - exp);
  // The vault adds notional × 1e4/(1e4 − dev) to exposure (step 13): scale the headroom down.
  const vaultExpHeadroom = (clampNonNeg(BigInt(v.limits.maxExposureUsdE8) - vaultExposureE8(v)) * (BPS - dev)) / BPS;
  const pfHeadroom = clampNonNeg(usdE8(pf.strategy.portfolio.maxPortfolioExposureUsd) - portfolioExposureE8(pf));
  const t = turnoverRemainingE8(pf, market);
  return pickMin({
    tradeSize: usdE8(m.tradeSizeUsd),
    maxTrade: BigInt(v.limits.maxTradeUsdE8),
    positionLimit: posHeadroom,
    vaultExposure: vaultExpHeadroom,
    portfolioExposure: pfHeadroom,
    epochRemaining: epochRemainingE8(v, now),
    turnoverMarket: t.market,
    turnoverPortfolio: t.portfolio,
    exitReserve: exitReserveBuyCapE8(v, now),
    balance: usdtToE8(BigInt(v.balanceQuote)),
  });
}

/** maxAmountIn for an entry sell (E8 USD before token conversion): trade size, epoch, turnover. */
export function entrySellCap(snap: MarketSnapshot, pf: PortfolioState): SizeCap {
  const market = snap.market;
  const m = effectiveMarketParams(market, pf.strategy.markets[market]);
  const t = turnoverRemainingE8(pf, market);
  return pickMin({
    tradeSize: usdE8(m.tradeSizeUsd),
    maxTrade: BigInt(snap.vault.limits.maxTradeUsdE8),
    epochRemaining: epochRemainingE8(snap.vault, snap.at),
    turnoverMarket: t.market,
    turnoverPortfolio: t.portfolio,
  });
}

/** Exit chunk in priceToken units: min(qty, USD cap ÷ max(P, T) × 0.99) with cap = min(maxTradeUsd, epoch remaining). */
export function exitChunk(snap: MarketSnapshot, qty: bigint, capE8?: bigint): bigint {
  const v = snap.vault;
  const p = BigInt(snap.price.oracle.price);
  const twap = snap.price.pool.twap === null ? null : BigInt(snap.price.pool.twap);
  const cap = minB(capE8 ?? BigInt(v.limits.maxTradeUsdE8), BigInt(v.limits.maxTradeUsdE8), epochRemainingE8(v, snap.at));
  if (cap <= 0n || p <= 0n) return 0n;
  const tokens = sellAmountForUsdCap(cap, p, twap, v.priceDecimals);
  return minB(tokens, qty, BigInt(v.balancePrice));
}
