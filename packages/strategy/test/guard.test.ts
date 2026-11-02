import { describe, expect, it } from "vitest";
import type { GuardVerdict, OpenProposal, PortfolioState } from "@ate/core";
import { checkProposal, createInvalidation, createReservations, createStrategyGuard, exitReserveBuyCapE8, exitReserveOk } from "../src/index.js";
import { FIXTURE_NOW, MARKET_WBTC, MARKET_WHSK, draft, freshPf, pf, setExposure } from "./helpers.js";

const WBTC_BUY = "cand_0b5e2c7a9d1f4e60";
const WBTC_DX = "cand_7f3a91d2c4b8e015";
const WHSK_DX = "cand_c0ffee12ab34cd56";

const buy25 = (over: Partial<Parameters<typeof draft>[0]> = {}) =>
  draft({ market: MARKET_WBTC, side: "buy", amountIn: "25000000", notionalUsdE8: "2500000000", candidateId: WBTC_BUY, generator: "spread-revert", leg: "open", ...over });

const fails = (v: GuardVerdict) => (v.ok ? null : { code: v.code, rule: v.rule });

describe("rule 1: candidate binding", () => {
  const g = createStrategyGuard();
  it("accepts a bound WBTC buy ≤ maxAmountIn and reserves its turnover", () => {
    const v = g.check(buy25(), freshPf(), "propose");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.reserve).toMatchObject({ market: MARKET_WBTC, turnoverUsd: "25", discretionary: 0, candidateId: WBTC_BUY });
  });
  it("missing candidateId → ATE_CANDIDATE_REQUIRED", () => {
    expect(fails(g.check(buy25({ candidateId: undefined }), freshPf(), "propose"))).toEqual({ code: "ATE_CANDIDATE_REQUIRED", rule: "candidate_binding" });
  });
  it("wrong side / wrong market / oversize / unknown → ATE_CANDIDATE_MISMATCH", () => {
    expect(fails(g.check(buy25({ side: "sell" }), freshPf(), "propose"))?.code).toBe("ATE_CANDIDATE_MISMATCH");
    expect(fails(g.check(buy25({ market: MARKET_WHSK }), freshPf(), "propose"))?.code).toBe("ATE_CANDIDATE_MISMATCH");
    expect(fails(g.check(buy25({ amountIn: "25000001" }), freshPf(), "propose"))?.code).toBe("ATE_CANDIDATE_MISMATCH");
    expect(fails(g.check(buy25({ candidateId: "cand_ffffffffffffffff" }), freshPf(), "propose"))?.code).toBe("ATE_CANDIDATE_MISMATCH");
  });
  it("expired candidate → mismatch at propose", () => {
    expect(fails(g.check(buy25(), freshPf((p) => (p.at = FIXTURE_NOW + 181)), "propose"))?.code).toBe("ATE_CANDIDATE_MISMATCH");
  });
  it("single-use: consumed by another proposal → mismatch; by itself at execute → ok", () => {
    const p = freshPf((x) => (x.candidates[WBTC_BUY]!.consumedBy = "prop_aaaaaaaaaaaaaaaa"));
    expect(fails(g.check(buy25({ proposalId: "prop_bbbbbbbbbbbbbbbb" }), p, "execute"))?.code).toBe("ATE_CANDIDATE_MISMATCH");
    expect(g.check(buy25({ proposalId: "prop_aaaaaaaaaaaaaaaa" }), p, "execute").ok).toBe(true);
  });
  it("confirm mode accepts unbound proposals", () => {
    expect(g.check(buy25({ candidateId: undefined, mode: "confirm" }), freshPf((x) => (x.mode = "confirm")), "propose").ok).toBe(true);
  });
});

describe("rule 2: position limits (buys only)", () => {
  const g = createStrategyGuard();
  it("per-market exposure ≤ maxPositionUsd", () => {
    const p = freshPf((x) => setExposure(x, null, MARKET_WBTC, 130));
    expect(fails(g.check(buy25(), p, "propose"))).toEqual({ code: "ATE_STRATEGY_BLOCKED", rule: "position_limit" });
  });
  it("portfolio Σ exposure ≤ maxPortfolioExposureUsd", () => {
    const p = freshPf((x) => setExposure(x, null, MARKET_WHSK, 160));
    expect(fails(g.check(buy25(), p, "propose"))?.rule).toBe("portfolio_exposure");
  });
  it("sells are not position-limited", () => {
    const p = freshPf((x) => setExposure(x, null, MARKET_WBTC, 149));
    expect(g.check(draft({ market: MARKET_WBTC, side: "sell", amountIn: "31000", notionalUsdE8: "2400000000", candidateId: WBTC_DX, generator: "discretionary_exit" }), p, "propose").ok).toBe(true);
  });
});

describe("rule 3: turnover budget", () => {
  const g = createStrategyGuard();
  it("market share (min($200/2, maxEpoch − maxExposure) = $100) is enforced", () => {
    const p = freshPf((x) => (x.markets[MARKET_WBTC].turnover.usedUsd = "80"));
    expect(fails(g.check(buy25(), p, "propose"))?.rule).toBe("turnover_budget");
  });
  it("reservations count; at execute the proposal's own reservation is not double counted", () => {
    const p = freshPf((x) => {
      x.markets[MARKET_WBTC].turnover = { allocationUsd: "100", usedUsd: "50", reservedUsd: "25" };
      x.turnover.reservedUsd = "25";
      x.openProposals = [
        { proposalId: "prop_1111111111111111", market: MARKET_WBTC, side: "buy", origin: "candidate", status: "approved", amountIn: "25000000", reservedTurnoverUsd: "25", createdAt: FIXTURE_NOW, expiresAt: FIXTURE_NOW + 120 },
      ];
    });
    expect(g.check(buy25({ proposalId: "prop_1111111111111111" }), p, "execute").ok).toBe(true);
    p.markets[MARKET_WBTC].turnover.usedUsd = "80";
    expect(fails(g.check(buy25({ proposalId: "prop_1111111111111111" }), p, "execute"))?.rule).toBe("turnover_budget");
  });
  it("one target asset gets the whole budget, clamped to the vault's $100", () => {
    const p = freshPf((x) => {
      x.strategy.portfolio.targetAssets = ["WBTC"];
      x.markets[MARKET_WBTC].turnover.usedUsd = "74";
    });
    expect(g.check(buy25(), p, "propose").ok).toBe(true);
    p.markets[MARKET_WBTC].turnover.usedUsd = "76";
    expect(fails(g.check(buy25(), p, "propose"))?.rule).toBe("turnover_budget");
  });
  it("discretionary_exit, spread close and guard exits are turnover-exempt", () => {
    const p = freshPf((x) => (x.markets[MARKET_WBTC].turnover.usedUsd = "100"));
    const v = g.check(draft({ market: MARKET_WBTC, side: "sell", amountIn: "31000", notionalUsdE8: "2400000000", candidateId: WBTC_DX }), p, "propose");
    expect(v.ok && v.exemptions).toContain("turnover");
    if (v.ok) expect(v.reserve.turnoverUsd).toBe("0");
    const gx = g.check(draft({ market: MARKET_WBTC, side: "sell", amountIn: "31000", notionalUsdE8: "2400000000", origin: "guard", generator: "guard_exit" }), p, "propose");
    expect(gx.ok && gx.exemptions).toEqual(["turnover", "exit_reserve", "edge_gate"]);
  });
});

describe("rule 3b: exit reserve", () => {
  const g = createStrategyGuard();
  it("start the day at $150 exposure, close $100, re-buy → blocked once the reserve would be breached", () => {
    // Day start: $150 exposure, nothing spent. Exit $100 (discretionary_exit).
    const p = freshPf((x) => {
      setExposure(x, null, MARKET_WHSK, 150);
      x.markets[MARKET_WHSK].vault.epoch.spentUsdE8 = "0";
      x.strategy.portfolio.maxPortfolioExposureUsd = "300";
      x.strategy.markets[MARKET_WHSK].maxPositionUsd = "150";
      x.markets[MARKET_WHSK].turnover.usedUsd = "0";
      x.turnover.usedUsd = "0";
      x.candidates.whskBuy = { ...x.candidates[WHSK_DX]!, candidateId: "whskBuy", generator: "spread-revert", leg: "open", side: "buy", maxAmountIn: "25000000", consumedBy: null };
    });
    const vx = p.markets[MARKET_WHSK].vault;
    expect(exitReserveOk(vx, FIXTURE_NOW, "sell", 10_000_000_000n).ok).toBe(true);
    // After the $100 exit: exposure $50, spent $100. First $25 re-buy fits (125 ≥ 75/0.975 = 76.9).
    setExposure(p, null, MARKET_WHSK, 50);
    vx.epoch.spentUsdE8 = "10000000000";
    const rebuy = draft({ market: MARKET_WHSK, side: "buy", amountIn: "25000000", notionalUsdE8: "2500000000", candidateId: "whskBuy" });
    expect(g.check(rebuy, p, "propose").ok).toBe(true);
    // Second re-buy: exposure $75, spent $125 → after: 100 < 100/0.975 = 102.6 → blocked.
    setExposure(p, null, MARKET_WHSK, 75);
    vx.epoch.spentUsdE8 = "12500000000";
    expect(fails(g.check(rebuy, p, "propose"))).toEqual({ code: "ATE_STRATEGY_BLOCKED", rule: "exit_reserve" });
    expect(exitReserveBuyCapE8(vx, FIXTURE_NOW)).toBeLessThan(2_500_000_000n);
    // Guard exits are exempt even with the budget nearly spent.
    vx.epoch.spentUsdE8 = "24900000000";
    expect(g.check(draft({ market: MARKET_WHSK, side: "sell", amountIn: "1", notionalUsdE8: "2500000000", origin: "guard", generator: "guard_exit" }), p, "propose").ok).toBe(true);
  });
  it("binds only above ~$146 exposure with $100 spent (defaults)", () => {
    const v = structuredClone(pf().markets[MARKET_WBTC].vault);
    v.epoch.spentUsdE8 = "10000000000";
    v.exposureUsdE8 = "14500000000";
    expect(exitReserveOk(v, FIXTURE_NOW, "sell", 0n).ok).toBe(true);
    v.exposureUsdE8 = "14700000000";
    expect(exitReserveOk(v, FIXTURE_NOW, "sell", 0n).ok).toBe(false);
  });
});

describe("rules 5, 6, 7, 8, 9", () => {
  const g = createStrategyGuard();
  it("rule 5: re-entry lock blocks buys, not sells", () => {
    const p = freshPf((x) => (x.markets[MARKET_WBTC].reentryLockUntil = FIXTURE_NOW + 600));
    expect(fails(g.check(buy25(), p, "propose"))?.rule).toBe("reentry_lock");
    expect(g.check(draft({ market: MARKET_WBTC, side: "sell", amountIn: "31000", notionalUsdE8: "2400000000", candidateId: WBTC_DX }), p, "propose").ok).toBe(true);
  });
  it("rule 6: breaker past the limit blocks entries; exits pass", () => {
    const p = freshPf((x) => (x.dailyPnlUsd = "-10.01"));
    expect(fails(g.check(buy25(), p, "propose"))?.rule).toBe("daily_loss_breaker");
    p.breaker = { state: "tripped", since: FIXTURE_NOW };
    expect(g.check(draft({ market: MARKET_WBTC, side: "sell", amountIn: "31000", notionalUsdE8: "2400000000", origin: "guard", generator: "guard_exit" }), p, "propose").ok).toBe(true);
  });
  it("rule 7: WBTC entries ≥ 1800 s apart; another open entry on the market blocks", () => {
    expect(fails(g.check(buy25(), pf(), "propose"))?.rule).toBe("frequency"); // last entry 900 s ago
    const p = freshPf((x) => {
      x.openProposals = [{ proposalId: "prop_2222222222222222", market: MARKET_WBTC, side: "buy", origin: "candidate", status: "proposed", amountIn: "1", reservedTurnoverUsd: "1", createdAt: FIXTURE_NOW, expiresAt: FIXTURE_NOW + 120 }];
    });
    expect(fails(g.check(buy25(), p, "propose"))?.rule).toBe("frequency");
    // exits are never throttled
    expect(g.check(draft({ market: MARKET_WBTC, side: "sell", amountIn: "31000", notionalUsdE8: "2400000000", candidateId: WBTC_DX }), pf(), "propose").ok).toBe(true);
  });
  it("rule 8: discretionary needs a ≥ 40-char thesis, ≤ $10, < 3/day", () => {
    const thesis = "CEX ask thinning 3 cycles while pool flow is net buy; exit if CEX mid < entry; invalidated by spread > 40 bps";
    const d = (over = {}) => draft({ market: MARKET_WHSK, side: "buy", amountIn: "10000000", notionalUsdE8: "1000000000", origin: "discretionary", thesis, ...over });
    const v = g.check(d(), freshPf(), "propose");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.reserve.discretionary).toBe(1);
    expect(fails(g.check(d({ thesis: "too short" }), freshPf(), "propose"))?.code).toBe("ATE_DISCRETIONARY_LIMIT");
    expect(fails(g.check(d({ amountIn: "10010000", notionalUsdE8: "1001000000" }), freshPf(), "propose"))?.code).toBe("ATE_DISCRETIONARY_LIMIT");
    const p3 = freshPf((x) => (x.discretionary = { executedToday: 2, reservedToday: 1 }));
    expect(fails(g.check(d(), p3, "propose"))?.code).toBe("ATE_DISCRETIONARY_LIMIT");
    // lowered by the user to 0 → lane disabled
    expect(fails(g.check(d(), freshPf((x) => (x.strategy.portfolio.discretionaryTradesPerDay = 0)), "propose"))?.code).toBe("ATE_DISCRETIONARY_LIMIT");
    // still subject to rules 2–7 and 9 (re-entry lock)
    expect(fails(g.check(d(), freshPf((x) => (x.markets[MARKET_WHSK].reentryLockUntil = FIXTURE_NOW + 1)), "propose"))?.rule).toBe("reentry_lock");
  });
  it("rule 9: de-selected market → entries blocked, guard sell-down allowed", () => {
    const p = freshPf((x) => (x.strategy.portfolio.targetAssets = ["WHSK"]));
    expect(fails(g.check(buy25(), p, "propose"))?.rule).toBe("target_assets");
    expect(g.check(draft({ market: MARKET_WBTC, side: "sell", amountIn: "31000", notionalUsdE8: "2400000000", origin: "guard", generator: "guard_exit" }), p, "propose").ok).toBe(true);
  });
});

describe("reservations + invalidation", () => {
  it("reserve / totals / release(executed) converts to used; others free it", () => {
    const r = createReservations();
    r.reserve("prop_a", { market: MARKET_WBTC, turnoverUsd: "25", discretionary: 0 });
    r.reserve("prop_b", { market: MARKET_WHSK, turnoverUsd: "5", discretionary: 1 });
    r.reserve("prop_a", { market: MARKET_WBTC, turnoverUsd: "999", discretionary: 0 }); // idempotent
    expect(r.totals()).toEqual({ turnoverUsd: "30", discretionary: 1, byMarket: { [MARKET_WBTC]: "25", [MARKET_WHSK]: "5" } });
    r.release("prop_a", "executed");
    r.release("prop_b", "expired");
    expect(r.totals().turnoverUsd).toBe("0");
    expect(r.used()).toEqual({ turnoverUsd: "25", discretionary: 0, byMarket: { [MARKET_WBTC]: "25" } });
  });
  it("guard exit invalidates open buys on that market only; execute then returns ATE_STRATEGY_BLOCKED", () => {
    const open: OpenProposal[] = [
      { proposalId: "prop_buyb", market: MARKET_WBTC, side: "buy", origin: "candidate", status: "approved", amountIn: "1", reservedTurnoverUsd: "25", createdAt: 0, expiresAt: FIXTURE_NOW + 100 },
      { proposalId: "prop_sell", market: MARKET_WBTC, side: "sell", origin: "candidate", status: "approved", amountIn: "1", reservedTurnoverUsd: "0", createdAt: 0, expiresAt: FIXTURE_NOW + 100 },
      { proposalId: "prop_buyh", market: MARKET_WHSK, side: "buy", origin: "candidate", status: "proposed", amountIn: "1", reservedTurnoverUsd: "5", createdAt: 0, expiresAt: FIXTURE_NOW + 100 },
    ];
    const res = createReservations();
    res.reserve("prop_buyb", { market: MARKET_WBTC, turnoverUsd: "25", discretionary: 0 });
    const inv = createInvalidation(() => open, res);
    expect(inv.onGuardExit(MARKET_WBTC, "stop_loss")).toEqual(["prop_buyb"]);
    expect(res.get("prop_buyb")).toBeUndefined();
    expect(inv.onBreaker()).toEqual(["prop_buyh"]);
    const g = createStrategyGuard({ invalidation: inv });
    const p: PortfolioState = freshPf();
    expect(fails(g.check(buy25({ proposalId: "prop_buyb" }), p, "execute"))).toEqual({ code: "ATE_STRATEGY_BLOCKED", rule: "invalidated" });
    expect(checkProposal(buy25({ proposalId: "prop_other" }), p, "execute").ok).toBe(true);
  });
});
