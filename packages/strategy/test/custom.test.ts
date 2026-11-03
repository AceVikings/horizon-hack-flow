import { describe, expect, it } from "vitest";
import { compareRisk, describeStrategy, parseStrategySpec, specRisk, type CustomStrategyRef, type StrategySpec } from "@ate/core";
import { CustomState, LiveHistory, SignalBook, barsFromPoints, currentRisk, customActivation, customDrafts, decideRules, recordSnapshot, runEngine, type Bar } from "../src/index.js";
import { FIXTURE_NOW, MARKET_WBTC, freshPf, snaps } from "./helpers.js";

const spec = (over: Partial<StrategySpec> = {}): StrategySpec => {
  const r = parseStrategySpec({
    name: "Gap buyer",
    kind: "rules",
    markets: ["BTC"],
    entry: { conditions: [{ signal: "gap_cex", op: "below", value: -1 }] },
    exit: { takeProfitPct: 0.8, stopLossPct: 2 },
    sizing: { mode: "usd", value: 25 },
    limits: { maxTradesPerDay: 4, cooldownMin: 30 },
    ...over,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
};
const ref = (s: StrategySpec): CustomStrategyRef => ({ id: "stg_1", version: 1, hash: "0xabc", name: s.name, kind: s.kind, spec: s });

describe("strategy spec", () => {
  it("validates and fills defaults", () => {
    const s = spec();
    expect(s.schema).toBe("flow.strategy/v1");
    expect(s.barMinutes).toBe(5);
    expect(s.exit.conditions).toEqual([]);
  });
  it("rejects a spec with no way to sell, and P&L entries", () => {
    const r = parseStrategySpec({ name: "x", kind: "rules", markets: ["HSK"], entry: { conditions: [{ signal: "pnl", op: "above", value: 1 }] }, exit: {}, sizing: { mode: "usd", value: 5 }, limits: { maxTradesPerDay: 1, cooldownMin: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/sell/);
  });
  it("reads back as plain sentences", () => {
    expect(describeStrategy(spec())).toEqual([
      "Buys $25 of BTC when the pool price is more than 1% under the HashKey Global exchange price.",
      "Sells when it is up 0.8% or it is down 2%.",
      "At most 4 buys a day, at least 30 minutes apart.",
      "Your vault limits and safety rules always apply on top.",
    ]);
    const ai = spec({ kind: "ai", instructions: "skip when BTC is falling fast", entry: { when: "all", conditions: [{ signal: "rsi", op: "below", value: 30 }, { signal: "hour", op: "between", value: 8, value2: 16 }] } });
    expect(describeStrategy(ai)[0]).toBe("Buys $25 of BTC when RSI(14) is below 30 and the time is between 08:00 and 16:00 UTC.");
    expect(describeStrategy(ai)[3]).toMatch(/never more/);
  });
  it("compares risk field by field", () => {
    const a = specRisk(spec(), { budgetUsd: 100, guardStopPct: 3 });
    expect(a).toEqual({ sizeUsd: 25, stopPct: 2, tradesPerDay: 4, cooldownMin: 30 });
    expect(compareRisk(a, { ...a, sizeUsd: 50 }).riskier).toBe(true);
    expect(compareRisk(a, { ...a, cooldownMin: 60, tradesPerDay: 2 }).riskier).toBe(false);
    expect(compareRisk(a, { ...a, stopPct: 3 }).reasons[0]).toMatch(/looser stop/);
  });
});

describe("signals", () => {
  const bars: Bar[] = Array.from({ length: 60 }, (_, i) => ({ t: i * 300, pool: 100 + Math.sin(i / 3) * 2, cex: 101, oracle: 100, vol: 10 }));
  it("never look ahead: values at bar i ignore later bars", () => {
    const a = new SignalBook(bars, 300);
    const changed = bars.map((b, i) => (i > 40 ? { ...b, pool: 999, cex: 1 } : b));
    const b = new SignalBook(changed, 300);
    for (const c of [
      { signal: "ema", op: "above", value: 0, period: 10 },
      { signal: "rsi", op: "below", value: 30, period: 14 },
      { signal: "bollinger", op: "below", value: 0, period: 20 },
      { signal: "vwap", op: "above", value: 0, period: 20 },
      { signal: "change", op: "below", value: -1, windowMin: 30 },
      { signal: "gap_cex", op: "below", value: -1 },
    ] as const)
      for (let i = 0; i <= 40; i++) expect(b.value(c, i)).toBe(a.value(c, i));
  });
  it("gap, change, hour", () => {
    const sb = new SignalBook(bars, 300);
    expect(sb.value({ signal: "gap_cex", op: "below", value: -1 }, 0)).toBeCloseTo(-0.99, 2);
    expect(sb.holds({ signal: "hour", op: "between", value: 22, value2: 2 }, 0)).toBe(true);
    expect(sb.holds({ signal: "hour", op: "between", value: 8, value2: 16 }, 0)).toBe(false);
    expect(SignalBook.warmup(spec({ entry: { when: "all", conditions: [{ signal: "change", op: "below", value: -1, windowMin: 60 }] } }))).toBe(13);
  });
  it("bars carry the last price at or before each close", () => {
    const b = barsFromPoints(60, 0, 180, [{ t: 10, v: 1, vol: 5 }, { t: 70, v: 2 }], [{ t: 60, v: 1.1 }], []);
    expect(b.map((x) => x.pool)).toEqual([1, 2, 2, 2]);
    expect(b[0]!.cex).toBe(null);
    expect(b[1]!.cex).toBe(1.1);
    expect(b[0]!.vol).toBe(5);
  });
});

describe("live custom generator", () => {
  it("emits a custom buy bound by the guard caps, and the rules engine takes it", () => {
    const s = snaps();
    const p = freshPf((x) => {
      x.strategy.markets[MARKET_WBTC].custom = ref(spec());
    });
    const h = new LiveHistory();
    recordSnapshot(h, s[MARKET_WBTC]);
    const r = customDrafts(s[MARKET_WBTC], p, ref(spec()), h, new CustomState());
    // the fixture holds BTC above dust with an exit mark: the spec's stop/TP do not fire, so the gap entry fires
    expect(r.drafts.map((d) => [d.generator, d.leg, d.side])).toEqual([["custom", "open", "buy"]]);
    expect(BigInt(r.drafts[0]!.maxAmountIn)).toBeLessThanOrEqual(25_000_000n);
    const eng = runEngine({ [MARKET_WBTC]: s[MARKET_WBTC] }, p);
    const c = eng.candidates.find((x) => x.generator === "custom");
    expect(c?.strategy?.name).toBe("Gap buyer");
    expect(eng.candidates.some((x) => x.generator === "spread-revert" && x.leg === "open")).toBe(false);
    const act = decideRules([MARKET_WBTC], eng.candidates, eng.suppressed, FIXTURE_NOW);
    expect(act[0]!.kind).toBe("propose");
  });
  it("respects the day's buy count", () => {
    const s = snaps();
    const one = spec({ limits: { maxTradesPerDay: 1, cooldownMin: 0 } });
    const st = new CustomState();
    const p = freshPf((x) => {
      x.markets[MARKET_WBTC].lastEntryAt = FIXTURE_NOW - 60;
    });
    const h = new LiveHistory();
    recordSnapshot(h, s[MARKET_WBTC]);
    const r = customDrafts(s[MARKET_WBTC], p, ref(one), h, st);
    expect(r.drafts).toEqual([]);
    expect(r.notes[0]).toMatch(/1 buys today/);
  });
});

describe("activation", () => {
  it("a bigger, busier strategy is riskier; a smaller one applies at once", () => {
    const s = freshPf().strategy;
    const big = customActivation(MARKET_WBTC, ref(spec({ sizing: { mode: "usd", value: 100 }, limits: { maxTradesPerDay: 20, cooldownMin: 0 } })), s);
    expect(big.riskier).toBe(true);
    expect(big.changes[0]!.field).toBe("customStrategy");
    const small = customActivation(MARKET_WBTC, ref(spec({ sizing: { mode: "usd", value: 5 }, limits: { maxTradesPerDay: 1, cooldownMin: 60 } })), s);
    expect(small.riskier).toBe(false);
    expect(small.next.markets[MARKET_WBTC].custom?.name).toBe("Gap buyer");
    expect(Number(small.next.markets[MARKET_WBTC].tradeSizeUsd)).toBe(5);
    const stop = customActivation(MARKET_WBTC, null, small.next);
    expect(stop.next.markets[MARKET_WBTC].custom).toBeUndefined();
    expect(currentRisk(MARKET_WBTC, small.next).sizeUsd).toBe(5);
  });
});

describe("price-action signals", () => {
  // a range, then a breakout and an uptrend
  const closes = [...Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 2)), ...Array.from({ length: 40 }, (_, i) => 101 + i * 0.3)];
  const bars: Bar[] = closes.map((v, i) => ({ t: i * 300, pool: v, cex: v, oracle: v, vol: i > 100 ? 50 : 10 }));
  const sb = new SignalBook(bars, 300);
  it("breakout above resistance fires on the crossing bar only", () => {
    const c = { signal: "resistance", op: "crosses_above", value: 0, period: 48 } as const;
    const hits = bars.map((_, i) => sb.holds(c, i)).flatMap((x, i) => (x ? [i] : []));
    expect(hits.some((i) => i >= 80 && i <= 85)).toBe(true);
    // during the steady climb the price keeps making new highs, but "crosses" needs the previous bar at or under it
    expect(hits.filter((i) => i > 85).length).toBeLessThan(5);
  });
  it("golden cross, trend, volatility and volume", () => {
    const cross = bars.map((_, i) => sb.holds({ signal: "ma_cross", op: "crosses_above", value: 0, period: 5, period2: 20 }, i));
    expect(cross.some(Boolean)).toBe(true);
    expect(sb.value({ signal: "trend", op: "above", value: 0, period: 20 }, 119)!).toBeGreaterThan(0);
    expect(sb.value({ signal: "volatility", op: "below", value: 1, period: 24 }, 119)!).toBeGreaterThan(0);
    expect(sb.value({ signal: "volume", op: "above", value: 150, period: 6 }, 119)!).toBeGreaterThan(150);
  });
  it("reads back in plain words", () => {
    expect(describeStrategy(spec({ entry: { when: "all", conditions: [{ signal: "ma_cross", op: "crosses_above", value: 0, period: 20, period2: 50 }, { signal: "rsi", op: "below", value: 70 }, { signal: "volatility", op: "below", value: 0.5, period: 24 }] } }))[0]).toBe(
      "Buys $25 of BTC when the 20-bar EMA crosses above the 50-bar one, RSI(14) is below 70 and the market is calm (price swings under 0.5% per bar).",
    );
    expect(describeStrategy(spec({ entry: { when: "all", conditions: [{ signal: "resistance", op: "crosses_above", value: 0, period: 48 }, { signal: "trend", op: "above", value: 0, period: 50 }] } }))[0]).toBe(
      "Buys $25 of BTC when the price breaks above its 48-bar high and the trend is up (50-bar EMA rising).",
    );
  });
});
