// Deterministic chat fallback (§11.5): handles the ★ intents when no LLM is configured or it fails. Replies are
// labelled engine=rules. Stateful only for the "HSK, BTC or both?" stop-loss scoping question.

import { MARKETS, MARKET_WBTC, MARKET_WHSK, type MarketId, type PositionsOutput, type StrategyPatch, type TargetAsset, type ToolResult } from "@ate/core";
import type { AteTools } from "@ate/trader";

export type Intent =
  | { kind: "positions" }
  | { kind: "stop"; field: "stopLossBps" | "takeProfitBps"; bps: number; markets: MarketId[] | null; conservative: boolean }
  | { kind: "targets"; patch: StrategyPatch; label: string }
  | { kind: "why"; market?: MarketId; hourUtc?: number }
  | { kind: "pause" }
  | { kind: "limits" }
  | { kind: "scope_answer"; markets: MarketId[] }
  | { kind: "unknown" };

const HSK = /\b(hsk|whsk)\b/i;
const BTC = /\b(btc|wbtc|bitcoin)\b/i;

function marketsIn(t: string): MarketId[] {
  const out: MarketId[] = [];
  if (HSK.test(t)) out.push(MARKET_WHSK);
  if (BTC.test(t)) out.push(MARKET_WBTC);
  return out;
}

export function parseIntent(text: string): Intent {
  const t = text.trim().toLowerCase();
  if (/^(both|hsk|whsk|btc|wbtc|bitcoin|hsk and btc|btc and hsk)[.!]?$/.test(t)) {
    return { kind: "scope_answer", markets: t === "both" || t.includes(" and ") ? [MARKET_WHSK, MARKET_WBTC] : marketsIn(t) };
  }
  if (/how am i doing|how are we doing|\bp&?l\b|positions?\b|portfolio/.test(t)) return { kind: "positions" };
  if (/stop everything|kill switch|pause (all|everything|trading)|halt/.test(t)) return { kind: "pause" };
  if (/(raise|increase|lift).*(daily cap|epoch|limit|exposure cap)/.test(t)) return { kind: "limits" };
  const stop = /(stop[ -]?(out|loss)|take[ -]?profit)[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*%/.exec(t);
  if (stop) {
    const pct = Number(stop[3]);
    const m = marketsIn(t);
    return {
      kind: "stop",
      field: stop[1]!.startsWith("take") ? "takeProfitBps" : "stopLossBps",
      bps: Math.round(pct * 100),
      markets: /\bboth\b/.test(t) ? [MARKET_WHSK, MARKET_WBTC] : m.length ? m : null,
      conservative: /conservative/.test(t),
    };
  }
  const target = /target\s+([0-9]+)\s*%\s*(hsk|whsk|btc|wbtc)/.exec(t) ?? /([0-9]+)\s*%\s*(hsk|whsk|btc|wbtc)/.exec(t);
  if (target && /target|allocat/.test(t)) {
    const market = HSK.test(target[2]!) ? MARKET_WHSK : MARKET_WBTC;
    return { kind: "targets", patch: { market, rebalanceTargetPct: Number(target[1]) }, label: `target ${target[1]}% ${MARKETS[market].label}` };
  }
  if (/go to cash|only trade|trade .* again|stop trading (hsk|btc)|keep the (btc|hsk)/.test(t)) {
    let assets: TargetAsset[];
    if (/only trade/.test(t)) assets = marketsIn(t.split("only trade")[1] ?? "").map((m) => MARKETS[m].asset);
    else if (/go to cash on (hsk|whsk)|stop trading hsk|keep the btc/.test(t)) assets = ["WBTC"];
    else if (/go to cash on (btc|wbtc)|stop trading btc|keep the hsk/.test(t)) assets = ["WHSK"];
    else if (/again/.test(t)) assets = ["WHSK", "WBTC"];
    else assets = [];
    return { kind: "targets", patch: { targetAssets: assets }, label: assets.length ? `trade only ${assets.join(", ")}` : "go to cash" };
  }
  if (/\bwhy\b/.test(t)) {
    const h = /at\s+([0-9]{1,2})\s*(am|pm)?/.exec(t);
    const hour = h ? (Number(h[1]) % 12) + (h[2] === "pm" ? 12 : 0) : undefined;
    const m = marketsIn(t);
    return { kind: "why", ...(m.length === 1 ? { market: m[0]! } : {}), ...(hour !== undefined ? { hourUtc: hour } : {}) };
  }
  return { kind: "unknown" };
}

export const RULES_HELP =
  'I can (rules mode): "How am I doing?", "Stop out at 2%" (then HSK, BTC or both), "Go to cash", "Go to cash on HSK, keep the BTC", "Only trade BTC", "Target 20% HSK", "Why did you sell at 3am?", "Stop everything".';

function fmtPositions(p: PositionsOutput): string {
  const lines: string[] = [];
  for (const m of p.markets) {
    const label = MARKETS[m.market].label;
    lines.push(
      `${label}: realised $${m.realisedUsd}; if sold now (exit-executable) $${m.unrealisedExitUsd} (${m.unrealisedExitBps} bps); at the oracle mark $${m.unrealisedCexUsd} (${m.unrealisedCexBps} bps); exposure $${m.exposureUsd}; fee drag $${m.feeDragUsd}; epoch left $${m.epoch.remainingUsd}; turnover left $${m.turnoverRemainingUsd}${m.paused ? "; PAUSED" : ""}`,
    );
  }
  const pf = p.portfolio;
  lines.push(`Portfolio: daily P&L $${pf.dailyPnlUsd}, exposure $${pf.exposureUsd}/$${pf.maxPortfolioExposureUsd}, turnover left $${pf.turnoverRemainingUsd}, breaker ${pf.breaker}.`);
  const s = p.scoreboard;
  lines.push(`AI scoreboard: ${s.acts} acts, ${s.vetoes} vetoes, ${s.sizeDowns} size-downs (saved ${s.savedBps} bps / $${s.savedUsd}), ${s.discretionary} discretionary.`);
  return lines.join("\n");
}

function errText(r: ToolResult<unknown>): string {
  if (r.ok) return "";
  if (r.error.code === "ATE_APPROVAL_REQUIRED") {
    const d = r.error.details as { renderedDiff?: string; changeId?: string } | undefined;
    return `This loosens risk, so it needs your Touch ID (ate-approve) before it applies:\n${d?.renderedDiff ?? r.error.message}${d?.changeId ? `\n(changeId ${d.changeId})` : ""}`;
  }
  return `${r.error.code}: ${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ""}`;
}

export interface RulesChat {
  handle(text: string): Promise<{ reply: string; engine: "rules"; tool?: string }>;
}

export function createRulesChat(tools: () => Promise<AteTools>): RulesChat {
  let pending: Extract<Intent, { kind: "stop" }> | null = null;

  async function applyStop(intent: Extract<Intent, { kind: "stop" }>, markets: MarketId[], userText: string) {
    const t = await tools();
    const out: string[] = [];
    for (const market of markets) {
      const patch: StrategyPatch = { market, [intent.field]: intent.bps };
      const r = await t.call("ate_strategy_set", { patch, rationale: `user (chat): ${userText}`.padEnd(16, ".") });
      const what = `${MARKETS[market].label} ${intent.field === "stopLossBps" ? "stop-loss" : "take-profit"} ${intent.bps / 100}%`;
      out.push(r.ok ? `${what}: applied${r.data.clamped ? " (clamped to limits)" : ""}.` : `${what}: ${errText(r)}`);
    }
    return out.join("\n");
  }

  return {
    async handle(text) {
      const intent = parseIntent(text);
      if (intent.kind === "scope_answer" && pending) {
        const p = pending;
        pending = null;
        return { reply: await applyStop(p, intent.markets, text), engine: "rules", tool: "ate_strategy_set" };
      }
      pending = null;
      const t = await tools();
      switch (intent.kind) {
        case "positions": {
          const r = await t.call("ate_positions", {});
          return { reply: r.ok ? fmtPositions(r.data) : errText(r), engine: "rules", tool: "ate_positions" };
        }
        case "stop": {
          if (!intent.markets) {
            pending = intent;
            return { reply: "HSK, BTC or both?", engine: "rules" };
          }
          return { reply: await applyStop(intent, intent.markets, text), engine: "rules", tool: "ate_strategy_set" };
        }
        case "targets": {
          const r = await t.call("ate_strategy_set", { patch: intent.patch, rationale: `user (chat): ${text}`.padEnd(16, ".") });
          const sell = intent.patch.targetAssets !== undefined ? " De-selected markets are sold down at once by the guard (reason=target_assets)." : "";
          return { reply: r.ok ? `Applied: ${intent.label}.${sell}` : errText(r), engine: "rules", tool: "ate_strategy_set" };
        }
        case "why": {
          const r = await t.call("ate_journal_read", { limit: 50, kind: ["execution", "proposal"], ...(intent.market ? { market: intent.market } : {}) });
          if (!r.ok) return { reply: errText(r), engine: "rules", tool: "ate_journal_read" };
          let es = r.data.entries.filter((e) => e.intent?.side === "sell" || e.kind === "execution");
          if (intent.hourUtc !== undefined) {
            const near = es.filter((e) => new Date(e.at * 1000).getUTCHours() === intent.hourUtc || new Date(e.at * 1000).getHours() === intent.hourUtc);
            if (near.length) es = near;
          }
          const e = es[0];
          if (!e) return { reply: "No matching sell in the journal.", engine: "rules", tool: "ate_journal_read" };
          return {
            reply: `${new Date(e.at * 1000).toISOString()} ${e.kind} ${e.id} (engine=${e.engine}, origin=${e.origin ?? "-"}${e.candidateId ? `, candidate ${e.candidateId}` : ""}${e.execution ? `, tx ${e.execution.txHash}` : ""}). Rationale: ${e.rationale}`,
            engine: "rules",
            tool: "ate_journal_read",
          };
        }
        case "pause": {
          const r = await t.call("ate_pause", { rationale: `user (chat): ${text}`.padEnd(16, ".") });
          const note = "Note: a pause also stops stop-loss exits — it freezes the remaining exposure until the owner unpauses. If you only want to stop risk, \"Go to cash\" sells down instead.";
          return { reply: r.ok ? `Paused: ${r.data.vaults.map((v) => `${MARKETS[v.market].label} ${v.status}${v.txHash ? ` ${v.txHash}` : ""}`).join(", ")}.\n${note}` : `${errText(r)}\n${note}`, engine: "rules", tool: "ate_pause" };
        }
        case "limits":
          return { reply: "On-chain limits can't be changed from chat. The owner runs `ate-owner set-limits --vault <address> …` on their own device.", engine: "rules" };
        default:
          return { reply: RULES_HELP, engine: "rules" };
      }
    },
  };
}
