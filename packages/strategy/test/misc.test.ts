import { describe, expect, it } from "vitest";
import { MARKET_WBTC, MARKET_WHSK, type StrategyPatch } from "@ate/core";
import { FIXTURE_STRATEGY, FIXTURE_VAULT_STATES } from "@ate/core/fixtures";
import {
  applyFill,
  applyPatch,
  avgEntryE8,
  decideRules,
  emptyBook,
  initialBreaker,
  needsMarketScope,
  pnl,
  renderDiff,
  runEngine,
  scoreVeto,
  seedBook,
  stepBreaker,
  toPositionBook,
  withProfiles,
} from "../src/index.js";
import { FIXTURE_NOW, freshPf, snaps } from "./helpers.js";

describe("ledger: avg cost + FIFO lots", () => {
  it("WBTC (8 dp): buy lot, partial sell realises vs avg and FIFO lot", () => {
    let b = emptyBook();
    b = applyFill(b, { id: "f1", market: MARKET_WBTC, side: "buy", baseQty: 32_083n, quoteQty: 25_000_000n, generator: "spread-revert", leg: "open", at: 1 });
    expect(avgEntryE8(b, 8)).toBe(7_792_288_751_051n); // 25 / 0.00032083 = 77922.8875
    expect(b.lots).toHaveLength(1);
    b = applyFill(b, { id: "f2", market: MARKET_WBTC, side: "buy", baseQty: 32_000n, quoteQty: 25_000_000n, generator: "discretionary", at: 2 });
    expect(b.lots).toHaveLength(1);
    // Sell the lot's qty at 78,500 → lot consumed first; realised vs avg.
    b = applyFill(b, { id: "f3", market: MARKET_WBTC, side: "sell", baseQty: 32_083n, quoteQty: 25_185_155n, generator: "spread-revert", leg: "close", at: 3 });
    expect(b.qty).toBe(32_000n);
    expect(b.lots[0]!.qtyRemaining).toBe("0");
    expect(b.lots[0]!.closedAt).toBe(3);
    expect(Number(b.lotsRealisedE8)).toBeGreaterThan(0.18e8);
    const pos = toPositionBook(b, MARKET_WBTC);
    expect(pos.lots).toHaveLength(0);
    expect(Number(pos.realisedUsd)).toBeGreaterThan(0);
  });
  it("WHSK (18 dp): seed at APRO, P&L two ways, never blended", () => {
    const b = seedBook(420n * 10n ** 18n, 8_800_000n, 18);
    expect(avgEntryE8(b, 18)).toBe(8_800_000n);
    const v = pnl(b, MARKET_WHSK, 8_735_714n, 8_816_400n);
    expect(v.unrealisedExitBps).toBeCloseTo(-73.05, 1);
    expect(v.unrealisedCexBps).toBeCloseTo(18.63, 1);
    expect(v.unrealisedExitUsd).toBe("-0.27");
    expect(v.unrealisedCexUsd).toBe("0.07");
  });
});

describe("breaker (rule 6)", () => {
  it("armed → flattening at the limit → paused after 2 cycles even if exits are blocked", () => {
    let s = initialBreaker("2026-11-02");
    const base = { utcDay: "2026-11-02", dailyLossLimitUsd: "10", flat: false, cycle: true };
    let r = stepBreaker(s, { ...base, now: 100, dailyPnlUsd: "-9.99" });
    expect(r.state.state).toBe("armed");
    r = stepBreaker(r.state, { ...base, now: 110, dailyPnlUsd: "-10" });
    expect(r.state.state).toBe("flattening");
    expect(r.actions).toEqual(["invalidate_buys", "flatten", "notify"]);
    r = stepBreaker(r.state, { ...base, now: 230, dailyPnlUsd: "-11" });
    expect(r.state.state).toBe("flattening");
    r = stepBreaker(r.state, { ...base, now: 350, dailyPnlUsd: "-11" });
    expect(r.state.state).toBe("tripped");
    expect(r.actions).toEqual(["pause_all", "notify", "journal_unflattened"]);
    s = r.state;
    expect(stepBreaker(s, { ...base, utcDay: "2026-11-03", now: 90_000, dailyPnlUsd: "0" }).state.state).toBe("armed");
  });
  it("5 min bound without cycles; flat → pause without unflattened record", () => {
    let r = stepBreaker(initialBreaker("d"), { now: 0, utcDay: "d", dailyPnlUsd: "-20", dailyLossLimitUsd: "10", flat: false, cycle: false });
    r = stepBreaker(r.state, { now: 300, utcDay: "d", dailyPnlUsd: "-20", dailyLossLimitUsd: "10", flat: false, cycle: false });
    expect(r.state.state).toBe("tripped");
    let q = stepBreaker(initialBreaker("d"), { now: 0, utcDay: "d", dailyPnlUsd: "-20", dailyLossLimitUsd: "10", flat: false, cycle: false });
    q = stepBreaker(q.state, { now: 10, utcDay: "d", dailyPnlUsd: "-20", dailyLossLimitUsd: "10", flat: true, cycle: false });
    expect(q.actions).toEqual(["pause_all", "notify"]);
  });
});

describe("outcome scoring (E13)", () => {
  it("vetoed buy that would have lost → positive saved; that would have won → negative", () => {
    expect(scoreVeto({ side: "buy", declinedAmountIn: 25_000_000n, quotedPriceE8: 7_800_000_000_000n, markThenE8: 7_722_000_000_000n, d: 8 })).toEqual({ savedBps: 100, savedUsd: "0.25" });
    expect(scoreVeto({ side: "buy", declinedAmountIn: 25_000_000n, quotedPriceE8: 7_800_000_000_000n, markThenE8: 7_839_000_000_000n, d: 8 })).toEqual({ savedBps: -50, savedUsd: "-0.125" });
  });
  it("vetoed sell (WHSK): holding gained → positive", () => {
    const r = scoreVeto({ side: "sell", declinedAmountIn: 100n * 10n ** 18n, quotedPriceE8: 8_800_000n, markThenE8: 8_888_000n, d: 18 });
    expect(r.savedBps).toBe(100);
    expect(r.savedUsd).toBe("0.088");
  });
});

describe("patcher (§11.5 loosening table)", () => {
  const vaults = FIXTURE_VAULT_STATES;
  const cur = FIXTURE_STRATEGY;
  const apply = (patch: StrategyPatch, scope: "agent" | "chat" = "chat") => applyPatch(patch, scope, cur, cur, vaults);
  const cases: [StrategyPatch, boolean][] = [
    [{ market: MARKET_WHSK, stopLossBps: 400 }, true],
    [{ market: MARKET_WHSK, stopLossBps: 50 }, false],
    [{ dailyLossLimitUsd: "20" }, true],
    [{ dailyLossLimitUsd: "5" }, false],
    [{ market: MARKET_WBTC, maxPositionUsd: "100" }, false],
    [{ maxDailyTurnoverUsd: "150" }, false],
    [{ maxPortfolioExposureUsd: "250" }, true],
    [{ tradeSizeUsd: "10" }, false],
    [{ discretionaryTradesPerDay: 1 }, false],
    [{ discretionaryUsd: "5" }, false],
    [{ market: MARKET_WHSK, rebalanceTargetPct: 20 }, false],
    [{ market: MARKET_WHSK, rebalanceTargetPct: 0 }, false],
    [{ market: MARKET_WHSK, rebalanceTargetPct: 60 }, true],
    [{ market: MARKET_WBTC, rebalanceTargetPct: 10 }, true], // null → 10 > 0
    [{ entrySpreadBps: 100 }, false],
    [{ entrySpreadBps: 40 }, true],
    [{ minNetEdgeBps: 10 }, true],
    [{ minNetEdgeBps: 25 }, false],
    [{ cycleSeconds: 60 }, true],
    [{ cycleSeconds: 300 }, false],
    [{ reentryCooldownSec: 600 }, true],
    [{ reentryCooldownSec: 20_000 }, false],
    [{ market: MARKET_WHSK, rebalanceBandPct: 2 }, true],
    [{ market: MARKET_WHSK, rebalanceBandPct: 20 }, false],
    [{ market: MARKET_WHSK, takeProfitBps: 100 }, true],
    [{ targetAssets: ["WBTC"] }, false],
    [{ targetAssets: [] }, false],
    [{ enabled: false }, false],
  ];
  for (const [patch, loosening] of cases) {
    it(`${JSON.stringify(patch)} → ${loosening ? "needs approval" : "applies at once"}`, () => {
      const r = apply(patch);
      expect(r.changes.length).toBeGreaterThan(0);
      expect(r.needsApproval).toBe(loosening);
    });
  }
  it("adding a target asset / enabling loosens", () => {
    const off = { ...cur, enabled: false, portfolio: { ...cur.portfolio, targetAssets: ["WBTC" as const] } };
    expect(applyPatch({ targetAssets: ["WBTC", "WHSK"] }, "chat", off, cur, vaults).needsApproval).toBe(true);
    expect(applyPatch({ enabled: true }, "chat", off, cur, vaults).needsApproval).toBe(true);
  });
  it("raising turnover loosens; above Σ vault (maxEpoch − maxExposure) it is clamped", () => {
    const low = { ...cur, portfolio: { ...cur.portfolio, maxDailyTurnoverUsd: "150" } };
    expect(applyPatch({ maxDailyTurnoverUsd: "250" }, "chat", low, cur, vaults)).toMatchObject({ needsApproval: true, clamped: true });
    expect(apply({ maxDailyTurnoverUsd: "250" }).next.portfolio.maxDailyTurnoverUsd).toBe("200");
  });
  it("clamps to on-chain limits and says so", () => {
    const r = apply({ market: MARKET_WHSK, maxPositionUsd: "500" });
    expect(r.clamped).toBe(true);
    expect(r.next.markets[MARKET_WHSK].maxPositionUsd).toBe("150");
    expect(r.changes[0]).toMatchObject({ requested: "500", clampedBy: "vault maxExposureUsd" });
    expect(apply({ discretionaryUsd: "50" }).next.portfolio.discretionaryUsd).toBe("10");
    expect(apply({ tradeSizeUsd: "100" }).next.markets[MARKET_WBTC].tradeSizeUsd).toBe("25");
  });
  it("riskProfile: conservative tightens at once; aggressive loosens (explicit fields win)", () => {
    const c = apply({ riskProfile: "conservative" });
    expect(c.needsApproval).toBe(false);
    expect(c.next.markets[MARKET_WBTC]).toMatchObject({ tradeSizeUsd: "10", entrySpreadBps: 90, minNetEdgeBps: 25, stopLossBps: 200, maxPositionUsd: "75" });
    const a = apply({ riskProfile: "aggressive", stopLossBps: 250 });
    expect(a.needsApproval).toBe(true);
    expect(a.next.markets[MARKET_WHSK].stopLossBps).toBe(250);
    expect(a.next.markets[MARKET_WHSK].entrySpreadBps).toBe(45);
  });
  it("riskProfile on a demo-profile market applies only stopLossBps and maxPositionUsd", () => {
    const demo = withProfiles(cur, { WHSK: "demo" });
    const r = applyPatch({ riskProfile: "conservative" }, "chat", demo, demo, vaults);
    expect(r.next.markets[MARKET_WHSK].entrySpreadBps).toBe(10);
    expect(r.next.markets[MARKET_WHSK].stopLossBps).toBe(200);
    expect(r.next.markets[MARKET_WBTC].entrySpreadBps).toBe(90);
  });
  it("agent scope: only tunables, clamped to ×0.5–×1.5 of the human anchors, never needs approval", () => {
    expect(() => apply({ stopLossBps: 100 }, "agent")).toThrow(/agent scope/);
    const r = apply({ entrySpreadBps: 10, tradeSizeUsd: "100", cycleSeconds: 30 }, "agent");
    expect(r.next.markets[MARKET_WBTC].entrySpreadBps).toBe(30);
    expect(r.next.markets[MARKET_WBTC].tradeSizeUsd).toBe("25"); // ×1.5 = 37.5 but vault maxTrade $25
    expect(r.next.markets[MARKET_WBTC].cycleSeconds).toBe(60);
    expect(r.needsApproval).toBe(false);
    expect(renderDiff(r.changes)).toMatch(/BTC\.entrySpreadBps: 60 → 30/);
  });
  it("stop-loss without a market must be scoped by the chat first", () => {
    expect(needsMarketScope({ stopLossBps: 200 })).toBe(true);
    expect(needsMarketScope({ market: MARKET_WHSK, stopLossBps: 200 })).toBe(false);
  });
});

describe("rules engine", () => {
  it("takes the WBTC spread-revert buy and records no_trade on WHSK", () => {
    const r = runEngine(snaps(), freshPf());
    const acts = decideRules([MARKET_WHSK, MARKET_WBTC], r.candidates, r.suppressed, FIXTURE_NOW);
    expect(acts[0]).toMatchObject({ kind: "no_trade", market: MARKET_WHSK, reason: "no_signal" });
    expect(acts[1]).toMatchObject({ kind: "propose", market: MARKET_WBTC, amountIn: "25000000" });
    expect(acts[1]!.kind === "propose" && acts[1]!.candidate.generator).toBe("spread-revert");
  });
  it("never takes discretionary_exit; guard exits are left to the daemon", () => {
    const p = freshPf((x) => (x.strategy.portfolio.targetAssets = ["WBTC"]));
    const r = runEngine(snaps(), p);
    const acts = decideRules([MARKET_WHSK], r.candidates, r.suppressed, FIXTURE_NOW);
    expect(acts[0]).toMatchObject({ kind: "no_trade", reason: "guard" });
  });
});
