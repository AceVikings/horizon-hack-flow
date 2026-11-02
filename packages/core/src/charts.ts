// ADDITIVE (Flow v1 lane D4): typed chart specs and data tables returned by the read-only `ate_chart` and
// `ate_data` tools. The daemon computes everything (series, indicators, markers); clients only render.
// Times are unix seconds; values are plain JS numbers in the unit named by the series (charts, not accounting).

import type { MarketId } from "./markets.js";

export const CHART_KINDS = ["price", "cex", "oracle", "spread", "depth", "volume", "pnl", "exposure", "budget"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const CHART_INTERVALS = ["1m", "5m", "1h", "1d"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];
export const INTERVAL_SEC: Record<ChartInterval, number> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86_400 };

/** Server-side indicators. Overlays (main pane): ema*, sma*, vwap, bb20. Lower pane: rsi14, macd, atr14. */
export const CHART_INDICATORS = ["ema20", "ema50", "sma20", "sma50", "vwap", "bb20", "rsi14", "macd", "atr14", "volume"] as const;
export type ChartIndicator = (typeof CHART_INDICATORS)[number];

/** Market-data network: the daemon's own chain (where the vaults are) or HashKey Chain mainnet (177). */
export const CHART_NETWORKS = ["vault", "mainnet"] as const;
export type ChartNetwork = (typeof CHART_NETWORKS)[number];

export interface ChartInput {
  kind: ChartKind;
  market?: MarketId;
  interval?: ChartInterval;
  /** Bars (time series) to return, 10–500 (default 120). */
  bars?: number;
  indicators?: ChartIndicator[];
  /** Decision markers from the journal (default true for price/pnl). */
  markers?: boolean;
  network?: ChartNetwork;
  /** ADDITIVE: extra price lines on the same chart (price/cex kinds): the pool, HashKey Global, the oracle. */
  compare?: ChartCompare[];
  /** ADDITIVE: drawings to put on the chart (agent-built charts): levels, trendlines, zones, Fibonacci, notes. */
  drawings?: ChartDrawing[];
  /** ADDITIVE: add a plain-language analysis (trend, range, support/resistance, momentum) tied to drawings. */
  analyse?: boolean;
}

export const CHART_COMPARE = ["pool", "cex", "oracle"] as const;
export type ChartCompare = (typeof CHART_COMPARE)[number];

export const DRAWING_KINDS = ["hline", "trend", "zone", "fib", "text"] as const;
export type DrawingKind = (typeof DRAWING_KINDS)[number];
export interface DrawPoint {
  /** Unix seconds; omitted for horizontal levels. */
  t?: number;
  /** Price (USD) — or the series value on non-price charts. */
  v: number;
}
/**
 * hline: a level at `a.v` · trend: a line from `a` to `b` · zone: a band between `a.v` and `b.v` (from `a.t` to `b.t`
 * when given) · fib: retracement levels between `a` and `b` · text: a note at `a`.
 */
export interface ChartDrawing {
  id?: string;
  kind: DrawingKind;
  a: DrawPoint;
  b?: DrawPoint;
  label?: string;
  role?: "support" | "resistance" | "neutral";
  /** Who made it: the user (saved per market) or the agent (until kept). */
  by?: "user" | "agent";
}

export interface ChartFinding {
  text: string;
  /** The drawing this finding refers to. */
  drawingId?: string;
  tone?: "up" | "down" | "neutral";
}
export interface ChartAnalysis {
  /** One sentence. */
  summary: string;
  findings: ChartFinding[];
  /** Always present: information, not advice; Flow does not trade from it. */
  disclaimer: string;
  from: number;
  to: number;
}

export const ANALYSIS_DISCLAIMER = "This is information, not advice. Flow does not trade from it — you decide.";
export const MAX_DRAWINGS = 20;

/** Validates drawings (agent or user input): known kind, finite positive prices, needed points; clamps labels. */
export function validateDrawings(input: unknown): { drawings: ChartDrawing[]; errors: string[] } {
  const errors: string[] = [];
  const out: ChartDrawing[] = [];
  if (!Array.isArray(input)) return { drawings: [], errors: input === undefined ? [] : ["drawings must be an array"] };
  const pt = (p: unknown): DrawPoint | null => {
    if (!p || typeof p !== "object") return null;
    const o = p as Record<string, unknown>;
    const v = Number(o.v);
    if (!Number.isFinite(v)) return null;
    const t = o.t === undefined || o.t === null ? undefined : Number(o.t);
    if (t !== undefined && (!Number.isFinite(t) || t < 1_000_000_000 || t > 4_000_000_000)) return null;
    return t === undefined ? { v } : { t: Math.floor(t), v };
  };
  input.slice(0, MAX_DRAWINGS).forEach((d, i) => {
    const o = (d ?? {}) as Record<string, unknown>;
    const kind = o.kind as DrawingKind;
    if (!(DRAWING_KINDS as readonly string[]).includes(String(kind))) return void errors.push(`drawing ${i}: unknown kind ${String(o.kind)}`);
    const a = pt(o.a);
    const b = o.b === undefined ? undefined : pt(o.b);
    if (!a) return void errors.push(`drawing ${i}: needs a point a { v, t? }`);
    if ((kind === "trend" || kind === "fib") && (!b || a.t === undefined || b.t === undefined)) return void errors.push(`drawing ${i}: ${kind} needs points a and b with times`);
    if (kind === "zone" && !b) return void errors.push(`drawing ${i}: zone needs a and b`);
    if (kind === "text" && (a.t === undefined || !o.label)) return void errors.push(`drawing ${i}: text needs a time and a label`);
    const role = o.role === "support" || o.role === "resistance" || o.role === "neutral" ? o.role : undefined;
    out.push({
      id: typeof o.id === "string" && o.id.length <= 40 ? o.id : `d${i}`,
      kind,
      a,
      ...(b ? { b } : {}),
      ...(typeof o.label === "string" && o.label.trim() ? { label: o.label.trim().slice(0, 80) } : {}),
      ...(role ? { role } : {}),
      ...(o.by === "user" || o.by === "agent" ? { by: o.by } : {}),
    });
  });
  if (input.length > MAX_DRAWINGS) errors.push(`only the first ${MAX_DRAWINGS} drawings are kept`);
  return { drawings: out, errors };
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base volume. */
  v?: number;
  /** Quote (USD) volume. */
  q?: number;
}
export interface Point {
  t: number;
  v: number;
  /** Optional per-point colour role (histograms): up / down / neutral. */
  tone?: "up" | "down" | "neutral";
}

export type SeriesType = "candles" | "line" | "area" | "histogram";
export type SeriesUnit = "usd" | "bps" | "pct" | "qty" | "index";

export interface ChartSeries {
  id: string;
  label: string;
  type: SeriesType;
  unit: SeriesUnit;
  /** 0 = main pane; 1 = lower pane (oscillators, volume). */
  pane: 0 | 1;
  /** Colour role, mapped to the design tokens by the client. */
  role?: "primary" | "secondary" | "muted" | "accent" | "up" | "down";
  candles?: Candle[];
  points?: Point[];
  /** Set on indicator series: which indicator produced it. */
  indicator?: ChartIndicator;
}

export interface ChartMarker {
  t: number;
  kind: "buy" | "sell" | "no_trade" | "strategy" | "pause" | "info";
  label: string;
  /** Journal record id (opens the decision record). */
  id?: string;
  /** Price at the marker, when known. */
  price?: number;
}

/** Horizontal reference line (limits, thresholds, last price). */
export interface ChartLine {
  v: number;
  label: string;
  pane?: 0 | 1;
  role?: "muted" | "accent" | "down" | "up";
}

export interface ChartSource {
  name: string;
  detail?: string;
  chainId?: number;
  /** First and last data timestamps actually returned. */
  firstT: number | null;
  lastT: number | null;
  fetchedAt: number;
  cached?: boolean;
}

/** Category charts (depth) use `x` in place of time. */
export interface ChartAxis {
  type: "time" | "category";
  label?: string;
}

export interface ChartSpec {
  v: 1;
  kind: ChartKind;
  title: string;
  /** One plain sentence: what the chart shows. */
  caption: string;
  market?: MarketId;
  interval?: ChartInterval;
  x: ChartAxis;
  series: ChartSeries[];
  /** Ids of series that are indicator overlays (subset of `series`). */
  overlays: string[];
  markers: ChartMarker[];
  lines: ChartLine[];
  sources: ChartSource[];
  generatedAt: number;
  notes: string[];
  /** The input that produced this spec (lets a pinned chart refresh itself). */
  input: ChartInput;
  /** Depth charts: the x labels (trade sizes in USD). */
  categories?: string[];
  /** ADDITIVE: drawings on the chart (from the input and from the analysis). */
  drawings?: ChartDrawing[];
  /** ADDITIVE: present when the input asked for `analyse`. */
  analysis?: ChartAnalysis;
}

// ------------------------------------------------------------------ ate_data

export const DATA_TABLES = ["swaps", "book", "fills", "lots", "oracle"] as const;
export type DataTableKind = (typeof DATA_TABLES)[number];

export interface DataInput {
  table: DataTableKind;
  market?: MarketId;
  /** Rows, 1–100 (default 20). */
  limit?: number;
  network?: ChartNetwork;
}

export interface DataColumn {
  key: string;
  label: string;
  unit?: "usd" | "price" | "qty" | "bps" | "time" | "text" | "tx";
  align?: "left" | "right";
}

export interface DataTable {
  v: 1;
  table: DataTableKind;
  title: string;
  caption: string;
  market?: MarketId;
  columns: DataColumn[];
  rows: Record<string, string | number | null>[];
  sources: ChartSource[];
  generatedAt: number;
  notes: string[];
  input: DataInput;
}
