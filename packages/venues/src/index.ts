// @ate/venues — VenueAdapter (§6.1) and the hsk-dex adapter (§6.2): QuoterV2 canonical quote, vault
// check() verdict, pre-flight eth_call of PolicyVault.execute from the agent, execute calldata, receipt parsing.

import {
  AteError,
  CUSTOM_ERROR_TO_REASON,
  EXECUTE_QUOTE_BUFFER_BPS,
  HSKDEX,
  MARKETS,
  ReasonCode,
  formatUnits,
  maxBig,
  policyVaultAbi,
  poolPriceFromSqrtPriceX96,
  reasonErrorKind,
  reasonName,
  reasonToError,
  scaleFor,
  tokenInFor,
  type Address,
  type CheckResult,
  type Hex,
  type MarketId,
  type Quote,
  type QuoteRequest,
  type Side,
  type SwapParams,
} from "@ate/core";
import { decodeErrorResult, decodeEventLog, encodeFunctionData, type PublicClient, type TransactionReceipt } from "viem";

export const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const slot0Abi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  gas?: bigint;
}

export interface ParsedFill {
  vault: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  notionalUsd: bigint;
  oraclePrice: bigint;
  proposalId: Hex;
  rationaleHash: Hex;
  exitPath: boolean;
}

export interface BuildOpts {
  proposalId: Hex;
  rationaleHash: Hex;
  minAmountOut: bigint;
  deadline: bigint;
}

/** §6.1 interface (v0.1 shape; listMarkets/getMarket are served by @ate/oracle's MarketReader). */
export interface VenueAdapter {
  readonly id: string;
  readonly chainId: number;
  quote(req: QuoteRequest): Promise<Quote>;
  buildExecute(q: Quote, opts: BuildOpts): TxRequest;
  parseReceipt(r: TransactionReceipt): ParsedFill | null;
}

export interface HskDexOptions {
  client: PublicClient;
  vaults: Partial<Record<MarketId, Address>>;
  /** Address used as check() caller and pre-flight `from` (the agent). */
  agent: () => Address | null;
  quoter?: Address;
  now?: () => number;
}

export interface RawQuote {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  spotBefore: bigint;
  /** Execution cost vs pre-trade spot, incl. pool fee (bps). */
  impactBps: number;
}

export function checkReasonToAteError(c: { reason: number }, extra = ""): AteError | null {
  if (c.reason === ReasonCode.OK) return null;
  const code = reasonToError(c.reason)!;
  const kind = reasonErrorKind(c.reason)!;
  return new AteError(kind, code, `vault check() → ${reasonName(c.reason)}${extra ? `: ${extra}` : ""}`, { hint: hintFor(c.reason) });
}

export function hintFor(reason: number): string {
  switch (reason) {
    case ReasonCode.ERR_TRADE_CAP:
      return "Reduce amountIn to ≤ the vault's maxTradeUsd notional";
    case ReasonCode.ERR_EPOCH_CAP:
      return "Epoch budget exhausted; wait until the epoch resets at 00:00 UTC or trade smaller";
    case ReasonCode.ERR_COOLDOWN:
      return "Wait for the vault cooldown (default 60 s) since the last trade";
    case ReasonCode.ERR_ORACLE_DEVIATION:
      return "Pool too far from APRO: buys blocked; sells may use the exit path";
    case ReasonCode.ERR_ORACLE_STALE:
      return "APRO round older than maxOracleAge; wait for the next heartbeat";
    case ReasonCode.ERR_EXPOSURE:
      return "Sell first: a buy would exceed maxExposureUsd";
    case ReasonCode.ERR_BALANCE:
      return "Vault lacks tokenIn; reduce amountIn";
    case ReasonCode.ERR_SLIPPAGE:
      return "Re-quote; minAmountOut is below the vault floor";
    case ReasonCode.ERR_PAUSED:
      return "Vault paused; the owner must unpause (ate-owner unpause --all)";
    case ReasonCode.ERR_NOT_AGENT:
      return "The daemon's agent key is not the vault's agent; check setAgent";
    default:
      return "See SPEC §7.6";
  }
}

/** Decode a PolicyVault revert (custom error) into an AteError. */
export function decodeVaultRevert(err: unknown): AteError {
  let data: Hex | undefined;
  let e: unknown = err;
  for (let i = 0; i < 8 && e && typeof e === "object"; i++) {
    const d = (e as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x")) {
      data = d as Hex;
      break;
    }
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") {
      data = (d as { data: Hex }).data;
      break;
    }
    e = (e as { cause?: unknown }).cause;
  }
  if (data && data.length >= 10) {
    try {
      const dec = decodeErrorResult({ abi: policyVaultAbi, data });
      const reason = CUSTOM_ERROR_TO_REASON[dec.errorName];
      if (reason !== undefined) {
        const a = checkReasonToAteError({ reason }, `${dec.errorName}(${(dec.args ?? []).map(String).join(", ")})`)!;
        a.context.errorName = dec.errorName;
        return a;
      }
      return new AteError("VenueError", "ATE_VENUE_ERROR", `vault reverted ${dec.errorName}(${(dec.args ?? []).map(String).join(", ")})`, { context: { errorName: dec.errorName } });
    } catch {
      /* fallthrough */
    }
  }
  if (err instanceof AteError) return err;
  return new AteError("VenueError", "ATE_VENUE_ERROR", `execute pre-flight reverted: ${(err as Error)?.message?.split("\n")[0] ?? String(err)}`, {
    hint: "Router revert or RPC failure; re-quote and retry",
  });
}

export class HskDexAdapter implements VenueAdapter {
  readonly id = "hsk-dex";
  readonly chainId = 177;
  constructor(private readonly o: HskDexOptions) {}

  vaultFor(market: MarketId): Address {
    const v = this.o.vaults[market];
    if (!v) throw new AteError("VenueError", "ATE_MARKET_UNKNOWN", `no vault configured for ${market}`, { hint: "Add the vault to config.vaults" });
    return v;
  }

  /** QuoterV2 quoteExactInputSingle + pre-trade spot. */
  async rawQuote(market: MarketId, side: Side, amountIn: bigint): Promise<RawQuote> {
    const m = MARKETS[market];
    const tokenIn = side === "buy" ? m.quoteToken : m.baseToken;
    const tokenOut = side === "buy" ? m.baseToken : m.quoteToken;
    const [q, s0] = await Promise.all([
      this.o.client.simulateContract({
        address: this.o.quoter ?? HSKDEX.quoter,
        abi: quoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee: m.fee, sqrtPriceLimitX96: 0n }],
      }),
      this.o.client.readContract({ address: m.pool, abi: slot0Abi, functionName: "slot0" }),
    ]).catch((e) => {
      if (e instanceof AteError) throw e;
      throw new AteError("VenueError", "ATE_VENUE_ERROR", `QuoterV2 failed: ${(e as Error).message.split("\n")[0]}`, { hint: "Retry; the quoter or RPC failed" });
    });
    const amountOut = q.result[0];
    const spot = poolPriceFromSqrtPriceX96(s0[0], m.baseDecimals);
    // ideal out at spot, no fee: buy: amountIn × SCALE / spot ; sell: amountIn × spot / SCALE
    const scale = scaleFor(m.baseDecimals);
    const ideal = side === "buy" ? (amountIn * scale) / spot : (amountIn * spot) / scale;
    const impactBps = ideal > 0n ? Number(((ideal - amountOut) * 10_000n) / ideal) : 0;
    return { amountOut, sqrtPriceX96After: q.result[1], spotBefore: spot, impactBps };
  }

  async check(market: MarketId, p: SwapParams, caller?: Address): Promise<CheckResult> {
    const agent = caller ?? this.o.agent();
    if (!agent) throw new AteError("WalletError", "ATE_DAEMON_LOCKED", "no agent address (daemon locked)", { hint: "Run `ate unlock`" });
    const r = await this.o.client.readContract({ address: this.vaultFor(market), abi: policyVaultAbi, functionName: "check", args: [agent, p] });
    const [reason, notionalUsd, oraclePrice, minOutFloor, exitPath] = r as unknown as readonly [number, bigint, bigint, bigint, boolean];
    return { reason: reason as CheckResult["reason"], notionalUsd, oraclePrice, minOutFloor, exitPath };
  }

  /**
   * Canonical quote: QuoterV2 + vault check() with minAmountOut = max(floor, quote × (1 − 50 bps)) (T18).
   * Returns minAmountOut on `policy` via minOutFloor and the chosen value.
   */
  async quoteFull(req: QuoteRequest, opts: { deadline?: bigint; proposalId?: Hex; caller?: Address } = {}): Promise<{ quote: Quote; check: CheckResult; minAmountOut: bigint }> {
    const now = BigInt((this.o.now ?? (() => Math.floor(Date.now() / 1000)))());
    const m = MARKETS[req.market];
    const amountIn = BigInt(req.amountIn);
    const tin = tokenInFor(req.market, req.side);
    const raw = await this.rawQuote(req.market, req.side, amountIn);
    const buffered = (raw.amountOut * (10_000n - BigInt(EXECUTE_QUOTE_BUFFER_BPS))) / 10_000n;
    const params: SwapParams = {
      tokenIn: tin.token,
      amountIn,
      minAmountOut: buffered,
      deadline: opts.deadline ?? now + 60n,
      proposalId: opts.proposalId ?? (`0x${"00".repeat(32)}` as Hex),
    };
    let chk = await this.check(req.market, params, opts.caller);
    let minAmountOut = buffered;
    if (chk.reason === ReasonCode.ERR_SLIPPAGE && chk.minOutFloor > 0n) {
      minAmountOut = maxBig(chk.minOutFloor, buffered);
      chk = await this.check(req.market, { ...params, minAmountOut }, opts.caller);
    } else if (chk.minOutFloor > minAmountOut) {
      minAmountOut = chk.minOutFloor;
    }
    const outDec = req.side === "buy" ? m.baseDecimals : m.quoteDecimals;
    const outSym = req.side === "buy" ? m.base : m.quote;
    const code = chk.reason === ReasonCode.OK ? "OK" : reasonToError(chk.reason)!;
    const quote: Quote = {
      market: req.market,
      vault: this.vaultFor(req.market),
      side: req.side,
      tokenIn: tin.token,
      tokenOut: req.side === "buy" ? m.baseToken : m.quoteToken,
      decimals: tin.decimals,
      amountIn: amountIn.toString(),
      amountInHuman: `${formatUnits(amountIn, tin.decimals)} ${tin.symbol}`,
      amountOut: raw.amountOut.toString(),
      amountOutHuman: `${formatUnits(raw.amountOut, outDec)} ${outSym}`,
      impactBps: raw.impactBps,
      source: "simulation",
      policy: {
        reason: chk.reason,
        code,
        notionalUsdE8: chk.notionalUsd.toString(),
        oraclePrice: chk.oraclePrice.toString(),
        minOutFloor: chk.minOutFloor.toString(),
        exitPath: chk.exitPath,
      },
      minOutFloor: chk.minOutFloor.toString(),
      exitPath: chk.exitPath,
      blockNumber: "0",
      at: Number(now),
    };
    return { quote, check: chk, minAmountOut };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    return (await this.quoteFull(req)).quote;
  }

  buildExecute(q: Pick<Quote, "market" | "tokenIn" | "amountIn">, opts: BuildOpts): TxRequest {
    const p: SwapParams = { tokenIn: q.tokenIn, amountIn: BigInt(q.amountIn), minAmountOut: opts.minAmountOut, deadline: opts.deadline, proposalId: opts.proposalId };
    return { to: this.vaultFor(q.market), data: encodeFunctionData({ abi: policyVaultAbi, functionName: "execute", args: [p, opts.rationaleHash] }) };
  }

  buildPause(market: MarketId): TxRequest {
    return { to: this.vaultFor(market), data: encodeFunctionData({ abi: policyVaultAbi, functionName: "pause" }) };
  }

  /** eth_call PolicyVault.execute from the agent at latest (§6.2 Pre-flight). Throws a decoded AteError on revert. */
  async preflight(tx: TxRequest, from: Address): Promise<{ amountOut: bigint; gas: bigint | null }> {
    try {
      const r = await this.o.client.call({ account: from, to: tx.to, data: tx.data });
      const amountOut = r.data && r.data.length >= 66 ? BigInt(r.data.slice(0, 66)) : 0n;
      let gas: bigint | null = null;
      try {
        gas = await this.o.client.estimateGas({ account: from, to: tx.to, data: tx.data });
      } catch {
        gas = null;
      }
      return { amountOut, gas };
    } catch (e) {
      throw decodeVaultRevert(e);
    }
  }

  parseReceipt(r: TransactionReceipt): ParsedFill | null {
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: policyVaultAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "TradeExecuted") {
          const a = ev.args as unknown as {
            tokenIn: Address;
            tokenOut: Address;
            amountIn: bigint;
            amountOut: bigint;
            notionalUsd: bigint;
            oraclePrice: bigint;
            proposalId: Hex;
            rationaleHash: Hex;
            exitPath: boolean;
          };
          return { vault: log.address as Address, ...a };
        }
      } catch {
        /* not ours */
      }
    }
    return null;
  }
}
