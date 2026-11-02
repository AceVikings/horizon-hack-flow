import { decodeErrorResult, encodeErrorResult, encodeFunctionData, decodeFunctionResult, toFunctionSelector, type AbiFunction } from "viem";
import { describe, expect, it } from "vitest";
import {
  ATE_ERROR_CODES,
  ERROR_RETRYABLE,
  MARKET_IDS,
  MARKETS,
  REASON_NAMES,
  REASON_TO_CUSTOM_ERROR,
  ReasonCode,
  parseConfig,
  policyVaultAbi,
  reasonToError,
  toolsForScope,
  CHAT_TOOL_ALLOWLIST,
  decisionIdFromHash,
  fail,
  AteError,
} from "../src/index.js";
import { FIXTURE_CANDIDATES, FIXTURE_CONFIG, FIXTURE_MARKET_SNAPSHOTS, FIXTURE_PORTFOLIO } from "../src/fixtures.js";

describe("reason codes (§4.1)", () => {
  it("are exactly 0..15 in spec order", () => {
    expect(REASON_NAMES).toEqual([
      "OK",
      "ERR_PAUSED",
      "ERR_NOT_AGENT",
      "ERR_ZERO_AMOUNT",
      "ERR_DEADLINE",
      "ERR_PAIR_NOT_ALLOWED",
      "ERR_ORACLE_INVALID",
      "ERR_ORACLE_STALE",
      "ERR_ORACLE_DEVIATION",
      "ERR_TRADE_CAP",
      "ERR_EPOCH_CAP",
      "ERR_COOLDOWN",
      "ERR_SLIPPAGE",
      "ERR_BALANCE",
      "ERR_EXPOSURE",
      "ERR_EXIT_PRICE",
    ]);
    REASON_NAMES.forEach((n, i) => expect(ReasonCode[n]).toBe(i));
  });
  it("map to §7.6 error codes", () => {
    expect(reasonToError(0)).toBeNull();
    expect(reasonToError(13)).toBe("ATE_INSUFFICIENT_BALANCE");
    expect(reasonToError(15)).toBe("ATE_EXIT_PRICE");
    for (let i = 1; i <= 15; i++) expect(ATE_ERROR_CODES).toContain(reasonToError(i));
  });
  it("every reason has a custom error in the ABI", () => {
    const errs = new Set(policyVaultAbi.filter((x) => x.type === "error").map((x) => x.name));
    for (const name of Object.values(REASON_TO_CUSTOM_ERROR)) expect(errs.has(name as never)).toBe(true);
  });
});

describe("PolicyVault ABI is viem-compatible", () => {
  const p = {
    tokenIn: MARKETS["hsk-dex:WBTC/USDT:3000"].quoteToken,
    amountIn: 25_000_000n,
    minAmountOut: 31_000n,
    deadline: 1_793_588_460n,
    proposalId: `0x${"ab".repeat(32)}` as const,
  };
  it("encodes execute and check", () => {
    const data = encodeFunctionData({ abi: policyVaultAbi, functionName: "execute", args: [p, `0x${"cd".repeat(32)}`] });
    expect(data.slice(0, 10)).toBe(toFunctionSelector("execute((address,uint256,uint256,uint256,bytes32),bytes32)"));
    const c = encodeFunctionData({ abi: policyVaultAbi, functionName: "check", args: ["0x1111111111111111111111111111111111111111", p] });
    expect(c.slice(0, 10)).toBe(toFunctionSelector("check(address,(address,uint256,uint256,uint256,bytes32))"));
  });
  it("selector set matches IPolicyVault", () => {
    const sigs = policyVaultAbi
      .filter((x): x is Extract<(typeof policyVaultAbi)[number], { type: "function" }> => x.type === "function")
      .map((f) => `${f.name}(${(f as AbiFunction).inputs.map((i) => (i.type === "tuple" ? "tuple" : i.type)).join(",")})`);
    expect(sigs).toEqual(
      expect.arrayContaining([
        "setAgent(address)",
        "setGuardian(address)",
        "setLimits(tuple)",
        "unpause()",
        "withdraw(address,address,uint256)",
        "transferOwnership(address)",
        "acceptOwnership()",
        "pause()",
        "execute(tuple,bytes32)",
        "check(address,tuple)",
        "epoch()",
        "limits()",
        "exposureUsd()",
        "agent()",
        "guardian()",
        "owner()",
        "paused()",
        "quoteToken()",
        "priceToken()",
        "priceDecimals()",
        "oracle()",
        "router()",
        "pool()",
        "factory()",
      ]),
    );
  });
  it("decodes limits() into the Limits shape", () => {
    const limits = {
      maxTradeUsd: 2_500_000_000n,
      maxEpochUsd: 25_000_000_000n,
      maxExposureUsd: 15_000_000_000n,
      epochDuration: 86_400,
      maxSlippageBps: 250,
      maxOracleDeviationBps: 250,
      maxExitDiscountBps: 500,
      maxOracleAge: 90_000,
      cooldown: 60,
    };
    const set = encodeFunctionData({ abi: policyVaultAbi, functionName: "setLimits", args: [limits] });
    expect(set.length).toBeGreaterThan(10);
  });
  it("round-trips custom errors with context", () => {
    const enc = encodeErrorResult({ abi: policyVaultAbi, errorName: "TradeCap", args: [2_600_000_000n, 2_500_000_000n] });
    const dec = decodeErrorResult({ abi: policyVaultAbi, data: enc });
    expect(dec.errorName).toBe("TradeCap");
    expect(dec.args).toEqual([2_600_000_000n, 2_500_000_000n]);
  });
  it("decodes check() outputs", () => {
    const fn = policyVaultAbi.find((x) => x.type === "function" && x.name === "check")!;
    expect((fn as AbiFunction).outputs.map((o) => o.name)).toEqual(["reason", "notionalUsd", "oraclePrice", "minOutFloor", "exitPath"]);
    expect(typeof decodeFunctionResult).toBe("function");
  });
  it("events per §4.3", () => {
    const ev = policyVaultAbi.filter((x) => x.type === "event").map((x) => x.name);
    expect(ev).toEqual([
      "TradeExecuted",
      "LimitsUpdated",
      "AgentUpdated",
      "GuardianUpdated",
      "Paused",
      "Unpaused",
      "Withdrawn",
      "OwnershipTransferStarted",
      "OwnershipTransferred",
    ]);
  });
});

describe("errors and envelope", () => {
  it("retryable table covers every code", () => {
    for (const c of ATE_ERROR_CODES) expect(typeof ERROR_RETRYABLE[c]).toBe("boolean");
  });
  it("fail() fills retryable", () => {
    expect(fail("ATE_POLICY_EPOCH_CAP", "x", "wait")).toEqual({ ok: false, error: { code: "ATE_POLICY_EPOCH_CAP", message: "x", hint: "wait", retryable: true } });
    const e = new AteError("StrategyError", "ATE_STRATEGY_BLOCKED", "blocked", { hint: "h" });
    expect(e.toToolError()).toEqual({ code: "ATE_STRATEGY_BLOCKED", message: "blocked", hint: "h", retryable: true });
  });
});

describe("tools / scopes", () => {
  it("chat scope sees only the §11.5 allowlist", () => {
    expect(toolsForScope("chat", { hsp: true })).toEqual([...CHAT_TOOL_ALLOWLIST]);
    expect(toolsForScope("chat", { hsp: true })).not.toContain("ate_execute");
    expect(toolsForScope("agent", { hsp: false })).not.toContain("ate_signal_buy");
    expect(toolsForScope("agent", { hsp: true })).toHaveLength(15); // + ate_chart, ate_data (lane D4, read-only), ate_backtest (lane STRAT)
  });
});

describe("journal ids", () => {
  it("prefix + hash[2:18]", () => {
    const h = `0x${"0123456789abcdef".repeat(4)}`;
    expect(decisionIdFromHash("proposal", h)).toBe("prop_0123456789abcdef");
    expect(decisionIdFromHash("no_trade", h)).toBe("dec_0123456789abcdef");
  });
});

describe("config (§16)", () => {
  it("fixture parses", () => {
    expect(parseConfig(FIXTURE_CONFIG).vaults).toHaveLength(2);
  });
  it("rejects unknown keys", () => {
    expect(() => parseConfig({ ...FIXTURE_CONFIG, extra: 1 })).toThrow(/ATE|invalid config/);
  });
  it("rejects demo profile on WBTC", () => {
    const bad = structuredClone(FIXTURE_CONFIG);
    bad.strategy.markets["hsk-dex:WBTC/USDT:3000"].profile = "demo";
    expect(() => parseConfig(bad)).toThrow(/demo profile/);
  });
  it("rejects a non-SwapRouter02 routerKind", () => {
    const bad = structuredClone(FIXTURE_CONFIG) as unknown as { venues: { hskdex: { routerKind: string } } };
    bad.venues.hskdex.routerKind = "swaprouter";
    expect(() => parseConfig(bad)).toThrow();
  });
});

describe("fixtures", () => {
  it("cover both markets", () => {
    expect(Object.keys(FIXTURE_MARKET_SNAPSHOTS).sort()).toEqual([...MARKET_IDS].sort());
    expect(Object.keys(FIXTURE_PORTFOLIO.markets).sort()).toEqual([...MARKET_IDS].sort());
    for (const c of FIXTURE_CANDIDATES) expect(c.candidateId).toMatch(/^cand_[0-9a-f]{16}$/);
  });
});
