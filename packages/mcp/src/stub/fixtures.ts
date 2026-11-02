// Canned, type-checked tool outputs for both markets (Lanes C/D develop against these until 08:00).

import {
  MARKETS,
  MARKET_IDS,
  MARKET_WBTC,
  MARKET_WHSK,
  tokenInFor,
  type Decision,
  type JournalEntry,
  type MarketId,
  type MarketPosition,
  type MarketView,
  type PositionsOutput,
  type Quote,
  type StrategyGetOutput,
} from "@ate/core";
import {
  FIXTURE_BLOCK,
  FIXTURE_CANDIDATES,
  FIXTURE_MARKET_SNAPSHOTS,
  FIXTURE_NOW,
  FIXTURE_PRICES,
  FIXTURE_STRATEGY,
  FIXTURE_VAULT_STATES,
} from "@ate/core/fixtures";

export { FIXTURE_BLOCK, FIXTURE_CANDIDATES, FIXTURE_NOW, FIXTURE_STRATEGY };

export const STUB_MARKETS: Record<MarketId, MarketView> = {
  "hsk-dex:WHSK/USDT:3000": {
    ...FIXTURE_PRICES[MARKET_WHSK],
    vault: FIXTURE_VAULT_STATES[MARKET_WHSK],
    exitMark: FIXTURE_MARKET_SNAPSHOTS[MARKET_WHSK].exitMark,
    recentPoolSwaps: [
      { txHash: `0x${"a1".repeat(32)}`, side: "buy", amountUsd: "112.40", sender: "0x1127000000000000000000000000000000001127", at: FIXTURE_NOW - 240 },
    ],
  },
  "hsk-dex:WBTC/USDT:3000": {
    ...FIXTURE_PRICES[MARKET_WBTC],
    vault: FIXTURE_VAULT_STATES[MARKET_WBTC],
    exitMark: FIXTURE_MARKET_SNAPSHOTS[MARKET_WBTC].exitMark,
    recentPoolSwaps: [],
  },
};

/** Deterministic quote: linear in amountIn at the fixture mid, 30 bps fee, small impact. */
export function stubQuote(market: MarketId, side: "buy" | "sell", amountIn: string): Quote {
  const m = MARKETS[market];
  const p = BigInt(FIXTURE_PRICES[market].pool.price);
  const scale = 10n ** BigInt(m.baseDecimals + 2);
  const a = BigInt(amountIn);
  const gross = side === "buy" ? (a * scale) / p : (a * p) / scale;
  const out = (gross * 9_965n) / 10_000n; // 30 bps fee + 5 bps impact
  const ti = tokenInFor(market, side);
  const outDec = side === "buy" ? m.baseDecimals : m.quoteDecimals;
  const outSym = side === "buy" ? m.base : m.quote;
  const floor = (gross * 9_721n) / 10_000n; // ≈ (1 − 0.3%) × (1 − 2.5%)
  const notional = side === "buy" ? a * 100n : (a * BigInt(FIXTURE_PRICES[market].oracle.price)) / 10n ** BigInt(m.baseDecimals);
  const human = (v: bigint, d: number) => (Number(v) / 10 ** d).toString();
  return {
    market,
    vault: FIXTURE_VAULT_STATES[market].address,
    side,
    tokenIn: ti.token,
    tokenOut: side === "buy" ? m.baseToken : m.quoteToken,
    decimals: ti.decimals,
    amountIn,
    amountInHuman: `${human(a, ti.decimals)} ${ti.symbol}`,
    amountOut: out.toString(),
    amountOutHuman: `${human(out, outDec)} ${outSym}`,
    impactBps: 5,
    source: "simulation",
    policy: {
      reason: notional > 2_500_000_000n ? 9 : 0,
      code: notional > 2_500_000_000n ? "ATE_POLICY_TRADE_CAP" : "OK",
      notionalUsdE8: notional.toString(),
      oraclePrice: FIXTURE_PRICES[market].oracle.price,
      minOutFloor: floor.toString(),
      exitPath: false,
    },
    minOutFloor: floor.toString(),
    exitPath: false,
    blockNumber: FIXTURE_BLOCK,
    at: FIXTURE_NOW,
  };
}

const epoch = { spentUsd: "5", capUsd: "250", remainingUsd: "245", resetsAt: (Math.floor(FIXTURE_NOW / 86_400) + 1) * 86_400 };

export const STUB_POSITIONS: PositionsOutput = {
  markets: [
    {
      market: MARKET_WHSK,
      vault: FIXTURE_VAULT_STATES[MARKET_WHSK].address,
      balanceQuote: FIXTURE_VAULT_STATES[MARKET_WHSK].balanceQuote,
      balancePrice: FIXTURE_VAULT_STATES[MARKET_WHSK].balancePrice,
      qty: FIXTURE_VAULT_STATES[MARKET_WHSK].balancePrice,
      exposureUsd: "36.96",
      avgEntry: "8800000",
      mark: "8735714",
      cexMid: FIXTURE_PRICES[MARKET_WHSK].cex!.mid,
      realisedUsd: "0",
      unrealisedExitUsd: "-0.27",
      unrealisedExitBps: -73,
      unrealisedCexUsd: "0.07",
      unrealisedCexBps: 19,
      feeDragUsd: "0.22",
      lots: [],
      lotsRealisedUsd: "0",
      epoch,
      exitReserveUsd: "37.91",
      turnoverRemainingUsd: "95",
      reentryLockUntil: null,
      paused: false,
    },
    {
      market: MARKET_WBTC,
      vault: FIXTURE_VAULT_STATES[MARKET_WBTC].address,
      balanceQuote: FIXTURE_VAULT_STATES[MARKET_WBTC].balanceQuote,
      balancePrice: FIXTURE_VAULT_STATES[MARKET_WBTC].balancePrice,
      qty: "32083",
      exposureUsd: "25.01",
      avgEntry: "7792255000000",
      mark: "7667000000000",
      cexMid: FIXTURE_PRICES[MARKET_WBTC].cex!.mid,
      realisedUsd: "0",
      unrealisedExitUsd: "-0.40",
      unrealisedExitBps: -161,
      unrealisedCexUsd: "0.03",
      unrealisedCexBps: 13,
      feeDragUsd: "0.08",
      lots: [
        {
          id: "lot_0001",
          market: MARKET_WBTC,
          openFillId: "fill_0001",
          qtyOpen: "32083",
          qtyRemaining: "32083",
          entryPrice: "7792255000000",
          realisedUsd: "0",
          openedAt: FIXTURE_NOW - 900,
          closedAt: null,
        },
      ],
      lotsRealisedUsd: "0",
      epoch: { ...epoch, spentUsd: "25", remainingUsd: "225" },
      exitReserveUsd: "25.65",
      turnoverRemainingUsd: "75",
      reentryLockUntil: null,
      paused: false,
    },
  ] satisfies MarketPosition[],
  portfolio: {
    exposureUsd: "61.97",
    maxPortfolioExposureUsd: "200",
    dailyPnlUsd: "-0.67",
    realisedUsd: "0",
    unrealisedExitUsd: "-0.67",
    unrealisedCexUsd: "0.10",
    turnoverUsedUsd: "30",
    turnoverRemainingUsd: "170",
    discretionaryUsedToday: 0,
    breaker: "armed",
  },
  scoreboard: { acts: 2, vetoes: 1, sizeDowns: 0, savedBps: 12, savedUsd: "0.03", discretionary: 0 },
  counters: { uptimeSec: 3_600, startedAt: FIXTURE_NOW - 3_600, cycles: 30, trades: 2, hskswapTrades: 2, routedUsd: "30" },
};

export const STUB_STRATEGY: StrategyGetOutput = {
  strategy: FIXTURE_STRATEGY,
  anchors: Object.fromEntries(
    MARKET_IDS.map((id) => {
      const m = FIXTURE_STRATEGY.markets[id];
      return [id, { entrySpreadBps: m.entrySpreadBps, minNetEdgeBps: m.minNetEdgeBps, tradeSizeUsd: m.tradeSizeUsd, cycleSeconds: m.cycleSeconds }];
    }),
  ) as StrategyGetOutput["anchors"],
  updatedAt: FIXTURE_NOW - 7_200,
};

const ctx = (market: MarketId): Decision["context"] => {
  const p = FIXTURE_PRICES[market];
  return {
    oracle: { price: p.oracle.price, updatedAt: p.oracle.updatedAt, roundId: p.oracle.roundId, ageSec: p.oracle.ageSec },
    pool: { price: p.pool.price, twap: p.pool.twap ?? "0", liquidity: p.pool.liquidity, deviationBps: p.pool.deviationBps, twapDeviationBps: p.pool.twapDeviationBps ?? 0 },
    cex: { mid: p.cex!.mid, halfSpreadBps: p.cex!.halfSpreadBps, topDepthUsd: p.cex!.topDepthUsd, at: p.cex!.at },
    policy: { maxTradeUsd: "25", epochRemainingUsd: "225", turnoverRemainingUsd: "75", cooldownRemainingSec: 0 },
    blockNumber: FIXTURE_BLOCK,
  };
};

export const STUB_JOURNAL: JournalEntry[] = [
  {
    seq: 3,
    id: "dec_5a1e0f9c3b7d2e48",
    hash: "0x5a1e0f9c3b7d2e48aa00000000000000000000000000000000000000000003",
    at: FIXTURE_NOW - 300,
    prevHash: "0x9c2b4f1d7e6a3c05bb00000000000000000000000000000000000000000002",
    kind: "no_trade",
    market: MARKET_WHSK,
    engine: "llm",
    profile: "default",
    actor: { kind: "agent", via: "mcp" },
    origin: "candidate",
    candidateId: "cand_3e9d1c7b5a2f4e60",
    rationale: "WHSK spread-revert candidate vetoed: CEX book 40 bps wide on the ask, spread likely stale.",
    rationaleHash: `0x${"5e".repeat(32)}`,
    context: ctx(MARKET_WHSK),
    verdict: { ok: true, code: "NO_TRADE" },
  },
  {
    seq: 2,
    id: "exec_9c2b4f1d7e6a3c05",
    hash: "0x9c2b4f1d7e6a3c05bb00000000000000000000000000000000000000000002",
    at: FIXTURE_NOW - 896,
    prevHash: "0x0b5e2c7a9d1f4e60cc00000000000000000000000000000000000000000001",
    kind: "execution",
    market: MARKET_WBTC,
    refId: "prop_0b5e2c7a9d1f4e60",
    engine: "llm",
    profile: "default",
    actor: { kind: "agent", via: "mcp" },
    origin: "candidate",
    candidateId: "cand_0b5e2c7a9d1f4e60",
    intent: { market: MARKET_WBTC, vault: FIXTURE_VAULT_STATES[MARKET_WBTC].address, side: "buy", tokenIn: MARKETS[MARKET_WBTC].quoteToken, amountIn: "25000000" },
    rationale: "WBTC pool 112.6 bps below CEX mid; net edge 78 bps after costs.",
    rationaleHash: `0x${"7a".repeat(32)}`,
    context: ctx(MARKET_WBTC),
    verdict: { ok: true, code: "OK", approvedBy: "policy" },
    execution: { txHash: `0x${"e1".repeat(32)}`, blockNumber: 12_345_200, gasUsed: "212345", amountOut: "32083", exitPath: false },
  },
  {
    seq: 1,
    id: "prop_0b5e2c7a9d1f4e60",
    hash: "0x0b5e2c7a9d1f4e60cc00000000000000000000000000000000000000000001",
    at: FIXTURE_NOW - 900,
    prevHash: `0x${"00".repeat(32)}`,
    kind: "proposal",
    market: MARKET_WBTC,
    engine: "llm",
    profile: "default",
    actor: { kind: "agent", via: "mcp" },
    origin: "candidate",
    candidateId: "cand_0b5e2c7a9d1f4e60",
    intent: { market: MARKET_WBTC, vault: FIXTURE_VAULT_STATES[MARKET_WBTC].address, side: "buy", tokenIn: MARKETS[MARKET_WBTC].quoteToken, amountIn: "25000000" },
    rationale: "WBTC pool 112.6 bps below CEX mid; net edge 78 bps after costs.",
    rationaleHash: `0x${"7a".repeat(32)}`,
    context: ctx(MARKET_WBTC),
    verdict: { ok: true, code: "OK", approvedBy: "policy" },
  },
];
