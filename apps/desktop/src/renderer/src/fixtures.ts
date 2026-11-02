// Fixtures mode: a complete in-memory AteBridge so every view renders without a daemon (screenshots, dev).
// Values derive from @ate/core/fixtures (Nov 2 reads) plus a hand-built journal.
import {
  MARKETS,
  MARKET_IDS,
  MARKET_WBTC,
  MARKET_WHSK,
  type DaemonEvent,
  type Decision,
  type JournalEntry,
  type MarketId,
  type MarketPosition,
  type MarketView,
  type PositionsOutput,
  type Quote,
  type StatusResponse,
  type StrategyGetOutput,
} from "@ate/core";
import { FIXTURE_CANDIDATES, FIXTURE_NOW, FIXTURE_PRICES, FIXTURE_STRATEGY, FIXTURE_VAULT_STATES as CORE_VAULT_STATES, FIXTURE_AGENT } from "@ate/core/fixtures";
import type { AteBridge, ChatMessage, JournalFilter, PaymentsList, Res, Settings } from "@shared/bridge";
import { fmtUnits } from "./format";

/**
 * Screenshot scenario (fixtures only): `?fixtures&state=<s>` or localStorage "flow.fixture".
 * live (default) · paused · empty · loading · error (status fails after the first read) · stale-oracle · mempty (no
 * market enabled) · cash (HSK sold to cash).
 */
export const SCENARIO: string = (() => {
  try {
    return new URLSearchParams(location.search).get("state") ?? localStorage.getItem("flow.fixture") ?? "live";
  } catch {
    return "live";
  }
})();

/** Testnet 133 deployment (deployments/133.json) and the §19 default limits; balances match the approved v1 board. */
const TESTNET = {
  [MARKET_WHSK]: { address: "0xF80A74F4D9C17Db8a2a0F32558a9FC3A63e2Bcd2", quote: "85310000", base: "705800000000000000000", expE8: "6170000000", spentE8: "3750000000" },
  [MARKET_WBTC]: { address: "0x6Da0c6EF7328d3aD6b0b8781770D941D065a6693", quote: "75000000", base: "32009", expE8: "2521000000", spentE8: "2500000000" },
} as Record<MarketId, { address: `0x${string}`; quote: string; base: string; expE8: string; spentE8: string }>;
const FIXTURE_VAULT_STATES = Object.fromEntries(
  (Object.entries(CORE_VAULT_STATES) as [MarketId, (typeof CORE_VAULT_STATES)[MarketId]][]).map(([m, v]) => {
    const t = TESTNET[m];
    const empty = SCENARIO === "empty";
    const cash = SCENARIO === "cash" && m === MARKET_WHSK;
    return [
      m,
      {
        ...v,
        address: t.address,
        agent: "0xC11CbceE5fDf41aa7175319691aA204eFb164f8a",
        guardian: "0x8aAcC0D83C22644f76185EF0c082112D80Cdb66B",
        owner: "0xFF7Df888C4DE9df4c044Fd0C7144AAfd1937569e",
        paused: SCENARIO === "paused",
        balanceQuote: cash ? "146860000" : empty ? (m === MARKET_WHSK ? "120000000" : "100000000") : t.quote,
        balancePrice: cash ? "0" : empty ? (m === MARKET_WHSK ? "686500000000000000000" : "0") : t.base,
        exposureUsdE8: cash ? "0" : empty ? (m === MARKET_WHSK ? "6000000000" : "0") : t.expE8,
        epoch: { ...v.epoch, spentUsdE8: empty ? "0" : cash ? "10920000000" : t.spentE8 },
        limits: { ...v.limits, maxTradeUsdE8: "10000000000", maxEpochUsdE8: "25000000000", maxExposureUsdE8: "15000000000", epochDuration: 86_400, maxOracleAge: 90_000 },
      },
    ];
  }),
) as unknown as typeof CORE_VAULT_STATES;

export const NOW = FIXTURE_NOW;
const ok = <T,>(data: T): Res<T> => ({ ok: true, data });
/** Fixture data is dated at FIXTURE_NOW; shift every unix-seconds field so ages read as on the board, today. */
const SHIFT = Math.floor(Date.now() / 1000) - FIXTURE_NOW;
const TIME_KEYS = new Set(["at", "updatedAt", "start", "openedAt", "closedAt", "expiresAt", "createdAt", "lastTradeAt", "lastCycleAt", "startedAt", "resetsAt", "reentryLockUntil", "approvedAt", "consumedAt", "generatedAt"]);
function shiftTimes<T>(v: T): T {
  if (Array.isArray(v)) return v.map(shiftTimes) as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = TIME_KEYS.has(k) && typeof x === "number" && x > 1_700_000_000 ? x + SHIFT : shiftTimes(x);
    return o as T;
  }
  return v;
}
const delay = <T,>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(shiftTimes(v)), ms));
const never = <T,>(): Promise<T> => new Promise(() => {});

// ---- deterministic fake hashes ----
function hex(seed: string, bytes = 32): `0x${string}` {
  let h = 2166136261 >>> 0;
  let out = "";
  let i = 0;
  while (out.length < bytes * 2) {
    for (const c of seed + i) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
    i++;
  }
  return `0x${out.slice(0, bytes * 2)}`;
}
const PREFIX: Record<string, string> = { proposal: "prop_", no_trade: "dec_", execution: "exec_", attestation: "att_", strategy_change: "strat_", pause: "pause_", outcome: "out_", payment: "pay_", payment_update: "payu_" };

function ctx(market: MarketId, dt: number, extra: Partial<Decision["context"]> = {}): Decision["context"] {
  const p = FIXTURE_PRICES[market];
  const v = FIXTURE_VAULT_STATES[market];
  return {
    oracle: { price: p.oracle.price, updatedAt: NOW - dt - 7_920, roundId: p.oracle.roundId, ageSec: 7_920 },
    pool: { price: p.pool.price, twap: p.pool.twap ?? "0", liquidity: p.pool.liquidity, deviationBps: p.pool.deviationBps, twapDeviationBps: p.pool.twapDeviationBps ?? 0 },
    cex: p.cex ? { mid: p.cex.mid, halfSpreadBps: p.cex.halfSpreadBps, topDepthUsd: p.cex.topDepthUsd, at: NOW - dt - 2 } : undefined,
    policy: { maxTradeUsd: "100", epochRemainingUsd: "225", turnoverRemainingUsd: "175", cooldownRemainingSec: 0 },
    blockNumber: String(12_345_678 - Math.floor(dt / 2)),
    ...(v ? {} : {}),
    ...extra,
  };
}

let prev = "0x" + "00".repeat(32);
let seq = 0;
function rec(dt: number, d: Omit<Decision, "id" | "at" | "prevHash" | "profile" | "rationaleHash"> & { id?: string }): JournalEntry {
  const at = NOW - dt;
  const body = { ...d, at, prevHash: prev };
  const hash = hex(JSON.stringify(body) + seq);
  const entry = { ...body, profile: "default", rationaleHash: hex(d.rationale), id: PREFIX[d.kind] + hash.slice(2, 18), hash, seq: ++seq } as JournalEntry;
  prev = hash;
  return entry;
}

const agent = { kind: "agent", via: "mcp", agentId: "trader" } as const;
const guard = { kind: "guard" } as const;
const human = { kind: "human", via: "chat" } as const;

const entries: JournalEntry[] = [];
const push = (e: JournalEntry) => (entries.push(e), e);

const pBtc = push(
  rec(9_100, {
    kind: "proposal", market: MARKET_WBTC, engine: "llm", actor: agent, origin: "candidate", candidateId: "cand_0b5e2c7a9d1f4e60",
    intent: { market: MARKET_WBTC, vault: FIXTURE_VAULT_STATES[MARKET_WBTC].address, side: "buy", tokenIn: MARKETS[MARKET_WBTC].quoteToken, amountIn: "25000000" },
    rationale: "WBTC pool sits 112.6 bps below HashKey Global BTCUSDT mid; gap 113 bps vs cost 35 bps leaves 78 bps net. Oracle and TWAP agree within 12 bps. Taking the full $25 strategy trade size (vault cap $100), no size-down.",
    context: ctx(MARKET_WBTC, 9_100, { signal: { id: "cand_0b5e2c7a9d1f4e60", generator: "spread-revert", leg: "open", edgeBps: 113, costBps: 35 }, quote: { amountOut: "32083", impactBps: 5, minOutFloor: "31121", exitPath: false, source: "simulation" } }),
    verdict: { ok: true, code: "OK", approvedBy: "policy" },
  }),
);
push(rec(9_090, { kind: "execution", refId: pBtc.id, market: MARKET_WBTC, engine: "llm", actor: agent, origin: "candidate", rationale: "Executed proposal within vault limits.", context: ctx(MARKET_WBTC, 9_090), verdict: { ok: true, code: "OK", approvedBy: "policy" }, execution: { txHash: hex("tx-btc-buy"), blockNumber: 12_341_130, gasUsed: "214377", amountOut: "32083", exitPath: false } }));
push(rec(9_085, { kind: "attestation", refId: pBtc.id, market: MARKET_WBTC, engine: "guard", actor: guard, rationale: "EAS attestation for executed trade.", context: ctx(MARKET_WBTC, 9_085), verdict: { ok: true, code: "OK" }, attestation: { easUid: hex("eas-btc"), schemaUid: hex("schema"), txHash: hex("tx-att-btc") } }));
push(rec(7_200, { kind: "no_trade", market: MARKET_WHSK, engine: "llm", actor: agent, rationale: "HSK pool is 30 bps under CEX mid; round-trip cost is 36 bps (30 fee + 6 impact). Net edge negative, sitting out.", context: ctx(MARKET_WHSK, 7_200, { signal: { id: "cand_93aa01b2c3d4e5f6", generator: "spread-revert", leg: "open", edgeBps: 30, costBps: 36 } }), verdict: { ok: true, code: "NO_TRADE", message: "awaiting_signal" } }));
push(rec(5_400, { kind: "no_trade", market: MARKET_WBTC, engine: "rules", actor: guard, rationale: "WBTC entry suppressed: minEntryIntervalSec 1800 not elapsed since last fill.", context: ctx(MARKET_WBTC, 5_400, { suppressed: { cause: "entry_interval", side: "buy", bps: 0 } }), verdict: { ok: true, code: "NO_TRADE", message: "guard" } }));
const veto = push(rec(3_500, { kind: "no_trade", market: MARKET_WBTC, engine: "llm", actor: agent, candidateId: "cand_5d3c1ab29e7f4408", rationale: "VETO: WBTC candidate gap widened only because Supra feed is 600 s old and disagrees by 71 bps; declining until the cross-check converges.", context: ctx(MARKET_WBTC, 3_500, { suppressed: { cause: "oracle_disagree", side: "buy", bps: 71, supra: "7737000000000" } }), verdict: { ok: true, code: "NO_TRADE", message: "llm_veto" } }));
push(rec(3_000, { kind: "proposal", market: MARKET_WHSK, engine: "llm", actor: agent, origin: "candidate", candidateId: "cand_aa11bb22cc33dd44", intent: { market: MARKET_WHSK, vault: FIXTURE_VAULT_STATES[MARKET_WHSK].address, side: "buy", tokenIn: MARKETS[MARKET_WHSK].quoteToken, amountIn: "25000000" }, rationale: "Rebalance buy toward 33% HSK target.", context: ctx(MARKET_WHSK, 3_000), verdict: { ok: false, code: "ATE_ORACLE_DEVIATION", message: "Pool spot is 251 bps from the Supra oracle; maxOracleDeviationBps is 250." } }));
push(rec(1_700, { kind: "outcome", refId: veto.id, market: MARKET_WBTC, engine: "guard", actor: guard, rationale: "30-minute counterfactual for vetoed candidate: declining saved 42 bps.", context: ctx(MARKET_WBTC, 1_700), verdict: { ok: true, code: "OK" }, outcome: { horizonSec: 1800, declinedAmountIn: "25000000", markThen: "7701200000000", savedBps: 42, savedUsd: "1.05" } }));
const pExit = push(rec(1_500, { kind: "proposal", market: MARKET_WHSK, engine: "llm", actor: agent, origin: "discretionary", thesis: "The Supra oracle is 2.2 h old while CEX is up 40 bps; trimming 13 WHSK is cheap insurance before the oracle updates.", intent: { market: MARKET_WHSK, vault: FIXTURE_VAULT_STATES[MARKET_WHSK].address, side: "sell", tokenIn: MARKETS[MARKET_WHSK].baseToken, amountIn: "13000000000000000000" }, rationale: "Discretionary trim, 1 of 3 today.", context: ctx(MARKET_WHSK, 1_500), verdict: { ok: true, code: "OK", approvedBy: "policy" } }));
push(rec(1_490, { kind: "execution", refId: pExit.id, market: MARKET_WHSK, engine: "llm", actor: agent, origin: "discretionary", rationale: "Executed on the exit path (floor min(oracle, TWAP)).", context: ctx(MARKET_WHSK, 1_490), verdict: { ok: true, code: "OK", approvedBy: "policy" }, execution: { txHash: hex("tx-hsk-exit"), blockNumber: 12_344_100, gasUsed: "188201", amountOut: "1137500", exitPath: true } }));
push(rec(900, { kind: "strategy_change", market: MARKET_WHSK, engine: "human", actor: human, origin: "human", rationale: "Go to cash on HSK, keep the BTC", context: ctx(MARKET_WHSK, 900), verdict: { ok: true, code: "OK", approvedBy: "human" } }));
const pG = push(rec(880, { kind: "proposal", market: MARKET_WHSK, engine: "guard", actor: guard, origin: "guard", intent: { market: MARKET_WHSK, vault: FIXTURE_VAULT_STATES[MARKET_WHSK].address, side: "sell", tokenIn: MARKETS[MARKET_WHSK].baseToken, amountIn: "407000000000000000000" }, rationale: "reason=target_assets: WHSK de-selected; guard sells the position down (no LLM).", context: ctx(MARKET_WHSK, 880), verdict: { ok: true, code: "OK", approvedBy: "policy" } }));
push(rec(868, { kind: "execution", refId: pG.id, market: MARKET_WHSK, engine: "guard", actor: guard, origin: "guard", rationale: "Guard exit executed.", context: ctx(MARKET_WHSK, 868), verdict: { ok: true, code: "OK", approvedBy: "policy" }, execution: { txHash: hex("tx-hsk-guard"), blockNumber: 12_344_700, gasUsed: "190114", amountOut: "35540000", exitPath: true } }));
push(rec(120, { kind: "no_trade", market: MARKET_WBTC, engine: "llm", actor: agent, rationale: "No candidate above cost after fees; BTC gap 104 bps vs cost 35 bps but entry interval still open for 11 min.", context: ctx(MARKET_WBTC, 120), verdict: { ok: true, code: "NO_TRADE", message: "no_signal" } }));

if (SCENARIO === "paused") push(rec(-60, { kind: "pause", engine: "human", actor: { kind: "human", via: "ui" }, rationale: "kill switch, by you", context: ctx(MARKET_WHSK, -60), verdict: { ok: true, code: "OK", approvedBy: "human" }, execution: { txHash: hex("tx-pause-hsk"), blockNumber: 12_345_700, gasUsed: "31000", amountOut: "0", exitPath: false } }));
if (SCENARIO === "empty") entries.splice(0, entries.length);
export const FIXTURE_JOURNAL = entries;

// ---- state ----
const mv = (m: MarketId): MarketView => {
  const p = FIXTURE_PRICES[m];
  const ageSec = m === MARKET_WBTC ? (SCENARIO === "stale-oracle" ? 93_600 : 2_460) : 7_920;
  return { ...p, oracle: { ...p.oracle, ageSec, updatedAt: NOW - ageSec, health: ageSec > 90_000 ? "stale" : ageSec > 3_600 ? "aging" : "fresh" }, vault: FIXTURE_VAULT_STATES[m], exitMark: m === MARKET_WBTC ? "7667000000000" : "8735714" };
};

const status: StatusResponse = {
  version: "0.1.0-fixtures", chainId: 133, blockNumber: "35241906", locked: SCENARIO === "paused",
  ...(SCENARIO === "empty" ? { uptimeSec: 40, startedAt: NOW - 40, cycles: 1, trades: 0, hskswapTrades: 0, routedUsd: "0" } : { uptimeSec: 29_640, startedAt: NOW - 29_640, cycles: SCENARIO === "paused" ? 1_511 : 1_482, trades: 4, hskswapTrades: 4, routedUsd: "87.50" }),
  trader: { running: SCENARIO !== "paused", mode: "autonomous", engine: "llm", lastCycleAt: NOW - 14 },
  vaults: MARKET_IDS.map((m) => ({ market: m, address: FIXTURE_VAULT_STATES[m].address, paused: SCENARIO === "paused" })),
  gas: { agentHsk: "3.412", low: false, attestationsDeferred: 0 },
};

function pos(m: MarketId): MarketPosition {
  const btc = m === MARKET_WBTC;
  const v = FIXTURE_VAULT_STATES[m];
  const empty = SCENARIO === "empty";
  const cash = SCENARIO === "cash" && !btc;
  const flat = empty || cash || BigInt(v.balancePrice) === 0n;
  return {
    market: m, vault: v.address, balanceQuote: v.balanceQuote, balancePrice: v.balancePrice, qty: v.balancePrice,
    exposureUsd: (Number(v.exposureUsdE8) / 1e8).toFixed(2),
    avgEntry: flat && !(empty && !btc) ? null : btc ? "7810200000000" : "8739000", mark: btc ? "7805500000000" : "8721000", cexMid: FIXTURE_PRICES[m].cex!.mid,
    realisedUsd: empty ? "0.00" : btc ? "0.00" : cash ? "0.18" : "0.31",
    unrealisedExitUsd: flat ? "0.00" : btc ? "-0.15" : "-0.13", unrealisedExitBps: flat ? 0 : btc ? -60 : -21,
    unrealisedCexUsd: flat ? "0.00" : btc ? "0.20" : "0.28", unrealisedCexBps: flat ? 0 : btc ? 80 : 45,
    feeDragUsd: empty ? "0.00" : btc ? "0.08" : "0.22",
    lots: empty ? [] : btc ? [{ id: "lot_0b5e2c7a", market: m, openFillId: "fill_btc_1", qtyOpen: "32009", qtyRemaining: "32009", entryPrice: "7810200000000", realisedUsd: "0.00", openedAt: NOW - 9_090, closedAt: null }] : [],
    lotsRealisedUsd: "0.00",
    epoch: { spentUsd: (Number(v.epoch.spentUsdE8) / 1e8).toFixed(2), capUsd: "250", remainingUsd: (250 - Number(v.epoch.spentUsdE8) / 1e8).toFixed(2), resetsAt: Math.floor(NOW / 86400) * 86400 + 86400 },
    exitReserveUsd: "25.00", turnoverRemainingUsd: btc ? "175.00" : "170.00", reentryLockUntil: null, paused: SCENARIO === "paused",
  };
}
const positions: PositionsOutput = {
  markets: MARKET_IDS.map(pos),
  portfolio:
    SCENARIO === "empty"
      ? { exposureUsd: "60.00", maxPortfolioExposureUsd: "200", dailyPnlUsd: "0", realisedUsd: "0.00", unrealisedExitUsd: "0.00", unrealisedCexUsd: "0.00", turnoverUsedUsd: "0", turnoverRemainingUsd: "500", discretionaryUsedToday: 0, breaker: "armed" }
      : SCENARIO === "cash"
        ? { exposureUsd: "25.21", maxPortfolioExposureUsd: "200", dailyPnlUsd: "0.03", realisedUsd: "0.18", unrealisedExitUsd: "-0.15", unrealisedCexUsd: "0.20", turnoverUsedUsd: "124.05", turnoverRemainingUsd: "375.95", discretionaryUsedToday: 1, breaker: "armed" }
        : { exposureUsd: "86.91", maxPortfolioExposureUsd: "200", dailyPnlUsd: "0.03", realisedUsd: "0.31", unrealisedExitUsd: "-0.28", unrealisedCexUsd: "0.48", turnoverUsedUsd: "62.50", turnoverRemainingUsd: "437.50", discretionaryUsedToday: 1, breaker: "armed" },
  scoreboard: SCENARIO === "empty" ? { acts: 0, vetoes: 0, sizeDowns: 0, savedBps: 0, savedUsd: "0", discretionary: 0 } : { acts: 3, vetoes: 2, sizeDowns: 1, savedBps: 42, savedUsd: "1.05", discretionary: 1 },
  counters: { uptimeSec: status.uptimeSec, startedAt: status.startedAt, cycles: status.cycles, trades: status.trades, hskswapTrades: status.hskswapTrades, routedUsd: status.routedUsd },
};

const strategy: StrategyGetOutput = (() => {
  const s = structuredClone(FIXTURE_STRATEGY);
  const anchors = Object.fromEntries(MARKET_IDS.map((m) => { const x = s.markets[m]; return [m, { entrySpreadBps: x.entrySpreadBps, minNetEdgeBps: x.minNetEdgeBps, tradeSizeUsd: x.tradeSizeUsd, cycleSeconds: x.cycleSeconds }]; })) as StrategyGetOutput["anchors"];
  // Agent-tuned values (inside ×0.5–×1.5 of the human anchor)
  s.markets[MARKET_WBTC].entrySpreadBps = Math.round(anchors[MARKET_WBTC].entrySpreadBps * 0.8);
  s.markets[MARKET_WHSK].minNetEdgeBps = Math.round(anchors[MARKET_WHSK].minNetEdgeBps * 1.2);
  s.portfolio.maxDailyTurnoverUsd = "500";
  s.portfolio.maxPortfolioExposureUsd = "200";
  if (SCENARIO === "mempty") for (const m of MARKET_IDS) s.markets[m].enabled = false;
  if (SCENARIO === "cash") s.portfolio.targetAssets = ["WBTC"];
  return { strategy: s, anchors, updatedAt: NOW - 900 };
})();

const payments: PaymentsList = {
  gate: "no-go",
  rows: [{ paymentId: "pay_demo_recorded01", state: "SETTLED", amountUsd: "0.02", payTo: "0x9c0ffee000000000000000000000000000000042", offerId: "sig_4e1a0c7b92d3f815", at: NOW - 40_000, gatewayTx: hex("gw") }],
};
const settings: Settings = { rpcUrls: ["https://mainnet.hsk.xyz"], unlockTimeoutMin: 30, daemonPort: null };

// ---- quotes ----
function quote(market: MarketId, side: "buy" | "sell", amountIn: string): Quote {
  const m = MARKETS[market];
  const p = FIXTURE_PRICES[market];
  const v = FIXTURE_VAULT_STATES[market];
  const spot = BigInt(p.pool.price); // 8dp USD per base
  const bd = m.baseDecimals;
  const ain = BigInt(amountIn || "0");
  let out: bigint;
  let notionalE8: bigint;
  if (side === "buy") {
    // USDT 6dp -> base units: usd = ain/1e6 ; base = usd / spot
    out = (ain * 10n ** BigInt(bd + 2)) / spot; // (ain/1e6)*1e8/spot*10^bd = ain*10^(bd+2)/spot
    notionalE8 = ain * 100n;
  } else {
    out = (ain * spot) / 10n ** BigInt(bd + 2);
    notionalE8 = (ain * spot) / 10n ** BigInt(bd);
  }
  out = (out * 9970n) / 10000n;
  const impactBps = Number(notionalE8 / 500_000_000n);
  const spent = BigInt(v.epoch.spentUsdE8);
  const maxTrade = BigInt(v.limits.maxTradeUsdE8);
  const epochCap = BigInt(v.limits.maxEpochUsdE8);
  let reason = 0, code: Quote["policy"]["code"] = "OK";
  if (ain === 0n) { reason = 3; code = "ATE_POLICY_ZERO_AMOUNT"; }
  else if (notionalE8 > maxTrade) { reason = 9; code = "ATE_POLICY_TRADE_CAP"; }
  else if (spent + notionalE8 > epochCap) { reason = 10; code = "ATE_POLICY_EPOCH_CAP"; }
  else if (side === "buy" && Math.abs(p.pool.deviationBps) > 250) { reason = 8; code = "ATE_ORACLE_DEVIATION"; }
  const dq = side === "buy" ? 6 : bd;
  return {
    market, vault: v.address, side,
    tokenIn: side === "buy" ? m.quoteToken : m.baseToken, tokenOut: side === "buy" ? m.baseToken : m.quoteToken,
    decimals: dq, amountIn,
    amountInHuman: `${fmtUnits(amountIn || "0", dq)} ${side === "buy" ? "USDT" : m.base}`,
    amountOut: out.toString(),
    amountOutHuman: `${fmtUnits(out, side === "buy" ? bd : 6, 2)} ${side === "buy" ? m.base : "USDT"}`,
    impactBps, source: "simulation",
    policy: { reason: reason as 0, code, notionalUsdE8: notionalE8.toString(), oraclePrice: p.oracle.price, minOutFloor: ((out * 9750n) / 10000n).toString(), exitPath: side === "sell" },
    minOutFloor: ((out * 9750n) / 10000n).toString(), exitPath: side === "sell", blockNumber: "12345678", at: Math.floor(Date.now() / 1000),
  };
}

// ---- chat ----
const listeners = new Set<(e: DaemonEvent) => void>();
const emit = (e: DaemonEvent) => listeners.forEach((l) => l(e));
const chatLog = new Map<string, ChatMessage[]>();
const nowSec = () => Math.floor(Date.now() / 1000);

function runChat(sessionId: string, turnId: string, text: string): void {
  const t = text.toLowerCase();
  const say = (s: string, done = true) => emit({ type: "chat.delta", at: nowSec(), data: { sessionId, turnId, text: s, done } });
  const tool = (name: string, args: unknown, result: unknown, decisionId?: string) => emit({ type: "chat.tool", at: nowSec(), data: { sessionId, turnId, tool: name, args, result, decisionId } });
  const seqRun = (steps: (() => void)[]) => steps.forEach((s, i) => setTimeout(s, 500 + i * 650));
  if (/how am i doing|doing today/.test(t)) {
    seqRun([
      () => tool("ate_positions", {}, { portfolio: positions.portfolio, markets: positions.markets.map((m) => ({ market: m.market, exposureUsd: m.exposureUsd, unrealisedExitUsd: m.unrealisedExitUsd, unrealisedExitBps: m.unrealisedExitBps, unrealisedCexUsd: m.unrealisedCexUsd, unrealisedCexBps: m.unrealisedCexBps, feeDragUsd: m.feeDragUsd })), scoreboard: positions.scoreboard }),
      () => say("Selling the BTC lot right now would realise −0.62% (−$0.15) after fees; marked at the HashKey Global mid it is +1.13% on paper (+$0.28). HSK is flat: realised +$0.31, exit-executable −$0.01. Fee drag so far is $0.30. The AI vetoed 2 entries (+42 bps saved, $1.05) and used 1 of 3 discretionary trades."),
    ]);
  } else if (/go to cash/.test(t) || /only trade btc/.test(t)) {
    seqRun([
      () => tool("ate_strategy_set", { patch: { targetAssets: ["WBTC"] }, rationale: text }, { status: "applied", clamped: false, changes: [{ scope: "portfolio", field: "targetAssets", before: ["WHSK", "WBTC"], after: ["WBTC"], loosening: false }] }, "strat_9f3b2a17c0d4e861"),
      () => say("Done. Target assets are now WBTC only. This tightens the strategy so it applied at once; the guard is selling the WHSK position down now (reason=target_assets), no LLM cycle needed."),
    ]);
  } else if (/pause|stop everything/.test(t)) {
    seqRun([
      () => tool("ate_pause", { rationale: text }, { vaults: MARKET_IDS.map((m) => ({ market: m, status: "submitted" })), daemonLocked: true }, "pause_c41d5e0a77b2f390"),
      () => say("Both vaults are paused. Note a pause also stops stop-loss exits; say \"go to cash\" first next time if you hold a position."),
    ]);
  } else if (/aggressive/.test(t)) {
    seqRun([
      () => tool("ate_strategy_set", { patch: { riskProfile: "aggressive" }, rationale: text }, { error: { code: "ATE_APPROVAL_REQUIRED", message: "Loosening change needs a Touch ID signature", details: { changeId: "chg_5e1f0a9c3b7d2e48", renderedDiff: "tradeSizeUsd 25 → 50\nentrySpreadBps 60 → 45\nminNetEdgeBps 15 → 10\nstopLossBps 300 → 400" } } }),
      () => say("That loosens several limits, so it needs your Touch ID approval before it applies. Approve the diff above to continue."),
    ]);
  } else if (/why did you sell/.test(t)) {
    seqRun([
      () => tool("ate_journal_read", { kind: ["proposal"], limit: 3 }, { entries: 2 }, entries[9]?.id),
      () => say("At 02:35 the guard sold the WHSK position because you set target assets to WBTC only (reason=target_assets); before that, a 13 WHSK discretionary trim was filed on the exit path with the thesis \"The Supra oracle is 2.2 h old while CEX is up 40 bps\"."),
    ]);
  } else {
    seqRun([() => say("I can show how you are doing, explain a trade, tune the strategy (size, spread, stop-loss, target assets) or pause the vaults. Loosening changes need a Touch ID signature; tightening ones apply immediately. What would you like?")]);
  }
}

let statusReads = 0;
export function createFixtureBridge(): AteBridge {
  return {
    fixtures: true,
    connection: () => delay({ mode: "fixtures" as const, detail: "fixtures mode: synthetic data, no daemon" }, 10),
    markets: { list: () => (SCENARIO === "loading" ? never() : delay(ok(MARKET_IDS.map(mv)))), get: (id) => delay(ok(mv(id))) },
    quote: { get: (r) => delay(ok(quote(r.market, r.side, r.amountIn)), 250) },
    trade: {
      propose: (r) => delay(ok({ proposalId: "prop_" + hex(r.market + Date.now()).slice(2, 18), journalHash: hex("p"), status: "approved" as never, origin: "human" as never, candidateId: null, expiresAt: nowSec() + 120, quote: quote(r.market, r.side, r.amountIn), reservedTurnoverUsd: "25", approvedBy: "policy" as const }), 400),
      approve: () => delay(ok({ approved: true as const })),
      execute: () => delay(ok({ proposalId: "p", executionId: "exec_1", txHash: hex("tx" + Date.now()), blockNumber: "12345690", amountIn: "25000000", amountOut: "32083", minAmountOut: "31121", quoterOut: "32083", notionalUsdE8: "2500000000", exitPath: false, rationaleHash: hex("r"), attestation: { status: "queued" as const } }), 1200),
    },
    vaults: {
      status: () => {
        if (SCENARIO === "loading") return never();
        if (SCENARIO === "error" && statusReads++ > 0) return delay({ ok: false as const, error: { code: "ATE_INTERNAL" as const, message: "fetch failed: connect ECONNREFUSED 127.0.0.1 (daemon or RPC unreachable)" } }, 300);
        return delay(ok({ status, positions }));
      },
      pause: () => delay(ok({ vaults: MARKET_IDS.map((m) => ({ market: m, vault: FIXTURE_VAULT_STATES[m].address, txHash: hex("pause" + m), status: "submitted" as const })), decisionId: "pause_x", daemonLocked: true as const }), 1500),
    },
    candidates: {
      get: () => delay(ok({ candidates: SCENARIO === "empty" ? [] : FIXTURE_CANDIDATES, suppressed: SCENARIO === "empty" ? [] : [{ market: MARKET_WBTC, side: "buy" as const, cause: "entry_interval" as const, bps: 0 }], candidateTtlSec: 180, cycle: 1482, generatedAt: NOW })),
    },
    cycle: { request: () => delay(ok({ started: true, cycle: 1483 })) },
    strategy: {
      get: () => delay(ok(strategy)),
      set: (patch) => delay(ok({ status: "applied" as const, decisionId: "strat_fixture", changes: [], clamped: false, strategy: { ...strategy.strategy, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) } })),
      approve: () => delay(ok({ applied: true as const, decisionId: "strat_fixture_approved", changes: [] }), 600),
    },
    journal: {
      list: (f: JournalFilter) => {
        let es = [...entries].reverse();
        if (f.market) es = es.filter((e) => (e.market ?? e.intent?.market) === f.market);
        if (f.kind) es = es.filter((e) => f.kind!.includes(e.kind));
        return delay(ok({ entries: es.slice(0, f.limit ?? 100), head: { seq: entries.length, hash: entries[entries.length - 1]!.hash } }));
      },
      get: (id) => { const e = entries.find((x) => x.id === id); return delay(e ? ok(e) : { ok: false as const, error: { code: "ATE_INTERNAL" as const, message: "not found" } }); },
    },
    chat: {
      send: (sessionId, text) => {
        const turnId = "turn_" + Math.random().toString(16).slice(2, 10);
        const log = chatLog.get(sessionId) ?? [];
        log.push({ id: "u" + turnId, role: "user", text, at: nowSec() });
        chatLog.set(sessionId, log);
        runChat(sessionId, turnId, text);
        return delay(ok({ turnId }), 50);
      },
      history: (s) => delay(ok(chatLog.get(s) ?? [])),
    },
    payments: {
      list: () => delay(ok(payments)),
      approve: () => delay(ok({ approved: true as const })),
      deny: () => delay(ok({ denied: true as const })),
    },
    settings: { get: () => delay(ok(settings)), set: (p) => delay(ok({ ...settings, ...p })) },
    events: {
      subscribe: (h) => {
        listeners.add(h);
        // Mirror chat events into the local history, as main does in live mode.
        return () => void listeners.delete(h);
      },
    },
  };
}

// Mirror chat events into history so reloads/tab switches keep the transcript.
listeners.add((e) => {
  if (e.type === "chat.delta") {
    const log = chatLog.get(e.data.sessionId) ?? [];
    const last = log[log.length - 1];
    if (last && last.role === "agent" && last.turnId === e.data.turnId) last.text += e.data.text;
    else log.push({ id: e.data.turnId + ":a", role: "agent", text: e.data.text, at: e.at, turnId: e.data.turnId });
    chatLog.set(e.data.sessionId, log);
  } else if (e.type === "chat.tool") {
    const log = chatLog.get(e.data.sessionId) ?? [];
    log.push({ id: e.data.turnId + ":t" + log.length, role: "tool", text: e.data.tool, at: e.at, turnId: e.data.turnId, tool: { name: e.data.tool, args: e.data.args, result: e.data.result, decisionId: e.data.decisionId } });
    chatLog.set(e.data.sessionId, log);
  }
});

export { FIXTURE_AGENT };
