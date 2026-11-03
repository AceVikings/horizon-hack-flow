// Lean renderer for a daemon ChartSpec on lightweight-charts (TradingView, Apache-2.0): candles, lines, areas,
// histograms, indicator overlays, a lower pane for oscillators, journal markers, reference lines and a crosshair
// that can be linked across charts (CrosshairLink). The daemon computes every value; this only draws.
import { createContext, useContext, useEffect, useRef } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { INTERVAL_SEC, type ChartDrawing, type ChartIndicator, type ChartSeries, type ChartSpec, type DrawingKind } from "@ate/core";
import { DrawingsPrimitive, timeForLogical } from "./drawings";

const C = { fg: "#171e19", mute: "rgba(23,30,25,.55)", line: "rgba(23,30,25,.08)", sage: "#5d7470", accent: "#a87f00", up: "#13744a", down: "#b3202d" };
const ROLE: Record<NonNullable<ChartSeries["role"]>, string> = { primary: C.fg, secondary: C.sage, muted: "rgba(23,30,25,.35)", accent: C.accent, up: C.up, down: C.down };
const MARK = { buy: { color: C.up, shape: "arrowUp", position: "belowBar" }, sell: { color: C.down, shape: "arrowDown", position: "aboveBar" }, no_trade: { color: "rgba(23,30,25,.4)", shape: "circle", position: "aboveBar" }, strategy: { color: C.sage, shape: "square", position: "aboveBar" }, pause: { color: C.down, shape: "square", position: "aboveBar" }, info: { color: C.sage, shape: "circle", position: "aboveBar" } } as const;

/** Bars an indicator needs before it has a value (warm-up), for the "not enough data" legend note. */
const WARMUP: Record<ChartIndicator, number> = { ema20: 20, ema50: 50, sma20: 20, sma50: 50, vwap: 1, bb20: 20, rsi14: 15, macd: 35, atr14: 14, volume: 1 };
const npts = (s: ChartSeries) => (s.candles?.length ?? 0) + (s.points?.length ?? 0);
/** An indicator series with too few points to draw a line (e.g. EMA 50 over 36 bars): kept out of the chart. */
export const tooThin = (s: ChartSeries) => !!s.indicator && npts(s) < 2;

/** Lower (indicator) pane height: about 30% of the chart, never below 90 px. */
export const lowerPaneHeight = (height: number) => Math.max(96, Math.round(height * 0.3));

/**
 * A plain note when the newest swap is old (a quiet pool): the line is flat because nothing traded, not because the
 * chart is broken. Null when the data is fresh or the chart is not built from pool swaps.
 */
export function staleNote(spec: Pick<ChartSpec, "sources" | "interval" | "kind" | "x">, now = Date.now() / 1000): string | null {
  if (spec.x.type !== "time") return null;
  const src = spec.sources.find((s) => /swap/i.test(s.name) && s.lastT);
  if (!src?.lastT) return null;
  const sec = spec.interval ? INTERVAL_SEC[spec.interval] : 3600;
  const age = now - src.lastT;
  if (age < Math.max(3 * sec, 3 * 3600)) return null;
  const h = age / 3600;
  const span = h < 48 ? `${Math.floor(h)} h` : `${Math.floor(h / 24)} days`;
  return `No swaps in the last ${span}${spec.kind === "price" ? ", price unchanged" : ""}.`;
}

/** The licence credit for lightweight-charts (the in-chart logo is off). */
export function TvCredit() {
  return (
    <a className="tvcredit" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
      Charts by TradingView
    </a>
  );
}

/** Charts whose USD values are amounts of money (cents), not asset prices. */
const MONEY_KINDS = new Set(["pnl", "exposure", "budget", "volume"]);

/** Precision for a price magnitude (HSK ≈ 0.0875 needs 5 dp, BTC ≈ 77 000 needs 2). Money (P&L, exposure, budget,
 * volume) is always cents: a P&L ending near −$1 must not put "−0.9999" on the axis. */
export function precisionFor(v: number, unit: ChartSeries["unit"], kind?: string): number {
  if (unit === "bps" || unit === "index") return unit === "index" ? 1 : 0;
  if (unit === "usd" && kind && MONEY_KINDS.has(kind)) return 2;
  const a = Math.abs(v);
  if (unit === "usd" && a >= 1) return 2;
  if (a === 0) return 2;
  return Math.min(8, Math.max(2, 2 - Math.floor(Math.log10(a)) + 1));
}

// ---- linked crosshair: charts in one CrosshairLink follow each other's time
type Listener = (t: number | null, from: object) => void;
class Bus {
  private ls = new Set<Listener>();
  on(l: Listener) {
    this.ls.add(l);
    return () => void this.ls.delete(l);
  }
  emit(t: number | null, from: object) {
    for (const l of this.ls) l(t, from);
  }
}
const LinkC = createContext<Bus | null>(null);
export function CrosshairLink({ children }: { children: React.ReactNode }) {
  const bus = useRef(new Bus()).current;
  return <LinkC.Provider value={bus}>{children}</LinkC.Provider>;
}

export interface ChartViewProps {
  spec: ChartSpec;
  height?: number;
  /** "line" draws candle series as a plain close line (simple default); "candles" draws OHLC. */
  look?: "line" | "candles";
  /** Hide journal markers. */
  noMarkers?: boolean;
  onMarker?(id: string): void;
  /** Extra drawings (the user's, saved per market) on top of `spec.drawings`. */
  drawings?: ChartDrawing[];
  /** Drawing id to emphasise (e.g. the finding under the pointer). */
  highlight?: string | null;
  logScale?: boolean;
  /** Crosshair readout: OHLC (candles) or a value, with time; null when the pointer leaves. */
  onCrosshair?(r: Readout | null): void;
  /** Active drawing tool: clicks on the chart create a drawing (two clicks for trend, zone, fib). */
  drawTool?: DrawingKind | null;
  /** Label for the text tool. */
  drawText?: string;
  onDraw?(d: ChartDrawing): void;
}

export interface Readout {
  t: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

const ts = (t: number) => t as UTCTimestamp;
const two = (n: number) => String(n).padStart(2, "0");
function localTime(t: number, withDate: boolean): string {
  const d = new Date(t * 1000);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return withDate ? `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}` : hm;
}

export function ChartView({ spec, height = 280, look = "line", noMarkers, onMarker, drawings, highlight = null, logScale, onCrosshair, drawTool = null, drawText, onDraw }: ChartViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const bus = useContext(LinkC);
  const chartRef = useRef<IChartApi | null>(null);
  const primRef = useRef<DrawingsPrimitive | null>(null);
  const pending = useRef<{ t: number; v: number } | null>(null);
  const live = useRef({ onCrosshair, drawTool, drawText, onDraw, drawings, highlight });
  live.current = { onCrosshair, drawTool, drawText, onDraw, drawings, highlight };
  const all = () => [...(spec.drawings ?? []), ...(live.current.drawings ?? [])];
  useEffect(() => {
    if (!el.current) return;
    const cat = spec.x.type === "category";
    const drawn = spec.series.filter((s) => !tooThin(s));
    const lower = drawn.some((s) => s.pane === 1);
    const daily = spec.interval === "1d";
    const chart: IChartApi = createChart(el.current, {
      autoSize: true,
      // attribution: a text credit sits in each chart's footer (TvCredit), not a logo inside the plot
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: C.mute, fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, attributionLogo: false, panes: { separatorColor: C.line } },
      grid: { vertLines: { visible: false }, horzLines: { color: C.line } },
      rightPriceScale: { borderVisible: false, entireTextOnly: true, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: {
        borderVisible: false,
        timeVisible: !daily && !cat,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        // The time scale says what each tick is: a new year / month / day gets the date, the ticks inside a day the
        // time. (Formatting every tick as a date repeated "Nov 3" across a day; every tick as a time hid the days.)
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          if (cat) return spec.categories?.[Number(t) - 1] ?? "";
          const d = new Date(Number(t) * 1000);
          if (type === TickMarkType.Year) return String(d.getFullYear());
          if (type === TickMarkType.Month) return d.toLocaleDateString(undefined, { month: "short" });
          if (type === TickMarkType.DayOfMonth) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          // inside a day: the time (daily bars have no intraday ticks; if one appears, its date would only repeat)
          return daily ? "" : localTime(Number(t), false);
        },
      },
      localization: { timeFormatter: (t: Time) => (cat ? `${spec.categories?.[Number(t) - 1] ?? ""} trade` : localTime(Number(t), true)) },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: "rgba(23,30,25,.3)", labelBackgroundColor: C.fg }, horzLine: { color: "rgba(23,30,25,.3)", labelBackgroundColor: C.fg } },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const made: { s: ISeriesApi<SeriesType>; def: ChartSeries }[] = [];
    for (const def of drawn) {
      const color = ROLE[def.role ?? "primary"];
      const sample = def.candles?.at(-1)?.c ?? def.points?.at(-1)?.v ?? 0;
      const p = precisionFor(sample, def.unit, spec.kind);
      const money = def.unit === "usd" && MONEY_KINDS.has(spec.kind);
      const priceFormat = money
        ? { type: "custom" as const, minMove: 0.01, formatter: (x: number) => `${x < -0.004 ? "−" : ""}$${Math.abs(x).toFixed(2)}` }
        : { type: "price" as const, precision: p, minMove: 10 ** -p };
      const pane = def.pane;
      const xOf = (t: number) => ts(cat ? t + 1 : t);
      let s: ISeriesApi<SeriesType>;
      if (def.type === "candles" && def.candles) {
        if (look === "candles") {
          s = chart.addSeries(CandlestickSeries, { upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down, priceFormat, priceLineVisible: false }, pane);
          s.setData(def.candles.map((c) => ({ time: xOf(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
        } else {
          s = chart.addSeries(AreaSeries, { lineColor: C.fg, lineWidth: 2, topColor: "rgba(23,30,25,.10)", bottomColor: "rgba(23,30,25,0)", priceFormat, priceLineVisible: false, crosshairMarkerRadius: 3 }, pane);
          s.setData(def.candles.map((c) => ({ time: xOf(c.t), value: c.c })));
        }
      } else if (def.type === "histogram") {
        s = chart.addSeries(HistogramSeries, { color, priceFormat, priceLineVisible: false }, pane);
        s.setData((def.points ?? []).map((x) => ({ time: xOf(x.t), value: x.v, color: x.tone === "down" ? "rgba(179,32,45,.55)" : x.tone === "up" ? "rgba(19,116,74,.55)" : color })));
      } else if (def.type === "area") {
        s = chart.addSeries(AreaSeries, { lineColor: color, lineWidth: 2, topColor: "rgba(23,30,25,.10)", bottomColor: "rgba(23,30,25,0)", priceFormat, priceLineVisible: false }, pane);
        s.setData((def.points ?? []).map((x) => ({ time: xOf(x.t), value: x.v })));
      } else {
        const ind = !!def.indicator;
        s = chart.addSeries(LineSeries, { color, lineWidth: ind ? 1 : 2, lineStyle: def.role === "muted" && ind ? LineStyle.Dotted : LineStyle.Solid, priceFormat, priceLineVisible: false, lastValueVisible: !ind || pane === 1, crosshairMarkerVisible: !ind, pointMarkersVisible: cat }, pane);
        s.setData((def.points ?? []).map((x) => ({ time: xOf(x.t), value: x.v })));
      }
      const paneLines = spec.lines.filter((l) => (l.pane ?? 0) === pane).map((l) => l.v);
      if (def.indicator === "rsi14") {
        // RSI is 0–100 by definition: a fixed scale with the usual 30 / 70 guides, so a flat 65 reads as "65 of 100"
        s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
        for (const v of [30, 70]) s.createPriceLine({ price: v, color: "rgba(23,30,25,.28)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: String(v) });
      } else if (paneLines.length && !made.some((m) => m.def.pane === pane))
        s.applyOptions({
          autoscaleInfoProvider: (base: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
            const r = base();
            if (!r?.priceRange) return r;
            return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...paneLines), maxValue: Math.max(r.priceRange.maxValue, ...paneLines) } };
          },
        });
      made.push({ s, def });
    }
    const main = made.find((m) => m.def.pane === 0)?.s ?? made[0]?.s;
    chartRef.current = chart;
    if (main && !cat) {
      const prim = new DrawingsPrimitive();
      main.attachPrimitive(prim);
      primRef.current = prim;
      prim.set(all(), null, live.current.highlight);
    }
    for (const l of spec.lines) {
      const target = made.find((m) => m.def.pane === (l.pane ?? 0))?.s;
      target?.createPriceLine({ price: l.v, color: l.role === "down" ? C.down : l.role === "up" ? C.up : l.role === "accent" ? C.accent : "rgba(23,30,25,.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.label });
    }
    // Skipped cycles ("no trade") are not drawn: they were unlabeled grey dots stacked on the last bar. Every other
    // marker says what it is (B / S, Strategy, Paused).
    const shown = noMarkers ? [] : spec.markers.filter((m) => m.kind !== "no_trade");
    if (main && shown.length) {
      const text = (m: (typeof shown)[number]) => (m.kind === "buy" ? "B" : m.kind === "sell" ? "S" : m.kind === "strategy" ? "Strategy" : m.kind === "pause" ? "Paused" : m.label.slice(0, 16));
      const ms: SeriesMarker<Time>[] = shown.map((m) => ({ time: ts(m.t), color: MARK[m.kind].color, shape: MARK[m.kind].shape, position: MARK[m.kind].position, text: text(m), id: m.id }));
      createSeriesMarkers(main, ms);
    }
    if (lower) {
      chart.panes()[1]?.setHeight(lowerPaneHeight(height));
      // margins keep the lower pane's top label off the price pane's bottom label
      made.find((m) => m.def.pane === 1)?.s.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0.14 } });
    }
    chart.timeScale().fitContent();
    const me = {};
    chart.subscribeCrosshairMove((p) => {
      bus?.emit(p.time === undefined ? null : Number(p.time), me);
      const cb = live.current.onCrosshair;
      if (!cb || !main) return;
      const d = p.time === undefined ? undefined : (p.seriesData.get(main) as { open?: number; high?: number; low?: number; close?: number; value?: number } | undefined);
      if (!d || p.time === undefined) return cb(null);
      cb({ t: Number(p.time), ...(d.close !== undefined ? { o: d.open, h: d.high, l: d.low, c: d.close } : { v: d.value }) });
    });
    chart.subscribeClick((p) => {
      const tool = live.current.drawTool;
      if (!tool || !main || !p.point || cat) return;
      const v = main.coordinateToPrice(p.point.y);
      const lg = chart.timeScale().coordinateToLogical(p.point.x);
      const times = (main.data() as { time: Time }[]).map((x) => Number(x.time));
      const t = lg === null ? null : timeForLogical(Number(lg), times);
      if (v === null || t === null) return;
      const pt = { t, v: Number(v) };
      const emit = live.current.onDraw;
      if (tool === "hline") emit?.({ kind: "hline", a: { v: pt.v } });
      else if (tool === "text") emit?.({ kind: "text", a: pt, label: live.current.drawText?.trim() || "Note" });
      else if (!pending.current) {
        pending.current = pt;
        primRef.current?.set(all(), pt, live.current.highlight);
      } else {
        const a = pending.current;
        pending.current = null;
        emit?.({ kind: tool, a, b: pt });
      }
    });
    if (onMarker) chart.subscribeClick((p) => (p.hoveredObjectId ? onMarker(String(p.hoveredObjectId)) : undefined));
    const off = bus?.on((t, from) => {
      if (from === me || !main || cat) return;
      if (t === null) return chart.clearCrosshairPosition();
      const d = main.data();
      let best: { time: Time; value?: number; close?: number } | null = null;
      for (const x of d as { time: Time; value?: number; close?: number }[]) {
        if (Number(x.time) <= t) best = x;
        else break;
      }
      if (best) chart.setCrosshairPosition(best.value ?? best.close ?? 0, best.time, main);
    });
    return () => {
      off?.();
      chartRef.current = null;
      primRef.current = null;
      chart.remove();
    };
  }, [spec, height, look, noMarkers, bus, onMarker]);
  // drawings, highlight and the pending first point update without rebuilding the chart
  useEffect(() => {
    if (!drawTool) pending.current = null;
    primRef.current?.set(all(), pending.current, highlight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawings, highlight, drawTool, spec]);
  useEffect(() => {
    chartRef.current?.priceScale("right").applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [logScale, spec, look]);
  const keys = spec.series.filter((s) => !(s.indicator && s.type === "histogram"));
  const bars = spec.series.find((s) => s.type === "candles")?.candles?.length ?? 0;
  const stale = staleNote(spec);
  const lowerShown = spec.series.some((s) => s.pane === 1 && !tooThin(s));
  // a lower pane gets its own room: the price pane keeps most of `height`
  const total = lowerShown ? height + lowerPaneHeight(height) : height;
  return (
    <>
      {keys.length > 1 && (
        <div className="clegend">
          {keys.map((s) =>
            tooThin(s) ? (
              <span key={s.id} className="thin" title={s.indicator ? `${s.label} needs at least ${WARMUP[s.indicator]} bars; this chart has ${bars}.` : undefined}>
                <i />
                {s.label} (not enough data)
              </span>
            ) : (
              <span key={s.id}>
                <i style={{ background: ROLE[s.role ?? "primary"] }} />
                {s.label}
              </span>
            ),
          )}
        </div>
      )}
      {stale && <p className="cstale">{stale}</p>}
      <div ref={el} className={`cv${drawTool ? " drawing" : ""}`} style={{ height: total }} />
    </>
  );
}
