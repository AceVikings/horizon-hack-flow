import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SIM_LIMITS, PracticeSession, Simulator, countCandidateCycles, depthFromQuote, depthFromSwaps, presetSpec, runBacktest, simTools, suggestImprovements, sweep, type PracticeDecider } from "../src/index.js";
import { BTC, FROM, input, spec, synthHistory } from "./helpers.js";

const GOLDEN = new URL("./fixtures/golden-7d.json", import.meta.url);

const digest = (r: ReturnType<typeof runBacktest>) => ({
  pnlUsd: r.pnlUsd,
  returnPct: r.returnPct,
  buys: r.buys,
  sells: r.sells,
  winRate: r.winRate,
  maxDrawdownPct: r.maxDrawdownPct,
  feesUsd: r.feesUsd,
  timeInMarketPct: r.timeInMarketPct,
  hold: r.hold,
  preset: r.preset,
  summary: r.summary.line,
  firstTrades: r.trades.slice(0, 6).map((t) => ({ t: t.t, side: t.side, usd: Math.round(t.usd * 100) / 100, by: t.by, reason: t.reason, pnlUsd: t.pnlUsd === undefined ? null : Math.round(t.pnlUsd * 1e4) / 1e4 })),
});

describe("backtest", () => {
  const preset = presetSpec("balanced", { assets: ["BTC"], feeBps: 30, halfSpreadBps: 1, impactBps: 5, dailyBudgetUsd: 100, cooldownMin: 30, name: "Balanced" });
  it("matches the golden result (deterministic)", () => {
    const r = runBacktest({ ...input(7), compareTo: { name: "Balanced", spec: preset } });
    const d = digest(r);
    if (process.env.UPDATE_GOLDEN || !existsSync(GOLDEN)) writeFileSync(GOLDEN, JSON.stringify(d, null, 2) + "\n");
    expect(d).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
    expect(digest(runBacktest({ ...input(7), compareTo: { name: "Balanced", spec: preset } }))).toEqual(d);
    expect(r.buys).toBeGreaterThan(3);
    expect(r.summary.line).toMatch(/^Over 7 days: [+−]?[\d.]+%, \d+ trades, worst dip/);
  });
  it("honours the limits: trade cap, daily budget, buys a day, cooldown", () => {
    const r = runBacktest(input(7, spec({ sizing: { mode: "usd", value: 100 }, limits: { maxTradesPerDay: 48, cooldownMin: 0 } })));
    const buys = r.trades.filter((t) => t.side === "buy");
    expect(Math.max(...buys.map((t) => t.usd))).toBeLessThanOrEqual(DEFAULT_SIM_LIMITS.maxTradeUsd + 1e-6);
    const perDay = new Map<number, number>();
    for (const b of buys) perDay.set(Math.floor(b.t / 86_400), (perDay.get(Math.floor(b.t / 86_400)) ?? 0) + b.usd);
    for (const v of perDay.values()) expect(v).toBeLessThanOrEqual(DEFAULT_SIM_LIMITS.dailyBudgetUsd + 1e-6);
    const r2 = runBacktest(input(7, spec({ limits: { maxTradesPerDay: 2, cooldownMin: 120 } })));
    const b2 = r2.trades.filter((t) => t.side === "buy");
    for (let k = 1; k < b2.length; k++) expect(b2[k]!.t - b2[k - 1]!.t).toBeGreaterThanOrEqual(7200);
    const cnt = new Map<number, number>();
    for (const b of b2) cnt.set(Math.floor(b.t / 86_400), (cnt.get(Math.floor(b.t / 86_400)) ?? 0) + 1);
    for (const v of cnt.values()) expect(v).toBeLessThanOrEqual(2);
  });
  it("the guard stop sells and locks re-entry", () => {
    const r = runBacktest({ ...input(7, spec({ exit: { takeProfitPct: 30 } })), limits: { ...DEFAULT_SIM_LIMITS, guardStopPct: 0.4, reentryCooldownSec: 6 * 3600 } });
    const stop = r.trades.find((t) => t.side === "sell" && t.by === "guard");
    expect(stop?.reason).toMatch(/safety stop/);
    const next = r.trades.find((t) => t.side === "buy" && t.t > stop!.t);
    if (next) expect(next.t - stop!.t).toBeGreaterThanOrEqual(6 * 3600);
  });
  it("says what the data cannot show", () => {
    const h = synthHistory(BTC, 3);
    h.pool = h.pool.filter((_, k) => k % 40 === 0);
    const r = runBacktest({ ...input(3), histories: [h] });
    expect(r.coverage.join(" ")).toMatch(/traded only \d+ times/);
    expect(r.coverage.join(" ")).toMatch(/do not move the replayed prices/);
  });
  it("calibrates depth", () => {
    expect(depthFromQuote(100, 10)).toBeCloseTo(99_700, 0);
    expect(depthFromSwaps(synthHistory(BTC, 1).pool)).toBeGreaterThan(0);
  });
});

describe("practice", () => {
  it("the AI never sees past the virtual now", async () => {
    let maxSeen = 0;
    let late = 0;
    const decider: PracticeDecider = async ({ call, at }) => {
      const m = (await call("ate_market_get", {})).data as { markets: { recentCloses: { t: number }[] }[] };
      for (const x of m.markets[0]!.recentCloses) {
        maxSeen = Math.max(maxSeen, x.t);
        if (x.t > at) late++;
      }
      const c = (await call("ate_candidates_get", {})).data as { candidates: { candidateId: string; maxAmountIn: string; generator: string }[] };
      const e = c.candidates.find((x) => x.generator === "custom");
      if (e) {
        const p = await call("ate_propose", { market: BTC, side: "buy", amountIn: String(Math.floor(Number(e.maxAmountIn) / 2)), candidateId: e.candidateId, rationale: "Summary: Bought half.\nDetails: test" });
        await call("ate_execute", { proposalId: (p.data as { proposalId: string }).proposalId });
      }
    };
    const run = (mutateFuture: boolean) => {
      const inp = input(3);
      if (mutateFuture) {
        const cut = FROM + 2 * 86_400;
        const h = inp.histories[0]!;
        h.pool = h.pool.map((p) => (p.t > cut ? { ...p, v: p.v * 1.5 } : p));
        h.cex = h.cex.map((p) => (p.t > cut ? { ...p, v: p.v * 0.5 } : p));
      }
      return new PracticeSession({ ...inp, decider, sampleEvery: 1, speed: 0 }).run();
    };
    const a = await run(false);
    expect(late).toBe(0);
    expect(maxSeen).toBeGreaterThan(FROM);
    const b = await run(true);
    const cut = FROM + 2 * 86_400;
    const before = (r: typeof a) => r.decisions.filter((d) => d.t <= cut).map((d) => [d.t, d.action, d.usd]);
    expect(before(b)).toEqual(before(a));
    expect(a.decisions.some((d) => d.action === "sized_down" && d.by === "llm")).toBe(true);
  });
  it("binds the AI to the candidate: never more than its max", async () => {
    const sim = new Simulator(input(3));
    const tools = simTools(sim);
    let c = sim.open();
    while (!c.length && !sim.done) {
      sim.close();
      c = sim.open();
    }
    const over = await tools.call("ate_propose", { market: BTC, side: "buy", amountIn: String(Math.round((c[0]!.maxUsd + 1) * 1e6)), candidateId: c[0]!.id, rationale: "x" });
    expect(over.ok).toBe(false);
    const none = await tools.call("ate_propose", { market: BTC, side: "buy", amountIn: "1000000", rationale: "x" });
    expect(none.error?.code).toBe("ATE_CANDIDATE_REQUIRED");
    expect((await tools.call("ate_pause", {})).error?.code).toBe("ATE_TOOL_NOT_ALLOWED");
  });
  it("a cycle that runs past the cutoff ends as timeout and the run goes on; stop ends cleanly", async () => {
    const hang: PracticeDecider = ({ signal }) => new Promise((res) => signal.addEventListener("abort", () => res()));
    const s = new PracticeSession({ ...input(2), decider: hang, sampleEvery: 1, speed: 0, cycleTimeoutMs: 5, maxAiCalls: 3 });
    const r = await s.run();
    expect(r.decisions.filter((d) => d.action === "timeout").length).toBe(3);
    expect(r.aiCalls).toBe(3);
    expect(r.decisions.some((d) => d.by === "rules")).toBe(true);
    const s2 = new PracticeSession({ ...input(2), decider: hang, sampleEvery: 1, speed: 0, cycleTimeoutMs: 60_000 });
    setTimeout(() => s2.stop(), 20);
    const r2 = await s2.run();
    expect(r2.stopped).toBe(true);
    expect(r2.aiCalls).toBe(1);
  });
  it("samples the AI every N candidate cycles", async () => {
    let calls = 0;
    const n = countCandidateCycles(input(3));
    const r = await new PracticeSession({ ...input(3), decider: async () => void calls++, sampleEvery: 4, speed: 0 }).run();
    expect(calls).toBe(r.aiCalls);
    expect(calls).toBeLessThanOrEqual(Math.ceil(n / 4) + 1);
    expect(calls).toBeGreaterThan(0);
  });
});

describe("training", () => {
  it("suggests tested changes with their effect in words", () => {
    const base = input(7);
    const r = runBacktest(base);
    const s = suggestImprovements(base, r);
    for (const x of s) {
      expect(x.pnlDeltaUsd).toBeGreaterThanOrEqual(0);
      expect(x.effect).toMatch(/over 7 days\.$/);
    }
  });
  it("sweeps on the first part and checks the winner on a hold-out", () => {
    const res = sweep({ base: input(10), params: [{ path: "entry.conditions.0.value", values: [-0.3, -0.6, -0.9] }, { path: "exit.takeProfitPct", values: [0.3, 0.6] }], metric: "pnl" });
    expect(res.rows.length).toBe(6);
    expect(res.holdout?.from).toBe(res.inSample.to);
    expect(res.best?.score).toBe(Math.max(...res.rows.map((x) => x.score)));
    expect(typeof res.warning === "string" || res.warning === null).toBe(true);
  });
});
