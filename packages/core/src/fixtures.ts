// Shared contract-test fixtures for both markets (§21.4). Values are realistic (Nov 2 reads, §0.2/§4.2)
// but synthetic. Import from "@ate/core/fixtures". Lanes may add fixtures, never change existing ones.

import { DEFAULT_STRATEGY_CONFIG, type AteConfig } from "./config.js";
import { MARKETS, MARKET_WBTC, MARKET_WHSK, type Address, type MarketId } from "./markets.js";
import { deviationBps, exposureUsd, scaleFor, e8ToUsd } from "./policy.js";
import { ReasonCode } from "./reasons.js";
import type { MarketSnapshot, PortfolioState } from "./strategy.js";
import type { Candidate, LimitsJson, PriceSnapshot, StrategyParams, VaultState } from "./types.js";

export const FIXTURE_NOW = 1_793_588_400; // 2026-11-02T03:00:00Z, fixed
export const FIXTURE_BLOCK = "12345678";
export const FIXTURE_AGENT: Address = "0x1111111111111111111111111111111111111111";
export const FIXTURE_GUARDIAN: Address = "0x2222222222222222222222222222222222222222";
export const FIXTURE_OWNER: Address = "0x3333333333333333333333333333333333333333";
export const FIXTURE_VAULTS: Record<MarketId, Address> = {
  "hsk-dex:WHSK/USDT:3000": "0xAAAA00000000000000000000000000000000AAAA",
  "hsk-dex:WBTC/USDT:3000": "0xBBBB00000000000000000000000000000000BBBB",
};

/** §19 step 3 defaults (identical for both vaults): $25 trade, $250 epoch, $150 exposure, 1 day. */
export const FIXTURE_LIMITS: LimitsJson = {
  maxTradeUsdE8: "2500000000",
  maxEpochUsdE8: "25000000000",
  maxExposureUsdE8: "15000000000",
  epochDuration: 86_400,
  maxSlippageBps: 250,
  maxOracleDeviationBps: 250,
  maxExitDiscountBps: 500,
  maxOracleAge: 90_000,
  cooldown: 60,
};

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** sqrtPriceX96 for an 8-dp USD price (token0 = priceToken, token1 = USDT). */
export function sqrtPriceX96FromPrice(priceE8: bigint, d: 8 | 18): bigint {
  return isqrt((priceE8 << 192n) / scaleFor(d));
}

function tickFromPrice(priceE8: bigint, d: 8 | 18): number {
  const raw = Number(priceE8) / Number(scaleFor(d));
  return Math.floor(Math.log(raw) / Math.log(1.0001));
}

function priceSnap(market: MarketId, oracleE8: bigint, spotE8: bigint, twapE8: bigint, cexMidE8: bigint, halfSpreadBps: number): PriceSnapshot {
  const d = MARKETS[market].baseDecimals;
  return {
    market,
    oracle: { price: oracleE8.toString(), updatedAt: FIXTURE_NOW - 7_920, roundId: "18446744073709552000", ageSec: 7_920, health: "aging" },
    pool: {
      price: spotE8.toString(),
      twap: twapE8.toString(),
      sqrtPriceX96: sqrtPriceX96FromPrice(spotE8, d).toString(),
      tick: tickFromPrice(spotE8, d),
      liquidity: market === MARKET_WHSK ? "41234567890123456789" : "123456789012",
      observationCardinality: 240,
      deviationBps: Number(deviationBps(spotE8, oracleE8)),
      twapDeviationBps: Number(deviationBps(twapE8, oracleE8)),
    },
    cex: {
      symbol: MARKETS[market].cexSymbol,
      mid: cexMidE8.toString(),
      bid: ((cexMidE8 * BigInt(10_000 - halfSpreadBps)) / 10_000n).toString(),
      ask: ((cexMidE8 * BigInt(10_000 + halfSpreadBps)) / 10_000n).toString(),
      halfSpreadBps,
      topDepthUsd: market === MARKET_WHSK ? "4200" : "185000",
      at: FIXTURE_NOW - 2,
    },
    supra: { price: oracleE8.toString(), updatedAt: FIXTURE_NOW - 600, disagreeBps: 3, active: market === MARKET_WBTC },
    readOnly: false,
    blockNumber: FIXTURE_BLOCK,
    at: FIXTURE_NOW,
  };
}

// WHSK: APRO $0.0880, pool ~30 bps below CEX mid. WBTC: APRO 77,925.02, pool 77,144.61 (112.6 bps below CEX mid).
const WHSK_P = 8_800_000n;
const WBTC_P = 7_792_502_000_000n;

export const FIXTURE_PRICES: Record<MarketId, PriceSnapshot> = {
  "hsk-dex:WHSK/USDT:3000": priceSnap(MARKET_WHSK, WHSK_P, 8_790_000n, 8_792_000n, 8_816_400n, 6),
  "hsk-dex:WBTC/USDT:3000": priceSnap(MARKET_WBTC, WBTC_P, 7_714_461_000_000n, 7_716_000_000_000n, 7_802_315_000_000n, 1),
};

function vault(market: MarketId, balanceQuote: bigint, balancePrice: bigint, oracleE8: bigint, spentE8: bigint): VaultState {
  const d = MARKETS[market].baseDecimals;
  return {
    market,
    address: FIXTURE_VAULTS[market],
    paused: false,
    agent: FIXTURE_AGENT,
    guardian: FIXTURE_GUARDIAN,
    owner: FIXTURE_OWNER,
    priceDecimals: d,
    balanceQuote: balanceQuote.toString(),
    balancePrice: balancePrice.toString(),
    exposureUsdE8: exposureUsd(balancePrice, oracleE8, d).toString(),
    epoch: { index: String(Math.floor(FIXTURE_NOW / 86_400)), start: Math.floor(FIXTURE_NOW / 86_400) * 86_400, spentUsdE8: spentE8.toString(), capUsdE8: FIXTURE_LIMITS.maxEpochUsdE8 },
    limits: FIXTURE_LIMITS,
    lastTradeAt: FIXTURE_NOW - 900,
  };
}

/** Vault-HSK seeded ~33% WHSK ($37 of ~$110); Vault-BTC holds one $25 spread-revert lot. */
export const FIXTURE_VAULT_STATES: Record<MarketId, VaultState> = {
  "hsk-dex:WHSK/USDT:3000": vault(MARKET_WHSK, 73_000_000n, 420_000_000_000_000_000_000n, WHSK_P, 500_000_000n),
  "hsk-dex:WBTC/USDT:3000": vault(MARKET_WBTC, 85_000_000n, 32_083n, WBTC_P, 2_500_000_000n),
};

export const FIXTURE_MARKET_SNAPSHOTS: Record<MarketId, MarketSnapshot> = {
  "hsk-dex:WHSK/USDT:3000": {
    market: MARKET_WHSK,
    at: FIXTURE_NOW,
    price: FIXTURE_PRICES[MARKET_WHSK],
    vault: FIXTURE_VAULT_STATES[MARKET_WHSK],
    feeBps: 30,
    impact: {
      buy: [
        { amountIn: "5000000", amountOut: "566176000000000000000", impactBps: 0 },
        { amountIn: "25000000", amountOut: "2830870000000000000000", impactBps: 1 },
      ],
      sell: [{ amountIn: "420000000000000000000", amountOut: "36690000", impactBps: 1 }],
    },
    exitMark: "8735714",
    prefilterBuy: { reason: ReasonCode.OK, notionalUsdE8: "2500000000", deviationBps: 12 },
  },
  "hsk-dex:WBTC/USDT:3000": {
    market: MARKET_WBTC,
    at: FIXTURE_NOW,
    price: FIXTURE_PRICES[MARKET_WBTC],
    vault: FIXTURE_VAULT_STATES[MARKET_WBTC],
    feeBps: 30,
    impact: {
      buy: [
        { amountIn: "5000000", amountOut: "6462", impactBps: 1 },
        { amountIn: "25000000", amountOut: "32083", impactBps: 5 },
      ],
      sell: [{ amountIn: "32083", amountOut: "24600000", impactBps: 5 }],
    },
    exitMark: "7667000000000",
    prefilterBuy: { reason: ReasonCode.OK, notionalUsdE8: "2500000000", deviationBps: 101 },
  },
};

export const FIXTURE_STRATEGY: StrategyParams = {
  engine: "llm",
  mode: "autonomous",
  enabled: true,
  portfolio: { ...DEFAULT_STRATEGY_CONFIG.portfolio, candidateTtlSec: 180 },
  markets: DEFAULT_STRATEGY_CONFIG.markets,
};

export const FIXTURE_CANDIDATES: Candidate[] = [
  {
    candidateId: "cand_0b5e2c7a9d1f4e60",
    market: MARKET_WBTC,
    generator: "spread-revert",
    leg: "open",
    side: "buy",
    maxAmountIn: "25000000",
    edgeBps: 113,
    costBps: 35,
    netEdgeBps: 78,
    reason: "WBTC pool 112.6 bps below HashKey Global BTCUSDT mid; cost 30 fee + 5 impact + <0.01 half-spread",
    expiresAt: FIXTURE_NOW + 180,
    createdAt: FIXTURE_NOW,
    profile: "default",
  },
  {
    candidateId: "cand_7f3a91d2c4b8e015",
    market: MARKET_WBTC,
    generator: "discretionary_exit",
    side: "sell",
    maxAmountIn: "32083",
    edgeBps: 0,
    costBps: 35,
    netEdgeBps: -35,
    reason: "standing discretionary exit: min(position, maxTradeUsd, epoch remaining)",
    expiresAt: FIXTURE_NOW + 180,
    createdAt: FIXTURE_NOW,
    profile: "default",
  },
  {
    candidateId: "cand_c0ffee12ab34cd56",
    market: MARKET_WHSK,
    generator: "discretionary_exit",
    side: "sell",
    maxAmountIn: "281250000000000000000",
    edgeBps: 0,
    costBps: 36,
    netEdgeBps: -36,
    reason: "standing discretionary exit: min(position, maxTradeUsd, epoch remaining)",
    expiresAt: FIXTURE_NOW + 180,
    createdAt: FIXTURE_NOW,
    profile: "default",
  },
];

const book = (market: MarketId, qty: string, avgEntry: string | null, used: string) => ({
  market,
  position: { qty, avgEntry, realisedUsd: "0", lots: [] },
  exposureUsd: e8ToUsd(BigInt(FIXTURE_VAULT_STATES[market].exposureUsdE8)),
  reentryLockUntil: null,
  lastEntryAt: FIXTURE_NOW - 900,
  lastGuardExitAt: null,
  turnover: { allocationUsd: "100", usedUsd: used, reservedUsd: "0" },
  vault: FIXTURE_VAULT_STATES[market],
});

export const FIXTURE_PORTFOLIO: PortfolioState = {
  at: FIXTURE_NOW,
  utcDay: "2026-11-02",
  mode: "autonomous",
  strategy: FIXTURE_STRATEGY,
  markets: {
    "hsk-dex:WHSK/USDT:3000": book(MARKET_WHSK, FIXTURE_VAULT_STATES[MARKET_WHSK].balancePrice, "8800000", "5"),
    "hsk-dex:WBTC/USDT:3000": {
      ...book(MARKET_WBTC, "32083", "7792255000000", "25"),
      position: {
        qty: "32083",
        avgEntry: "7792255000000",
        realisedUsd: "0",
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
      },
    },
  },
  turnover: { budgetUsd: "200", usedUsd: "30", reservedUsd: "0" },
  discretionary: { executedToday: 0, reservedToday: 0 },
  dailyPnlUsd: "-0.21",
  breaker: { state: "armed", since: null },
  candidates: Object.fromEntries(FIXTURE_CANDIDATES.map((c) => [c.candidateId, { ...c, consumedBy: null }])),
  openProposals: [],
  candidateTtlSec: 180,
};

/** A complete, valid ~/.ate/config.json for tests (§16). */
export const FIXTURE_CONFIG: AteConfig = {
  version: 1,
  chain: { id: 177, rpcUrls: ["https://mainnet.hsk.xyz", "https://177.rpc.thirdweb.com"], explorer: "https://hsk.blockscout.com" },
  agentKeyId: "8f14e45f-ceea-467f-a0e6-5b0c6f1e7a11",
  guardian: FIXTURE_GUARDIAN,
  vaults: [
    { market: MARKET_WHSK, address: FIXTURE_VAULTS[MARKET_WHSK] },
    { market: MARKET_WBTC, address: FIXTURE_VAULTS[MARKET_WBTC] },
  ],
  eas: { address: "0x4200000000000000000000000000000000000021", schemaUid: `0x${"ab".repeat(32)}` },
  venues: {
    hskdex: {
      factory: "0x972cA9D1662F5e029cD18327D29026532E84c742",
      router: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
      quoter: "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD",
      routerKind: "swaprouter02",
      markets: [MARKET_WHSK, MARKET_WBTC].map((id) => {
        const m = MARKETS[id];
        return { id, base: m.base, baseDecimals: m.baseDecimals, quote: "USDT" as const, fee: 3000 as const, pool: m.pool, oracle: m.oracle, cexSymbol: m.cexSymbol };
      }),
    },
  },
  oracle: {
    apro: { maxAgeSec: 90_000 },
    cex: { provider: "hashkey-public-market", site: "glb", baseUrl: "https://api-glb.hashkey.com", skillCommit: "0000000" },
  },
  strategy: DEFAULT_STRATEGY_CONFIG,
  chat: {
    runner: "claude -p",
    prompt: "agents/chat/PROMPT.md",
    fallback: "rules",
    runnerFlags: ["--strict-mcp-config", "--allowedTools", "mcp__ate__*"],
    allowedTools: ["mcp__ate__*"],
  },
  payments: {
    enabled: false,
    worker: "http://127.0.0.1:7401",
    provider: "hsp",
    endpoint: "https://mcp-qa.hashkeymerchant.com/",
    transport: "streamable-http",
    merchantName: "Vikings",
    signer: "okx-agentic-wallet",
    fallbackSigner: "local-eoa",
    requireSignApproval: true,
    requireSubmitApproval: true,
    signalPriceUsd: "0.02",
    perPaymentCapUsd: "0.10",
    dailyCapUsd: "1.00",
  },
  daemon: { autoLockMinutes: 15, port: 0, gasAlarmHsk: "2", attestFloorHsk: "1", approvalFallback: "off" },
  supra: { storage: "0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57", use: "entry-gate+crosscheck", maxDisagreeBps: 250, maxAgeSec: 3600 },
  ui: { theme: "dark", reducedMotion: false },
};
