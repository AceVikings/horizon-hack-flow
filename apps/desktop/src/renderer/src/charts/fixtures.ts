// Fixture-mode charts (no daemon): deterministic synthetic series shaped like the daemon's ChartSpec / DataTable.
import { INTERVAL_SEC, type Candle, type ChartInput, type ChartSeries, type ChartSpec, type DataInput, type DataTable, type MarketId } from "@ate/core";
import type { Res } from "@shared/bridge";

const LBL: Record<MarketId, string> = { "hsk-dex:WHSK/USDT:3000": "HSK", "hsk-dex:WBTC/USDT:3000": "BTC" };
const BASE: Record<MarketId, number> = { "hsk-dex:WHSK/USDT:3000": 0.0875, "hsk-dex:WBTC/USDT:3000": 77_450 };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function walk(m: MarketId, n: number, sec: number, seed: number): Candle[] {
  const r = rng(seed);
  const end = Math.floor(Date.now() / 1000 / sec) * sec;
  let p = BASE[m];
  const out: Candle[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const o = p;
    p = p * (1 + (r() - 0.5) * 0.012);
    out.push({ t: end - i * sec, o, h: Math.max(o, p) * (1 + r() * 0.002), l: Math.min(o, p) * (1 - r() * 0.002), c: p, v: r() * 100, q: r() * 400 });
  }
  return out;
}
const ema = (xs: number[], n: number) => {
  const k = 2 / (n + 1);
  let e = xs[0]!;
  return xs.map((x) => (e = x * k + e * (1 - k)));
};

export function fixtureChart(input: ChartInput): ChartSpec {
  const m = input.market ?? "hsk-dex:WHSK/USDT:3000";
  const iv = input.interval ?? "1h";
  const bars = input.bars ?? 120;
  const L = LBL[m];
  const now = Math.floor(Date.now() / 1000);
  const c = walk(m, bars, INTERVAL_SEC[iv], m.length * 7 + bars + iv.length);
  const src = (name: string) => [{ name, firstT: c[0]!.t, lastT: now - 40, fetchedAt: now }];
  const base = { v: 1 as const, kind: input.kind, market: m, interval: iv, x: { type: "time" as const }, overlays: [] as string[], markers: [] as ChartSpec["markers"], lines: [] as ChartSpec["lines"], notes: [] as string[], generatedAt: now, input: { ...input, market: m, interval: iv, bars } };
  const series: ChartSeries[] = [];
  let title = `${L} price`;
  let caption = `${L} price on the HSKSwap pool, ${iv} bars.`;
  let sources = src(`HSKSwap ${L}/USDT pool Swap logs`);
  switch (input.kind) {
    case "price":
    case "cex":
      series.push({ id: "p", label: `${L} price`, type: "candles", unit: "usd", pane: 0, role: "primary", candles: c });
      if (input.kind === "cex") {
        title = `${L}USDT on HashKey Global`;
        caption = `${L} price on the HashKey Global exchange, ${iv} bars.`;
        sources = src(`HashKey Global ${L}USDT klines`);
      }
      if (input.kind === "price" && input.markers !== false) base.markers = [{ t: c[Math.floor(bars * 0.4)]!.t, kind: "buy", label: "Buy (llm)" }, { t: c[Math.floor(bars * 0.75)]!.t, kind: "sell", label: "Sell (llm)" }];
      if (input.indicators?.includes("ema20")) series.push({ id: "ema20", label: "EMA 20", type: "line", unit: "usd", pane: 0, role: "accent", indicator: "ema20", points: ema(c.map((x) => x.c), 20).map((v, i) => ({ t: c[i]!.t, v })).slice(19) });
      if (input.indicators?.includes("rsi14")) series.push({ id: "rsi14", label: "RSI 14", type: "line", unit: "index", pane: 1, role: "accent", indicator: "rsi14", points: c.slice(14).map((x, i) => ({ t: x.t, v: 50 + Math.sin(i / 5) * 18 })) });
      break;
    case "spread":
      title = `${L} pool vs exchange gap`;
      caption = "How far the pool price is from HashKey Global, in basis points (100 bps = 1%).";
      series.push({ id: "spread", label: "Gap (bps)", type: "line", unit: "bps", pane: 0, role: "primary", points: c.map((x, i) => ({ t: x.t, v: Math.round(Math.sin(i / 7) * 60 + (x.c / BASE[m] - 1) * 900) })) });
      base.lines = [{ v: 0, label: "No gap", role: "muted" }, { v: 100, label: "Agent trades past 100 bps", role: "accent" }];
      break;
    case "volume":
      title = `${L} pool volume`;
      caption = `Dollars traded in the HSKSwap ${L} pool per ${iv} bar.`;
      series.push({ id: "volume", label: "Volume (USD)", type: "histogram", unit: "usd", pane: 0, role: "primary", points: c.map((x) => ({ t: x.t, v: Math.round(x.q!), tone: x.c >= x.o ? "up" : "down" })) });
      break;
    case "depth": {
      const sizes = [10, 25, 50, 100, 250, 500, 1000, 2500];
      const k = m.includes("WBTC") ? 0.19 : 0.023;
      return {
        ...base,
        interval: undefined,
        x: { type: "category", label: "Trade size (USD)" },
        categories: sizes.map((u) => `$${u}`),
        title: `${L} cost by trade size`,
        caption: "How much worse than the pool price a trade fills, by size (incl. the 0.30% fee).",
        series: [
          { id: "buy", label: "Buy", type: "line", unit: "bps", pane: 0, role: "up", points: sizes.map((u, i) => ({ t: i, v: Math.round(30 + u * k) })) },
          { id: "sell", label: "Sell", type: "line", unit: "bps", pane: 0, role: "down", points: sizes.map((u, i) => ({ t: i, v: Math.round(30 + u * k * 1.05) })) },
        ],
        lines: [{ v: 30, label: "Pool fee", role: "muted" }],
        sources: [{ name: "QuoterV2 ladder (live)", firstT: now, lastT: now, fetchedAt: now }],
      };
    }
    case "oracle":
      title = `${L} oracle prices`;
      caption = "The price the vault enforces (Supra), the APRO cross-check and the pool.";
      series.push({ id: "pool", label: "Pool", type: "line", unit: "usd", pane: 0, role: "muted", points: c.map((x) => ({ t: x.t, v: x.c })) });
      series.push({ id: "supra", label: "Supra", type: "line", unit: "usd", pane: 0, role: "primary", points: c.filter((_, i) => i % 6 === 0).map((x) => ({ t: x.t, v: x.o })) });
      break;
    default: {
      const pnl = input.kind === "pnl";
      title = pnl ? `${L} profit and loss` : input.kind === "exposure" ? `${L} exposure` : `${L} daily budget used`;
      caption = pnl ? `Realised plus marked profit of the agent's ${L} trades, in dollars.` : input.kind === "exposure" ? `Dollar value of the ${L} the agent bought, against the vault's cap.` : "Dollars traded in each vault epoch (a UTC day) against the on-chain cap.";
      let acc = 0;
      series.push({ id: input.kind, label: "USD", type: "area", unit: "usd", pane: 0, role: "primary", points: c.map((x, i) => ({ t: x.t, v: pnl ? Math.round((x.c / BASE[m] - 1) * 4000) / 100 : input.kind === "budget" ? (acc = i % 24 === 0 ? 0 : acc + (i % 5 === 0 ? 25 : 0)) : 60 + Math.round((x.c / BASE[m]) * 20) })) });
      base.lines = pnl ? [{ v: 0, label: "Break-even", role: "muted" }] : [{ v: input.kind === "budget" ? 250 : 150, label: input.kind === "budget" ? "Cap $250" : "Cap $150", role: "down" }];
      sources = src("Vault fills");
    }
  }
  return { ...base, title, caption, series, sources };
}

export function fixtureData(input: DataInput): DataTable {
  const m = input.market ?? "hsk-dex:WHSK/USDT:3000";
  const now = Math.floor(Date.now() / 1000);
  const r = rng(42);
  const n = Math.min(input.limit ?? 10, 10);
  const p = BASE[m];
  const rows = Array.from({ length: n }, (_, i) => ({ t: now - i * 1700, side: r() > 0.5 ? "buy" : "sell", usd: Math.round(r() * 4000) / 100, price: p * (1 + (r() - 0.5) * 0.01), tx: `0x${(i + 1).toString(16).padStart(64, "a")}` }));
  return {
    v: 1,
    table: input.table,
    title: `${LBL[m]} pool swaps`,
    caption: `Latest ${n} swaps in the HSKSwap ${LBL[m]}/USDT pool.`,
    market: m,
    columns: [
      { key: "t", label: "Time", unit: "time" },
      { key: "side", label: "Side", unit: "text" },
      { key: "usd", label: "Size", unit: "usd", align: "right" },
      { key: "price", label: "Price", unit: "price", align: "right" },
    ],
    rows,
    sources: [{ name: "HSKSwap pool Swap logs", firstT: now - n * 1700, lastT: now, fetchedAt: now }],
    generatedAt: now,
    notes: [],
    input,
  };
}

const later = <T,>(v: T, ms = 250): Promise<Res<T>> => new Promise((r) => setTimeout(() => r({ ok: true, data: v }), ms));
export const chartFixtures = { chart: (i: ChartInput) => later(fixtureChart(i)), data: (i: DataInput) => later(fixtureData(i)) };
