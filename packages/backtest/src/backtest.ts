// Backtest (lane STRAT): one deterministic replay of a strategy on the paper market, with the plain numbers the app
// shows (P&L, trades, win rate, worst dip, fees, time in market), "just holding" and the current preset alongside,
// and notes on data coverage. Read-only: nothing here touches a vault or the journal.

import { MARKETS, RISK_PROFILES, backtestLine, parseStrategySpec, type BacktestSummary, type MarketId, type RiskProfile, type StrategySpec } from "@ate/core";
import { Simulator, type Decision, type MarketHistory, type SimInput, type SimLimits, type Trade } from "./sim.js";

export interface BacktestResult {
  from: number;
  to: number;
  days: number;
  barSec: number;
  markets: MarketId[];
  /** Money the strategy may hold (Σ exposure caps): the base of every %. */
  capitalUsd: number;
  pnlUsd: number;
  returnPct: number;
  trades: Trade[];
  buys: number;
  sells: number;
  /** Share of closed round trips (flat → flat) that made money; null with none closed. */
  winRate: number | null;
  roundTrips: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  feesUsd: number;
  timeInMarketPct: number;
  /** P&L over time (USD), ≤ 600 points. */
  curve: { t: number; v: number }[];
  decisions: Decision[];
  hold: { pnlUsd: number; returnPct: number };
  preset: { name: string; pnlUsd: number; returnPct: number; trades: number } | null;
  coverage: string[];
  summary: BacktestSummary;
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** Plain notes on what the replay could and could not see. */
export function coverageNotes(histories: MarketHistory[], from: number, to: number, barSec: number): string[] {
  const out: string[] = [];
  for (const h of histories) {
    const name = MARKETS[h.market].asset === "WBTC" ? "BTC" : "HSK";
    const inWin = h.pool.filter((p) => p.t >= from && p.t <= to);
    const days = (to - from) / 86_400;
    if (inWin.length === 0) out.push(`${name}: no pool trades in this period. The price stays flat at the last trade before it.`);
    else if (inWin.length / days < 24) out.push(`${name}: the pool traded only ${inWin.length} times in ${round(days, 0)} days, so its price moves in steps.`);
    let maxGap = 0;
    let prev = from;
    for (const p of inWin) {
      maxGap = Math.max(maxGap, p.t - prev);
      prev = p.t;
    }
    maxGap = Math.max(maxGap, to - prev);
    if (inWin.length && maxGap > 12 * 3600) out.push(`${name}: the longest stretch without a pool trade is ${round(maxGap / 3600, 0)} hours.`);
    const cexIn = h.cex.filter((p) => p.t >= from && p.t <= to);
    const want = (to - from) / 60;
    if (cexIn.length < want * 0.9) {
      const step = cexIn.length > 1 ? (cexIn[cexIn.length - 1]!.t - cexIn[0]!.t) / (cexIn.length - 1) : 0;
      if (step > 90) out.push(`${name}: HashKey Global prices are ${round(step / 60, 0)}-minute closes.`);
      else out.push(`${name}: HashKey Global prices cover ${round((cexIn.length / want) * 100, 0)}% of the minutes.`);
    }
    const oraIn = h.oracle.filter((p) => p.t >= from - 86_400 && p.t <= to);
    if (oraIn.length < 2) out.push(`${name}: little oracle history, so rules on the oracle gap rarely apply.`);
    out.push(`${name}: price impact uses ${h.depthSource}.`);
    out.push(...h.notes);
  }
  out.push("Your own trades do not move the replayed prices. Fills pay the 0.30% pool fee and the estimated price impact.");
  void barSec;
  return out;
}

export interface BacktestOptions extends SimInput {
  /** The preset to compare against (the market's current settings). null to skip. */
  compareTo?: { name: string; spec: StrategySpec } | null;
}

/** Rules backtest: every candidate is taken at its max (the deterministic strategy). */
export function runBacktest(o: BacktestOptions): BacktestResult {
  const sim = new Simulator(o);
  while (!sim.done) {
    for (const c of sim.open()) sim.take(c.id, c.maxUsd, "rules", `Bought: ${c.reason}${c.boundBy ? `, capped by ${c.boundBy}` : ""}`);
    sim.close();
  }
  const r = resultOf(sim, o);
  if (o.compareTo) {
    const p = runBacktest({ ...o, spec: o.compareTo.spec, compareTo: null });
    r.preset = { name: o.compareTo.name, pnlUsd: p.pnlUsd, returnPct: p.returnPct, trades: p.trades.length };
  }
  return r;
}

/** Results of a finished (or stopped) simulator run. */
export function resultOf(sim: Simulator, o: SimInput): BacktestResult {
  const curveAll = sim.curve;
  let peak = 0;
  let dd = 0;
  for (const p of curveAll) {
    peak = Math.max(peak, p.v);
    dd = Math.max(dd, peak - p.v);
  }
  const pnl = curveAll.length ? curveAll[curveAll.length - 1]!.v : 0;
  const cap = sim.capital || 1;
  const step = Math.max(1, Math.ceil(curveAll.length / 600));
  const curve = curveAll.filter((_, k) => k % step === 0 || k === curveAll.length - 1).map((p) => ({ t: p.t, v: round(p.v, 4) }));
  const st = sim.stats();
  const wins = sim.roundTrips.filter((x) => x > 0).length;
  const to = Math.min(o.to, sim.start + sim.n * sim.barSec);
  const days = Math.max(1, Math.round((to - o.from) / 86_400));
  const returnPct = round((pnl / cap) * 100, 2);
  const ddPct = round((dd / cap) * 100, 2);
  const trades = sim.trades;
  const hold = holdResult(o, sim);
  return {
    from: o.from,
    to,
    days,
    barSec: sim.barSec,
    markets: sim.markets,
    capitalUsd: round(cap),
    pnlUsd: round(pnl, 2),
    returnPct,
    trades,
    buys: trades.filter((t) => t.side === "buy").length,
    sells: trades.filter((t) => t.side === "sell").length,
    winRate: sim.roundTrips.length ? round(wins / sim.roundTrips.length, 3) : null,
    roundTrips: sim.roundTrips.length,
    maxDrawdownUsd: round(dd),
    maxDrawdownPct: ddPct,
    feesUsd: round(trades.reduce((a, t) => a + t.feeUsd, 0)),
    timeInMarketPct: st.barsWithData ? round((st.barsInMarket / st.barsWithData) * 100, 1) : 0,
    curve,
    decisions: sim.decisions,
    hold,
    preset: null,
    coverage: coverageNotes(o.histories.filter((h) => sim.markets.includes(h.market)), o.from, to, sim.barSec),
    summary: { at: o.to, days, returnPct, pnlUsd: round(pnl), trades: trades.length, worstDipPct: ddPct, line: backtestLine(days, returnPct, trades.length, ddPct) },
  };
}

/** "Just holding": buy the full exposure cap at the first price, sell at the last (fees and impact both ways). */
function holdResult(o: SimInput, sim: Simulator): { pnlUsd: number; returnPct: number } {
  let pnl = 0;
  for (const m of sim.markets) {
    const h = sim.history(m)!;
    const pts = h.pool.filter((p) => p.t <= o.to);
    const first = [...pts].reverse().find((p) => p.t <= o.from) ?? pts.find((p) => p.t >= o.from);
    const last = pts[pts.length - 1];
    if (!first || !last) continue;
    const usd = o.limits.maxExposureUsd;
    const fee = h.feeBps / 1e4;
    const imp = (x: number) => (h.depthUsd > 0 ? (x * (1 - fee)) / h.depthUsd : 0);
    const tokens = (usd * (1 - fee)) / (first.v * (1 + imp(usd)));
    const out = tokens * last.v * (1 - imp(tokens * last.v)) * (1 - fee);
    pnl += out - usd;
  }
  return { pnlUsd: round(pnl), returnPct: round((pnl / (sim.capital || 1)) * 100) };
}

/**
 * The built-in preset as a rules spec, so it replays on the same paper market: buy when the pool is under HashKey
 * Global by more than the entry gap and by more than the costs + the minimum edge, sell when the lot is up by the
 * minimum edge (spread-revert close), the preset's stop-loss, its size and its daily budget.
 */
export function presetSpec(p: RiskProfile | { tradeSizeUsd: string; entrySpreadBps: number; minNetEdgeBps: number; stopLossBps: number }, o: { assets: ("HSK" | "BTC")[]; feeBps: number; halfSpreadBps: number; impactBps: number; dailyBudgetUsd: number; cooldownMin: number; name?: string; reference?: "oracle" | "cex" }): StrategySpec {
  const r = typeof p === "string" ? RISK_PROFILES[p] : p;
  const size = Number(r.tradeSizeUsd);
  const gapBps = Math.max(r.entrySpreadBps, o.feeBps + o.halfSpreadBps + o.impactBps + r.minNetEdgeBps);
  const spec = parseStrategySpec({
    name: o.name ?? (typeof p === "string" ? p : "Current settings"),
    kind: "rules",
    markets: o.assets,
    barMinutes: 5,
    entry: { when: "all", conditions: [{ signal: o.reference === "cex" ? "gap_cex" : "gap_oracle", op: "below", value: -round(gapBps / 100, 4) }] },
    exit: { conditions: [{ signal: "pnl", op: "above", value: Math.max(0.01, r.minNetEdgeBps / 100) }], stopLossPct: r.stopLossBps / 100 },
    sizing: { mode: "usd", value: size },
    limits: { maxTradesPerDay: Math.min(48, Math.max(1, Math.floor(o.dailyBudgetUsd / Math.max(1, size)))), cooldownMin: o.cooldownMin },
  });
  if (!spec.ok) throw new Error(spec.errors.join("; "));
  return spec.spec;
}

/** Default limits (vault defaults §19 + strategy defaults) for tests and the CLI. */
export const DEFAULT_SIM_LIMITS: SimLimits = {
  maxTradeUsd: 25,
  maxExposureUsd: 150,
  maxEpochUsd: 250,
  dailyBudgetUsd: 100,
  maxPortfolioExposureUsd: 200,
  dailyLossLimitUsd: 10,
  guardStopPct: 3,
  minEntryIntervalSec: 0,
  reentryCooldownSec: 14_400,
  maxOracleDeviationBps: 250,
};
