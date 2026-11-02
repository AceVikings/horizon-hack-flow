// The B↔C strategy seam (§21.4). FROZEN 04:30 IST.
//
// Lane B (daemon) builds MarketSnapshot / PortfolioState each cycle and calls these interfaces;
// Lane B ships a pass-through stub (rules 1–3); Lane C replaces it with the full guard (§11.4 rules 1–9
// incl. 3b), reservations, invalidation and the FIFO lot sub-ledger. Shared contract-test fixtures:
// `@ate/core/fixtures`.

import type { AteErrorCode } from "./errors.js";
import type { Address, MarketId, Side } from "./markets.js";
import type { ReasonCode } from "./reasons.js";
import type {
  ApprovalMode,
  Candidate,
  DecString,
  DecisionActor,
  GeneratorId,
  GuardExitReason,
  Lot,
  PriceSnapshot,
  ProposalOrigin,
  ProposalStatus,
  StrategyFieldChange,
  StrategyParams,
  StrategyPatch,
  Suppressed,
  TokenScope,
  UnixSec,
  VaultState,
} from "./types.js";

// ------------------------------------------------------------------ inputs

/** One QuoterV2 sample used for sizing (impactBps(size), §11.3). */
export interface ImpactPoint {
  amountIn: DecString;
  amountOut: DecString;
  impactBps: number;
}

/** Everything a generator needs for one market, read in the cycle's single Multicall3 (§11.2). */
export interface MarketSnapshot {
  market: MarketId;
  at: UnixSec;
  price: PriceSnapshot;
  vault: VaultState;
  feeBps: number;
  /** QuoterV2 samples, ascending by amountIn, per side (tokenIn units). */
  impact: { buy: ImpactPoint[]; sell: ImpactPoint[] };
  /** QuoterV2 full-position sell ÷ qty, 8 dp; null when flat (§11.4 rule 4 mark). */
  exitMark: DecString | null;
  /**
   * check() pre-filter for a nominal buy at tradeSizeUsd (§11.3): the reason code the vault would return.
   * null when not evaluated (e.g. market not a target asset).
   */
  prefilterBuy: { reason: ReasonCode; notionalUsdE8: DecString; deviationBps: number } | null;
}

export interface PositionBook {
  /** priceToken held, smallest units. */
  qty: DecString;
  /** Average-cost entry, 8 dp, fee-inclusive; null when flat. */
  avgEntry: DecString | null;
  realisedUsd: string;
  /** Open spread-revert lots (FIFO sub-ledger). */
  lots: Lot[];
}

export interface MarketBook {
  market: MarketId;
  position: PositionBook;
  exposureUsd: string;
  /** §11.4 rule 5. */
  reentryLockUntil: UnixSec | null;
  /** Last non-exit entry executed (rule 7 frequency). */
  lastEntryAt: UnixSec | null;
  lastGuardExitAt: UnixSec | null;
  turnover: { allocationUsd: string; usedUsd: string; reservedUsd: string };
  /** On-chain vault view (epoch spent/cap, limits) for rule 3b. */
  vault: VaultState;
}

export interface LiveCandidate extends Candidate {
  consumedBy: string | null;
}

export interface OpenProposal {
  proposalId: string;
  market: MarketId;
  side: Side;
  origin: ProposalOrigin;
  status: ProposalStatus;
  amountIn: DecString;
  reservedTurnoverUsd: string;
  createdAt: UnixSec;
  expiresAt: UnixSec;
}

export interface PortfolioState {
  at: UnixSec;
  /** UTC day "YYYY-MM-DD" (turnover, discretionary counts, breaker are per UTC day). */
  utcDay: string;
  mode: ApprovalMode;
  /** Effective params (human anchors + agent tuning). */
  strategy: StrategyParams;
  markets: Record<MarketId, MarketBook>;
  turnover: { budgetUsd: string; usedUsd: string; reservedUsd: string };
  discretionary: { executedToday: number; reservedToday: number };
  /** Realised + unrealised (exit-executable) P&L for the UTC day across both vaults. */
  dailyPnlUsd: string;
  breaker: { state: "armed" | "flattening" | "tripped"; since: UnixSec | null };
  /** Live candidates by id (rule 1 binding). */
  candidates: Record<string, LiveCandidate>;
  openProposals: OpenProposal[];
  candidateTtlSec: number;
}

/** What the guard checks at propose and again at execute (§7.3, §11.4). */
export interface ProposalDraft {
  /** Present at execute (and after the propose record is written). */
  proposalId?: string;
  market: MarketId;
  side: Side;
  tokenIn: Address;
  amountIn: DecString;
  /** Notional at Pcap from check()/quote, 8-dp USD units. */
  notionalUsdE8: DecString;
  origin: ProposalOrigin;
  candidateId?: string;
  thesis?: string;
  /** Generator of the bound candidate, when any (exemptions in rule 3 depend on it). */
  generator?: GeneratorId;
  leg?: "open" | "close";
  exitPath?: boolean;
  actor: DecisionActor;
  scope: TokenScope | "internal";
  mode: ApprovalMode;
}

// ------------------------------------------------------------------ outputs

export type GuardRule =
  | "candidate_binding" // 1
  | "position_limit" // 2
  | "portfolio_exposure" // 2
  | "turnover_budget" // 3
  | "exit_reserve" // 3b
  | "stop_loss" // 4 (informational: exits are generated, not blocked)
  | "reentry_lock" // 5
  | "daily_loss_breaker" // 6
  | "frequency" // 7
  | "discretionary_limit" // 8
  | "target_assets" // 9
  | "market_disabled"
  | "invalidated"; // §11.4 Invalidation

export type GuardExemption = "turnover" | "exit_reserve" | "edge_gate";

export interface ReservationClaim {
  market: MarketId;
  turnoverUsd: string;
  discretionary: 0 | 1;
  candidateId?: string;
}

export type GuardVerdict =
  | {
      ok: true;
      /** What to reserve at propose (re-validated, not re-reserved, at execute). */
      reserve: ReservationClaim;
      exemptions: GuardExemption[];
      notes?: string[];
    }
  | {
      ok: false;
      code: Extract<
        AteErrorCode,
        "ATE_STRATEGY_BLOCKED" | "ATE_CANDIDATE_REQUIRED" | "ATE_CANDIDATE_MISMATCH" | "ATE_DISCRETIONARY_LIMIT"
      >;
      rule: GuardRule;
      message: string;
      hint: string;
      retryable: boolean;
    };

export type ReleaseCause = "executed" | "expired" | "rejected" | "invalidated" | "failed";

// ------------------------------------------------------------------ frozen interfaces

/** Per-market generator (§11.3). Pure and synchronous: all chain/CEX reads are in the snapshot. */
export interface CandidateGenerator {
  readonly id: GeneratorId;
  generate(snap: MarketSnapshot, pf: PortfolioState): Candidate[];
}

/** Strategy + portfolio guard (§11.4 rules 1–9), run at propose and again at execute. */
export interface StrategyGuard {
  check(p: ProposalDraft, pf: PortfolioState, phase: "propose" | "execute"): GuardVerdict;
}

/** Turnover / discretionary reservations (§7.3). */
export interface Reservations {
  reserve(proposalId: string, claim: ReservationClaim): void;
  /** "executed" converts the reservation into used turnover; every other cause frees it. */
  release(proposalId: string, cause?: ReleaseCause): void;
  get(proposalId: string): ReservationClaim | undefined;
  totals(): { turnoverUsd: string; discretionary: number; byMarket: Record<MarketId, string> };
}

/** §11.4 Invalidation: guard exits / breaker invalidate open buys (and release their reservations). */
export interface Invalidation {
  /** Returns the invalidated proposal ids (open buys on `market`). */
  onGuardExit(market: MarketId, reason: GuardExitReason): string[];
  /** Breaker: open buys on both markets. */
  onBreaker(): string[];
  isInvalidated(proposalId: string): boolean;
}

// ------------------------------------------------------------------ freeze additions (lanes may use)

/** Runs every enabled generator for every market and applies the suppression pre-filter (§11.3). */
export interface CandidateEngine {
  run(snaps: Record<MarketId, MarketSnapshot>, pf: PortfolioState): { candidates: Candidate[]; suppressed: Suppressed[] };
}

/** ate_strategy_set clamping and loosening detection (§7.2, §11.5). */
export interface StrategyPatcher {
  apply(
    patch: StrategyPatch,
    scope: "agent" | "chat" | "ui" | "session",
    current: StrategyParams,
    anchors: StrategyParams,
    vaults: Record<MarketId, VaultState>,
  ): { next: StrategyParams; changes: StrategyFieldChange[]; clamped: boolean; needsApproval: boolean };
}
