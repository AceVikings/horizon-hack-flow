// CandidateEngine (freeze addition): runs every enabled generator per market and applies entry gating
// and the suppression pre-filter (§11.3 check() pre-filter, Supra gate; §11.4 rules 5, 6, 7, 9).

import {
  ReasonCode,
  type Candidate,
  type CandidateEngine,
  type MarketId,
  type MarketSnapshot,
  type PortfolioState,
  type Suppressed,
  type SuppressionCause,
} from "@ate/core";
import { discretionaryExitDrafts, finalize, guardExitDrafts, rebalanceDrafts, spreadRevertDrafts, type DraftCandidate } from "./generators.js";
import { effectiveMarketParams, isTargeted, minEntryIntervalSec } from "./params.js";
import { CustomState, customDrafts, LiveHistory, recordSnapshot } from "./custom/live.js";

/** Price history and per-market state for custom strategies (one per daemon process). */
export const customHistory = new LiveHistory();
const customState = new CustomState();

/** Supra–APRO disagreement above which entries are withheld (§5.1, config `supra.maxDisagreeBps`). */
export const SUPRA_MAX_DISAGREE_BPS = 250;
/** Slack on the "one entry per cycleSeconds" rule so a cycle that fires a few seconds early is not suppressed. */
export const CYCLE_SLACK_SEC = 10;

export interface EngineOptions {
  supraMaxDisagreeBps?: number;
}

export interface EntryGate {
  allowed: boolean;
  /** Present when the gate produces a `suppressed` record (§11.3). */
  cause?: SuppressionCause;
  bps?: number;
  /** Silent block (no suppressed record): reentry lock, breaker, read-only, de-selected. */
  note?: string;
}

/** Rule 7: seconds until the next entry is allowed on `market` (0 = now). */
export function entryIntervalRemaining(pf: PortfolioState, market: MarketId, now: number): number {
  const book = pf.markets[market];
  const raw = pf.strategy.markets[market];
  if (!book || !raw || book.lastEntryAt === null) return 0;
  const m = effectiveMarketParams(market, raw);
  const since = now - book.lastEntryAt;
  const need = Math.max(minEntryIntervalSec(market, m), m.cycleSeconds - CYCLE_SLACK_SEC);
  return since >= need ? 0 : need - since;
}

export function entryGate(snap: MarketSnapshot, pf: PortfolioState, side: "buy" | "sell", netEdgeBps: number, opts: EngineOptions = {}): EntryGate {
  const market = snap.market;
  const book = pf.markets[market];
  if (!isTargeted(market, pf.strategy)) return { allowed: false, note: "not a target asset" };
  if (pf.breaker.state !== "armed") return { allowed: false, note: `breaker ${pf.breaker.state}` };
  if (snap.price.readOnly) return { allowed: false, note: "market read-only (APRO unavailable)" };
  if (side === "buy" && book?.reentryLockUntil != null && snap.at < book.reentryLockUntil) {
    return { allowed: false, note: `re-entry lock until ${book.reentryLockUntil}` };
  }
  if (side === "buy" && snap.prefilterBuy && snap.prefilterBuy.reason === ReasonCode.ERR_ORACLE_DEVIATION) {
    return { allowed: false, cause: "deviation", bps: snap.prefilterBuy.deviationBps };
  }
  const supra = snap.price.supra;
  const maxDis = opts.supraMaxDisagreeBps ?? SUPRA_MAX_DISAGREE_BPS;
  if (supra && supra.active && supra.disagreeBps !== null && supra.disagreeBps > maxDis) {
    return { allowed: false, cause: "oracle_disagree", bps: supra.disagreeBps };
  }
  if (entryIntervalRemaining(pf, market, snap.at) > 0) return { allowed: false, cause: "entry_interval", bps: Math.round(netEdgeBps) };
  return { allowed: true };
}

export interface EngineResult {
  candidates: Candidate[];
  suppressed: Suppressed[];
  /** Per-market notes for blocked entries without a suppression record (journal/LLM context). */
  notes: Record<string, string[]>;
}

export function runEngine(snaps: Partial<Record<MarketId, MarketSnapshot>>, pf: PortfolioState, opts: EngineOptions = {}): EngineResult {
  const candidates: Candidate[] = [];
  const suppressed: Suppressed[] = [];
  const notes: Record<string, string[]> = {};
  for (const market of Object.keys(snaps).sort() as MarketId[]) {
    const snap = snaps[market];
    if (!snap) continue;
    const raw = pf.strategy.markets[market];
    if (!raw) continue;
    const mNotes: string[] = (notes[market] = []);
    if (snap.vault.paused) {
      mNotes.push("vault paused: nothing executes, including guard exits");
      continue;
    }
    const drafts: DraftCandidate[] = [];
    const guard = guardExitDrafts(snap, pf);
    drafts.push(...guard);
    const gens = raw.generators;
    recordSnapshot(customHistory, snap);
    const custom = raw.custom ?? null;
    if (custom) {
      // the user's own strategy replaces the open-entry generators (spread-revert closes of older lots stay)
      drafts.push(...spreadRevertDrafts(snap, pf).filter((d) => d.leg === "close"));
      const r = customDrafts(snap, pf, custom, customHistory, customState);
      drafts.push(...r.drafts);
      mNotes.push(...r.notes);
    } else {
      drafts.push(...spreadRevertDrafts(snap, pf).filter((d) => d.leg === "close" || gens.includes("spread-revert")));
      drafts.push(...rebalanceDrafts(snap, pf));
    }
    drafts.push(...discretionaryExitDrafts(snap, pf));
    const seen = new Set<string>();
    for (const d of drafts) {
      // While a guard exit is live on a market, its entries are withheld.
      if (d.entry && guard.length > 0) {
        mNotes.push(`${d.generator} ${d.side} withheld: guard exit (${guard[0]!.guardReason}) in progress`);
        continue;
      }
      if (d.entry) {
        const g = entryGate(snap, pf, d.side, d.netEdgeBps, opts);
        if (!g.allowed) {
          if (g.cause) {
            const key = `${g.cause}:${d.side}`;
            if (!seen.has(key)) {
              seen.add(key);
              suppressed.push({ market, side: d.side, cause: g.cause, bps: g.bps ?? 0 });
            }
          } else mNotes.push(`${d.generator} ${d.side} withheld: ${g.note}`);
          continue;
        }
      }
      const c = finalize(d, snap, pf);
      if (d.generator === "custom" && custom) c.strategy = { id: custom.id, version: custom.version, hash: custom.hash, name: custom.name, kind: custom.kind };
      candidates.push(c);
    }
  }
  return { candidates, suppressed, notes };
}

export function createCandidateEngine(opts: EngineOptions = {}): CandidateEngine {
  return {
    run(snaps, pf) {
      const r = runEngine(snaps, pf, opts);
      return { candidates: r.candidates, suppressed: r.suppressed };
    },
  };
}

/** Did a scan open an entry candidate on a market that had none in the previous scan? (§11.1 out-of-schedule cycle) */
export function newlyOpenedEntryMarkets(prev: Candidate[], next: Candidate[]): MarketId[] {
  const isEntry = (c: Candidate) => (c.generator === "spread-revert" && c.leg === "open") || (c.generator === "rebalance" && c.side === "buy") || (c.generator === "custom" && c.leg === "open");
  const before = new Set(prev.filter(isEntry).map((c) => c.market));
  return [...new Set(next.filter(isEntry).map((c) => c.market))].filter((m) => !before.has(m));
}
