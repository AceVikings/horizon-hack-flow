// docs/replay-7d.md renderer (E11). Labelled counterfactual, from logs, not realised P&L.

import { MARKETS } from "@ate/core";
import { fmtDur, type MarketReplay } from "./sim.js";

const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const usd = (x: number | null) => (x === null ? "n/a" : `$${x.toFixed(2)}`);
/** Short name of the replay's reference price. */
const refOf = (r: MarketReplay) => ((r.params.reference ?? "cex") === "cex" ? "CEX" : "TWAP");

export function headline(r: MarketReplay): string {
  const m = MARKETS[r.market];
  const fired = r.fired.buy + r.fired.sell;
  if (r.cyclesWithData === 0) return `${m.label}: no data`;
  if (fired === 0) {
    return `${m.label}: 0 of ${r.cyclesWithData} cycles cleared fee + impact${r.params.halfSpreadBps ? " + half-spread" : ""} + ${r.params.minNetEdgeBps} bps (median gap ${r.gapDist.p50} bps vs cost ~${(r.params.feeBps + r.params.halfSpreadBps).toFixed(0)}+ bps) — the market gave no edge after fees; the agent correctly did nothing. Gap verdict: ${r.verdict}.`;
  }
  return `${m.label}: ${fired} of ${r.cyclesWithData} cycles fired spread-revert (${r.fired.buy} buy / ${r.fired.sell} sell), mean counterfactual net edge ${r.counterfactual.firedMeanNetBps} bps (${usd(r.counterfactual.firedMeanNetUsd)} per $${r.params.tradeSizeUsd}); ${r.counterfactual.taken} would have been taken under the default-profile caps (close leg realised ${usd(r.counterfactual.realisedUsd)} on ${r.counterfactual.closedLots} lots; ${r.counterfactual.openLots} lots still open at ${usd(r.counterfactual.openExitUsd)} exit-executable / ${usd(r.counterfactual.openCexUsd)} ${refOf(r)}-marked); gap > cost in ${(r.shareAboveCost * 100).toFixed(1)}% of cycles; verdict: ${r.verdict}.`;
}

export function renderReport(rs: MarketReplay[], meta: { generatedAt: number; days: number; source: string; notes: string[] }): string {
  const L: string[] = [];
  L.push(`# ATE replay — last ${meta.days} days (E11)`);
  L.push("");
  L.push(`> **Counterfactual, from logs, not realised P&L.** Generated ${iso(meta.generatedAt)} by \`ate replay --days ${meta.days}\`. ${meta.source}`);
  L.push("");
  L.push("## Headline");
  L.push("");
  for (const r of rs) L.push(`- ${headline(r)}`);
  L.push("");
  for (const r of rs) {
    const m = MARKETS[r.market];
    const p = r.params;
    const ref = refOf(r);
    L.push(`## ${m.label} — \`${r.market}\``);
    L.push("");
    L.push(`Window ${iso(r.from)} → ${iso(r.to)}; cycle ${p.cycleSeconds} s; default profile: entrySpreadBps ${p.entrySpreadBps}, minNetEdgeBps ${p.minNetEdgeBps}, tradeSizeUsd $${p.tradeSizeUsd}, fee ${p.feeBps} bps, ${ref === "CEX" ? `reference HashKey Global, CEX half-spread ${p.halfSpreadBps} bps (median top of book at run time)` : "reference the pool's 300 s TWAP (on-chain; no half-spread)"}, minEntryIntervalSec ${p.minEntryIntervalSec}, daily turnover share $${p.dailyTurnoverUsd}, maxPositionUsd $${p.maxPositionUsd}.`);
    L.push("");
    L.push("| Metric | Value |");
    L.push("|---|---|");
    L.push(`| Pool swaps / volume | ${r.swaps} / $${r.volumeUsd.toLocaleString("en-US")} |`);
    L.push(`| Unique swap senders (top sender share) | ${r.uniqueSenders}${r.topSender ? ` (\`${r.topSender.address.slice(0, 8)}…\` ${(r.topSender.share * 100).toFixed(0)}%)` : ""} |`);
    L.push(`| Cycles evaluated (with pool + ${ref} data) | ${r.cycles} (${r.cyclesWithData}) |`);
    if (ref === "CEX") L.push(`| CEX 1 m klines with no trade (close carried forward) | ${(r.cexNoTradeMinutesShare * 100).toFixed(0)}% |`);
    L.push(`| Candidates fired — spread-revert buy / sell | ${r.fired.buy} / ${r.fired.sell} |`);
    L.push(`| Rejected on net edge (gap ≥ ${p.entrySpreadBps} but net < ${p.minNetEdgeBps}) | ${r.rejectedNetEdge} |`);
    L.push(`| Below entry spread (gap < ${p.entrySpreadBps} bps) | ${r.belowEntrySpread} |`);
    L.push(`| edgeBps − costBps: p10 / p50 / p90 / max | ${r.netEdgeDist.p10} / ${r.netEdgeDist.p50} / ${r.netEdgeDist.p90} / ${r.netEdgeDist.max} |`);
    L.push(`| Counterfactual net edge per fired candidate | ${r.counterfactual.firedMeanNetBps ?? "n/a"} bps = ${usd(r.counterfactual.firedMeanNetUsd)} at $${p.tradeSizeUsd} (Σ over all fired: ${usd(r.counterfactual.firedSumNetUsd)}) |`);
    L.push(`| Taken under rule 3/7 + position caps (buys) | ${r.counterfactual.taken} (Σ net edge at entry ${usd(r.counterfactual.takenSumNetUsd)}) |`);
    L.push(`| Close leg: lots closed / realised (exit-executable) | ${r.counterfactual.closedLots} / ${usd(r.counterfactual.realisedUsd)} |`);
    L.push(`| Open lots at window end: exit-executable / ${ref}-marked | ${r.counterfactual.openLots} lots: ${usd(r.counterfactual.openExitUsd)} / ${usd(r.counterfactual.openCexUsd)} |`);
    L.push(`| Signed gap (pool − ${ref}) bps: min / p10 / p50 / p90 / max | ${r.gapDist.min} / ${r.gapDist.p10} / ${r.gapDist.p50} / ${r.gapDist.p90} / ${r.gapDist.max} |`);
    L.push(`| Share of cycles with |gap| > cost | ${(r.shareAboveCost * 100).toFixed(1)}% |`);
    L.push(`| Episodes |gap| > cost (closed / still open) | ${r.episodes.count} (${r.episodes.closed} / ${r.episodes.open}) |`);
    L.push(`| Median time for a gap > cost to fall below cost | ${r.episodes.medianTimeToCloseSec === null ? "n/a (none closed)" : fmtDur(r.episodes.medianTimeToCloseSec)} |`);
    L.push(`| Longest episode | ${fmtDur(r.episodes.longestSec)} |`);
    L.push(`| **Verdict** | **${r.verdict}** |`);
    L.push("");
    L.push(`### Top-decile gaps (${m.label}, one row per hour) — default-profile decision`);
    L.push("");
    L.push("| Time (UTC) | Gap bps | Cost bps | Net bps | Decision |");
    L.push("|---|---|---|---|---|");
    for (const t of r.topDecile) L.push(`| ${iso(t.at)} | ${t.gapBps} | ${t.costBps} | ${t.netBps} | ${t.decision} |`);
    L.push("");
  }
  L.push("## Method and caveats");
  L.push("");
  L.push("- Pool price per cycle = price after the last `Swap` at or before the cycle (from `sqrtPriceX96` in the event); impact for a `tradeSizeUsd` buy from the event's active `liquidity` (V3 in-range approximation).");
  if (rs.some((r) => (r.params.reference ?? "cex") === "cex")) {
    L.push("- CEX reference (optional; the earlier reference) = HashKey Global 1 m kline close (`/quote/v1/klines`, `hashkey-public-market` endpoint map); the half-spread is a constant read from the live top of book at run time.");
    L.push("- The kline close is the last trade price, not a book mid: on HSKUSDT the 0.0001 tick is ~11 bps of price, and on BTCUSDT many minutes have no trade (share above), so a stale close inflates |gap| in both directions. Treat single-cycle gaps as noisy; the persistence statistics and the realised close-leg result are the robust numbers.");
    L.push("- The pool price only moves on swaps (few per day on WBTC/USDT), so a gap is frequently the CEX moving while the pool stands still; a buy marked at the CEX shows paper edge that is realised only if a later swap moves the pool toward the CEX.");
  }
  if (rs.some((r) => r.params.reference === "twap")) {
    L.push("- On-chain reference = the pool's 300 s TWAP, rebuilt from its own `Swap` logs (time-weighted step price, the quantity `observe()` returns). The live agent measures the pool against the on-chain oracle (Supra, the feed the vault checks); that feed keeps no readable price history, so the replay uses the pool TWAP instead and says so here.");
    L.push("- A TWAP gap opens only when a swap moves the spot away from the last five minutes' average, so it measures swap-driven dislocation that the pool tends to revert.");
  }
  L.push("- One-legged: a spread-revert buy realises only if the pool reverts toward the reference (close leg, fee-inclusive exit mark ≥ entry + minNetEdgeBps). Our own trades' pool impact is not simulated; sells need inventory and are counted as fired, not taken.");
  L.push("- A zero or negative result is stated as such: the market gave no edge after fees, and the agent correctly did nothing.");
  for (const n of meta.notes) L.push(`- ${n}`);
  L.push("");
  return L.join("\n");
}
