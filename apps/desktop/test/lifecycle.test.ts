import { describe, expect, it } from "vitest";
import { findStrategyCode } from "../src/main/lifecycle";

describe("findStrategyCode", () => {
  const now = 1_000_000;
  const codes = [
    { code: "11111111", line: "ATE approval code for UI attach (nonce abcd…): 11111111 (single use, 60 s)", at: now - 5 },
    { code: "22222222", line: "ATE approval code for strategy change chg_1: WHSK stopLossBps 300 → 500: 22222222 (single use, 60 s)", at: now - 10 },
    { code: "33333333", line: "ATE approval code for strategy change chg_2: x: 33333333 (single use, 60 s)", at: now - 120 },
  ];
  it("returns the code issued for that change", () => {
    expect(findStrategyCode(codes, "chg_1", now)).toEqual({ code: "22222222", expiresAt: now + 50 });
  });
  it("ignores other purposes, other changes and expired codes", () => {
    expect(findStrategyCode(codes, "chg_9", now)).toBeNull();
    expect(findStrategyCode(codes, "chg_2", now)).toBeNull();
    expect(findStrategyCode(codes, "abcd", now)).toBeNull();
  });
});
