// Candidate generators (§11.3): spread-revert (open/close), rebalance, guard_exit, discretionary_exit.
// Pure and synchronous: every chain/CEX read is in the MarketSnapshot (FREEZE-NOTES §S3).

import {
  MARKETS,
  sellAmountForUsdCap,
  type Candidate,
  type CandidateGenerator,
  type GeneratorId,
  type GuardExitReason,
  type Leg,
  type MarketId,
  type MarketSnapshot,
  type PortfolioState,
  type Side,
} from "@ate/core";
import { candidateId, costBps, signedEdgeFor, sizeForImpact, viewOf, type MarketView } from "./market.js";
import { effectiveMarketParams, isDemo, isTargeted, rebalanceTarget } from "./params.js";
import { entryBuyCap, entrySellCap, exitChunk } from "./sizing.js";
import { E8, absBps, e8ToUsdt, minB, roundBps, signedBps, tokenValueE8, usdE8, usdStr, usdtToE8 } from "./units.js";

/** Smallest entry worth emitting ($1). */
export const MIN_ENTRY_E8 = 1n * E8;
/** Positions worth less than this are dust: no exit candidates ($0.50). */
export const DUST_E8 = E8 / 2n;

export interface DraftCandidate {
  market: MarketId;
  generator: GeneratorId;
  leg?: Leg;
  side: Side;
  maxAmountIn: bigint;
  edgeBps: number;
  costBps: number;
  netEdgeBps: number;
  reason: string;
  guardReason?: GuardExitReason;
  /** True for non-exit trades (rule 3 turnover / rule 5 / rule 7 / entry suppression apply). */
  entry: boolean;
}

export function finalize(d: DraftCandidate, snap: MarketSnapshot, pf: PortfolioState): Candidate {
  const m = pf.strategy.markets[d.market];
  const c: Candidate = {
    candidateId: candidateId({ market: d.market, generator: d.generator, side: d.side, leg: d.leg, at: snap.at, maxAmountIn: d.maxAmountIn.toString(), extra: d.guardReason }),
    market: d.market,
    generator: d.generator,
    side: d.side,
    maxAmountIn: d.maxAmountIn.toString(),
    edgeBps: roundBps(d.edgeBps),
    costBps: roundBps(d.costBps),
    netEdgeBps: roundBps(d.netEdgeBps),
    reason: d.reason,
    expiresAt: snap.at + pf.candidateTtlSec,
    createdAt: snap.at,
    profile: m && isDemo(d.market, m) ? "demo" : "default",
  };
  if (d.leg) c.leg = d.leg;
  if (d.guardReason) c.guardReason = d.guardReason;
  return c;
}

const fmtUsdt = (x: bigint) => usdStr(usdtToE8(x));
const label = (m: MarketId) => MARKETS[m].label;

function positionQty(snap: MarketSnapshot, pf: PortfolioState): bigint {
  // The vault balance is authoritative for what can be sold.
  return BigInt(snap.vault.balancePrice);
}

// ------------------------------------------------------------------ spread-revert

export function spreadRevertDrafts(snap: MarketSnapshot, pf: PortfolioState): DraftCandidate[] {
  const market = snap.market;
  const raw = pf.strategy.markets[market];
  if (!raw) return [];
  const m = effectiveMarketParams(market, raw);
  const v = viewOf(snap);
  const out: DraftCandidate[] = [];

  // Close leg: FIFO open spread-revert lots, while each lot's fee-inclusive exit mark beats its entry by ≥ minNetEdgeBps.
  const book = pf.markets[market];
  const qty = positionQty(snap, pf);
  if (book && snap.exitMark !== null && qty > 0n) {
    const mark = BigInt(snap.exitMark);
    const lots = [...book.position.lots].filter((l) => BigInt(l.qtyRemaining) > 0n && l.closedAt === null).sort((a, b) => a.openedAt - b.openedAt);
    let sum = 0n;
    let firstBps: number | null = null;
    let n = 0;
    for (const l of lots) {
      const bps = signedBps(mark, BigInt(l.entryPrice));
      if (bps < m.minNetEdgeBps) break;
      firstBps ??= bps;
      sum += BigInt(l.qtyRemaining);
      n++;
    }
    if (sum > 0n && firstBps !== null) {
      const amt = minB(sum, exitChunk(snap, qty));
      if (amt > 0n) {
        out.push({
          market,
          generator: "spread-revert",
          leg: "close",
          side: "sell",
          maxAmountIn: amt,
          edgeBps: firstBps,
          costBps: 0,
          netEdgeBps: firstBps,
          reason: `${label(market)} spread-revert close: ${n} open lot(s) exit-executable mark beats entry by ${roundBps(firstBps)} bps ≥ minNetEdgeBps ${m.minNetEdgeBps} (fee-inclusive)`,
          entry: false,
        });
      }
    }
  }

  // Open leg (needs a target asset and a CEX reference).
  if (!isTargeted(market, pf.strategy) || v.gapBps === null || v.cexMid === null) return out;
  const edge = Math.abs(v.gapBps);
  const side: Side = v.gapBps < 0 ? "buy" : "sell";
  if (edge < m.entrySpreadBps) return out;
  const impactLimit = sizeForImpact(side === "buy" ? snap.impact.buy : snap.impact.sell, edge / 3);
  let amountIn: bigint;
  let capNote: string;
  if (side === "buy") {
    const cap = entryBuyCap(snap, pf);
    const usdt = minB(e8ToUsdt(cap.capE8), impactLimit);
    amountIn = usdt;
    capNote = usdt === impactLimit && impactLimit < e8ToUsdt(cap.capE8) ? "impact≤edge/3" : cap.binding;
    if (usdtToE8(amountIn) < MIN_ENTRY_E8) return out;
  } else {
    if (qty <= 0n) return out;
    const cap = entrySellCap(snap, pf);
    const tokens = minB(sellAmountForUsdCap(cap.capE8, v.oracle, v.twap, v.d), qty, impactLimit);
    amountIn = tokens;
    capNote = cap.binding;
    if (tokenValueE8(amountIn, v.oracle, v.d) < MIN_ENTRY_E8) return out;
  }
  const { cost, impact } = costBps(v, snap, side, amountIn);
  const net = edge - cost;
  if (net < m.minNetEdgeBps) return out;
  const dir = v.gapBps < 0 ? "below" : "above";
  out.push({
    market,
    generator: "spread-revert",
    leg: "open",
    side,
    maxAmountIn: amountIn,
    edgeBps: edge,
    costBps: cost,
    netEdgeBps: net,
    reason:
      `${label(market)} pool ${roundBps(edge)} bps ${dir} HashKey Global ${MARKETS[market].cexSymbol} mid; cost ${v.feeBps} fee + ${impact} impact + ${v.halfSpreadBps} half-spread = ${cost} bps; ` +
      `net ${roundBps(net)} ≥ ${m.minNetEdgeBps}; size bound: ${capNote}` +
      (side === "buy" ? ` (${fmtUsdt(amountIn)} USDT)` : ""),
    entry: true,
  });
  return out;
}

// ------------------------------------------------------------------ rebalance

export function rebalanceDrafts(snap: MarketSnapshot, pf: PortfolioState): DraftCandidate[] {
  const market = snap.market;
  const raw = pf.strategy.markets[market];
  if (!raw || !isTargeted(market, pf.strategy)) return []; // de-selected markets sell down via guard_exit(target_assets)
  const target = rebalanceTarget(market, pf.strategy);
  if (target === null) return [];
  if (!raw.generators.includes("rebalance") && raw.rebalanceTargetPct === null) return [];
  const m = effectiveMarketParams(market, raw);
  const v = viewOf(snap);
  const qty = positionQty(snap, pf);
  const tokenVal = tokenValueE8(qty, v.oracle, v.d);
  const total = tokenVal + usdtToE8(BigInt(snap.vault.balanceQuote));
  if (total <= 0n) return [];
  const sharePct = Number((tokenVal * 1_000_000n) / total) / 10_000;
  const demo = isDemo(market, raw);

  if (target === 0) {
    if (tokenVal < DUST_E8) return [];
    const amt = exitChunk(snap, qty);
    if (amt <= 0n) return [];
    const { cost } = costBps(v, snap, "sell", amt);
    const e = signedEdgeFor(v, "sell");
    return [
      {
        market,
        generator: "rebalance",
        side: "sell",
        maxAmountIn: amt,
        edgeBps: e,
        costBps: cost,
        netEdgeBps: e - cost,
        reason: `${label(market)} rebalanceTargetPct = 0 (go to cash): sell down regardless of edge; share ${sharePct.toFixed(2)}%`,
        entry: false,
      },
    ];
  }

  const band = m.rebalanceBandPct;
  let side: Side;
  if (sharePct < target - band) side = "buy";
  else if (sharePct > target + band) side = "sell";
  else return [];
  const gapUsdE8 = (total * BigInt(Math.round(Math.abs(target - sharePct) * 10_000))) / 1_000_000n;
  let amountIn: bigint;
  if (side === "buy") {
    const cap = entryBuyCap(snap, pf);
    amountIn = e8ToUsdt(minB(cap.capE8, gapUsdE8));
    if (usdtToE8(amountIn) < MIN_ENTRY_E8) return [];
  } else {
    const cap = entrySellCap(snap, pf);
    amountIn = minB(sellAmountForUsdCap(minB(cap.capE8, gapUsdE8), v.oracle, v.twap, v.d), qty);
    if (tokenValueE8(amountIn, v.oracle, v.d) < MIN_ENTRY_E8) return [];
  }
  const { cost } = costBps(v, snap, side, amountIn);
  const e = signedEdgeFor(v, side);
  const net = e - cost;
  // Default-profile edge gate: direction-adjusted net edge vs CEX mid ≥ 0. Waived under the WHSK demo profile.
  if (!demo && (v.gapBps === null || net < 0)) return [];
  return [
    {
      market,
      generator: "rebalance",
      side,
      maxAmountIn: amountIn,
      edgeBps: e,
      costBps: cost,
      netEdgeBps: net,
      reason:
        `${label(market)} share ${sharePct.toFixed(2)}% outside ${target}% ± ${band}% → ${side} toward target; signed edge ${roundBps(e)} − cost ${cost} = ${roundBps(net)} bps` +
        (demo ? " (profile=demo: edge gate waived; not arbitrage)" : " (edge gate ≥ 0 passed)"),
      entry: true,
    },
  ];
}

// ------------------------------------------------------------------ guard exits (§11.4 rules 4, 6, 9)

export interface StopEval {
  pnlBps: number | null;
  trigger: "stop_loss" | "take_profit" | null;
  /** Mark vs TWAP disagreement beyond maxOracleDeviationBps → the trigger waits a cycle. */
  waiting: boolean;
  note: string;
}

/** Stop-loss / take-profit evaluation on average-cost entry vs exit-executable mark (§11.4 rule 4). */
export function evaluateStop(snap: MarketSnapshot, pf: PortfolioState): StopEval {
  const market = snap.market;
  const book = pf.markets[market];
  const raw = pf.strategy.markets[market];
  if (!book || !raw || book.position.avgEntry === null || snap.exitMark === null) return { pnlBps: null, trigger: null, waiting: false, note: "flat or no mark" };
  const m = effectiveMarketParams(market, raw);
  const entry = BigInt(book.position.avgEntry);
  const mark = BigInt(snap.exitMark);
  const pnl = signedBps(mark, entry);
  const twap = snap.price.pool.twap === null ? null : BigInt(snap.price.pool.twap);
  const dev = snap.vault.limits.maxOracleDeviationBps;
  let trigger: StopEval["trigger"] = null;
  if (pnl <= -m.stopLossBps) trigger = "stop_loss";
  else if (pnl >= m.takeProfitBps) trigger = "take_profit";
  if (trigger && (twap === null || absBps(mark, twap) > dev)) {
    return { pnlBps: pnl, trigger, waiting: true, note: `mark disagrees with 300 s TWAP by more than ${dev} bps; trigger waits a cycle` };
  }
  return { pnlBps: pnl, trigger, waiting: false, note: `entry ${entry} mark ${mark} → ${roundBps(pnl)} bps (stop −${m.stopLossBps}, TP +${m.takeProfitBps})` };
}

export function guardExitDrafts(snap: MarketSnapshot, pf: PortfolioState): DraftCandidate[] {
  const market = snap.market;
  const v = viewOf(snap);
  const qty = positionQty(snap, pf);
  if (tokenValueE8(qty, v.oracle, v.d) < DUST_E8) return [];
  let reason: GuardExitReason | null = null;
  let why = "";
  if (pf.breaker.state === "flattening") {
    reason = "breaker";
    why = `daily loss breaker flattening (daily P&L ${pf.dailyPnlUsd} USD ≤ −${pf.strategy.portfolio.dailyLossLimitUsd})`;
  } else if (!isTargeted(market, pf.strategy)) {
    reason = "target_assets";
    why = `${label(market)} not in targetAssets [${pf.strategy.portfolio.targetAssets.join(", ")}]: sell down`;
  } else {
    const s = evaluateStop(snap, pf);
    if (s.trigger && !s.waiting) {
      reason = s.trigger;
      why = `${s.trigger === "stop_loss" ? "stop-loss" : "take-profit"}: ${s.note}`;
    }
  }
  if (!reason) return [];
  const amt = exitChunk(snap, qty);
  if (amt <= 0n) return [];
  const { cost } = costBps(v, snap, "sell", amt);
  return [
    {
      market,
      generator: "guard_exit",
      side: "sell",
      maxAmountIn: amt,
      edgeBps: 0,
      costBps: cost,
      netEdgeBps: -cost,
      reason: `${label(market)} guard exit (${reason}): ${why}; chunk ≤ maxTradeUsd ÷ max(P, T) × 0.99`,
      guardReason: reason,
      entry: false,
    },
  ];
}

// ------------------------------------------------------------------ discretionary exit

export function discretionaryExitDrafts(snap: MarketSnapshot, pf: PortfolioState): DraftCandidate[] {
  const market = snap.market;
  const v = viewOf(snap);
  const qty = positionQty(snap, pf);
  if (tokenValueE8(qty, v.oracle, v.d) < DUST_E8) return [];
  const amt = exitChunk(snap, qty);
  if (amt <= 0n) return [];
  const { cost } = costBps(v, snap, "sell", amt);
  return [
    {
      market,
      generator: "discretionary_exit",
      side: "sell",
      maxAmountIn: amt,
      edgeBps: 0,
      costBps: cost,
      netEdgeBps: -cost,
      reason: "standing discretionary exit: min(position, maxTradeUsd, epoch remaining)",
      entry: false,
    },
  ];
}

// ------------------------------------------------------------------ frozen CandidateGenerator wrappers

function wrap(id: GeneratorId, fn: (s: MarketSnapshot, p: PortfolioState) => DraftCandidate[]): CandidateGenerator {
  return { id, generate: (s, p) => fn(s, p).map((d) => finalize(d, s, p)) };
}

export const spreadRevert = wrap("spread-revert", spreadRevertDrafts);
export const rebalance = wrap("rebalance", rebalanceDrafts);
export const guardExit = wrap("guard_exit", guardExitDrafts);
export const discretionaryExit = wrap("discretionary_exit", discretionaryExitDrafts);

export const GENERATORS: readonly CandidateGenerator[] = [guardExit, spreadRevert, rebalance, discretionaryExit];

/** One-line market diagnosis for no_trade rationales and the rules engine. */
export function explainMarket(snap: MarketSnapshot, pf: PortfolioState): string {
  const market = snap.market;
  const raw = pf.strategy.markets[market];
  const v = viewOf(snap);
  if (!raw) return `${label(market)}: no strategy params`;
  const m = effectiveMarketParams(market, raw);
  if (v.gapBps === null) return `${label(market)}: no CEX reference`;
  const side: Side = v.gapBps < 0 ? "buy" : "sell";
  const probe = side === "buy" ? e8ToUsdt(usdE8(m.tradeSizeUsd)) : sellAmountForUsdCap(usdE8(m.tradeSizeUsd), v.oracle, v.twap, v.d);
  const { cost } = costBps(v, snap, side, probe);
  const edge = Math.abs(v.gapBps);
  return `${label(market)}: pool ${v.gapBps < 0 ? "below" : "above"} CEX by ${roundBps(edge)} bps vs cost ${cost} bps (net ${roundBps(edge - cost)}; needs edge ≥ ${m.entrySpreadBps} and net ≥ ${m.minNetEdgeBps}, profile=${m.profile})`;
}

export { E8 };
