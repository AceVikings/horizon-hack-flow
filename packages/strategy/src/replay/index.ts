// @ate/strategy/replay — `ate replay --days N` (E11).
import { DEFAULT_MIN_ENTRY_INTERVAL_SEC, DEFAULT_STRATEGY_CONFIG, MARKETS, MARKET_IDS, type MarketId } from "@ate/core";
import { blockByTime, fetchHalfSpreadBps, fetchKlines, fetchSwaps, fetchSwapsRpc, lastSwapBefore, lastSwapBeforeRpc, rpcBlockByTime, rpcHead, type FetchOptions } from "./fetch.js";
import { renderReport } from "./report.js";
import { simulate, twapKlines, type MarketReplay, type ReplayParams, type ReplayReference } from "./sim.js";

export * from "./sim.js";
export * from "./fetch.js";
export * from "./report.js";

export function defaultReplayParams(market: MarketId, halfSpreadBps: number, reference: ReplayReference = "twap"): ReplayParams {
  const m = DEFAULT_STRATEGY_CONFIG.markets[market];
  const share = Math.min(Number(DEFAULT_STRATEGY_CONFIG.portfolio.maxDailyTurnoverUsd) / MARKET_IDS.length, 100);
  return {
    reference,
    cycleSeconds: m.cycleSeconds,
    entrySpreadBps: m.entrySpreadBps,
    minNetEdgeBps: m.minNetEdgeBps,
    tradeSizeUsd: Number(m.tradeSizeUsd),
    feeBps: MARKETS[market].fee / 100,
    halfSpreadBps,
    minEntryIntervalSec: m.minEntryIntervalSec ?? DEFAULT_MIN_ENTRY_INTERVAL_SEC[market],
    dailyTurnoverUsd: share,
    maxPositionUsd: Number(m.maxPositionUsd),
  };
}

export interface RunReplayOptions extends FetchOptions {
  days: number;
  markets?: MarketId[];
  now?: number;
  /** Reference price: "twap" (default) = the pool's own 300 s TWAP from its Swap logs (on-chain); "cex" = HashKey Global klines (optional). */
  reference?: ReplayReference;
  /** Override the measured CEX half-spread per market (reference "cex" only). */
  halfSpreadBps?: Partial<Record<MarketId, number>>;
  /** Log source: batched JSON-RPC eth_getLogs (default) or Blockscout's logs API. */
  source?: "rpc" | "blockscout";
}

export async function runReplay(o: RunReplayOptions): Promise<{ reports: MarketReplay[]; markdown: string }> {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const from = now - o.days * 86_400;
  const markets = o.markets ?? [...MARKET_IDS];
  const reference: ReplayReference = o.reference ?? "twap";
  const log = o.log ?? (() => {});
  log(`replay window ${new Date(from * 1000).toISOString()} → ${new Date(now * 1000).toISOString()}`);
  const useRpc = (o.source ?? "rpc") === "rpc";
  let fromBlock: number;
  let toBlock: number;
  if (useRpc) {
    const head = await rpcHead(o);
    toBlock = head.number;
    fromBlock = await rpcBlockByTime(from, head, o);
  } else {
    fromBlock = await blockByTime(from, o);
    toBlock = await blockByTime(now, o);
  }
  log(`blocks ${fromBlock} → ${toBlock}`);
  const reports: MarketReplay[] = [];
  const notes: string[] = [];
  for (const market of markets) {
    const m = MARKETS[market];
    log(`${m.label}: fetching pool Swap logs (${useRpc ? "batched eth_getLogs" : "Blockscout"})…`);
    const swaps = useRpc ? await fetchSwapsRpc(market, fromBlock, toBlock, o) : await fetchSwaps(market, fromBlock, toBlock, o);
    const prior = useRpc ? await lastSwapBeforeRpc(market, fromBlock, o) : await lastSwapBefore(market, fromBlock, o);
    if (prior) swaps.unshift(prior);
    else notes.push(`${m.label}: no swap found before the window start; cycles before the first in-window swap are skipped.`);
    if (reference === "twap") {
      log(`${m.label}: ${swaps.length} swaps; rebuilding the pool's 300 s TWAP; simulating…`);
      reports.push(simulate(market, swaps, twapKlines(swaps, from, now), from, now, defaultReplayParams(market, 0, "twap")).report);
      continue;
    }
    log(`${m.label}: ${swaps.length} swaps; fetching ${m.cexSymbol} 1 m klines…`);
    const klines = await fetchKlines(m.cexSymbol, from, now, o);
    let hs = o.halfSpreadBps?.[market];
    if (hs === undefined) {
      try {
        hs = await fetchHalfSpreadBps(m.cexSymbol, o);
      } catch {
        hs = market === "hsk-dex:WHSK/USDT:3000" ? 5.7 : 0.01;
        notes.push(`${m.label}: live top of book unavailable; half-spread defaulted to ${hs} bps (§11.3).`);
      }
    }
    log(`${m.label}: ${klines.length} klines; half-spread ${hs} bps; simulating…`);
    const { report } = simulate(market, swaps, klines, from, now, defaultReplayParams(market, hs, "cex"));
    reports.push(report);
  }
  const markdown = renderReport(reports, {
    generatedAt: now,
    days: o.days,
    source: `Sources: HSK Chain blocks ${fromBlock}–${toBlock}, pool \`Swap\` logs via ${useRpc ? `batched JSON-RPC eth_getLogs (${o.rpcUrl ?? "https://mainnet.hsk.xyz"}; timestamps interpolated between block-header anchors)` : "Blockscout"}; ${reference === "twap" ? "reference: the pool's own 300 s TWAP rebuilt from those logs (on-chain; the live oracle keeps no readable history)" : "reference: HashKey Global 1 m klines (site glb; optional CEX reference)"}.`,
    notes,
  });
  return { reports, markdown };
}
