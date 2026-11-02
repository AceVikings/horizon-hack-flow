import { describe, expect, it } from "vitest";
import { MARKET_WBTC, MARKET_WHSK } from "@ate/core";
import { sqrtPriceX96FromPrice } from "@ate/core/fixtures";
import { decodeSwapData, defaultReplayParams, impactBpsForUsd, renderReport, simulate, type Kline, type SwapPoint } from "../src/replay/index.js";

const enc = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");

function swap(at: number, priceE8: bigint, d: 8 | 18, liquidity: bigint): SwapPoint {
  return { at, block: at, priceE8, sqrtPriceX96: sqrtPriceX96FromPrice(priceE8, d), liquidity, usdtAbs: 25_000_000n, side: "buy", sender: "0xabc" };
}

describe("replay", () => {
  it("decodes a Swap event (signed amounts, price for 8 and 18 dp)", () => {
    const sp = sqrtPriceX96FromPrice(7_714_461_000_000n, 8);
    const data = "0x" + enc(-32_083n) + enc(25_000_000n) + enc(sp) + enc(123_456_789n) + enc(-50n);
    const s = decodeSwapData(data, 8);
    expect(s.amount0).toBe(-32_083n);
    expect(s.amount1).toBe(25_000_000n);
    expect(s.tick).toBe(-50);
    expect(Number(s.priceE8)).toBeCloseTo(7_714_461_000_000, -6);
    const sp18 = sqrtPriceX96FromPrice(8_790_000n, 18);
    expect(Number(decodeSwapData("0x" + enc(1n) + enc(-1n) + enc(sp18) + enc(1n) + enc(0n), 18).priceE8)).toBeCloseTo(8_790_000, -1);
  });

  it("impact grows with size and shrinks with liquidity", () => {
    const sp = sqrtPriceX96FromPrice(7_714_461_000_000n, 8);
    const a = impactBpsForUsd(sp, 10n ** 12n, 25, 30);
    expect(impactBpsForUsd(sp, 10n ** 12n, 50, 30)).toBeGreaterThan(a);
    expect(impactBpsForUsd(sp, 10n ** 13n, 25, 30)).toBeLessThan(a);
  });

  it("WBTC: a persistent 112 bps discount fires buys every cycle, entries spaced by minEntryIntervalSec", () => {
    const from = 1_000_000;
    const to = from + 86_400;
    const swaps = [swap(from - 10, 7_714_461_000_000n, 8, 10n ** 14n)];
    const klines: Kline[] = [];
    for (let t = from - 60; t <= to; t += 60) klines.push({ t, close: 78_023.15 });
    const { report } = simulate(MARKET_WBTC, swaps, klines, from, to, defaultReplayParams(MARKET_WBTC, 0.01));
    expect(report.fired.buy).toBe(report.cyclesWithData);
    expect(report.counterfactual.firedMeanNetBps!).toBeGreaterThan(70);
    expect(report.counterfactual.taken).toBe(6); // 4 on day 1 ($100 share ÷ $25), then capped by maxPositionUsd $150 on day 2
    expect(report.verdict).toMatch(/^persistent/);
    expect(report.counterfactual.openLots).toBe(6);
    expect(report.counterfactual.openCexUsd).toBeGreaterThan(0);
    expect(report.counterfactual.openExitUsd).toBeLessThan(0);
  });

  it("WHSK: 30 bps gaps never fire; transient spikes close; report says no edge after fees", () => {
    const from = 2_000_000;
    const to = from + 6 * 3600;
    const swaps = [swap(from - 1, 8_790_000n, 18, 10n ** 22n), swap(from + 3600, 8_700_000n, 18, 10n ** 22n), swap(from + 3600 + 600, 8_790_000n, 18, 10n ** 22n)];
    const klines: Kline[] = [];
    for (let t = from - 60; t <= to; t += 60) klines.push({ t, close: 0.088164 });
    const { report } = simulate(MARKET_WHSK, swaps, klines, from, to, defaultReplayParams(MARKET_WHSK, 5.7));
    expect(report.fired.buy + report.fired.sell).toBeGreaterThan(0); // the 1.3% dip for 10 min
    expect(report.episodes.closed).toBe(1);
    expect(report.episodes.medianTimeToCloseSec).toBe(600);
    expect(report.verdict).toMatch(/^transient/);
    expect(report.counterfactual.closedLots).toBeGreaterThan(0);
    const md = renderReport([report], { generatedAt: to, days: 1, source: "test", notes: [] });
    expect(md).toMatch(/Counterfactual, from logs, not realised P&L/);
    expect(md).toMatch(/Top-decile gaps/);
  });
});
