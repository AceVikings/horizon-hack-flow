// Testnet (chain 133) only: move a test pool off the oracle price, or back onto it, so the agent has something to
// trade during a demo. Nobody arbitrages the test pools, so they sit on the oracle and no trade ever fires. This is
// contracts/script/RecenterTestnetPool.s.sol ported to viem, signed by a separate market-maker key (the test-token
// deployer, which may mint the swap input), never the agent key or the Flow wallet. The key is read from
// $ATE_TESTNET_MM_KEY (a JSON file `[{ address, private_key }]`), default ~/.ate/testnet/deployer.json, and never
// leaves this module: no log line, response or error carries it.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const TESTNET_CHAIN_ID = 133;
const ROUTER: Address = "0xa6914E66690c6794244B5f66a09eAEbf66254237"; // SwapRouter02 (deployments/133.json)
const Q192 = 1n << 192n;

const poolAbi = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;
const aggAbi = [
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
const vaultAbi = [{ type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const tokAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const routerAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [{ type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" }, { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of a negative number");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** RecenterTestnetPool._target: sqrtPriceX96 of oracle * (1 + offsetBps/10000), token1 per token0 in raw units. */
export function targetSqrtPriceX96(o: { answer: bigint; oracleDecimals: number; dec0: number; dec1: number; offsetBps: number }): bigint {
  if (o.answer <= 0n) throw new Error("the oracle has no price");
  if (!Number.isInteger(o.offsetBps) || o.offsetBps <= -5000 || o.offsetBps >= 5000) throw new Error("offsetBps must be an integer between -4999 and 4999");
  let ratio = (o.answer * 10n ** BigInt(o.dec1) * Q192) / 10n ** BigInt(o.oracleDecimals + o.dec0);
  ratio = (ratio * BigInt(10_000 + o.offsetBps)) / 10_000n;
  return isqrt(ratio);
}

/** Pool price vs the oracle, in bps (negative: the pool is cheaper). */
export function gapBps(o: { sqrtPriceX96: bigint; answer: bigint; oracleDecimals: number; dec0: number; dec1: number }): number {
  const oracle = (o.answer * 10n ** BigInt(o.dec1) * Q192) / 10n ** BigInt(o.oracleDecimals + o.dec0); // oracle in pool ratio units ×2^192
  const pool = o.sqrtPriceX96 * o.sqrtPriceX96;
  return Number(((pool - oracle) * 1_000_000n) / oracle) / 100;
}

export function mmKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ATE_TESTNET_MM_KEY ?? join(homedir(), ".ate", "testnet", "deployer.json");
}

function loadMmKey(path: string): Hex | null {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const e = (Array.isArray(j) ? j[0] : j) as { private_key?: string; privateKey?: string } | undefined;
    const k = e?.private_key ?? e?.privateKey;
    return typeof k === "string" && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null;
  } catch {
    return null;
  }
}

export interface TestnetMarket {
  id: string;
  pool: Address;
  /** Fallback price feed; the vault's own oracle() is used when there is a vault (the price it enforces). */
  oracle: Address;
  vault?: Address | null;
}
export interface PoolGap {
  market: string;
  pool: Address;
  gapBps: number;
}

export class TestnetPool {
  private busy = false;
  constructor(
    private readonly o: {
      chainId: () => number;
      rpcUrl: () => string;
      markets: () => TestnetMarket[];
      /** Addresses the market-maker key must never be (the agent, the vault owner). */
      forbidden: () => (string | null | undefined)[];
      env?: NodeJS.ProcessEnv;
      client?: PublicClient;
      log?: (m: string) => void;
    },
  ) {}

  private pc(): PublicClient {
    return this.o.client ?? (createPublicClient({ transport: http(this.o.rpcUrl()) }) as PublicClient);
  }
  private market(m: string): TestnetMarket {
    const q = m.toLowerCase();
    const found = this.o.markets().find((x) => x.id === m || x.id.toLowerCase().includes(`:w${q}/`) || x.id.toLowerCase().includes(`:${q}/`));
    if (!found) throw Object.assign(new Error(`no ${m} market on this network`), { status: 404, code: "ATE_NOT_FOUND" });
    return found;
  }
  private guard() {
    if (this.o.chainId() !== TESTNET_CHAIN_ID) throw Object.assign(new Error("moving a pool price is a testnet (chain 133) tool only"), { status: 403, code: "ATE_TOOL_NOT_ALLOWED" });
  }

  /** `blockNumber`: read at (not before) this block, so a load-balanced RPC can't answer from an older node. */
  private async read(m: TestnetMarket, blockNumber?: bigint) {
    const c = this.pc();
    const at = blockNumber === undefined ? {} : { blockNumber };
    const oracle = m.vault ? await c.readContract({ address: m.vault, abi: vaultAbi, functionName: "oracle" }).catch(() => m.oracle) : m.oracle;
    const [slot0, t0, t1, fee, round, od] = await Promise.all([
      c.readContract({ address: m.pool, abi: poolAbi, functionName: "slot0", ...at }),
      c.readContract({ address: m.pool, abi: poolAbi, functionName: "token0" }),
      c.readContract({ address: m.pool, abi: poolAbi, functionName: "token1" }),
      c.readContract({ address: m.pool, abi: poolAbi, functionName: "fee" }),
      c.readContract({ address: oracle, abi: aggAbi, functionName: "latestRoundData" }),
      c.readContract({ address: oracle, abi: aggAbi, functionName: "decimals" }),
    ]);
    const [dec0, dec1] = await Promise.all([c.readContract({ address: t0, abi: tokAbi, functionName: "decimals" }), c.readContract({ address: t1, abi: tokAbi, functionName: "decimals" })]);
    return { sqrtPriceX96: slot0[0], token0: t0, token1: t1, fee, answer: round[1], oracleDecimals: Number(od), dec0: Number(dec0), dec1: Number(dec1) };
  }

  /** Each market's pool vs oracle gap, and whether the market-maker key is set up (its address only). */
  async status(): Promise<{ available: boolean; chainId: number; maker: Address | null; makerHsk: string | null; pools: PoolGap[] }> {
    const chainId = this.o.chainId();
    if (chainId !== TESTNET_CHAIN_ID) return { available: false, chainId, maker: null, makerHsk: null, pools: [] };
    const k = loadMmKey(mmKeyPath(this.o.env));
    const maker = k ? privateKeyToAccount(k).address : null;
    const pools: PoolGap[] = [];
    for (const m of this.o.markets()) {
      try {
        const r = await this.read(m);
        pools.push({ market: m.id, pool: m.pool, gapBps: gapBps(r) });
      } catch {
        /* RPC hiccup: the market is left out */
      }
    }
    const bal = maker ? await this.pc().getBalance({ address: maker }).catch(() => null) : null;
    return { available: !!maker, chainId, maker, makerHsk: bal === null ? null : (Number(bal) / 1e18).toFixed(4), pools };
  }

  /** Moves the pool to oracle × (1 + offsetBps/10000). offsetBps 0 restores it. */
  async move(market: string, offsetBps: number): Promise<{ market: string; beforeBps: number; afterBps: number; txs: Hex[] }> {
    this.guard();
    const m = this.market(market);
    const key = loadMmKey(mmKeyPath(this.o.env));
    if (!key) throw Object.assign(new Error(`no market-maker key at ${mmKeyPath(this.o.env)} (testnet token deployer)`), { status: 409, code: "ATE_CONFIG_INVALID" });
    const acct = privateKeyToAccount(key);
    if (this.o.forbidden().some((a) => a && a.toLowerCase() === acct.address.toLowerCase())) throw Object.assign(new Error("the market-maker key must not be the agent key or the Flow wallet"), { status: 409, code: "ATE_CONFIG_INVALID" });
    if (this.busy) throw Object.assign(new Error("a pool move is already running"), { status: 409, code: "ATE_BUSY" });
    this.busy = true;
    try {
      const r = await this.read(m);
      const before = gapBps(r);
      const target = targetSqrtPriceX96({ ...r, offsetBps });
      if (target === r.sqrtPriceX96) return { market: m.id, beforeBps: before, afterBps: before, txs: [] };
      const zeroForOne = r.sqrtPriceX96 > target; // sell token0 (the price token): price falls
      const tin = zeroForOne ? r.token0 : r.token1;
      const tout = zeroForOne ? r.token1 : r.token0;
      const c = this.pc();
      const amountIn = await c.readContract({ address: tin, abi: tokAbi, functionName: "balanceOf", args: [m.pool] });
      const w = createWalletClient({ account: acct, transport: http(this.o.rpcUrl()) });
      const chain = { id: TESTNET_CHAIN_ID, name: "HashKey Chain testnet", nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [this.o.rpcUrl()] } } } as const;
      let nonce = await c.getTransactionCount({ address: acct.address, blockTag: "pending" });
      const txs: Hex[] = [];
      let lastBlock = 0n;
      const send = async (to: Address, data: Hex, gas: bigint) => {
        const fees = await c.estimateFeesPerGas().catch(() => null);
        const hash = await w.sendTransaction({ chain, to, data, gas, nonce: nonce++, ...(fees?.maxFeePerGas ? { maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 1n } : {}) });
        txs.push(hash);
        const rc = await c.waitForTransactionReceipt({ hash, timeout: 90_000 });
        if (rc.status !== "success") throw new Error(`pool move tx reverted (${hash})`);
        lastBlock = rc.blockNumber;
      };
      await send(tin, encodeFunctionData({ abi: tokAbi, functionName: "mint", args: [acct.address, amountIn] }), 120_000n);
      await send(tin, encodeFunctionData({ abi: tokAbi, functionName: "approve", args: [ROUTER, amountIn] }), 80_000n);
      await send(ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: tin, tokenOut: tout, fee: r.fee, recipient: acct.address, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: target }] }), 600_000n);
      const after = gapBps(await this.read(m, lastBlock).catch(() => this.read(m)));
      this.o.log?.(`testnet pool ${m.id}: ${before.toFixed(0)} → ${after.toFixed(0)} bps vs the oracle (${offsetBps === 0 ? "restored" : `staged ${offsetBps} bps`})`);
      return { market: m.id, beforeBps: before, afterBps: after, txs };
    } finally {
      this.busy = false;
    }
  }
}
