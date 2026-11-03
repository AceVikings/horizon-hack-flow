import { describe, expect, it } from "vitest";
import { applyFill, avgEntryE8, emptyBook, seedBook, unrealised } from "../src/positions.js";

const M = "hsk-dex:WHSK/USDT:3000" as const;
describe("positions (avg cost + FIFO lots)", () => {
  it("average cost, realised on sell, FIFO lots", () => {
    let b = emptyBook();
    b = applyFill(b, { id: "f1", market: M, generator: "spread-revert", side: "buy", baseQty: 100n * 10n ** 18n, quoteQty: 10_000_000n, at: 1 }, 18); // $10 @ 0.10
    b = applyFill(b, { id: "f2", market: M, generator: "rebalance", side: "buy", baseQty: 100n * 10n ** 18n, quoteQty: 20_000_000n, at: 2 }, 18); // $20 @ 0.20
    expect(avgEntryE8(b, 18)).toBe(15_000_000n);
    expect(b.lots).toHaveLength(1);
    b = applyFill(b, { id: "f3", market: M, generator: "spread-revert", side: "sell", baseQty: 100n * 10n ** 18n, quoteQty: 25_000_000n, at: 3 }, 18); // sell 100 @ 0.25
    expect(b.realisedE8).toBe(1_000_000_000n); // 25 − 15
    expect(b.lots[0]!.qtyRemaining).toBe("0");
    expect(b.lotsRealisedE8).toBe(1_500_000_000n); // 25 − 10 (lot entry 0.10)
    expect(avgEntryE8(b, 18)).toBe(15_000_000n);
    expect(unrealised(b, 20_000_000n, 18).usdE8).toBe(500_000_000n);
  });
  it("selling tokens deposited after the seed (no recorded cost) is not counted as profit", () => {
    let b = applyFill(emptyBook(), { id: "f1", market: M, generator: "spread-revert", side: "buy", baseQty: 100n * 10n ** 18n, quoteQty: 10_000_000n, at: 1 }, 18); // $10 @ 0.10
    // the vault also got 575 WHSK by a deposit; the sale of all 675 @ 0.087 counts only the 100 the book knows
    b = applyFill(b, { id: "f2", market: M, generator: "guard", side: "sell", baseQty: 675n * 10n ** 18n, quoteQty: 58_725_000n, at: 2 }, 18);
    expect(b.realisedE8).toBe(-130_000_000n); // 100 × 0.087 − 10 = −1.30
    expect(b.qty).toBe(0n);
  });
  it("seed inventory enters at its basis", () => {
    const b = seedBook(10n ** 8n, 7_792_502_000_000n, 8);
    expect(avgEntryE8(b, 8)).toBe(7_792_502_000_000n);
  });
});
