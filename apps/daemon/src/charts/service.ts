// ate_chart / ate_data (lane D4, read-only). Builds typed ChartSpec / DataTable values for the chat agent and the
// app: pool candles from HSKSwap Swap logs (cached, see swaps.ts), HashKey Global klines, Supra/APRO oracle
// history, pool-vs-CEX spread, QuoterV2 depth ladder, volume, and the vault's P&L / exposure / epoch budget
// curves rebuilt from fills, with journal decision markers and server-side indicators.

import type Database from "better-sqlite3";
import {
  INTERVAL_SEC,
  MARKETS,
  MARKET_IDS,
  HSKDEX,
  AteError,
  type Address,
  type Candle,
  type ChartInput,
  type ChartInterval,
  type ChartMarker,
  type ChartNetwork,
  type ChartSeries,
  type ChartSource,
  type ChartSpec,
  type DataInput,
  type DataTable,
  type JournalEntry,
  type MarketId,
  type StrategyParams,
} from "@ate/core";
import { aggregatorAbi, type CexReader, type CycleRead } from "@ate/oracle";
import { quoterV2Abi } from "@ate/venues";
import type { PublicClient } from "viem";
import { indicatorSeries } from "./indicators.js";
import { bucketCandles, SwapIndex, type PoolRef, type Rpc, type SwapRow } from "./swaps.js";

/** HashKey Chain mainnet (177) market constants, fixed here because a testnet daemon rewrites MARKETS in place. */
export const MAINNET_MARKETS: Record<MarketId, { pool: Address; base: Address; quote: Address; baseDecimals: number; apro: Address }> = {
  "hsk-dex:WHSK/USDT:3000": {
    pool: "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc",
    base: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
    quote: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
    baseDecimals: 18,
    apro: "0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b",
  },
  "hsk-dex:WBTC/USDT:3000": {
    pool: "0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A",
    base: "0x6119ca49a79f5825c8b345f8d7ac36b272565b14",
    quote: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
    baseDecimals: 8,
    apro: "0x204ED500ab56A2E19B051561258E3A45c850360F",
  },
};
export const MAINNET_QUOTER: Address = "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD";

export interface ChainHandle {
  chainId: number;
  rpc: Rpc;
  client: PublicClient;
}

export interface ChartDeps {
  db: Database.Database;
  journal: { list(f: { limit?: number; market?: MarketId; since?: number; kind?: JournalEntry["kind"][] }): JournalEntry[] };
  /** The daemon's chain (vaults). */
  vaultChain: ChainHandle;
  /** HashKey Chain mainnet (read-only); the vault chain itself when the daemon runs on 177. */
  mainnet: () => ChainHandle;
  cex: Pick<CexReader, "klines" | "depth">;
  /** Latest market + vault read (cached by the daemon). */
  snapshot: () => Promise<CycleRead | null>;
  strategy: () => StrategyParams;
  now?: () => number;
  swaps?: SwapIndex;
}

const LABEL: Record<MarketId, string> = { "hsk-dex:WHSK/USDT:3000": "HSK", "hsk-dex:WBTC/USDT:3000": "BTC" };
const DEPTH_SIZES_USD = [10, 25, 50, 100, 250, 500, 1000, 2500];
const FEE_BPS = 30;

export class ChartService {
  readonly swaps: SwapIndex;
  private readonly now: () => number;
  private klineCache = new Map<string, { at: number; candles: Candle[] }>();
  private aproCache = new Map<string, { at: number; points: { t: number; v: number }[] }>();

  constructor(private readonly d: ChartDeps) {
    this.swaps = d.swaps ?? new SwapIndex(d.db);
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ------------------------------------------------------------------ refs

  private net(n?: ChartNetwork): ChainHandle {
    return n === "mainnet" ? this.d.mainnet() : this.d.vaultChain;
  }
  private poolRef(m: MarketId, n?: ChartNetwork): PoolRef {
    const h = this.net(n);
    if (h.chainId === 177) return { chainId: 177, pool: MAINNET_MARKETS[m].pool, baseDecimals: MAINNET_MARKETS[m].baseDecimals, quoteDecimals: 6 };
    return { chainId: h.chainId, pool: MARKETS[m].pool, baseDecimals: MARKETS[m].baseDecimals, quoteDecimals: 6 };
  }
  private netName(chainId: number) {
    return chainId === 177 ? "HashKey Chain mainnet" : chainId === 133 ? "HashKey Chain testnet" : `chain ${chainId}`;
  }

  // ------------------------------------------------------------------ public

  async chart(input: ChartInput): Promise<ChartSpec> {
    const market = input.market ?? MARKET_IDS[0];
    const interval: ChartInterval = input.interval ?? (input.kind === "pnl" || input.kind === "exposure" || input.kind === "budget" ? "1h" : "1h");
    const bars = Math.min(500, Math.max(10, input.bars ?? 120));
    const base = { v: 1 as const, kind: input.kind, market, interval, x: { type: "time" as const }, overlays: [] as string[], markers: [] as ChartMarker[], lines: [] as ChartSpec["lines"], notes: [] as string[], generatedAt: this.now(), input: { ...input, market, interval, bars } };
    let spec: ChartSpec;
    switch (input.kind) {
      case "price":
        spec = await this.priceChart(base, market, interval, bars, input);
        break;
      case "cex":
        spec = await this.cexChart(base, market, interval, bars);
        break;
      case "volume":
        spec = await this.volumeChart(base, market, interval, bars, input.network);
        break;
      case "spread":
        spec = await this.spreadChart(base, market, interval, bars, input.network);
        break;
      case "oracle":
        spec = await this.oracleChart(base, market, interval, bars, input.network);
        break;
      case "depth":
        spec = await this.depthChart(base, market, input.network);
        break;
      case "pnl":
      case "exposure":
      case "budget":
        spec = await this.vaultChart(base, input.kind, market, interval, bars);
        break;
    }
    // indicators apply to the first candle series
    const candles = spec.series.find((s) => s.type === "candles")?.candles;
    if (candles && input.indicators?.length) {
      const ind = indicatorSeries(candles, input.indicators);
      spec.series.push(...ind);
      spec.overlays.push(...ind.map((s) => s.id));
    }
    const wantMarkers = input.markers ?? (input.kind === "price" || input.kind === "pnl");
    if (wantMarkers && spec.x.type === "time") spec.markers = this.markers(market, spec);
    return spec;
  }

  async data(input: DataInput): Promise<DataTable> {
    const market = input.market ?? MARKET_IDS[0];
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const base = { v: 1 as const, table: input.table, market, generatedAt: this.now(), notes: [] as string[], input: { ...input, market, limit } };
    const L = LABEL[market];
    switch (input.table) {
      case "swaps": {
        const ref = this.poolRef(market, input.network);
        const h = this.net(input.network);
        const sync = await this.swaps.sync(h.rpc, ref, this.now() - 7 * 86_400);
        const rows = this.swaps.recent(ref, limit);
        if (!sync.complete) base.notes.push("Older swaps are still loading; ask again for more history.");
        return {
          ...base,
          title: `${L} pool swaps`,
          caption: `Latest ${rows.length} swaps in the HSKSwap ${L}/USDT pool.`,
          columns: [
            { key: "t", label: "Time", unit: "time" },
            { key: "side", label: "Side", unit: "text" },
            { key: "usd", label: "Size", unit: "usd", align: "right" },
            { key: "price", label: "Price", unit: "price", align: "right" },
            { key: "tx", label: "Transaction", unit: "tx" },
          ],
          rows: rows.map((r) => ({ t: r.t, side: r.side, usd: round(r.quote, 2), price: r.price, tx: r.tx })),
          sources: [this.src(`HSKSwap ${L}/USDT pool Swap logs`, rows.map((r) => r.t), h.chainId, sync.calls === 0)],
        };
      }
      case "book": {
        const sym = MARKETS[market].cexSymbol;
        const b = await this.d.cex.depth(sym, Math.min(20, limit));
        const rows: DataTable["rows"] = [];
        const n = Math.max(b.bids.length, b.asks.length);
        for (let i = 0; i < n; i++) {
          const bid = b.bids[i];
          const ask = b.asks[i];
          rows.push({ bidQty: bid ? Number(bid[1]) : null, bid: bid ? Number(bid[0]) : null, ask: ask ? Number(ask[0]) : null, askQty: ask ? Number(ask[1]) : null });
        }
        const t = Math.floor(b.t / 1000);
        return {
          ...base,
          title: `${sym} order book`,
          caption: `Top ${n} bid and ask levels on HashKey Global.`,
          columns: [
            { key: "bidQty", label: "Bid size", unit: "qty", align: "right" },
            { key: "bid", label: "Bid", unit: "price", align: "right" },
            { key: "ask", label: "Ask", unit: "price", align: "right" },
            { key: "askQty", label: "Ask size", unit: "qty", align: "right" },
          ],
          rows,
          sources: [this.src("HashKey Global /quote/v1/depth", [t])],
        };
      }
      case "fills": {
        const fs = this.fills(market).slice(-limit).reverse();
        return {
          ...base,
          title: `${L} vault fills`,
          caption: fs.length ? `The vault's last ${fs.length} executed trades on ${L}.` : `The ${L} vault has no fills yet.`,
          columns: [
            { key: "t", label: "Time", unit: "time" },
            { key: "side", label: "Side", unit: "text" },
            { key: "usd", label: "Size", unit: "usd", align: "right" },
            { key: "qty", label: "Amount", unit: "qty", align: "right" },
            { key: "price", label: "Price", unit: "price", align: "right" },
            { key: "generator", label: "Why", unit: "text" },
          ],
          rows: fs.map((f) => ({ t: f.t, side: f.side, usd: round(f.quote, 2), qty: f.base, price: f.base > 0 ? f.quote / f.base : null, generator: f.generator })),
          sources: [this.src("Journal fills (SQLite)", fs.map((f) => f.t), this.d.vaultChain.chainId)],
        };
      }
      case "lots": {
        const rows = (this.d.db.prepare("SELECT * FROM lots WHERE market = ? ORDER BY opened_at DESC LIMIT ?").all(market, limit) as Record<string, unknown>[]).map((r) => {
          const d = MARKETS[market].baseDecimals;
          return {
            opened: r.opened_at as number,
            closed: (r.closed_at as number | null) ?? null,
            qty: Number(r.qty_open as string) / 10 ** d,
            left: Number(r.qty_remaining as string) / 10 ** d,
            entry: Number(r.entry_price as string) / 1e8,
            realised: Number(r.realised_usd as string),
          };
        });
        return {
          ...base,
          title: `${L} spread-revert lots`,
          caption: rows.length ? `Open and closed spread-revert lots on ${L}.` : `No spread-revert lots on ${L} yet.`,
          columns: [
            { key: "opened", label: "Opened", unit: "time" },
            { key: "closed", label: "Closed", unit: "time" },
            { key: "qty", label: "Amount", unit: "qty", align: "right" },
            { key: "left", label: "Left", unit: "qty", align: "right" },
            { key: "entry", label: "Entry", unit: "price", align: "right" },
            { key: "realised", label: "Realised", unit: "usd", align: "right" },
          ],
          rows,
          sources: [this.src("Lots ledger (SQLite)", rows.map((r) => r.opened), this.d.vaultChain.chainId)],
        };
      }
      case "oracle": {
        const c = await this.d.snapshot();
        const r = c?.markets[market];
        const t = this.now();
        const rows: DataTable["rows"] = [];
        if (r) {
          const p = r.price;
          rows.push({ source: "Supra (vault oracle)", price: e8(p.oracle.price), age: t - p.oracle.updatedAt, note: p.supra?.disagreeBps != null ? `${p.supra.disagreeBps} bps from APRO` : "" });
          if (p.apro) rows.push({ source: "APRO (cross-check)", price: e8(p.apro.price), age: p.apro.ageSec, note: "" });
          rows.push({ source: "HSKSwap pool", price: e8(p.pool.price), age: t - p.at, note: `${p.pool.deviationBps} bps from oracle` });
          if (p.pool.twap) rows.push({ source: "Pool 5-min average", price: e8(p.pool.twap), age: t - p.at, note: "" });
          if (p.cex) rows.push({ source: "HashKey Global mid", price: e8(p.cex.mid), age: t - p.cex.at, note: `half-spread ${p.cex.halfSpreadBps} bps` });
        } else base.notes.push("No market read yet; the daemon has not completed a scan.");
        return {
          ...base,
          title: `${L} prices by source`,
          caption: `Every price the vault and the agent see for ${L}, with age in seconds.`,
          columns: [
            { key: "source", label: "Source", unit: "text" },
            { key: "price", label: "Price", unit: "price", align: "right" },
            { key: "age", label: "Age (s)", align: "right" },
            { key: "note", label: "Note", unit: "text" },
          ],
          rows,
          sources: [this.src("Daemon market read (Multicall3 + HashKey Global)", [r?.price.at ?? t], this.d.vaultChain.chainId)],
        };
      }
    }
  }

  // ------------------------------------------------------------------ series builders

  /** Pool candles for the window ending now. */
  async poolCandles(market: MarketId, interval: ChartInterval, bars: number, network?: ChartNetwork): Promise<{ candles: Candle[]; source: ChartSource; notes: string[] }> {
    const sec = INTERVAL_SEC[interval];
    const h = this.net(network);
    const ref = this.poolRef(market, network);
    const toT = this.now();
    const fromT = Math.floor(toT / sec) * sec - (bars - 1) * sec;
    const sync = await this.swaps.sync(h.rpc, ref, fromT);
    const { rows, prior } = this.swaps.rows(ref, fromT);
    const candles = bucketCandles(rows, prior, sec, bars, toT);
    const notes: string[] = [];
    if (!sync.complete) notes.push(`History loaded back to ${new Date(sync.coveredFromT * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC; older bars load on the next request.`);
    if (rows.length === 0) notes.push("No swaps in this window: the line is flat at the last traded price.");
    return { candles, source: this.src(`HSKSwap ${LABEL[market]}/USDT pool Swap logs (${rows.length} swaps)`, rows.map((r) => r.t), h.chainId, sync.calls === 0, this.netName(h.chainId)), notes };
  }

  async cexCandles(market: MarketId, interval: ChartInterval, bars: number): Promise<{ candles: Candle[]; source: ChartSource }> {
    const sym = MARKETS[market].cexSymbol;
    const key = `${sym}:${interval}:${bars}`;
    const hit = this.klineCache.get(key);
    let candles: Candle[];
    if (hit && this.now() - hit.at < Math.min(60, INTERVAL_SEC[interval] / 2)) candles = hit.candles;
    else {
      const raw = (await this.d.cex.klines(sym, interval, bars)) as [number, string, string, string, string, string, number, string][];
      candles = raw.map((k) => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7] })).sort((a, b) => a.t - b.t);
      this.klineCache.set(key, { at: this.now(), candles });
    }
    return { candles, source: this.src(`HashKey Global ${sym} klines`, candles.map((c) => c.t), undefined, !!hit && hit.candles === candles) };
  }

  private async priceChart(base: Base, m: MarketId, iv: ChartInterval, bars: number, input: ChartInput): Promise<ChartSpec> {
    const p = await this.poolCandles(m, iv, bars, input.network);
    const last = p.candles.at(-1)?.c;
    return {
      ...base,
      title: `${LABEL[m]} price`,
      caption: `${LABEL[m]} price on the HSKSwap pool, ${iv} bars.`,
      series: [{ id: "pool", label: `${LABEL[m]} pool price`, type: "candles", unit: "usd", pane: 0, role: "primary", candles: p.candles }],
      lines: last ? [{ v: last, label: "Last", role: "muted" }] : [],
      sources: [p.source],
      notes: p.notes,
    };
  }

  private async cexChart(base: Base, m: MarketId, iv: ChartInterval, bars: number): Promise<ChartSpec> {
    const k = await this.cexCandles(m, iv, bars);
    return {
      ...base,
      title: `${MARKETS[m].cexSymbol} on HashKey Global`,
      caption: `${LABEL[m]} price on the HashKey Global exchange, ${iv} bars.`,
      series: [{ id: "cex", label: MARKETS[m].cexSymbol, type: "candles", unit: "usd", pane: 0, role: "primary", candles: k.candles }],
      sources: [k.source],
    };
  }

  private async volumeChart(base: Base, m: MarketId, iv: ChartInterval, bars: number, n?: ChartNetwork): Promise<ChartSpec> {
    const p = await this.poolCandles(m, iv, bars, n);
    return {
      ...base,
      title: `${LABEL[m]} pool volume`,
      caption: `Dollars traded in the HSKSwap ${LABEL[m]} pool per ${iv} bar.`,
      series: [{ id: "volume", label: "Volume (USD)", type: "histogram", unit: "usd", pane: 0, role: "primary", points: p.candles.map((c) => ({ t: c.t, v: round(c.q ?? 0, 2), tone: c.c >= c.o ? "up" : "down" })) }],
      sources: [p.source],
      notes: p.notes,
    };
  }

  private async spreadChart(base: Base, m: MarketId, iv: ChartInterval, bars: number, n?: ChartNetwork): Promise<ChartSpec> {
    const [p, k] = await Promise.all([this.poolCandles(m, iv, bars, n), this.cexCandles(m, iv, bars)]);
    const cexAt = new Map(k.candles.map((c) => [c.t, c.c]));
    const pts = p.candles.flatMap((c) => {
      const x = cexAt.get(c.t);
      return x ? [{ t: c.t, v: Math.round(((c.c - x) / x) * 10_000) }] : [];
    });
    const s = this.d.strategy().markets[m];
    const lines: ChartSpec["lines"] = [
      { v: 0, label: "No gap", role: "muted" },
      { v: s.entrySpreadBps, label: `Agent buys/sells past ${s.entrySpreadBps} bps`, role: "accent" },
      { v: -s.entrySpreadBps, label: `-${s.entrySpreadBps} bps`, role: "accent" },
      { v: FEE_BPS * 2, label: "Round-trip pool fee", role: "down" },
    ];
    return {
      ...base,
      title: `${LABEL[m]} pool vs exchange gap`,
      caption: `How far the pool price is from HashKey Global, in basis points (100 bps = 1%).`,
      series: [{ id: "spread", label: "Pool − exchange (bps)", type: "line", unit: "bps", pane: 0, role: "primary", points: pts }],
      lines,
      sources: [p.source, k.source],
      notes: p.notes,
    };
  }

  private async oracleChart(base: Base, m: MarketId, iv: ChartInterval, bars: number, n?: ChartNetwork): Promise<ChartSpec> {
    const sec = INTERVAL_SEC[iv];
    const fromT = this.now() - bars * sec;
    const [p, apro] = await Promise.all([this.poolCandles(m, iv, bars, n), this.aproHistory(m, fromT).catch(() => null)]);
    const supra = this.d.journal
      .list({ market: m, since: fromT, limit: 2000 })
      .filter((e) => e.context?.oracle?.price && e.context.oracle.price !== "0")
      .map((e) => ({ t: e.context.oracle.updatedAt || e.at, v: e8(e.context.oracle.price) }));
    const c = await this.d.snapshot();
    const live = c?.markets[m]?.price;
    if (live && live.oracle.price !== "0") supra.push({ t: live.oracle.updatedAt, v: e8(live.oracle.price) });
    const series: ChartSeries[] = [
      { id: "pool", label: "Pool price", type: "line", unit: "usd", pane: 0, role: "muted", points: p.candles.map((x) => ({ t: x.t, v: x.c })) },
      { id: "supra", label: "Supra (vault oracle)", type: "line", unit: "usd", pane: 0, role: "primary", points: dedupe(supra) },
    ];
    const sources = [p.source, this.src("Supra price at each decision (journal) + live read", supra.map((x) => x.t), this.d.vaultChain.chainId)];
    if (apro?.length) {
      series.push({ id: "apro", label: "APRO (cross-check)", type: "line", unit: "usd", pane: 0, role: "accent", points: apro });
      sources.push(this.src("APRO feed rounds (getRoundData)", apro.map((x) => x.t), 177));
    }
    const notes = [...p.notes];
    if (supra.length < 3) notes.push("Few Supra points: they come from decision records, so they fill in as the agent runs.");
    return { ...base, title: `${LABEL[m]} oracle prices`, caption: `The price the vault enforces (Supra), the APRO cross-check and the pool.`, series, sources, notes };
  }

  /** APRO rounds walking back from the latest round (mainnet feed; EOA reads only). Cached 5 min. */
  private async aproHistory(m: MarketId, fromT: number, maxRounds = 48): Promise<{ t: number; v: number }[]> {
    const key = `${m}:${fromT - (fromT % 3600)}`;
    const hit = this.aproCache.get(key);
    if (hit && this.now() - hit.at < 300) return hit.points;
    const h = this.d.mainnet();
    const feed = MAINNET_MARKETS[m].apro;
    const abi = [...aggregatorAbi, { type: "function", name: "getRoundData", stateMutability: "view", inputs: [{ name: "_roundId", type: "uint80" }], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }] as const;
    const latest = (await h.client.readContract({ address: feed, abi, functionName: "latestRoundData" })) as readonly bigint[];
    const pts: { t: number; v: number }[] = [{ t: Number(latest[3]), v: Number(latest[1]) / 1e8 }];
    let id = latest[0]!;
    for (let i = 0; i < maxRounds && id > 1n; i++) {
      id -= 1n;
      try {
        const r = (await h.client.readContract({ address: feed, abi, functionName: "getRoundData", args: [id] })) as readonly bigint[];
        const t = Number(r[3]);
        if (!t) break;
        pts.push({ t, v: Number(r[1]) / 1e8 });
        if (t < fromT) break;
      } catch {
        break;
      }
    }
    const out = dedupe(pts.filter((p) => p.t >= fromT - 86_400));
    this.aproCache.set(key, { at: this.now(), points: out });
    return out;
  }

  private async depthChart(base: Base, m: MarketId, n?: ChartNetwork): Promise<ChartSpec> {
    const h = this.net(n);
    const main = h.chainId === 177;
    const quoter = main ? MAINNET_QUOTER : HSKDEX.quoter;
    const mk = main ? MAINNET_MARKETS[m] : { pool: MARKETS[m].pool, base: MARKETS[m].baseToken, quote: MARKETS[m].quoteToken, baseDecimals: MARKETS[m].baseDecimals };
    const slot0 = (await h.client.readContract({ address: mk.pool, abi: [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }] as const, functionName: "slot0" })) as readonly [bigint, ...unknown[]];
    const sq = Number(slot0[0]) / 2 ** 96;
    const spot = sq * sq * 10 ** (mk.baseDecimals - 6); // USD per whole base
    const buy: { t: number; v: number }[] = [];
    const sell: { t: number; v: number }[] = [];
    for (let i = 0; i < DEPTH_SIZES_USD.length; i++) {
      const usd = DEPTH_SIZES_USD[i]!;
      const q = async (tokenIn: Address, tokenOut: Address, amountIn: bigint) =>
        ((await h.client.simulateContract({ address: quoter, abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee: 3000, sqrtPriceLimitX96: 0n }] })).result as readonly bigint[])[0]!;
      try {
        const out = await q(mk.quote, mk.base, BigInt(Math.round(usd * 1e6)));
        const got = Number(out) / 10 ** mk.baseDecimals;
        buy.push({ t: i, v: Math.round((1 - (got * spot) / usd) * 10_000) });
      } catch {
        /* beyond liquidity */
      }
      try {
        const amt = BigInt(Math.round((usd / spot) * 10 ** Math.min(mk.baseDecimals, 15))) * 10n ** BigInt(Math.max(0, mk.baseDecimals - 15));
        const out = await q(mk.base, mk.quote, amt);
        sell.push({ t: i, v: Math.round((1 - Number(out) / 1e6 / usd) * 10_000) });
      } catch {
        /* beyond liquidity */
      }
    }
    const t = this.now();
    return {
      ...base,
      interval: undefined,
      x: { type: "category", label: "Trade size (USD)" },
      categories: DEPTH_SIZES_USD.map((u) => `$${u}`),
      title: `${LABEL[m]} cost by trade size`,
      caption: `How much worse than the pool price a trade fills, by size (incl. the 0.30% fee).`,
      series: [
        { id: "buy", label: "Buy", type: "line", unit: "bps", pane: 0, role: "up", points: buy },
        { id: "sell", label: "Sell", type: "line", unit: "bps", pane: 0, role: "down", points: sell },
      ],
      lines: [{ v: FEE_BPS, label: "Pool fee", role: "muted" }],
      sources: [this.src(`QuoterV2 ladder on ${this.netName(h.chainId)} (live)`, [t], h.chainId, false, `spot $${spot.toPrecision(6)}`)],
    };
  }

  /** P&L, exposure and epoch budget curves rebuilt from fills, marked at vault-chain pool candle closes. */
  private async vaultChart(base: Base, kind: "pnl" | "exposure" | "budget", m: MarketId, iv: ChartInterval, bars: number): Promise<ChartSpec> {
    const sec = INTERVAL_SEC[iv];
    const fills = this.fills(m);
    const snap = await this.d.snapshot();
    const vault = snap?.markets[m]?.vault ?? null;
    const L = LABEL[m];
    const notes: string[] = [];
    if (kind === "budget") {
      const epochLen = vault?.limits.epochDuration ?? 86_400;
      const epochStart0 = vault?.epoch.start ?? 0;
      const cap = vault ? e8(vault.limits.maxEpochUsdE8) : null;
      const end = Math.floor(this.now() / sec) * sec;
      const pts: { t: number; v: number }[] = [];
      for (let t = end - (bars - 1) * sec; t <= end; t += sec) {
        const es = epochStart0 + Math.floor((t + sec - 1 - epochStart0) / epochLen) * epochLen;
        // buys (and non-exit sells) spend the epoch budget; approximate as every fill's notional
        const spent = fills.filter((f) => f.t >= es && f.t < t + sec).reduce((a, f) => a + f.quote, 0);
        pts.push({ t, v: round(spent, 2) });
      }
      return {
        ...base,
        title: `${L} daily budget used`,
        caption: `Dollars traded in each vault epoch (a UTC day) against the on-chain cap.`,
        series: [{ id: "spent", label: "Spent this epoch", type: "area", unit: "usd", pane: 0, role: "primary", points: pts }],
        lines: cap !== null ? [{ v: cap, label: `Cap $${cap}`, role: "down" }] : [],
        sources: [this.src("Vault fills (journal SQLite)", fills.map((f) => f.t), this.d.vaultChain.chainId)],
        notes: fills.length ? notes : ["No fills yet: the budget is untouched."],
      };
    }
    const p = await this.poolCandles(m, iv, bars, "vault");
    let qty = 0;
    let cost = 0;
    let realised = 0;
    let fi = 0;
    // fills before the window set the opening book
    const pts: { t: number; v: number }[] = [];
    for (const c of p.candles) {
      while (fi < fills.length && fills[fi]!.t < c.t + sec) {
        const f = fills[fi++]!;
        if (f.side === "buy") {
          qty += f.base;
          cost += f.quote;
        } else if (qty > 0) {
          const avg = cost / qty;
          const q = Math.min(f.base, qty);
          realised += f.quote - avg * q;
          cost -= avg * q;
          qty -= q;
        }
      }
      pts.push({ t: c.t, v: round(kind === "pnl" ? realised + (qty * c.c - cost) : qty * c.c, 2) });
    }
    const isPnl = kind === "pnl";
    const cap = vault ? e8(vault.limits.maxExposureUsdE8) : null;
    if (!fills.length) notes.push(`No trades yet on ${L}: the curve is flat at zero.`);
    notes.push("Rebuilt from the vault's fills (average cost, fee-inclusive); seed inventory is not included.");
    return {
      ...base,
      title: isPnl ? `${L} profit and loss` : `${L} exposure`,
      caption: isPnl ? `Realised plus marked profit of the agent's ${L} trades, in dollars.` : `Dollar value of the ${L} the agent bought, against the vault's cap.`,
      series: [{ id: kind, label: isPnl ? "P&L (USD)" : "Exposure (USD)", type: "area", unit: "usd", pane: 0, role: "primary", points: pts }],
      lines: isPnl ? [{ v: 0, label: "Break-even", role: "muted" }] : cap !== null ? [{ v: cap, label: `Cap $${cap}`, role: "down" }] : [],
      sources: [this.src("Vault fills (journal SQLite)", fills.map((f) => f.t), this.d.vaultChain.chainId), p.source],
      notes: [...notes, ...p.notes],
    };
  }

  // ------------------------------------------------------------------ helpers

  private fills(m: MarketId): { t: number; side: "buy" | "sell"; base: number; quote: number; generator: string }[] {
    const d = MARKETS[m].baseDecimals;
    return (this.d.db.prepare("SELECT side, base_qty, quote_qty, generator, at FROM fills WHERE market = ? ORDER BY at, rowid").all(m) as Record<string, unknown>[]).map((r) => ({
      t: r.at as number,
      side: r.side as "buy" | "sell",
      base: Number(r.base_qty as string) / 10 ** d,
      quote: Number(r.quote_qty as string) / 1e6,
      generator: r.generator as string,
    }));
  }

  /** Journal decisions in the chart window: executions (buy/sell), no-trades, strategy changes, pauses. */
  private markers(m: MarketId, spec: ChartSpec): ChartMarker[] {
    const ts = spec.series.flatMap((s) => (s.candles ?? s.points ?? []).map((p) => p.t));
    if (!ts.length) return [];
    const from = Math.min(...ts);
    const sec = spec.interval ? INTERVAL_SEC[spec.interval] : 0;
    const to = Math.max(...ts) + sec;
    const es = this.d.journal.list({ since: from, limit: 200, kind: ["proposal", "no_trade", "strategy_change", "pause"] });
    const out: ChartMarker[] = [];
    for (const e of es) {
      if (e.at > to) continue;
      if (e.market && e.market !== m && e.kind !== "pause") continue;
      const t = sec ? e.at - (e.at % sec) : e.at;
      const price = e.context?.pool?.price ? e8(e.context.pool.price) : undefined;
      if (e.kind === "proposal") {
        if (!e.verdict.ok || !e.intent) continue;
        out.push({ t, kind: e.intent.side, label: `${e.intent.side === "buy" ? "Buy" : "Sell"} (${e.engine})`, id: e.id, ...(price ? { price } : {}) });
      } else if (e.kind === "no_trade") out.push({ t, kind: "no_trade", label: "Skipped", id: e.id });
      else if (e.kind === "strategy_change") out.push({ t, kind: "strategy", label: "Strategy changed", id: e.id });
      else out.push({ t, kind: "pause", label: "Paused", id: e.id });
    }
    return out.sort((a, b) => a.t - b.t).slice(-100);
  }

  private src(name: string, ts: number[], chainId?: number, cached?: boolean, detail?: string): ChartSource {
    const f = ts.filter((x) => Number.isFinite(x));
    return {
      name,
      ...(detail ? { detail } : {}),
      ...(chainId ? { chainId } : {}),
      firstT: f.length ? Math.min(...f) : null,
      lastT: f.length ? Math.max(...f) : null,
      fetchedAt: this.now(),
      ...(cached ? { cached } : {}),
    };
  }
}

type Base = Omit<ChartSpec, "title" | "caption" | "series" | "sources"> & Partial<Pick<ChartSpec, "notes">>;

const e8 = (s: string) => Number(s) / 1e8;
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;
function dedupe(p: { t: number; v: number }[]): { t: number; v: number }[] {
  const m = new Map<number, number>();
  for (const x of p) m.set(x.t, x.v);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

export function chartError(e: unknown): AteError {
  return e instanceof AteError ? e : new AteError("VenueError", "ATE_VENUE_ERROR", `chart data failed: ${(e as Error).message?.split("\n")[0] ?? String(e)}`, { hint: "Retry in a minute; the RPC or HashKey Global may be rate limiting" });
}

export type { SwapRow };
