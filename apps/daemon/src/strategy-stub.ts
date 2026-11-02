// Lane B pass-through strategy seam (§21.4): guard rules 1–3 only, simple reservations/invalidation and a
// candidate engine that emits only `discretionary_exit` (+ the one-shot `smoke` candidate added by the service).
// Lane C's @ate/strategy replaces all of it (loadStrategy below prefers it when present).
// The autonomous trader must never run on this stub (§21.4).

import {
  MARKETS,
  MARKET_IDS,
  e8ToUsd,
  minBig,
  sellAmountForUsdCap,
  usdToE8,
  type Candidate,
  type CandidateEngine,
  type GuardVerdict,
  type Invalidation,
  type MarketId,
  type MarketSnapshot,
  type OpenProposal,
  type PortfolioState,
  type ProposalDraft,
  type ReleaseCause,
  type ReservationClaim,
  type Reservations,
  type StrategyGuard,
  type Suppressed,
} from "@ate/core";
import { keccak256, toBytes } from "viem";

export const THESIS_MIN = 40;

export function candidateIdFor(parts: string): string {
  return `cand_${keccak256(toBytes(parts)).slice(2, 18)}`;
}

const blocked = (rule: Extract<GuardVerdict, { ok: false }>["rule"], code: Extract<GuardVerdict, { ok: false }>["code"], message: string, hint: string, retryable = code !== "ATE_CANDIDATE_MISMATCH" && code !== "ATE_CANDIDATE_REQUIRED"): GuardVerdict => ({
  ok: false,
  code,
  rule,
  message,
  hint,
  retryable,
});

const isExitGen = (g?: string) => g === "guard_exit" || g === "discretionary_exit";

export class StubGuard implements StrategyGuard {
  constructor(private readonly invalidated: (id: string) => boolean = () => false) {}

  check(p: ProposalDraft, pf: PortfolioState, phase: "propose" | "execute"): GuardVerdict {
    const notional = BigInt(p.notionalUsdE8);
    if (p.proposalId && this.invalidated(p.proposalId)) {
      return blocked("invalidated", "ATE_STRATEGY_BLOCKED", "proposal invalidated by a guard exit or breaker", "Re-read candidates and propose again");
    }
    let discretionary: 0 | 1 = 0;
    // Rule 1: candidate binding (autonomous) / discretionary lane.
    if (p.mode === "autonomous" && (p.origin === "candidate" || p.origin === "discretionary")) {
      if (p.origin === "discretionary") {
        if (!p.thesis || p.thesis.trim().length < THESIS_MIN) {
          return blocked("candidate_binding", "ATE_CANDIDATE_REQUIRED", `origin=discretionary requires a thesis (≥ ${THESIS_MIN} chars)`, "Add a thesis: why, what would prove it wrong, exit plan");
        }
        if (notional > usdToE8(pf.strategy.portfolio.discretionaryUsd)) {
          return blocked("discretionary_limit", "ATE_DISCRETIONARY_LIMIT", `discretionary notional ${e8ToUsd(notional)} > discretionaryUsd ${pf.strategy.portfolio.discretionaryUsd}`, `Reduce amountIn to ≤ $${pf.strategy.portfolio.discretionaryUsd} notional`);
        }
        if (phase === "propose" && pf.discretionary.executedToday + pf.discretionary.reservedToday >= pf.strategy.portfolio.discretionaryTradesPerDay) {
          return blocked("discretionary_limit", "ATE_DISCRETIONARY_LIMIT", "discretionaryTradesPerDay reached", "Wait for the next UTC day");
        }
        discretionary = 1;
      } else {
        if (!p.candidateId) return blocked("candidate_binding", "ATE_CANDIDATE_REQUIRED", "autonomous mode: bind to a candidateId or use origin=discretionary with a thesis", "Call ate_candidates_get and pass one candidateId");
        const c = pf.candidates[p.candidateId];
        if (!c) return blocked("candidate_binding", "ATE_CANDIDATE_MISMATCH", `unknown or expired candidate ${p.candidateId}`, "Call ate_candidates_get for current candidates");
        if (phase === "propose" && (c.expiresAt < pf.at || c.consumedBy)) {
          return blocked("candidate_binding", "ATE_CANDIDATE_MISMATCH", `candidate ${p.candidateId} expired or already used`, "Call ate_candidates_get for current candidates");
        }
        if (c.market !== p.market || c.side !== p.side) {
          return blocked("candidate_binding", "ATE_CANDIDATE_MISMATCH", `candidate is ${c.market} ${c.side}`, `Use market=${c.market} side=${c.side}`);
        }
        if (BigInt(p.amountIn) > BigInt(c.maxAmountIn)) {
          return blocked("candidate_binding", "ATE_CANDIDATE_MISMATCH", `amountIn ${p.amountIn} > maxAmountIn ${c.maxAmountIn}`, `Reduce amountIn to ≤ ${c.maxAmountIn}`);
        }
      }
    }
    const book = pf.markets[p.market];
    const ms = pf.strategy.markets[p.market];
    if (pf.strategy.markets[p.market]?.enabled === false) return blocked("market_disabled", "ATE_STRATEGY_BLOCKED", `${p.market} disabled`, "Enable the market via ate_strategy_set");
    const exit = p.side === "sell" || isExitGen(p.generator);
    // Rule 2: position limit + portfolio exposure (buys only).
    if (p.side === "buy" && book && ms) {
      const exp = usdToE8(book.exposureUsd) + notional;
      if (exp > usdToE8(ms.maxPositionUsd)) {
        return blocked("position_limit", "ATE_STRATEGY_BLOCKED", `position would be $${e8ToUsd(exp)} > maxPositionUsd $${ms.maxPositionUsd}`, "Reduce size or sell first");
      }
      let pfExp = 0n;
      for (const m of MARKET_IDS) pfExp += usdToE8(pf.markets[m]?.exposureUsd ?? "0");
      if (pfExp + notional > usdToE8(pf.strategy.portfolio.maxPortfolioExposureUsd)) {
        return blocked("portfolio_exposure", "ATE_STRATEGY_BLOCKED", `portfolio exposure would exceed $${pf.strategy.portfolio.maxPortfolioExposureUsd}`, "Reduce size or sell first");
      }
    }
    // Rule 3: turnover budget (entries; exits exempt).
    let turnoverUsd = "0";
    if (!exit && book) {
      const left = usdToE8(book.turnover.allocationUsd) - usdToE8(book.turnover.usedUsd) - (phase === "propose" ? usdToE8(book.turnover.reservedUsd) : 0n);
      if (notional > left) {
        return blocked("turnover_budget", "ATE_STRATEGY_BLOCKED", `turnover left $${e8ToUsd(left > 0n ? left : 0n)} < notional $${e8ToUsd(notional)}`, "Trade smaller or wait for the next UTC day");
      }
      turnoverUsd = e8ToUsd(notional);
    }
    return {
      ok: true,
      reserve: { market: p.market, turnoverUsd, discretionary, ...(p.candidateId ? { candidateId: p.candidateId } : {}) },
      exemptions: exit ? ["turnover", "exit_reserve"] : [],
      notes: ["lane-b stub guard (rules 1–3)"],
    };
  }
}

export class StubReservations implements Reservations {
  private m = new Map<string, ReservationClaim>();
  used = new Map<MarketId, bigint>();
  reserve(id: string, c: ReservationClaim) {
    this.m.set(id, c);
  }
  release(id: string, cause: ReleaseCause = "expired") {
    const c = this.m.get(id);
    if (!c) return;
    this.m.delete(id);
    if (cause === "executed") this.used.set(c.market, (this.used.get(c.market) ?? 0n) + usdToE8(c.turnoverUsd));
  }
  get(id: string) {
    return this.m.get(id);
  }
  totals() {
    const byMarket = Object.fromEntries(MARKET_IDS.map((m) => [m, "0"])) as Record<MarketId, string>;
    let t = 0n;
    let d = 0;
    for (const c of this.m.values()) {
      const v = usdToE8(c.turnoverUsd);
      t += v;
      d += c.discretionary;
      byMarket[c.market] = e8ToUsd(usdToE8(byMarket[c.market]) + v);
    }
    return { turnoverUsd: e8ToUsd(t), discretionary: d, byMarket };
  }
}

export class StubInvalidation implements Invalidation {
  private inv = new Set<string>();
  constructor(
    private readonly open: () => OpenProposal[],
    private readonly res: Pick<Reservations, "release">,
  ) {}
  onGuardExit(market: MarketId): string[] {
    const ids = this.open().filter((p) => p.market === market && p.side === "buy").map((p) => p.proposalId);
    for (const id of ids) {
      this.inv.add(id);
      this.res.release(id, "invalidated");
    }
    return ids;
  }
  onBreaker(): string[] {
    const ids = this.open().filter((p) => p.side === "buy").map((p) => p.proposalId);
    for (const id of ids) {
      this.inv.add(id);
      this.res.release(id, "invalidated");
    }
    return ids;
  }
  isInvalidated(id: string) {
    return this.inv.has(id);
  }
}

/** Emits only the standing `discretionary_exit` (§7.2) per market whose vault holds its priceToken. */
export class StubCandidateEngine implements CandidateEngine {
  run(snaps: Record<MarketId, MarketSnapshot>, pf: PortfolioState): { candidates: Candidate[]; suppressed: Suppressed[] } {
    const out: Candidate[] = [];
    for (const m of MARKET_IDS) {
      const s = snaps[m];
      if (!s || !s.vault || s.vault.address === "0x0000000000000000000000000000000000000000") continue;
      const bal = BigInt(s.vault.balancePrice);
      if (bal === 0n || s.price.readOnly) continue;
      const P = BigInt(s.price.oracle.price);
      const T = s.price.pool.twap ? BigInt(s.price.pool.twap) : null;
      const capE8 = minBig(BigInt(s.vault.limits.maxTradeUsdE8), BigInt(s.vault.epoch.capUsdE8) - BigInt(s.vault.epoch.spentUsdE8));
      if (capE8 <= 0n || P === 0n) continue;
      const max = minBig(bal, sellAmountForUsdCap(capE8, P, T, MARKETS[m].baseDecimals));
      if (max <= 0n) continue;
      out.push({
        candidateId: candidateIdFor(`${m}|discretionary_exit|${pf.at}|${max}`),
        market: m,
        generator: "discretionary_exit",
        side: "sell",
        maxAmountIn: max.toString(),
        edgeBps: 0,
        costBps: 30,
        netEdgeBps: -30,
        reason: "Standing discretionary exit: sell up to the position, trade cap and epoch remaining (lane-b stub)",
        expiresAt: pf.at + pf.candidateTtlSec,
        createdAt: pf.at,
      });
    }
    return { candidates: out, suppressed: [] };
  }
}

export interface StrategyImpl {
  source: "lane-c" | "lane-b-stub";
  engine: CandidateEngine;
  guard: StrategyGuard;
  reservations: Reservations;
  invalidation: Invalidation;
}

/** Prefer Lane C's @ate/strategy (createCandidateEngine/createStrategyGuard/createReservations/createInvalidation). */
export async function loadStrategy(openProposals: () => OpenProposal[], opts: { forceStub?: boolean } = {}): Promise<StrategyImpl> {
  if (!opts.forceStub) {
    try {
      const name = "@ate/strategy";
      const mod = (await import(name)) as Record<string, unknown>;
      if (typeof mod.createCandidateEngine === "function" && typeof mod.createStrategyGuard === "function" && typeof mod.createReservations === "function" && typeof mod.createInvalidation === "function") {
        const reservations = (mod.createReservations as () => Reservations)();
        const invalidation = (mod.createInvalidation as (o: () => OpenProposal[], r: Reservations) => Invalidation)(openProposals, reservations);
        return {
          source: "lane-c",
          engine: (mod.createCandidateEngine as () => CandidateEngine)(),
          guard: (mod.createStrategyGuard as () => StrategyGuard)(),
          reservations,
          invalidation,
        };
      }
    } catch {
      /* fall back to the stub */
    }
  }
  const reservations = new StubReservations();
  const invalidation = new StubInvalidation(openProposals, reservations);
  return { source: "lane-b-stub", engine: new StubCandidateEngine(), guard: new StubGuard((id) => invalidation.isInvalidated(id)), reservations, invalidation };
}
