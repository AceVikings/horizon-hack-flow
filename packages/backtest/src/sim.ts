// The paper market (lane STRAT): replays past bars on a virtual clock with paper vaults. Fills use the pool's
// liquidity/impact model (QuoterV2-calibrated depth) plus the 0.30% pool fee; the vault limits (trade cap, daily
// epoch cap, exposure cap, exit reserve) and the guard rules (daily budget, exposure, entry interval, stop-loss,
// re-entry lock after a stop, daily loss breaker) bind on every fill. Exits are automatic; entries are offered as
// candidates the caller takes (rules), sizes down or skips (AI). Pure and deterministic.

import { MARKETS, type MarketId, type StrategySpec } from "@ate/core";
import { SignalBook, barsFromPoints, type Bar } from "@ate/strategy";

export interface MarketHistory {
  market: MarketId;
  from: number;
  to: number;
  /** Pool prices after each swap (USD per token) with the swap's USD volume. */
  pool: { t: number; v: number; vol?: number }[];
  /** HashKey Global closes, stamped at the minute's close (when the price was known). */
  cex: { t: number; v: number }[];
  /** Oracle rounds (time the price was published). */
  oracle: { t: number; v: number }[];
  /** Impact model: a buy of $x executes ≈ x·(1 − fee)/depthUsd above spot (V3 in-range Δ√P/√P). */
  depthUsd: number;
  /** Where depthUsd came from ("QuoterV2 at $100", "estimated from swaps"). */
  depthSource: string;
  feeBps: number;
  halfSpreadBps: number;
  notes: string[];
}

export interface SimLimits {
  /** Vault per-trade cap. */
  maxTradeUsd: number;
  /** Exposure cap per market: min(strategy maxPositionUsd, vault maxExposureUsd). */
  maxExposureUsd: number;
  /** Vault epoch (day) cap: buys and sells both count. */
  maxEpochUsd: number;
  /** Entry budget per market per UTC day (rule 3 allocation). */
  dailyBudgetUsd: number;
  maxPortfolioExposureUsd: number;
  dailyLossLimitUsd: number;
  /** Guard stop-loss in % (rule 4). */
  guardStopPct: number;
  /** Rule 7 minimum seconds between entries. */
  minEntryIntervalSec: number;
  /** Rule 5 lock after a stop exit. */
  reentryCooldownSec: number;
  /** For the exit reserve (rule 3b). */
  maxOracleDeviationBps: number;
}

export type Actor = "rules" | "llm" | "guard";

export interface SimCandidate {
  id: string;
  market: MarketId;
  side: "buy" | "sell";
  kind: "entry" | "exit";
  /** Max USD for buys; position value for exits. */
  maxUsd: number;
  reason: string;
  /** Why this bar's entry is capped below the spec size ("" when it is not). */
  boundBy: string;
}

export interface Trade {
  t: number;
  market: MarketId;
  side: "buy" | "sell";
  usd: number;
  tokens: number;
  price: number;
  feeUsd: number;
  by: Actor;
  reason: string;
  /** Realised P&L of a sell, USD (fees included). */
  pnlUsd?: number;
}

export interface Decision {
  t: number;
  cycle: number;
  market: MarketId;
  action: "bought" | "sold" | "skipped" | "vetoed" | "sized_down" | "timeout";
  usd: number;
  by: Actor;
  /** Plain one-liner (the AI's Summary line when it wrote one). */
  summary: string;
}

interface MState {
  hist: MarketHistory;
  bars: Bar[];
  book: SignalBook;
  cash: number;
  tokens: number;
  costUsd: number;
  heldSince: number | null;
  peakPx: number;
  lastEntryAt: number | null;
  buysToday: number;
  spentToday: number;
  epochToday: number;
  lockUntil: number;
  roundTripPnl: number;
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const day = (t: number) => Math.floor(t / 86_400);

export interface SimInput {
  spec: StrategySpec;
  histories: MarketHistory[];
  limits: SimLimits;
  from: number;
  to: number;
  /** Override the bar size (default: the spec's). */
  barSec?: number;
}

export class Simulator {
  readonly barSec: number;
  readonly n: number;
  readonly start: number;
  readonly capital: number;
  readonly markets: MarketId[];
  i = 0;
  cycle = 0;
  trades: Trade[] = [];
  decisions: Decision[] = [];
  curve: { t: number; v: number }[] = [];
  readonly roundTrips: number[] = [];
  private st = new Map<MarketId, MState>();
  private open_: SimCandidate[] = [];
  private dayKey = -1;
  private dayStartEquity = 0;
  private breakerTripped = false;
  private barsWithData = 0;
  private barsInMarket = 0;
  private warm: number;

  constructor(readonly input: SimInput) {
    const s = input.spec;
    this.barSec = input.barSec ?? s.barMinutes * 60;
    this.start = Math.floor(input.from / this.barSec) * this.barSec;
    this.warm = SignalBook.warmup(s);
    const assets = new Set(s.markets);
    this.markets = input.histories.filter((h) => assets.has(MARKETS[h.market].asset === "WBTC" ? "BTC" : "HSK")).map((h) => h.market);
    let n = 0;
    for (const h of input.histories) {
      if (!this.markets.includes(h.market)) continue;
      const bars = barsFromPoints(this.barSec, this.start, input.to, h.pool, h.cex, h.oracle);
      n = Math.max(n, bars.length);
      this.st.set(h.market, {
        hist: h,
        bars,
        book: new SignalBook(bars, this.barSec),
        cash: input.limits.maxExposureUsd,
        tokens: 0,
        costUsd: 0,
        heldSince: null,
        peakPx: 0,
        lastEntryAt: null,
        buysToday: 0,
        spentToday: 0,
        epochToday: 0,
        lockUntil: 0,
        roundTripPnl: 0,
      });
    }
    this.n = n;
    this.capital = input.limits.maxExposureUsd * this.markets.length;
  }

  get done(): boolean {
    return this.i >= this.n;
  }
  /** Virtual now: the current bar's close. */
  get now(): number {
    return this.start + (this.i + 1) * this.barSec;
  }
  /** Bars visible at the current bar (no look-ahead). */
  visibleBars(m: MarketId): readonly Bar[] {
    return (this.st.get(m)?.bars ?? []).slice(0, this.i + 1);
  }
  history(m: MarketId): MarketHistory | undefined {
    return this.st.get(m)?.hist;
  }

  // ------------------------------------------------------------------ pricing

  impactBps(m: MarketId, usd: number): number {
    const h = this.st.get(m)!.hist;
    if (!(h.depthUsd > 0)) return 0;
    return ((usd * (1 - h.feeBps / 1e4)) / h.depthUsd) * 1e4;
  }
  /** Last pool price at or before now. */
  price(m: MarketId): number | null {
    const s = this.st.get(m);
    if (!s) return null;
    for (let k = Math.min(this.i, s.bars.length - 1); k >= 0; k--) if (s.bars[k]!.pool !== null) return s.bars[k]!.pool;
    return null;
  }
  /** What selling the whole position would bring, per token (impact + fee). */
  exitPx(m: MarketId): number | null {
    const s = this.st.get(m)!;
    const p = this.price(m);
    if (p === null) return null;
    const fee = s.hist.feeBps / 1e4;
    return p * (1 - this.impactBps(m, s.tokens * p) / 1e4) * (1 - fee);
  }
  positionValue(m: MarketId): number {
    const s = this.st.get(m)!;
    const px = this.exitPx(m);
    return px === null ? s.costUsd : s.tokens * px;
  }
  pnlPct(m: MarketId): number | null {
    const s = this.st.get(m)!;
    if (s.tokens <= 0 || s.costUsd <= 0) return null;
    return ((this.positionValue(m) - s.costUsd) / s.costUsd) * 100;
  }
  equity(): number {
    let e = 0;
    for (const [m, s] of this.st) e += s.cash + (s.tokens > 0 ? this.positionValue(m) : 0);
    return e;
  }
  exposure(m: MarketId): number {
    const s = this.st.get(m)!;
    const p = this.price(m);
    return p === null ? s.costUsd : s.tokens * p;
  }
  state(m: MarketId) {
    const s = this.st.get(m)!;
    return { cash: s.cash, tokens: s.tokens, costUsd: s.costUsd, heldSince: s.heldSince, lastEntryAt: s.lastEntryAt, buysToday: s.buysToday, spentToday: s.spentToday, lockUntil: s.lockUntil };
  }

  // ------------------------------------------------------------------ the cycle

  /** Opens the current bar: day rollover, automatic exits, then this bar's entry candidates. */
  open(): SimCandidate[] {
    this.cycle++;
    const T = this.now;
    if (day(T) !== this.dayKey) {
      this.dayKey = day(T);
      this.dayStartEquity = this.equity();
      this.breakerTripped = false;
      for (const s of this.st.values()) {
        s.buysToday = 0;
        s.spentToday = 0;
        s.epochToday = 0;
      }
    }
    const spec = this.input.spec;
    const L = this.input.limits;
    if (!this.breakerTripped && this.equity() - this.dayStartEquity <= -L.dailyLossLimitUsd) this.breakerTripped = true;
    const out: SimCandidate[] = [];
    let anyData = false;
    let inMarket = false;
    for (const m of this.markets) {
      const s = this.st.get(m)!;
      const bar = s.bars[this.i];
      if (!bar || bar.pool === null) continue;
      anyData = true;
      // ---- exits (automatic: guard and the strategy's own sell rules)
      if (s.tokens > 0) {
        const px = this.exitPx(m)!;
        s.peakPx = Math.max(s.peakPx, px);
        const pnl = this.pnlPct(m) ?? 0;
        const x = spec.exit;
        let why: string | null = null;
        let guard = false;
        if (this.breakerTripped) {
          why = `daily loss limit ($${L.dailyLossLimitUsd}) reached`;
          guard = true;
        } else if (pnl <= -L.guardStopPct) {
          why = `safety stop: down ${round(-pnl)}%`;
          guard = true;
        } else if (x.stopLossPct !== undefined && pnl <= -x.stopLossPct) why = `down ${round(-pnl)}% (stop ${x.stopLossPct}%)`;
        else if (x.takeProfitPct !== undefined && pnl >= x.takeProfitPct) why = `up ${round(pnl)}% (take profit ${x.takeProfitPct}%)`;
        else if (x.trailingStopPct !== undefined && px <= s.peakPx * (1 - x.trailingStopPct / 100)) why = `${round(((s.peakPx - px) / s.peakPx) * 100)}% off its high (trailing stop ${x.trailingStopPct}%)`;
        else if (x.maxHoldHours !== undefined && s.heldSince !== null && T - s.heldSince >= x.maxHoldHours * 3600) why = `held ${round((T - s.heldSince) / 3600, 1)} h`;
        else {
          const rule = s.book.exitRule(spec, this.i, { pnlPct: pnl });
          if (rule) why = `sell rule met (${rule.signal})`;
        }
        if (why) {
          const stopped = guard || (x.stopLossPct !== undefined && pnl <= -x.stopLossPct);
          this.sellChunk(m, guard ? "guard" : "rules", why, stopped);
        }
        if (s.tokens > 0) inMarket = true;
      }
      // ---- entry candidate
      if (this.breakerTripped || this.i < this.warm - 1 || !s.book.entryHolds(spec, this.i)) continue;
      if (s.buysToday >= spec.limits.maxTradesPerDay) continue;
      const gap = Math.max(spec.limits.cooldownMin * 60, L.minEntryIntervalSec);
      if (s.lastEntryAt !== null && T - s.lastEntryAt < gap) continue;
      if (T < s.lockUntil) continue;
      const cap = this.entryCap(m);
      if (cap.usd < 1) continue;
      out.push({ id: `sim_${this.cycle}_${MARKETS[m].asset}`, market: m, side: "buy", kind: "entry", maxUsd: round(cap.usd), reason: "entry rules met", boundBy: cap.boundBy });
    }
    if (anyData) this.barsWithData++;
    if (inMarket) this.barsInMarket++;
    this.open_ = out;
    return out;
  }

  /** The current bar's open candidates. */
  candidates(): SimCandidate[] {
    return this.open_;
  }

  private entryCap(m: MarketId): { usd: number; boundBy: string } {
    const s = this.st.get(m)!;
    const L = this.input.limits;
    const spec = this.input.spec;
    const want = spec.sizing.mode === "usd" ? spec.sizing.value : (L.dailyBudgetUsd * spec.sizing.value) / 100;
    let pfExp = 0;
    for (const k of this.markets) pfExp += this.exposure(k);
    const exp = this.exposure(m);
    const dev = L.maxOracleDeviationBps / 1e4;
    const epochLeft = L.maxEpochUsd - s.epochToday;
    // rule 3b: (R − n)(1 − dev) ≥ X + n  ⇒  n ≤ (R(1 − dev) − X) / (2 − dev)
    const reserve = (epochLeft * (1 - dev) - exp) / (2 - dev);
    const terms: Record<string, number> = {
      "the strategy's size": want,
      "the vault's trade cap": L.maxTradeUsd,
      "the position limit": L.maxExposureUsd - exp,
      "the portfolio limit": L.maxPortfolioExposureUsd - pfExp,
      "the day's budget": L.dailyBudgetUsd - s.spentToday,
      "the vault's daily cap": epochLeft,
      "the exit reserve": reserve,
      cash: s.cash / (1 + 1e-9),
    };
    let usd = Infinity;
    let boundBy = "";
    for (const [k, v] of Object.entries(terms)) {
      if (v < usd) {
        usd = v;
        boundBy = k;
      }
    }
    return { usd: Math.max(0, usd), boundBy: boundBy === "the strategy's size" ? "" : boundBy };
  }

  /** Buy on a candidate (≤ its max). Returns the trade or an error in plain words. */
  take(id: string, usd: number, by: Actor, summary: string): { ok: true; trade: Trade } | { ok: false; error: string } {
    const c = this.open_.find((x) => x.id === id);
    if (!c) return { ok: false, error: "no such candidate at this time" };
    if (!(usd > 0)) return { ok: false, error: "amount must be above zero" };
    if (usd > c.maxUsd + 1e-6) return { ok: false, error: `amount $${round(usd)} is above the candidate's max $${c.maxUsd}` };
    this.open_ = this.open_.filter((x) => x.id !== id);
    const m = c.market;
    const s = this.st.get(m)!;
    const p = this.price(m)!;
    const fee = s.hist.feeBps / 1e4;
    const fillPx = p * (1 + this.impactBps(m, usd) / 1e4);
    const tokens = (usd * (1 - fee)) / fillPx;
    const T = this.now;
    s.cash -= usd;
    s.tokens += tokens;
    s.costUsd += usd;
    s.heldSince ??= T;
    s.peakPx = Math.max(s.peakPx, this.exitPx(m) ?? 0);
    s.lastEntryAt = T;
    s.buysToday++;
    s.spentToday += usd;
    s.epochToday += usd;
    const tr: Trade = { t: T, market: m, side: "buy", usd: round(usd, 4), tokens, price: fillPx, feeUsd: round(usd * fee, 4), by, reason: c.reason };
    this.trades.push(tr);
    this.decisions.push({ t: T, cycle: this.cycle, market: m, action: usd < c.maxUsd - 0.005 ? "sized_down" : "bought", usd: round(usd), by, summary });
    return { ok: true, trade: tr };
  }

  /** Decline a candidate (recorded in the sandbox journal). */
  skip(id: string, by: Actor, summary: string, veto = false): void {
    const c = this.open_.find((x) => x.id === id);
    if (!c) return;
    this.open_ = this.open_.filter((x) => x.id !== id);
    this.decisions.push({ t: this.now, cycle: this.cycle, market: c.market, action: veto ? "vetoed" : "skipped", usd: c.maxUsd, by, summary });
  }

  /** Sell (part of) a position now — the AI's early exit. `usd` is capped by the trade and daily caps. */
  sellNow(m: MarketId, usd: number, by: Actor, summary: string): { ok: true; trade: Trade } | { ok: false; error: string } {
    const s = this.st.get(m);
    if (!s || s.tokens <= 0) return { ok: false, error: "nothing to sell" };
    const t = this.sellChunk(m, by, summary, false, usd);
    return t ? { ok: true, trade: t } : { ok: false, error: "the vault's daily cap is used up" };
  }

  private sellChunk(m: MarketId, by: Actor, why: string, stopped: boolean, wantUsd?: number): Trade | null {
    const s = this.st.get(m)!;
    const L = this.input.limits;
    const p = this.price(m)!;
    const value = s.tokens * p;
    const usdCap = Math.min(value, L.maxTradeUsd, L.maxEpochUsd - s.epochToday, wantUsd ?? Infinity);
    if (usdCap <= 0.01) return null;
    const frac = Math.min(1, usdCap / value);
    const tokens = frac >= 0.999 ? s.tokens : s.tokens * frac;
    const fee = s.hist.feeBps / 1e4;
    const px = p * (1 - this.impactBps(m, tokens * p) / 1e4);
    const gross = tokens * px;
    const out = gross * (1 - fee);
    const basis = s.costUsd * (tokens / s.tokens);
    const pnl = out - basis;
    const T = this.now;
    s.tokens -= tokens;
    s.costUsd -= basis;
    s.cash += out;
    s.epochToday += gross;
    s.roundTripPnl += pnl;
    if (s.tokens <= 1e-12) {
      s.tokens = 0;
      s.costUsd = 0;
      s.heldSince = null;
      s.peakPx = 0;
      this.roundTrips.push(s.roundTripPnl);
      s.roundTripPnl = 0;
    }
    if (stopped) s.lockUntil = T + L.reentryCooldownSec;
    const tr: Trade = { t: T, market: m, side: "sell", usd: round(gross, 4), tokens, price: px, feeUsd: round(gross * fee, 4), by, reason: why, pnlUsd: round(pnl, 4) };
    this.trades.push(tr);
    this.decisions.push({ t: T, cycle: this.cycle, market: m, action: "sold", usd: round(gross), by, summary: by === "llm" ? why : `Sold: ${why}` });
    return tr;
  }

  /** Closes the bar: unanswered candidates lapse, equity is recorded, the clock moves one bar. */
  close(): void {
    this.open_ = [];
    this.curve.push({ t: this.now, v: this.equity() - this.capital });
    this.i++;
  }

  stats() {
    return { barsWithData: this.barsWithData, barsInMarket: this.barsInMarket };
  }
}
