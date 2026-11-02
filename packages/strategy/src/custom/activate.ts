// "Use this strategy" on a market (lane STRAT): the strategy change that puts a custom strategy in use (or stops it),
// with the risk comparison that decides Touch ID. Riskier = bigger trades, a looser stop, more trades a day or less
// time between trades than what runs now (the active custom strategy, or the preset numbers). Safer applies at once.

import {
  DEFAULT_MIN_ENTRY_INTERVAL_SEC,
  compareRisk,
  specRisk,
  type CustomStrategyRef,
  type MarketId,
  type RiskNumbers,
  type StrategyFieldChange,
  type StrategyParams,
  type VaultState,
} from "@ate/core";
import { effectiveMarketParams, minEntryIntervalSec, turnoverAllocationE8 } from "../params.js";

const refLabel = (r: CustomStrategyRef | null | undefined) => (r ? `${r.name} v${r.version} ${r.hash.slice(0, 10)}` : null);

/** What the market runs now, as risk numbers (custom strategy, or the preset numbers). */
export function currentRisk(market: MarketId, s: StrategyParams, vault?: VaultState): RiskNumbers {
  const raw = s.markets[market];
  const m = effectiveMarketParams(market, raw);
  const budgetUsd = Number(turnoverAllocationE8(market, s, vault)) / 1e8;
  const guardStopPct = m.stopLossBps / 100;
  if (raw.custom) {
    const r = specRisk(raw.custom.spec, { budgetUsd, guardStopPct });
    return { ...r, sizeUsd: Math.min(r.sizeUsd, Number(m.tradeSizeUsd)) };
  }
  const size = Number(m.tradeSizeUsd);
  return {
    sizeUsd: size,
    stopPct: guardStopPct,
    tradesPerDay: size > 0 ? Math.max(1, Math.floor(budgetUsd / size)) : 0,
    cooldownMin: Math.round(Math.max(minEntryIntervalSec(market, m), m.cycleSeconds) / 60),
  };
}

export interface CustomActivation {
  next: StrategyParams;
  changes: StrategyFieldChange[];
  riskier: boolean;
  /** Plain reasons it is riskier ("bigger trades ($25 → $50)"). */
  reasons: string[];
  before: RiskNumbers;
  after: RiskNumbers;
}

/** The strategy change for using `ref` on `market` (null = stop using a custom strategy there). */
export function customActivation(market: MarketId, ref: CustomStrategyRef | null, current: StrategyParams, vault?: VaultState): CustomActivation {
  const next = JSON.parse(JSON.stringify(current)) as StrategyParams;
  const cur = current.markets[market];
  const m = next.markets[market];
  const before = currentRisk(market, current, vault);
  const changes: StrategyFieldChange[] = [];
  const set = (field: "tradeSizeUsd" | "stopLossBps" | "minEntryIntervalSec", after: string | number, loosening: boolean) => {
    const b = (m as unknown as Record<string, unknown>)[field];
    if (String(b) === String(after)) return;
    (m as unknown as Record<string, unknown>)[field] = after;
    changes.push({ scope: market, field, before: b, after, loosening });
  };
  if (ref) {
    m.custom = ref;
    const budgetUsd = Number(turnoverAllocationE8(market, current, vault)) / 1e8;
    const r = specRisk(ref.spec, { budgetUsd, guardStopPct: cur.stopLossBps / 100 });
    const vaultCap = vault ? Number(BigInt(vault.limits.maxTradeUsdE8)) / 1e8 : Infinity;
    const size = Math.max(1, Math.min(r.sizeUsd, vaultCap));
    set("tradeSizeUsd", String(Math.round(size * 100) / 100), size > Number(cur.tradeSizeUsd));
    if (ref.spec.exit.stopLossPct !== undefined) {
      const bps = Math.max(50, Math.round(ref.spec.exit.stopLossPct * 100));
      if (bps < cur.stopLossBps) set("stopLossBps", bps, false);
    }
    const iv = ref.spec.limits.cooldownMin * 60;
    const was = minEntryIntervalSec(market, effectiveMarketParams(market, cur));
    set("minEntryIntervalSec", iv, iv < was);
  } else {
    delete m.custom;
    const iv = DEFAULT_MIN_ENTRY_INTERVAL_SEC[market];
    const was = minEntryIntervalSec(market, effectiveMarketParams(market, cur));
    set("minEntryIntervalSec", iv, iv < was);
  }
  const after = currentRisk(market, next, vault);
  const cmp = compareRisk(before, after);
  changes.unshift({ scope: market, field: "customStrategy", before: refLabel(cur.custom), after: refLabel(ref), loosening: cmp.riskier });
  const riskier = cmp.riskier || changes.some((c) => c.loosening);
  return { next, changes, riskier, reasons: cmp.reasons, before, after };
}
