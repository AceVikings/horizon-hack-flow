import { describe, expect, it } from "vitest";
import { ReasonCode, sellAmountForUsdCap } from "@ate/core";
import {
  candidateId,
  evaluateStop,
  exitChunk,
  explainMarket,
  impactAt,
  newlyOpenedEntryMarkets,
  runEngine,
  sizeForImpact,
  viewOf,
  withProfiles,
} from "../src/index.js";
import { FIXTURE_NOW, MARKET_WBTC, MARKET_WHSK, freshPf, pf, snaps } from "./helpers.js";

const WHSK_CHUNK = sellAmountForUsdCap(2_500_000_000n, 8_800_000n, 8_792_000n, 18).toString(); // floor(25 ÷ 0.088 × 0.99) ≈ 281.25 WHSK

describe("market view", () => {
  it("WBTC gap is ~112.6 bps below the CEX mid (8 dp token)", () => {
    const v = viewOf(snaps()[MARKET_WBTC]);
    expect(v.d).toBe(8);
    expect(v.gapBps).toBeCloseTo(-112.6, 0);
  });
  it("WHSK gap is ~30 bps below the CEX mid (18 dp token)", () => {
    const v = viewOf(snaps()[MARKET_WHSK]);
    expect(v.d).toBe(18);
    expect(v.gapBps).toBeCloseTo(-29.9, 0);
  });
  it("impact interpolates and extrapolates; sizeForImpact inverts it", () => {
    const pts = snaps()[MARKET_WBTC].impact.buy; // 5 USDT → 1 bps, 25 USDT → 5 bps
    expect(impactAt(pts, 15_000_000n)).toBe(3);
    expect(impactAt(pts, 50_000_000n)).toBe(10);
    expect(sizeForImpact(pts, 37.5)).toBe(187_500_000n);
    expect(sizeForImpact([], 10)).toBeGreaterThan(10n ** 30n);
  });
  it("candidate ids are deterministic and well-formed", () => {
    const a = candidateId({ market: MARKET_WBTC, generator: "spread-revert", side: "buy", at: 1, maxAmountIn: "1" });
    expect(a).toMatch(/^cand_[0-9a-f]{16}$/);
    expect(candidateId({ market: MARKET_WBTC, generator: "spread-revert", side: "buy", at: 1, maxAmountIn: "1" })).toBe(a);
  });
});

describe("spread-revert", () => {
  it("fires a default-profile WBTC buy at tradeSizeUsd with ~77 bps net edge", () => {
    const r = runEngine(snaps(), freshPf());
    const c = r.candidates.find((x) => x.market === MARKET_WBTC && x.generator === "spread-revert");
    expect(c).toBeDefined();
    expect(c!.side).toBe("buy");
    expect(c!.leg).toBe("open");
    expect(c!.maxAmountIn).toBe("25000000");
    expect(c!.costBps).toBe(36);
    expect(c!.netEdgeBps).toBeCloseTo(76.6, 0);
    expect(c!.expiresAt).toBe(FIXTURE_NOW + 180);
    expect(c!.profile).toBe("default");
  });
  it("WHSK 30 bps gap vs ~37 bps cost → no spread-revert candidate", () => {
    const r = runEngine(snaps(), freshPf());
    expect(r.candidates.filter((x) => x.market === MARKET_WHSK && x.generator === "spread-revert")).toHaveLength(0);
    expect(explainMarket(snaps()[MARKET_WHSK], freshPf())).toMatch(/below CEX by 29\.9/);
  });
  it("rule 7: WBTC entry 900 s after the last one (< 1800 s) → suppressed entry_interval", () => {
    const r = runEngine(snaps(), pf());
    expect(r.candidates.find((x) => x.market === MARKET_WBTC && x.generator === "spread-revert")).toBeUndefined();
    expect(r.suppressed).toContainEqual(expect.objectContaining({ market: MARKET_WBTC, side: "buy", cause: "entry_interval" }));
  });
  it("two WBTC candidates 120 s apart → the second is suppressed entry_interval", () => {
    const p = freshPf();
    const s = snaps();
    expect(runEngine(s, p).candidates.some((c) => c.market === MARKET_WBTC && c.leg === "open")).toBe(true);
    p.markets[MARKET_WBTC].lastEntryAt = FIXTURE_NOW;
    p.at = FIXTURE_NOW + 120;
    s[MARKET_WBTC].at = FIXTURE_NOW + 120;
    const r2 = runEngine(s, p);
    expect(r2.candidates.some((c) => c.market === MARKET_WBTC && c.leg === "open")).toBe(false);
    expect(r2.suppressed).toContainEqual(expect.objectContaining({ market: MARKET_WBTC, cause: "entry_interval" }));
  });
  it("check() pre-filter ERR_ORACLE_DEVIATION → suppressed deviation with bps, no candidate", () => {
    const s = snaps();
    s[MARKET_WBTC].prefilterBuy = { reason: ReasonCode.ERR_ORACLE_DEVIATION, notionalUsdE8: "2500000000", deviationBps: 262 };
    const r = runEngine(s, freshPf());
    expect(r.candidates.some((c) => c.market === MARKET_WBTC && c.side === "buy")).toBe(false);
    expect(r.suppressed).toEqual([{ market: MARKET_WBTC, side: "buy", cause: "deviation", bps: 262 }]);
  });
  it("Supra–APRO disagreement > 250 bps withholds entries (oracle_disagree)", () => {
    const s = snaps();
    s[MARKET_WBTC].price.supra = { price: "1", updatedAt: FIXTURE_NOW, disagreeBps: 300, active: true };
    const r = runEngine(s, freshPf());
    expect(r.suppressed).toContainEqual({ market: MARKET_WBTC, side: "buy", cause: "oracle_disagree", bps: 300 });
  });
  it("re-entry lock: no buys, no suppression record, sells still emitted", () => {
    const p = freshPf((x) => (x.markets[MARKET_WBTC].reentryLockUntil = FIXTURE_NOW + 100));
    const r = runEngine(snaps(), p);
    expect(r.candidates.some((c) => c.market === MARKET_WBTC && c.side === "buy")).toBe(false);
    expect(r.suppressed).toHaveLength(0);
    expect(r.candidates.some((c) => c.market === MARKET_WBTC && c.generator === "discretionary_exit")).toBe(true);
    expect(r.notes[MARKET_WBTC]!.join()).toMatch(/re-entry lock/);
  });
  it("impact ≤ edge/3 binds the size when tradeSizeUsd is large", () => {
    const p = freshPf((x) => {
      x.strategy.markets[MARKET_WBTC].tradeSizeUsd = "1000";
      x.strategy.portfolio.maxDailyTurnoverUsd = "5000";
      x.turnover.budgetUsd = "5000";
    });
    const s = snaps();
    s[MARKET_WBTC].vault.limits = { ...s[MARKET_WBTC].vault.limits, maxTradeUsdE8: "100000000000", maxEpochUsdE8: "500000000000", maxExposureUsdE8: "100000000000" };
    s[MARKET_WBTC].vault.balanceQuote = "1000000000";
    p.markets[MARKET_WBTC].vault = s[MARKET_WBTC].vault;
    p.strategy.markets[MARKET_WBTC].maxPositionUsd = "1000";
    p.strategy.portfolio.maxPortfolioExposureUsd = "2000";
    const c = runEngine(s, p).candidates.find((x) => x.market === MARKET_WBTC && x.leg === "open")!;
    // edge/3 ≈ 37.5 bps → ~$187.7 with 5 bps per $25
    expect(Number(c.maxAmountIn)).toBeGreaterThan(180_000_000);
    expect(Number(c.maxAmountIn)).toBeLessThan(190_000_000);
    expect(c.reason).toMatch(/impact≤edge\/3/);
  });
  it("pool above CEX with inventory → spread-revert open SELL in token units", () => {
    const s = snaps();
    s[MARKET_WBTC].price.cex!.mid = "7630000000000"; // pool 77144.61 is ~110 bps above 76300
    const c = runEngine(s, freshPf()).candidates.find((x) => x.market === MARKET_WBTC && x.leg === "open")!;
    expect(c.side).toBe("sell");
    expect(BigInt(c.maxAmountIn)).toBeLessThanOrEqual(32_083n);
  });
  it("close leg: FIFO lot sells once the exit mark beats its entry by ≥ minNetEdgeBps", () => {
    const s = snaps();
    s[MARKET_WBTC].exitMark = "7810000000000"; // +22.8 bps vs 77922.55
    const r = runEngine(s, pf());
    const c = r.candidates.find((x) => x.leg === "close")!;
    expect(c.side).toBe("sell");
    expect(c.generator).toBe("spread-revert");
    // capped at maxTradeUsd ÷ max(P,T) × 0.99
    expect(c.maxAmountIn).toBe(sellAmountForUsdCap(2_500_000_000n, 7_792_502_000_000n, 7_716_000_000_000n, 8).toString());
    expect(c.edgeBps).toBeGreaterThanOrEqual(15);
    s[MARKET_WBTC].exitMark = "7800000000000"; // +10 bps: not yet
    expect(runEngine(s, pf()).candidates.find((x) => x.leg === "close")).toBeUndefined();
  });
});

describe("rebalance", () => {
  it("WHSK default profile within band → nothing", () => {
    expect(runEngine(snaps(), freshPf()).candidates.some((c) => c.generator === "rebalance")).toBe(false);
  });
  it("WHSK demo profile: 33.6% vs 40 ± 2 → $5 buy, edge gate waived, labelled demo", () => {
    const p = freshPf((x) => (x.strategy = withProfiles(x.strategy, { WHSK: "demo" })));
    const c = runEngine(snaps(), p).candidates.find((x) => x.generator === "rebalance")!;
    expect(c.market).toBe(MARKET_WHSK);
    expect(c.side).toBe("buy");
    expect(c.maxAmountIn).toBe("5000000");
    expect(c.profile).toBe("demo");
    expect(c.netEdgeBps).toBeLessThan(0);
    expect(c.reason).toMatch(/edge gate waived/);
  });
  it("WBTC can never take the demo profile", () => {
    expect(() => withProfiles(freshPf().strategy, { WBTC: "demo" })).toThrow();
  });
  it("default profile edge gate: below band but negative net edge → no candidate; positive → buy", () => {
    const s = snaps();
    s[MARKET_WHSK].vault.balancePrice = "100000000000000000000"; // 100 WHSK ≈ $8.8 of ~$82 → 10.7%
    expect(runEngine(s, freshPf()).candidates.some((c) => c.generator === "rebalance")).toBe(false);
    s[MARKET_WHSK].price.cex!.mid = "8900000"; // pool 0.0879 now ~124 bps below CEX → favourable buy
    const c = runEngine(s, freshPf()).candidates.find((x) => x.generator === "rebalance" && x.market === MARKET_WHSK);
    expect(c?.side).toBe("buy");
    expect(c!.netEdgeBps).toBeGreaterThanOrEqual(0);
  });
  it("rebalanceTargetPct = 0 sells down regardless of edge (turnover-exempt exit)", () => {
    const p = freshPf((x) => (x.strategy.markets[MARKET_WHSK].rebalanceTargetPct = 0));
    const c = runEngine(snaps(), p).candidates.find((x) => x.generator === "rebalance")!;
    expect(c.side).toBe("sell");
    expect(c.maxAmountIn).toBe(WHSK_CHUNK);
  });
});

describe("guard exits (§11.4 rules 4, 6, 9)", () => {
  it("stop-loss fires on avg-cost entry vs exit-executable mark; entries withheld", () => {
    const p = freshPf((x) => (x.markets[MARKET_WBTC].position.avgEntry = "8000000000000")); // mark 76670 → −416 bps
    const s = snaps();
    s[MARKET_WBTC].price.pool.twap = "7667000000000";
    const r = runEngine(s, p);
    const g = r.candidates.filter((c) => c.market === MARKET_WBTC && c.generator === "guard_exit");
    expect(g).toHaveLength(1);
    expect(g[0]!.guardReason).toBe("stop_loss");
    expect(r.candidates.some((c) => c.market === MARKET_WBTC && c.leg === "open")).toBe(false);
  });
  it("stop-loss waits while the mark disagrees with the TWAP by > maxOracleDeviationBps", () => {
    const p = freshPf((x) => (x.markets[MARKET_WBTC].position.avgEntry = "8000000000000"));
    const s = snaps();
    s[MARKET_WBTC].price.pool.twap = "7900000000000"; // mark 76670 is ~295 bps below
    expect(evaluateStop(s[MARKET_WBTC], p).waiting).toBe(true);
    expect(runEngine(s, p).candidates.some((c) => c.generator === "guard_exit")).toBe(false);
  });
  it("take-profit on WHSK (18 dp)", () => {
    const p = freshPf((x) => (x.markets[MARKET_WHSK].position.avgEntry = "8500000")); // mark 0.08735714 → +277 bps
    const s = snaps();
    s[MARKET_WHSK].price.pool.twap = "8740000";
    const g = runEngine(s, p).candidates.find((c) => c.generator === "guard_exit")!;
    expect(g.guardReason).toBe("take_profit");
    expect(g.maxAmountIn).toBe(WHSK_CHUNK);
  });
  it("target_assets de-selection → immediate guard_exit sell-down on WHSK, no WHSK entries", () => {
    const p = freshPf((x) => (x.strategy.portfolio.targetAssets = ["WBTC"]));
    const r = runEngine(snaps(), p);
    const g = r.candidates.find((c) => c.market === MARKET_WHSK && c.generator === "guard_exit")!;
    expect(g.guardReason).toBe("target_assets");
    expect(r.candidates.some((c) => c.market === MARKET_WBTC && c.leg === "open")).toBe(true);
  });
  it("breaker flattening → guard exits on both markets, no entries", () => {
    const p = freshPf((x) => (x.breaker = { state: "flattening", since: FIXTURE_NOW }));
    const r = runEngine(snaps(), p);
    expect(r.candidates.filter((c) => c.generator === "guard_exit").map((c) => c.guardReason)).toEqual(["breaker", "breaker"]);
    expect(r.candidates.some((c) => c.generator === "spread-revert" && c.leg === "open")).toBe(false);
  });
  it("paused vault → nothing at all", () => {
    const s = snaps();
    s[MARKET_WBTC].vault.paused = true;
    expect(runEngine(s, freshPf()).candidates.some((c) => c.market === MARKET_WBTC)).toBe(false);
  });
});

describe("discretionary_exit and USD caps", () => {
  it("standing discretionary exit per held position, token-converted at max(P, T) × 0.99", () => {
    const r = runEngine(snaps(), freshPf());
    const w = r.candidates.find((c) => c.market === MARKET_WHSK && c.generator === "discretionary_exit")!;
    const b = r.candidates.find((c) => c.market === MARKET_WBTC && c.generator === "discretionary_exit")!;
    expect(w.maxAmountIn).toBe(WHSK_CHUNK);
    expect(b.maxAmountIn).toBe(sellAmountForUsdCap(2_500_000_000n, 7_792_502_000_000n, 7_716_000_000_000n, 8).toString()); // 31761 sats
  });
  it("exit chunk is bounded by the epoch remaining", () => {
    const s = snaps();
    s[MARKET_WBTC].vault.epoch.spentUsdE8 = "24000000000"; // $10 left
    expect(exitChunk(s[MARKET_WBTC], 32_083n)).toBe(sellAmountForUsdCap(1_000_000_000n, 7_792_502_000_000n, 7_716_000_000_000n, 8));
  });
  it("newlyOpenedEntryMarkets detects a gap opening between scans", () => {
    const after = runEngine(snaps(), freshPf()).candidates;
    expect(newlyOpenedEntryMarkets([], after)).toEqual([MARKET_WBTC]);
    expect(newlyOpenedEntryMarkets(after, after)).toEqual([]);
  });
});
