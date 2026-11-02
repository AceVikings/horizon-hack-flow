// StrategyPatcher (§7.2 ate_strategy_set, §11.5): riskProfile expansion, clamping to on-chain limits and the
// agent tuning range, and loosening detection (direction table; a patch with any loosening field is loosening).

import {
  AGENT_TUNABLE_FIELDS,
  AteError,
  LOOSENING_DIRECTION,
  MARKETS,
  RISK_PROFILES,
  TARGET_ASSETS,
  type MarketId,
  type MarketStrategyParams,
  type StrategyFieldChange,
  type StrategyParams,
  type StrategyPatch,
  type StrategyPatcher,
  type VaultState,
} from "@ate/core";
import { isDemo } from "./params.js";
import { DISCRETIONARY_MAX_PER_DAY, DISCRETIONARY_MAX_USD } from "./guard.js";
import { minB, usdE8, usdStr } from "./units.js";

type Scope = "agent" | "chat" | "ui" | "session";

const PORTFOLIO_FIELDS = new Set<keyof StrategyPatch>([
  "targetAssets",
  "maxDailyTurnoverUsd",
  "maxPortfolioExposureUsd",
  "dailyLossLimitUsd",
  "discretionaryTradesPerDay",
  "discretionaryUsd",
]);
const MARKET_FIELDS = [
  "minNetEdgeBps",
  "rebalanceTargetPct",
  "rebalanceBandPct",
  "maxPositionUsd",
  "tradeSizeUsd",
  "cycleSeconds",
  "entrySpreadBps",
  "stopLossBps",
  "takeProfitBps",
  "reentryCooldownSec",
] as const satisfies readonly (keyof StrategyPatch & keyof MarketStrategyParams)[];
type MarketField = (typeof MARKET_FIELDS)[number];

const USD_FIELDS = new Set<string>(["maxPositionUsd", "tradeSizeUsd", "maxDailyTurnoverUsd", "maxPortfolioExposureUsd", "dailyLossLimitUsd", "discretionaryUsd"]);

/** Static bounds (config schema §16). */
const BOUNDS: Partial<Record<keyof StrategyPatch, [number, number]>> = {
  cycleSeconds: [30, 86_400],
  entrySpreadBps: [10, 2000],
  minNetEdgeBps: [0, 2000],
  rebalanceTargetPct: [0, 100],
  rebalanceBandPct: [1, 50],
  stopLossBps: [50, 5000],
  takeProfitBps: [10, 5000],
  reentryCooldownSec: [0, 86_400],
  discretionaryTradesPerDay: [0, DISCRETIONARY_MAX_PER_DAY],
};

const num = (field: string, v: unknown): number => (USD_FIELDS.has(field) ? Number(usdE8(String(v))) / 1e8 : Number(v));

/** Expanded patch for one market scope: riskProfile fields first, explicit fields win; demo markets take only stop/position. */
export function expandRiskProfile(patch: StrategyPatch, market: MarketId | null, current: StrategyParams): StrategyPatch {
  if (!patch.riskProfile) return patch;
  const preset = RISK_PROFILES[patch.riskProfile];
  const demo = market !== null && current.markets[market] ? isDemo(market, current.markets[market]) : false;
  const base: StrategyPatch = demo ? { stopLossBps: preset.stopLossBps, maxPositionUsd: preset.maxPositionUsd } : { ...preset };
  const { riskProfile: _rp, ...rest } = patch;
  return { ...base, ...rest };
}

/** True when the patch changes stop-loss / take-profit without naming a market (chat must ask "HSK, BTC or both?"). */
export function needsMarketScope(patch: StrategyPatch): boolean {
  return !patch.market && (patch.stopLossBps !== undefined || patch.takeProfitBps !== undefined);
}

function isLoosening(field: keyof StrategyPatch, before: unknown, after: unknown): boolean {
  if (field === "rebalanceTargetPct") {
    const b = before === null || before === undefined ? 0 : Number(before);
    return Number(after) > b && Number(after) > 0;
  }
  const dir = LOOSENING_DIRECTION[field];
  if (!dir) return false;
  if (dir === "any") return before !== after;
  const b = num(field, before);
  const a = num(field, after);
  return dir === "up" ? a > b : a < b;
}

export function applyPatch(
  patch: StrategyPatch,
  scope: Scope,
  current: StrategyParams,
  anchors: StrategyParams,
  vaults: Partial<Record<MarketId, VaultState>>,
): { next: StrategyParams; changes: StrategyFieldChange[]; clamped: boolean; needsApproval: boolean } {
  if (scope === "agent") {
    const allowed = new Set<string>([...AGENT_TUNABLE_FIELDS, "market"]);
    const bad = Object.keys(patch).filter((k) => !allowed.has(k) && (patch as Record<string, unknown>)[k] !== undefined);
    if (bad.length) {
      throw new AteError("StrategyError", "ATE_TOOL_NOT_ALLOWED", `agent scope may change only ${AGENT_TUNABLE_FIELDS.join(", ")}; got ${bad.join(", ")}`, {
        hint: "Ask the user to change other fields via Chat",
      });
    }
  }
  if (patch.market && !MARKETS[patch.market]) throw new AteError("StrategyError", "ATE_MARKET_UNKNOWN", `unknown market ${patch.market}`);

  const next: StrategyParams = structuredClone(current);
  const changes: StrategyFieldChange[] = [];
  let clamped = false;

  const record = (sc: StrategyFieldChange["scope"], field: keyof StrategyPatch, before: unknown, after: unknown, requested: unknown, clampedBy?: string) => {
    if (JSON.stringify(before) === JSON.stringify(after) && !clampedBy) return;
    const ch: StrategyFieldChange = { scope: sc, field, before, after, loosening: isLoosening(field, before, after) };
    if (clampedBy) {
      ch.requested = requested;
      ch.clampedBy = clampedBy;
      clamped = true;
    }
    changes.push(ch);
  };

  // ---- portfolio fields
  const allVaults = Object.values(vaults).filter((v): v is VaultState => !!v);
  const p = next.portfolio;
  if (patch.targetAssets !== undefined) {
    const uniq = [...new Set(patch.targetAssets)].filter((a) => (TARGET_ASSETS as readonly string[]).includes(a));
    const before = [...p.targetAssets];
    p.targetAssets = uniq;
    if (JSON.stringify(before) !== JSON.stringify(uniq)) {
      changes.push({ scope: "portfolio", field: "targetAssets", before, after: uniq, loosening: uniq.some((a) => !before.includes(a)) });
    }
  }
  const usdField = (field: "maxDailyTurnoverUsd" | "maxPortfolioExposureUsd" | "dailyLossLimitUsd" | "discretionaryUsd", cap?: { e8: bigint; by: string }) => {
    const req = patch[field];
    if (req === undefined) return;
    let v = usdE8(req);
    let by: string | undefined;
    if (cap && v > cap.e8) {
      v = cap.e8;
      by = cap.by;
    }
    const before = p[field];
    p[field] = usdStr(v);
    record("portfolio", field, before, p[field], req, by);
  };
  const sumExposure = allVaults.reduce((a, v) => a + BigInt(v.limits.maxExposureUsdE8), 0n);
  const sumTurnover = allVaults.reduce((a, v) => a + (BigInt(v.limits.maxEpochUsdE8) - BigInt(v.limits.maxExposureUsdE8)), 0n);
  usdField("maxPortfolioExposureUsd", allVaults.length ? { e8: sumExposure, by: "Σ vault maxExposureUsd" } : undefined);
  usdField("maxDailyTurnoverUsd", allVaults.length && sumTurnover > 0n ? { e8: sumTurnover, by: "Σ vault (maxEpochUsd − maxExposureUsd)" } : undefined);
  usdField("dailyLossLimitUsd");
  usdField("discretionaryUsd", { e8: usdE8(DISCRETIONARY_MAX_USD), by: "v0.1 maximum $10" });
  if (patch.discretionaryTradesPerDay !== undefined) {
    const req = patch.discretionaryTradesPerDay;
    const v = Math.max(0, Math.min(DISCRETIONARY_MAX_PER_DAY, Math.round(req)));
    const before = p.discretionaryTradesPerDay;
    p.discretionaryTradesPerDay = v;
    record("portfolio", "discretionaryTradesPerDay", before, v, req, v !== req ? "v0.1 maximum 3/day" : undefined);
  }

  // ---- enabled
  if (patch.enabled !== undefined) {
    if (patch.market) {
      const m = next.markets[patch.market];
      const before = m.enabled ?? true;
      m.enabled = patch.enabled;
      if (before !== patch.enabled) changes.push({ scope: patch.market, field: "enabled", before, after: patch.enabled, loosening: patch.enabled && !before });
    } else {
      const before = next.enabled;
      next.enabled = patch.enabled;
      if (before !== patch.enabled) changes.push({ scope: "portfolio", field: "enabled", before, after: patch.enabled, loosening: patch.enabled && !before });
    }
  }

  // ---- market fields
  const marketIds = Object.keys(next.markets) as MarketId[];
  const enabledMarkets = marketIds.filter((id) => next.markets[id].enabled !== false && next.portfolio.targetAssets.includes(MARKETS[id].asset));
  const targets: MarketId[] = patch.market ? [patch.market] : enabledMarkets.length ? enabledMarkets : marketIds;
  const [lo, hi] = current.portfolio.agentTuneRange;
  for (const id of targets) {
    const mp = expandRiskProfile(patch, id, current);
    const m = next.markets[id];
    const vault = vaults[id];
    for (const field of MARKET_FIELDS) {
      const req = mp[field];
      if (req === undefined) continue;
      if (PORTFOLIO_FIELDS.has(field)) continue;
      let by: string | undefined;
      let val: number | string = req as number | string;
      if (USD_FIELDS.has(field)) {
        let e8 = usdE8(String(req));
        if (field === "maxPositionUsd" && vault && e8 > BigInt(vault.limits.maxExposureUsdE8)) {
          e8 = BigInt(vault.limits.maxExposureUsdE8);
          by = "vault maxExposureUsd";
        }
        if (field === "tradeSizeUsd" && vault && e8 > BigInt(vault.limits.maxTradeUsdE8)) {
          e8 = BigInt(vault.limits.maxTradeUsdE8);
          by = "vault maxTradeUsd";
        }
        if (scope === "agent" && field === "tradeSizeUsd") {
          const anchor = usdE8(anchors.markets[id].tradeSizeUsd);
          const loE = (anchor * BigInt(Math.round(lo * 1000))) / 1000n;
          const hiE = minB((anchor * BigInt(Math.round(hi * 1000))) / 1000n, vault ? BigInt(vault.limits.maxTradeUsdE8) : 10n ** 30n);
          if (e8 < loE) [e8, by] = [loE, `agent tune range ×${lo}`];
          if (e8 > hiE) [e8, by] = [hiE, `agent tune range ×${hi}`];
        }
        val = usdStr(e8);
      } else {
        let n = Math.round(Number(req));
        const b = BOUNDS[field];
        if (b && n < b[0]) [n, by] = [b[0], `minimum ${b[0]}`];
        if (b && n > b[1]) [n, by] = [b[1], `maximum ${b[1]}`];
        if (scope === "agent" && (AGENT_TUNABLE_FIELDS as readonly string[]).includes(field)) {
          const anchor = anchors.markets[id][field as "entrySpreadBps" | "minNetEdgeBps" | "cycleSeconds"];
          const loN = Math.ceil(anchor * lo);
          const hiN = Math.floor(anchor * hi);
          if (n < loN) [n, by] = [loN, `agent tune range ×${lo}`];
          if (n > hiN) [n, by] = [hiN, `agent tune range ×${hi}`];
          if (field === "cycleSeconds" && n < 30) [n, by] = [30, "minimum 30"];
        }
        val = n;
      }
      const before = m[field as MarketField];
      (m as unknown as Record<string, unknown>)[field] = val;
      record(id, field, before, val, req, by);
    }
  }

  const needsApproval = scope !== "agent" && changes.some((c) => c.loosening);
  return { next, changes, clamped, needsApproval };
}

export function createStrategyPatcher(): StrategyPatcher {
  return { apply: (patch, scope, current, anchors, vaults) => applyPatch(patch, scope, current, anchors, vaults) };
}

/** Plain-text before/after diff for ate-approve (§11.5). */
export function renderDiff(changes: StrategyFieldChange[]): string {
  const label = (s: StrategyFieldChange["scope"]) => (s === "portfolio" ? "portfolio" : MARKETS[s].label);
  return changes
    .map((c) => `${label(c.scope)}.${String(c.field)}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}${c.loosening ? "  [LOOSENING]" : ""}${c.clampedBy ? `  (requested ${JSON.stringify(c.requested)}, clamped by ${c.clampedBy})` : ""}`)
    .join("\n");
}
