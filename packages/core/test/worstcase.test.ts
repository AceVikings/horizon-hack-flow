import { describe, expect, it } from "vitest";
import { worstCase, worstCaseVault } from "../src/worstcase.js";

const DEF = { maxEpochUsdE8: 250_00000000n, maxSlippageBps: 250, maxOracleDeviationBps: 250, maxExitDiscountBps: 500 };

describe("worstCase (SPEC §4.6)", () => {
  it("defaults: $25.75 per vault, $51.50 portfolio, $103 rolling 24 h, $26.50 normal path", () => {
    const v = worstCaseVault(DEF);
    expect(v.totalBps).toBe(1030);
    expect(v.maxLossUsdE8).toBe(25_75000000n);
    const w = worstCase([DEF, DEF]);
    expect(w.maxLossUsdE8).toBe(51_50000000n);
    expect(w.rolling24hUsdE8).toBe(103_00000000n);
    expect(w.normalLossUsdE8).toBe(26_50000000n);
  });
  it("A never drops below the 250 bps oracle assumption", () => {
    expect(worstCaseVault({ ...DEF, maxOracleDeviationBps: 100 }).oracleBps).toBe(250);
    expect(worstCaseVault({ ...DEF, maxOracleDeviationBps: 400 }).oracleBps).toBe(400);
  });
});
