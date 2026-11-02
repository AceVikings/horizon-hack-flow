// Signals for custom strategies (lane STRAT): a fixed-grid bar series per market (pool, HashKey Global, oracle,
// volume) and causal indicators over it. Every value at bar i uses bars ≤ i only (no look-ahead), so the live
// generator, the backtest and the simulation evaluate the same rules the same way.

import type { Condition, StrategySpec } from "@ate/core";

export interface Bar {
  /** Bar open time, unix seconds (grid aligned). */
  t: number;
  /** Pool price at the bar close (last swap at or before the close), USD; null before the first swap. */
  pool: number | null;
  /** HashKey Global close, USD; null when missing. */
  cex: number | null;
  /** Oracle price at the bar close, USD; null when unknown. */
  oracle: number | null;
  /** Pool volume in the bar, USD. */
  vol: number;
}

/** Position facts the exit signals need. */
export interface PositionFacts {
  /** Exit-executable P&L of the open position in % (null when flat). */
  pnlPct: number | null;
}

type Series = (number | null)[];

/** Causal indicators over a bar series, computed once per (kind, period) and cached. */
export class SignalBook {
  private cache = new Map<string, Series>();
  readonly closes: Series;
  private cexBook: SignalBook | null = null;
  constructor(
    readonly bars: readonly Bar[],
    readonly barSec: number,
    readonly src: "pool" | "oracle" | "cex" | "onchain" = "pool",
  ) {
    // on-chain series: "onchain" = the pool price where the pool traded in the bar, else the oracle price (the pool
    // trades rarely, so its bars alone are mostly flat); "oracle" = the oracle price only
    this.closes =
      src === "pool" ? bars.map((b) => b.pool) : src === "oracle" ? bars.map((b) => b.oracle ?? b.pool) : src === "cex" ? bars.map((b) => b.cex ?? b.pool) : onchain(bars);
  }
  private cex(src: "oracle" | "cex" | "onchain"): SignalBook {
    if (!this.cexBook || this.cexBook.src !== src) this.cexBook = new SignalBook(this.bars, this.barSec, src);
    return this.cexBook;
  }

  private memo(key: string, f: () => Series): Series {
    let s = this.cache.get(key);
    if (!s) {
      s = f();
      this.cache.set(key, s);
    }
    return s;
  }

  /** Closes with gaps carried forward (indicators need a continuous series). */
  private filled(): Series {
    return this.memo("filled", () => {
      let last: number | null = null;
      return this.closes.map((c) => (c !== null ? (last = c) : last));
    });
  }

  sma(n: number): Series {
    return this.memo(`sma${n}`, () => {
      const xs = this.filled();
      const out: Series = [];
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i] ?? null;
        if (x !== null) {
          sum += x;
          cnt++;
        }
        const drop = i - n >= 0 ? (xs[i - n] ?? null) : null;
        if (drop !== null) {
          sum -= drop;
          cnt--;
        }
        out.push(cnt >= n ? sum / cnt : null);
      }
      return out;
    });
  }

  ema(n: number): Series {
    return this.memo(`ema${n}`, () => {
      const xs = this.filled();
      const k = 2 / (n + 1);
      const out: Series = [];
      let e: number | null = null;
      let seen = 0;
      for (const x of xs) {
        if (x === null) {
          out.push(null);
          continue;
        }
        seen++;
        e = e === null ? x : x * k + e * (1 - k);
        out.push(seen >= n ? e : null);
      }
      return out;
    });
  }

  rsi(n: number): Series {
    return this.memo(`rsi${n}`, () => {
      const xs = this.filled();
      const out: Series = [null];
      let g = 0;
      let l = 0;
      let cnt = 0;
      for (let i = 1; i < xs.length; i++) {
        const a = xs[i - 1] ?? null;
        const b = xs[i] ?? null;
        if (a === null || b === null) {
          out.push(null);
          continue;
        }
        const d = b - a;
        const up = Math.max(0, d);
        const dn = Math.max(0, -d);
        cnt++;
        if (cnt <= n) {
          g += up / n;
          l += dn / n;
        } else {
          g = (g * (n - 1) + up) / n;
          l = (l * (n - 1) + dn) / n;
        }
        out.push(cnt < n ? null : l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
      }
      return out;
    });
  }

  /** %B: (price − lower) / (upper − lower) with a 2σ band over n bars. */
  bollinger(n: number): Series {
    return this.memo(`bb${n}`, () => {
      const xs = this.filled();
      const mid = this.sma(n);
      return xs.map((x, i) => {
        const m = mid[i] ?? null;
        if (x === null || m === null || i + 1 < n) return null;
        let v = 0;
        for (let j = i - n + 1; j <= i; j++) v += ((xs[j] ?? m) - m) ** 2;
        const sd = Math.sqrt(v / n);
        if (sd === 0) return 0.5;
        return (x - (m - 2 * sd)) / (4 * sd);
      });
    });
  }

  /** Rolling VWAP over n bars (equal weights when no volume). */
  vwap(n: number): Series {
    return this.memo(`vwap${n}`, () => {
      const xs = this.filled();
      return xs.map((_, i) => {
        if (i + 1 < n) return null;
        let pv = 0;
        let v = 0;
        let s = 0;
        let c = 0;
        for (let j = i - n + 1; j <= i; j++) {
          const p = xs[j] ?? null;
          if (p === null) continue;
          const w = this.bars[j]!.vol;
          pv += p * w;
          v += w;
          s += p;
          c++;
        }
        if (!c) return null;
        return v > 0 ? pv / v : s / c;
      });
    });
  }

  /** Highest / lowest close over the `n` bars before i (the current bar excluded). */
  private extreme(n: number, hi: boolean): Series {
    return this.memo(`${hi ? "hi" : "lo"}${n}`, () => {
      const xs = this.filled();
      return xs.map((_, i) => {
        if (i < n) return null;
        let m: number | null = null;
        for (let j = i - n; j < i; j++) {
          const x = xs[j] ?? null;
          if (x !== null && (m === null || (hi ? x > m : x < m))) m = x;
        }
        return m;
      });
    });
  }
  /** Standard deviation of bar-to-bar % moves over n bars. */
  volatility(n: number): Series {
    return this.memo(`vol${n}`, () => {
      const xs = this.filled();
      return xs.map((_, i) => {
        if (i < n) return null;
        const r: number[] = [];
        for (let j = i - n + 1; j <= i; j++) {
          const a = xs[j - 1] ?? null;
          const b = xs[j] ?? null;
          if (a && b) r.push(((b - a) / a) * 100);
        }
        if (r.length < 2) return null;
        const m = r.reduce((x, y) => x + y, 0) / r.length;
        return Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / r.length);
      });
    });
  }
  /** Pool volume of the last n bars vs the average n-bar volume of the 4n bars before (100 = normal). */
  volumeRatio(n: number): Series {
    return this.memo(`vr${n}`, () =>
      this.bars.map((_, i) => {
        if (i < 5 * n - 1) return null;
        let now = 0;
        let before = 0;
        for (let j = i - n + 1; j <= i; j++) now += this.bars[j]!.vol;
        for (let j = i - 5 * n + 1; j <= i - n; j++) before += this.bars[j]!.vol;
        const avg = before / 4;
        return avg > 0 ? (now / avg) * 100 : now > 0 ? 1000 : 100;
      }),
    );
  }

  /** Value of a condition's signal at bar i (null = not enough data). */
  value(c: Condition, i: number, pos: PositionFacts = { pnlPct: null }): number | null {
    const b = this.bars[i];
    if (!b) return null;
    // price-action signals read on-chain prices: the pool where it traded, the oracle in between (default)
    if (this.src === "pool" && PRICE_ACTION.has(c.signal)) {
      const want = c.source === "oracle" ? "oracle" : c.source === "cex" ? "cex" : "onchain";
      return this.cex(want).value(c, i, pos);
    }
    const p = this.filled()[i] ?? null;
    const dist = (ref: number | null) => (p === null || ref === null || ref <= 0 ? null : ((p - ref) / ref) * 100);
    switch (c.signal) {
      case "gap_cex":
        return b.pool === null || b.cex === null ? null : dist(b.cex);
      case "gap_oracle":
        return b.pool === null || b.oracle === null ? null : dist(b.oracle);
      case "change": {
        const back = Math.max(1, Math.round(((c.windowMin ?? 60) * 60) / this.barSec));
        const prev = i - back >= 0 ? (this.filled()[i - back] ?? null) : null;
        return dist(prev);
      }
      case "ema":
        return dist(this.ema(c.period ?? 20)[i] ?? null);
      case "sma":
        return dist(this.sma(c.period ?? 20)[i] ?? null);
      case "vwap":
        return dist(this.vwap(c.period ?? 20)[i] ?? null);
      case "rsi":
        return this.rsi(c.period ?? 14)[i] ?? null;
      case "bollinger":
        return this.bollinger(c.period ?? 20)[i] ?? null;
      case "hour":
        return new Date((b.t + this.barSec) * 1000).getUTCHours();
      case "pnl":
        return pos.pnlPct;
      case "ma_cross": {
        const f = c.ma === "sma" ? this.sma(c.period ?? 20) : this.ema(c.period ?? 20);
        const sl = c.ma === "sma" ? this.sma(c.period2 ?? 50) : this.ema(c.period2 ?? 50);
        const a = f[i] ?? null;
        const b = sl[i] ?? null;
        return a === null || b === null || b <= 0 ? null : ((a - b) / b) * 100;
      }
      case "resistance":
        return dist(this.extreme(c.period ?? 48, true)[i] ?? null);
      case "support":
        return dist(this.extreme(c.period ?? 48, false)[i] ?? null);
      case "volatility":
        return this.volatility(c.period ?? 24)[i] ?? null;
      case "trend": {
        const n = c.period ?? 50;
        const e = this.ema(n);
        const now = e[i] ?? null;
        const then = i - n >= 0 ? (e[i - n] ?? null) : null;
        return now === null || then === null || then <= 0 ? null : ((now - then) / then) * 100;
      }
      case "volume":
        return this.volumeRatio(c.period ?? 12)[i] ?? null;
    }
  }

  /** Does the condition hold at bar i? Missing data → false. */
  holds(c: Condition, i: number, pos?: PositionFacts): boolean {
    const v = this.value(c, i, pos);
    if (v === null) return false;
    if (c.op === "crosses_above" || c.op === "crosses_below") {
      const p = i > 0 ? this.value(c, i - 1, pos) : null;
      if (p === null) return false;
      return c.op === "crosses_above" ? p <= c.value && v > c.value : p >= c.value && v < c.value;
    }
    return test(c, v);
  }

  entryHolds(s: StrategySpec, i: number): boolean {
    const xs = s.entry.conditions.map((c) => this.holds(c, i));
    return s.entry.when === "all" ? xs.every(Boolean) : xs.some(Boolean);
  }

  /** First exit rule that holds at bar i ("" when none). */
  exitRule(s: StrategySpec, i: number, pos: PositionFacts): Condition | null {
    for (const c of s.exit.conditions) if (this.holds(c, i, pos)) return c;
    return null;
  }

  /** Bars of history the spec needs before its first evaluation. */
  static warmup(s: StrategySpec): number {
    const barSec = s.barMinutes * 60;
    let n = 1;
    for (const c of [...s.entry.conditions, ...s.exit.conditions]) {
      if (c.signal === "change") n = Math.max(n, Math.ceil(((c.windowMin ?? 60) * 60) / barSec) + 1);
      else if (c.signal === "rsi") n = Math.max(n, (c.period ?? 14) + 1);
      else if (c.signal === "ema" || c.signal === "sma" || c.signal === "vwap" || c.signal === "bollinger") n = Math.max(n, c.period ?? 20);
      else if (c.signal === "ma_cross") n = Math.max(n, c.period2 ?? 50, c.period ?? 20) + 1;
      else if (c.signal === "resistance" || c.signal === "support") n = Math.max(n, (c.period ?? 48) + 1);
      else if (c.signal === "volatility") n = Math.max(n, (c.period ?? 24) + 1);
      else if (c.signal === "trend") n = Math.max(n, 2 * (c.period ?? 50) + 1);
      else if (c.signal === "volume") n = Math.max(n, 5 * (c.period ?? 12));
    }
    return n;
  }
}

/** Pool close where the pool traded in the bar, else the oracle price scaled to the last pool/oracle ratio. */
function onchain(bars: readonly Bar[]): (number | null)[] {
  let ratio = 1;
  let lastPool: number | null = null;
  return bars.map((b, i) => {
    const traded = b.pool !== null && b.vol > 0;
    if (traded && b.oracle) ratio = b.pool! / b.oracle;
    if (traded || (b.pool !== null && i === 0)) {
      lastPool = b.pool;
      return b.pool;
    }
    return b.oracle !== null ? b.oracle * ratio : lastPool;
  });
}

const PRICE_ACTION = new Set<string>(["change", "ema", "sma", "vwap", "rsi", "bollinger", "ma_cross", "resistance", "support", "volatility", "trend"]);

export function test(c: Condition, v: number): boolean {
  if (c.op === "above" || c.op === "crosses_above") return v > c.value;
  if (c.op === "crosses_below") return v < c.value;
  if (c.op === "below") return v < c.value;
  const lo = c.value;
  const hi = c.value2 ?? c.value;
  if (c.signal === "hour" && lo > hi) return v >= lo || v < hi; // wraps midnight
  return v >= lo && v < hi + (c.signal === "hour" ? 0 : 1e-12);
}

/** Bars on a fixed grid from point samples (last value at or before each bar close; volume summed). */
export function barsFromPoints(
  barSec: number,
  from: number,
  to: number,
  pool: readonly { t: number; v: number; vol?: number }[],
  cex: readonly { t: number; v: number }[],
  oracle: readonly { t: number; v: number }[],
  o: { cexMaxAgeSec?: number; oracleMaxAgeSec?: number } = {},
): Bar[] {
  const start = Math.floor(from / barSec) * barSec;
  const out: Bar[] = [];
  let ip = 0;
  let ic = 0;
  let io = 0;
  let lastPool: number | null = null;
  let lastCex: { t: number; v: number } | null = null;
  let lastOracle: { t: number; v: number } | null = null;
  const cexAge = o.cexMaxAgeSec ?? Math.max(300, barSec);
  const oraAge = o.oracleMaxAgeSec ?? 7 * 86_400;
  for (let t = start; t + barSec <= to + barSec && t <= to; t += barSec) {
    const close = t + barSec;
    let vol = 0;
    while (ip < pool.length && pool[ip]!.t < close) {
      const p = pool[ip]!;
      if (p.t >= t) vol += p.vol ?? 0;
      lastPool = p.v;
      ip++;
    }
    while (ic < cex.length && cex[ic]!.t < close) lastCex = cex[ic++]!;
    while (io < oracle.length && oracle[io]!.t < close) lastOracle = oracle[io++]!;
    out.push({
      t,
      pool: lastPool,
      cex: lastCex && close - lastCex.t <= cexAge + barSec ? lastCex.v : null,
      oracle: lastOracle && close - lastOracle.t <= oraAge ? lastOracle.v : null,
      vol,
    });
  }
  return out;
}
