// Domain types (§5, §7, §11, §12, §13). FROZEN 04:30 IST — lanes may add, never change.
//
// Wire convention (§12): every amount/price on the wire and in SQLite is a DECIMAL STRING of integer
// smallest units unless the field name says otherwise:
//   - `*Usd` strings are human USD decimals ("25", "0.10")       — strategy params, P&L, display
//   - `*UsdE8` strings are 8-dp integer vault units ("2500000000") — on-chain notional/caps/exposure
//   - prices (`price`, `mid`, `entry`, `mark`, …) are 8-dp integer strings (USD per whole priceToken)
//   - token amounts (`amountIn`, `qty`, …) are integer strings in the token's smallest units
// Times are Unix seconds (number). Block numbers on the wire are decimal strings.

import type { AteErrorCode } from "./errors.js";
import type { Address, Hex, MarketId, Side, TargetAsset } from "./markets.js";
import type { ReasonCode } from "./reasons.js";
import type { CustomStrategyRef } from "./custom-strategy.js";

export type DecString = string;
export type UnixSec = number;

export type Profile = "default" | "demo" | "rogue";
export type Engine = "llm" | "rules" | "guard" | "human";
export type ApprovalMode = "autonomous" | "confirm";
/** `rogue` is additive (v0.9, §10.1): only with --allow-rogue, only the TxQueue raw-broadcast route. */
export type TokenScope = "agent" | "chat" | "ui" | "session" | "view" | "rogue";

// ------------------------------------------------------------------ market data (§5, §11.2)

export type OracleHealth = "fresh" | "aging" | "stale";

export interface OracleSnapshot {
  /** 8-dp answer as read. */
  price: DecString;
  updatedAt: UnixSec;
  roundId: DecString;
  ageSec: number;
  health: OracleHealth;
}

export interface PoolSnapshot {
  /** Spot S, 8 dp. */
  price: DecString;
  /** 300 s TWAP T, 8 dp; null if observe() reverted. */
  twap: DecString | null;
  sqrtPriceX96: DecString;
  tick: number;
  liquidity: DecString;
  observationCardinality: number;
  deviationBps: number;
  twapDeviationBps: number | null;
}

export interface CexSnapshot {
  symbol: "HSKUSDT" | "BTCUSDT";
  /** 8 dp. */
  mid: DecString;
  bid: DecString;
  ask: DecString;
  halfSpreadBps: number;
  topDepthUsd: string;
  at: UnixSec;
  recentTrades?: { price: DecString; qty: string; side: Side; at: UnixSec }[];
}

export interface SupraSnapshot {
  /** 8 dp; null when the pair is unlisted. */
  price: DecString | null;
  updatedAt: UnixSec | null;
  disagreeBps: number | null;
  /** false when unlisted, read failed or > 1 h old (gate inactive, §5.1). */
  active: boolean;
}

/** OracleService.getPrice(market) (§5.3). */
export interface PriceSnapshot {
  market: MarketId;
  oracle: OracleSnapshot;
  pool: PoolSnapshot;
  cex: CexSnapshot | null;
  supra: SupraSnapshot | null;
  /**
   * Additive (Lane B): APRO cross-check read by EOA eth_call (APRO rejects contract readers on 177, so the
   * vault's `oracle` is a SupraAggregatorAdapter and `oracle` above is that adapter). null when not read.
   */
  apro?: { price: DecString; updatedAt: UnixSec; ageSec: number; disagreeBps: number } | null;
  /** Market in read-only mode (APRO unavailable/invalid, §5.3). */
  readOnly: boolean;
  blockNumber: DecString;
  at: UnixSec;
}

/** Vault on-chain state, wire form (bigints as decimal strings). */
export interface VaultState {
  market: MarketId;
  address: Address;
  paused: boolean;
  agent: Address;
  guardian: Address;
  owner: Address;
  priceDecimals: 8 | 18;
  balanceQuote: DecString;
  balancePrice: DecString;
  exposureUsdE8: DecString;
  epoch: { index: DecString; start: UnixSec; spentUsdE8: DecString; capUsdE8: DecString };
  limits: LimitsJson;
  lastTradeAt: UnixSec;
}

/** Limits in wire form (§12 `limits` table). */
export interface LimitsJson {
  maxTradeUsdE8: DecString;
  maxEpochUsdE8: DecString;
  maxExposureUsdE8: DecString;
  epochDuration: number;
  maxSlippageBps: number;
  maxOracleDeviationBps: number;
  maxExitDiscountBps: number;
  maxOracleAge: number;
  cooldown: number;
}

// ------------------------------------------------------------------ quotes (§6, §7.4)

export interface QuoteRequest {
  market: MarketId;
  side: Side;
  /** Smallest units of tokenIn. */
  amountIn: DecString;
}

export interface Quote {
  market: MarketId;
  vault: Address;
  side: Side;
  tokenIn: Address;
  tokenOut: Address;
  /** Decimals of tokenIn. */
  decimals: number;
  amountIn: DecString;
  /** Human-readable amountIn, e.g. "25 USDT". */
  amountInHuman: string;
  amountOut: DecString;
  amountOutHuman: string;
  impactBps: number;
  source: "simulation" | "estimate";
  /** check() verdict. */
  policy: {
    reason: ReasonCode;
    code: AteErrorCode | "OK";
    notionalUsdE8: DecString;
    oraclePrice: DecString;
    minOutFloor: DecString;
    exitPath: boolean;
  };
  minOutFloor: DecString;
  exitPath: boolean;
  blockNumber: DecString;
  at: UnixSec;
}

// ------------------------------------------------------------------ candidates (§7.2, §11.3)

/** `custom` is additive (lane STRAT): candidates from the user's own strategy (`MarketStrategyParams.custom`). */
export type GeneratorId = "spread-revert" | "rebalance" | "guard_exit" | "discretionary_exit" | "smoke" | "custom";
/** Generators configurable per market in config (§16). */
export type ConfigurableGenerator = "spread-revert" | "rebalance";
export type Leg = "open" | "close";
export type GuardExitReason = "stop_loss" | "take_profit" | "breaker" | "target_assets";
/** `entry_interval` is additive (v0.9, §11.4 rule 7). */
export type SuppressionCause = "deviation" | "oracle_disagree" | "entry_interval";

export interface Candidate {
  /** "cand_" + 16 hex. */
  candidateId: string;
  market: MarketId;
  generator: GeneratorId;
  leg?: Leg;
  side: Side;
  /** Smallest units of tokenIn. */
  maxAmountIn: DecString;
  edgeBps: number;
  costBps: number;
  netEdgeBps: number;
  /** Agent-visible text; wrapped in <untrusted_agent_text> for chat (§11.5). */
  reason: string;
  expiresAt: UnixSec;
  // ---- freeze additions (optional, daemon-populated) ----
  createdAt?: UnixSec;
  profile?: Profile;
  guardReason?: GuardExitReason;
  /** Additive (lane STRAT): the custom strategy behind a `custom` candidate. */
  strategy?: { id: string; version: number; hash: string; name: string; kind: "rules" | "ai" };
}

export interface Suppressed {
  market: MarketId;
  /** "buy" for deviation/oracle_disagree; entry_interval may suppress any entry. */
  side: Side;
  cause: SuppressionCause;
  bps: number;
}

// ------------------------------------------------------------------ proposals (§7.3, §12)

export type ProposalOrigin = "candidate" | "discretionary" | "guard" | "human";
export type ProposalStatus =
  | "proposed"
  | "awaiting_human"
  | "approved"
  | "executed"
  | "failed"
  | "rejected"
  | "expired"
  | "invalidated";

export interface Proposal {
  /** "prop_" + 16 hex (= hash[2:18]). */
  id: string;
  market: MarketId;
  vault: Address;
  side: Side;
  tokenIn: Address;
  amountIn: DecString;
  minAmountOut: DecString;
  rationale: string;
  rationaleHash: Hex;
  candidateId: string | null;
  signalId: string | null;
  origin: ProposalOrigin;
  thesis: string | null;
  /** Full journal record hash = on-chain SwapParams.proposalId. */
  journalHash: Hex;
  oraclePrice: DecString;
  oracleUpdatedAt: UnixSec;
  poolPrice: DecString;
  policyReason: ReasonCode;
  status: ProposalStatus;
  reservedTurnoverUsd: string;
  approvedBy: "policy" | "human" | null;
  approvedAt: UnixSec | null;
  createdAt: UnixSec;
  expiresAt: UnixSec;
  consumedAt: UnixSec | null;
}

export const PROPOSAL_TTL_SEC = 120;
export const MIN_CANDIDATE_TTL_SEC = 120;
export const EXECUTE_DEADLINE_SEC = 60;
export const EXECUTE_QUOTE_BUFFER_BPS = 50;

// ------------------------------------------------------------------ strategy params (§16, §7.4)

export interface MarketStrategyParams {
  profile: "default" | "demo";
  generators: ConfigurableGenerator[];
  enabled?: boolean;
  tradeSizeUsd: string;
  maxPositionUsd: string;
  cycleSeconds: number;
  entrySpreadBps: number;
  minNetEdgeBps: number;
  /** null = no allocation target (rebalance inactive). 0 = go to cash. */
  rebalanceTargetPct: number | null;
  rebalanceBandPct: number;
  stopLossBps: number;
  takeProfitBps: number;
  reentryCooldownSec: number;
  /** Additive v0.9 (§11.4 rule 7): default 0 (WHSK), 1800 (WBTC). */
  minEntryIntervalSec?: number;
  /** Additive (lane STRAT): the user's custom strategy in use on this market; replaces the open-entry generators. */
  custom?: CustomStrategyRef | null;
  /**
   * Additive: the price the spread-revert gap is measured against. Default (absent) "oracle" — the on-chain
   * Supra feed the vault checks. "twap" = the pool's 300 s TWAP. "cex" = HashKey Global mid (optional context,
   * the earlier reference; off by default). Every trade fills on HSKSwap whichever is chosen.
   */
  reference?: "oracle" | "twap" | "cex";
}

export interface PortfolioStrategyParams {
  targetAssets: TargetAsset[];
  maxDailyTurnoverUsd: string;
  maxPortfolioExposureUsd: string;
  dailyLossLimitUsd: string;
  discretionaryTradesPerDay: number;
  discretionaryUsd: string;
  agentTuneRange: [number, number];
  runTimeoutSec: number;
  candidateTtlSec: number;
  /** Additive v0.9 (§11.1 deterministic scan): default 20. */
  scanSeconds?: number;
}

export interface StrategyParams {
  engine: "llm" | "rules";
  mode: ApprovalMode;
  enabled: boolean;
  portfolio: PortfolioStrategyParams;
  markets: Record<MarketId, MarketStrategyParams>;
}

/** Fields the agent scope may tune (×0.5–×1.5 of the human anchor, §7.2). */
export const AGENT_TUNABLE_FIELDS = ["entrySpreadBps", "minNetEdgeBps", "tradeSizeUsd", "cycleSeconds"] as const;
export type AgentTunableField = (typeof AGENT_TUNABLE_FIELDS)[number];

/** ate_strategy_set patch (§7.4). */
export interface StrategyPatch {
  targetAssets?: TargetAsset[];
  enabled?: boolean;
  market?: MarketId;
  minNetEdgeBps?: number;
  rebalanceTargetPct?: number;
  rebalanceBandPct?: number;
  maxPositionUsd?: string;
  tradeSizeUsd?: string;
  cycleSeconds?: number;
  entrySpreadBps?: number;
  stopLossBps?: number;
  takeProfitBps?: number;
  dailyLossLimitUsd?: string;
  maxDailyTurnoverUsd?: string;
  maxPortfolioExposureUsd?: string;
  reentryCooldownSec?: number;
  discretionaryTradesPerDay?: number;
  discretionaryUsd?: string;
  /** Additive v0.9, human scopes only: expands per RISK_PROFILES; explicit fields in the same patch win. */
  riskProfile?: RiskProfile;
  /** Additive (lane STRAT): change records only ("name v2 0xabcd…" or null); set through the strategies routes. */
  customStrategy?: string | null;
  /** Additive (lane STRAT): change records only (a custom strategy's cooldown). */
  minEntryIntervalSec?: number;
}

export type RiskProfile = "conservative" | "balanced" | "aggressive";

/** §11.5 riskProfile presets (additive v0.9). maxPositionUsd is clamped to the vault's maxExposureUsd. */
export const RISK_PROFILES: Readonly<
  Record<RiskProfile, { tradeSizeUsd: string; entrySpreadBps: number; minNetEdgeBps: number; stopLossBps: number; maxPositionUsd: string }>
> = {
  conservative: { tradeSizeUsd: "10", entrySpreadBps: 90, minNetEdgeBps: 25, stopLossBps: 200, maxPositionUsd: "75" },
  balanced: { tradeSizeUsd: "25", entrySpreadBps: 60, minNetEdgeBps: 15, stopLossBps: 300, maxPositionUsd: "150" },
  aggressive: { tradeSizeUsd: "50", entrySpreadBps: 45, minNetEdgeBps: 10, stopLossBps: 400, maxPositionUsd: "150" },
};

/** §11.5 loosening direction table (v0.9). "up" = raising loosens; "down" = lowering loosens; "any" = any change. */
export const LOOSENING_DIRECTION: Readonly<Partial<Record<keyof StrategyPatch, "up" | "down" | "any">>> = {
  stopLossBps: "up",
  dailyLossLimitUsd: "up",
  maxPositionUsd: "up",
  maxDailyTurnoverUsd: "up",
  maxPortfolioExposureUsd: "up",
  tradeSizeUsd: "up",
  discretionaryTradesPerDay: "up",
  discretionaryUsd: "up",
  rebalanceTargetPct: "up", // raise to any value > current and > 0
  entrySpreadBps: "down",
  minNetEdgeBps: "down",
  cycleSeconds: "down",
  reentryCooldownSec: "down",
  rebalanceBandPct: "down",
  takeProfitBps: "any",
  // enabled: true and adding a target asset loosen; riskProfile is judged per expanded field.
};

export interface StrategyFieldChange {
  scope: "portfolio" | MarketId;
  field: keyof StrategyPatch;
  before: unknown;
  after: unknown;
  /** Value requested before clamping, when clamped. */
  requested?: unknown;
  clampedBy?: string;
  loosening: boolean;
}

// ------------------------------------------------------------------ positions / P&L (§7.2, §11.4)

export interface Lot {
  id: string;
  market: MarketId;
  openFillId: string;
  qtyOpen: DecString;
  qtyRemaining: DecString;
  /** 8 dp, fee-inclusive. */
  entryPrice: DecString;
  realisedUsd: string;
  openedAt: UnixSec;
  closedAt: UnixSec | null;
}

export interface Fill {
  id: string;
  executionId: string;
  market: MarketId;
  generator: GeneratorId | "discretionary";
  side: Side;
  baseQty: DecString;
  quoteQty: DecString;
  price: DecString;
  cexMid: DecString | null;
  at: UnixSec;
}

export interface MarketPosition {
  market: MarketId;
  vault: Address;
  balanceQuote: DecString;
  balancePrice: DecString;
  /** priceToken held (= balancePrice), smallest units. */
  qty: DecString;
  exposureUsd: string;
  /** Average-cost entry, 8 dp, fees included; null when flat. */
  avgEntry: DecString | null;
  /** Exit-executable mark (QuoterV2 full-position sell ÷ qty), 8 dp. */
  mark: DecString | null;
  cexMid: DecString | null;
  realisedUsd: string;
  unrealisedExitUsd: string;
  unrealisedExitBps: number;
  /** Paper P&L at the on-chain oracle price (wire name kept from the earlier CEX mark). */
  unrealisedCexUsd: string;
  unrealisedCexBps: number;
  feeDragUsd: string;
  /** Spread-revert sub-ledger, reported alongside, never summed (§11.4). */
  lots: Lot[];
  lotsRealisedUsd: string;
  epoch: { spentUsd: string; capUsd: string; remainingUsd: string; resetsAt: UnixSec };
  exitReserveUsd: string;
  turnoverRemainingUsd: string;
  reentryLockUntil: UnixSec | null;
  paused: boolean;
}

export interface AiScoreboard {
  acts: number;
  vetoes: number;
  sizeDowns: number;
  savedBps: number;
  savedUsd: string;
  discretionary: number;
}

export interface PortfolioSummary {
  exposureUsd: string;
  maxPortfolioExposureUsd: string;
  dailyPnlUsd: string;
  realisedUsd: string;
  unrealisedExitUsd: string;
  unrealisedCexUsd: string;
  turnoverUsedUsd: string;
  turnoverRemainingUsd: string;
  discretionaryUsedToday: number;
  breaker: "armed" | "flattening" | "tripped";
}

export interface DaemonCounters {
  uptimeSec: number;
  startedAt: UnixSec;
  cycles: number;
  trades: number;
  hskswapTrades: number;
  routedUsd: string;
}

// ------------------------------------------------------------------ decision journal (§13)

export const DECISION_KINDS = [
  "proposal",
  "no_trade",
  "execution",
  "attestation",
  "strategy_change",
  "pause",
  "outcome",
  "payment",
  "payment_update",
  // Additive (Lane B, FREEZE-NOTES §B): Supra pull refresh tx (verifyOracleProof) sent by the daemon.
  "oracle_refresh",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** id = prefix + hash[2:18] (§13). Only prop_ and dec_ are named by the spec; the rest are freeze choices. */
export const DECISION_ID_PREFIX: Readonly<Record<DecisionKind, string>> = {
  proposal: "prop_",
  no_trade: "dec_",
  execution: "exec_",
  attestation: "att_",
  strategy_change: "strat_",
  pause: "pause_",
  outcome: "out_",
  payment: "pay_",
  payment_update: "payu_",
  oracle_refresh: "orf_",
};

export const GENESIS_PREV_HASH: Hex = `0x${"00".repeat(32)}`;

export type NoTradeReason = "no_signal" | "llm_veto" | "awaiting_signal" | "guard" | "timeout";

export interface DecisionActor {
  kind: "agent" | "human" | "guard";
  via?: "chat" | "cli" | "mcp" | "ui";
  agentId?: string;
  address?: string;
}

export interface DecisionContext {
  oracle: { price: string; updatedAt: number; roundId: string; ageSec: number };
  pool: { price: string; twap: string; liquidity: string; deviationBps: number; twapDeviationBps: number };
  cex?: { mid: string; halfSpreadBps: number; topDepthUsd: string; at: number };
  signal?: {
    id: string;
    generator: string;
    leg?: "open" | "close";
    edgeBps: number;
    costBps: number;
    paid?: { paymentId: string };
  };
  quote?: { amountOut: string; impactBps: number; minOutFloor: string; exitPath: boolean; source: "simulation" | "estimate" };
  policy: { maxTradeUsd: string; epochRemainingUsd: string; turnoverRemainingUsd: string; cooldownRemainingSec: number };
  position?: { market: string; qty: string; entry: string; mark: string; cexMarkBps: number; unrealisedBps: number };
  portfolio?: { exposureUsd: string; turnoverRemainingUsd: string; dailyPnlUsd: string };
  suppressed?: { cause: SuppressionCause; side: Side; bps: number; supra?: string };
  blockNumber: string;
}

/** §13 Decision, verbatim. */
export interface Decision {
  /** Derived: kind-prefix + hash[2:18]; excluded from the hash. */
  id: string;
  at: number;
  /** hash = keccak256(prevHash ‖ canonical(record without id and hash)). */
  prevHash: string;
  kind: DecisionKind;
  refId?: string;
  /** Freeze addition (FREEZE-NOTES §J2): the market a record concerns (no_trade has no `intent`). */
  market?: MarketId;
  engine: Engine;
  profile: Profile;
  actor: DecisionActor;
  origin?: "candidate" | "discretionary" | "guard" | "human";
  candidateId?: string;
  thesis?: string;
  intent?: { market: string; vault: string; side: "buy" | "sell"; tokenIn: string; amountIn: string };
  rationale: string;
  rationaleHash: string;
  context: DecisionContext;
  verdict: { ok: boolean; code: AteErrorCode | "OK" | "NO_TRADE"; message?: string; approvedBy?: "policy" | "human" };
  execution?: { txHash: string; blockNumber: number; gasUsed: string; amountOut: string; exitPath: boolean; reverted?: boolean };
  attestation?: { easUid: string; schemaUid: string; txHash: string };
  outcome?: { horizonSec: 1800; declinedAmountIn: string; markThen: string; savedBps: number; savedUsd: string };
  payment?: { flowId: string; paymentRequestId: string; state: string; gatewayTx?: string; attributionVerified?: boolean };
}

/** A stored journal row (§12 `decisions`). */
export interface DecisionRow {
  seq: number;
  id: string;
  at: number;
  kind: DecisionKind;
  refId: string | null;
  /** Canonical JSON (RFC 8785) of the Decision without id and hash. */
  record: string;
  prevHash: string;
  hash: string;
}

/** Decision as returned to MCP callers: `hash` included (it is the on-chain anchor for proposals). */
export type JournalEntry = Decision & { hash: string; seq: number };

// ------------------------------------------------------------------ ids

export const ID_PATTERNS = {
  candidate: /^cand_[0-9a-f]{16}$/,
  proposal: /^prop_[0-9a-f]{16}$/,
  decision: /^[a-z]+_[0-9a-f]{16}$/,
} as const;

/** Derive a journal id from its 0x-prefixed 32-byte hash (§13: prefix + hash[2:18]). */
export function decisionIdFromHash(kind: DecisionKind, hash: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new RangeError(`not a 32-byte hex hash: ${hash}`);
  return DECISION_ID_PREFIX[kind] + hash.slice(2, 18).toLowerCase();
}
