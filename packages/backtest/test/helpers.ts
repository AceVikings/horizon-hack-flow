import { parseStrategySpec, type StrategySpec } from "@ate/core";
import { DEFAULT_SIM_LIMITS, type MarketHistory, type SimInput } from "../src/index.js";

export const BTC = "hsk-dex:WBTC/USDT:3000" as const;
export const HSK = "hsk-dex:WHSK/USDT:3000" as const;
export const FROM = 1_790_000_000 - (1_790_000_000 % 86_400);

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic market: the exchange price random-walks; the pool trades every ~10 min and its gap to the exchange
 * mean-reverts (sometimes > 1% under, then closes) — enough structure for a gap strategy to trade.
 */
export function synthHistory(market: typeof BTC | typeof HSK, days: number, seed = 7): MarketHistory {
  const r = rng(seed);
  const to = FROM + days * 86_400;
  const cex: { t: number; v: number }[] = [];
  const pool: { t: number; v: number; vol: number }[] = [];
  let p = market === BTC ? 100_000 : 0.5;
  let gap = 0;
  for (let t = FROM - 86_400; t <= to; t += 60) {
    p *= 1 + (r() - 0.5) * 0.002;
    cex.push({ t: t + 60, v: p });
    gap = gap * 0.97 + (r() - 0.52) * 0.0016;
    if (t % 600 === 0) pool.push({ t: t + Math.floor(r() * 60), v: p * (1 + gap), vol: 20 + r() * 200 });
  }
  const oracle = cex.filter((_, k) => k % 60 === 0).map((x) => ({ t: x.t, v: x.v * 1.001 }));
  return { market, from: FROM, to, pool, cex, oracle, depthUsd: 50_000, depthSource: "a test depth of $50,000", feeBps: 30, halfSpreadBps: 1, notes: [] };
}

export function spec(over: Record<string, unknown> = {}): StrategySpec {
  const r = parseStrategySpec({
    name: "Gap buyer",
    kind: "rules",
    markets: ["BTC"],
    entry: { conditions: [{ signal: "gap_cex", op: "below", value: -0.6 }] },
    exit: { takeProfitPct: 0.5, stopLossPct: 2 },
    sizing: { mode: "usd", value: 25 },
    limits: { maxTradesPerDay: 6, cooldownMin: 30 },
    ...over,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
}

export function input(days = 7, s: StrategySpec = spec()): SimInput {
  return { spec: s, histories: [synthHistory(BTC, days)], limits: DEFAULT_SIM_LIMITS, from: FROM, to: FROM + days * 86_400 };
}
