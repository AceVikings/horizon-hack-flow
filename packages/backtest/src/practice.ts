// Practice runs (lane STRAT): past data replayed as a live market on a virtual clock, with the selected AI engine
// deciding through the same tool names it uses live (ate_market_get, ate_candidates_get, ate_positions,
// ate_propose, ate_execute, ate_decide) — answered here by the paper market, never by the daemon, the journal or
// the chain. The AI only sees bars up to the virtual now. Sampling: the AI decides every N cycles that have
// something to decide; the rules decide in between. Each AI cycle has the live 90 s cutoff.

import { MARKETS, type MarketId } from "@ate/core";
import { resultOf, type BacktestResult } from "./backtest.js";
import { Simulator, type SimInput } from "./sim.js";

export interface ToolCallOut {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; hint?: string };
}

/** One AI cycle: call the tools as often as needed, then return. Must honour `signal`. */
export type PracticeDecider = (ctx: { cycle: number; at: number; call: (name: string, input: unknown) => Promise<ToolCallOut>; signal: AbortSignal }) => Promise<{ inputTokens?: number; outputTokens?: number; summary?: string } | void>;

export interface PracticeOptions extends SimInput {
  decider: PracticeDecider | null;
  /** AI decides on every Nth cycle that has a candidate (1 = all). */
  sampleEvery: number;
  /** Virtual seconds per real second; 0 = as fast as possible. */
  speed: number;
  cycleTimeoutMs?: number;
  /** Stop calling the AI after this many calls (the rest runs on rules). */
  maxAiCalls?: number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: PracticeEvent) => void;
}

export type PracticeEvent =
  | { type: "cycle"; cycle: number; at: number; pnlUsd: number; by: "llm" | "rules" | "none" }
  | { type: "decision"; decision: Simulator["decisions"][number] }
  | { type: "done"; stopped: boolean };

const usdt = (usd: number) => String(Math.round(usd * 1e6));
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const label = (m: MarketId) => (MARKETS[m].asset === "WBTC" ? "BTC" : "HSK");

/** The paper market behind the tool names (exported for tests). */
export function simTools(sim: Simulator) {
  const proposals = new Map<string, { candidateId: string | null; market: MarketId; side: "buy" | "sell"; usd: number; summary: string }>();
  let seq = 0;
  const decided = new Set<MarketId>();
  const summaryOf = (r: unknown) => {
    const s = typeof r === "string" ? r : "";
    const m = /Summary:\s*(.+)/.exec(s);
    return (m ? m[1]! : s.split("\n")[0]!).slice(0, 200);
  };
  const call = async (name: string, input: unknown): Promise<ToolCallOut> => {
    const a = (input ?? {}) as Record<string, unknown>;
    const pick = (m?: unknown): MarketId[] => (typeof m === "string" && sim.markets.includes(m as MarketId) ? [m as MarketId] : sim.markets);
    switch (name) {
      case "ate_market_get":
        return {
          ok: true,
          data: {
            practice: true,
            at: sim.now,
            markets: pick(a.market).map((m) => {
              const bars = sim.visibleBars(m);
              const last = bars[bars.length - 1];
              const h = sim.history(m)!;
              const gap = last?.pool && last.cex ? round(((last.pool - last.cex) / last.cex) * 100, 3) : null;
              return {
                market: m,
                label: label(m),
                poolPrice: last?.pool ?? null,
                cexMid: last?.cex ?? null,
                oraclePrice: last?.oracle ?? null,
                gapVsCexPct: gap,
                feePct: h.feeBps / 100,
                impactPctFor25Usd: round(sim.impactBps(m, 25) / 100, 3),
                recentCloses: bars.slice(-24).map((b) => ({ t: b.t + sim.barSec, pool: b.pool, cex: b.cex })),
              };
            }),
          },
        };
      case "ate_candidates_get": {
        const ms = pick(a.market);
        const cands = sim
          .candidates()
          .filter((c) => ms.includes(c.market))
          .map((c) => ({ candidateId: c.id, market: c.market, generator: "custom", leg: "open", side: c.side, maxAmountIn: usdt(c.maxUsd), maxUsd: c.maxUsd, reason: `${sim.input.spec.name}: ${c.reason}${c.boundBy ? ` (capped by ${c.boundBy})` : ""}${sim.input.spec.instructions ? `. The user's instructions: ${sim.input.spec.instructions}` : ""}`, expiresAt: sim.now + sim.barSec }));
        const held = ms.filter((m) => sim.state(m).tokens > 0).map((m) => ({ candidateId: `exit_${sim.cycle}_${label(m)}`, market: m, generator: "discretionary_exit", side: "sell", maxAmountIn: String(sim.state(m).tokens), maxUsd: round(sim.positionValue(m)), reason: "standing exit: sell early on your judgement", expiresAt: sim.now + sim.barSec }));
        return { ok: true, data: { practice: true, candidates: [...cands, ...held], suppressed: [] } };
      }
      case "ate_positions":
        return {
          ok: true,
          data: {
            practice: true,
            positions: pick(a.market).map((m) => {
              const s = sim.state(m);
              return { market: m, label: label(m), cashUsd: round(s.cash), tokens: s.tokens, valueUsd: round(s.tokens > 0 ? sim.positionValue(m) : 0), costUsd: round(s.costUsd), pnlPct: sim.pnlPct(m) === null ? null : round(sim.pnlPct(m)!, 3), buysToday: s.buysToday, budgetLeftUsd: round(sim.input.limits.dailyBudgetUsd - s.spentToday) };
            }),
            pnlUsd: round(sim.equity() - sim.capital),
          },
        };
      case "ate_propose": {
        const m = a.market as MarketId;
        if (!sim.markets.includes(m)) return { ok: false, error: { code: "ATE_INVALID_PARAMS", message: "unknown market" } };
        const side = a.side === "sell" ? "sell" : "buy";
        const cid = typeof a.candidateId === "string" ? a.candidateId : null;
        if (a.origin === "discretionary") return { ok: false, error: { code: "ATE_DISCRETIONARY_LIMIT", message: "practice runs test the strategy's candidates only", hint: "Bind a candidateId or decide no_trade" } };
        if (side === "buy") {
          const c = sim.candidates().find((x) => x.id === cid);
          if (!c) return { ok: false, error: { code: "ATE_CANDIDATE_REQUIRED", message: "a buy must carry a live candidateId" } };
          if (c.market !== m) return { ok: false, error: { code: "ATE_CANDIDATE_MISMATCH", message: "market does not match the candidate" } };
          const usd = Number(a.amountIn) / 1e6;
          if (!(usd > 0) || usd > c.maxUsd + 1e-6) return { ok: false, error: { code: "ATE_CANDIDATE_MISMATCH", message: `amountIn must be > 0 and ≤ maxAmountIn ${usdt(c.maxUsd)}` } };
          const id = `prp_sim_${++seq}`;
          proposals.set(id, { candidateId: c.id, market: m, side, usd, summary: summaryOf(a.rationale) });
          return { ok: true, data: { proposalId: id, status: "approved", practice: true } };
        }
        const s = sim.state(m);
        if (s.tokens <= 0) return { ok: false, error: { code: "ATE_INVALID_PARAMS", message: "nothing to sell" } };
        const tokens = Math.min(Number(a.amountIn) || s.tokens, s.tokens);
        const id = `prp_sim_${++seq}`;
        proposals.set(id, { candidateId: cid, market: m, side, usd: (tokens / s.tokens) * sim.positionValue(m), summary: summaryOf(a.rationale) });
        return { ok: true, data: { proposalId: id, status: "approved", practice: true } };
      }
      case "ate_execute": {
        const p = proposals.get(String(a.proposalId));
        if (!p) return { ok: false, error: { code: "ATE_INVALID_PARAMS", message: "unknown proposalId" } };
        proposals.delete(String(a.proposalId));
        const r = p.side === "buy" ? sim.take(p.candidateId!, p.usd, "llm", p.summary || "Bought") : sim.sellNow(p.market, p.usd, "llm", p.summary || "Sold early");
        if (!r.ok) return { ok: false, error: { code: "ATE_STRATEGY_BLOCKED", message: r.error } };
        decided.add(p.market);
        return { ok: true, data: { status: "filled", practice: true, usd: r.trade.usd, price: r.trade.price, feeUsd: r.trade.feeUsd } };
      }
      case "ate_decide": {
        const m = a.market as MarketId;
        const cid = typeof a.candidateId === "string" ? a.candidateId : null;
        const summary = summaryOf(a.rationale);
        const c = sim.candidates().find((x) => (cid ? x.id === cid : x.market === m));
        if (c) sim.skip(c.id, "llm", summary || "Skipped", a.reason === "llm_veto");
        decided.add(m);
        return { ok: true, data: { decisionId: `nt_sim_${sim.cycle}_${label(m)}`, practice: true } };
      }
      default:
        return { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: `${name} is not available in a practice run` } };
    }
  };
  return { call, reset: () => decided.clear() };
}

/** Tool names the practice backend answers. */
export const PRACTICE_TOOLS = ["ate_market_get", "ate_candidates_get", "ate_positions", "ate_propose", "ate_execute", "ate_decide"] as const;

export class PracticeSession {
  readonly sim: Simulator;
  private paused = false;
  private stopped = false;
  private stepOnce = false;
  private wake: (() => void) | null = null;
  private active: AbortController | null = null;
  aiCalls = 0;
  aiTokens = { input: 0, output: 0 };
  private candidateCycles = 0;

  constructor(readonly o: PracticeOptions) {
    this.sim = new Simulator(o);
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.wake?.();
  }
  step() {
    this.stepOnce = true;
    this.wake?.();
  }
  setSpeed(x: number) {
    this.o.speed = x;
    this.wake?.();
  }
  /** Ends the run after the current tool call; a running AI cycle is aborted. */
  stop() {
    this.stopped = true;
    this.active?.abort();
    this.wake?.();
  }
  get isPaused() {
    return this.paused;
  }

  async run(): Promise<BacktestResult & { stopped: boolean; aiCalls: number; aiTokens: { input: number; output: number } }> {
    const sim = this.sim;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const tools = simTools(sim);
    const emitted = { n: 0 };
    const flush = () => {
      for (; emitted.n < sim.decisions.length; emitted.n++) this.o.onEvent?.({ type: "decision", decision: sim.decisions[emitted.n]! });
    };
    while (!sim.done && !this.stopped) {
      while (this.paused && !this.stepOnce && !this.stopped) await new Promise<void>((r) => (this.wake = r));
      this.stepOnce = false;
      if (this.stopped) break;
      const cands = sim.open();
      let by: "llm" | "rules" | "none" = cands.length ? "rules" : "none";
      const aiTurn = cands.length > 0 && this.o.decider !== null && this.candidateCycles++ % Math.max(1, this.o.sampleEvery) === 0 && (this.o.maxAiCalls === undefined || this.aiCalls < this.o.maxAiCalls);
      if (aiTurn) {
        by = "llm";
        tools.reset();
        const ac = new AbortController();
        this.active = ac;
        const timer = setTimeout(() => ac.abort(), this.o.cycleTimeoutMs ?? 90_000);
        this.aiCalls++;
        try {
          const r = await this.o.decider!({ cycle: sim.cycle, at: sim.now, call: (n, i) => (ac.signal.aborted ? Promise.resolve({ ok: false, error: { code: "ATE_TIMEOUT", message: "cycle ended" } }) : tools.call(n, i)), signal: ac.signal });
          if (r) {
            this.aiTokens.input += r.inputTokens ?? 0;
            this.aiTokens.output += r.outputTokens ?? 0;
          }
        } catch {
          /* an engine error ends the cycle like a timeout */
        } finally {
          clearTimeout(timer);
          this.active = null;
        }
        if (ac.signal.aborted && !this.stopped) {
          for (const c of sim.candidates()) {
            sim.skip(c.id, "llm", "No decision in time: skipped");
            sim.decisions[sim.decisions.length - 1]!.action = "timeout";
          }
        }
        // anything the AI left open lapses as skipped
        for (const c of sim.candidates()) sim.skip(c.id, "llm", "Not taken");
      } else {
        for (const c of cands) sim.take(c.id, c.maxUsd, "rules", `Bought: ${c.reason}${c.boundBy ? `, capped by ${c.boundBy}` : ""}`);
      }
      sim.close();
      flush();
      this.o.onEvent?.({ type: "cycle", cycle: sim.cycle, at: sim.now, pnlUsd: round(sim.equity() - sim.capital), by });
      if (this.o.speed > 0 && !this.stopped) await sleep(Math.min(5000, (sim.barSec * 1000) / this.o.speed));
    }
    flush();
    this.o.onEvent?.({ type: "done", stopped: this.stopped });
    const res = resultOf(sim, { ...this.o, to: Math.min(this.o.to, sim.now) });
    return { ...res, stopped: this.stopped, aiCalls: this.aiCalls, aiTokens: this.aiTokens };
  }
}

/** How many AI calls a practice run will make, from the rules backtest's candidate cycles. */
export function estimateAiCalls(candidateCycles: number, sampleEvery: number, maxAiCalls?: number): number {
  const n = Math.ceil(candidateCycles / Math.max(1, sampleEvery));
  return maxAiCalls === undefined ? n : Math.min(n, maxAiCalls);
}

/** Cycles with at least one candidate in a rules run (the basis of the estimate). */
export function countCandidateCycles(o: SimInput): number {
  const sim = new Simulator(o);
  let n = 0;
  while (!sim.done) {
    const cs = sim.open();
    if (cs.length) n++;
    for (const c of cs) sim.take(c.id, c.maxUsd, "rules", "");
    sim.close();
  }
  return n;
}
