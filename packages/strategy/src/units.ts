// Unit helpers shared by the generators and the guard. Everything is bigint fixed-point:
//   USD → 8-dp "E8" integers (vault units), prices → 8-dp integers, token amounts → smallest units.
// Bps values are returned as JS numbers (display / comparison precision is enough).

import { MARKETS, formatUnits, mulDiv, parseUnits, type MarketId, type Side } from "@ate/core";

export const E8 = 100_000_000n;
export const BPS_N = 10_000n;

/** Signed USD decimal string → E8 ("-0.21" → -21000000n). Accepts up to 8 decimals. */
export function usdE8(v: string | number): bigint {
  const s = typeof v === "number" ? v.toFixed(8) : v.trim();
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const x = parseUnits(trimDecimals(body, 8), 8);
  return neg ? -x : x;
}

function trimDecimals(s: string, d: number): string {
  const i = s.indexOf(".");
  if (i < 0) return s;
  const out = s.slice(0, i + 1 + d);
  return out.endsWith(".") ? out.slice(0, -1) : out;
}

/** E8 → USD decimal string, rounded to cents for display/wire (`*Usd` fields). */
export function usdStr(e8: bigint, decimals = 2): string {
  const unit = 10n ** BigInt(8 - decimals);
  const neg = e8 < 0n;
  const a = neg ? -e8 : e8;
  const rounded = (a + unit / 2n) / unit;
  const s = formatUnits(rounded, decimals);
  return neg && rounded !== 0n ? `-${s}` : s;
}

export const minB = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));
export const maxB = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b > a ? b : a));
export const clampNonNeg = (x: bigint): bigint => (x < 0n ? 0n : x);

/** USDT (6 dp) amount → E8 USD. */
export const usdtToE8 = (usdt: bigint): bigint => usdt * 100n;
/** E8 USD → USDT (6 dp), floored. */
export const e8ToUsdt = (e8: bigint): bigint => e8 / 100n;

export function baseDecimals(market: MarketId): 8 | 18 {
  return MARKETS[market].baseDecimals;
}

/** Value (E8 USD) of `qty` priceToken smallest units at `priceE8`, floored. */
export function tokenValueE8(qty: bigint, priceE8: bigint, d: number): bigint {
  if (qty <= 0n || priceE8 <= 0n) return 0n;
  return mulDiv(qty, priceE8, 10n ** BigInt(d));
}

/** priceToken amount worth `usdE8` at `priceE8`, floored. */
export function tokensForUsd(usdE8v: bigint, priceE8: bigint, d: number): bigint {
  if (usdE8v <= 0n || priceE8 <= 0n) return 0n;
  return mulDiv(usdE8v, 10n ** BigInt(d), priceE8);
}

/** Effective fill price (8 dp) = USDT paid ÷ tokens received (fee-inclusive). */
export function fillPriceE8(quoteQtyUsdt: bigint, baseQty: bigint, d: number): bigint {
  if (baseQty <= 0n) return 0n;
  return (quoteQtyUsdt * 100n * 10n ** BigInt(d)) / baseQty;
}

/** Signed (a − b) / b in bps, as a number with 2-decimal precision. */
export function signedBps(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  return Number(((a - b) * 1_000_000n) / b) / 100;
}

/** |a − b| / b in bps. */
export function absBps(a: bigint, b: bigint): number {
  return Math.abs(signedBps(a, b));
}

/** tokenIn decimals for a side. */
export function tokenInDecimals(market: MarketId, side: Side): number {
  return side === "buy" ? 6 : MARKETS[market].baseDecimals;
}

/** Round a bps number for display / candidate fields. */
export const roundBps = (x: number): number => Math.round(x * 100) / 100;

/** UTC day "YYYY-MM-DD" for a unix second. */
export function utcDay(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}
