// StrategyGuard (§11.4 rules 1–9 incl. 3b), run at propose and again at execute (§7.3).

import {
  MARKETS,
  type GuardExemption,
  type GuardRule,
  type GuardVerdict,
  type Invalidation,
  type LiveCandidate,
  type PortfolioState,
  type ProposalDraft,
  type StrategyGuard,
} from "@ate/core";
import { entryIntervalRemaining } from "./engine.js";
import { effectiveMarketParams, isTargeted, portfolioExposureE8, positionCapE8, turnoverAllocationE8 } from "./params.js";
import { exitReserveOk } from "./sizing.js";
import { currentInvalidation } from "./reservations.js";
import { E8, clampNonNeg, minB, usdE8, usdStr } from "./units.js";

/** v0.1 maxima for the discretionary lane (§11.4 rule 8). */
export const DISCRETIONARY_MAX_PER_DAY = 3;
export const DISCRETIONARY_MAX_USD = "10";
export const THESIS_MIN_CHARS = 40;

type Fail = Extract<GuardVerdict, { ok: false }>;

function fail(code: Fail["code"], rule: GuardRule, message: string, hint: string, retryable: boolean): Fail {
  return { ok: false, code, rule, message, hint, retryable };
}

const ACTIVE = new Set(["proposed", "awaiting_human", "approved"]);

/** Trade classification used by rules 3, 3b, 5, 7, 9. */
export interface TradeClass {
  guardExit: boolean;
  /** Turnover-exempt: guard exits, discretionary_exit, spread-revert close, rebalance sells at target 0. */
  turnoverExempt: boolean;
  /** Non-exit trade (an "entry"): rules 3, 5 (buys), 7, 9 apply. */
  entry: boolean;
}

export function classify(p: ProposalDraft, cand: LiveCandidate | undefined, pf: PortfolioState): TradeClass {
  const gen = cand?.generator ?? p.generator;
  const leg = cand?.leg ?? p.leg;
  const guardExit = p.origin === "guard" || gen === "guard_exit";
  if (p.side === "sell") {
    if (guardExit) return { guardExit: true, turnoverExempt: true, entry: false };
    if (gen === "discretionary_exit") return { guardExit: false, turnoverExempt: true, entry: false };
    if (gen === "spread-revert" && leg === "close") return { guardExit: false, turnoverExempt: true, entry: false };
    if (gen === "rebalance" && (pf.strategy.markets[p.market]?.rebalanceTargetPct === 0 || !isTargeted(p.market, pf.strategy))) {
      return { guardExit: false, turnoverExempt: true, entry: false };
    }
  }
  return { guardExit, turnoverExempt: guardExit, entry: !guardExit };
}

export interface GuardOptions {
  invalidation?: Pick<Invalidation, "isInvalidated">;
}

export function checkProposal(p: ProposalDraft, pf: PortfolioState, phase: "propose" | "execute", opts: GuardOptions = {}): GuardVerdict {
  const market = p.market;
  const label = MARKETS[market]?.label ?? market;
  const raw = pf.strategy.markets[market];
  const book = pf.markets[market];
  if (!raw || !book) return fail("ATE_STRATEGY_BLOCKED", "market_disabled", `no strategy state for ${market}`, "Check the strategy config", false);
  const m = effectiveMarketParams(market, raw);
  const notional = BigInt(p.notionalUsdE8);
  const notes: string[] = [];
  const exemptions: GuardExemption[] = [];
  const own = p.proposalId ? pf.openProposals.find((o) => o.proposalId === p.proposalId) : undefined;

  // §11.4 Invalidation.
  if (p.proposalId && (opts.invalidation?.isInvalidated(p.proposalId) || own?.status === "invalidated")) {
    return fail("ATE_STRATEGY_BLOCKED", "invalidated", `proposal ${p.proposalId} was invalidated by a guard exit or the breaker`, "Re-read candidates and propose again", false);
  }

  // Rule 1: candidate binding (autonomous, non-discretionary, non-guard).
  let cand: LiveCandidate | undefined;
  if (p.candidateId) cand = pf.candidates[p.candidateId];
  const bound = p.mode === "autonomous" && p.origin !== "discretionary" && p.origin !== "guard";
  if (bound) {
    if (!p.candidateId) {
      return fail("ATE_CANDIDATE_REQUIRED", "candidate_binding", "autonomous proposals must bind a candidateId (or use origin=discretionary with a thesis)", "Call ate_candidates_get and bind a candidate", false);
    }
    if (!cand) return fail("ATE_CANDIDATE_MISMATCH", "candidate_binding", `unknown candidate ${p.candidateId}`, "Call ate_candidates_get for live candidates", false);
    if (cand.market !== market || cand.side !== p.side) {
      return fail("ATE_CANDIDATE_MISMATCH", "candidate_binding", `candidate ${cand.candidateId} is ${cand.market} ${cand.side}, proposal is ${market} ${p.side}`, "Market and side must match the candidate", false);
    }
    if (BigInt(p.amountIn) > BigInt(cand.maxAmountIn)) {
      return fail("ATE_CANDIDATE_MISMATCH", "candidate_binding", `amountIn ${p.amountIn} > candidate maxAmountIn ${cand.maxAmountIn}`, "Size down to ≤ maxAmountIn", false);
    }
    if (phase === "propose" && pf.at > cand.expiresAt) {
      return fail("ATE_CANDIDATE_MISMATCH", "candidate_binding", `candidate ${cand.candidateId} expired at ${cand.expiresAt}`, "Re-read candidates", false);
    }
    if (cand.consumedBy && cand.consumedBy !== p.proposalId) {
      return fail("ATE_CANDIDATE_MISMATCH", "candidate_binding", `candidate ${cand.candidateId} already used by ${cand.consumedBy}`, "Candidates are single-use", false);
    }
  }
  const cls = classify(p, cand, pf);
  if (cls.guardExit) exemptions.push("turnover", "exit_reserve", "edge_gate");
  else if (cls.turnoverExempt) exemptions.push("turnover", "edge_gate");

  // Rule 9 (+ market enabled): no entries on a de-selected / disabled market.
  if (cls.entry && !isTargeted(market, pf.strategy)) {
    return fail("ATE_STRATEGY_BLOCKED", "target_assets", `${label} is not a target asset (targetAssets: [${pf.strategy.portfolio.targetAssets.join(", ")}])`, "Only exits are allowed on de-selected markets", false);
  }
  if (cls.entry && (!pf.strategy.enabled || raw.enabled === false)) {
    return fail("ATE_STRATEGY_BLOCKED", "market_disabled", `strategy disabled for ${label}`, "Enable the strategy to trade", false);
  }

  // Rule 6: daily loss breaker — entries blocked once tripped / flattening or past the limit.
  if (cls.entry) {
    const limit = usdE8(pf.strategy.portfolio.dailyLossLimitUsd);
    if (pf.breaker.state !== "armed" || usdE8(pf.dailyPnlUsd) <= -limit) {
      return fail("ATE_STRATEGY_BLOCKED", "daily_loss_breaker", `daily loss breaker ${pf.breaker.state} (daily P&L ${pf.dailyPnlUsd} USD, limit −${pf.strategy.portfolio.dailyLossLimitUsd})`, "Only exits until the next UTC day", true);
    }
  }

  // Rule 5: re-entry lock after a guard exit (buys only; sells always allowed).
  if (cls.entry && p.side === "buy" && book.reentryLockUntil !== null && pf.at < book.reentryLockUntil) {
    return fail("ATE_STRATEGY_BLOCKED", "reentry_lock", `${label} re-entry lock until ${book.reentryLockUntil} (${book.reentryLockUntil - pf.at} s)`, "Wait for the lock to expire", true);
  }

  // Rule 8: discretionary lane.
  if (p.origin === "discretionary" && p.mode === "autonomous") {
    const perDay = Math.min(pf.strategy.portfolio.discretionaryTradesPerDay, DISCRETIONARY_MAX_PER_DAY);
    const capE8 = minB(usdE8(pf.strategy.portfolio.discretionaryUsd), usdE8(DISCRETIONARY_MAX_USD));
    const thesis = (p.thesis ?? "").trim();
    if (thesis.length < THESIS_MIN_CHARS) {
      return fail("ATE_DISCRETIONARY_LIMIT", "discretionary_limit", `thesis must be ≥ ${THESIS_MIN_CHARS} chars (why, invalidation, exit plan); got ${thesis.length}`, "Write a full thesis", false);
    }
    if (notional > capE8) {
      return fail("ATE_DISCRETIONARY_LIMIT", "discretionary_limit", `discretionary notional ${usdStr(notional)} > ${usdStr(capE8)} USD`, `Size down to ≤ $${usdStr(capE8)}`, false);
    }
    const ownReserved = phase === "execute" && own?.origin === "discretionary" ? 1 : 0;
    const used = pf.discretionary.executedToday + pf.discretionary.reservedToday - ownReserved;
    if (used >= perDay) {
      return fail("ATE_DISCRETIONARY_LIMIT", "discretionary_limit", `discretionary lane used ${used}/${perDay} today (UTC)`, "Next UTC day", true);
    }
  }

  // Rule 7: frequency (entries only; exits never throttled).
  if (cls.entry) {
    const wait = entryIntervalRemaining(pf, market, pf.at);
    if (wait > 0) {
      return fail("ATE_STRATEGY_BLOCKED", "frequency", `${label}: next entry allowed in ${wait} s (minEntryIntervalSec / one entry per cycle)`, "Wait for the entry interval", true);
    }
    const other = pf.openProposals.find(
      (o) => o.market === market && o.proposalId !== p.proposalId && ACTIVE.has(o.status) && o.origin !== "guard" && o.expiresAt >= pf.at && (o.side === "buy" || Number(o.reservedTurnoverUsd) > 0),
    );
    if (other) {
      return fail("ATE_STRATEGY_BLOCKED", "frequency", `${label}: another entry proposal ${other.proposalId} is open`, "At most one entry per market per cycle", true);
    }
  }

  // Rule 2: position limits (buys only).
  if (p.side === "buy" && !cls.guardExit) {
    const exp = usdE8(book.exposureUsd);
    const cap = positionCapE8(m, book.vault);
    if (exp + notional > cap) {
      return fail("ATE_STRATEGY_BLOCKED", "position_limit", `${label} exposure ${usdStr(exp)} + ${usdStr(notional)} > maxPositionUsd ${usdStr(cap)}`, `Size down to ≤ $${usdStr(clampNonNeg(cap - exp))}`, false);
    }
    const pfExp = portfolioExposureE8(pf);
    const pfCap = usdE8(pf.strategy.portfolio.maxPortfolioExposureUsd);
    if (pfExp + notional > pfCap) {
      return fail("ATE_STRATEGY_BLOCKED", "portfolio_exposure", `portfolio exposure ${usdStr(pfExp)} + ${usdStr(notional)} > ${usdStr(pfCap)}`, `Size down to ≤ $${usdStr(clampNonNeg(pfCap - pfExp))}`, false);
    }
  }

  // Rule 3: daily turnover budget (portfolio, allocated per market).
  let reserveTurnover = 0n;
  if (!cls.turnoverExempt) {
    const ownRes = phase === "execute" && own ? usdE8(own.reservedTurnoverUsd) : 0n;
    const alloc = turnoverAllocationE8(market, pf.strategy, book.vault);
    const mUsed = usdE8(book.turnover.usedUsd) + usdE8(book.turnover.reservedUsd) - ownRes;
    if (mUsed + notional > alloc) {
      return fail("ATE_STRATEGY_BLOCKED", "turnover_budget", `${label} turnover ${usdStr(mUsed)} + ${usdStr(notional)} > allocation ${usdStr(alloc)} (UTC day)`, `Remaining ${usdStr(clampNonNeg(alloc - mUsed))} USD`, true);
    }
    const budget = minB(usdE8(pf.turnover.budgetUsd), usdE8(pf.strategy.portfolio.maxDailyTurnoverUsd));
    const pUsed = usdE8(pf.turnover.usedUsd) + usdE8(pf.turnover.reservedUsd) - ownRes;
    if (pUsed + notional > budget) {
      return fail("ATE_STRATEGY_BLOCKED", "turnover_budget", `portfolio turnover ${usdStr(pUsed)} + ${usdStr(notional)} > ${usdStr(budget)} (UTC day)`, "Daily turnover spent", true);
    }
    reserveTurnover = notional;
  }

  // Rule 3b: exit reserve (non-guard trades).
  if (!cls.guardExit) {
    const r = exitReserveOk(book.vault, pf.at, p.side, notional);
    if (!r.ok) {
      return fail(
        "ATE_STRATEGY_BLOCKED",
        "exit_reserve",
        `${label} exit reserve: epoch remaining after trade ${usdStr(r.remainingAfterE8)} < exposure reserve ${usdStr(r.requiredE8)} USD`,
        "The epoch budget a stop-out needs is reserved; only guard exits may spend it",
        true,
      );
    }
  } else notes.push("guard exit: turnover- and exit-reserve-exempt; still bound on-chain");

  return {
    ok: true,
    reserve: {
      market,
      turnoverUsd: usdStr(reserveTurnover, 8),
      discretionary: p.origin === "discretionary" ? 1 : 0,
      ...(p.candidateId ? { candidateId: p.candidateId } : {}),
    },
    exemptions,
    ...(notes.length ? { notes } : {}),
  };
}

export function createStrategyGuard(opts: GuardOptions = {}): StrategyGuard {
  return {
    check: (p, pf, phase) => {
      const inv = opts.invalidation ?? currentInvalidation() ?? undefined;
      return checkProposal(p, pf, phase, inv ? { ...opts, invalidation: inv } : opts);
    },
  };
}

export { E8 };
