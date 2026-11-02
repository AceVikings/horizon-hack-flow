// Live custom-strategy generator (lane STRAT): turns the user's spec into `custom` candidates on the market it is in
// use on. Entries are sized like every other entry (entryBuyCap: trade cap, exposure, epoch, turnover, exit reserve),
// so the guard and the vault always bind on top; exits (take-profit, stop, trailing stop, time limit, exit rules) are
// turnover-exempt sells in exit chunks. History comes from the daemon's scans (and an optional seed from the charts
// cache), kept in memory per market.

import { MARKETS, type CustomStrategyRef, type MarketId, type MarketSnapshot, type PortfolioState } from "@ate/core";
import type { DraftCandidate } from "../generators.js";
import { costBps, viewOf } from "../market.js";
import { turnoverAllocationE8 } from "../params.js";
import { entryBuyCap, exitChunk } from "../sizing.js";
import { E8, e8ToUsdt, minB, roundBps, signedBps, tokenValueE8, usdE8, usdStr, usdtToE8, utcDay } from "../units.js";
import { barsFromPoints, SignalBook } from "./signals.js";

export interface PricePoint {
  t: number;
  pool: number | null;
  cex: number | null;
  oracle: number | null;
  /** Pool volume since the previous point, USD. */
  vol?: number;
}

const KEEP_SEC = 8 * 86_400;

/** In-memory price history per market (scan snapshots + seeded candles). */
export class LiveHistory {
  private pts = new Map<MarketId, PricePoint[]>();

  record(market: MarketId, p: PricePoint): void {
    const xs = this.pts.get(market) ?? [];
    const last = xs[xs.length - 1];
    if (last && p.t <= last.t) return;
    xs.push(p);
    const cut = p.t - KEEP_SEC;
    while (xs.length && xs[0]!.t < cut) xs.shift();
    this.pts.set(market, xs);
  }

  /** Older points (e.g. pool + exchange candles from the charts cache); merged before what the scans recorded. */
  seed(market: MarketId, older: PricePoint[]): void {
    const xs = this.pts.get(market) ?? [];
    const first = xs[0]?.t ?? Infinity;
    const add = older.filter((p) => p.t < first).sort((a, b) => a.t - b.t);
    this.pts.set(market, [...add, ...xs]);
  }

  points(market: MarketId): readonly PricePoint[] {
    return this.pts.get(market) ?? [];
  }

  /** Bars ending at `now` (the last bar holds the latest prices). */
  book(market: MarketId, barSec: number, now: number): SignalBook {
    const xs = this.points(market);
    const pool: { t: number; v: number; vol?: number }[] = [];
    const cex: { t: number; v: number }[] = [];
    const oracle: { t: number; v: number }[] = [];
    for (const p of xs) {
      if (p.pool !== null) pool.push({ t: p.t, v: p.pool, vol: p.vol ?? 0 });
      if (p.cex !== null) cex.push({ t: p.t, v: p.cex });
      if (p.oracle !== null) oracle.push({ t: p.t, v: p.oracle });
    }
    const from = xs[0]?.t ?? now;
    return new SignalBook(barsFromPoints(barSec, from, now, pool, cex, oracle, { cexMaxAgeSec: 600 }), barSec);
  }
}

/** Per-market bookkeeping for the day's buy count, trailing-stop peak and hold time. */
interface MarketState {
  day: string;
  buys: number;
  lastEntryAt: number | null;
  heldSince: number | null;
  peakMarkE8: bigint | null;
}

export class CustomState {
  private s = new Map<MarketId, MarketState>();
  get(m: MarketId): MarketState {
    let x = this.s.get(m);
    if (!x) this.s.set(m, (x = { day: "", buys: 0, lastEntryAt: null, heldSince: null, peakMarkE8: null }));
    return x;
  }
}

export const assetOf = (m: MarketId): "HSK" | "BTC" => (MARKETS[m].asset === "WBTC" ? "BTC" : "HSK");
const e8 = (x: string | null | undefined) => (x ? Number(BigInt(x)) / 1e8 : null);

/** Records the snapshot's prices into the history (called every scan). */
export function recordSnapshot(h: LiveHistory, snap: MarketSnapshot): void {
  h.record(snap.market, { t: snap.at, pool: e8(snap.price.pool.price), cex: e8(snap.price.cex?.mid), oracle: e8(snap.price.oracle.price) });
}

/** The market's daily budget in USD (turnover allocation). */
export function marketBudgetUsd(market: MarketId, pf: PortfolioState): number {
  return Number(turnoverAllocationE8(market, pf.strategy, pf.markets[market]?.vault)) / 1e8;
}

export interface CustomResult {
  drafts: DraftCandidate[];
  notes: string[];
}

export function customDrafts(snap: MarketSnapshot, pf: PortfolioState, ref: CustomStrategyRef, h: LiveHistory, st: CustomState): CustomResult {
  const market = snap.market;
  const spec = ref.spec;
  const notes: string[] = [];
  const out: DraftCandidate[] = [];
  const v = viewOf(snap);
  const book = pf.markets[market];
  const ms = st.get(market);
  const day = utcDay(snap.at);
  if (ms.day !== day) {
    ms.day = day;
    ms.buys = 0;
  }
  if (book?.lastEntryAt != null && book.lastEntryAt !== ms.lastEntryAt) {
    if (ms.lastEntryAt !== null && utcDay(book.lastEntryAt) === day) ms.buys++;
    else if (ms.lastEntryAt === null && utcDay(book.lastEntryAt) === day) ms.buys = Math.max(ms.buys, 1);
    ms.lastEntryAt = book.lastEntryAt;
  }
  const tag = `Your strategy “${ref.name}” (v${ref.version}, ${ref.kind === "rules" ? "rules" : "AI-guided"})`;
  const sb = h.book(market, spec.barMinutes * 60, snap.at);
  const i = sb.bars.length - 1;
  const qty = BigInt(snap.vault.balancePrice);
  const held = tokenValueE8(qty, v.oracle, v.d) >= E8 / 2n;

  // ---- exits
  if (!held) {
    ms.heldSince = null;
    ms.peakMarkE8 = null;
  } else {
    ms.heldSince ??= book?.lastEntryAt ?? snap.at;
    const mark = snap.exitMark === null ? null : BigInt(snap.exitMark);
    if (mark !== null && (ms.peakMarkE8 === null || mark > ms.peakMarkE8)) ms.peakMarkE8 = mark;
    const avg = book?.position.avgEntry ? BigInt(book.position.avgEntry) : null;
    const pnlPct = mark !== null && avg ? signedBps(mark, avg) / 100 : null;
    let why: string | null = null;
    const x = spec.exit;
    if (pnlPct !== null && x.takeProfitPct !== undefined && pnlPct >= x.takeProfitPct) why = `up ${pnlPct.toFixed(2)}% (take profit at ${x.takeProfitPct}%)`;
    else if (pnlPct !== null && x.stopLossPct !== undefined && pnlPct <= -x.stopLossPct) why = `down ${Math.abs(pnlPct).toFixed(2)}% (stop at ${x.stopLossPct}%)`;
    else if (x.trailingStopPct !== undefined && mark !== null && ms.peakMarkE8 !== null && signedBps(mark, ms.peakMarkE8) / 100 <= -x.trailingStopPct)
      why = `${Math.abs(signedBps(mark, ms.peakMarkE8) / 100).toFixed(2)}% below its high since buying (trailing stop ${x.trailingStopPct}%)`;
    else if (x.maxHoldHours !== undefined && snap.at - ms.heldSince >= x.maxHoldHours * 3600) why = `held ${((snap.at - ms.heldSince) / 3600).toFixed(1)} h (limit ${x.maxHoldHours} h)`;
    else {
      const rule = i >= 0 ? sb.exitRule(spec, i, { pnlPct }) : null;
      if (rule) why = `exit rule met (${rule.signal})`;
    }
    if (why) {
      const amt = exitChunk(snap, qty);
      if (amt > 0n) {
        const { cost } = costBps(v, snap, "sell", amt);
        out.push({ market, generator: "custom", leg: "close", side: "sell", maxAmountIn: amt, edgeBps: 0, costBps: cost, netEdgeBps: -cost, reason: `${tag}: sell — ${why}`, entry: false });
      }
    }
  }

  // ---- entry
  if (out.length) return { drafts: out, notes };
  if (!spec.markets.includes(assetOf(market))) return { drafts: out, notes: [`${tag} does not trade ${assetOf(market)}`] };
  if (i < SignalBook.warmup(spec) - 1) return { drafts: out, notes: [`${tag}: waiting for price history (${i + 1}/${SignalBook.warmup(spec)} bars)`] };
  if (!sb.entryHolds(spec, i)) return { drafts: out, notes };
  if (ms.buys >= spec.limits.maxTradesPerDay) return { drafts: out, notes: [`${tag}: ${ms.buys} buys today (max ${spec.limits.maxTradesPerDay})`] };
  if (book?.lastEntryAt != null && snap.at - book.lastEntryAt < spec.limits.cooldownMin * 60) return { drafts: out, notes: [`${tag}: cooldown until ${book.lastEntryAt + spec.limits.cooldownMin * 60}`] };
  const wantE8 = spec.sizing.mode === "usd" ? usdE8(spec.sizing.value) : (turnoverAllocationE8(market, pf.strategy, book?.vault) * BigInt(Math.round(spec.sizing.value * 100))) / 10_000n;
  const cap = entryBuyCap(snap, pf);
  const capE8 = minB(wantE8, cap.capE8 + 0n);
  const usdt = e8ToUsdt(capE8);
  if (usdtToE8(usdt) < E8) return { drafts: out, notes: [`${tag}: no room to buy (${cap.binding})`] };
  const { cost, impact } = costBps(v, snap, "buy", usdt);
  const edge = v.gapBps === null ? 0 : -v.gapBps;
  out.push({
    market,
    generator: "custom",
    leg: "open",
    side: "buy",
    maxAmountIn: usdt,
    edgeBps: roundBps(edge),
    costBps: cost,
    netEdgeBps: roundBps(edge - cost),
    reason:
      `${tag}: buy ${usdStr(usdtToE8(usdt))} USDT — entry rules met; cost ${v.feeBps} fee + ${impact} impact${capE8 < wantE8 ? `; size bound: ${cap.binding}` : ""}` +
      (ref.kind === "ai" ? `. The user's instructions: ${spec.instructions ?? "(none)"} — you may skip or buy less, never more.` : ". Rules strategy: the daemon trades it as is."),
    entry: true,
  });
  return { drafts: out, notes };
}
