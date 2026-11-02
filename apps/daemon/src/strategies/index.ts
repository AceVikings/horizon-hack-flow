// Lane STRAT (additive): custom strategies, backtests, practice runs and training — wiring + local API (ui scope;
// GETs also view). Everything here is read-only for the vaults except "use" (a normal strategy change: riskier →
// pending change approved with Touch ID or the one-time code through the existing /strategy/approve).
//
//   GET  /strategies                      → { strategies: SavedStrategy[], pending: chat-proposed saves }
//   POST /strategies/describe             { spec } → { ok, sentences, errors }
//   POST /strategies/draft                { text, base? } → { spec|null, sentences, errors, model }   (one AI call, no tools)
//   POST /strategies/save                 { spec, id? } → SavedStrategy (a new version when id is given)
//   POST /strategies/remove               { id }
//   POST /strategies/use                  { id|null, market: "HSK"|"BTC" } → { result (ToolResult of ate_strategy_set), riskier, reasons }
//   POST /strategies/confirm-save         { pendingId } · POST /strategies/drop-save { pendingId }
//   POST /backtest                        { strategyId?|spec?, days: 7|30|90 } → BacktestResult + sentences
//   POST /practice/estimate               { strategyId?|spec?, days, sampleEvery, maxAiCalls? } → AI calls, tokens, cost line
//   POST /practice/start                  { strategyId?|spec?, days, speed, sampleEvery, maxAiCalls?, engine?: ai|rules } → { runId }
//   POST /practice/state                  { runId } → live state (curve, decisions, result when done, rules comparison)
//   POST /practice/control                { runId, action: pause|resume|step|stop|speed, speed? }
//   POST /train                           { strategyId?|spec?, days, runId?, useAi? } → suggestions with tested effect + lessons
//   POST /sweep                           { strategyId?|spec?, days, params: [{path, values}], metric } → table, best, hold-out, warning
//   POST /strategies/adopt                { id, changes: [{path, value}], lessons? } → new version (use it separately)

import { MARKET_IDS, MARKETS, type AteConfig, type MarketId } from "@ate/core";
import { createChainClient } from "@ate/chain";
import { CexReader } from "@ate/oracle";
import type Database from "better-sqlite3";
import type { AiEngine } from "../engine.js";
import type { Routes } from "../http.js";
import type { AteService } from "../service.js";
import type { ChainHandle } from "../charts/service.js";
import { HistoryLoader } from "./history.js";
import { StrategyLab, readPrompt } from "./lab.js";

export { StrategyLab, extractJson, specHash } from "./lab.js";
export { HistoryLoader } from "./history.js";

export interface StrategyRoutesOptions {
  routes: Routes;
  cfg: AteConfig;
  db: Database.Database;
  service: AteService;
  ai: AiEngine;
  traderPromptFile: string;
  emit: (e: { type: string; at: number; data: unknown }) => void;
  /** True while the trader runs autonomously (Rules strategies and custom exits then trade as is). */
  autonomous: () => boolean;
  log?: (m: string) => void;
}

export function registerStrategyRoutes(o: StrategyRoutesOptions): StrategyLab {
  let main: ChainHandle | null = null;
  const mainnet = (): ChainHandle => {
    if (!main) {
      const c = createChainClient({ urls: process.env.ATE_MAINNET_RPC ? process.env.ATE_MAINNET_RPC.split(",") : ["https://mainnet.hsk.xyz"], chainId: 177, ...(o.log ? { log: o.log } : {}) });
      main = { chainId: 177, rpc: c.rpc, client: c.client };
    }
    return main;
  };
  const history = new HistoryLoader({ db: o.db, mainnet, cex: new CexReader({ baseUrl: o.cfg.oracle.cex.baseUrl }), ...(o.log ? { log: o.log } : {}) });
  const lab = new StrategyLab({ db: o.db, service: o.service, ai: o.ai, history, traderPrompt: readPrompt(o.traderPromptFile), emit: o.emit, ...(o.log ? { log: o.log } : {}) });
  o.service.strategies = { backtestTool: (a) => lab.backtestTool(a as never), saveFromChat: (a, via) => lab.saveFromChat(a, via) };
  o.service.customAuto = o.autonomous;

  const r = o.routes;
  const guard = async (json: (s: number, v: unknown) => void, f: () => unknown) => {
    try {
      json(200, await f());
    } catch (e) {
      const x = e as { status?: number; code?: string; message: string };
      json(x.status ?? 400, { error: { code: x.code ?? "ATE_INTERNAL", message: x.message } });
    }
  };
  const b = (x: unknown) => (x ?? {}) as Record<string, unknown>;
  const marketOf = (a: unknown): MarketId => {
    const m = MARKET_IDS.find((id) => (MARKETS[id].asset === "WBTC" ? "BTC" : "HSK") === a || id === a);
    if (!m) throw Object.assign(new Error("market must be HSK or BTC"), { status: 400, code: "ATE_INVALID_PARAMS" });
    return m;
  };
  const days = (x: unknown) => Number(x ?? 30);
  const pick = (x: Record<string, unknown>) => ({ ...(typeof x.strategyId === "string" ? { strategyId: x.strategyId } : { spec: x.spec }), days: days(x.days) });

  r.register({ method: "GET", path: "/strategies", scopes: ["ui", "view"], handler: ({ json }) => guard(json, () => ({ strategies: lab.list(), pending: lab.pendingSaves() })) });
  r.register({ method: "POST", path: "/strategies/describe", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.describe(b(body).spec)) });
  r.register({ method: "POST", path: "/strategies/draft", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.draft(String(b(body).text ?? ""), b(body).base)) });
  r.register({ method: "POST", path: "/strategies/save", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.save(b(body).spec, typeof b(body).id === "string" ? (b(body).id as string) : undefined)) });
  r.register({ method: "POST", path: "/strategies/remove", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.remove(String(b(body).id))) });
  r.register({ method: "POST", path: "/strategies/use", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.activate(marketOf(b(body).market), typeof b(body).id === "string" ? (b(body).id as string) : null)) });
  r.register({ method: "POST", path: "/strategies/confirm-save", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.confirmSave(String(b(body).pendingId))) });
  r.register({ method: "POST", path: "/strategies/drop-save", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.dropSave(String(b(body).pendingId))) });
  r.register({ method: "POST", path: "/strategies/adopt", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.adopt(String(b(body).id), (b(body).changes as never) ?? [], b(body).lessons as string[] | undefined)) });
  r.register({ method: "POST", path: "/backtest", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.backtest(pick(b(body)))) });
  r.register({
    method: "POST",
    path: "/practice/estimate",
    scopes: ["ui"],
    handler: ({ body, json }) => guard(json, () => lab.estimate({ ...pick(b(body)), sampleEvery: Number(b(body).sampleEvery ?? 1), ...(b(body).maxAiCalls ? { maxAiCalls: Number(b(body).maxAiCalls) } : {}) })),
  });
  r.register({
    method: "POST",
    path: "/practice/start",
    scopes: ["ui"],
    handler: ({ body, json }) =>
      guard(json, () => lab.startPractice({ ...pick(b(body)), speed: Number(b(body).speed ?? 600), sampleEvery: Number(b(body).sampleEvery ?? 1), ...(b(body).maxAiCalls ? { maxAiCalls: Number(b(body).maxAiCalls) } : {}), engine: b(body).engine === "rules" ? "rules" : "ai" })),
  });
  r.register({ method: "POST", path: "/practice/state", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.practice(String(b(body).runId))) });
  r.register({ method: "POST", path: "/practice/control", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.control(String(b(body).runId), b(body).action as never, b(body).speed as number | undefined)) });
  r.register({ method: "POST", path: "/train", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.train({ ...pick(b(body)), ...(typeof b(body).runId === "string" ? { runId: b(body).runId as string } : {}), useAi: b(body).useAi !== false })) });
  r.register({ method: "POST", path: "/sweep", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => lab.sweep({ ...pick(b(body)), params: b(body).params as never, metric: (b(body).metric as never) ?? "pnl" })) });
  return lab;
}
