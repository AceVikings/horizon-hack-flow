// `--engine rules` executor and runner-side MCP duties (timeout record, deterministic scan).
// Rules decisions are labelled engine=rules in their rationale and are not Track 1 evidence.

import { MARKET_IDS, type Candidate, type MarketId } from "@ate/core";
import { decideRules, newlyOpenedEntryMarkets } from "@ate/strategy";
import type { AteTools } from "./mcp.js";
import type { CycleExecutor, CycleOutcome } from "./runner.js";

const clip = (s: string) => (s.length > 1000 ? s.slice(0, 997) + "…" : s.length < 16 ? s.padEnd(16, ".") : s);

export function createRulesExecutor(tools: () => Promise<AteTools>, opts: { markets?: MarketId[]; dryRun?: boolean; log?: (m: string) => void } = {}): CycleExecutor {
  return {
    async run(ctx): Promise<CycleOutcome> {
      const t = await tools();
      const c = await t.call("ate_candidates_get", {});
      if (!c.ok) return { ok: false, summary: `ate_candidates_get: ${c.error.code} ${c.error.message}` };
      // Expiry is judged on the daemon's clock (generatedAt), not ours.
      const acts = decideRules(opts.markets ?? [...MARKET_IDS], c.data.candidates, c.data.suppressed, c.data.generatedAt);
      const lines: string[] = [];
      for (const a of acts) {
        if (ctx.signal.aborted) break;
        if (a.kind === "no_trade") {
          const r = await t.call("ate_decide", { decision: "no_trade", market: a.market, reason: a.reason, rationale: clip(a.rationale), ...(a.candidateId ? { candidateId: a.candidateId } : {}) });
          lines.push(`${a.market}: no_trade(${a.reason}) ${r.ok ? r.data.decisionId : r.error.code}`);
          continue;
        }
        const p = await t.call("ate_propose", { market: a.market, side: a.candidate.side, amountIn: a.amountIn, candidateId: a.candidate.candidateId, origin: "candidate", rationale: clip(a.rationale) });
        if (!p.ok) {
          const d = await t.call("ate_decide", { decision: "no_trade", market: a.market, reason: "guard", candidateId: a.candidate.candidateId, rationale: clip(`[engine=rules] proposal rejected: ${p.error.code} ${p.error.message}`) });
          lines.push(`${a.market}: propose rejected ${p.error.code} → ${d.ok ? d.data.decisionId : d.error.code}`);
          continue;
        }
        if (opts.dryRun) {
          lines.push(`${a.market}: proposed ${p.data.proposalId} (dry run, not executed)`);
          continue;
        }
        const x = await t.call("ate_execute", { proposalId: p.data.proposalId });
        lines.push(`${a.market}: ${x.ok ? `executed ${x.data.txHash}` : `execute failed ${x.error.code}`}`);
      }
      return { ok: true, summary: lines.join("; ") };
    },
  };
}

/** §11.1: the killed run is recorded as ate_decide { reason: "timeout" } (engine=rules) on each market. */
export async function writeTimeoutRecords(t: AteTools, cycle: number, timeoutSec: number, markets: readonly MarketId[] = MARKET_IDS): Promise<string[]> {
  const ids: string[] = [];
  for (const market of markets) {
    const r = await t.call("ate_decide", {
      decision: "no_trade",
      market,
      reason: "timeout",
      rationale: `[engine=rules] runner killed LLM cycle ${cycle} after ${timeoutSec} s; its open proposals expire normally and their reservations are released`,
    });
    if (r.ok) ids.push(r.data.decisionId);
  }
  return ids;
}

/** Deterministic scan: returns markets where an entry candidate just opened (→ out-of-schedule cycle). */
export function createScanner(t: () => Promise<AteTools>) {
  let prev: Candidate[] | null = null;
  return async (): Promise<MarketId[]> => {
    const r = await (await t()).call("ate_candidates_get", {});
    if (!r.ok) return [];
    const opened = prev === null ? [] : newlyOpenedEntryMarkets(prev, r.data.candidates);
    prev = r.data.candidates;
    return opened;
  };
}
