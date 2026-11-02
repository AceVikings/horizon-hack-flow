// Charts kit for every lane (D4). Ask renders `ate_chart` / `ate_data` tool results with <ToolResultBlock>;
// Trade drops in <PriceChart market=…> (TradeChart: one clean line by default, a compact toolbar, Ask about this chart);
// Charts pins and arranges them.
import { useState } from "react";
import type { ChartInput, ChartSpec, DataTable, MarketId, ToolResult } from "@ate/core";
import { useApp } from "../app";
import { useNav } from "../shell";
import { ChartCard, DataTableCard } from "./ChartCard";
import { addPin } from "./pins";
import { TradeChart, AnalysisPanel } from "./TradeChart";

export { ChartView, CrosshairLink } from "./Chart";
export { ChartCard, DataTableCard, INDICATOR_LABEL } from "./ChartCard";
export { addPin, usePins, readPins, type Pin } from "./pins";
export { useChart } from "./useChart";
export { TradeChart, AnalysisPanel } from "./TradeChart";
export { useDrawings, keepDrawings, readDrawings } from "./drawings";

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
  return (
    <>
      <ChartCard spec={spec} height={220} compact actions={<PinButton input={spec.input} />} />
      {(spec.analysis || spec.drawings?.length) && spec.market && <AnalysisPanel spec={spec} market={spec.market} />}
    </>
  );
}

/** Trade's chart (kept as `PriceChart` so Trade needs no change): see TradeChart. */
export function PriceChart({ market, height = 300 }: { market: MarketId; height?: number }) {
  return <TradeChart market={market} height={height} />;
}
