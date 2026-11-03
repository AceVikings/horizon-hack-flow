import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG, type StrategyParams } from "@ate/core";
import type { MarketHistory } from "@ate/backtest";
import { StrategyLab, extractJson } from "../src/strategies/lab.js";

const SPEC = {
  name: "Gap buyer",
  kind: "rules",
  markets: ["BTC"],
  entry: { conditions: [{ signal: "gap_cex", op: "below", value: -0.5 }] },
  exit: { takeProfitPct: 0.5, stopLossPct: 2 },
  sizing: { mode: "usd", value: 10 },
  limits: { maxTradesPerDay: 4, cooldownMin: 30 },
};

function history(market: string, days: number): MarketHistory {
  const to = 1_790_000_000;
  const from = to - days * 86_400;
  const pool: { t: number; v: number; vol: number }[] = [];
  const cex: { t: number; v: number }[] = [];
  for (let t = from - 86_400, k = 0; t <= to; t += 600, k++) {
    const p = 100_000 * (1 + 0.01 * Math.sin(k / 50));
    cex.push({ t, v: p });
    pool.push({ t: t + 30, v: p * (1 - 0.008 * Math.max(0, Math.sin(k / 7))), vol: 50 });
  }
  return { market: market as never, from, to, pool, cex, oracle: [], depthUsd: 50_000, depthSource: "a test depth", feeBps: 30, halfSpreadBps: 1, notes: [] };
}

function lab(over: { propose?: (riskier: boolean) => unknown } = {}) {
  const strategy = JSON.parse(JSON.stringify({ ...DEFAULT_STRATEGY_CONFIG, portfolio: { ...DEFAULT_STRATEGY_CONFIG.portfolio, candidateTtlSec: 120 } })) as StrategyParams;
  const calls: { riskier: boolean; rationale: string }[] = [];
  const service = {
    strategy,
    vaultState: () => undefined,
    portfolio: () => ({ strategy, markets: {} }),
    proposeStrategyChange: (_s: string, next: StrategyParams, _c: unknown, rationale: string, riskier: boolean) => {
      calls.push({ riskier, rationale });
      if (!riskier) Object.assign(strategy, next);
      return riskier ? { ok: false, error: { code: "ATE_APPROVAL_REQUIRED", message: "x" } } : { ok: true, data: { status: "applied" } };
    },
  };
  const l = new StrategyLab({ db: new Database(":memory:"), service: service as never, ai: {} as never, history: { load: async (m: string, d: number) => history(m, d) } as never, traderPrompt: "p", emit: () => {}, ...over });
  return { l, calls, strategy };
}

describe("strategy lab", () => {
  it("saves versions with a spec hash, reads them back as sentences, and removes", () => {
    const { l } = lab();
    const a = l.save(SPEC);
    expect(a.version).toBe(1);
    expect(a.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.sentences[0]).toBe("Buys $10 of BTC when the pool price is more than 0.5% under the HashKey Global exchange price.");
    expect(l.save(SPEC, a.id).version).toBe(1); // same spec → same version
    const b = l.save({ ...SPEC, sizing: { mode: "usd", value: 5 } }, a.id);
    expect(b.version).toBe(2);
    expect(b.hash).not.toBe(a.hash);
    expect(l.list()).toHaveLength(1);
    expect(l.get(a.id, 1)?.spec.sizing.value).toBe(10);
    expect(l.remove(a.id).removed).toBe(true);
    expect(l.list()).toHaveLength(0);
  });
  it("backtests a saved strategy and keeps the one-line result", async () => {
    const { l } = lab();
    const s = l.save(SPEC);
    const r = await l.backtest({ strategyId: s.id, days: 7 });
    expect(r.summary.line).toMatch(/^Over 7 days/);
    expect(r.preset?.name).toBe("Balanced");
    expect(l.get(s.id)?.lastBacktest?.line).toBe(r.summary.line);
    await expect(l.backtest({ strategyId: s.id, days: 12 })).rejects.toThrow(/7, 30 or 90/);
  });
  it("chat proposals wait for the user's OK; backtests from chat are read-only", async () => {
    const { l } = lab();
    const p = l.saveFromChat({ specJson: JSON.stringify(SPEC), rationale: "user asked" }, "chat") as { pendingId: string; sentences: string[] };
    expect(l.list()).toHaveLength(0);
    expect(p.sentences.length).toBeGreaterThan(2);
    const saved = l.confirmSave(p.pendingId);
    expect(l.list().map((x) => x.id)).toEqual([saved.id]);
    const listed = (await l.backtestTool({})) as { strategies: unknown[] };
    expect(listed.strategies).toHaveLength(1);
    const bt = (await l.backtestTool({ specJson: JSON.stringify(SPEC), days: 7 })) as { summary: string; days: number; curve: { t: number; v: number }[] };
    expect(bt.summary).toMatch(/^Over 7 days/);
    // Ask draws a result card from it: a short P&L curve, not the full ≤ 600-point one
    expect(bt.days).toBe(7);
    expect(bt.curve.length).toBeGreaterThan(0);
    expect(bt.curve.length).toBeLessThanOrEqual(81);
  });
  it("using a riskier strategy asks first; a safer one applies and carries the spec hash", () => {
    const { l, calls, strategy } = lab();
    const big = l.save({ ...SPEC, sizing: { mode: "usd", value: 100 }, limits: { maxTradesPerDay: 40, cooldownMin: 0 } });
    const r1 = l.activate("hsk-dex:WBTC/USDT:3000", big.id);
    expect(r1.riskier).toBe(true);
    expect(calls[0]!.riskier).toBe(true);
    const small = l.save({ ...SPEC, sizing: { mode: "usd", value: 5 }, limits: { maxTradesPerDay: 1, cooldownMin: 240 } });
    const r2 = l.activate("hsk-dex:WBTC/USDT:3000", small.id);
    expect(r2.riskier).toBe(false);
    expect(calls[1]!.rationale).toContain(small.hash);
    expect(strategy.markets["hsk-dex:WBTC/USDT:3000"].custom?.id).toBe(small.id);
    expect(() => l.activate("hsk-dex:WHSK/USDT:3000", small.id)).toThrow(/does not trade HSK/);
  });
  it("reads JSON out of a model answer", () => {
    expect(extractJson('Sure!\n```json\n{"a": {"b": "}"}}\n```')).toEqual({ a: { b: "}" } });
    expect(extractJson("no json")).toBe(null);
  });
});
