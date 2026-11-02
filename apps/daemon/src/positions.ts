// Positions and P&L (§7.2, §11.4): average-cost basis (fee-inclusive, from actual fills) per market, plus the
// spread-revert FIFO lot sub-ledger (every sell consumes open lots FIFO first, then other inventory). Lots'
// realised P&L is reported alongside position P&L, never summed with it.

import { mulDiv, type Lot, type MarketId } from "@ate/core";

export interface FillRow {
  id: string;
  market: MarketId;
  generator: string;
  side: "buy" | "sell";
  /** priceToken smallest units. */
  baseQty: bigint;
  /** USDT smallest units (6 dp). */
  quoteQty: bigint;
  at: number;
  leg?: "open" | "close" | null;
}

export interface Book {
  qty: bigint;
  /** Cost basis of qty, USD 8 dp. */
  costE8: bigint;
  realisedE8: bigint;
  lots: Lot[];
  lotsRealisedE8: bigint;
  feeDragE8: bigint;
}

const USDT_TO_E8 = 100n;

/** Seed inventory (vault funded by the owner) enters at its seed basis (APRO at the seed block, §11.4). */
export function seedBook(qty: bigint, basisPriceE8: bigint, d: number): Book {
  return { qty, costE8: mulDiv(qty, basisPriceE8, 10n ** BigInt(d)), realisedE8: 0n, lots: [], lotsRealisedE8: 0n, feeDragE8: 0n };
}

export function emptyBook(): Book {
  return { qty: 0n, costE8: 0n, realisedE8: 0n, lots: [], lotsRealisedE8: 0n, feeDragE8: 0n };
}

export function applyFill(b: Book, f: FillRow, d: number, feePips = 3000): Book {
  const quoteE8 = f.quoteQty * USDT_TO_E8;
  const next: Book = { ...b, lots: b.lots.map((l) => ({ ...l })) };
  next.feeDragE8 += (quoteE8 * BigInt(feePips)) / 1_000_000n;
  if (f.side === "buy") {
    next.qty += f.baseQty;
    next.costE8 += quoteE8;
    if (f.generator === "spread-revert" && f.leg !== "close") {
      const entry = f.baseQty > 0n ? mulDiv(quoteE8, 10n ** BigInt(d), f.baseQty) : 0n;
      next.lots.push({
        id: `lot_${f.id}`,
        market: f.market,
        openFillId: f.id,
        qtyOpen: f.baseQty.toString(),
        qtyRemaining: f.baseQty.toString(),
        entryPrice: entry.toString(),
        realisedUsd: "0",
        openedAt: f.at,
        closedAt: null,
      });
    }
    return next;
  }
  // sell: average cost
  const sold = f.baseQty > next.qty ? next.qty : f.baseQty;
  const basis = next.qty > 0n ? mulDiv(next.costE8, sold, next.qty) : 0n;
  next.realisedE8 += quoteE8 - basis;
  next.costE8 -= basis;
  next.qty -= sold;
  // FIFO lots first
  let rem = f.baseQty;
  const px = f.baseQty > 0n ? mulDiv(quoteE8, 10n ** BigInt(d), f.baseQty) : 0n;
  for (const l of next.lots) {
    if (rem === 0n) break;
    const r = BigInt(l.qtyRemaining);
    if (r === 0n) continue;
    const take = rem < r ? rem : r;
    const pnl = ((px - BigInt(l.entryPrice)) * take) / 10n ** BigInt(d);
    l.qtyRemaining = (r - take).toString();
    l.realisedUsd = fmtE8(parseE8(l.realisedUsd) + pnl);
    next.lotsRealisedE8 += pnl;
    if (r - take === 0n) l.closedAt = f.at;
    rem -= take;
  }
  return next;
}

export function avgEntryE8(b: Book, d: number): bigint | null {
  return b.qty > 0n ? mulDiv(b.costE8, 10n ** BigInt(d), b.qty) : null;
}

export function fmtE8(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 100_000_000n;
  const frac = (a % 100_000_000n).toString().padStart(8, "0").slice(0, 2);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function parseE8(s: string): bigint {
  const neg = s.startsWith("-");
  const [w, f = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(w || "0") * 100_000_000n + BigInt((f + "00000000").slice(0, 8));
  return neg ? -v : v;
}

/** Unrealised vs a mark (8 dp). Returns USD e8 and bps of cost. */
export function unrealised(b: Book, markE8: bigint | null, d: number): { usdE8: bigint; bps: number } {
  if (!markE8 || b.qty === 0n || b.costE8 === 0n) return { usdE8: 0n, bps: 0 };
  const value = mulDiv(b.qty, markE8, 10n ** BigInt(d));
  const u = value - b.costE8;
  return { usdE8: u, bps: Number((u * 10_000n) / b.costE8) };
}
