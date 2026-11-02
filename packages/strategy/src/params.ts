// Effective strategy parameters per market (§11.3 demo profile, §11.4 rules 3/7/9, §16).

import {
  DEFAULT_MIN_ENTRY_INTERVAL_SEC,
  MARKETS,
  MARKET_WBTC,
  WHSK_DEMO_PROFILE_OVERRIDES,
  type MarketId,
  type MarketStrategyParams,
  type PortfolioState,
  type StrategyParams,
  type VaultState,
} from "@ate/core";
import { minB, usdE8 } from "./units.js";

/** Demo profile is WHSK-only (§11.3, §16); a WBTC "demo" is treated as default. */
export function isDemo(market: MarketId, m: MarketStrategyParams): boolean {
  return m.profile === "demo" && market !== MARKET_WBTC;
}

/**
 * Market params with the demo-profile overrides applied (idempotent). Demo overrides win over the
 * stored values for the fields they set; `rebalanceTargetPct`/`stopLossBps`/`maxPositionUsd` stay.
 */
export function effectiveMarketParams(market: MarketId, m: MarketStrategyParams): MarketStrategyParams {
  if (!isDemo(market, m)) return { ...m, profile: "default" };
  return {
    ...m,
    profile: "demo",
    entrySpreadBps: WHSK_DEMO_PROFILE_OVERRIDES.entrySpreadBps,
    minNetEdgeBps: WHSK_DEMO_PROFILE_OVERRIDES.minNetEdgeBps,
    tradeSizeUsd: WHSK_DEMO_PROFILE_OVERRIDES.tradeSizeUsd,
    reentryCooldownSec: WHSK_DEMO_PROFILE_OVERRIDES.reentryCooldownSec,
    rebalanceBandPct: WHSK_DEMO_PROFILE_OVERRIDES.rebalanceBandPct,
  };
}

/** `--profile WHSK=demo` applied to a whole StrategyParams (WBTC can never be demo). */
export function withProfiles(s: StrategyParams, profiles: Partial<Record<"WHSK" | "WBTC", "demo" | "default">>): StrategyParams {
  const markets = { ...s.markets };
  for (const id of Object.keys(markets) as MarketId[]) {
    const asset = MARKETS[id].asset;
    const want = profiles[asset];
    if (!want) continue;
    if (want === "demo" && id === MARKET_WBTC) throw new RangeError("the WBTC market cannot be given the demo profile in v0.1 (§16)");
    markets[id] = effectiveMarketParams(id, { ...markets[id], profile: want });
  }
  return { ...s, markets };
}

export function minEntryIntervalSec(market: MarketId, m: MarketStrategyParams): number {
  return m.minEntryIntervalSec ?? DEFAULT_MIN_ENTRY_INTERVAL_SEC[market];
}

/** Market is a target asset and not disabled (§11.4 rule 9). */
export function isTargeted(market: MarketId, s: StrategyParams): boolean {
  const m = s.markets[market];
  if (!m || m.enabled === false) return false;
  return s.portfolio.targetAssets.includes(MARKETS[market].asset);
}

/**
 * Effective rebalance target: 0 when the market is de-selected (rule 9), else the configured value
 * (null = rebalance inactive).
 */
export function rebalanceTarget(market: MarketId, s: StrategyParams): number | null {
  if (!isTargeted(market, s)) return 0;
  return s.markets[market]?.rebalanceTargetPct ?? null;
}

/** Vault headroom for turnover: maxEpochUsd − maxExposureUsd (E8), ≥ 0. */
export function vaultTurnoverCapE8(v: VaultState): bigint {
  const x = BigInt(v.limits.maxEpochUsdE8) - BigInt(v.limits.maxExposureUsdE8);
  return x > 0n ? x : 0n;
}

/**
 * Rule 3 allocation (E8): maxDailyTurnoverUsd split equally among the enabled target assets, each share
 * clamped to ≤ the vault's maxEpochUsd − maxExposureUsd. A de-selected market gets 0.
 */
export function turnoverAllocationE8(market: MarketId, s: StrategyParams, vault: VaultState | undefined): bigint {
  if (!isTargeted(market, s)) return 0n;
  const targeted = (Object.keys(s.markets) as MarketId[]).filter((id) => isTargeted(id, s));
  const n = BigInt(Math.max(1, targeted.length));
  const share = usdE8(s.portfolio.maxDailyTurnoverUsd) / n;
  return vault ? minB(share, vaultTurnoverCapE8(vault)) : share;
}

/** Epoch spent with lazy rollover against `now` (mirrors the vault's aligned epochs). */
export function epochSpentE8(v: VaultState, now: number): bigint {
  const dur = v.limits.epochDuration;
  if (dur > 0 && Math.floor(now / dur) > Math.floor(v.epoch.start / dur)) return 0n;
  return BigInt(v.epoch.spentUsdE8);
}

export function epochRemainingE8(v: VaultState, now: number): bigint {
  const r = BigInt(v.limits.maxEpochUsdE8) - epochSpentE8(v, now);
  return r > 0n ? r : 0n;
}

/** Exposure cap per market (E8): min(maxPositionUsd, vault maxExposureUsd). */
export function positionCapE8(m: MarketStrategyParams, v: VaultState): bigint {
  return minB(usdE8(m.maxPositionUsd), BigInt(v.limits.maxExposureUsdE8));
}

/** Σ exposure across books (E8). */
export function portfolioExposureE8(pf: PortfolioState): bigint {
  let t = 0n;
  for (const b of Object.values(pf.markets)) t += usdE8(b.exposureUsd);
  return t;
}
