// Replay data plumbing: pool Swap logs via Blockscout (batched by block range, with timestamps; JSON-RPC
// eth_getLogs fallback) and HashKey Global 1 m klines (hashkey-public-market endpoint map, site glb).
// Polite: sequential requests, a fixed delay between calls, retry with backoff on 429/5xx.

import { MARKETS, type MarketId } from "@ate/core";
import { decodeSwapData, type Kline, type SwapPoint } from "./sim.js";

export const SWAP_TOPIC0 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

export interface FetchOptions {
  blockscout?: string;
  rpcUrl?: string;
  cexBaseUrl?: string;
  delayMs?: number;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, o: FetchOptions, init?: RequestInit): Promise<unknown> {
  const f = o.fetchImpl ?? fetch;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await f(url, { ...init, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60_000, 2000 * 2 ** attempt);
        o.log?.(`  HTTP ${res.status}; backing off ${Math.round(wait / 1000)} s`);
        await sleep(wait);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      await sleep(o.delayMs ?? 1000);
      return j;
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`fetch failed after retries: ${url}: ${String(lastErr)}`);
}

export async function blockByTime(ts: number, o: FetchOptions): Promise<number> {
  const base = o.blockscout ?? "https://hsk.blockscout.com";
  const j = (await getJson(`${base}/api?module=block&action=getblocknobytime&timestamp=${ts}&closest=before`, o)) as { result?: { blockNumber?: string } };
  const b = Number(j.result?.blockNumber);
  if (!Number.isFinite(b) || b <= 0) throw new Error(`getblocknobytime failed for ${ts}`);
  return b;
}

interface RawLog {
  blockNumber: string;
  timeStamp?: string;
  data: string;
  topics: (string | null)[];
}

/** Blockscout getLogs returns ≤ 1000 per call: split the range until each slice is below the cap. */
async function logsRange(pool: string, from: number, to: number, o: FetchOptions): Promise<RawLog[]> {
  const base = o.blockscout ?? "https://hsk.blockscout.com";
  const url = `${base}/api?module=logs&action=getLogs&address=${pool}&topic0=${SWAP_TOPIC0}&fromBlock=${from}&toBlock=${to}`;
  const j = (await getJson(url, o)) as { result?: RawLog[] | string; message?: string };
  const r = Array.isArray(j.result) ? j.result : [];
  if (r.length >= 1000 && to > from) {
    const mid = Math.floor((from + to) / 2);
    return [...(await logsRange(pool, from, mid, o)), ...(await logsRange(pool, mid + 1, to, o))];
  }
  return r;
}

export async function fetchSwaps(market: MarketId, fromBlock: number, toBlock: number, o: FetchOptions = {}): Promise<SwapPoint[]> {
  const m = MARKETS[market];
  const step = 100_000;
  const out: RawLog[] = [];
  for (let b = fromBlock; b <= toBlock; b += step) {
    const e = Math.min(toBlock, b + step - 1);
    const logs = await logsRange(m.pool, b, e, o);
    out.push(...logs);
    o.log?.(`  ${m.label} swaps ${b}…${e}: ${logs.length}`);
  }
  return out
    .filter((l) => l.timeStamp)
    .map((l) => {
      const s = decodeSwapData(l.data, m.baseDecimals);
      return {
        at: Number(l.timeStamp),
        block: Number(l.blockNumber),
        priceE8: s.priceE8,
        sqrtPriceX96: s.sqrtPriceX96,
        liquidity: s.liquidity,
        usdtAbs: s.amount1 < 0n ? -s.amount1 : s.amount1,
        side: s.amount0 > 0n ? ("sell" as const) : ("buy" as const),
        sender: "0x" + (l.topics[1] ?? "").slice(-40),
      };
    });
}

/** The last swap before `beforeBlock` (sets the pool price at the window start), scanning back in widening steps. */
export async function lastSwapBefore(market: MarketId, beforeBlock: number, o: FetchOptions = {}): Promise<SwapPoint | null> {
  let span = 200_000;
  let hi = beforeBlock - 1;
  while (hi > 0 && span <= 3_200_000) {
    const lo = Math.max(0, hi - span + 1);
    const xs = await fetchSwaps(market, lo, hi, o);
    if (xs.length) return xs.sort((a, b) => a.block - b.block)[xs.length - 1]!;
    hi = lo - 1;
    span *= 2;
  }
  return null;
}

/** HashKey Global 1 m klines for [from, to], paged backwards by endTime (1000 per call). */
export async function fetchKlines(symbol: string, from: number, to: number, o: FetchOptions = {}): Promise<Kline[]> {
  const base = o.cexBaseUrl ?? "https://api-glb.hashkey.com";
  const out = new Map<number, Kline>();
  let end = to * 1000;
  for (let i = 0; i < 40 && end > from * 1000; i++) {
    const j = (await getJson(`${base}/quote/v1/klines?symbol=${symbol}&interval=1m&limit=1000&endTime=${end}`, o)) as unknown[];
    if (!Array.isArray(j) || j.length === 0) break;
    let minT = Infinity;
    for (const row of j as [number, string, string, string, string, string][]) {
      const t = Math.floor(Number(row[0]) / 1000);
      minT = Math.min(minT, t);
      if (t >= from - 300 && t <= to) out.set(t, { t, close: Number(row[4]), volume: Number(row[5]) });
    }
    o.log?.(`  ${symbol} klines → ${new Date(minT * 1000).toISOString()}`);
    if (!Number.isFinite(minT) || minT * 1000 >= end) break;
    end = minT * 1000 - 1;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** CEX half-spread in bps from the top of book: median of `samples` reads ~2 s apart (used as the replay's constant). */
export async function fetchHalfSpreadBps(symbol: string, o: FetchOptions = {}, samples = 5): Promise<number> {
  const base = o.cexBaseUrl ?? "https://api-glb.hashkey.com";
  const xs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const j = (await getJson(`${base}/quote/v1/depth?symbol=${symbol}&limit=5`, o)) as { b?: [string, string][]; a?: [string, string][] };
    const bid = Number(j.b?.[0]?.[0]);
    const ask = Number(j.a?.[0]?.[0]);
    if (bid > 0 && ask > 0) xs.push(((ask - bid) / 2 / ((bid + ask) / 2)) * 1e4);
    if (i < samples - 1) await sleep(2000);
  }
  if (!xs.length) throw new Error(`no top of book for ${symbol}`);
  xs.sort((a, b) => a - b);
  return Math.round(xs[Math.floor(xs.length / 2)]! * 100) / 100;
}

// ------------------------------------------------------------------ JSON-RPC path (default)

interface RpcReq {
  method: string;
  params: unknown[];
}

/** One HTTP request carrying a JSON-RPC batch; retries the whole batch on 429/5xx/errors. */
export async function rpcBatch(reqs: RpcReq[], o: FetchOptions): Promise<unknown[]> {
  const url = o.rpcUrl ?? "https://mainnet.hsk.xyz";
  const body = JSON.stringify(reqs.map((r, i) => ({ jsonrpc: "2.0", id: i, method: r.method, params: r.params })));
  for (let attempt = 0; attempt < 6; attempt++) {
    const j = (await getJson(url, o, { method: "POST", headers: { "content-type": "application/json" }, body })) as { id: number; result?: unknown; error?: { message: string } }[];
    const arr = Array.isArray(j) ? j : [j];
    const err = arr.find((x) => x.error);
    if (!err) return [...arr].sort((a, b) => a.id - b.id).map((x) => x.result);
    o.log?.(`  rpc error: ${err.error!.message}; retrying`);
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
  }
  throw new Error("rpc batch failed after retries");
}

const hex = (n: number) => "0x" + n.toString(16);

export async function rpcHead(o: FetchOptions): Promise<{ number: number; timestamp: number }> {
  const [b] = (await rpcBatch([{ method: "eth_getBlockByNumber", params: ["latest", false] }], o)) as { number: string; timestamp: string }[];
  return { number: Number(b!.number), timestamp: Number(b!.timestamp) };
}

/** Block timestamps for a set of block numbers (batched headers). */
export async function rpcTimestamps(blocks: number[], o: FetchOptions): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const uniq = [...new Set(blocks)];
  for (let i = 0; i < uniq.length; i += 20) {
    const part = uniq.slice(i, i + 20);
    const res = (await rpcBatch(part.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), false] })), o)) as ({ timestamp: string } | null)[];
    part.forEach((b, k) => res[k] && out.set(b, Number(res[k]!.timestamp)));
  }
  return out;
}

/** Binary-search-free block-by-time: ~2 s blocks, refined with two header reads. */
export async function rpcBlockByTime(ts: number, head: { number: number; timestamp: number }, o: FetchOptions): Promise<number> {
  let guess = Math.max(1, head.number - Math.round((head.timestamp - ts) / 2));
  for (let i = 0; i < 4; i++) {
    const t = (await rpcTimestamps([guess], o)).get(guess);
    if (t === undefined) break;
    const delta = Math.round((t - ts) / 2);
    if (Math.abs(delta) <= 1) break;
    guess = Math.max(1, guess - delta);
  }
  return guess;
}

const RPC_LOG_SPAN = 5000;

/** Swap logs via batched eth_getLogs (≤ 5000 blocks per call, 10 calls per HTTP batch); timestamps interpolated between header anchors. */
export async function fetchSwapsRpc(market: MarketId, fromBlock: number, toBlock: number, o: FetchOptions = {}): Promise<SwapPoint[]> {
  const m = MARKETS[market];
  const ranges: [number, number][] = [];
  for (let b = fromBlock; b <= toBlock; b += RPC_LOG_SPAN) ranges.push([b, Math.min(toBlock, b + RPC_LOG_SPAN - 1)]);
  const logs: RawLog[] = [];
  for (let i = 0; i < ranges.length; i += 10) {
    const part = ranges.slice(i, i + 10);
    const res = (await rpcBatch(
      part.map(([a, b]) => ({ method: "eth_getLogs", params: [{ address: m.pool, topics: [SWAP_TOPIC0], fromBlock: hex(a), toBlock: hex(b) }] })),
      o,
    )) as RawLog[][];
    for (const r of res) logs.push(...(r ?? []));
    o.log?.(`  ${m.label} swaps ${part[0]![0]}…${part[part.length - 1]![1]}: ${res.reduce((a, r) => a + (r?.length ?? 0), 0)}`);
  }
  if (logs.length === 0) return [];
  // Header anchors every 25k blocks (+ ends); linear interpolation (HSK Chain ~2 s blocks).
  const blocks = logs.map((l) => Number(l.blockNumber));
  const lo = Math.min(...blocks);
  const hi = Math.max(...blocks);
  const anchors: number[] = [];
  for (let b = lo; b < hi; b += 25_000) anchors.push(b);
  anchors.push(hi);
  const ts = await rpcTimestamps(anchors, o);
  const pts = [...ts.entries()].sort((a, b) => a[0] - b[0]);
  const tsOf = (b: number): number => {
    let prev = pts[0]!;
    for (const p of pts) {
      if (p[0] >= b) {
        if (p[0] === prev[0]) return p[1];
        return Math.round(prev[1] + ((b - prev[0]) * (p[1] - prev[1])) / (p[0] - prev[0]));
      }
      prev = p;
    }
    return prev[1] + (b - prev[0]) * 2;
  };
  return logs.map((l) => {
    const s = decodeSwapData(l.data, m.baseDecimals);
    const block = Number(l.blockNumber);
    return {
      at: tsOf(block),
      block,
      priceE8: s.priceE8,
      sqrtPriceX96: s.sqrtPriceX96,
      liquidity: s.liquidity,
      usdtAbs: s.amount1 < 0n ? -s.amount1 : s.amount1,
      side: s.amount0 > 0n ? ("sell" as const) : ("buy" as const),
      sender: "0x" + (l.topics[1] ?? "").slice(-40),
    };
  });
}

/** Last swap before `beforeBlock` via RPC, scanning back in widening windows. */
export async function lastSwapBeforeRpc(market: MarketId, beforeBlock: number, o: FetchOptions = {}): Promise<SwapPoint | null> {
  let span = 50_000;
  let hi = beforeBlock - 1;
  while (hi > 0 && span <= 1_600_000) {
    const lo = Math.max(0, hi - span + 1);
    const xs = await fetchSwapsRpc(market, lo, hi, o);
    if (xs.length) return xs.sort((a, b) => a.block - b.block)[xs.length - 1]!;
    hi = lo - 1;
    span *= 2;
  }
  return null;
}
