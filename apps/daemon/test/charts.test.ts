import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { atr, bollinger, bucketCandles, ChartService, ema, indicatorSeries, macd, rsi, sma, SwapIndex, vwap, decodeSwap } from "../src/charts/index.js";
import { SWAP_TOPIC, type SwapRow } from "../src/charts/swaps.js";

const close = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
const candles = close.map((c, i) => ({ t: i * 60, o: c - 0.5, h: c + 1, l: c - 1, c, v: 10 + (i % 3) }));

describe("indicators", () => {
  it("SMA and EMA match hand-computed values", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBe(2); // seeded with SMA
    expect(e[3]).toBeCloseTo(3); // 4×0.5 + 2×0.5
    expect(e[4]).toBeCloseTo(4);
  });
  it("RSI is 100 on a monotone rise, 50 when flat, and bounded", () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3).at(-1)).toBe(100);
    expect(rsi([5, 5, 5, 5, 5], 3).at(-1)).toBe(50);
    for (const v of rsi(close)) if (v !== null) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
  });
  it("MACD hist = macd − signal; Bollinger brackets the mid; ATR ≥ 0; VWAP inside the range", () => {
    const m = macd(close);
    const i = m.hist.findIndex((x) => x !== null);
    expect(i).toBe(33); // 26 + 9 − 2
    expect(m.hist[i]).toBeCloseTo(m.macd[i]! - m.signal[i]!);
    const b = bollinger(close);
    expect(b.upper[25]!).toBeGreaterThan(b.mid[25]!);
    expect(b.lower[25]!).toBeLessThan(b.mid[25]!);
    expect(atr(candles).filter((x) => x !== null).every((x) => x! > 0)).toBe(true);
    const v = vwap(candles).at(-1)!;
    expect(v).toBeGreaterThan(Math.min(...close) - 1);
    expect(v).toBeLessThan(Math.max(...close) + 1);
  });
  it("indicatorSeries puts overlays on pane 0 and oscillators on pane 1, without warm-up NaNs", () => {
    const s = indicatorSeries(candles, ["ema20", "bb20", "rsi14", "macd"]);
    expect(s.find((x) => x.id === "ema20")!.pane).toBe(0);
    expect(s.find((x) => x.id === "rsi14")!.pane).toBe(1);
    expect(s.find((x) => x.id === "ema20")!.points).toHaveLength(21);
    expect(s.find((x) => x.id === "macd_hist")!.type).toBe("histogram");
    for (const x of s) for (const p of x.points!) expect(Number.isFinite(p.v)).toBe(true);
  });
});

const row = (t: number, price: number, base = 1): SwapRow => ({ block: t, logIndex: 0, t, price, base, quote: base * price, side: "buy", tx: "0x", sender: "0x" });

describe("candles", () => {
  it("buckets swaps, carries the prior close through empty bars", () => {
    const c = bucketCandles([row(130, 10), row(150, 12), row(170, 9), row(300, 11)], row(10, 8), 60, 5, 330);
    expect(c.map((x) => x.t)).toEqual([120, 180, 240, 300, 360].map((x) => x - 60));
    expect(c[0]).toMatchObject({ t: 60, o: 8, c: 8, v: 0 });
    expect(c[1]).toMatchObject({ t: 120, o: 8, h: 12, l: 8, c: 9, v: 3 }); // opens at the prior close
    expect(c[2]).toMatchObject({ o: 9, c: 9, v: 0 });
    expect(c[4]).toMatchObject({ t: 300, c: 11 });
  });
  it("drops bars before the first known price", () => {
    expect(bucketCandles([row(250, 5)], null, 60, 5, 300).map((x) => x.t)).toEqual([240, 300]);
  });
});

describe("Swap logs", () => {
  const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
  // WHSK/USDT: token0 = WHSK (18 dp), token1 = USDT (6 dp); price 0.0875 USD → sqrtPriceX96 = sqrt(0.0875e-12) × 2^96
  const sqrt = BigInt(Math.round(Math.sqrt(0.0875 * 1e6 / 1e18) * 2 ** 96));
  const log = (block: number, a0: bigint, a1: bigint) => ({
    data: `0x${word(a0)}${word(a1)}${word(sqrt)}${word(1n)}${word(0n)}`,
    topics: [SWAP_TOPIC, `0x${"0".repeat(24)}${"ab".repeat(20)}`, `0x${"0".repeat(64)}`],
    blockNumber: `0x${block.toString(16)}`,
    logIndex: "0x0",
    transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
  });
  const ref = { chainId: 177, pool: "0xPool", baseDecimals: 18, quoteDecimals: 6 };

  it("decodes price, sizes and side", () => {
    const s = decodeSwap(log(5, -(10n ** 19n), 875_000n), ref, 1000);
    expect(s.price).toBeCloseTo(0.0875, 6);
    expect(s).toMatchObject({ side: "buy", base: 10, quote: 0.875, block: 5, t: 1000 });
    expect(decodeSwap(log(6, 10n ** 18n, -87_000n), ref, 1).side).toBe("sell");
  });

  it("syncs in ≤ maxRange chunks, caches, and only fetches new blocks next time", async () => {
    const db = new Database(":memory:");
    const calls: [number, number][] = [];
    let head = 1000;
    const rpc = {
      async request(method: string, params: unknown[] = []) {
        if (method === "eth_getBlockByNumber") {
          const n = params[0] === "latest" ? head : Number(params[0] as string);
          return { number: `0x${n.toString(16)}`, timestamp: `0x${(10_000 + n * 2).toString(16)}` };
        }
        const f = params[0] as { fromBlock: string; toBlock: string };
        const a = Number(f.fromBlock);
        const b = Number(f.toBlock);
        calls.push([a, b]);
        return [500, 900, 1100].filter((x) => x >= a && x <= b).map((x) => log(x, -(10n ** 18n), 87_500n));
      },
    };
    const idx = new SwapIndex(db, { maxRange: 300, gapMs: 0 });
    const from = 10_000 + 400 * 2; // block 400
    const r1 = await idx.sync(rpc, ref, from);
    expect(r1.secondsPerBlock).toBe(2);
    expect(r1.complete).toBe(true);
    expect(calls.every(([a, b]) => b - a + 1 <= 300)).toBe(true);
    expect(idx.rows(ref, 0).rows.map((r) => r.block)).toEqual([500, 900]);
    expect(idx.rows(ref, 0).rows[0]!.t).toBe(10_000 + 500 * 2);
    calls.length = 0;
    head = 1200;
    await idx.sync(rpc, ref, from);
    expect(calls).toEqual([[1001, 1200]]);
    expect(idx.recent(ref, 5).map((r) => r.block)).toEqual([1100, 900, 500]);
    calls.length = 0;
    await idx.sync(rpc, ref, from);
    expect(calls).toEqual([]); // nothing new
  });

  const limitedRpc = (limit: number, head: number, calls: [number, number][], rejects: { n: number }) => ({
    async request(method: string, params: unknown[] = []) {
      if (method === "eth_getBlockByNumber") {
        const n = params[0] === "latest" ? head : Number(params[0] as string);
        return { number: `0x${n.toString(16)}`, timestamp: `0x${(1_000_000 + n * 2).toString(16)}` };
      }
      const f = params[0] as { fromBlock: string; toBlock: string };
      const a = Number(f.fromBlock);
      const b = Number(f.toBlock);
      if (b - a + 1 > limit) {
        rejects.n++;
        throw new Error('HTTP 400: {"error":{"code":-32602,"message":"block range too large"}}');
      }
      calls.push([a, b]);
      return [head - 10].filter((x) => x >= a && x <= b).map((x) => log(x, -(10n ** 18n), 87_500n));
    },
  });

  it("testnet 133: starts at the known 5 000-block range, so no request is rejected", async () => {
    const calls: [number, number][] = [];
    const rejects = { n: 0 };
    const idx = new SwapIndex(new Database(":memory:"), { gapMs: 0 });
    const head = 200_000;
    const r = await idx.sync(limitedRpc(5000, head, calls, rejects), { ...ref, chainId: 133 }, 1_000_000 + (head - 30_000) * 2);
    expect(rejects.n).toBe(0);
    expect(r.complete).toBe(true);
    expect(calls.length).toBe(7); // 30 001 blocks inclusive
    expect(idx.rows({ ...ref, chainId: 133 }, 0).rows).toHaveLength(1);
  });

  it("unknown chain: halves the range in place on 'range too large' (few rejects, still completes)", async () => {
    const calls: [number, number][] = [];
    const rejects = { n: 0 };
    const idx = new SwapIndex(new Database(":memory:"), { gapMs: 0 });
    const r = await idx.sync(limitedRpc(5000, 300_000, calls, rejects), { ...ref, chainId: 999 }, 1_000_000 + (300_000 - 40_000) * 2);
    expect(rejects.n).toBeLessThanOrEqual(5); // 99 000 → 49 500 → … → 3 093
    expect(r.complete).toBe(true);
    expect(calls.every(([a, b]) => b - a + 1 <= 5000)).toBe(true);
  });

  it("stops at the time budget with partial coverage instead of hanging", async () => {
    let clock = 0;
    const calls: [number, number][] = [];
    const idx = new SwapIndex(new Database(":memory:"), { gapMs: 0, budgetMs: 1000, clockMs: () => (clock += 300) });
    const r = await idx.sync(limitedRpc(5000, 500_000, calls, { n: 0 }), { ...ref, chainId: 133 }, 1_000_000);
    expect(r.complete).toBe(false);
    expect(calls.length).toBeLessThan(5);
    const again = await idx.sync(limitedRpc(5000, 500_000, calls, { n: 0 }), { ...ref, chainId: 133 }, 1_000_000);
    expect(again.coveredFromT).toBeLessThan(r.coveredFromT); // continues backward next time
  });
});

describe("price chart fallback", () => {
  const now = 2_000_000;
  const emptyRpc = (fail = false) => ({
    async request(method: string, params: unknown[] = []) {
      if (method === "eth_getBlockByNumber") {
        const n = params[0] === "latest" ? 50_000 : Number(params[0] as string);
        return { number: `0x${n.toString(16)}`, timestamp: `0x${(now - (50_000 - n) * 2).toString(16)}` };
      }
      if (fail) throw new Error("HTTP 500 from rpc");
      return [];
    },
  });
  const klines = Array.from({ length: 24 }, (_, i) => [(now - (23 - i) * 3600) * 1000, "100", "101", "99", String(100 + i), "1", 0, "100"]);
  const svc = (fail: boolean) => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE fills (id TEXT, market TEXT, side TEXT, base_qty TEXT, quote_qty TEXT, generator TEXT, at INTEGER)");
    const h = { chainId: 133, rpc: emptyRpc(fail), client: {} as never };
    return new ChartService({ db, journal: { list: () => [] }, vaultChain: h, mainnet: () => h, cex: { klines: async () => klines, depth: async () => ({ bids: [], asks: [], t: 0 }) } as never, snapshot: async () => null, strategy: () => ({}) as never, now: () => now, swaps: new SwapIndex(db, { gapMs: 0 }) });
  };
  it("uses HashKey Global candles when the pool has no trades yet", async () => {
    const s = await svc(false).chart({ kind: "price", market: "hsk-dex:WBTC/USDT:3000", interval: "1h", bars: 24 });
    expect(s.series[0]!.id).toBe("cex");
    expect(s.series[0]!.candles!.at(-1)!.c).toBe(123);
    expect(s.caption).toMatch(/no trades in this window/);
  });
  it("uses HashKey Global candles when the pool read fails", async () => {
    const s = await svc(true).chart({ kind: "price", market: "hsk-dex:WBTC/USDT:3000", interval: "1h", bars: 24 });
    expect(s.series[0]!.id).toBe("cex");
    expect(s.notes[0]).toMatch(/could not be read/);
  });
});
