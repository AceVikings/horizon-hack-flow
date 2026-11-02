// Training (lane STRAT): concrete, tested improvements to a strategy. Each suggestion is a spec change re-run on the
// same past data, with its effect in plain words ("would have avoided 3 losing trades, +$0.42"). The AI's own review
// (daemon) adds its suggestions through `evaluateChange`. Sweeps search 2–3 numbers on the first part of the period
// and check the winner on a hold-out window it never saw, with a plain warning when it may only fit the past.

import { describeCondition, parseStrategySpec, type StrategySpec } from "@ate/core";
import { runBacktest, type BacktestResult } from "./backtest.js";
import type { SimInput } from "./sim.js";

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const money = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(2)}`;

/** A numeric field of a spec by path ("exit.takeProfitPct", "entry.conditions.0.value", "sizing.value"). */
export function getPath(spec: StrategySpec, path: string): number | undefined {
  let cur: unknown = spec;
  for (const k of path.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
  return typeof cur === "number" ? cur : undefined;
}
export function setPath(spec: StrategySpec, path: string, v: number): StrategySpec {
  const next = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  const ks = path.split(".");
  let cur = next as Record<string, unknown>;
  for (const k of ks.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[ks[ks.length - 1]!] = v;
  return next as unknown as StrategySpec;
}

export interface SpecChange {
  path: string;
  value: number;
}

export interface Suggestion {
  changes: SpecChange[];
  /** "Wait for a 1.25% gap instead of 1%". */
  sentence: string;
  /** "Would have avoided 3 losing trades and made +$0.42 more over 30 days". */
  effect: string;
  pnlDeltaUsd: number;
  losingTradesAvoided: number;
  result: Pick<BacktestResult, "pnlUsd" | "returnPct" | "trades" | "maxDrawdownPct" | "winRate">;
  spec: StrategySpec;
  source: "rules" | "ai";
  why?: string;
}

const losers = (r: BacktestResult) => r.trades.filter((t) => t.side === "sell" && (t.pnlUsd ?? 0) < 0).length;

/** Re-runs the strategy with `changes` and words the difference. null when the change does not validate. */
export function evaluateChange(base: SimInput, baseline: BacktestResult, changes: SpecChange[], sentence: string, source: "rules" | "ai", why?: string): Suggestion | null {
  let spec = base.spec;
  for (const c of changes) spec = setPath(spec, c.path, c.value);
  const ok = parseStrategySpec(spec);
  if (!ok.ok) return null;
  const r = runBacktest({ ...base, spec: ok.spec, compareTo: null });
  const delta = round(r.pnlUsd - baseline.pnlUsd);
  const avoided = losers(baseline) - losers(r);
  const parts: string[] = [];
  if (avoided > 0) parts.push(`would have avoided ${avoided} losing trade${avoided === 1 ? "" : "s"}`);
  else if (avoided < 0) parts.push(`would have had ${-avoided} more losing trade${avoided === -1 ? "" : "s"}`);
  parts.push(delta === 0 ? "made the same" : `made ${money(delta)} ${delta > 0 ? "more" : "less"}`);
  if (r.maxDrawdownPct < baseline.maxDrawdownPct - 0.05) parts.push(`a smaller worst dip (${round(-r.maxDrawdownPct)}% vs ${round(-baseline.maxDrawdownPct)}%)`);
  return {
    changes,
    sentence,
    effect: `${parts.join(", ").replace(/^./, (c) => c.toUpperCase())} over ${baseline.days} days.`,
    pnlDeltaUsd: delta,
    losingTradesAvoided: avoided,
    result: { pnlUsd: r.pnlUsd, returnPct: r.returnPct, trades: r.trades, maxDrawdownPct: r.maxDrawdownPct, winRate: r.winRate },
    spec: ok.spec,
    source,
    ...(why ? { why } : {}),
  };
}

/** Rule-based ideas, each tested on the same data; returns the ones that help, best first. */
export function suggestImprovements(base: SimInput, baseline: BacktestResult, max = 4): Suggestion[] {
  const s = base.spec;
  const ideas: { changes: SpecChange[]; sentence: string }[] = [];
  s.entry.conditions.forEach((c, k) => {
    if (c.op === "between" || c.signal === "hour") return;
    for (const f of [1.25, 1.5, 0.8]) {
      const v = round(c.value * f, 4);
      if (v === c.value) continue;
      ideas.push({ changes: [{ path: `entry.conditions.${k}.value`, value: v }], sentence: `Buy only when ${describeCondition({ ...c, value: v })}` });
    }
  });
  const x = s.exit;
  if (x.takeProfitPct) for (const f of [0.75, 1.5]) ideas.push({ changes: [{ path: "exit.takeProfitPct", value: round(x.takeProfitPct * f, 3) }], sentence: `Take profit at ${round(x.takeProfitPct * f, 3)}% instead of ${x.takeProfitPct}%` });
  if (x.stopLossPct) for (const f of [0.6, 1.5]) ideas.push({ changes: [{ path: "exit.stopLossPct", value: round(x.stopLossPct * f, 3) }], sentence: `Sell at a ${round(x.stopLossPct * f, 3)}% loss instead of ${x.stopLossPct}%` });
  if (x.trailingStopPct) ideas.push({ changes: [{ path: "exit.trailingStopPct", value: round(x.trailingStopPct * 1.5, 3) }], sentence: `Give the trailing stop more room: ${round(x.trailingStopPct * 1.5, 3)}%` });
  ideas.push({ changes: [{ path: "limits.cooldownMin", value: Math.max(30, s.limits.cooldownMin * 2) }], sentence: `Wait ${Math.max(30, s.limits.cooldownMin * 2)} minutes between buys` });
  if (s.limits.maxTradesPerDay > 1) ideas.push({ changes: [{ path: "limits.maxTradesPerDay", value: Math.max(1, Math.floor(s.limits.maxTradesPerDay / 2)) }], sentence: `Buy at most ${Math.max(1, Math.floor(s.limits.maxTradesPerDay / 2))} times a day` });
  const out: Suggestion[] = [];
  for (const i of ideas) {
    const r = evaluateChange(base, baseline, i.changes, i.sentence, "rules");
    if (r && (r.pnlDeltaUsd > 0.005 || (r.pnlDeltaUsd >= 0 && r.losingTradesAvoided > 0))) out.push(r);
  }
  // one suggestion per field, best first
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.pnlDeltaUsd - a.pnlDeltaUsd || b.losingTradesAvoided - a.losingTradesAvoided)
    .filter((sug) => {
      const k = sug.changes.map((c) => c.path).join(",");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, max);
}

// ------------------------------------------------------------------ sweep

export type SweepMetric = "pnl" | "return_per_dip" | "win_rate";

export interface SweepInput {
  base: SimInput;
  /** 1–3 numbers to vary, ≤ 6 values each. */
  params: { path: string; values: number[] }[];
  metric: SweepMetric;
  /** Share of the period kept aside to check the winner (default 0.3). */
  holdoutShare?: number;
}

export interface SweepRow {
  values: Record<string, number>;
  pnlUsd: number;
  returnPct: number;
  trades: number;
  winRate: number | null;
  maxDrawdownPct: number;
  score: number;
}

export interface SweepResult {
  rows: SweepRow[];
  best: SweepRow | null;
  /** The best settings on the hold-out window (never seen while picking). */
  holdout: { from: number; to: number; pnlUsd: number; returnPct: number; trades: number; current: { pnlUsd: number; returnPct: number } } | null;
  /** Plain warning when the winner may only fit the past (null when it held up). */
  warning: string | null;
  spec: StrategySpec | null;
  inSample: { from: number; to: number };
}

function score(r: BacktestResult, m: SweepMetric): number {
  if (m === "pnl") return r.pnlUsd;
  if (m === "win_rate") return r.winRate ?? -1;
  return r.pnlUsd / Math.max(0.01, r.maxDrawdownUsd);
}

export function sweep(o: SweepInput): SweepResult {
  const params = o.params.slice(0, 3).map((p) => ({ ...p, values: [...new Set(p.values)].slice(0, 6) }));
  const share = Math.min(0.5, Math.max(0.1, o.holdoutShare ?? 0.3));
  const { from, to } = o.base;
  const cut = Math.floor((from + (to - from) * (1 - share)) / 3600) * 3600;
  const inS = { ...o.base, to: cut };
  const combos: Record<string, number>[] = [{}];
  for (const p of params) {
    const next: Record<string, number>[] = [];
    for (const c of combos) for (const v of p.values) next.push({ ...c, [p.path]: v });
    combos.splice(0, combos.length, ...next);
  }
  const rows: SweepRow[] = [];
  for (const c of combos) {
    let spec = o.base.spec;
    for (const [k, v] of Object.entries(c)) spec = setPath(spec, k, v);
    const ok = parseStrategySpec(spec);
    if (!ok.ok) continue;
    const r = runBacktest({ ...inS, spec: ok.spec, compareTo: null });
    rows.push({ values: c, pnlUsd: r.pnlUsd, returnPct: r.returnPct, trades: r.trades.length, winRate: r.winRate, maxDrawdownPct: r.maxDrawdownPct, score: round(score(r, o.metric), 4) });
  }
  rows.sort((a, b) => b.score - a.score || b.pnlUsd - a.pnlUsd);
  const best = rows[0] ?? null;
  if (!best) return { rows, best, holdout: null, warning: "None of these settings is a valid strategy.", spec: null, inSample: { from, to: cut } };
  let spec = o.base.spec;
  for (const [k, v] of Object.entries(best.values)) spec = setPath(spec, k, v);
  const hold = { ...o.base, from: cut };
  const h = runBacktest({ ...hold, spec, compareTo: null });
  const cur = runBacktest({ ...hold, spec: o.base.spec, compareTo: null });
  const holdDays = Math.max(1, Math.round((to - cut) / 86_400));
  let warning: string | null = null;
  const perDayIn = best.pnlUsd / Math.max(1, (cut - from) / 86_400);
  const perDayOut = h.pnlUsd / Math.max(1, (to - cut) / 86_400);
  if (best.pnlUsd > 0 && h.pnlUsd < 0) warning = `The best settings made money before but lost ${money(h.pnlUsd).slice(1)} in the last ${holdDays} days, which they had not seen. They may only fit the past.`;
  else if (perDayIn > 0 && perDayOut < perDayIn * 0.5) warning = `The best settings did much worse in the last ${holdDays} days, which they had not seen. They may only fit the past.`;
  else if (h.pnlUsd < cur.pnlUsd) warning = `In the last ${holdDays} days, which they had not seen, the best settings did worse than your current ones.`;
  else if (rows.length > 1 && h.trades.length < 3) warning = `Only ${h.trades.length} trade${h.trades.length === 1 ? "" : "s"} in the last ${holdDays} days: too few to trust the result.`;
  return {
    rows,
    best,
    holdout: { from: cut, to, pnlUsd: h.pnlUsd, returnPct: h.returnPct, trades: h.trades.length, current: { pnlUsd: cur.pnlUsd, returnPct: cur.returnPct } },
    warning,
    spec,
    inSample: { from, to: cut },
  };
}
