// @ate/chain — viem client for HashKey Chain 177 with ≥ 2 RPC failover (§16, §18.1, T7) and Multicall3.
//
// Retry policy (§18.1): every RPC call retries 3× with jitter (250 ms base, 8 s cap) on network errors,
// 5xx and 429 (honouring Retry-After), then fails over to the next RPC. A Cloudflare 1015 ban takes that
// RPC out of rotation for 10 minutes. JSON-RPC errors (reverts etc.) are returned immediately.

import { AteError, CHAIN_ID, HSKDEX } from "@ate/core";
import { createPublicClient, custom, defineChain, type Chain, type PublicClient, type EIP1193RequestFn } from "viem";

export const hashkeyChain: Chain = defineChain({
  id: CHAIN_ID,
  name: "HashKey Chain",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://hsk.blockscout.com" } },
  contracts: { multicall3: { address: HSKDEX.multicall3, blockCreated: 0 } },
});

/** Additive (testnet 133): the HashKey Chain testnet definition. */
export const hashkeyTestnet: Chain = defineChain({
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://testnet-explorer.hskchain.net" } },
  contracts: { multicall3: { address: HSKDEX.multicall3, blockCreated: 0 } },
  testnet: true,
});

export function chainFor(id: number = CHAIN_ID): Chain {
  return id === 133 ? hashkeyTestnet : hashkeyChain;
}

export interface RpcPoolOptions {
  urls: string[];
  /** Retries per URL (default 3). */
  retries?: number;
  baseDelayMs?: number;
  capDelayMs?: number;
  timeoutMs?: number;
  /** Ban duration after Cloudflare 1015 (default 10 min). */
  banMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

/** JSON-RPC error preserving `code` and `data` so viem can decode reverts. */
export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

interface UrlState {
  url: string;
  bannedUntil: number;
  failures: number;
}

const RATE_LIMIT_JSONRPC_CODES = new Set([-32005, -32029, 429]);

function isCloudflare1015(status: number, body: string): boolean {
  return (status === 429 || status === 403) && /error code:?\s*1015|\b1015\b/i.test(body);
}

export class RpcPool {
  readonly states: UrlState[];
  private readonly o: Required<Omit<RpcPoolOptions, "urls" | "log">> & { log?: (m: string) => void };
  private cursor = 0;
  private id = 0;

  constructor(opts: RpcPoolOptions) {
    if (opts.urls.length === 0) throw new AteError("ConfigError", "ATE_CONFIG_INVALID", "chain.rpcUrls is empty");
    this.states = opts.urls.map((url) => ({ url, bannedUntil: 0, failures: 0 }));
    this.o = {
      retries: opts.retries ?? 3,
      baseDelayMs: opts.baseDelayMs ?? 250,
      capDelayMs: opts.capDelayMs ?? 8000,
      timeoutMs: opts.timeoutMs ?? 10_000,
      banMs: opts.banMs ?? 10 * 60_000,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: opts.now ?? Date.now,
      log: opts.log,
    };
  }

  get activeUrl(): string {
    return this.states[this.cursor]!.url;
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const s = Number(retryAfter);
      if (Number.isFinite(s)) return Math.min(this.o.capDelayMs, s * 1000);
    }
    const exp = Math.min(this.o.capDelayMs, this.o.baseDelayMs * 2 ** attempt);
    return Math.floor(exp / 2 + Math.random() * (exp / 2));
  }

  /** EIP-1193 request with retries and failover. */
  async request(method: string, params: unknown[] = []): Promise<unknown> {
    const n = this.states.length;
    let rateLimitedAll = true;
    let lastErr: unknown;
    for (let k = 0; k < n; k++) {
      const idx = (this.cursor + k) % n;
      const st = this.states[idx]!;
      if (st.bannedUntil > this.o.now()) continue;
      for (let attempt = 0; attempt <= this.o.retries; attempt++) {
        let status = 0;
        let body = "";
        let retryAfter: string | null = null;
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), this.o.timeoutMs);
          let res: Response;
          try {
            res = await this.o.fetchImpl(st.url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
              signal: ctl.signal,
            });
          } finally {
            clearTimeout(t);
          }
          status = res.status;
          retryAfter = res.headers.get("retry-after");
          body = await res.text();
          if (res.ok) {
            const j = JSON.parse(body) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
            if (j.error) {
              if (RATE_LIMIT_JSONRPC_CODES.has(j.error.code) || /rate limit|too many requests/i.test(j.error.message)) {
                status = 429;
                throw new Error(`rate limited: ${j.error.message}`);
              }
              rateLimitedAll = false;
              this.cursor = idx;
              throw new JsonRpcError(j.error.message, j.error.code, j.error.data);
            }
            st.failures = 0;
            this.cursor = idx;
            return j.result;
          }
          if (isCloudflare1015(status, body)) {
            st.bannedUntil = this.o.now() + this.o.banMs;
            this.o.log?.(`rpc ${st.url}: Cloudflare 1015 ban, out of rotation for ${this.o.banMs / 60000} min`);
            lastErr = new Error(`Cloudflare 1015 from ${st.url}`);
            break;
          }
          if (status !== 429 && status < 500) {
            rateLimitedAll = false;
            lastErr = new Error(`HTTP ${status} from ${st.url}: ${body.slice(0, 200)}`);
            break;
          }
          lastErr = new Error(`HTTP ${status} from ${st.url}`);
        } catch (e) {
          if (e instanceof JsonRpcError) throw e;
          lastErr = e;
          if (status !== 429) rateLimitedAll = false;
        }
        if (status !== 429) rateLimitedAll = false;
        st.failures++;
        if (attempt < this.o.retries) await this.o.sleep(this.backoff(attempt, retryAfter));
      }
      this.o.log?.(`rpc ${st.url}: failing over (${String((lastErr as Error)?.message ?? lastErr)})`);
    }
    if (rateLimitedAll && lastErr) {
      throw new AteError("ChainError", "ATE_RPC_RATE_LIMITED", `all RPCs rate limited (${method})`, {
        hint: "Wait 30–60 s; the public RPC rate-limits bursts. Add a second RPC in config chain.rpcUrls.",
        cause: lastErr,
      });
    }
    throw new AteError("ChainError", "ATE_VENUE_ERROR", `RPC failure on every endpoint (${method}): ${String((lastErr as Error)?.message ?? lastErr ?? "all banned")}`, {
      hint: "Check network connectivity and `ate doctor`; RPCs may be banned for 10 min after Cloudflare 1015",
      cause: lastErr,
    });
  }

  /** viem EIP-1193 request function. */
  eip1193: EIP1193RequestFn = (async ({ method, params }: { method: string; params?: unknown }) =>
    this.request(method, (params as unknown[] | undefined) ?? [])) as unknown as EIP1193RequestFn;
}

export interface ChainClient {
  rpc: RpcPool;
  client: PublicClient;
  chain: Chain;
}

export function createChainClient(opts: RpcPoolOptions & { chainId?: number }): ChainClient {
  const rpc = new RpcPool(opts);
  const chain = chainFor(opts.chainId);
  const client = createPublicClient({
    chain,
    transport: custom({ request: rpc.eip1193 }, { retryCount: 0 }),
    batch: { multicall: false },
  }) as PublicClient;
  return { rpc, client, chain };
}

/** Per-URL head + chain-id probe for `ate doctor` (§16: second RPC must pass before use). */
export async function probeRpcs(urls: string[], fetchImpl: typeof fetch = fetch): Promise<{ url: string; chainId: number | null; head: bigint | null; ms: number; error?: string }[]> {
  const out = [];
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const pool = new RpcPool({ urls: [url], retries: 1, fetchImpl });
      const cid = Number(BigInt((await pool.request("eth_chainId")) as string));
      const head = BigInt((await pool.request("eth_blockNumber")) as string);
      out.push({ url, chainId: cid, head, ms: Date.now() - t0 });
    } catch (e) {
      out.push({ url, chainId: null, head: null, ms: Date.now() - t0, error: (e as Error).message });
    }
  }
  return out;
}

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;
