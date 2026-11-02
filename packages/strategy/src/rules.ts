// Deterministic fallback decision (`ate agent run --engine rules`, §11.1): the same candidates, no LLM.
// Decisions are labelled engine=rules and are NOT Track 1 evidence.

import { MARKETS, type Candidate, type MarketId, type Suppressed } from "@ate/core";

export type RulesAction =
  | { kind: "propose"; market: MarketId; candidate: Candidate; amountIn: string; rationale: string }
  | { kind: "no_trade"; market: MarketId; reason: "no_signal" | "guard"; rationale: string; candidateId?: string };

const rank = (c: Candidate): number => {
  if (c.generator === "custom" && c.leg === "close") return 0;
  if (c.generator === "custom") return 1;
  if (c.generator === "spread-revert" && c.leg === "close") return 0;
  if (c.generator === "spread-revert") return 1;
  if (c.generator === "rebalance") return 2;
  return 9;
};

/**
 * One action per market: guard exits are executed by the daemon without any engine (skipped here);
 * otherwise the best of spread-revert close > spread-revert open (highest net edge) > rebalance;
 * the standing discretionary_exit is never taken by rules; else no_trade.
 */
export function decideRules(markets: readonly MarketId[], candidates: readonly Candidate[], suppressed: readonly Suppressed[], now: number): RulesAction[] {
  const out: RulesAction[] = [];
  for (const market of markets) {
    const live = candidates.filter((c) => c.market === market && c.expiresAt >= now);
    const guard = live.find((c) => c.generator === "guard_exit");
    if (guard) {
      out.push({ kind: "no_trade", market, reason: "guard", candidateId: guard.candidateId, rationale: `[engine=rules] guard exit ${guard.guardReason ?? ""} in progress; the daemon executes it without the engine` });
      continue;
    }
    const pick = live
      .filter((c) => rank(c) < 9)
      .sort((a, b) => rank(a) - rank(b) || b.netEdgeBps - a.netEdgeBps)[0];
    if (pick) {
      out.push({
        kind: "propose",
        market,
        candidate: pick,
        amountIn: pick.maxAmountIn,
        rationale: `[engine=rules] ${pick.generator}${pick.leg ? `/${pick.leg}` : ""} ${pick.side} at maxAmountIn; edge ${pick.edgeBps} − cost ${pick.costBps} = net ${pick.netEdgeBps} bps. ${pick.reason}`,
      });
      continue;
    }
    const sup = suppressed.filter((s) => s.market === market).map((s) => `${s.side} suppressed (${s.cause}, ${s.bps} bps)`);
    out.push({
      kind: "no_trade",
      market,
      reason: "no_signal",
      rationale: `[engine=rules] ${MARKETS[market].label}: no entry or close candidate${sup.length ? `; ${sup.join("; ")}` : ""}`,
    });
  }
  return out;
}
