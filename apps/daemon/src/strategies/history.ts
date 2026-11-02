// Past data for backtests and practice runs (lane STRAT), read-only and always from HashKey Chain mainnet: pool
// prices from Swap logs (the charts cache, synced further back with a larger budget), HashKey Global klines (paged),
// APRO oracle rounds, and the pool's depth from a live QuoterV2 quote (else estimated from the swaps).

import { MARKETS, type MarketId } from "@ate/core";
import { depthFromQuote, depthFromSwaps, type MarketHistory } from "@ate/backtest";
import { aggregatorAbi, type CexReader } from "@ate/oracle";
import { quoterV2Abi } from "@ate/venues";
import type Database from "better-sqlite3";
import type { Address } from "viem";
import { MAINNET_MARKETS, MAINNET_QUOTER, type ChainHandle } from "../charts/service.js";
import { SwapIndex, type PoolRef } from "../charts/swaps.js";

export interface HistoryDeps {
  db: Database.Database;
  mainnet: () => ChainHandle;
  cex: Pick<CexReader, "klines" | "depth">;
  now?: () => number;
  log?: (m: string) => void;
}

const FEE_BPS = 30;
const nowSec = () => Math.floor(Date.now() / 1000);
const label = (m: MarketId) => (MARKETS[m].asset === "WBTC" ? "BTC" : "HSK");

export class HistoryLoader {
  private swaps: SwapIndex;
  private cache = new Map<string, { at: number; h: MarketHistory }>();
  private inflight = new Map<string, Promise<MarketHistory>>();
  constructor(private readonly d: HistoryDeps) {
    // same tables as the charts cache; a bigger budget per sync so 90 days load in a few passes
    this.swaps = new SwapIndex(d.db, { maxCalls: 120, budgetMs: 45_000 });
  }

  private now() {
    return (this.d.now ?? nowSec)();
  }

  /** History for [now − days, now], cached 10 minutes per (market, days). */
  load(market: MarketId, days: number): Promise<MarketHistory> {
    const key = `${market}:${days}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < 600) return Promise.resolve(hit.h);
    const cur = this.inflight.get(key);
    if (cur) return cur;
    const p = this.fetch(market, days)
      .then((h) => {
        this.cache.set(key, { at: this.now(), h });
        return h;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetch(market: MarketId, days: number): Promise<MarketHistory> {
    const to = this.now();
    const from = to - days * 86_400;
    const notes: string[] = [];
    const main = this.d.mainnet();
    const mk = MAINNET_MARKETS[market];
    const ref: PoolRef = { chainId: 177, pool: mk.pool, baseDecimals: mk.baseDecimals, quoteDecimals: 6 };
    // pool swaps (a day earlier, for the price at the start and indicator warm-up)
    let complete = false;
    for (let pass = 0; pass < 4 && !complete; pass++) {
      const r = await this.swaps.sync(main.rpc, ref, from - 86_400);
      complete = r.complete;
      if (!complete && pass === 3) notes.push(`${label(market)}: pool history loaded back to ${new Date(r.coveredFromT * 1000).toISOString().slice(0, 10)} only.`);
    }
    const { rows, prior } = this.swaps.rows(ref, from - 86_400, to);
    const pool = [...(prior ? [prior] : []), ...rows].map((r) => ({ t: r.t, v: r.price, vol: r.quote }));
    const [cex, oracle, depth] = await Promise.all([
      this.klines(market, from - 86_400, to).catch((e) => {
        notes.push(`${label(market)}: HashKey Global prices could not be loaded (${(e as Error).message.slice(0, 80)}).`);
        return [] as { t: number; v: number }[];
      }),
      this.apro(market, from - 86_400).catch(() => [] as { t: number; v: number }[]),
      this.depth(market, main).catch(() => null),
    ]);
    let depthUsd: number;
    let depthSource: string;
    if (depth) {
      depthUsd = depth.depthUsd;
      depthSource = `today's pool depth (QuoterV2: a $${depth.sizeUsd} buy fills ${depth.impactBps.toFixed(1)} bps above the price)`;
    } else {
      const est = depthFromSwaps(pool);
      depthUsd = est ?? 100_000;
      depthSource = est ? "a pool depth estimated from past swaps" : "an assumed pool depth of $100,000 (no quote and too few swaps)";
    }
    // live half-spread for costs
    let halfSpreadBps = market === "hsk-dex:WHSK/USDT:3000" ? 5.7 : 0.01;
    try {
      const b = (await this.d.cex.depth(MARKETS[market].cexSymbol, 5)) as { b?: [string, string][]; a?: [string, string][] };
      const bid = Number(b.b?.[0]?.[0]);
      const ask = Number(b.a?.[0]?.[0]);
      if (bid > 0 && ask > 0) halfSpreadBps = ((ask - bid) / 2 / ((ask + bid) / 2)) * 1e4;
    } catch {
      /* keep the measured default (§11.3) */
    }
    return { market, from, to, pool, cex, oracle, depthUsd, depthSource, feeBps: FEE_BPS, halfSpreadBps, notes };
  }

  /** HashKey Global closes stamped at each candle's close; 1 m for ≤ 7 days, 5 m for ≤ 30, else 15 m. */
  private async klines(market: MarketId, from: number, to: number): Promise<{ t: number; v: number }[]> {
    const days = (to - from) / 86_400;
    const [iv, sec] = days <= 8 ? ["1m", 60] : days <= 31 ? ["5m", 300] : ["15m", 900];
    const sym = MARKETS[market].cexSymbol;
    const out = new Map<number, number>();
    let end = to * 1000;
    for (let k = 0; k < 40 && end > from * 1000; k++) {
      const raw = (await this.d.cex.klines(sym, iv, 1000, end)) as [number, string, string, string, string][];
      if (!Array.isArray(raw) || !raw.length) break;
      let minT = Infinity;
      for (const r of raw) {
        const t = Math.floor(Number(r[0]) / 1000);
        minT = Math.min(minT, t);
        if (t + sec <= to && t >= from - sec) out.set(t + sec, Number(r[4]));
      }
      if (!Number.isFinite(minT) || minT * 1000 >= end) break;
      end = minT * 1000 - 1;
    }
    return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
  }

  /** APRO rounds back to `fromT` (EOA reads; at most 400 rounds, 8 at a time). */
  private async apro(market: MarketId, fromT: number): Promise<{ t: number; v: number }[]> {
    const h = this.d.mainnet();
    const feed = MAINNET_MARKETS[market].apro;
    const abi = [...aggregatorAbi, { type: "function", name: "getRoundData", stateMutability: "view", inputs: [{ name: "_roundId", type: "uint80" }], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }] as const;
    const latest = (await h.client.readContract({ address: feed, abi, functionName: "latestRoundData" })) as readonly bigint[];
    const pts: { t: number; v: number }[] = [{ t: Number(latest[3]), v: Number(latest[1]) / 1e8 }];
    let id = latest[0]!;
    for (let k = 0; k < 50 && id > 1n; k++) {
      const ids = Array.from({ length: 8 }, (_, j) => id - BigInt(j + 1)).filter((x) => x > 0n);
      id -= 8n;
      const rs = await Promise.all(ids.map((r) => h.client.readContract({ address: feed, abi, functionName: "getRoundData", args: [r] }).catch(() => null)));
      let older = false;
      for (const r of rs as (readonly bigint[] | null)[]) {
        if (!r || !Number(r[3])) continue;
        pts.push({ t: Number(r[3]), v: Number(r[1]) / 1e8 });
        if (Number(r[3]) < fromT) older = true;
      }
      if (older || rs.every((r) => r === null)) break;
    }
    return pts.sort((a, b) => a.t - b.t);
  }

  /** Depth D from a live QuoterV2 buy quote: impact (fee excluded) of a $500 buy. */
  private async depth(market: MarketId, h: ChainHandle): Promise<{ depthUsd: number; sizeUsd: number; impactBps: number } | null> {
    const mk = MAINNET_MARKETS[market];
    const slot0 = (await h.client.readContract({ address: mk.pool, abi: [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }] as const, functionName: "slot0" })) as readonly [bigint, ...unknown[]];
    const sq = Number(slot0[0]) / 2 ** 96;
    const spot = sq * sq * 10 ** (mk.baseDecimals - 6);
    for (const usd of [500, 5000]) {
      const r = await h.client.simulateContract({ address: MAINNET_QUOTER, abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn: mk.quote as Address, tokenOut: mk.base as Address, amountIn: BigInt(usd * 1e6), fee: 3000, sqrtPriceLimitX96: 0n }] });
      const got = Number((r.result as readonly bigint[])[0]!) / 10 ** mk.baseDecimals;
      const total = (1 - (got * spot) / usd) * 1e4;
      const impact = total - FEE_BPS;
      if (impact > 0.5) return { depthUsd: depthFromQuote(usd, impact, FEE_BPS), sizeUsd: usd, impactBps: impact };
    }
    return null;
  }
}
