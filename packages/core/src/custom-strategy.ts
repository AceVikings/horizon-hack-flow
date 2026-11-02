// Custom strategies (lane STRAT, additive): a declarative, versioned strategy spec the user writes (in plain words,
// drafted by the AI, or in the form), shown back as sentences, backtested, and fed to the candidate engine.
// The guard (§11.4) and the vault limits (§4) always apply on top; a spec can never exceed them.
// Pure (no node imports): the desktop renderer validates and describes specs with the same code.

import { z } from "zod";

export const STRATEGY_SPEC_SCHEMA = "flow.strategy/v1" as const;

/** Signals a condition can test. Values are in % unless noted. */
export const SIGNAL_IDS = [
  "gap_cex", // pool vs HashKey Global, (pool − cex) / cex in %
  "gap_oracle", // pool vs the vault oracle, in %
  "change", // pool price change over `windowMin` minutes, in %
  "ema", // price distance from its EMA(period bars), in %
  "sma", // price distance from its SMA(period bars), in %
  "vwap", // price distance from its rolling VWAP(period bars), in %
  "rsi", // RSI(period) 0–100
  "bollinger", // %B of Bollinger(period, 2σ): 0 = lower band, 1 = upper band
  "hour", // UTC hour 0–23 (use op "between")
  "pnl", // open position P&L in % (exit-executable); exits only
  // price action and market conditions (all causal, from the pool bars)
  "ma_cross", // fast MA (period) vs slow MA (period2) distance in %; crosses_above 0 = golden cross
  "resistance", // price vs the highest close of the previous `period` bars, in % (> 0 = breakout)
  "support", // price vs the lowest close of the previous `period` bars, in % (< 0 = breakdown)
  "volatility", // standard deviation of bar-to-bar moves over `period` bars, in %
  "trend", // EMA(period) change over the last `period` bars, in % (> 0 = uptrend)
  "volume", // pool volume over the last `period` bars vs its usual level (100 = normal)
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

export const ConditionSchema = z
  .object({
    signal: z.enum(SIGNAL_IDS),
    /** crosses_above / crosses_below: true only on the bar where the value crosses `value`. */
    op: z.enum(["above", "below", "between", "crosses_above", "crosses_below"]),
    value: z.number().finite(),
    value2: z.number().finite().optional(),
    /** Bars for ema/sma/vwap/rsi/bollinger. */
    period: z.number().int().min(2).max(200).optional(),
    /** Slow MA bars for ma_cross. */
    period2: z.number().int().min(2).max(400).optional(),
    /** Price the indicator reads: "pool" = the HSKSwap pool (default; the oracle price fills bars without a swap),
     *  "oracle" = the on-chain oracle. "cex" is kept for old specs only. Gaps and P&L ignore it. */
    source: z.enum(["pool", "oracle", "cex"]).optional(),
    /** ma_cross: "ema" (default) or "sma". */
    ma: z.enum(["ema", "sma"]).optional(),
    /** Minutes for `change`. */
    windowMin: z.number().int().min(1).max(7 * 24 * 60).optional(),
  })
  .strict()
  .refine((c) => c.op !== "between" || c.value2 !== undefined, { message: "a 'between' condition needs value2" });
export type Condition = z.infer<typeof ConditionSchema>;

export const StrategySpecSchema = z
  .object({
    schema: z.literal(STRATEGY_SPEC_SCHEMA).default(STRATEGY_SPEC_SCHEMA),
    name: z.string().trim().min(1).max(60),
    /** rules: fully deterministic. ai: rules make the candidates, the AI may skip or buy less (never more). */
    kind: z.enum(["rules", "ai"]),
    markets: z.array(z.enum(["HSK", "BTC"])).min(1).max(2),
    /** Bar size for indicators and the backtest grid. */
    barMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(60)]).default(5),
    entry: z.object({ when: z.enum(["all", "any"]).default("all"), conditions: z.array(ConditionSchema).min(1).max(6) }).strict(),
    exit: z
      .object({
        when: z.literal("any").default("any"),
        conditions: z.array(ConditionSchema).max(6).default([]),
        takeProfitPct: z.number().min(0.05).max(50).optional(),
        stopLossPct: z.number().min(0.1).max(50).optional(),
        trailingStopPct: z.number().min(0.1).max(50).optional(),
        maxHoldHours: z.number().min(0.25).max(24 * 30).optional(),
      })
      .strict(),
    sizing: z.object({ mode: z.enum(["usd", "pct"]), value: z.number().positive() }).strict(),
    limits: z
      .object({
        maxTradesPerDay: z.number().int().min(1).max(48),
        cooldownMin: z.number().int().min(0).max(24 * 60),
      })
      .strict(),
    /** AI-guided only: the user's plain-language instructions, shown to the AI with every candidate. */
    instructions: z.string().trim().max(1000).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.sizing.mode === "pct" && s.sizing.value > 100) ctx.addIssue({ code: "custom", path: ["sizing", "value"], message: "a share of the budget is at most 100%" });
    if (s.sizing.mode === "usd" && s.sizing.value > 10_000) ctx.addIssue({ code: "custom", path: ["sizing", "value"], message: "trade size is at most $10,000" });
    for (const c of s.entry.conditions) if (c.signal === "pnl") ctx.addIssue({ code: "custom", path: ["entry"], message: "position P&L can only be used to sell" });
    const exits = s.exit.conditions.length + (s.exit.takeProfitPct ? 1 : 0) + (s.exit.stopLossPct ? 1 : 0) + (s.exit.trailingStopPct ? 1 : 0) + (s.exit.maxHoldHours ? 1 : 0);
    if (exits === 0) ctx.addIssue({ code: "custom", path: ["exit"], message: "say when to sell: a take-profit, a stop, a trailing stop, a time limit or a rule" });
  });
export type StrategySpec = z.infer<typeof StrategySpecSchema>;
export type StrategySpecInput = z.input<typeof StrategySpecSchema>;

/** A saved strategy (daemon store): every edit is a new version with its own spec hash. */
export interface SavedStrategy {
  id: string;
  version: number;
  /** sha256 of the canonical spec JSON, "0x…". */
  hash: string;
  spec: StrategySpec;
  sentences: string[];
  createdAt: number;
  updatedAt: number;
  /** Markets it is in use on now. */
  activeOn: ("HSK" | "BTC")[];
  lastBacktest: BacktestSummary | null;
  /** Lessons from training (versioned with the strategy). */
  lessons?: string[];
}

/** One-line result of a backtest, for lists. */
export interface BacktestSummary {
  at: number;
  days: number;
  returnPct: number;
  pnlUsd: number;
  trades: number;
  worstDipPct: number;
  /** "Over 30 days: +1.2%, 14 trades, worst dip −0.6%". */
  line: string;
}

/** The active custom strategy on a market (additive `MarketStrategyParams.custom`). */
export interface CustomStrategyRef {
  id: string;
  version: number;
  hash: string;
  name: string;
  kind: "rules" | "ai";
  spec: StrategySpec;
}

export function parseStrategySpec(x: unknown): { ok: true; spec: StrategySpec } | { ok: false; errors: string[] } {
  const r = StrategySpecSchema.safeParse(x);
  if (r.success) return { ok: true, spec: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`) };
}

/** Canonical JSON (sorted keys) — the input of the spec hash. */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

// ------------------------------------------------------------------ sentences

const pct = (v: number) => `${trim(Math.abs(v))}%`;
function trim(v: number): string {
  return String(Math.round(v * 100) / 100);
}
const hh = (h: number) => `${String(Math.floor(((h % 24) + 24) % 24)).padStart(2, "0")}:00`;
const usd = (v: number) => (Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`);
const ASSET: Record<"HSK" | "BTC", string> = { HSK: "HSK", BTC: "BTC" };

/** One condition as words ("the pool price is more than 1% under HashKey Global"). */
export function describeCondition(c: Condition): string {
  const v = c.value;
  if (c.op === "crosses_above" || c.op === "crosses_below") {
    const up = c.op === "crosses_above";
    if (c.signal === "ma_cross" && v === 0) return `the ${c.period ?? 20}-bar ${(c.ma ?? "ema").toUpperCase()} crosses ${up ? "above" : "below"} the ${c.period2 ?? 50}-bar one`;
    if (c.signal === "rsi") return `RSI(${c.period ?? 14}) crosses ${up ? "above" : "below"} ${trim(v)}`;
    if ((c.signal === "ema" || c.signal === "sma") && v === 0) return `the price crosses ${up ? "above" : "below"} its ${c.period ?? 20}-bar ${c.signal.toUpperCase()}`;
    if (c.signal === "resistance" && up) return `the price breaks above its ${c.period ?? 48}-bar high${v ? ` by ${pct(v)}` : ""}`;
    if (c.signal === "support" && !up) return `the price breaks below its ${c.period ?? 48}-bar low${v ? ` by ${pct(v)}` : ""}`;
    return `${describeCondition({ ...c, op: up ? "above" : "below" }).replace(/ is (more|less) than /, " moves $1 than ")} (just now)`;
  }
  switch (c.signal) {
    case "ma_cross": {
      const m = (c.ma ?? "ema").toUpperCase();
      const f = `the ${c.period ?? 20}-bar ${m}`;
      const sl = `the ${c.period2 ?? 50}-bar ${m}`;
      if (c.op === "above") return v === 0 ? `${f} is above ${sl}` : `${f} is more than ${pct(v)} ${v > 0 ? "above" : "below"} ${sl}`;
      if (c.op === "below") return v === 0 ? `${f} is below ${sl}` : `${f} is less than ${pct(v)} ${v > 0 ? "above" : "below"} ${sl}`;
      return `${f} is between ${signed(v)} and ${signed(c.value2!)} from ${sl}`;
    }
    case "resistance":
      if (c.op === "above") return v >= 0 ? `the price is ${v ? `more than ${pct(v)} ` : ""}above its ${c.period ?? 48}-bar high (a breakout)` : `the price is within ${pct(v)} of its ${c.period ?? 48}-bar high`;
      return `the price is more than ${pct(v)} under its ${c.period ?? 48}-bar high`;
    case "support":
      if (c.op === "below") return v <= 0 ? `the price is ${v ? `more than ${pct(v)} ` : ""}below its ${c.period ?? 48}-bar low (a breakdown)` : `the price is within ${pct(v)} of its ${c.period ?? 48}-bar low`;
      return `the price is more than ${pct(v)} above its ${c.period ?? 48}-bar low`;
    case "volatility":
      if (c.op === "between") return `the price swings between ${trim(v)}% and ${trim(c.value2!)}% per bar`;
      return c.op === "below" ? `the market is calm (price swings under ${trim(v)}% per bar)` : `the market is busy (price swings over ${trim(v)}% per bar)`;
    case "trend":
      if (c.op === "above") return v === 0 ? `the trend is up (${c.period ?? 50}-bar EMA rising)` : `the trend is up more than ${pct(v)} (${c.period ?? 50}-bar EMA)`;
      if (c.op === "below") return v === 0 ? `the trend is down (${c.period ?? 50}-bar EMA falling)` : `the trend is down more than ${pct(v)} (${c.period ?? 50}-bar EMA)`;
      return `the ${c.period ?? 50}-bar EMA moved between ${signed(v)} and ${signed(c.value2!)}`;
    case "volume":
      return c.op === "above" ? `pool trading is above ${trim(v)}% of its usual level` : c.op === "below" ? `pool trading is below ${trim(v)}% of its usual level` : `pool trading is between ${trim(v)}% and ${trim(c.value2!)}% of usual`;
    case "gap_cex":
    case "gap_oracle": {
      const ref = c.signal === "gap_cex" ? "HashKey Global" : "the oracle price";
      if (c.op === "between") return `the pool price is between ${signed(v)} and ${signed(c.value2!)} from ${ref}`;
      if (c.op === "below") return v <= 0 ? `the pool price is more than ${pct(v)} under ${ref}` : `the pool price is less than ${pct(v)} over ${ref}`;
      return v >= 0 ? `the pool price is more than ${pct(v)} over ${ref}` : `the pool price is less than ${pct(v)} under ${ref}`;
    }
    case "change": {
      const w = window(c.windowMin ?? 60);
      if (c.op === "between") return `the price moved between ${signed(v)} and ${signed(c.value2!)} in the last ${w}`;
      if (c.op === "below") return v <= 0 ? `the price fell more than ${pct(v)} in the last ${w}` : `the price rose less than ${pct(v)} in the last ${w}`;
      return v >= 0 ? `the price rose more than ${pct(v)} in the last ${w}` : `the price fell less than ${pct(v)} in the last ${w}`;
    }
    case "ema":
    case "sma":
    case "vwap": {
      const name = c.signal === "vwap" ? `its ${c.period ?? 20}-bar average traded price (VWAP)` : `its ${c.period ?? 20}-bar ${c.signal === "ema" ? "moving average (EMA)" : "average (SMA)"}`;
      if (c.op === "between") return `the price is between ${signed(v)} and ${signed(c.value2!)} from ${name}`;
      if (v === 0) return `the price is ${c.op} ${name}`;
      if (c.op === "above") return v > 0 ? `the price is more than ${pct(v)} above ${name}` : `the price is less than ${pct(v)} below ${name}`;
      return v < 0 ? `the price is more than ${pct(v)} below ${name}` : `the price is less than ${pct(v)} above ${name}`;
    }
    case "rsi":
      return c.op === "between" ? `RSI(${c.period ?? 14}) is between ${trim(v)} and ${trim(c.value2!)}` : `RSI(${c.period ?? 14}) is ${c.op} ${trim(v)}`;
    case "bollinger": {
      const p = c.period ?? 20;
      if (c.op === "below" && v === 0) return `the price is under the lower Bollinger band (${p} bars)`;
      if (c.op === "above" && v === 1) return `the price is over the upper Bollinger band (${p} bars)`;
      if (c.op === "between") return `the price is between ${trim(v * 100)}% and ${trim(c.value2! * 100)}% of the way up its Bollinger band (${p} bars)`;
      return `the price is ${c.op} ${trim(v * 100)}% of the way up its Bollinger band (${p} bars)`;
    }
    case "hour":
      if (c.op === "between") return `the time is between ${hh(v)} and ${hh(c.value2!)} UTC`;
      return c.op === "above" ? `the time is after ${hh(v)} UTC` : `the time is before ${hh(v)} UTC`;
    case "pnl":
      if (c.op === "between") return `the trade is between ${signed(v)} and ${signed(c.value2!)}`;
      if (c.op === "above") return v >= 0 ? `the trade is up more than ${pct(v)}` : `the trade is down less than ${pct(v)}`;
      return v <= 0 ? `the trade is down more than ${pct(v)}` : `the trade is up less than ${pct(v)}`;
  }
}
function signed(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${trim(Math.abs(v))}%`;
}
function window(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? "day" : `${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? "hour" : `${min / 60} hours`;
  return `${min} minutes`;
}
function join(xs: string[], word: "and" | "or"): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} ${word} ${xs[xs.length - 1]}`;
}

/** The spec as short sentences ("Buys $25 of BTC when…", "Sells when…", "At most…"). */
export function describeStrategy(s: StrategySpec, o: { budgetUsd?: number } = {}): string[] {
  const assets = join(s.markets.map((m) => ASSET[m]), "or");
  const size = s.sizing.mode === "usd" ? usd(s.sizing.value) : `${trim(s.sizing.value)}% of the day's budget${o.budgetUsd ? ` (${usd(Math.round((o.budgetUsd * s.sizing.value) / 100))})` : ""}`;
  const out: string[] = [];
  out.push(`Buys ${size} of ${assets} when ${join(s.entry.conditions.map(describeCondition), s.entry.when === "all" ? "and" : "or")}.`);
  const sells: string[] = [];
  if (s.exit.takeProfitPct) sells.push(`it is up ${pct(s.exit.takeProfitPct)}`);
  if (s.exit.stopLossPct) sells.push(`it is down ${pct(s.exit.stopLossPct)}`);
  if (s.exit.trailingStopPct) sells.push(`the price falls ${pct(s.exit.trailingStopPct)} from its high since buying`);
  for (const c of s.exit.conditions) sells.push(describeCondition(c));
  if (sells.length) out.push(`Sells when ${join(sells, "or")}.`);
  if (s.exit.maxHoldHours) out.push(`Sells after ${s.exit.maxHoldHours < 1 ? `${Math.round(s.exit.maxHoldHours * 60)} minutes` : `${trim(s.exit.maxHoldHours)} hour${s.exit.maxHoldHours === 1 ? "" : "s"}`} at most.`);
  const gap = s.limits.cooldownMin > 0 ? `, at least ${window(s.limits.cooldownMin)} apart` : "";
  out.push(`At most ${s.limits.maxTradesPerDay} buy${s.limits.maxTradesPerDay === 1 ? "" : "s"} a day${gap}.`);
  if (s.kind === "ai") out.push(`The AI checks each trade${s.instructions ? ` against your words: “${s.instructions}”` : ""}. It may skip a trade or buy less, never more.`);
  out.push("Your vault limits and safety rules always apply on top.");
  return out;
}

// ------------------------------------------------------------------ risk comparison (Touch ID for riskier only)

/** The numbers that make a strategy riskier or safer. */
export interface RiskNumbers {
  /** USD per buy. */
  sizeUsd: number;
  /** Stop in % (the guard's stop when the spec has none). */
  stopPct: number;
  /** Buys a day at most. */
  tradesPerDay: number;
  /** Minutes between buys. */
  cooldownMin: number;
}

/** Risk numbers of a spec on a market: `budgetUsd` = the market's daily budget, `guardStopPct` = its stop-loss. */
export function specRisk(s: StrategySpec, o: { budgetUsd: number; guardStopPct: number }): RiskNumbers {
  const sizeUsd = s.sizing.mode === "usd" ? s.sizing.value : (o.budgetUsd * s.sizing.value) / 100;
  return {
    sizeUsd: Math.round(sizeUsd * 100) / 100,
    stopPct: Math.min(s.exit.stopLossPct ?? o.guardStopPct, o.guardStopPct),
    tradesPerDay: s.limits.maxTradesPerDay,
    cooldownMin: s.limits.cooldownMin,
  };
}

/** Is `next` riskier than `prev`? Any risk-raising field makes the whole change riskier. */
export function compareRisk(prev: RiskNumbers, next: RiskNumbers): { riskier: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (next.sizeUsd > prev.sizeUsd + 1e-9) reasons.push(`bigger trades (${usd(prev.sizeUsd)} → ${usd(next.sizeUsd)})`);
  if (next.stopPct > prev.stopPct + 1e-9) reasons.push(`a looser stop (${pct(prev.stopPct)} → ${pct(next.stopPct)})`);
  if (next.tradesPerDay > prev.tradesPerDay) reasons.push(`more trades a day (${prev.tradesPerDay} → ${next.tradesPerDay})`);
  if (next.cooldownMin < prev.cooldownMin) reasons.push(`less time between trades (${prev.cooldownMin} → ${next.cooldownMin} min)`);
  return { riskier: reasons.length > 0, reasons };
}

/** Plain one-liner of a backtest summary. */
export function backtestLine(days: number, returnPct: number, trades: number, worstDipPct: number): string {
  const r = `${returnPct > 0 ? "+" : returnPct < 0 ? "−" : ""}${trim(Math.abs(returnPct))}%`;
  return `Over ${days} days: ${r}, ${trades} trade${trades === 1 ? "" : "s"}, worst dip ${worstDipPct > 0 ? "−" : ""}${trim(Math.abs(worstDipPct))}%`;
}
