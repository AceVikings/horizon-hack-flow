import { describe, expect, it } from "vitest";
import type { ChartSpec } from "@ate/core";
import { lowerPaneHeight, staleNote, tooThin } from "../src/renderer/src/charts/Chart";

const now = 1_793_100_000;
const spec = (lastT: number, kind: ChartSpec["kind"] = "price", name = "HSKSwap BTC/USDT pool Swap logs"): Pick<ChartSpec, "sources" | "interval" | "kind" | "x"> => ({
  kind,
  interval: "1h",
  x: { type: "time" },
  sources: [{ name, firstT: lastT - 86_400, lastT, fetchedAt: now }],
});

describe("chart view helpers", () => {
  it("says the pool is quiet when the newest swap is old, not when it is fresh", () => {
    expect(staleNote(spec(now - 26.5 * 3600), now)).toBe("No swaps in the last 26 h, price unchanged.");
    expect(staleNote(spec(now - 4 * 86_400, "volume"), now)).toBe("No swaps in the last 4 days.");
    expect(staleNote(spec(now - 300), now)).toBeNull();
    // exchange klines and other sources are not pool swaps
    expect(staleNote(spec(now - 26 * 3600, "cex", "HashKey Global BTCUSDT klines"), now)).toBeNull();
  });
  it("keeps indicators without enough points off the chart", () => {
    expect(tooThin({ id: "ema50", label: "EMA 50", type: "line", unit: "usd", pane: 0, indicator: "ema50", points: [] })).toBe(true);
    expect(tooThin({ id: "rsi14", label: "RSI 14", type: "line", unit: "index", pane: 1, indicator: "rsi14", points: [{ t: 1, v: 50 }, { t: 2, v: 51 }] })).toBe(false);
    expect(tooThin({ id: "p", label: "Price", type: "line", unit: "usd", pane: 0, points: [] })).toBe(false);
  });
  it("gives the indicator pane about 30% and at least 96 px", () => {
    expect(lowerPaneHeight(220)).toBe(96);
    expect(lowerPaneHeight(400)).toBe(120);
  });
});
