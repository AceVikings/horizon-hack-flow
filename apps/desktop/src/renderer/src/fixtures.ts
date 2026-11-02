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
import { FIXTURE_NOW, FIXTURE_PRICES, FIXTURE_STRATEGY, FIXTURE_VAULT_STATES, FIXTURE_AGENT } from "@ate/core/fixtures";
import type { AteBridge, ChatMessage, JournalFilter, PaymentsList, Res, Settings } from "@shared/bridge";
import { fmtUnits } from "./format";

export const NOW = FIXTURE_NOW;
const ok = <T,>(data: T): Res<T> => ({ ok: true, data });
const delay = <T,>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

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
    policy: { maxTradeUsd: "25", epochRemainingUsd: "225", turnoverRemainingUsd: "175", cooldownRemainingSec: 0 },
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
    rationale: "WBTC pool sits 112.6 bps below HashKey Global BTCUSDT mid; gap 113 bps vs cost 35 bps leaves 78 bps net. Oracle and TWAP agree within 12 bps. Taking the full $25 trade cap, no size-down.",
    context: ctx(MARKET_WBTC, 9_100, { signal: { id: "cand_0b5e2c7a9d1f4e60", generator: "spread-revert", leg: "open", edgeBps: 113, costBps: 35 }, quote: { amountOut: "32083", impactBps: 5, minOutFloor: "31121", exitPath: false, source: "simulation" } }),
    verdict: { ok: true, code: "OK", approvedBy: "policy" },
  }),
);
push(rec(9_090, { kind: "execution", refId: pBtc.id, market: MARKET_WBTC, engine: "llm", actor: agent, origin: "candidate", rationale: "Executed proposal within vault limits.", context: ctx(MARKET_WBTC, 9_090), verdict: { ok: true, code: "OK", approvedBy: "policy" }, execution: { txHash: hex("tx-btc-buy"), blockNumber: 12_341_130, gasUsed: "214377", amountOut: "32083", exitPath: false } }));
push(rec(9_085, { kind: "attestation", refId: pBtc.id, market: MARKET_WBTC, engine: "guard", actor: guard, rationale: "EAS attestation for executed trade.", context: ctx(MARKET_WBTC, 9_085), verdict: { ok: true, code: "OK" }, attestation: { easUid: hex("eas-btc"), schemaUid: hex("schema"), txHash: hex("tx-att-btc") } }));
push(rec(7_200, { kind: "no_trade", market: MARKET_WHSK, engine: "llm", actor: agent, rationale: "HSK pool is 30 bps under CEX mid; round-trip cost is 36 bps (30 fee + 6 impact). Net edge negative, sitting out.", context: ctx(MARKET_WHSK, 7_200, { signal: { id: "cand_93aa01b2c3d4e5f6", generator: "spread-revert", leg: "open", edgeBps: 30, costBps: 36 } }), verdict: { ok: true, code: "NO_TRADE", message: "awaiting_signal" } }));
push(rec(5_400, { kind: "no_trade", market: MARKET_WBTC, engine: "rules", actor: guard, rationale: "WBTC entry suppressed: minEntryIntervalSec 1800 not elapsed since last fill.", context: ctx(MARKET_WBTC, 5_400, { suppressed: { cause: "entry_interval", side: "buy", bps: 0 } }), verdict: { ok: true, code: "NO_TRADE", message: "guard" } }));
const veto = push(rec(3_500, { kind: "no_trade", market: MARKET_WBTC, engine: "llm", actor: agent, candidateId: "cand_5d3c1ab29e7f4408", rationale: "VETO: WBTC candidate gap widened only because Supra feed is 600 s old and disagrees by 71 bps; declining until the cross-check converges.", context: ctx(MARKET_WBTC, 3_500, { suppressed: { cause: "oracle_disagree", side: "buy", bps: 71, supra: "7737000000000" } }), verdict: { ok: true, code: "NO_TRADE", message: "llm_veto" } }));
push(rec(3_000, { kind: "proposal", market: MARKET_WHSK, engine: "llm", actor: agent, origin: "candidate", candidateId: "cand_aa11bb22cc33dd44", intent: { market: MARKET_WHSK, vault: FIXTURE_VAULT_STATES[MARKET_WHSK].address, side: "buy", tokenIn: MARKETS[MARKET_WHSK].quoteToken, amountIn: "25000000" }, rationale: "Rebalance buy toward 33% HSK target.", context: ctx(MARKET_WHSK, 3_000), verdict: { ok: false, code: "ATE_ORACLE_DEVIATION", message: "Pool spot is 251 bps from APRO; maxOracleDeviationBps is 250." } }));
push(rec(1_700, { kind: "outcome", refId: veto.id, market: MARKET_WBTC, engine: "guard", actor: guard, rationale: "30-minute counterfactual for vetoed candidate: declining saved 42 bps.", context: ctx(MARKET_WBTC, 1_700), verdict: { ok: true, code: "OK" }, outcome: { horizonSec: 1800, declinedAmountIn: "25000000", markThen: "7701200000000", savedBps: 42, savedUsd: "1.05" } }));
const pExit = push(rec(1_500, { kind: "proposal", market: MARKET_WHSK, engine: "llm", actor: agent, origin: "discretionary", thesis: "APRO is 2.2 h old while CEX is up 40 bps; trimming 13 WHSK is cheap insurance before the oracle updates.", intent: { market: MARKET_WHSK, vault: FIXTURE_VAULT_STATES[MARKET_WHSK].address, side: "sell", tokenIn: MARKETS[MARKET_WHSK].baseToken, amountIn: "13000000000000000000" }, rationale: "Discretionary trim, 1 of 3 today.", context: ctx(MARKET_WHSK, 1_500), verdict: { ok: true, code: "OK", approvedBy: "policy" } }));
push(rec(1_490, { kind: "execution", refId: pExit.id, market: MARKET_WHSK, engine: "llm", actor: agent, origin: "discretionary", rationale: "Executed on the exit path (floor min(APRO, TWAP)).", context: ctx(MARKET_WHSK, 1_490), verdict: { ok: true, code: "OK", approvedBy: "policy" }, execution: { txHash: hex("tx-hsk-exit"), blockNumber: 12_344_100, gasUsed: "188201", amountOut: "1137500", exitPath: true } }));
push(rec(900, { kind: "strategy_change", market: MARKET_WHSK, engine: "human", actor: human, origin: "human", rationale: "Go to cash on HSK, keep the BTC", context: ctx(MARKET_WHSK, 900), verdict: { ok: true, code: "OK", approvedBy: "human" } }));
const pG = push(rec(880, { kind: "proposal", market: MARKET_WHSK, engine: "guard", actor: guard, origin: "guard", intent: { market: MARKET_WHSK, vault: FIXTURE_VAULT_STATES[MARKET_WHSK].address, side: "sell", tokenIn: MARKETS[MARKET_WHSK].baseToken, amountIn: "407000000000000000000" }, rationale: "reason=target_assets: WHSK de-selected; guard sells the position down (no LLM).", context: ctx(MARKET_WHSK, 880), verdict: { ok: true, code: "OK", approvedBy: "policy" } }));
push(rec(868, { kind: "execution", refId: pG.id, market: MARKET_WHSK, engine: "guard", actor: guard, origin: "guard", rationale: "Guard exit executed.", context: ctx(MARKET_WHSK, 868), verdict: { ok: true, code: "OK", approvedBy: "policy" }, execution: { txHash: hex("tx-hsk-guard"), blockNumber: 12_344_700, gasUsed: "190114", amountOut: "35540000", exitPath: true } }));
push(rec(120, { kind: "no_trade", market: MARKET_WBTC, engine: "llm", actor: agent, rationale: "No candidate above cost after fees; BTC gap 104 bps vs cost 35 bps but entry interval still open for 11 min.", context: ctx(MARKET_WBTC, 120), verdict: { ok: true, code: "NO_TRADE", message: "no_signal" } }));

export const FIXTURE_JOURNAL = entries;

// ---- state ----
const mv = (m: MarketId): MarketView => ({ ...FIXTURE_PRICES[m], vault: FIXTURE_VAULT_STATES[m], exitMark: m === MARKET_WBTC ? "7667000000000" : "8735714" });

const status: StatusResponse = {
  version: "0.1.0-fixtures", chainId: 177, blockNumber: "12345678", locked: false,
  uptimeSec: 29_640, startedAt: NOW - 29_640, cycles: 1_482, trades: 4, hskswapTrades: 4, routedUsd: "87.50",
  trader: { running: true, mode: "autonomous", engine: "llm", lastCycleAt: NOW - 14 },
  vaults: MARKET_IDS.map((m) => ({ market: m, address: FIXTURE_VAULT_STATES[m].address, paused: false })),
  gas: { agentHsk: "3.412", low: false, attestationsDeferred: 0 },
};

function pos(m: MarketId): MarketPosition {
  const btc = m === MARKET_WBTC;
  const v = FIXTURE_VAULT_STATES[m];
  return {
    market: m, vault: v.address, balanceQuote: v.balanceQuote, balancePrice: v.balancePrice, qty: v.balancePrice,
    exposureUsd: btc ? "25.00" : "36.69",
    avgEntry: btc ? "7714461000000" : "8750000", mark: btc ? "7667000000000" : "8735714", cexMid: FIXTURE_PRICES[m].cex!.mid,
    realisedUsd: btc ? "0.00" : "0.31",
    unrealisedExitUsd: btc ? "-0.15" : "-0.01", unrealisedExitBps: btc ? -62 : -16,
    unrealisedCexUsd: btc ? "0.28" : "0.28", unrealisedCexBps: btc ? 113 : 76,
    feeDragUsd: btc ? "0.08" : "0.22",
    lots: btc ? [{ id: "lot_0b5e2c7a", market: m, openFillId: "fill_btc_1", qtyOpen: "32083", qtyRemaining: "32083", entryPrice: "7714461000000", realisedUsd: "0.00", openedAt: NOW - 9_090, closedAt: null }] : [],
    lotsRealisedUsd: "0.00",
    epoch: { spentUsd: btc ? "25" : "5", capUsd: "250", remainingUsd: btc ? "225" : "245", resetsAt: Math.floor(NOW / 86400) * 86400 + 86400 },
    exitReserveUsd: "25.00", turnoverRemainingUsd: btc ? "175.00" : "170.00", reentryLockUntil: m === MARKET_WHSK ? NOW + 2_400 : null, paused: false,
  };
}
const positions: PositionsOutput = {
  markets: MARKET_IDS.map(pos),
  portfolio: { exposureUsd: "61.69", maxPortfolioExposureUsd: "150", dailyPnlUsd: "0.15", realisedUsd: "0.31", unrealisedExitUsd: "-0.16", unrealisedCexUsd: "0.56", turnoverUsedUsd: "87.50", turnoverRemainingUsd: "212.50", discretionaryUsedToday: 1, breaker: "armed" },
  scoreboard: { acts: 3, vetoes: 2, sizeDowns: 1, savedBps: 42, savedUsd: "1.05", discretionary: 1 },
  counters: { uptimeSec: status.uptimeSec, startedAt: status.startedAt, cycles: status.cycles, trades: status.trades, hskswapTrades: status.hskswapTrades, routedUsd: status.routedUsd },
};

const strategy: StrategyGetOutput = (() => {
  const s = structuredClone(FIXTURE_STRATEGY);
  const anchors = Object.fromEntries(MARKET_IDS.map((m) => { const x = s.markets[m]; return [m, { entrySpreadBps: x.entrySpreadBps, minNetEdgeBps: x.minNetEdgeBps, tradeSizeUsd: x.tradeSizeUsd, cycleSeconds: x.cycleSeconds }]; })) as StrategyGetOutput["anchors"];
  // Agent-tuned values (inside ×0.5–×1.5 of the human anchor)
  s.markets[MARKET_WBTC].entrySpreadBps = Math.round(anchors[MARKET_WBTC].entrySpreadBps * 0.8);
  s.markets[MARKET_WHSK].minNetEdgeBps = Math.round(anchors[MARKET_WHSK].minNetEdgeBps * 1.2);
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
      () => tool("ate_strategy_set", { patch: { riskProfile: "aggressive" }, rationale: text }, { error: { code: "ATE_APPROVAL_REQUIRED", message: "Loosening change needs a Touch ID signature", details: { renderedDiff: "tradeSizeUsd 25 → 50\nentrySpreadBps 60 → 45\nminNetEdgeBps 15 → 10\nstopLossBps 300 → 400" } } }),
      () => say("That loosens several limits, so it needs your Touch ID approval before it applies. Approve the diff above to continue."),
    ]);
  } else if (/why did you sell/.test(t)) {
    seqRun([
      () => tool("ate_journal_read", { kind: ["proposal"], limit: 3 }, { entries: 2 }, entries[9]?.id),
      () => say("At 02:35 the guard sold the WHSK position because you set target assets to WBTC only (reason=target_assets); before that, a 13 WHSK discretionary trim was filed on the exit path with the thesis \"APRO is 2.2 h old while CEX is up 40 bps\"."),
    ]);
  } else {
    seqRun([() => say("I can show how you are doing, explain a trade, tune the strategy (size, spread, stop-loss, target assets) or pause the vaults. Loosening changes need a Touch ID signature; tightening ones apply immediately. What would you like?")]);
  }
}

export function createFixtureBridge(): AteBridge {
  return {
    fixtures: true,
    connection: () => delay({ mode: "fixtures" as const, detail: "fixtures mode: synthetic data, no daemon" }, 10),
    markets: { list: () => delay(ok(MARKET_IDS.map(mv))), get: (id) => delay(ok(mv(id))) },
    quote: { get: (r) => delay(ok(quote(r.market, r.side, r.amountIn)), 250) },
    trade: {
      propose: (r) => delay(ok({ proposalId: "prop_" + hex(r.market + Date.now()).slice(2, 18), journalHash: hex("p"), status: "approved" as never, origin: "human" as never, candidateId: null, expiresAt: nowSec() + 120, quote: quote(r.market, r.side, r.amountIn), reservedTurnoverUsd: "25", approvedBy: "policy" as const }), 400),
      approve: () => delay(ok({ approved: true as const })),
      execute: () => delay(ok({ proposalId: "p", executionId: "exec_1", txHash: hex("tx" + Date.now()), blockNumber: "12345690", amountIn: "25000000", amountOut: "32083", minAmountOut: "31121", quoterOut: "32083", notionalUsdE8: "2500000000", exitPath: false, rationaleHash: hex("r"), attestation: { status: "queued" as const } }), 1200),
    },
    vaults: { status: () => delay(ok({ status, positions })), pause: () => delay(ok({ vaults: [], decisionId: "pause_x", daemonLocked: true as const })) },
    strategy: {
      get: () => delay(ok(strategy)),
      set: (patch) => delay(ok({ status: "applied" as const, decisionId: "strat_fixture", changes: [], clamped: false, strategy: { ...strategy.strategy, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) } })),
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
