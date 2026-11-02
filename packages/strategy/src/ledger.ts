// Position book (average cost, fee-inclusive) + FIFO spread-revert lot sub-ledger (§11.4 rule 4, §12 lots),
// and P&L helpers (§7.2 ate_positions: realised / exit-executable / CEX-marked, never blended).

import { createHash } from "node:crypto";
import type { GeneratorId, Leg, Lot, MarketId, PositionBook, Side, UnixSec } from "@ate/core";
import { MARKETS } from "@ate/core";
import { fillPriceE8, signedBps, tokenValueE8, usdE8, usdStr } from "./units.js";

export interface FillInput {
  id: string;
  market: MarketId;
  side: Side;
  /** priceToken smallest units (received on buys, spent on sells). */
  baseQty: bigint;
  /** USDT 6-dp (paid on buys, received on sells). */
  quoteQty: bigint;
  generator: GeneratorId | "discretionary";
  leg?: Leg;
  at: UnixSec;
}

export interface BookState {
  qty: bigint;
  /** Σ cost basis in E8 USD for the current qty (avg-cost). */
  costE8: bigint;
  realisedE8: bigint;
  lots: Lot[];
  lotsRealisedE8: bigint;
}

export const emptyBook = (): BookState => ({ qty: 0n, costE8: 0n, realisedE8: 0n, lots: [], lotsRealisedE8: 0n });

/** Seed inventory deposited by the owner enters at the APRO price at the deposit block (§11.4 rule 4). */
export function seedBook(qty: bigint, aproPriceE8: bigint, d: number): BookState {
  return { ...emptyBook(), qty, costE8: tokenValueE8(qty, aproPriceE8, d) };
}

export function avgEntryE8(b: BookState, d: number): bigint | null {
  if (b.qty <= 0n) return null;
  return (b.costE8 * 10n ** BigInt(d)) / b.qty;
}

function lotId(fillId: string): string {
  return `lot_${createHash("sha256").update(fillId).digest("hex").slice(0, 16)}`;
}

/** Apply one fill. Every sell consumes open spread-revert lots FIFO first, then other inventory. */
export function applyFill(b: BookState, f: FillInput): BookState {
  const d = MARKETS[f.market].baseDecimals;
  const lots = b.lots.map((l) => ({ ...l }));
  if (f.side === "buy") {
    const cost = f.quoteQty * 100n;
    const next: BookState = { ...b, qty: b.qty + f.baseQty, costE8: b.costE8 + cost, lots };
    if (f.generator === "spread-revert" && (f.leg ?? "open") === "open") {
      lots.push({
        id: lotId(f.id),
        market: f.market,
        openFillId: f.id,
        qtyOpen: f.baseQty.toString(),
        qtyRemaining: f.baseQty.toString(),
        entryPrice: fillPriceE8(f.quoteQty, f.baseQty, d).toString(),
        realisedUsd: "0",
        openedAt: f.at,
        closedAt: null,
      });
    }
    return next;
  }
  // Sell: realise vs average cost.
  const sellQty = f.baseQty > b.qty ? b.qty : f.baseQty;
  const costOut = b.qty > 0n ? (b.costE8 * sellQty) / b.qty : 0n;
  const proceeds = f.quoteQty * 100n;
  // Proceeds attributable to the held qty (if the fill exceeds the book, scale down).
  const proceedsHeld = f.baseQty > 0n ? (proceeds * sellQty) / f.baseQty : 0n;
  const realised = b.realisedE8 + proceedsHeld - costOut;
  // FIFO lots.
  let remaining = f.baseQty;
  let lotsRealised = b.lotsRealisedE8;
  const sellPx = fillPriceE8(f.quoteQty, f.baseQty, d);
  for (const l of lots) {
    if (remaining <= 0n) break;
    const r = BigInt(l.qtyRemaining);
    if (r <= 0n || l.closedAt !== null) continue;
    const take = remaining < r ? remaining : r;
    const pnl = ((sellPx - BigInt(l.entryPrice)) * take) / 10n ** BigInt(d);
    l.qtyRemaining = (r - take).toString();
    l.realisedUsd = usdStr(usdE8(l.realisedUsd) + pnl, 8);
    if (r - take === 0n) l.closedAt = f.at;
    lotsRealised += pnl;
    remaining -= take;
  }
  return { qty: b.qty - sellQty, costE8: b.costE8 - costOut, realisedE8: realised, lots, lotsRealisedE8: lotsRealised };
}

export function toPositionBook(b: BookState, market: MarketId): PositionBook {
  const d = MARKETS[market].baseDecimals;
  const avg = avgEntryE8(b, d);
  return {
    qty: b.qty.toString(),
    avgEntry: avg === null ? null : avg.toString(),
    realisedUsd: usdStr(b.realisedE8, 8),
    lots: b.lots.filter((l) => BigInt(l.qtyRemaining) > 0n),
  };
}

export interface PnlView {
  realisedUsd: string;
  unrealisedExitUsd: string;
  unrealisedExitBps: number;
  unrealisedCexUsd: string;
  unrealisedCexBps: number;
  lotsRealisedUsd: string;
}

/** Position P&L two ways (exit-executable mark and CEX mid), never blended (§11.3). */
export function pnl(b: BookState, market: MarketId, exitMarkE8: bigint | null, cexMidE8: bigint | null): PnlView {
  const d = MARKETS[market].baseDecimals;
  const avg = avgEntryE8(b, d);
  const exitVal = exitMarkE8 === null ? null : tokenValueE8(b.qty, exitMarkE8, d);
  const cexVal = cexMidE8 === null ? null : tokenValueE8(b.qty, cexMidE8, d);
  return {
    realisedUsd: usdStr(b.realisedE8),
    unrealisedExitUsd: exitVal === null ? "0" : usdStr(exitVal - b.costE8),
    unrealisedExitBps: avg && exitMarkE8 ? signedBps(exitMarkE8, avg) : 0,
    unrealisedCexUsd: cexVal === null ? "0" : usdStr(cexVal - b.costE8),
    unrealisedCexBps: avg && cexMidE8 ? signedBps(cexMidE8, avg) : 0,
    lotsRealisedUsd: usdStr(b.lotsRealisedE8),
  };
}
