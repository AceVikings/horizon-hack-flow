import { encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { policyVaultAbi } from "@ate/core";
import { FULL_RUN, STAGE_RUN, decodeRevert, resolveMarket } from "../src/commands/a/_rogue.js";

describe("ate rogue helpers", () => {
  it("market aliases and attack lists (§22.3)", () => {
    expect(resolveMarket("HSK")).toBe("hsk-dex:WHSK/USDT:3000");
    expect(resolveMarket("wbtc")).toBe("hsk-dex:WBTC/USDT:3000");
    expect(STAGE_RUN).toEqual(["slippage", "withdraw"]);
    expect(FULL_RUN).toHaveLength(7);
  });
  it("decodes the vault's custom errors from a nested viem error", () => {
    const data = encodeErrorResult({ abi: policyVaultAbi, errorName: "Slippage", args: [1n, 55n] } as never);
    expect(decodeRevert({ message: "reverted", cause: { data } })).toBe("Slippage(1, 55)");
  });
});
