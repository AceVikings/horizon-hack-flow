// Plain-language chart analysis (lane D4, pure): trend, range, support/resistance from clustered swing points with
// touch counts, momentum (RSI) and volatility (ATR), each finding tied to a drawing. Information, not advice.

import { ANALYSIS_DISCLAIMER, type Candle, type ChartAnalysis, type ChartDrawing, type ChartFinding } from "@ate/core";
import { atr, ema, rsi } from "./indicators.js";

export interface Level {
  price: number;
  touches: number;
  kind: "support" | "resistance";
  lastT: number;
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 5 : v < 100 ? 3 : 0, minimumFractionDigits: v < 1 ? 4 : 0 })}`;
const pct = (x: number) => `${Math.abs(x).toFixed(Math.abs(x) < 1 ? 2 : 1)}%`;

/** Swing highs/lows: a bar whose high (low) is the max (min) of `k` bars on each side. */
export function swings(c: Candle[], k = 2): { highs: { t: number; v: number }[]; lows: { t: number; v: number }[] } {
  const highs: { t: number; v: number }[] = [];
  const lows: { t: number; v: number }[] = [];
  for (let i = k; i < c.length - k; i++) {
    let hi = true;
    let lo = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (c[j]!.h > c[i]!.h) hi = false;
      if (c[j]!.l < c[i]!.l) lo = false;
    }
    // flat stretches (no trades) are not swings
    if (hi && c[i]!.h > c[i]!.l) highs.push({ t: c[i]!.t, v: c[i]!.h });
    if (lo && c[i]!.h > c[i]!.l) lows.push({ t: c[i]!.t, v: c[i]!.l });
  }
  return { highs, lows };
}

/** Clusters swing points within `tol` (fraction of price); touches = points in the cluster. */
export function levels(c: Candle[], tol: number): Level[] {
  if (c.length < 5) return [];
  const last = c.at(-1)!.c;
  const { highs, lows } = swings(c);
  const pts = [...highs, ...lows].sort((a, b) => a.v - b.v);
  const clusters: { v: number[]; t: number[] }[] = [];
  for (const p of pts) {
    const cl = clusters.at(-1);
    const mean = cl ? cl.v.reduce((a, b) => a + b, 0) / cl.v.length : 0;
    if (cl && Math.abs(p.v - mean) / mean <= tol) {
      cl.v.push(p.v);
      cl.t.push(p.t);
    } else clusters.push({ v: [p.v], t: [p.t] });
  }
  // also count bars whose low/high came within tol of the level (retests that were not strict swings)
  return clusters
    .map((cl) => {
      const price = cl.v.reduce((a, b) => a + b, 0) / cl.v.length;
      const kind: Level["kind"] = price <= last ? "support" : "resistance";
      let touches = 0;
      let lastT = 0;
      let inTouch = false;
      for (const x of c) {
        const near = kind === "support" ? Math.abs(x.l - price) / price <= tol : Math.abs(x.h - price) / price <= tol;
        if (near && !inTouch) {
          touches++;
          lastT = x.t;
        }
        inTouch = near;
      }
      return { price, touches: Math.max(touches, cl.v.length), kind, lastT: Math.max(lastT, ...cl.t) };
    })
    .filter((l) => l.touches >= 2);
}

export function analyse(c: Candle[], o: { label: string; interval: string; gapBps?: number | null } = { label: "", interval: "" }): { analysis: ChartAnalysis; drawings: ChartDrawing[] } {
  const findings: ChartFinding[] = [];
  const drawings: ChartDrawing[] = [];
  const from = c[0]?.t ?? 0;
  const to = c.at(-1)?.t ?? 0;
  if (c.length < 5) {
    return { analysis: { summary: `Not enough ${o.label} price history to analyse yet.`, findings, disclaimer: ANALYSIS_DISCLAIMER, from, to }, drawings };
  }
  const span = describeSpan(to - from);
  const first = c[0]!.o;
  const last = c.at(-1)!.c;
  const chg = ((last - first) / first) * 100;
  let hi = c[0]!;
  let lo = c[0]!;
  for (const x of c) {
    if (x.h > hi.h) hi = x;
    if (x.l < lo.l) lo = x;
  }
  const range = hi.h - lo.l;
  const posInRange = range > 0 ? (last - lo.l) / range : 0.5;
  const where = posInRange > 0.8 ? "near the top of its range" : posInRange < 0.2 ? "near the bottom of its range" : "in the middle of its range";
  const flat = Math.abs(chg) < 0.1;
  const summary = `${o.label} ${flat ? "was flat" : chg > 0 ? `rose ${pct(chg)}` : `fell ${pct(chg)}`} over the last ${span} and trades ${where}.`;

  // range zone
  drawings.push({ id: "range", kind: "zone", a: { v: lo.l }, b: { v: hi.h }, label: `Range ${usd(lo.l)}–${usd(hi.h)}`, role: "neutral", by: "agent" });
  findings.push({ text: `Range: ${usd(lo.l)} to ${usd(hi.h)} (${pct((range / lo.l) * 100)} wide).`, drawingId: "range", tone: "neutral" });

  // trend
  const closes = c.map((x) => x.c);
  const fastN = Math.min(20, Math.max(3, Math.floor(c.length / 4)));
  const slowN = Math.min(50, Math.max(fastN + 2, Math.floor(c.length / 2)));
  const f = ema(closes, fastN).at(-1);
  const s = ema(closes, slowN).at(-1);
  if (f != null && s != null) {
    const d = ((f - s) / s) * 100;
    const t = Math.abs(d) < 0.15 ? "sideways" : d > 0 ? "up" : "down";
    findings.push({ text: t === "sideways" ? `Trend: sideways — the short and long averages are close together.` : `Trend: ${t} — the ${fastN}-bar average is ${pct(d)} ${d > 0 ? "above" : "below"} the ${slowN}-bar average.`, tone: t === "up" ? "up" : t === "down" ? "down" : "neutral" });
  }

  // support / resistance
  const a = atr(c, Math.min(14, c.length - 1)).at(-1) ?? range / 10;
  const tol = Math.min(0.01, Math.max(0.0015, (0.35 * a) / last));
  const lv = levels(c, tol);
  const sup = lv.filter((l) => l.kind === "support").sort((x, y) => y.touches - x.touches || y.price - x.price)[0];
  const res = lv.filter((l) => l.kind === "resistance").sort((x, y) => y.touches - x.touches || x.price - y.price)[0];
  if (sup) {
    drawings.push({ id: "support", kind: "hline", a: { v: sup.price }, label: `Support ${usd(sup.price)}`, role: "support", by: "agent" });
    findings.push({ text: `Support near ${usd(sup.price)} — tested ${sup.touches} times, ${pct(((last - sup.price) / last) * 100)} below the last price.`, drawingId: "support", tone: "up" });
  }
  if (res) {
    drawings.push({ id: "resistance", kind: "hline", a: { v: res.price }, label: `Resistance ${usd(res.price)}`, role: "resistance", by: "agent" });
    findings.push({ text: `Resistance near ${usd(res.price)} — tested ${res.touches} times, ${pct(((res.price - last) / last) * 100)} above the last price.`, drawingId: "resistance", tone: "down" });
  }
  if (!sup && !res) findings.push({ text: "No clear support or resistance: the price has not returned to the same level twice in this window.", tone: "neutral" });

  // momentum and volatility
  const empty = c.filter((x) => x.v === 0).length / c.length;
  const r = empty > 0.4 ? null : rsi(closes, Math.min(14, c.length - 1)).at(-1);
  if (empty > 0.4) findings.push({ text: `This pool trades rarely (${Math.round(empty * 100)}% of bars have no trades), so momentum readings are not meaningful.`, tone: "neutral" });
  if (r != null) {
    const state = r >= 70 ? "stretched up (above 70): rises often pause here" : r <= 30 ? "stretched down (below 30): falls often pause here" : "neutral (between 30 and 70)";
    findings.push({ text: `Momentum (RSI ${Math.round(r)}): ${state}.`, tone: r >= 70 ? "down" : r <= 30 ? "up" : "neutral" });
  }
  findings.push({ text: `A typical ${o.interval} bar moves about ${pct((a / last) * 100)}.`, tone: "neutral" });
  if (o.gapBps !== undefined && o.gapBps !== null) {
    findings.push({ text: `The pool is ${pct(o.gapBps / 100)} ${o.gapBps < 0 ? "below" : "above"} the on-chain oracle price now. The round-trip pool fee is 0.60%.`, tone: "neutral" });
  }
  return { analysis: { summary, findings, disclaimer: ANALYSIS_DISCLAIMER, from, to }, drawings };
}

function describeSpan(sec: number): string {
  if (sec >= 2 * 86_400) return `${Math.round(sec / 86_400)} days`;
  if (sec >= 2 * 3600) return `${Math.round(sec / 3600)} hours`;
  return `${Math.max(1, Math.round(sec / 60))} minutes`;
}
