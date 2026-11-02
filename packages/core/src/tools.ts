// MCP tool names, scope allowlists and per-tool input/output (`data`) types (§7.2, §7.4, §11.5).
// FROZEN 04:30 IST. JSON Schemas for the inputs live in @ate/mcp (packages/mcp/schemas/*.json).
// Every tool returns ToolResult<Output> (§7.5) serialised as JSON text content.

import type { Address, Hex, MarketId, Side } from "./markets.js";
import type { ChartInput, ChartSpec, DataInput, DataTable } from "./charts.js";
import type {
  AiScoreboard,
  Candidate,
  DaemonCounters,
  DecisionKind,
  JournalEntry,
  MarketPosition,
  NoTradeReason,
  PortfolioSummary,
  PriceSnapshot,
  ProposalOrigin,
  ProposalStatus,
  Quote,
  StrategyFieldChange,
  StrategyParams,
  StrategyPatch,
  Suppressed,
  UnixSec,
  VaultState,
} from "./types.js";

export const TOOL_NAMES = [
  "ate_market_get",
  "ate_candidates_get",
  "ate_quote",
  "ate_propose",
  "ate_decide",
  "ate_execute",
  "ate_positions",
  "ate_strategy_get",
  "ate_strategy_set",
  "ate_journal_read",
  "ate_signal_buy",
  "ate_pause",
  // additive (Flow v1 lane D4): read-only charts and data tables
  "ate_chart",
  "ate_data",
  // additive (lane STRAT): read-only backtest of a custom strategy; chat-proposed strategies wait for the user's OK
  "ate_backtest",
  "ate_strategy_save",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** §11.5: the only tools a `chat`-scope token sees or may call. Anything else → ATE_TOOL_NOT_ALLOWED. */
export const CHAT_TOOL_ALLOWLIST = [
  "ate_market_get",
  "ate_candidates_get",
  "ate_quote",
  "ate_positions",
  "ate_strategy_get",
  "ate_strategy_set",
  "ate_journal_read",
  "ate_pause",
  "ate_chart",
  "ate_data",
  "ate_backtest",
  "ate_strategy_save",
] as const satisfies readonly ToolName[];

/** Additive (lane STRAT): tools the trader (agent scope) never gets. */
export const AGENT_EXCLUDED_TOOLS = ["ate_strategy_save"] as const satisfies readonly ToolName[];

/** Registered only when G-HSP is go (§7.1). */
export const HSP_GATED_TOOLS = ["ate_signal_buy"] as const satisfies readonly ToolName[];

export const MUTATING_TOOLS = {
  ate_execute: "chain",
  ate_pause: "chain",
  ate_strategy_set: "config",
  ate_signal_buy: "payment",
  ate_propose: "record",
  ate_decide: "record",
} as const satisfies Partial<Record<ToolName, "chain" | "config" | "payment" | "record">>;

/** Tool set visible to a scope (server-side, §7.1). */
export function toolsForScope(scope: "agent" | "chat", opts: { hsp: boolean }): ToolName[] {
  const base: readonly ToolName[] = scope === "chat" ? CHAT_TOOL_ALLOWLIST : TOOL_NAMES.filter((t) => !(AGENT_EXCLUDED_TOOLS as readonly string[]).includes(t));
  return base.filter((t) => opts.hsp || !(HSP_GATED_TOOLS as readonly string[]).includes(t));
}

// ------------------------------------------------------------------ inputs

export interface MarketGetInput {
  market?: MarketId;
}
export interface CandidatesGetInput {
  market?: MarketId;
}
export interface QuoteInput {
  market: MarketId;
  side: Side;
  amountIn: string;
}
export interface ProposeInput {
  market: MarketId;
  side: Side;
  amountIn: string;
  candidateId?: string;
  origin?: "candidate" | "discretionary";
  thesis?: string;
  signalId?: string;
  rationale: string;
}
export interface DecideInput {
  decision: "no_trade";
  market: MarketId;
  candidateId?: string;
  reason: NoTradeReason;
  rationale: string;
}
export interface ExecuteInput {
  proposalId: string;
}
export interface PositionsInput {
  market?: MarketId;
}
export interface StrategyGetInput {
  market?: MarketId;
}
export interface StrategySetInput {
  patch: StrategyPatch;
  rationale: string;
}
export interface JournalReadInput {
  limit?: number;
  market?: MarketId;
  kind?: DecisionKind[];
  since?: UnixSec;
  before?: UnixSec;
  id?: string;
}
export interface SignalBuyInput {
  offerId: string;
  rationale: string;
}
export interface PauseInput {
  rationale: string;
}

// ------------------------------------------------------------------ outputs (`data`)

export interface MarketView extends PriceSnapshot {
  vault: VaultState;
  /** Exit-executable mark for the vault's full position (QuoterV2), 8 dp; null when flat. */
  exitMark: string | null;
  recentPoolSwaps?: { txHash: Hex; side: Side; amountUsd: string; sender: Address; at: UnixSec }[];
}
export interface MarketGetOutput {
  markets: MarketView[];
}

export interface CandidatesGetOutput {
  candidates: Candidate[];
  suppressed: Suppressed[];
  candidateTtlSec: number;
  cycle: number;
  generatedAt: UnixSec;
}

export type QuoteOutput = Quote;

export interface ProposeOutput {
  proposalId: string;
  /** Full journal hash = on-chain proposalId. */
  journalHash: Hex;
  status: ProposalStatus;
  origin: ProposalOrigin;
  candidateId: string | null;
  expiresAt: UnixSec;
  quote: Quote;
  reservedTurnoverUsd: string;
  approvedBy: "policy" | "human" | null;
}

export interface DecideOutput {
  decisionId: string;
  hash: Hex;
  at: UnixSec;
}

export interface ExecuteOutput {
  proposalId: string;
  executionId: string;
  txHash: Hex;
  blockNumber: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  quoterOut: string;
  notionalUsdE8: string;
  exitPath: boolean;
  rationaleHash: Hex;
  /** Attestation is asynchronous (lowest TxQueue priority, §13). */
  attestation: { status: "queued" | "deferred"; decisionId?: string };
}

export interface PositionsOutput {
  markets: MarketPosition[];
  portfolio: PortfolioSummary;
  scoreboard: AiScoreboard;
  counters: DaemonCounters;
}

export interface StrategyGetOutput {
  strategy: StrategyParams;
  /** Human anchors the agent's tuning is clamped to (§7.2). */
  anchors: Record<MarketId, Pick<StrategyParams["markets"][MarketId], "entrySpreadBps" | "minNetEdgeBps" | "tradeSizeUsd" | "cycleSeconds">>;
  updatedAt: UnixSec;
}

export interface StrategySetOutput {
  status: "applied";
  decisionId: string;
  changes: StrategyFieldChange[];
  clamped: boolean;
  strategy: StrategyParams;
}

/** `error.details` of an ATE_APPROVAL_REQUIRED result from ate_strategy_set (§11.5). */
export interface StrategyApprovalPending {
  changeId: string;
  diff: StrategyFieldChange[];
  renderedDiff: string;
  expiresAt: UnixSec;
}

export interface JournalReadOutput {
  entries: JournalEntry[];
  head: { seq: number; hash: Hex };
}

export interface SignalBuyOutput {
  paymentId: string;
  state: string;
  approvalsRequired: 2;
}

export interface PauseOutput {
  vaults: { market: MarketId; vault: Address; txHash: Hex; status: "submitted" | "already_paused" }[];
  decisionId: string;
  daemonLocked: true;
}

/** Tool name → [input, output] map for typed clients/servers. */
export interface ToolIO {
  ate_market_get: [MarketGetInput, MarketGetOutput];
  ate_candidates_get: [CandidatesGetInput, CandidatesGetOutput];
  ate_quote: [QuoteInput, QuoteOutput];
  ate_propose: [ProposeInput, ProposeOutput];
  ate_decide: [DecideInput, DecideOutput];
  ate_execute: [ExecuteInput, ExecuteOutput];
  ate_positions: [PositionsInput, PositionsOutput];
  ate_strategy_get: [StrategyGetInput, StrategyGetOutput];
  ate_strategy_set: [StrategySetInput, StrategySetOutput];
  ate_journal_read: [JournalReadInput, JournalReadOutput];
  ate_signal_buy: [SignalBuyInput, SignalBuyOutput];
  ate_pause: [PauseInput, PauseOutput];
  ate_chart: [ChartInput, ChartSpec];
  ate_data: [DataInput, DataTable];
  ate_backtest: [BacktestToolInput, unknown];
  ate_strategy_save: [StrategySaveInput, { status: "needs_confirmation"; pendingId: string; name: string; sentences: string[]; hint: string }];
}

/** Additive (lane STRAT). Omit both strategyId and specJson to list saved strategies. */
export interface BacktestToolInput {
  strategyId?: string;
  /** A flow.strategy/v1 spec as a JSON string. */
  specJson?: string;
  days?: 7 | 30 | 90;
}
export interface StrategySaveInput {
  specJson: string;
  rationale: string;
}
export type ToolInput<T extends ToolName> = ToolIO[T][0];
export type ToolOutput<T extends ToolName> = ToolIO[T][1];

/** Wraps agent-authored text for the chat agent (§11.5). */
export function wrapUntrusted(text: string): string {
  return `<untrusted_agent_text>${text}</untrusted_agent_text>`;
}
