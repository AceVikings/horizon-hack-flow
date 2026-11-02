// Drawings on a lightweight-charts series via the series-primitives API: horizontal levels, trendlines, zones,
// Fibonacci retracements and text notes. Times map to x through the series' bars (interpolated between bars and
// extrapolated past the ends), so a drawing keeps its place when the timeframe changes. Saved per market.
import { useCallback, useEffect, useState } from "react";
import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, IPrimitivePaneView, Logical, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";
import { validateDrawings, type ChartDrawing, type MarketId } from "@ate/core";

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
type CanvasRenderingTarget2D = Parameters<IPrimitivePaneRenderer["draw"]>[0];
const COLOR = { support: "#13744a", resistance: "#b3202d", neutral: "#171e19", agent: "#5d7470", fill: "rgba(23,30,25,.06)", fillS: "rgba(19,116,74,.08)", fillR: "rgba(179,32,45,.07)" };

const colorOf = (d: ChartDrawing) => (d.role === "support" ? COLOR.support : d.role === "resistance" ? COLOR.resistance : d.by === "agent" ? COLOR.agent : COLOR.neutral);
const fmt = (v: number) => (v >= 100 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));

/** Pure: x for unix time `t` given the bar times and a logical→x mapper. Interpolates; extrapolates by bar spacing. */
export function xForTime(t: number, times: number[], logicalToX: (l: number) => number | null): number | null {
  if (!times.length) return null;
  let lo = 0;
  let hi = times.length - 1;
  if (t <= times[0]!) {
    const step = times.length > 1 ? times[1]! - times[0]! : 1;
    return logicalToX((t - times[0]!) / step);
  }
  if (t >= times[hi]!) {
    const step = times.length > 1 ? times[hi]! - times[hi - 1]! : 1;
    return logicalToX(hi + (t - times[hi]!) / step);
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return logicalToX(lo + (t - times[lo]!) / (times[hi]! - times[lo]!));
}

/** Pure: unix time for an x coordinate (inverse of xForTime). */
export function timeForLogical(l: number, times: number[]): number | null {
  if (!times.length) return null;
  const i = Math.floor(l);
  if (i < 0) return Math.round(times[0]! + l * (times.length > 1 ? times[1]! - times[0]! : 1));
  if (i >= times.length - 1) return Math.round(times.at(-1)! + (l - (times.length - 1)) * (times.length > 1 ? times.at(-1)! - times.at(-2)! : 1));
  return Math.round(times[i]! + (l - i) * (times[i + 1]! - times[i]!));
}

/** Pure: the price levels of a Fibonacci retracement from a (start) to b (end). */
export function fibLevels(a: number, b: number): { r: number; v: number }[] {
  return FIB_LEVELS.map((r) => ({ r, v: b - (b - a) * r }));
}

class Renderer implements IPrimitivePaneRenderer {
  constructor(private readonly p: DrawingsPrimitive) {}
  draw(target: CanvasRenderingTarget2D): void {
    const { chart, series } = this.p;
    if (!chart || !series) return;
    const times = (series.data() as { time: Time }[]).map((d) => Number(d.time));
    const ts = chart.timeScale();
    const X = (t: number | undefined) => (t === undefined ? null : xForTime(t, times, (l) => ts.logicalToCoordinate(l as Logical)));
    const Y = (v: number) => series.priceToCoordinate(v);
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = mediaSize.width;
      ctx.font = "500 11px Inter, system-ui, sans-serif";
      const placed: { x: number; y: number; w: number }[] = [];
      const label = (text: string, x: number, yIn: number, color: string, align: "left" | "right" = "left") => {
        const w = ctx.measureText(text).width + 8;
        const x0 = align === "left" ? x : x - w;
        // labels never overlap: nudge down past any label already drawn in the same spot; drop after 4 tries
        let y = yIn;
        for (let k = 0; k < 4 && placed.some((p) => x0 < p.x + p.w && p.x < x0 + w && Math.abs(p.y - y) < 15); k++) y += 15;
        if (placed.some((p) => x0 < p.x + p.w && p.x < x0 + w && Math.abs(p.y - y) < 15)) return;
        placed.push({ x: x0, y, w });
        ctx.fillStyle = "rgba(255,255,255,.88)";
        ctx.fillRect(x0, y - 15, w, 15);
        ctx.fillStyle = color;
        ctx.fillText(text, x0 + 4, y - 4);
      };
      for (const d of this.p.drawings) {
        const c = colorOf(d);
        ctx.strokeStyle = c;
        ctx.lineWidth = d.id === this.p.highlight ? 2.5 : 1.5;
        ctx.setLineDash(d.by === "agent" && d.kind === "hline" ? [6, 4] : []);
        const ya = Y(d.a.v);
        if (d.kind === "hline") {
          if (ya === null) continue;
          ctx.beginPath();
          ctx.moveTo(0, ya);
          ctx.lineTo(W, ya);
          ctx.stroke();
          label(d.label ?? `$${fmt(d.a.v)}`, 6, ya - 2, c);
        } else if (d.kind === "trend" && d.b) {
          const xa = X(d.a.t);
          const xb = X(d.b.t);
          const yb = Y(d.b.v);
          if (xa === null || xb === null || ya === null || yb === null) continue;
          ctx.beginPath();
          ctx.moveTo(xa, ya);
          ctx.lineTo(xb, yb);
          ctx.stroke();
          for (const [x, y] of [[xa, ya], [xb, yb]] as const) {
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fillStyle = c;
            ctx.fill();
          }
          if (d.label) label(d.label, xb + 6, yb, c);
        } else if (d.kind === "zone" && d.b) {
          const yb = Y(d.b.v);
          if (ya === null || yb === null) continue;
          const xa = d.a.t !== undefined ? (X(d.a.t) ?? 0) : 0;
          const xb = d.b.t !== undefined ? (X(d.b.t) ?? W) : W;
          ctx.fillStyle = d.role === "support" ? COLOR.fillS : d.role === "resistance" ? COLOR.fillR : COLOR.fill;
          ctx.fillRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya));
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya));
          if (d.label) label(d.label, Math.min(xa, xb) + 6, Math.min(ya, yb) + 16, c);
        } else if (d.kind === "fib" && d.b) {
          const xa = X(d.a.t) ?? 0;
          ctx.lineWidth = 1;
          for (const f of fibLevels(d.a.v, d.b.v)) {
            const y = Y(f.v);
            if (y === null) continue;
            ctx.setLineDash(f.r === 0 || f.r === 1 ? [] : [4, 3]);
            ctx.beginPath();
            ctx.moveTo(xa, y);
            ctx.lineTo(W, y);
            ctx.stroke();
            label(`${(f.r * 100).toFixed(1)}%  $${fmt(f.v)}`, W - 6, y - 1, c, "right");
          }
        } else if (d.kind === "text") {
          const x = X(d.a.t);
          if (x === null || ya === null) continue;
          ctx.beginPath();
          ctx.arc(x, ya, 3, 0, Math.PI * 2);
          ctx.fillStyle = c;
          ctx.fill();
          label(d.label ?? "Note", x + 6, ya - 4, c);
        }
      }
      // first point of a two-click drawing in progress
      if (this.p.pending) {
        const x = X(this.p.pending.t);
        const y = Y(this.p.pending.v);
        if (x !== null && y !== null) {
          ctx.setLineDash([]);
          ctx.strokeStyle = COLOR.neutral;
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    });
  }
}

class View implements IPrimitivePaneView {
  private readonly r: Renderer;
  constructor(p: DrawingsPrimitive) {
    this.r = new Renderer(p);
  }
  zOrder(): "top" {
    return "top";
  }
  renderer(): IPrimitivePaneRenderer {
    return this.r;
  }
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  drawings: ChartDrawing[] = [];
  pending: { t: number; v: number } | null = null;
  highlight: string | null = null;
  private request: (() => void) | null = null;
  private readonly views: View[] = [new View(this)];
  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart as IChartApi;
    this.series = p.series;
    this.request = p.requestUpdate;
  }
  detached(): void {
    this.chart = null;
    this.series = null;
    this.request = null;
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
  set(drawings: ChartDrawing[], pending: { t: number; v: number } | null, highlight: string | null): void {
    this.drawings = drawings;
    this.pending = pending;
    this.highlight = highlight;
    this.request?.();
  }
}

// ---------------------------------------------------------------- per-market storage

const KEY = (m: MarketId) => `flow.drawings.v1.${m}`;
const EVT = "flow:drawings";
export function readDrawings(m: MarketId): ChartDrawing[] {
  try {
    return validateDrawings(JSON.parse(localStorage.getItem(KEY(m)) ?? "[]")).drawings.map((d) => ({ ...d, by: "user" as const }));
  } catch {
    return [];
  }
}
export function saveDrawings(m: MarketId, ds: ChartDrawing[]): void {
  localStorage.setItem(KEY(m), JSON.stringify(ds.slice(-20)));
  window.dispatchEvent(new Event(EVT));
}
/** Adds drawings (e.g. "Keep drawings" from the agent) to a market's saved drawings, as the user's. */
export function keepDrawings(m: MarketId, ds: ChartDrawing[]): void {
  const now = readDrawings(m);
  saveDrawings(m, [...now, ...ds.map((d, i) => ({ ...d, by: "user" as const, id: `k${Date.now().toString(36)}${i}` }))]);
}
export function useDrawings(m: MarketId): { drawings: ChartDrawing[]; add(d: ChartDrawing): void; undo(): void; clear(): void } {
  const [ds, setDs] = useState<ChartDrawing[]>(() => readDrawings(m));
  useEffect(() => {
    setDs(readDrawings(m));
    const on = () => setDs(readDrawings(m));
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, [m]);
  const add = useCallback((d: ChartDrawing) => saveDrawings(m, [...readDrawings(m), { ...d, by: "user", id: d.id ?? `u${Date.now().toString(36)}` }]), [m]);
  const undo = useCallback(() => saveDrawings(m, readDrawings(m).slice(0, -1)), [m]);
  const clear = useCallback(() => saveDrawings(m, []), [m]);
  return { drawings: ds, add, undo, clear };
}
