// HSKSwap pool Swap-log index for charts: batched eth_getLogs (≤ maxRange blocks per call, sequential with a
// gap between calls so the public RPC's rate limit holds), cached in SQLite with one contiguous covered block
// range per (chain, pool). Block times come from a measured block interval and one anchor block per sync
// (HashKey Chain is an OP-stack chain with a constant block time), so no per-log getBlock calls.

import type Database from "better-sqlite3";
import { poolPriceFromSqrtPriceX96, type Candle } from "@ate/core";

/** Known eth_getLogs block-range limits of the public RPCs (mainnet 100 000; testnet ≈ 5 000). */
export const KNOWN_RANGE: Record<number, number> = { 177: 99_000, 133: 5_000 };
const MIN_RANGE = 500;
const RANGE_ERR = /range|too large|too many|limit exceeded|exceed/i;

export const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

export interface Rpc {
  request(method: string, params?: unknown[]): Promise<unknown>;
}

export interface SwapRow {
  block: number;
  logIndex: number;
  t: number;
  /** Pool price after the swap, USD per whole base token. */
  price: number;
  /** Base token amount (whole tokens, positive). */
  base: number;
  /** Quote (USDT) amount, positive. */
  quote: number;
  side: "buy" | "sell";
  tx: string;
  sender: string;
}

export interface PoolRef {
  chainId: number;
  pool: string;
  baseDecimals: number;
  quoteDecimals: number;
}

export interface SwapIndexOptions {
  /** Max blocks per eth_getLogs (the public RPC allows 100 000). */
  maxRange?: number;
  /** Max getLogs calls per sync (the rest loads on the next request). */
  maxCalls?: number;
  /** Gap between RPC calls, ms. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Wall-clock budget per sync, ms (default 8 000): the app's chart request must answer well inside 15 s. */
  budgetMs?: number;
  clockMs?: () => number;
}

const hexn = (n: number) => `0x${n.toString(16)}`;
const big = (h: string) => BigInt(h);
const int256 = (word: string): bigint => {
  const v = BigInt(`0x${word}`);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
};

/** Decodes one Swap log (amount0, amount1, sqrtPriceX96, liquidity, tick). token0 = base. */
export function decodeSwap(log: { data: string; topics: string[]; blockNumber: string; logIndex: string; transactionHash: string }, ref: PoolRef, t: number): SwapRow {
  const d = log.data.slice(2);
  const a0 = int256(d.slice(0, 64));
  const a1 = int256(d.slice(64, 128));
  const sqrt = BigInt(`0x${d.slice(128, 192)}`);
  const priceE8 = poolPriceFromSqrtPriceX96(sqrt, ref.baseDecimals);
  const abs = (x: bigint) => (x < 0n ? -x : x);
  return {
    block: Number(big(log.blockNumber)),
    logIndex: Number(big(log.logIndex)),
    t,
    price: Number(priceE8) / 1e8,
    base: Number(abs(a0)) / 10 ** ref.baseDecimals,
    quote: Number(abs(a1)) / 10 ** ref.quoteDecimals,
    // base flowed into the pool (amount0 > 0) → the trader sold base
    side: a0 > 0n ? "sell" : "buy",
    tx: log.transactionHash,
    sender: `0x${(log.topics[1] ?? "").slice(-40)}`,
  };
}

export class SwapIndex {
  private readonly o: Required<SwapIndexOptions>;
  private blockTime = new Map<number, number>();
  /** Per-chain block range learned from "range too large" errors (load-balanced RPCs differ). */
  private range = new Map<number, number>();
  private inflight = new Map<string, Promise<SyncResult>>();
  private readonly explicitRange: boolean;

  constructor(
    private readonly db: Database.Database,
    opts: SwapIndexOptions = {},
  ) {
    this.explicitRange = opts.maxRange !== undefined;
    this.o = {
      maxRange: opts.maxRange ?? 99_000,
      maxCalls: opts.maxCalls ?? 40,
      gapMs: opts.gapMs ?? 120,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
      budgetMs: opts.budgetMs ?? 8000,
      clockMs: opts.clockMs ?? Date.now,
    };
    db.exec(`CREATE TABLE IF NOT EXISTS chart_swaps (
      chain_id INTEGER NOT NULL, pool TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
      t INTEGER NOT NULL, price REAL NOT NULL, base REAL NOT NULL, quote REAL NOT NULL, side TEXT NOT NULL,
      tx TEXT NOT NULL, sender TEXT NOT NULL, PRIMARY KEY (chain_id, pool, block, log_index));
    CREATE INDEX IF NOT EXISTS idx_chart_swaps_t ON chart_swaps(chain_id, pool, t);
    CREATE TABLE IF NOT EXISTS chart_sync (
      chain_id INTEGER NOT NULL, pool TEXT NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (chain_id, pool));`);
  }

  /** Seconds per block, measured once per chain from two blocks 10 000 apart. */
  private async secondsPerBlock(rpc: Rpc, chainId: number, head: { n: number; t: number }): Promise<number> {
    const known = this.blockTime.get(chainId);
    if (known) return known;
    const back = Math.max(0, head.n - 10_000);
    const b = (await rpc.request("eth_getBlockByNumber", [hexn(back), false])) as { timestamp: string };
    const s = head.n > back ? (head.t - Number(big(b.timestamp))) / (head.n - back) : 2;
    const v = s > 0 ? s : 2;
    this.blockTime.set(chainId, v);
    return v;
  }

  /** Makes sure swaps since `fromT` are cached (bounded work per call). Single-flight per pool. */
  sync(rpc: Rpc, ref: PoolRef, fromT: number): Promise<SyncResult> {
    const key = `${ref.chainId}:${ref.pool.toLowerCase()}`;
    const cur = this.inflight.get(key);
    if (cur) return cur;
    const p = this.doSync(rpc, ref, fromT).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async doSync(rpc: Rpc, ref: PoolRef, fromT: number): Promise<SyncResult> {
    const pool = ref.pool.toLowerCase();
    const headB = (await rpc.request("eth_getBlockByNumber", ["latest", false])) as { number: string; timestamp: string };
    const head = { n: Number(big(headB.number)), t: Number(big(headB.timestamp)) };
    const spb = await this.secondsPerBlock(rpc, ref.chainId, head);
    const tsOf = (b: number) => Math.round(head.t - (head.n - b) * spb);
    const wantLo = Math.max(0, head.n - Math.ceil((head.t - fromT) / spb));
    const row = this.db.prepare("SELECT lo, hi FROM chart_sync WHERE chain_id = ? AND pool = ?").get(ref.chainId, pool) as { lo: number; hi: number } | undefined;
    // fetch forward (hi, head] first (fresh data matters most), then backward [wantLo, lo); chunks of the chain's
    // block range, halved in place on "range too large"; bounded by maxCalls and a time budget (partial is fine:
    // coverage stays one contiguous range and the next request continues).
    let R = this.range.get(ref.chainId) ?? (this.explicitRange ? this.o.maxRange : (KNOWN_RANGE[ref.chainId] ?? this.o.maxRange));
    let lo = row?.lo ?? head.n + 1;
    let hi = row?.hi ?? head.n;
    const ins = this.db.prepare("INSERT OR IGNORE INTO chart_swaps (chain_id, pool, block, log_index, t, price, base, quote, side, tx, sender) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const save = this.db.prepare("INSERT INTO chart_sync (chain_id, pool, lo, hi, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(chain_id, pool) DO UPDATE SET lo = excluded.lo, hi = excluded.hi, updated_at = excluded.updated_at");
    const deadline = this.o.clockMs() + this.o.budgetMs;
    let calls = 0;
    let added = 0;
    let stopped = false;
    while (!stopped) {
      const forward = !!row && hi < head.n;
      if (!forward && lo - 1 < wantLo) break;
      const a = forward ? hi + 1 : Math.max(wantLo, lo - R);
      const b = forward ? Math.min(head.n, hi + R) : lo - 1;
      if (calls >= this.o.maxCalls || this.o.clockMs() > deadline) break;
      if (calls > 0) await this.o.sleep(this.o.gapMs);
      calls++;
      let logs: Parameters<typeof decodeSwap>[0][];
      try {
        logs = (await rpc.request("eth_getLogs", [{ address: ref.pool, fromBlock: hexn(a), toBlock: hexn(b), topics: [SWAP_TOPIC] }])) as Parameters<typeof decodeSwap>[0][];
      } catch (e) {
        if (!RANGE_ERR.test(String((e as Error).message)) || R <= MIN_RANGE) {
          if (calls === 1 && !row) throw e;
          stopped = true; // keep what we have; the caller still gets cached rows
          break;
        }
        R = Math.max(MIN_RANGE, Math.floor(R / 2));
        this.range.set(ref.chainId, R);
        continue;
      }
      this.db.transaction(() => {
        for (const l of logs) {
          const s = decodeSwap(l, ref, tsOf(Number(big(l.blockNumber))));
          added += ins.run(ref.chainId, pool, s.block, s.logIndex, s.t, s.price, s.base, s.quote, s.side, s.tx, s.sender).changes;
        }
      })();
      if (forward) hi = b;
      else lo = a;
      save.run(ref.chainId, pool, lo, hi, this.o.now());
    }
    const coveredFromT = tsOf(lo);
    return { calls, added, complete: lo <= wantLo, coveredFromT, headT: head.t, secondsPerBlock: spb, cached: calls === 0 };
  }

  /** Cached swaps for a pool in [fromT, toT], oldest first; plus the last swap before fromT (opening price). */
  rows(ref: PoolRef, fromT: number, toT = Number.MAX_SAFE_INTEGER, limit = 200_000): { rows: SwapRow[]; prior: SwapRow | null } {
    const pool = ref.pool.toLowerCase();
    const map = (r: Record<string, unknown>): SwapRow => ({
      block: r.block as number,
      logIndex: r.log_index as number,
      t: r.t as number,
      price: r.price as number,
      base: r.base as number,
      quote: r.quote as number,
      side: r.side as "buy" | "sell",
      tx: r.tx as string,
      sender: r.sender as string,
    });
    const rows = (this.db.prepare("SELECT * FROM chart_swaps WHERE chain_id = ? AND pool = ? AND t >= ? AND t <= ? ORDER BY block, log_index LIMIT ?").all(ref.chainId, pool, fromT, toT, limit) as Record<string, unknown>[]).map(map);
    const p = this.db.prepare("SELECT * FROM chart_swaps WHERE chain_id = ? AND pool = ? AND t < ? ORDER BY block DESC, log_index DESC LIMIT 1").get(ref.chainId, pool, fromT) as Record<string, unknown> | undefined;
    return { rows, prior: p ? map(p) : null };
  }

  /** Newest swaps first. */
  recent(ref: PoolRef, limit: number): SwapRow[] {
    const { rows } = this.rows(ref, 0);
    return rows.slice(-limit).reverse();
  }
}

export interface SyncResult {
  calls: number;
  added: number;
  /** Covered back to the requested start. */
  complete: boolean;
  coveredFromT: number;
  headT: number;
  secondsPerBlock: number;
  cached: boolean;
}

/**
 * Buckets swaps into `bars` candles of `sec` seconds ending at the bucket containing `toT`. Empty buckets carry
 * the previous close (flat, zero volume); buckets before the first known price are dropped.
 */
export function bucketCandles(rows: SwapRow[], prior: SwapRow | null, sec: number, bars: number, toT: number): Candle[] {
  const end = Math.floor(toT / sec) * sec;
  const start = end - (bars - 1) * sec;
  const out: Candle[] = [];
  let last = prior?.price ?? null;
  let i = 0;
  while (i < rows.length && rows[i]!.t < start) last = rows[i++]!.price;
  for (let t = start; t <= end; t += sec) {
    let c: Candle | null = last === null ? null : { t, o: last, h: last, l: last, c: last, v: 0, q: 0 };
    while (i < rows.length && rows[i]!.t < t + sec) {
      const r = rows[i++]!;
      if (!c) c = { t, o: r.price, h: r.price, l: r.price, c: r.price, v: 0, q: 0 };
      c.h = Math.max(c.h, r.price);
      c.l = Math.min(c.l, r.price);
      c.c = r.price;
      c.v! += r.base;
      c.q! += r.quote;
      last = r.price;
    }
    if (c) out.push(c);
  }
  return out;
}
