// Charts kit for every lane (D4). Ask renders `ate_chart` / `ate_data` tool results with <ToolResultBlock>;
// Trade drops in <PriceChart market=…> (one clean line, "Add indicator"); Charts pins and arranges them.
import { useEffect, useState } from "react";
import type { ChartInput, ChartSpec, DataTable, MarketId, ToolResult } from "@ate/core";
import type { Res } from "@shared/bridge";
import { useApp } from "../app";
import { useNav } from "../shell";
import { ChartCard, DataTableCard } from "./ChartCard";
import { addPin } from "./pins";

export { ChartView, CrosshairLink } from "./Chart";
export { ChartCard, DataTableCard, INDICATOR_LABEL } from "./ChartCard";
export { addPin, usePins, readPins, type Pin } from "./pins";

const HSK: MarketId = "hsk-dex:WHSK/USDT:3000";
const BTC: MarketId = "hsk-dex:WBTC/USDT:3000";

/** "Add chart" presets, in plain words. */
export const PRESETS: { name: string; sub: string; input: ChartInput }[] = [
  { name: "HSK price", sub: "Pool price, hourly", input: { kind: "price", market: HSK, interval: "1h", bars: 72 } },
  { name: "BTC price", sub: "Pool price, hourly", input: { kind: "price", market: BTC, interval: "1h", bars: 72 } },
  { name: "HSK on the exchange", sub: "HashKey Global, 5 min", input: { kind: "cex", market: HSK, interval: "5m", bars: 96 } },
  { name: "BTC on the exchange", sub: "HashKey Global, 5 min", input: { kind: "cex", market: BTC, interval: "5m", bars: 96 } },
  { name: "HSK gap: pool vs exchange", sub: "What the agent trades on", input: { kind: "spread", market: HSK, interval: "1h", bars: 72 } },
  { name: "BTC gap: pool vs exchange", sub: "What the agent trades on", input: { kind: "spread", market: BTC, interval: "1h", bars: 72 } },
  { name: "HSK cost by trade size", sub: "Live quotes, buy and sell", input: { kind: "depth", market: HSK } },
  { name: "BTC cost by trade size", sub: "Live quotes, buy and sell", input: { kind: "depth", market: BTC } },
  { name: "BTC oracle prices", sub: "Supra, APRO and the pool", input: { kind: "oracle", market: BTC, interval: "1h", bars: 72 } },
  { name: "HSK pool volume", sub: "Dollars traded per hour", input: { kind: "volume", market: HSK, interval: "1h", bars: 48 } },
  { name: "HSK profit and loss", sub: "The agent's trades", input: { kind: "pnl", market: HSK, interval: "1h", bars: 72 } },
  { name: "BTC profit and loss", sub: "The agent's trades", input: { kind: "pnl", market: BTC, interval: "1h", bars: 72 } },
  { name: "HSK exposure", sub: "Value held vs the cap", input: { kind: "exposure", market: HSK, interval: "1h", bars: 72 } },
  { name: "BTC daily budget", sub: "Spent today vs the cap", input: { kind: "budget", market: BTC, interval: "1h", bars: 48 } },
];

/** Fetches a chart for `input`; refetches on change and every `every` ms. Keeps the last good spec. */
export function useChart(input: ChartInput, every = 60_000): { spec: ChartSpec | null; error: string | null; busy: boolean } {
  const { ate } = useApp();
  const key = JSON.stringify(input);
  const [spec, setSpec] = useState<ChartSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let live = true;
    const load = () => {
      if (!ate.charts) {
        setError("Charts need the Flow service running.");
        setBusy(false);
        return;
      }
      setBusy(true);
      void ate.charts.chart(JSON.parse(key) as ChartInput).then((r: Res<ChartSpec>) => {
        if (!live) return;
        setBusy(false);
        if (r.ok) {
          setSpec(r.data);
          setError(null);
        } else setError(r.error.message);
      });
    };
    load();
    const i = setInterval(load, every);
    return () => {
      live = false;
      clearInterval(i);
    };
  }, [ate, key, every]);
  return { spec, error, busy };
}

function PinButton({ input }: { input: ChartInput }) {
  const go = useNav();
  const { toast } = useApp();
  const [done, setDone] = useState(false);
  return done ? (
    <button className="lnk" onClick={() => go("charts")}>
      Pinned. Open Charts
    </button>
  ) : (
    <button
      className="lnk"
      onClick={() => {
        addPin(input);
        setDone(true);
        toast({ kind: "ok", text: "Pinned to Charts" });
      }}
    >
      Pin
    </button>
  );
}

/**
 * Inline renderer for chat tool results. Returns null for other tools, so Ask can call it for every tool result:
 * `<ToolResultBlock tool={name} result={parsed} />`. `result` is the ToolResult JSON the daemon returned.
 */
export function ToolResultBlock({ tool, result }: { tool: string; result: unknown }) {
  if (tool !== "ate_chart" && tool !== "ate_data") return null;
  const r = result as ToolResult<ChartSpec | DataTable>;
  if (!r || typeof r !== "object" || !("ok" in r)) return null;
  if (!r.ok) return <p className="chempty">Could not load this {tool === "ate_chart" ? "chart" : "table"}: {r.error.message}</p>;
  if (tool === "ate_data") return <DataTableCard table={r.data as DataTable} />;
  const spec = r.data as ChartSpec;
  return <ChartCard spec={spec} height={220} compact actions={<PinButton input={spec.input} />} />;
}

/** Trade's default chart: one clean price line for `market`, with timeframe and "Add indicator". */
export function PriceChart({ market, height = 260 }: { market: MarketId; height?: number }) {
  const [input, setInput] = useState<ChartInput>({ kind: "price", market, interval: "1h", bars: 72 });
  useEffect(() => setInput((i) => ({ ...i, market })), [market]);
  const { spec, error, busy } = useChart(input);
  if (!spec) return <div className="chcard chload" style={{ minHeight: height + 60 }}>{error ? <p className="chempty">{error}</p> : <p className="chempty">Loading the price…</p>}</div>;
  return <ChartCard spec={spec} height={height} busy={busy} onChange={setInput} actions={<PinButton input={input} />} />;
}
