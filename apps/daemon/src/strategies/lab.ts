// Strategy lab (lane STRAT): the user's own strategies — saved and versioned (spec hash), drafted from plain words by
// the selected AI engine (one tool-free call), read back as sentences, backtested on mainnet history with this
// vault's limits, practised with the AI on a virtual clock (a sandbox: never the live journal, never on-chain),
// improved by training and sweeps, and put in use per market through a normal strategy change (riskier → Touch ID).

import { createHash, randomBytes } from "node:crypto";
import {
  MARKETS,
  MARKET_IDS,
  canonicalJson,
  describeStrategy,
  parseStrategySpec,
  type BacktestSummary,
  type CustomStrategyRef,
  type MarketId,
  type SavedStrategy,
  type StrategySpec,
} from "@ate/core";
import {
  DEFAULT_SIM_LIMITS,
  PRACTICE_TOOLS,
  PracticeSession,
  countCandidateCycles,
  estimateAiCalls,
  evaluateChange,
  presetSpec,
  runBacktest,
  suggestImprovements,
  sweep,
  type BacktestResult,
  type MarketHistory,
  type PracticeDecider,
  type PracticeEvent,
  type SimInput,
  type SimLimits,
  type SpecChange,
  type Suggestion,
  type SweepMetric,
} from "@ate/backtest";
import { currentRisk, customActivation, customHistory, marketBudgetUsd, minEntryIntervalSec, effectiveMarketParams, turnoverAllocationE8 } from "@ate/strategy";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { AiEngine } from "../engine.js";
import type { AteService } from "../service.js";
import type { HistoryLoader } from "./history.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const err = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const asset = (m: MarketId): "HSK" | "BTC" => (MARKETS[m].asset === "WBTC" ? "BTC" : "HSK");
const marketOf = (a: "HSK" | "BTC"): MarketId => MARKET_IDS.find((m) => asset(m) === a)!;
export const specHash = (s: StrategySpec) => `0x${createHash("sha256").update(canonicalJson(s)).digest("hex")}`;
const e8 = (x: string | number | bigint) => Number(BigInt(x)) / 1e8;

/** Rough model prices per million tokens (input, output) for the cost estimate; subscriptions are not billed per call. */
const PRICE_PER_M: { match: RegExp; in: number; out: number }[] = [
  { match: /opus/i, in: 5, out: 25 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /haiku/i, in: 1, out: 5 },
  { match: /gpt-5.*mini|flash|nano/i, in: 0.3, out: 2.5 },
  { match: /gpt-5|gemini.*pro|o\d/i, in: 1.25, out: 10 },
];
/** Tokens per AI practice cycle (system prompt + three reads + one decision), measured on live cycles. */
const TOKENS_PER_CYCLE = { input: 14_000, output: 900 };

const DRAFT_SYSTEM = `You turn a trader's plain words into a strategy spec for Flow. Answer with ONE JSON object only, no prose, no code fence.
Schema (flow.strategy/v1):
{ "name": string (≤ 40 chars, short), "kind": "rules" | "ai", "markets": ["HSK"] | ["BTC"] | ["HSK","BTC"],
  "barMinutes": 1 | 5 | 15 | 60 (default 5),
  "entry": { "when": "all" | "any", "conditions": Condition[] (1–6) },
  "exit": { "conditions": Condition[] (0–6), "takeProfitPct"?: number, "stopLossPct"?: number, "trailingStopPct"?: number, "maxHoldHours"?: number },
  "sizing": { "mode": "usd", "value": dollars } | { "mode": "pct", "value": percent of the day's budget },
  "limits": { "maxTradesPerDay": 1–48, "cooldownMin": minutes between buys },
  "instructions"?: string (only for kind "ai": the user's judgement rules for the AI, in their words) }
Condition = { "signal", "op": "above" | "below" | "between", "value": number, "value2"?: number, "period"?: bars, "windowMin"?: minutes }
Signals (values in %):
- gap_cex: (pool − HashKey Global) / HashKey Global. "pool more than 1% under HashKey Global" = { "signal":"gap_cex","op":"below","value":-1 }
- gap_oracle: same against the oracle price
- change: price change over windowMin. "fell 2% in the last hour" = { "signal":"change","op":"below","value":-2,"windowMin":60 }
- ema | sma | vwap: price distance from the average over period bars. "above the 50-bar EMA" = { "signal":"ema","op":"above","value":0,"period":50 }
- rsi: 0–100 over period bars (default 14)
- bollinger: %B, 0 = lower band, 1 = upper band (period default 20). "under the lower band" = { "op":"below","value":0 }
- hour: UTC hour, use "between" (value, value2)
- pnl: open trade P&L in % (exit conditions only)
- ma_cross: fast MA (period) vs slow MA (period2), "ma": "ema"|"sma". Golden cross = { "signal":"ma_cross","op":"crosses_above","value":0,"period":20,"period2":50 }; "20 EMA above 50 EMA" = op "above", value 0
- resistance: price vs the highest close of the previous period bars. Breakout = { "signal":"resistance","op":"crosses_above","value":0,"period":48 }
- support: price vs the lowest close of the previous period bars. Breakdown = { "signal":"support","op":"crosses_below","value":0,"period":48 }; "near support" = { "op":"below","value":0.3 }
- volatility: std dev of bar moves over period bars in %. Calm market filter = { "signal":"volatility","op":"below","value":0.3,"period":24 }
- trend: EMA(period) change over period bars in %. Uptrend = { "signal":"trend","op":"above","value":0,"period":50 }
- volume: pool volume of the last period bars vs usual (100 = normal). Busy = { "op":"above","value":150 }
- momentum / 24h move: use change with windowMin 1440. RSI oversold = { "signal":"rsi","op":"below","value":30 }; overbought (sell) = { "op":"above","value":70 }
Ops: "above" | "below" | "between" | "crosses_above" | "crosses_below" (crosses_* is true only on the bar it happens). There is no funding-rate signal on spot; say so in the name if asked and use momentum instead.
Rules: Flow only buys the token and sells it back (no shorting). Every strategy must say when to sell. Use "ai" kind only when the user asks for judgement the rules cannot express (news, "use your judgement", "skip when …" in words). Defaults when unsaid: sizing $10, maxTradesPerDay 4, cooldownMin 30, stopLossPct 2. Never invent numbers the user gave differently.`;

interface PracticeRun {
  id: string;
  strategyId: string | null;
  spec: StrategySpec;
  days: number;
  session: PracticeSession;
  status: "running" | "paused" | "done" | "stopped" | "error";
  startedAt: number;
  engine: { provider: string; model: string; mode: "tools" | "json" } | null;
  sampleEvery: number;
  events: { cycle: number; at: number; pnlUsd: number; by: string }[];
  result: (BacktestResult & { stopped: boolean; aiCalls: number; aiTokens: { input: number; output: number } }) | null;
  rules: BacktestResult | null;
  error: string | null;
}

interface PendingSave {
  id: string;
  spec: StrategySpec;
  sentences: string[];
  rationale: string;
  via: string;
  expiresAt: number;
}

export interface LabOptions {
  db: Database.Database;
  service: AteService;
  ai: AiEngine;
  history: HistoryLoader;
  traderPrompt: string;
  emit: (e: { type: string; at: number; data: unknown }) => void;
  log?: (m: string) => void;
}

export class StrategyLab {
  private runs = new Map<string, PracticeRun>();
  private pending = new Map<string, PendingSave>();

  constructor(private readonly o: LabOptions) {
    o.db.exec(`CREATE TABLE IF NOT EXISTS custom_strategies (
      id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, spec TEXT NOT NULL, lessons TEXT,
      created_at INTEGER NOT NULL, PRIMARY KEY (id, version));
    CREATE TABLE IF NOT EXISTS custom_strategy_meta (
      id TEXT PRIMARY KEY, deleted INTEGER NOT NULL DEFAULT 0, last_backtest TEXT, updated_at INTEGER NOT NULL);`);
  }

  // ------------------------------------------------------------------ store

  list(): SavedStrategy[] {
    const ids = this.o.db.prepare("SELECT id FROM custom_strategy_meta WHERE deleted = 0 ORDER BY updated_at DESC").all() as { id: string }[];
    return ids.map((r) => this.get(r.id)!).filter(Boolean);
  }

  get(id: string, version?: number): SavedStrategy | null {
    const row = (version
      ? this.o.db.prepare("SELECT * FROM custom_strategies WHERE id = ? AND version = ?").get(id, version)
      : this.o.db.prepare("SELECT * FROM custom_strategies WHERE id = ? ORDER BY version DESC LIMIT 1").get(id)) as { id: string; version: number; hash: string; spec: string; lessons: string | null; created_at: number } | undefined;
    const meta = this.o.db.prepare("SELECT * FROM custom_strategy_meta WHERE id = ?").get(id) as { deleted: number; last_backtest: string | null; updated_at: number } | undefined;
    if (!row || !meta || meta.deleted) return null;
    const spec = JSON.parse(row.spec) as StrategySpec;
    const first = this.o.db.prepare("SELECT MIN(created_at) AS c FROM custom_strategies WHERE id = ?").get(id) as { c: number };
    const activeOn = MARKET_IDS.filter((m) => this.o.service.strategy.markets[m]?.custom?.id === id).map(asset);
    return {
      id,
      version: row.version,
      hash: row.hash,
      spec,
      sentences: describeStrategy(spec, { budgetUsd: this.budgetUsd(spec) }),
      createdAt: first.c,
      updatedAt: meta.updated_at,
      activeOn,
      lastBacktest: meta.last_backtest ? (JSON.parse(meta.last_backtest) as BacktestSummary) : null,
      ...(row.lessons ? { lessons: JSON.parse(row.lessons) as string[] } : {}),
    };
  }

  /** Saves a spec (a new version when `id` exists). Never changes what runs: "Use this strategy" does that. */
  save(rawSpec: unknown, id?: string, lessons?: string[]): SavedStrategy {
    const p = parseStrategySpec(rawSpec);
    if (!p.ok) throw err(400, "ATE_INVALID_PARAMS", p.errors.join("; "));
    const spec = p.spec;
    const t = nowSec();
    const sid = id ?? `stg_${randomBytes(6).toString("hex")}`;
    const prev = id ? this.get(id) : null;
    if (id && !prev) throw err(404, "ATE_INVALID_PARAMS", "no such strategy");
    const hash = specHash(spec);
    if (prev && prev.hash === hash && !lessons) return prev;
    const version = (prev?.version ?? 0) + 1;
    const keep = lessons ?? prev?.lessons ?? null;
    this.o.db.prepare("INSERT INTO custom_strategies (id, version, hash, spec, lessons, created_at) VALUES (?,?,?,?,?,?)").run(sid, version, hash, JSON.stringify(spec), keep ? JSON.stringify(keep) : null, t);
    this.o.db.prepare("INSERT INTO custom_strategy_meta (id, deleted, last_backtest, updated_at) VALUES (?, 0, NULL, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, last_backtest = CASE WHEN ? THEN NULL ELSE last_backtest END").run(sid, t, prev && prev.hash !== hash ? 1 : 0);
    return this.get(sid)!;
  }

  remove(id: string): { removed: boolean } {
    const s = this.get(id);
    if (!s) return { removed: false };
    if (s.activeOn.length) throw err(409, "ATE_INVALID_PARAMS", `“${s.spec.name}” is in use on ${s.activeOn.join(" and ")}. Stop using it first.`);
    this.o.db.prepare("UPDATE custom_strategy_meta SET deleted = 1, updated_at = ? WHERE id = ?").run(nowSec(), id);
    return { removed: true };
  }

  describe(rawSpec: unknown): { ok: boolean; sentences: string[]; errors: string[] } {
    const p = parseStrategySpec(rawSpec);
    if (!p.ok) return { ok: false, sentences: [], errors: p.errors };
    return { ok: true, sentences: describeStrategy(p.spec, { budgetUsd: this.budgetUsd(p.spec) }), errors: [] };
  }

  private budgetUsd(spec: StrategySpec): number {
    const m = marketOf(spec.markets[0]!);
    const v = this.o.service.vaultState?.(m) ?? undefined;
    return Number(turnoverAllocationE8(m, this.o.service.strategy, v)) / 1e8;
  }

  // ------------------------------------------------------------------ AI draft (one tool-free call)

  async draft(text: string, base?: unknown): Promise<{ spec: StrategySpec | null; sentences: string[]; errors: string[]; model: string }> {
    if (!text.trim()) throw err(400, "ATE_INVALID_PARAMS", "write what the strategy should do");
    if (text.length > 2000) throw err(400, "ATE_INVALID_PARAMS", "keep it under 2,000 characters");
    const ask = async (msg: string): Promise<{ raw: string; model: string }> => {
      const conv = this.o.ai.conversation("trader");
      this.o.ai.pushUser(conv, msg);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 90_000);
      try {
        const r = await this.o.ai.run("trader", conv, { effort: "low", system: DRAFT_SYSTEM, toolNames: [], noExtraTools: true, signal: ac.signal, maxTurns: 1, maxTokens: 2000, call: async () => ({ content: "no tools here", isError: true }) as never });
        return { raw: r.text, model: `${conv.provider}/${conv.model}` };
      } finally {
        clearTimeout(timer);
      }
    };
    const msg = base ? `Current strategy (JSON):\n${JSON.stringify(base)}\n\nChange it as follows: ${text}` : `Strategy in the user's words: ${text}`;
    let { raw, model } = await ask(msg);
    let parsed = parseStrategySpec(extractJson(raw));
    if (!parsed.ok) {
      ({ raw, model } = await ask(`${msg}\n\nYour last answer was not valid: ${parsed.errors.join("; ")}. Answer with the corrected JSON object only.`));
      parsed = parseStrategySpec(extractJson(raw));
    }
    if (!parsed.ok) return { spec: null, sentences: [], errors: parsed.errors, model };
    return { spec: parsed.spec, sentences: describeStrategy(parsed.spec, { budgetUsd: this.budgetUsd(parsed.spec) }), errors: [], model };
  }

  // ------------------------------------------------------------------ backtest inputs

  /** This vault's limits and the guard's numbers for a market, as the paper market uses them. */
  limits(m: MarketId): SimLimits {
    const s = this.o.service.strategy;
    const mp = effectiveMarketParams(m, s.markets[m]);
    const v = this.o.service.vaultState?.(m) ?? null;
    const L = v?.limits;
    const vaultExp = L ? e8(L.maxExposureUsdE8) : DEFAULT_SIM_LIMITS.maxExposureUsd;
    return {
      maxTradeUsd: L ? e8(L.maxTradeUsdE8) : DEFAULT_SIM_LIMITS.maxTradeUsd,
      maxExposureUsd: Math.min(Number(mp.maxPositionUsd), vaultExp),
      maxEpochUsd: L ? e8(L.maxEpochUsdE8) : DEFAULT_SIM_LIMITS.maxEpochUsd,
      dailyBudgetUsd: Number(turnoverAllocationE8(m, s, v ?? undefined)) / 1e8 || DEFAULT_SIM_LIMITS.dailyBudgetUsd,
      maxPortfolioExposureUsd: Number(s.portfolio.maxPortfolioExposureUsd),
      dailyLossLimitUsd: Number(s.portfolio.dailyLossLimitUsd),
      guardStopPct: mp.stopLossBps / 100,
      minEntryIntervalSec: 0,
      reentryCooldownSec: mp.reentryCooldownSec,
      maxOracleDeviationBps: L?.maxOracleDeviationBps ?? DEFAULT_SIM_LIMITS.maxOracleDeviationBps,
    };
  }

  private resolve(a: { strategyId?: string; spec?: unknown }): { spec: StrategySpec; saved: SavedStrategy | null } {
    if (a.strategyId) {
      const s = this.get(a.strategyId);
      if (!s) throw err(404, "ATE_INVALID_PARAMS", "no such strategy");
      return { spec: s.spec, saved: s };
    }
    const p = parseStrategySpec(a.spec);
    if (!p.ok) throw err(400, "ATE_INVALID_PARAMS", p.errors.join("; "));
    return { spec: p.spec, saved: null };
  }

  private async input(spec: StrategySpec, days: number): Promise<SimInput & { histories: MarketHistory[] }> {
    if (![7, 30, 90].includes(days)) throw err(400, "ATE_INVALID_PARAMS", "days must be 7, 30 or 90");
    const ms = spec.markets.map(marketOf);
    const histories = await Promise.all(ms.map((m) => this.o.history.load(m, days)));
    const to = Math.min(...histories.map((h) => h.to));
    // the strictest market's limits (one strategy, the same numbers on both markets)
    const ls = ms.map((m) => this.limits(m));
    const limits: SimLimits = ls.reduce((a, b) => ({
      maxTradeUsd: Math.min(a.maxTradeUsd, b.maxTradeUsd),
      maxExposureUsd: Math.min(a.maxExposureUsd, b.maxExposureUsd),
      maxEpochUsd: Math.min(a.maxEpochUsd, b.maxEpochUsd),
      dailyBudgetUsd: Math.min(a.dailyBudgetUsd, b.dailyBudgetUsd),
      maxPortfolioExposureUsd: a.maxPortfolioExposureUsd,
      dailyLossLimitUsd: a.dailyLossLimitUsd,
      guardStopPct: Math.min(a.guardStopPct, b.guardStopPct),
      minEntryIntervalSec: 0,
      reentryCooldownSec: Math.max(a.reentryCooldownSec, b.reentryCooldownSec),
      maxOracleDeviationBps: a.maxOracleDeviationBps,
    }));
    return { spec, histories, limits, from: to - days * 86_400, to };
  }

  /** The market's current settings as a rules spec ("what runs now" without a custom strategy). */
  private presetCompare(spec: StrategySpec, histories: MarketHistory[]): { name: string; spec: StrategySpec } {
    const m = marketOf(spec.markets[0]!);
    const s = this.o.service.strategy;
    const mp = effectiveMarketParams(m, s.markets[m]);
    const h = histories[0]!;
    const impactBps = ((Number(mp.tradeSizeUsd) * 0.997) / h.depthUsd) * 1e4;
    const risk = currentRisk(m, s);
    const name = profileName(mp);
    return {
      name,
      spec: presetSpec(
        { tradeSizeUsd: mp.tradeSizeUsd, entrySpreadBps: mp.entrySpreadBps, minNetEdgeBps: mp.minNetEdgeBps, stopLossBps: mp.stopLossBps },
        { assets: spec.markets, feeBps: h.feeBps, halfSpreadBps: h.halfSpreadBps, impactBps, dailyBudgetUsd: marketBudgetUsd(m, this.o.service.portfolio()), cooldownMin: Math.max(risk.cooldownMin, Math.round(minEntryIntervalSec(m, mp) / 60)), name },
      ),
    };
  }

  async backtest(a: { strategyId?: string; spec?: unknown; days: number }): Promise<BacktestResult & { sentences: string[] }> {
    const { spec, saved } = this.resolve(a);
    const inp = await this.input(spec, a.days);
    const r = runBacktest({ ...inp, compareTo: this.presetCompare(spec, inp.histories) });
    if (saved) this.o.db.prepare("UPDATE custom_strategy_meta SET last_backtest = ? WHERE id = ?").run(JSON.stringify(r.summary), saved.id);
    return { ...r, sentences: describeStrategy(spec, { budgetUsd: this.budgetUsd(spec) }) };
  }

  // ------------------------------------------------------------------ practice (AI on a virtual clock)

  async estimate(a: { strategyId?: string; spec?: unknown; days: number; sampleEvery: number; maxAiCalls?: number }) {
    const { spec } = this.resolve(a);
    const inp = await this.input(spec, a.days);
    const cycles = countCandidateCycles(inp);
    const calls = estimateAiCalls(cycles, a.sampleEvery, a.maxAiCalls);
    const sel = this.o.ai.conversation("trader");
    const price = PRICE_PER_M.find((p) => p.match.test(sel.model));
    const billed = sel.provider !== "subscription" && sel.provider !== "opencode" && sel.provider !== "ollama";
    const tokens = { input: calls * TOKENS_PER_CYCLE.input, output: calls * TOKENS_PER_CYCLE.output };
    const usd = billed && price ? Math.round(((tokens.input * price.in + tokens.output * price.out) / 1e6) * 100) / 100 : null;
    const minutes = Math.ceil((calls * 25) / 60);
    return {
      cycles: Math.ceil((inp.to - inp.from) / (spec.barMinutes * 60)),
      candidateCycles: cycles,
      aiCalls: calls,
      tokens,
      costUsd: usd,
      costLine: calls === 0 ? "The rules find nothing to decide in this period, so the AI is never asked." : usd !== null ? `About ${calls} AI decisions, roughly $${usd.toFixed(2)} on ${sel.model}.` : `About ${calls} AI decisions on ${sel.model}, from your ${sel.provider === "opencode" ? "OpenCode" : sel.provider === "ollama" ? "local" : "subscription"} plan.`,
      minutes,
      model: sel.model,
      provider: sel.provider,
    };
  }

  async startPractice(a: { strategyId?: string; spec?: unknown; days: number; speed: number; sampleEvery: number; maxAiCalls?: number; engine?: "ai" | "rules" }): Promise<{ runId: string }> {
    for (const r of this.runs.values()) if (r.status === "running" || r.status === "paused") throw err(409, "ATE_INVALID_PARAMS", "a practice run is already going; stop it first");
    const { spec, saved } = this.resolve(a);
    const inp = await this.input(spec, a.days);
    const useAi = a.engine !== "rules";
    const conv = this.o.ai.conversation("trader");
    const mode: "tools" | "json" = conv.protocol === "opencode" ? "json" : "tools";
    const decider = useAi ? this.decider(mode) : null;
    const id = `prc_${randomBytes(5).toString("hex")}`;
    const run: PracticeRun = { id, strategyId: saved?.id ?? null, spec, days: a.days, session: null as never, status: "running", startedAt: nowSec(), engine: useAi ? { provider: conv.provider, model: conv.model, mode } : null, sampleEvery: a.sampleEvery, events: [], result: null, rules: null, error: null };
    const onEvent = (e: PracticeEvent) => {
      if (e.type === "cycle") {
        run.events.push({ cycle: e.cycle, at: e.at, pnlUsd: e.pnlUsd, by: e.by });
        if (run.events.length > 4000) run.events.splice(0, run.events.length - 4000);
      }
      this.o.emit({ type: "practice.event", at: nowSec(), data: { runId: id, ...e } });
    };
    run.session = new PracticeSession({ ...inp, decider, sampleEvery: Math.max(1, a.sampleEvery), speed: a.speed, ...(a.maxAiCalls ? { maxAiCalls: a.maxAiCalls } : {}), onEvent });
    run.rules = runBacktest({ ...inp, compareTo: null });
    this.runs.set(id, run);
    void run.session
      .run()
      .then((r) => {
        run.result = r;
        run.status = r.stopped ? "stopped" : "done";
      })
      .catch((e) => {
        run.status = "error";
        run.error = (e as Error).message;
      });
    return { runId: id };
  }

  /** The AI decider: the live tool loop pointed at the paper market (or, for opencode, one JSON answer per cycle). */
  private decider(mode: "tools" | "json"): PracticeDecider {
    const system = `${this.o.traderPrompt}\n\n## Practice run\nThis is a PRACTICE run on past data: the tools answer from a simulated market at a past time, and nothing you do reaches a vault, the journal or the chain. Treat it exactly like a live cycle. Only the strategy's candidates can be bought; discretionary trades are off.`;
    if (mode === "tools") {
      return async ({ cycle, at, call, signal }) => {
        const conv = this.o.ai.conversation("trader");
        this.o.ai.pushUser(conv, `Cycle ${cycle} at ${new Date(at * 1000).toISOString()} (practice). Read state, evaluate every candidate, and end each market in ate_execute (after ate_propose) or ate_decide.`);
        const r = await this.o.ai.run("trader", conv, {
          effort: "low",
          system,
          toolNames: PRACTICE_TOOLS,
          noExtraTools: true,
          signal,
          maxTurns: 12,
          call: async (name: string, input: unknown) => {
            const out = await call(name, input);
            return { content: JSON.stringify(out), isError: !out.ok } as never;
          },
        });
        return { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, summary: r.text.slice(0, 300) };
      };
    }
    // opencode calls Flow's live MCP itself, so practice gives it the state in the prompt and takes one JSON decision
    return async ({ cycle, at, call, signal }) => {
      const [m, c, p] = await Promise.all([call("ate_market_get", {}), call("ate_candidates_get", {}), call("ate_positions", {})]);
      // the analysis the live trader does with ate_chart (5 m and 1 h), computed from the practice bars
      const cmk = [...new Set(((c.data as { candidates: { market: string }[] }).candidates ?? []).map((x) => x.market))];
      const charts = await Promise.all(cmk.flatMap((mk) => ["5m", "1h"].map((iv) => call("ate_chart", { kind: "cex", market: mk, interval: iv, analyse: true }).then((r) => ({ market: mk, interval: iv, ...(r.data as object) })))));
      const conv = this.o.ai.conversation("trader");
      this.o.ai.pushUser(
        conv,
        `Cycle ${cycle} at ${new Date(at * 1000).toISOString()} (practice, tools are off: the state is below).\nate_market_get: ${JSON.stringify(m.data)}\nate_candidates_get: ${JSON.stringify(c.data)}\nate_positions: ${JSON.stringify(p.data)}\nate_chart (analysis): ${JSON.stringify(charts)}\n\nStart each rationale's Details with the Analysis line (trend, RSI, support/resistance, volatility, gap vs cost, expected edge). Answer with ONE JSON object only: {"decisions":[{"candidateId": string, "action": "take" | "veto" | "skip", "amountIn"?: string (≤ maxAmountIn), "rationale": "Summary: …\\nDetails: …"}]}`,
      );
      const r = await this.o.ai.run("trader", conv, { effort: "low", system, toolNames: [], noExtraTools: true, signal, maxTurns: 1, maxTokens: 2000, call: async () => ({ content: "tools are off", isError: true }) as never });
      const j = extractJson(r.text) as { decisions?: { candidateId: string; action: string; amountIn?: string; rationale?: string }[] } | null;
      const cands = ((c.data as { candidates: { candidateId: string; market: string; side: string; maxAmountIn: string }[] }).candidates ?? []);
      for (const d of j?.decisions ?? []) {
        const k = cands.find((x) => x.candidateId === d.candidateId);
        if (!k) continue;
        if (d.action === "take") {
          const pr = await call("ate_propose", { market: k.market, side: k.side, amountIn: d.amountIn ?? k.maxAmountIn, candidateId: k.candidateId, rationale: d.rationale ?? "Summary: Took the trade." });
          if (pr.ok) await call("ate_execute", { proposalId: (pr.data as { proposalId: string }).proposalId });
        } else await call("ate_decide", { decision: "no_trade", market: k.market, candidateId: k.candidateId, reason: d.action === "veto" ? "llm_veto" : "no_signal", rationale: d.rationale ?? "Summary: Skipped." });
      }
      return { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
    };
  }

  practice(runId: string) {
    const r = this.runs.get(runId);
    if (!r) throw err(404, "ATE_INVALID_PARAMS", "no such practice run");
    const sim = r.session.sim;
    return {
      runId: r.id,
      status: r.status === "running" && r.session.isPaused ? "paused" : r.status,
      strategyId: r.strategyId,
      name: r.spec.name,
      days: r.days,
      engine: r.engine,
      sampleEvery: r.sampleEvery,
      progress: sim.n ? Math.min(1, sim.i / sim.n) : 1,
      virtualNow: sim.now,
      speed: r.session.o.speed,
      aiCalls: r.session.aiCalls,
      aiTokens: r.session.aiTokens,
      curve: thin(r.events.map((e) => ({ t: e.at, v: e.pnlUsd })), 600),
      decisions: sim.decisions.slice(-400),
      result: r.result,
      rules: r.rules ? { pnlUsd: r.rules.pnlUsd, returnPct: r.rules.returnPct, trades: r.rules.trades.length, maxDrawdownPct: r.rules.maxDrawdownPct, curve: r.rules.curve } : null,
      error: r.error,
    };
  }

  control(runId: string, action: "pause" | "resume" | "step" | "stop" | "speed", speed?: number) {
    const r = this.runs.get(runId);
    if (!r) throw err(404, "ATE_INVALID_PARAMS", "no such practice run");
    const s = r.session;
    if (action === "pause") s.pause();
    else if (action === "resume") s.resume();
    else if (action === "step") s.step();
    else if (action === "stop") s.stop();
    else if (action === "speed") s.setSpeed(Math.max(0, Math.min(100_000, Number(speed) || 0)));
    return this.practice(runId);
  }

  // ------------------------------------------------------------------ training

  /** Tested improvements: rule-based ideas, plus the AI's review of its own practice decisions when there was one. */
  async train(a: { strategyId?: string; spec?: unknown; days: number; runId?: string; useAi?: boolean }): Promise<{ baseline: BacktestResult["summary"]; suggestions: Suggestion[]; lessons: string[]; aiNote: string | null }> {
    const run = a.runId ? this.runs.get(a.runId) : undefined;
    const { spec } = run ? { spec: run.spec } : this.resolve(a);
    const inp = await this.input(spec, run?.days ?? a.days);
    const baseline = runBacktest({ ...inp, compareTo: null });
    const suggestions = suggestImprovements(inp, baseline, 4);
    let lessons: string[] = [];
    let aiNote: string | null = null;
    if (a.useAi !== false) {
      try {
        const decisions = (run?.result?.decisions ?? baseline.decisions).slice(-120);
        const trades = (run?.result?.trades ?? baseline.trades).filter((t) => t.side === "sell").slice(-60).map((t) => ({ t: t.t, usd: Math.round(t.usd * 100) / 100, pnlUsd: t.pnlUsd, why: t.reason }));
        const conv = this.o.ai.conversation("trader");
        this.o.ai.pushUser(
          conv,
          `Review this strategy's past run and propose improvements.\nStrategy: ${JSON.stringify(spec)}\nResult: ${baseline.summary.line}; win rate ${baseline.winRate ?? "n/a"}; fees $${baseline.feesUsd}.\nDecisions (latest): ${JSON.stringify(decisions.map((d) => ({ t: d.t, action: d.action, usd: d.usd, by: d.by, summary: d.summary })))}\nClosed trades: ${JSON.stringify(trades)}\n\nAnswer with ONE JSON object only: {"changes":[{"path": "entry.conditions.0.value" | "exit.takeProfitPct" | "exit.stopLossPct" | "exit.trailingStopPct" | "sizing.value" | "limits.cooldownMin" | "limits.maxTradesPerDay" | ..., "value": number, "sentence": "plain words, ≤ 15 words", "why": "≤ 20 words"}] (≤ 3), "lessons": ["short plain rules for the trader, ≤ 20 words each"] (≤ 3)}`,
        );
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 90_000);
        const r = await this.o.ai.run("trader", conv, { effort: "low", system: "You are a careful trading coach. Answer with JSON only.", toolNames: [], noExtraTools: true, signal: ac.signal, maxTurns: 1, maxTokens: 2000, call: async () => ({ content: "no tools", isError: true }) as never }).finally(() => clearTimeout(timer));
        const j = extractJson(r.text) as { changes?: { path: string; value: number; sentence?: string; why?: string }[]; lessons?: string[] } | null;
        lessons = (j?.lessons ?? []).filter((x) => typeof x === "string").map((x) => x.slice(0, 200)).slice(0, 3);
        for (const c of (j?.changes ?? []).slice(0, 3)) {
          if (typeof c.path !== "string" || typeof c.value !== "number" || !/^(entry|exit|sizing|limits)\./.test(c.path)) continue;
          const s = evaluateChange(inp, baseline, [{ path: c.path, value: c.value }], (c.sentence ?? `${c.path} → ${c.value}`).slice(0, 120), "ai", c.why?.slice(0, 160));
          if (s) suggestions.push(s);
        }
      } catch (e) {
        aiNote = `The AI review did not finish (${(e as Error).message.slice(0, 80)}). The suggestions below come from the rules.`;
      }
    }
    return { baseline: baseline.summary, suggestions: suggestions.map((s) => ({ ...s, result: { ...s.result, trades: [] } })), lessons, aiNote };
  }

  async sweep(a: { strategyId?: string; spec?: unknown; days: number; params: { path: string; values: number[] }[]; metric: SweepMetric }) {
    const { spec } = this.resolve(a);
    if (!Array.isArray(a.params) || a.params.length < 1 || a.params.length > 3) throw err(400, "ATE_INVALID_PARAMS", "pick 1 to 3 numbers to try");
    const inp = await this.input(spec, a.days);
    return sweep({ base: inp, params: a.params, metric: a.metric ?? "pnl" });
  }

  /** Saves a tested change (and lessons) as a new version. Using it is a separate step. */
  adopt(id: string, changes: SpecChange[], lessons?: string[]): SavedStrategy {
    const s = this.get(id);
    if (!s) throw err(404, "ATE_INVALID_PARAMS", "no such strategy");
    let spec = s.spec;
    for (const c of changes) {
      if (!/^(entry|exit|sizing|limits)\./.test(c.path)) throw err(400, "ATE_INVALID_PARAMS", `cannot change ${c.path}`);
      spec = setDeep(spec, c.path, c.value);
    }
    return this.save(spec, id, lessons && lessons.length ? [...(s.lessons ?? []), ...lessons].slice(-10) : undefined);
  }

  // ------------------------------------------------------------------ use on a market

  /** Puts a strategy in use on a market (or stops it: id null). Riskier → pending change (Touch ID); safer → applied. */
  activate(market: MarketId, id: string | null, scope: "ui" | "chat" = "ui") {
    const saved = id ? this.get(id) : null;
    if (id && !saved) throw err(404, "ATE_INVALID_PARAMS", "no such strategy");
    if (saved && !saved.spec.markets.includes(asset(market))) throw err(400, "ATE_INVALID_PARAMS", `“${saved.spec.name}” does not trade ${asset(market)}`);
    const ref: CustomStrategyRef | null = saved ? { id: saved.id, version: saved.version, hash: saved.hash, name: saved.spec.name, kind: saved.spec.kind, spec: saved.spec } : null;
    const cur = this.o.service.strategy;
    const act = customActivation(market, ref, cur, this.o.service.vaultState?.(market) ?? undefined);
    const rationale = ref
      ? `Use “${ref.name}” v${ref.version} on ${asset(market)} (spec ${ref.hash})${act.reasons.length ? ` — riskier: ${act.reasons.join(", ")}` : ""}`
      : `Stop using “${cur.markets[market].custom?.name ?? "custom strategy"}” on ${asset(market)}; back to the preset${act.reasons.length ? ` — riskier: ${act.reasons.join(", ")}` : ""}`;
    const r = this.o.service.proposeStrategyChange(scope, act.next, act.changes, rationale, act.riskier);
    if (ref && r.ok) void this.seedLive(market, ref.spec).catch(() => undefined);
    return { result: r, riskier: act.riskier, reasons: act.reasons, before: act.before, after: act.after };
  }

  /** Seeds the live generator's history from the charts cache so indicators work at once. */
  private async seedLive(market: MarketId, spec: StrategySpec) {
    const h = await this.o.history.load(market, 7);
    const from = h.to - Math.max(2 * 86_400, 200 * spec.barMinutes * 60);
    const pts: { t: number; pool: number | null; cex: number | null; oracle: number | null }[] = [];
    let k = 0;
    let lastCex: number | null = null;
    const cex = h.cex.filter((x) => x.t >= from);
    for (const p of h.pool.filter((x) => x.t >= from)) {
      while (k < cex.length && cex[k]!.t <= p.t) lastCex = cex[k++]!.v;
      pts.push({ t: p.t, pool: p.v, cex: lastCex, oracle: null });
    }
    customHistory.seed(market, pts);
  }

  // ------------------------------------------------------------------ chat (read-only backtest; saving asks first)

  async backtestTool(a: { strategyId?: string; specJson?: string; days?: number }) {
    if (!a.strategyId && !a.specJson) return { strategies: this.list().map((s) => ({ strategyId: s.id, name: s.spec.name, version: s.version, sentences: s.sentences, lastBacktest: s.lastBacktest?.line ?? null, inUseOn: s.activeOn })) };
    let spec: unknown;
    if (a.specJson) {
      try {
        spec = JSON.parse(a.specJson);
      } catch {
        throw err(400, "ATE_INVALID_PARAMS", "specJson is not valid JSON");
      }
    }
    const r = await this.backtest({ ...(a.strategyId ? { strategyId: a.strategyId } : { spec }), days: a.days ?? 30 });
    return {
      summary: r.summary.line,
      sentences: r.sentences,
      pnlUsd: r.pnlUsd,
      returnPct: r.returnPct,
      trades: r.trades.length,
      winRate: r.winRate,
      worstDipPct: r.maxDrawdownPct,
      feesUsd: r.feesUsd,
      timeInMarketPct: r.timeInMarketPct,
      justHolding: r.hold,
      currentSettings: r.preset,
      coverage: r.coverage,
      note: "Simulated on past prices with this vault's limits; not a promise of future results.",
    };
  }

  saveFromChat(a: { specJson: string; rationale: string }, via: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(a.specJson);
    } catch {
      throw err(400, "ATE_INVALID_PARAMS", "specJson is not valid JSON");
    }
    const p = parseStrategySpec(raw);
    if (!p.ok) throw err(400, "ATE_INVALID_PARAMS", p.errors.join("; "));
    const t = nowSec();
    for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k);
    const id = `sav_${randomBytes(5).toString("hex")}`;
    const sentences = describeStrategy(p.spec, { budgetUsd: this.budgetUsd(p.spec) });
    this.pending.set(id, { id, spec: p.spec, sentences, rationale: a.rationale.slice(0, 300), via, expiresAt: t + 600 });
    this.o.emit({ type: "strategy.save_pending", at: t, data: { pendingId: id, name: p.spec.name } });
    return { status: "needs_confirmation", pendingId: id, name: p.spec.name, sentences, hint: "The user confirms it under Agent → Your strategies. Saving never changes what runs." };
  }

  pendingSaves() {
    const t = nowSec();
    return [...this.pending.values()].filter((p) => p.expiresAt >= t);
  }
  confirmSave(pendingId: string): SavedStrategy {
    const p = this.pending.get(pendingId);
    if (!p || p.expiresAt < nowSec()) throw err(404, "ATE_INVALID_PARAMS", "this suggestion expired; ask again");
    this.pending.delete(pendingId);
    return this.save(p.spec);
  }
  dropSave(pendingId: string) {
    return { dropped: this.pending.delete(pendingId) };
  }
}

function profileName(mp: { tradeSizeUsd: string; entrySpreadBps: number; minNetEdgeBps: number }): string {
  const n = Number(mp.tradeSizeUsd);
  if (n === 10 && mp.entrySpreadBps === 90) return "Careful";
  if (n === 25 && mp.entrySpreadBps === 60) return "Balanced";
  if (n === 50 && mp.entrySpreadBps === 45) return "Active";
  return "Your current settings";
}

function thin<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = Math.ceil(xs.length / n);
  return xs.filter((_, k) => k % step === 0 || k === xs.length - 1);
}

function setDeep(spec: StrategySpec, path: string, v: number): StrategySpec {
  const next = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  const ks = path.split(".");
  let cur = next;
  for (const k of ks.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") throw err(400, "ATE_INVALID_PARAMS", `no field ${path}`);
    cur = cur[k] as Record<string, unknown>;
  }
  cur[ks[ks.length - 1]!] = v;
  return next as unknown as StrategySpec;
}

/** First JSON object in a model's answer (tolerates code fences and prose around it). */
export function extractJson(text: string): unknown {
  const s = text.replace(/```(?:json)?/g, "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let k = start; k < s.length; k++) {
    const ch = s[k];
    if (inStr) {
      if (ch === "\\") k++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, k + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export const readPrompt = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "You are Flow's trading agent.";
  }
};
