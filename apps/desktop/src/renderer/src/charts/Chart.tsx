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
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartSeries, ChartSpec } from "@ate/core";

const C = { fg: "#171e19", mute: "rgba(23,30,25,.55)", line: "rgba(23,30,25,.08)", sage: "#5d7470", accent: "#a87f00", up: "#13744a", down: "#b3202d" };
const ROLE: Record<NonNullable<ChartSeries["role"]>, string> = { primary: C.fg, secondary: C.sage, muted: "rgba(23,30,25,.35)", accent: C.accent, up: C.up, down: C.down };
const MARK = { buy: { color: C.up, shape: "arrowUp", position: "belowBar" }, sell: { color: C.down, shape: "arrowDown", position: "aboveBar" }, no_trade: { color: "rgba(23,30,25,.4)", shape: "circle", position: "aboveBar" }, strategy: { color: C.sage, shape: "square", position: "aboveBar" }, pause: { color: C.down, shape: "square", position: "aboveBar" }, info: { color: C.sage, shape: "circle", position: "aboveBar" } } as const;

/** Precision for a price magnitude (HSK ≈ 0.0875 needs 5 dp, BTC ≈ 77 000 needs 2). */
export function precisionFor(v: number, unit: ChartSeries["unit"]): number {
  if (unit === "bps" || unit === "index") return unit === "index" ? 1 : 0;
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
}

const ts = (t: number) => t as UTCTimestamp;
const two = (n: number) => String(n).padStart(2, "0");
function localTime(t: number, withDate: boolean): string {
  const d = new Date(t * 1000);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return withDate ? `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}` : hm;
}

export function ChartView({ spec, height = 280, look = "line", noMarkers, onMarker }: ChartViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const bus = useContext(LinkC);
  useEffect(() => {
    if (!el.current) return;
    const cat = spec.x.type === "category";
    const lower = spec.series.some((s) => s.pane === 1);
    const daily = spec.interval === "1d";
    const chart: IChartApi = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: C.mute, fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, panes: { separatorColor: C.line } },
      grid: { vertLines: { visible: false }, horzLines: { color: C.line } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: {
        borderVisible: false,
        timeVisible: !daily && !cat,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (t: Time) => (cat ? (spec.categories?.[Number(t) - 1] ?? "") : daily ? new Date(Number(t) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : localTime(Number(t), false)),
      },
      localization: { timeFormatter: (t: Time) => (cat ? `${spec.categories?.[Number(t) - 1] ?? ""} trade` : localTime(Number(t), true)) },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: "rgba(23,30,25,.3)", labelBackgroundColor: C.fg }, horzLine: { color: "rgba(23,30,25,.3)", labelBackgroundColor: C.fg } },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const made: { s: ISeriesApi<SeriesType>; def: ChartSeries }[] = [];
    for (const def of spec.series) {
      const color = ROLE[def.role ?? "primary"];
      const sample = def.candles?.at(-1)?.c ?? def.points?.at(-1)?.v ?? 0;
      const p = precisionFor(sample, def.unit);
      const priceFormat = { type: "price" as const, precision: p, minMove: 10 ** -p };
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
      if (paneLines.length && !made.some((m) => m.def.pane === pane))
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
    for (const l of spec.lines) {
      const target = made.find((m) => m.def.pane === (l.pane ?? 0))?.s;
      target?.createPriceLine({ price: l.v, color: l.role === "down" ? C.down : l.role === "up" ? C.up : l.role === "accent" ? C.accent : "rgba(23,30,25,.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.label });
    }
    if (main && !noMarkers && spec.markers.length) {
      const ms: SeriesMarker<Time>[] = spec.markers.map((m) => ({ time: ts(m.t), color: MARK[m.kind].color, shape: MARK[m.kind].shape, position: MARK[m.kind].position, text: m.kind === "buy" || m.kind === "sell" ? (m.kind === "buy" ? "B" : "S") : "", id: m.id }));
      createSeriesMarkers(main, ms);
    }
    if (lower) chart.panes()[1]?.setHeight(Math.round(height * 0.3));
    chart.timeScale().fitContent();
    const me = {};
    chart.subscribeCrosshairMove((p) => bus?.emit(p.time === undefined ? null : Number(p.time), me));
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
      chart.remove();
    };
  }, [spec, height, look, noMarkers, bus, onMarker]);
  const keys = spec.series.filter((s) => !(s.indicator && s.type === "histogram"));
  return (
    <>
      {keys.length > 1 && (
        <div className="clegend">
          {keys.map((s) => (
            <span key={s.id}>
              <i style={{ background: ROLE[s.role ?? "primary"] }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div ref={el} className="cv" style={{ height }} />
    </>
  );
}
