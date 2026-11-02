// @ate/oracle — per-cycle market reads (§5, §11.2): one Multicall3 call for both markets carrying pool
// slot0 / liquidity / 300 s TWAP, both APRO rounds, Supra, both vaults' state and balances; plus the
// HashKey Global public market reader (hashkey-public-market endpoint map, site glb).

import {
  HSKDEX,
  MARKETS,
  SUPRA_STORAGE,
  TWAP_WINDOW_SEC,
  deviationBps,
  getSqrtPriceAtTick,
  policyVaultAbi,
  poolPriceFromSqrtPriceX96,
  twapTick,
  type Address,
  type CexSnapshot,
  type LimitsJson,
  type MarketId,
  type OracleHealth,
  type PriceSnapshot,
  type SupraSnapshot,
  type VaultState,
} from "@ate/core";
import { erc20Abi } from "@ate/chain";
import { encodeFunctionData, type PublicClient } from "viem";
import { aggregatorAbi, multicall3Abi, poolAbi, supraAbi } from "./abis.js";

export * from "./abis.js";

export const FRESH_SEC = 3600;

export interface MarketReaderOptions {
  client: PublicClient;
  markets: MarketId[];
  vaults: Partial<Record<MarketId, Address>>;
  /** Agent address for the gas-float read. */
  agent?: Address;
  maxOracleAgeSec: number;
  /**
   * Enforcement oracle per market = the vault's immutable `oracle()` (a SupraAggregatorAdapter since
   * contracts 974cbf0). When absent, the Supra storage pair is read directly (same source, same scaling).
   */
  oracles?: Partial<Record<MarketId, Address>>;
  supra?: { storage?: Address; pairs: Partial<Record<MarketId, number | null>>; maxAgeSec: number; maxDisagreeBps: number };
  /** Latest APRO cross-check (EOA reads; see readAproCrossCheck), merged into each PriceSnapshot. */
  apro?: () => Partial<Record<MarketId, { answer: bigint; updatedAt: number } | null>>;
  cex?: CexReader | null;
  now?: () => number;
}

export interface MarketRead {
  price: PriceSnapshot;
  vault: VaultState | null;
  feeBps: number;
  /** Raw values used by the venue / policy mirror. */
  raw: { sqrtPriceX96: bigint; twapTick: number | null; oracleAnswer: bigint; oracleUpdatedAt: bigint; answeredInRound: bigint; roundId: bigint };
}

export interface CycleRead {
  blockNumber: bigint;
  blockTimestamp: number;
  at: number;
  agentBalanceWei: bigint | null;
  markets: Partial<Record<MarketId, MarketRead>>;
}

/** Default Supra pair indices (read 10:30 IST Nov 2): BTC_USDT = 0; HSK unlisted → gate inactive. */
export const DEFAULT_SUPRA_PAIRS: Record<MarketId, number | null> = {
  "hsk-dex:WHSK/USDT:3000": 517,
  "hsk-dex:WBTC/USDT:3000": 0,
};

export function oracleHealth(ageSec: number, maxOracleAgeSec: number): OracleHealth {
  if (ageSec < FRESH_SEC) return "fresh";
  if (ageSec < maxOracleAgeSec) return "aging";
  return "stale";
}

/** Truncating decimal → fixed-point (CEX prices may carry > 8 decimals). */
export function decToUnits(s: string, decimals: number): bigint {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) throw new RangeError(`not a decimal: ${s}`);
  const v = BigInt((m[2] || "0") + ((m[3] ?? "") + "0".repeat(decimals)).slice(0, decimals));
  return m[1] ? -v : v;
}

type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

export class MarketReader {
  constructor(private readonly o: MarketReaderOptions) {}

  async read(): Promise<CycleRead> {
    const now = this.o.now ?? (() => Math.floor(Date.now() / 1000));
    const calls: Call[] = [];
    const idx: Record<string, number> = {};
    const add = (key: string, c: Call) => {
      idx[key] = calls.length;
      calls.push(c);
    };
    add("ts", { address: HSKDEX.multicall3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" });
    add("bn", { address: HSKDEX.multicall3, abi: multicall3Abi, functionName: "getBlockNumber" });
    if (this.o.agent) add("agentBal", { address: HSKDEX.multicall3, abi: multicall3Abi, functionName: "getEthBalance", args: [this.o.agent] });
    for (const m of this.o.markets) {
      const s = MARKETS[m];
      add(`${m}:slot0`, { address: s.pool, abi: poolAbi, functionName: "slot0" });
      add(`${m}:liq`, { address: s.pool, abi: poolAbi, functionName: "liquidity" });
      add(`${m}:obs`, { address: s.pool, abi: poolAbi, functionName: "observe", args: [[TWAP_WINDOW_SEC, 0]] });
      const adapter = this.o.oracles?.[m];
      const pair = this.o.supra?.pairs[m] ?? DEFAULT_SUPRA_PAIRS[m];
      if (adapter) add(`${m}:apro`, { address: adapter, abi: aggregatorAbi, functionName: "latestRoundData" });
      else if (pair !== null) add(`${m}:supra`, { address: this.o.supra?.storage ?? SUPRA_STORAGE, abi: supraAbi, functionName: "getSvalue", args: [BigInt(pair)] });
      const v = this.o.vaults[m];
      if (v) {
        for (const fn of ["paused", "agent", "guardian", "owner", "limits", "epoch", "exposureUsd", "lastTradeAt", "priceDecimals"] as const) {
          add(`${m}:v:${fn}`, { address: v, abi: policyVaultAbi, functionName: fn });
        }
        add(`${m}:v:balQ`, { address: s.quoteToken, abi: erc20Abi, functionName: "balanceOf", args: [v] });
        add(`${m}:v:balP`, { address: s.baseToken, abi: erc20Abi, functionName: "balanceOf", args: [v] });
      }
    }
    // One Multicall3 call for both markets (§6.2 Batching, §18.1).
    const res = (await this.o.client.multicall({ contracts: calls as never, allowFailure: true, batchSize: 0 })) as {
      status: "success" | "failure";
      result?: unknown;
      error?: Error;
    }[];
    const get = <T>(key: string): T | undefined => {
      const i = idx[key];
      if (i === undefined) return undefined;
      const r = res[i];
      return r && r.status === "success" ? (r.result as T) : undefined;
    };
    const blockTimestamp = Number(get<bigint>("ts") ?? BigInt(now()));
    const blockNumber = get<bigint>("bn") ?? 0n;
    const cexAll = this.o.cex ? await this.o.cex.bookAll(this.o.markets.map((m) => MARKETS[m].cexSymbol)) : {};

    const out: CycleRead = { blockNumber, blockTimestamp, at: now(), agentBalanceWei: get<bigint>("agentBal") ?? null, markets: {} };
    for (const m of this.o.markets) {
      const s = MARKETS[m];
      const d = s.baseDecimals;
      const slot0 = get<readonly [bigint, number, number, number, number, number, boolean]>(`${m}:slot0`);
      const liq = get<bigint>(`${m}:liq`) ?? 0n;
      const obs = get<readonly [readonly bigint[], readonly bigint[]]>(`${m}:obs`);
      let apro = get<readonly [bigint, bigint, bigint, bigint, bigint]>(`${m}:apro`);
      if (!apro) {
        const sv = get<{ round: bigint; decimals: bigint; time: bigint; price: bigint }>(`${m}:supra`);
        if (sv && sv.price > 0n) {
          const dec = Number(sv.decimals);
          const p8 = dec >= 8 ? sv.price / 10n ** BigInt(dec - 8) : sv.price * 10n ** BigInt(8 - dec);
          let t = sv.time > 10_000_000_000n ? sv.time / 1000n : sv.time;
          if (t > BigInt(blockTimestamp)) t = BigInt(blockTimestamp);
          apro = [sv.round, p8, t, t, sv.round];
        }
      }
      const sqrtP = slot0?.[0] ?? 0n;
      const spot = sqrtP > 0n ? poolPriceFromSqrtPriceX96(sqrtP, d) : 0n;
      const tt = obs ? twapTick(obs[0][0]!, obs[0][1]!) : null;
      const twap = tt !== null ? poolPriceFromSqrtPriceX96(getSqrtPriceAtTick(tt), d) : null;
      const answer = apro?.[1] ?? 0n;
      const updatedAt = apro?.[3] ?? 0n;
      const oracleValid = !!apro && answer > 0n && updatedAt > 0n;
      const ageSec = oracleValid ? Math.max(0, blockTimestamp - Number(updatedAt)) : Number.MAX_SAFE_INTEGER;
      const dev = oracleValid && spot > 0n ? Number(deviationBps(spot, answer)) : 0;
      const twapDev = oracleValid && twap !== null ? Number(deviationBps(twap, answer)) : null;

      // Second-oracle entry gate (§5.1), roles swapped after 974cbf0: enforcement = Supra (adapter),
      // cross-check = APRO (EOA read). `supra` describes the enforcement source; disagreeBps is vs APRO.
      const aproX = this.o.apro?.()[m] ?? null;
      let aproOut: PriceSnapshot["apro"] = null;
      let supra: SupraSnapshot | null = null;
      if (oracleValid) {
        const dis = aproX && aproX.answer > 0n ? Number(deviationBps(answer, aproX.answer)) : null;
        if (aproX && aproX.answer > 0n) {
          aproOut = { price: aproX.answer.toString(), updatedAt: aproX.updatedAt, ageSec: Math.max(0, blockTimestamp - aproX.updatedAt), disagreeBps: dis ?? 0 };
        }
        supra = {
          price: answer.toString(),
          updatedAt: Number(updatedAt),
          disagreeBps: dis,
          active: dis !== null && !!aproX && blockTimestamp - aproX.updatedAt <= this.o.maxOracleAgeSec,
        };
      }

      const cexRaw = cexAll[s.cexSymbol] ?? null;
      const price: PriceSnapshot = {
        market: m,
        oracle: {
          price: answer.toString(),
          updatedAt: Number(updatedAt),
          roundId: (apro?.[0] ?? 0n).toString(),
          ageSec: oracleValid ? ageSec : 0,
          health: oracleValid ? oracleHealth(ageSec, this.o.maxOracleAgeSec) : "stale",
        },
        pool: {
          price: spot.toString(),
          twap: twap === null ? null : twap.toString(),
          sqrtPriceX96: sqrtP.toString(),
          tick: slot0?.[1] ?? 0,
          liquidity: liq.toString(),
          observationCardinality: slot0?.[3] ?? 0,
          deviationBps: dev,
          twapDeviationBps: twapDev,
        },
        cex: cexRaw,
        supra,
        apro: aproOut,
        readOnly: !oracleValid || !slot0,
        blockNumber: blockNumber.toString(),
        at: blockTimestamp,
      };

      let vault: VaultState | null = null;
      const va = this.o.vaults[m];
      if (va && get(`${m}:v:paused`) !== undefined) {
        const L = get<{ maxTradeUsd: bigint; maxEpochUsd: bigint; maxExposureUsd: bigint; epochDuration: number; maxSlippageBps: number; maxOracleDeviationBps: number; maxExitDiscountBps: number; maxOracleAge: number; cooldown: number }>(`${m}:v:limits`);
        const ep = get<readonly [bigint, bigint, bigint, bigint]>(`${m}:v:epoch`);
        const limits: LimitsJson = {
          maxTradeUsdE8: (L?.maxTradeUsd ?? 0n).toString(),
          maxEpochUsdE8: (L?.maxEpochUsd ?? 0n).toString(),
          maxExposureUsdE8: (L?.maxExposureUsd ?? 0n).toString(),
          epochDuration: Number(L?.epochDuration ?? 86400),
          maxSlippageBps: Number(L?.maxSlippageBps ?? 0),
          maxOracleDeviationBps: Number(L?.maxOracleDeviationBps ?? 0),
          maxExitDiscountBps: Number(L?.maxExitDiscountBps ?? 0),
          maxOracleAge: Number(L?.maxOracleAge ?? 0),
          cooldown: Number(L?.cooldown ?? 0),
        };
        vault = {
          market: m,
          address: va,
          paused: get<boolean>(`${m}:v:paused`) ?? false,
          agent: get<Address>(`${m}:v:agent`) ?? "0x0000000000000000000000000000000000000000",
          guardian: get<Address>(`${m}:v:guardian`) ?? "0x0000000000000000000000000000000000000000",
          owner: get<Address>(`${m}:v:owner`) ?? "0x0000000000000000000000000000000000000000",
          priceDecimals: (Number(get<number>(`${m}:v:priceDecimals`) ?? d) as 8 | 18),
          balanceQuote: (get<bigint>(`${m}:v:balQ`) ?? 0n).toString(),
          balancePrice: (get<bigint>(`${m}:v:balP`) ?? 0n).toString(),
          exposureUsdE8: (get<bigint>(`${m}:v:exposureUsd`) ?? 0n).toString(),
          epoch: {
            index: (ep?.[0] ?? 0n).toString(),
            start: Number(ep?.[1] ?? 0n),
            spentUsdE8: (ep?.[2] ?? 0n).toString(),
            capUsdE8: (ep?.[3] ?? L?.maxEpochUsd ?? 0n).toString(),
          },
          limits,
          lastTradeAt: Number(get<bigint>(`${m}:v:lastTradeAt`) ?? 0n),
        };
      }
      out.markets[m] = {
        price,
        vault,
        feeBps: s.fee / 100,
        raw: { sqrtPriceX96: sqrtP, twapTick: tt, oracleAnswer: answer, oracleUpdatedAt: updatedAt, answeredInRound: apro?.[4] ?? 0n, roundId: apro?.[0] ?? 0n },
      };
    }
    return out;
  }
}

// ------------------------------------------------------------------ HashKey Global (hashkey-public-market, site glb)

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

export interface CexReaderOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Read-only public market data per the skill's endpoint map (/quote/v1/*). Every result is timestamped. */
export class CexReader {
  private readonly f: typeof fetch;
  constructor(private readonly o: CexReaderOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const sym = params.symbol;
    if (sym !== undefined && !SYMBOL_RE.test(String(sym))) throw new RangeError(`invalid symbol ${String(sym)}`);
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 5000);
    try {
      const res = await this.f(`${this.o.baseUrl.replace(/\/$/, "")}${path}?${qs}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HashKey Global ${path} HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  async bookTicker(symbol: string): Promise<{ bid: string; bidQty: string; ask: string; askQty: string; t: number }> {
    const r = await this.get<{ s: string; b: string; bq: string; a: string; aq: string; t: number }[] | { s: string; b: string; bq: string; a: string; aq: string; t: number }>(
      "/quote/v1/ticker/bookTicker",
      { symbol },
    );
    const x = Array.isArray(r) ? r.find((e) => e.s === symbol) ?? r[0] : r;
    if (!x) throw new Error(`no bookTicker for ${symbol}`);
    return { bid: x.b, bidQty: x.bq, ask: x.a, askQty: x.aq, t: x.t };
  }

  async depth(symbol: string, limit = 5): Promise<{ bids: [string, string][]; asks: [string, string][]; t: number }> {
    const r = await this.get<{ t: number; b: [string, string][]; a: [string, string][] }>("/quote/v1/depth", { symbol, limit });
    return { bids: r.b ?? [], asks: r.a ?? [], t: r.t };
  }

  async trades(symbol: string, limit = 10): Promise<{ t: number; p: string; q: string; ibm: boolean }[]> {
    return this.get("/quote/v1/trades", { symbol, limit });
  }

  async klines(symbol: string, interval: string, limit = 500, endTime?: number): Promise<unknown[]> {
    return this.get("/quote/v1/klines", { symbol, interval, limit, ...(endTime ? { endTime } : {}) });
  }

  /** CexSnapshot for one symbol; null on failure (spread generators then emit nothing, §5.3). */
  async snapshot(symbol: "HSKUSDT" | "BTCUSDT", withTrades = false): Promise<CexSnapshot | null> {
    try {
      const bt = await this.bookTicker(symbol);
      const bid = decToUnits(bt.bid, 8);
      const ask = decToUnits(bt.ask, 8);
      if (bid <= 0n || ask <= 0n) return null;
      const mid = (bid + ask) / 2n;
      const halfSpreadBps = Number(((ask - bid) * 10_000n) / (2n * mid));
      const bidUsd = Number(bt.bid) * Number(bt.bidQty);
      const askUsd = Number(bt.ask) * Number(bt.askQty);
      const snap: CexSnapshot = {
        symbol,
        mid: mid.toString(),
        bid: bid.toString(),
        ask: ask.toString(),
        halfSpreadBps,
        topDepthUsd: Math.min(bidUsd, askUsd).toFixed(2),
        at: Math.floor(bt.t / 1000),
      };
      if (withTrades) {
        const tr = await this.trades(symbol, 10).catch(() => []);
        snap.recentTrades = tr.map((x) => ({ price: decToUnits(x.p, 8).toString(), qty: x.q, side: x.ibm ? "sell" : "buy", at: Math.floor(x.t / 1000) }));
      }
      return snap;
    } catch {
      return null;
    }
  }

  async bookAll(symbols: ("HSKUSDT" | "BTCUSDT")[]): Promise<Record<string, CexSnapshot | null>> {
    const out: Record<string, CexSnapshot | null> = {};
    await Promise.all(symbols.map(async (s) => (out[s] = await this.snapshot(s))));
    return out;
  }
}


// ------------------------------------------------------------------ APRO cross-check (EOA reads only)

/**
 * APRO feeds on 177 reject contract readers (SimpleReadAccessController), so they cannot ride in the
 * Multicall3 batch. Read each by a direct eth_call (from = zero address / EOA). Display + doctor + gate only.
 */
export async function readAproCrossCheck(client: PublicClient, markets: MarketId[]): Promise<Partial<Record<MarketId, { answer: bigint; updatedAt: number; roundId: bigint; answeredInRound: bigint } | null>>> {
  const out: Partial<Record<MarketId, { answer: bigint; updatedAt: number; roundId: bigint; answeredInRound: bigint } | null>> = {};
  for (const m of markets) {
    try {
      const r = (await client.readContract({ address: MARKETS[m].oracle, abi: aggregatorAbi, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
      out[m] = { answer: r[1], updatedAt: Number(r[3]), roundId: r[0], answeredInRound: r[4] };
    } catch {
      out[m] = null;
    }
  }
  return out;
}

// ------------------------------------------------------------------ Supra pull refresh

export const supraPullAbi = [
  { type: "function", name: "verifyOracleProof", stateMutability: "nonpayable", inputs: [{ name: "_bytesProof", type: "bytes" }], outputs: [] },
] as const;

/** POST {pair_indexes, chain_type:"evm"} → proof_bytes (hex). */
export async function fetchSupraProof(url: string, pairs: number[], fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<`0x${string}`> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pair_indexes: pairs, chain_type: "evm" }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`Supra get_proof HTTP ${res.status}`);
    const j = (await res.json()) as { proof_bytes?: string };
    if (!j.proof_bytes) throw new Error("Supra get_proof: no proof_bytes");
    const hex = j.proof_bytes.startsWith("0x") ? j.proof_bytes : `0x${j.proof_bytes}`;
    return hex as `0x${string}`;
  } finally {
    clearTimeout(t);
  }
}

export function buildSupraPullTx(contract: Address, proof: `0x${string}`): { to: Address; data: `0x${string}`; gas: bigint } {
  return { to: contract, data: encodeFunctionData({ abi: supraPullAbi, functionName: "verifyOracleProof", args: [proof] }), gas: 600_000n };
}
