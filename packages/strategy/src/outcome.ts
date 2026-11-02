// Veto / size-down outcome scoring (§11.1 E13): 30 min after an LLM veto or size-down, the counterfactual of
// the declined amount — entry at the candidate's quoted price vs the exit-executable mark at +30 min, fees
// included. Positive saved = the veto saved money; negative = it cost money.

import type { Side } from "@ate/core";
import { roundBps, signedBps, tokenValueE8, usdStr } from "./units.js";

export const OUTCOME_HORIZON_SEC = 1800 as const;

export interface VetoInput {
  side: Side;
  /** Declined amount in tokenIn smallest units (USDT 6 dp for buys, priceToken for sells). */
  declinedAmountIn: bigint;
  /** Fee-inclusive effective price the declined trade would have filled at (8 dp). */
  quotedPriceE8: bigint;
  /** Exit-executable mark at +30 min (8 dp). */
  markThenE8: bigint;
  /** priceToken decimals. */
  d: number;
}

export function scoreVeto(i: VetoInput): { savedBps: number; savedUsd: string } {
  if (i.declinedAmountIn <= 0n || i.quotedPriceE8 <= 0n) return { savedBps: 0, savedUsd: "0" };
  // Declined buy: had we bought, P&L = (markThen − quoted)/quoted; saved = −P&L.
  // Declined sell: had we sold, we'd have missed (markThen − quoted)/quoted; saved = +that.
  const move = signedBps(i.markThenE8, i.quotedPriceE8);
  const savedBps = roundBps(i.side === "buy" ? -move : move);
  const notionalE8 = i.side === "buy" ? i.declinedAmountIn * 100n : tokenValueE8(i.declinedAmountIn, i.quotedPriceE8, i.d);
  const savedE8 = (notionalE8 * BigInt(Math.round(savedBps * 100))) / 1_000_000n;
  return { savedBps, savedUsd: usdStr(savedE8, 4) };
}
