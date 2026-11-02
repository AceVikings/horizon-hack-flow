// TypeScript mirror of PolicyVault math (§4.2 "Units and math") with bigint and identical rounding.
// FROZEN 04:30 IST (signatures). The Demo Day parity suite compares this against the Solidity (§18.2).
//
// Units: P, S, T = USD per whole priceToken, 8 dp. USDT 6 dp. priceToken d ∈ {8, 18}.
// SCALE = 10^(d+2). Fee f in hundredths of a bip (3000 = 0.30%). Rounding favours the vault.

import type { Address, PriceDecimals, Side } from "./markets.js";
import { ReasonCode } from "./reasons.js";

export const Q96 = 1n << 96n;
export const BPS = 10_000n;
export const FEE_DENOM = 1_000_000n;
export const USD_DECIMALS = 8;
export const USDT_DECIMALS = 6;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const TWAP_WINDOW_SEC = 300;

/** On-chain Limits struct (§4.1). uint128 → bigint; uint16/uint32 → number (viem decoding). */
export interface Limits {
  maxTradeUsd: bigint; // 8 dp; 0 = disallow
  maxEpochUsd: bigint; // 8 dp
  maxExposureUsd: bigint; // 8 dp
  epochDuration: number; // s, > 0
  maxSlippageBps: number; // ≤ 1000
  maxOracleDeviationBps: number; // ≤ 1000
  maxExitDiscountBps: number; // maxOracleDeviationBps ≤ x ≤ 2000
  maxOracleAge: number; // 300 ≤ x ≤ 172800
  cooldown: number; // s
}

/** On-chain SwapParams struct (§4.1). */
export interface SwapParams {
  tokenIn: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
  proposalId: `0x${string}`;
}

/** PolicyVault.check() outputs (§4.1). */
export interface CheckResult {
  reason: ReasonCode;
  notionalUsd: bigint;
  oraclePrice: bigint;
  minOutFloor: bigint;
  exitPath: boolean;
}

// ---------------------------------------------------------------- primitives

function assertNonNeg(...xs: bigint[]): void {
  for (const x of xs) if (x < 0n) throw new RangeError("negative operand");
}

/** floor(a × b / d), as OpenZeppelin Math.mulDiv. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  assertNonNeg(a, b);
  if (d <= 0n) throw new RangeError("mulDiv: division by zero");
  return (a * b) / d;
}

/** ceil(a × b / d), as OpenZeppelin Math.mulDiv(..., Rounding.Ceil). */
export function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  assertNonNeg(a, b);
  if (d <= 0n) throw new RangeError("mulDivUp: division by zero");
  const p = a * b;
  const q = p / d;
  return p % d === 0n ? q : q + 1n;
}

export function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** SCALE = 10^(d+2): 1e20 for WHSK (18 dp), 1e10 for WBTC (8 dp). */
export function scaleFor(d: PriceDecimals | number): bigint {
  return 10n ** BigInt(d + 2);
}

// ---------------------------------------------------------------- §4.2 units table

/** notionalUsd (8 dp). Buy: amountIn × 10^2. Sell: mulDivUp(amountIn, Pcap, 10^d). */
export function notionalUsd(side: Side, amountIn: bigint, pCap: bigint, d: PriceDecimals | number): bigint {
  return side === "buy" ? amountIn * 100n : mulDivUp(amountIn, pCap, 10n ** BigInt(d));
}

/** expectedOut in tokenOut units. Buy: mulDivUp(amountIn, SCALE, Pfloor). Sell: mulDivUp(amountIn, Pfloor, SCALE). */
export function expectedOut(side: Side, amountIn: bigint, pFloor: bigint, d: PriceDecimals | number): bigint {
  const scale = scaleFor(d);
  return side === "buy" ? mulDivUp(amountIn, scale, pFloor) : mulDivUp(amountIn, pFloor, scale);
}

/** minOutFloor = mulDivUp(expectedOut, (1e6 − f) × (1e4 − maxSlippageBps), 1e10). */
export function minOutFloor(expected: bigint, feePips: number | bigint, maxSlippageBps: number | bigint): bigint {
  return mulDivUp(expected, (FEE_DENOM - BigInt(feePips)) * (BPS - BigInt(maxSlippageBps)), 10_000_000_000n);
}

/** Pool price (8 dp, USD per whole priceToken) from sqrtPriceX96, token0 = priceToken, token1 = USDT. */
export function poolPriceFromSqrtPriceX96(sqrtPriceX96: bigint, d: PriceDecimals | number): bigint {
  return mulDiv(mulDiv(sqrtPriceX96, sqrtPriceX96, Q96), scaleFor(d), Q96);
}

/** devBps(X) = mulDivUp(|X − P|, 10^4, P). */
export function deviationBps(x: bigint, p: bigint): bigint {
  return mulDivUp(absDiff(x, p), BPS, p);
}

/** exposureUsd() = mulDivUp(priceToken balance, P, 10^d), 8 dp. */
export function exposureUsd(priceTokenBalance: bigint, p: bigint, d: PriceDecimals | number): bigint {
  return mulDivUp(priceTokenBalance, p, 10n ** BigInt(d));
}

/** Step 13 second term: mulDivUp(notionalUsd, 10^4, 10^4 − maxOracleDeviationBps). */
export function exposureBuyAddend(notional: bigint, maxOracleDeviationBps: number | bigint): bigint {
  return mulDivUp(notional, BPS, BPS - BigInt(maxOracleDeviationBps));
}

/** Step 7b admission: T ≥ mulDivUp(P, 10^4 − maxExitDiscountBps, 10^4). */
export function exitPathAllowed(twap: bigint, p: bigint, maxExitDiscountBps: number | bigint): boolean {
  return twap >= mulDivUp(p, BPS - BigInt(maxExitDiscountBps), BPS);
}

/** Mean tick over the window, rounded toward −∞ (§4.2 step 7). */
export function twapTick(tickCumulativeOld: bigint, tickCumulativeNew: bigint, windowSec = TWAP_WINDOW_SEC): number {
  const diff = tickCumulativeNew - tickCumulativeOld;
  const w = BigInt(windowSec);
  let t = diff / w; // truncates toward zero
  if (diff < 0n && diff % w !== 0n) t -= 1n;
  return Number(t);
}

const TICK_MULTIPLIERS: readonly [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** Uniswap TickMath.getSqrtPriceAtTick (v4-core naming; same values as v3 getSqrtRatioAtTick). */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick out of range: ${tick}`);
  const absTick = Math.abs(tick);
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, mul] of TICK_MULTIPLIERS) {
    if ((absTick & bit) !== 0) ratio = (ratio * mul) >> 128n;
  }
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Fixed aligned epochs: index = floor(t / epochDuration), start = index × epochDuration (§4.2 Epochs). */
export function epochOf(t: bigint, epochDuration: number): { index: bigint; start: bigint } {
  if (epochDuration <= 0) throw new RangeError("epochDuration must be > 0");
  const d = BigInt(epochDuration);
  const index = t / d;
  return { index, start: index * d };
}

/**
 * setLimits bounds (§4.1 Limits comments). Returns 0 when valid, else the 1-based Limits field index
 * (= InvalidLimits(field) on-chain, see abi LIMITS_FIELD).
 */
export function validateLimits(l: Limits): number {
  if (l.epochDuration <= 0) return 4;
  if (l.maxSlippageBps > 1000) return 5;
  if (l.maxOracleDeviationBps > 1000) return 6;
  if (l.maxExitDiscountBps < l.maxOracleDeviationBps || l.maxExitDiscountBps > 2000) return 7;
  if (l.maxOracleAge < 300 || l.maxOracleAge > 172_800) return 8;
  return 0;
}

// ---------------------------------------------------------------- check() mirror

export interface VaultCheckState {
  paused: boolean;
  agent: Address;
  quoteToken: Address;
  priceToken: Address;
  priceDecimals: PriceDecimals;
  feePips: number;
  limits: Limits;
  /** block.timestamp */
  now: bigint;
  /** latestRoundData; `reverted: true` models a reverting feed. */
  oracle: { reverted?: boolean; answer: bigint; updatedAt: bigint };
  spotSqrtPriceX96: bigint;
  /** Mean tick over 300 s, or null when observe([300, 0]) reverted. */
  twapTick: number | null;
  /** Stored epoch index and spent (rolled over lazily against `now`). */
  epochIndex: bigint;
  epochSpentUsd: bigint;
  lastTradeAt: bigint;
  balanceQuote: bigint;
  balancePrice: bigint;
}

/** Price basis after step 7. */
export interface PriceBasis {
  spot: bigint;
  twap: bigint | null;
  pFloor: bigint;
  pCap: bigint;
  exitPath: boolean;
}

const addrEq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Mirrors check(caller, p) step-for-step (§4.2 steps 1–13).
 * Output convention (FREEZE-NOTES §A4): oraclePrice is set from step 6; notionalUsd and minOutFloor are
 * computed right after step 7 (once Pfloor/Pcap exist), before steps 8–13 are evaluated; fields not yet
 * computable at the failing step are 0. The answeredInRound clause is not modelled (decided at deploy).
 */
export function checkMirror(s: VaultCheckState, caller: Address, p: SwapParams): CheckResult {
  const r = (reason: ReasonCode, extra: Partial<CheckResult> = {}): CheckResult => ({
    reason,
    notionalUsd: 0n,
    oraclePrice: 0n,
    minOutFloor: 0n,
    exitPath: false,
    ...extra,
  });
  const L = s.limits;
  const d = s.priceDecimals;
  // 1–5
  if (s.paused) return r(ReasonCode.ERR_PAUSED);
  if (!addrEq(caller, s.agent)) return r(ReasonCode.ERR_NOT_AGENT);
  if (p.amountIn === 0n) return r(ReasonCode.ERR_ZERO_AMOUNT);
  if (s.now > p.deadline) return r(ReasonCode.ERR_DEADLINE);
  const isBuy = addrEq(p.tokenIn, s.quoteToken);
  const isSell = addrEq(p.tokenIn, s.priceToken);
  if (!isBuy && !isSell) return r(ReasonCode.ERR_PAIR_NOT_ALLOWED);
  const side: Side = isBuy ? "buy" : "sell";
  // 6
  const o = s.oracle;
  if (o.reverted || o.answer <= 0n || o.updatedAt === 0n || o.updatedAt > s.now) return r(ReasonCode.ERR_ORACLE_INVALID);
  if (s.now - o.updatedAt > BigInt(L.maxOracleAge)) return r(ReasonCode.ERR_ORACLE_STALE);
  const P = o.answer;
  // 7
  const basis = priceBasis(s, side, P);
  if (typeof basis === "number") return r(basis, { oraclePrice: P });
  const notional = notionalUsd(side, p.amountIn, basis.pCap, d);
  const floor = minOutFloor(expectedOut(side, p.amountIn, basis.pFloor, d), s.feePips, L.maxSlippageBps);
  const out = { oraclePrice: P, notionalUsd: notional, minOutFloor: floor, exitPath: basis.exitPath };
  // 8
  if (notional > L.maxTradeUsd) return r(ReasonCode.ERR_TRADE_CAP, out);
  // 9
  const { index } = epochOf(s.now, L.epochDuration);
  const spent = index === s.epochIndex ? s.epochSpentUsd : 0n;
  if (spent + notional > L.maxEpochUsd) return r(ReasonCode.ERR_EPOCH_CAP, out);
  // 10
  if (s.lastTradeAt !== 0n && s.now < s.lastTradeAt + BigInt(L.cooldown)) return r(ReasonCode.ERR_COOLDOWN, out);
  // 11
  if (p.minAmountOut < floor) return r(ReasonCode.ERR_SLIPPAGE, out);
  // 12
  if ((isBuy ? s.balanceQuote : s.balancePrice) < p.amountIn) return r(ReasonCode.ERR_BALANCE, out);
  // 13
  if (isBuy) {
    const exp = exposureUsd(s.balancePrice, P, d) + exposureBuyAddend(notional, L.maxOracleDeviationBps);
    if (exp > L.maxExposureUsd) return r(ReasonCode.ERR_EXPOSURE, out);
  }
  return r(ReasonCode.OK, out);
}

/** Step 7: returns the price basis, or the failing reason code (ERR_ORACLE_DEVIATION / ERR_EXIT_PRICE). */
export function priceBasis(
  s: Pick<VaultCheckState, "spotSqrtPriceX96" | "twapTick" | "priceDecimals" | "limits">,
  side: Side,
  P: bigint,
): PriceBasis | ReasonCode {
  const d = s.priceDecimals;
  const L = s.limits;
  const S = poolPriceFromSqrtPriceX96(s.spotSqrtPriceX96, d);
  const T = s.twapTick === null ? null : poolPriceFromSqrtPriceX96(getSqrtPriceAtTick(s.twapTick), d);
  const maxDev = BigInt(L.maxOracleDeviationBps);
  if (T !== null && deviationBps(S, P) <= maxDev && deviationBps(T, P) <= maxDev) {
    return { spot: S, twap: T, pFloor: P, pCap: P, exitPath: false };
  }
  if (side === "buy" || T === null) return ReasonCode.ERR_ORACLE_DEVIATION;
  if (!exitPathAllowed(T, P, L.maxExitDiscountBps)) return ReasonCode.ERR_EXIT_PRICE;
  return { spot: S, twap: T, pFloor: minBig(P, T), pCap: maxBig(P, T), exitPath: true };
}

// ---------------------------------------------------------------- decimal-string helpers

/** Parse a non-negative decimal string into fixed-point units ("25.5", 8 → 2550000000n). Rejects excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new RangeError(`not a non-negative decimal: ${value}`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`too many decimals (${frac.length} > ${decimals}): ${value}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Format fixed-point units as a decimal string, trimming trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** USD decimal string ("25", "0.10") → 8-dp vault units. */
export const usdToE8 = (usd: string): bigint => parseUnits(usd, USD_DECIMALS);
/** 8-dp vault units → USD decimal string. */
export const e8ToUsd = (e8: bigint): string => formatUnits(e8, USD_DECIMALS);

/**
 * USD cap → priceToken amount for sells (§11.3 "USD caps on token amounts"):
 * floor(capUsd ÷ max(P, T) × 0.99) in priceToken units.
 */
export function sellAmountForUsdCap(capUsdE8: bigint, p: bigint, twap: bigint | null, d: PriceDecimals | number): bigint {
  const pc = twap === null ? p : maxBig(p, twap);
  return mulDiv(mulDiv(capUsdE8, 10n ** BigInt(d), pc), 99n, 100n);
}
