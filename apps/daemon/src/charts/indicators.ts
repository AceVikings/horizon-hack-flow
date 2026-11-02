// Server-side chart indicators over candles (pure). Outputs align to the input candles' times; warm-up bars are
// omitted (no NaN on the wire). Standard definitions: EMA k = 2/(n+1) seeded with the SMA; RSI and ATR use
// Wilder smoothing; MACD 12/26/9; Bollinger 20, 2σ (population); VWAP cumulative over the window, typical price.

import type { Candle, ChartIndicator, ChartSeries, Point } from "@ate/core";

export function sma(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i]!;
    if (i >= n) sum -= xs[i - n]!;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

export function ema(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (n + 1);
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < xs.length; i++) {
    if (prev === null) {
      seed += xs[i]!;
      if (i === n - 1) prev = seed / n;
      out.push(prev);
      continue;
    }
    prev = xs[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(xs: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let ag = 0;
  let al = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i]! - xs[i - 1]!;
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= n) {
      ag += g / n;
      al += l / n;
      out.push(i === n ? rsiOf(ag, al) : null);
    } else {
      ag = (ag * (n - 1) + g) / n;
      al = (al * (n - 1) + l) / n;
      out.push(rsiOf(ag, al));
    }
  }
  return out.slice(0, xs.length);
}
const rsiOf = (ag: number, al: number) => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));

export function macd(xs: number[], fast = 12, slow = 26, signal = 9): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const f = ema(xs, fast);
  const s = ema(xs, slow);
  const m = xs.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  const start = m.findIndex((v) => v !== null);
  const sig: (number | null)[] = m.map(() => null);
  if (start >= 0) {
    const e = ema(m.slice(start) as number[], signal);
    e.forEach((v, j) => (sig[start + j] = v));
  }
  return { macd: m, signal: sig, hist: m.map((v, i) => (v !== null && sig[i] !== null ? v - sig[i]! : null)) };
}

export function bollinger(xs: number[], n = 20, k = 2): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(xs, n);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < xs.length; i++) {
    const m = mid[i];
    if (m === null || m === undefined) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (xs[j]! - m) ** 2;
    const sd = Math.sqrt(v / n);
    upper.push(m + k * sd);
    lower.push(m - k * sd);
  }
  return { mid, upper, lower };
}

/** Wilder's ATR. */
export function atr(c: Candle[], n = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let a: number | null = null;
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    const x = c[i]!;
    const tr = i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1]!.c), Math.abs(x.l - c[i - 1]!.c));
    if (i < n) {
      sum += tr;
      if (i === n - 1) a = sum / n;
      out.push(a);
    } else {
      a = (a! * (n - 1) + tr) / n;
      out.push(a);
    }
  }
  return out;
}

/** Cumulative VWAP over the window (typical price × base volume); bars without volume carry the last value. */
export function vwap(c: Candle[]): (number | null)[] {
  let pv = 0;
  let vol = 0;
  return c.map((x) => {
    const v = x.v ?? 0;
    pv += ((x.h + x.l + x.c) / 3) * v;
    vol += v;
    return vol > 0 ? pv / vol : null;
  });
}

const pts = (c: Candle[], ys: (number | null)[]): Point[] => {
  const out: Point[] = [];
  ys.forEach((v, i) => {
    if (v !== null && Number.isFinite(v)) out.push({ t: c[i]!.t, v });
  });
  return out;
};

/** Series for the requested indicators over `c`. Overlays go on pane 0; oscillators on pane 1. */
export function indicatorSeries(c: Candle[], wanted: readonly ChartIndicator[]): ChartSeries[] {
  const close = c.map((x) => x.c);
  const out: ChartSeries[] = [];
  const line = (id: string, label: string, indicator: ChartIndicator, ys: (number | null)[], pane: 0 | 1, role: ChartSeries["role"], unit: ChartSeries["unit"] = "usd"): ChartSeries => ({
    id,
    label,
    type: "line",
    unit,
    pane,
    role,
    indicator,
    points: pts(c, ys),
  });
  for (const w of wanted) {
    switch (w) {
      case "ema20":
      case "ema50":
        out.push(line(w, `EMA ${w.slice(3)}`, w, ema(close, Number(w.slice(3))), 0, w === "ema20" ? "accent" : "secondary"));
        break;
      case "sma20":
      case "sma50":
        out.push(line(w, `SMA ${w.slice(3)}`, w, sma(close, Number(w.slice(3))), 0, w === "sma20" ? "accent" : "secondary"));
        break;
      case "vwap":
        out.push(line("vwap", "VWAP", w, vwap(c), 0, "secondary"));
        break;
      case "bb20": {
        const b = bollinger(close, 20, 2);
        out.push(line("bb20_upper", "Bollinger upper", w, b.upper, 0, "muted"), line("bb20_mid", "Bollinger mid", w, b.mid, 0, "muted"), line("bb20_lower", "Bollinger lower", w, b.lower, 0, "muted"));
        break;
      }
      case "rsi14":
        out.push(line("rsi14", "RSI 14", w, rsi(close, 14), 1, "accent", "index"));
        break;
      case "macd": {
        const m = macd(close);
        out.push(line("macd", "MACD", w, m.macd, 1, "primary"), line("macd_signal", "Signal", w, m.signal, 1, "accent"));
        out.push({
          id: "macd_hist",
          label: "MACD histogram",
          type: "histogram",
          unit: "usd",
          pane: 1,
          indicator: w,
          points: pts(c, m.hist).map((p) => ({ ...p, tone: p.v >= 0 ? "up" : "down" })),
        });
        break;
      }
      case "atr14":
        out.push(line("atr14", "ATR 14", w, atr(c, 14), 1, "accent"));
        break;
    }
  }
  return out;
}
