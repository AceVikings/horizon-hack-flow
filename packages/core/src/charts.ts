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
export const CHART_INDICATORS = ["ema20", "ema50", "sma20", "sma50", "vwap", "bb20", "rsi14", "macd", "atr14"] as const;
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
