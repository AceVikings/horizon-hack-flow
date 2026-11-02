import { describe, expect, it } from "vitest";
import {
  BPS,
  MAX_TICK,
  MIN_TICK,
  Q96,
  ReasonCode,
  checkMirror,
  deviationBps,
  epochOf,
  exitPathAllowed,
  expectedOut,
  exposureBuyAddend,
  exposureUsd,
  formatUnits,
  getSqrtPriceAtTick,
  minOutFloor,
  mulDiv,
  mulDivUp,
  notionalUsd,
  parseUnits,
  poolPriceFromSqrtPriceX96,
  scaleFor,
  sellAmountForUsdCap,
  twapTick,
  usdToE8,
  validateLimits,
  type Limits,
  type VaultCheckState,
  type Address,
} from "../src/index.js";
import { sqrtPriceX96FromPrice } from "../src/fixtures.js";

describe("mulDiv / mulDivUp", () => {
  it("rounds down / up", () => {
    expect(mulDiv(7n, 3n, 2n)).toBe(10n);
    expect(mulDivUp(7n, 3n, 2n)).toBe(11n);
    expect(mulDivUp(6n, 3n, 2n)).toBe(9n);
    expect(mulDivUp(0n, 3n, 2n)).toBe(0n);
  });
  it("handles 512-bit intermediates", () => {
    const max = (1n << 256n) - 1n;
    expect(mulDiv(max, max, max)).toBe(max);
    expect(mulDivUp(max, 2n, 4n)).toBe((max + 1n) / 2n);
  });
  it("rejects zero divisor and negatives", () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow();
    expect(() => mulDivUp(-1n, 1n, 1n)).toThrow();
  });
});

describe("SCALE", () => {
  it("is 1e20 for 18 dp and 1e10 for 8 dp", () => {
    expect(scaleFor(18)).toBe(10n ** 20n);
    expect(scaleFor(8)).toBe(10n ** 10n);
  });
});

describe("§4.2 worked check — WBTC (d = 8)", () => {
  const P = 7_792_502_000_000n; // 77,925.02
  it("$25 buy expects 32,083 sats-units", () => {
    expect(notionalUsd("buy", 25_000_000n, P, 8)).toBe(2_500_000_000n);
    expect(expectedOut("buy", 25_000_000n, P, 8)).toBe(32_083n);
  });
  it("selling 32,083 back has notional ≈ 25.0e8 (rounded up)", () => {
    const n = notionalUsd("sell", 32_083n, P, 8);
    expect(n).toBe(mulDivUp(32_083n, P, 10n ** 8n));
    expect(Number(n) / 1e8).toBeCloseTo(25.0, 2);
  });
  it("pool price from sqrtPriceX96 ≈ 77,144.61", () => {
    const sqrtP = BigInt(Math.round(Math.sqrt(771.4461) * 2 ** 48)) * (1n << 48n);
    const S = poolPriceFromSqrtPriceX96(sqrtP, 8);
    expect(Number(S) / 1e8).toBeCloseTo(77_144.61, 0);
  });
});

describe("§4.2 units — WHSK (d = 18)", () => {
  const P = 8_800_000n; // $0.088
  it("buy expectedOut and notional", () => {
    expect(notionalUsd("buy", 5_000_000n, P, 18)).toBe(500_000_000n);
    // 5 USDT / 0.088 = 56.8181… WHSK, rounded up in wei
    expect(expectedOut("buy", 5_000_000n, P, 18)).toBe(mulDivUp(5_000_000n, 10n ** 20n, P));
    expect(Number(expectedOut("buy", 5_000_000n, P, 18)) / 1e18).toBeCloseTo(56.8181818, 6);
  });
  it("sell expectedOut in USDT units", () => {
    const out = expectedOut("sell", 10n ** 20n, P, 18); // 100 WHSK → 8.8 USDT
    expect(out).toBe(8_800_000n);
  });
  it("round-trips a price through sqrtPriceX96", () => {
    for (const [p, d] of [
      [8_800_000n, 18],
      [7_792_502_000_000n, 8],
    ] as const) {
      const s = sqrtPriceX96FromPrice(p, d);
      const back = poolPriceFromSqrtPriceX96(s, d);
      expect(Number(absRel(back, p))).toBeLessThan(1e-6);
    }
  });
});

function absRel(a: bigint, b: bigint): number {
  return Math.abs(Number(a - b)) / Number(b);
}

describe("minOutFloor", () => {
  it("applies fee and slippage, rounding up", () => {
    // 32,083 × 0.997 × 0.975 = 31,187.08… → 31,188 (rounds up)
    expect(minOutFloor(32_083n, 3000, 250)).toBe(31_188n);
    expect(minOutFloor(10_000_000_000n, 0, 0)).toBe(10_000_000_000n);
  });
});

describe("deviation / exposure / exit path", () => {
  it("deviationBps rounds up", () => {
    expect(deviationBps(101n, 100n)).toBe(100n);
    expect(deviationBps(100_001n, 100_000n)).toBe(1n);
    expect(deviationBps(99n, 100n)).toBe(100n);
  });
  it("exposureUsd rounds up for both shapes", () => {
    expect(exposureUsd(32_083n, 7_792_502_000_000n, 8)).toBe(mulDivUp(32_083n, 7_792_502_000_000n, 10n ** 8n));
    expect(exposureUsd(10n ** 18n, 8_800_000n, 18)).toBe(8_800_000n);
    expect(exposureUsd(1n, 8_800_000n, 18)).toBe(1n);
  });
  it("buy exposure addend grosses up by the deviation bound", () => {
    expect(exposureBuyAddend(2_500_000_000n, 250)).toBe(mulDivUp(2_500_000_000n, BPS, 9_750n));
  });
  it("exit path admission boundary", () => {
    const P = 100_000_000n;
    expect(exitPathAllowed(95_000_000n, P, 500)).toBe(true);
    expect(exitPathAllowed(94_999_999n, P, 500)).toBe(false);
  });
});

describe("TickMath.getSqrtPriceAtTick", () => {
  it("matches the canonical endpoints", () => {
    expect(getSqrtPriceAtTick(0)).toBe(Q96);
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(4295128739n);
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(1461446703485210103287273052203988822378723970342n);
  });
  it("tracks 1.0001^(t/2) for every bit", () => {
    const ticks = [1, -1, 2, 3, 7, 50, 100, 1000, -1000, 4095, 65535, -65535, 200000, -300630, 300000, -887000, 524288, 887271];
    for (const t of ticks) {
      const got = Number(getSqrtPriceAtTick(t)) / 2 ** 96;
      const want = Math.exp((t / 2) * Math.log(1.0001));
      expect(Math.abs(got - want) / want).toBeLessThan(1e-9);
    }
  });
  it("rejects out-of-range ticks", () => {
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow();
  });
});

describe("twapTick rounds toward −∞", () => {
  it("positive and negative", () => {
    expect(twapTick(0n, 3000n)).toBe(10);
    expect(twapTick(0n, 3001n)).toBe(10);
    expect(twapTick(0n, -3000n)).toBe(-10);
    expect(twapTick(0n, -3001n)).toBe(-11);
  });
});

describe("epochs and limits", () => {
  it("aligned windows", () => {
    expect(epochOf(86_400n * 5n + 10n, 86_400)).toEqual({ index: 5n, start: 432_000n });
  });
  it("validateLimits bounds", () => {
    const ok: Limits = baseLimits();
    expect(validateLimits(ok)).toBe(0);
    expect(validateLimits({ ...ok, maxSlippageBps: 1001 })).toBe(5);
    expect(validateLimits({ ...ok, maxExitDiscountBps: 200 })).toBe(7);
    expect(validateLimits({ ...ok, maxExitDiscountBps: 2001 })).toBe(7);
    expect(validateLimits({ ...ok, maxOracleAge: 299 })).toBe(8);
    expect(validateLimits({ ...ok, epochDuration: 0 })).toBe(4);
  });
});

describe("decimal helpers", () => {
  it("parse/format units", () => {
    expect(usdToE8("25")).toBe(2_500_000_000n);
    expect(usdToE8("0.10")).toBe(10_000_000n);
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(() => parseUnits("1.1234567", 6)).toThrow();
    expect(formatUnits(2_500_000_000n, 8)).toBe("25");
    expect(formatUnits(-150n, 2)).toBe("-1.5");
  });
  it("sell amount for a USD cap uses max(P, T) and 0.99", () => {
    const amt = sellAmountForUsdCap(2_500_000_000n, 7_792_502_000_000n, 7_800_000_000_000n, 8);
    expect(amt).toBe(mulDiv(mulDiv(2_500_000_000n, 10n ** 8n, 7_800_000_000_000n), 99n, 100n));
    expect(notionalUsd("sell", amt, 7_800_000_000_000n, 8) <= 2_500_000_000n).toBe(true);
  });
});

// ------------------------------------------------------------------ check() mirror

const AGENT = "0x1111111111111111111111111111111111111111" as Address;
const USDT = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as Address;
const WBTC = "0x6119ca49a79f5825c8b345f8d7ac36b272565b14" as Address;
const NOW = 1_793_588_400n;

function baseLimits(): Limits {
  return {
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
}

function tickNear(priceE8: bigint, d: 8 | 18): number {
  const raw = Number(priceE8) / Number(scaleFor(d));
  return Math.floor(Math.log(raw) / Math.log(1.0001));
}

function wbtcState(over: Partial<VaultCheckState> = {}): VaultCheckState {
  const P = 7_792_502_000_000n;
  return {
    paused: false,
    agent: AGENT,
    quoteToken: USDT,
    priceToken: WBTC,
    priceDecimals: 8,
    feePips: 3000,
    limits: baseLimits(),
    now: NOW,
    oracle: { answer: P, updatedAt: NOW - 3600n },
    spotSqrtPriceX96: sqrtPriceX96FromPrice(7_714_461_000_000n, 8), // −100 bps
    twapTick: tickNear(7_716_000_000_000n, 8),
    epochIndex: NOW / 86_400n,
    epochSpentUsd: 0n,
    lastTradeAt: 0n,
    balanceQuote: 100_000_000n,
    balancePrice: 0n,
    ...over,
  };
}

const BIG = 10n ** 30n; // passes the slippage step unless a test sets minAmountOut
const buy = (amountIn: bigint, minAmountOut = BIG) => ({
  tokenIn: USDT,
  amountIn,
  minAmountOut,
  deadline: NOW + 60n,
  proposalId: `0x${"11".repeat(32)}` as `0x${string}`,
});
const sell = (amountIn: bigint, minAmountOut = BIG) => ({ ...buy(amountIn, minAmountOut), tokenIn: WBTC });

describe("checkMirror (both shapes, every reason code)", () => {
  it("OK buy with floor equal to the formula", () => {
    const s = wbtcState();
    const floor = minOutFloor(expectedOut("buy", 25_000_000n, s.oracle.answer, 8), 3000, 250);
    const r = checkMirror(s, AGENT, buy(25_000_000n, floor));
    expect(r).toEqual({ reason: ReasonCode.OK, notionalUsd: 2_500_000_000n, oraclePrice: s.oracle.answer, minOutFloor: floor, exitPath: false });
  });
  it("1–5", () => {
    expect(checkMirror(wbtcState({ paused: true }), AGENT, buy(1n)).reason).toBe(ReasonCode.ERR_PAUSED);
    expect(checkMirror(wbtcState(), USDT, buy(1n)).reason).toBe(ReasonCode.ERR_NOT_AGENT);
    expect(checkMirror(wbtcState(), AGENT, buy(0n)).reason).toBe(ReasonCode.ERR_ZERO_AMOUNT);
    expect(checkMirror(wbtcState(), AGENT, { ...buy(1n), deadline: NOW - 1n }).reason).toBe(ReasonCode.ERR_DEADLINE);
    expect(checkMirror(wbtcState(), AGENT, { ...buy(1n), tokenIn: AGENT }).reason).toBe(ReasonCode.ERR_PAIR_NOT_ALLOWED);
  });
  it("6–7 oracle", () => {
    expect(checkMirror(wbtcState({ oracle: { answer: 0n, updatedAt: NOW } }), AGENT, buy(1n)).reason).toBe(ReasonCode.ERR_ORACLE_INVALID);
    expect(checkMirror(wbtcState({ oracle: { reverted: true, answer: 1n, updatedAt: NOW } }), AGENT, buy(1n)).reason).toBe(ReasonCode.ERR_ORACLE_INVALID);
    expect(checkMirror(wbtcState({ oracle: { answer: 1n, updatedAt: NOW + 1n } }), AGENT, buy(1n)).reason).toBe(ReasonCode.ERR_ORACLE_INVALID);
    expect(checkMirror(wbtcState({ oracle: { answer: 7_792_502_000_000n, updatedAt: NOW - 90_001n } }), AGENT, buy(1n)).reason).toBe(ReasonCode.ERR_ORACLE_STALE);
  });
  it("8 deviation blocks buys; observe() revert blocks sells", () => {
    const far = wbtcState({ spotSqrtPriceX96: sqrtPriceX96FromPrice(7_500_000_000_000n, 8) });
    expect(checkMirror(far, AGENT, buy(25_000_000n)).reason).toBe(ReasonCode.ERR_ORACLE_DEVIATION);
    expect(checkMirror(wbtcState({ twapTick: null, balancePrice: 32_083n }), AGENT, sell(32_083n)).reason).toBe(ReasonCode.ERR_ORACLE_DEVIATION);
  });
  it("7b exit path: T < P floors at T; T far below → ERR_EXIT_PRICE", () => {
    const T = 7_500_000_000_000n; // −3.75% vs P, within 5% exit discount
    const s = wbtcState({ spotSqrtPriceX96: sqrtPriceX96FromPrice(7_400_000_000_000n, 8), twapTick: tickNear(T, 8), balancePrice: 32_083n });
    const r = checkMirror(s, AGENT, sell(30_000n));
    expect(r.reason).toBe(ReasonCode.OK);
    expect(r.exitPath).toBe(true);
    expect(r.minOutFloor < minOutFloor(expectedOut("sell", 30_000n, s.oracle.answer, 8), 3000, 250)).toBe(true);
    const s2 = wbtcState({ spotSqrtPriceX96: sqrtPriceX96FromPrice(7_000_000_000_000n, 8), twapTick: tickNear(7_000_000_000_000n, 8), balancePrice: 32_083n });
    expect(checkMirror(s2, AGENT, sell(30_000n)).reason).toBe(ReasonCode.ERR_EXIT_PRICE);
  });
  it("7b exit path: T > P floors at P and caps notional at T", () => {
    const T = 8_100_000_000_000n; // +3.9% vs P
    const s = wbtcState({ spotSqrtPriceX96: sqrtPriceX96FromPrice(8_100_000_000_000n, 8), twapTick: tickNear(T, 8), balancePrice: 32_083n });
    const r = checkMirror(s, AGENT, sell(30_000n));
    expect(r.exitPath).toBe(true);
    expect(r.minOutFloor).toBe(minOutFloor(expectedOut("sell", 30_000n, s.oracle.answer, 8), 3000, 250));
    expect(r.notionalUsd > notionalUsd("sell", 30_000n, s.oracle.answer, 8)).toBe(true);
  });
  it("9–14", () => {
    expect(checkMirror(wbtcState(), AGENT, buy(25_000_001n)).reason).toBe(ReasonCode.ERR_TRADE_CAP);
    expect(checkMirror(wbtcState({ epochSpentUsd: 23_000_000_000n }), AGENT, buy(25_000_000n)).reason).toBe(ReasonCode.ERR_EPOCH_CAP);
    expect(checkMirror(wbtcState({ epochSpentUsd: 23_000_000_000n, epochIndex: 1n }), AGENT, buy(25_000_000n)).reason).toBe(ReasonCode.OK); // rolled over
    expect(checkMirror(wbtcState({ lastTradeAt: NOW - 10n }), AGENT, buy(25_000_000n)).reason).toBe(ReasonCode.ERR_COOLDOWN);
    const floor = checkMirror(wbtcState(), AGENT, buy(25_000_000n)).minOutFloor;
    expect(checkMirror(wbtcState(), AGENT, buy(25_000_000n, floor - 1n)).reason).toBe(ReasonCode.ERR_SLIPPAGE);
    expect(checkMirror(wbtcState({ balanceQuote: 1n }), AGENT, buy(25_000_000n, floor)).reason).toBe(ReasonCode.ERR_BALANCE);
    expect(checkMirror(wbtcState({ balancePrice: 160_000n }), AGENT, buy(25_000_000n, floor)).reason).toBe(ReasonCode.ERR_EXPOSURE);
  });
  it("sells are never blocked by exposure; 18-dp shape works", () => {
    expect(checkMirror(wbtcState({ balancePrice: 10_000_000n }), AGENT, sell(30_000n)).reason).toBe(ReasonCode.OK);
    const WHSK = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1" as Address;
    const P = 8_800_000n;
    const s: VaultCheckState = {
      ...wbtcState(),
      priceToken: WHSK,
      priceDecimals: 18,
      oracle: { answer: P, updatedAt: NOW - 60n },
      spotSqrtPriceX96: sqrtPriceX96FromPrice(8_790_000n, 18),
      twapTick: tickNear(8_792_000n, 18),
    };
    expect(checkMirror(s, AGENT, buy(5_000_000n, 0n)).reason).toBe(ReasonCode.ERR_SLIPPAGE);
    const r = checkMirror(s, AGENT, buy(5_000_000n));
    expect(r.reason).toBe(ReasonCode.OK);
    expect(r.minOutFloor).toBe(minOutFloor(mulDivUp(5_000_000n, 10n ** 20n, P), 3000, 250));
  });
});
