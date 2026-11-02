// Reservations (§7.3) and Invalidation (§11.4). In-memory, deterministic; the daemon persists the
// resulting proposal statuses in the journal.

import {
  type GuardExitReason,
  type Invalidation,
  type MarketId,
  type OpenProposal,
  type ReleaseCause,
  type ReservationClaim,
  type Reservations,
} from "@ate/core";
import { usdE8, usdStr } from "./units.js";

export interface ReservationLedger extends Reservations {
  /** Turnover converted to used by `release(id, "executed")`, per market (E8 USD as decimal string). */
  used(): { turnoverUsd: string; discretionary: number; byMarket: Record<string, string> };
  /** New UTC day: clears used counters (open reservations stay). */
  resetDay(): void;
}

export function createReservations(): ReservationLedger {
  const open = new Map<string, ReservationClaim>();
  const usedByMarket = new Map<MarketId, bigint>();
  let usedDisc = 0;

  return {
    reserve(proposalId, claim) {
      if (open.has(proposalId)) return; // idempotent: execute re-validates, never re-reserves
      open.set(proposalId, { ...claim });
    },
    release(proposalId, cause = "expired") {
      const c = open.get(proposalId);
      if (!c) return;
      open.delete(proposalId);
      if (cause === "executed") {
        usedByMarket.set(c.market, (usedByMarket.get(c.market) ?? 0n) + usdE8(c.turnoverUsd));
        usedDisc += c.discretionary;
      }
    },
    get(proposalId) {
      const c = open.get(proposalId);
      return c ? { ...c } : undefined;
    },
    totals() {
      let t = 0n;
      let d = 0;
      const by: Record<string, bigint> = {};
      for (const c of open.values()) {
        const x = usdE8(c.turnoverUsd);
        t += x;
        d += c.discretionary;
        by[c.market] = (by[c.market] ?? 0n) + x;
      }
      return {
        turnoverUsd: usdStr(t, 8),
        discretionary: d,
        byMarket: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, usdStr(v, 8)])) as Record<MarketId, string>,
      };
    },
    used() {
      let t = 0n;
      const by: Record<string, string> = {};
      for (const [k, v] of usedByMarket) {
        t += v;
        by[k] = usdStr(v, 8);
      }
      return { turnoverUsd: usdStr(t, 8), discretionary: usedDisc, byMarket: by };
    },
    resetDay() {
      usedByMarket.clear();
      usedDisc = 0;
    },
  };
}

const OPEN_STATUSES = new Set(["proposed", "awaiting_human", "approved"]);

export interface InvalidationTracker extends Invalidation {
  /** Log of invalidations (for journalling). */
  history(): { proposalId: string; market: MarketId; cause: GuardExitReason | "breaker" }[];
}

let lastInvalidation: InvalidationTracker | null = null;

/**
 * The most recently created Invalidation. `createStrategyGuard()` without options consults it, so a daemon
 * that creates the seam objects independently (engine, guard, reservations, invalidation) still gets
 * execute-time ATE_STRATEGY_BLOCKED on invalidated proposals.
 */
export function currentInvalidation(): InvalidationTracker | null {
  return lastInvalidation;
}

/**
 * Invalidation: a guard exit on a market invalidates every open BUY proposal on it; the breaker on both
 * markets. Their reservations are released with cause "invalidated".
 */
export function createInvalidation(openProposals: () => OpenProposal[], reservations: Pick<Reservations, "release">): InvalidationTracker {
  const invalid = new Set<string>();
  const log: { proposalId: string; market: MarketId; cause: GuardExitReason | "breaker" }[] = [];
  const hit = (filter: (p: OpenProposal) => boolean, cause: GuardExitReason | "breaker"): string[] => {
    const ids: string[] = [];
    for (const p of openProposals()) {
      if (p.side !== "buy" || !OPEN_STATUSES.has(p.status) || invalid.has(p.proposalId) || !filter(p)) continue;
      invalid.add(p.proposalId);
      reservations.release(p.proposalId, "invalidated" satisfies ReleaseCause);
      log.push({ proposalId: p.proposalId, market: p.market, cause });
      ids.push(p.proposalId);
    }
    return ids;
  };
  const tracker: InvalidationTracker = {
    onGuardExit: (market, reason) => hit((p) => p.market === market, reason),
    onBreaker: () => hit(() => true, "breaker"),
    isInvalidated: (id) => invalid.has(id),
    history: () => [...log],
  };
  lastInvalidation = tracker;
  return tracker;
}
