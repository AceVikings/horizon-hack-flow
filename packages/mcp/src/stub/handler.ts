// Transport-free stub tool handler: frozen schemas in, schema-valid canned ToolResults out.
// Mimics the real server's scope rules (§7.1, §11.5) and the main error paths so lanes can test them.

import {
  CHAT_TOOL_ALLOWLIST,
  LOOSENING_DIRECTION,
  RISK_PROFILES,
  MARKET_IDS,
  TOOL_NAMES,
  fail,
  ok,
  toolsForScope,
  wrapUntrusted,
  type CandidatesGetOutput,
  type DecideInput,
  type ExecuteInput,
  type JournalReadInput,
  type MarketId,
  type ProposeInput,
  type QuoteInput,
  type StrategyFieldChange,
  type StrategyPatch,
  type StrategySetInput,
  type ToolName,
  type ToolOutput,
  type ToolResult,
} from "@ate/core";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../schemas.js";
import { validateToolInput } from "../validate.js";
import {
  FIXTURE_BLOCK,
  FIXTURE_CANDIDATES,
  FIXTURE_NOW,
  STUB_JOURNAL,
  STUB_MARKETS,
  STUB_POSITIONS,
  STUB_STRATEGY,
  stubQuote,
} from "./fixtures.js";

export interface StubOptions {
  scope: "agent" | "chat";
  hsp: boolean;
  /** Clock override for tests; defaults to the fixture time so candidates never expire in the stub. */
  now?: () => number;
}

export class InvalidParamsError extends Error {
  constructor(readonly tool: string, readonly errors: string[]) {
    super(`invalid arguments for ${tool}: ${errors.join("; ")}`);
  }
}
export class UnknownToolError extends Error {}

const meta = () => ({ latencyMs: 1, blockNumber: FIXTURE_BLOCK });
const hex16 = (n: number) => n.toString(16).padStart(16, "0");
const pick = <T extends { market: MarketId }>(xs: T[], market?: MarketId) => (market ? xs.filter((x) => x.market === market) : xs);

const AGENT_FIELDS = new Set<keyof StrategyPatch>(["entrySpreadBps", "minNetEdgeBps", "tradeSizeUsd", "cycleSeconds", "market"]);

export function createStubHandler(opts: StubOptions) {
  const now = opts.now ?? (() => FIXTURE_NOW);
  const visible = new Set<ToolName>(toolsForScope(opts.scope, { hsp: opts.hsp }));
  const proposals = new Map<string, { market: MarketId; side: "buy" | "sell"; amountIn: string; used: boolean }>();
  let seq = 0;

  function listTools(): ToolDefinition[] {
    return TOOL_NAMES.filter((n) => visible.has(n)).map((n) => TOOL_DEFINITIONS[n]);
  }

  function callTool(name: string, rawArgs: unknown): ToolResult<unknown> {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new UnknownToolError(`unknown tool ${name}`);
    const tool = name as ToolName;
    if (!visible.has(tool)) {
      return fail(
        "ATE_TOOL_NOT_ALLOWED",
        `${tool} is not available to the ${opts.scope} scope`,
        opts.scope === "chat" ? `Chat may call only: ${CHAT_TOOL_ALLOWLIST.join(", ")}` : "ate_signal_buy is registered only when HSP payments are live",
      );
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const v = validateToolInput(tool, args);
    if (!v.ok) throw new InvalidParamsError(tool, v.errors);
    return dispatch(tool, args);
  }

  function dispatch(tool: ToolName, args: Record<string, unknown>): ToolResult<unknown> {
    const market = args.market as MarketId | undefined;
    switch (tool) {
      case "ate_chart":
      case "ate_data":
        return fail("ATE_VENUE_ERROR", "charts and tables need a live daemon (not served by the stub)", "Run ate-daemon");
      case "ate_backtest":
      case "ate_strategy_save":
        return fail("ATE_VENUE_ERROR", "custom strategies need a live daemon (not served by the stub)", "Run ate-daemon");
      case "ate_market_get":
        return ok<ToolOutput<"ate_market_get">>({ markets: MARKET_IDS.filter((m) => !market || m === market).map((m) => STUB_MARKETS[m]) }, meta());

      case "ate_candidates_get": {
        const out: CandidatesGetOutput = {
          candidates: pick(FIXTURE_CANDIDATES, market).map((c) => (opts.scope === "chat" ? { ...c, reason: wrapUntrusted(c.reason) } : c)),
          suppressed: [],
          candidateTtlSec: 180,
          cycle: 30,
          generatedAt: now(),
        };
        return ok(out, meta());
      }

      case "ate_quote": {
        const a = args as unknown as QuoteInput;
        return ok<ToolOutput<"ate_quote">>(stubQuote(a.market, a.side, a.amountIn), meta());
      }

      case "ate_propose": {
        const a = args as unknown as ProposeInput;
        const origin = a.origin ?? "candidate";
        if (origin === "discretionary") {
          if (!a.thesis) return fail("ATE_CANDIDATE_REQUIRED", "origin=discretionary requires a thesis (≥ 40 chars)", "Add a thesis: why, what would prove it wrong, exit plan");
          const q = stubQuote(a.market, a.side, a.amountIn);
          if (BigInt(q.policy.notionalUsdE8) > 1_000_000_000n)
            return fail("ATE_DISCRETIONARY_LIMIT", "discretionary notional above discretionaryUsd ($10)", "Reduce amountIn to ≤ $10 notional");
        } else {
          if (!a.candidateId)
            return fail("ATE_CANDIDATE_REQUIRED", "autonomous mode: bind to a candidateId or use origin=discretionary with a thesis", "Call ate_candidates_get and pass one candidateId");
          const c = FIXTURE_CANDIDATES.find((x) => x.candidateId === a.candidateId);
          if (!c || c.market !== a.market || c.side !== a.side || BigInt(a.amountIn) > BigInt(c.maxAmountIn) || c.expiresAt < now())
            return fail("ATE_CANDIDATE_MISMATCH", "unknown/expired candidate, market or side differs, or amountIn > maxAmountIn", c ? `amountIn ≤ ${c.maxAmountIn}, side=${c.side}` : "Call ate_candidates_get");
        }
        const q = stubQuote(a.market, a.side, a.amountIn);
        if (q.policy.code !== "OK") return fail(q.policy.code, "vault check() refused the trade", "Reduce amountIn to ≤ 25 USD notional");
        const id = `prop_${hex16(++seq)}`;
        proposals.set(id, { market: a.market, side: a.side, amountIn: a.amountIn, used: false });
        return ok<ToolOutput<"ate_propose">>(
          {
            proposalId: id,
            journalHash: `0x${id.slice(5)}${"0".repeat(48)}`,
            status: "approved",
            origin,
            candidateId: a.candidateId ?? null,
            expiresAt: now() + 120,
            quote: q,
            reservedTurnoverUsd: a.side === "buy" ? (Number(q.policy.notionalUsdE8) / 1e8).toFixed(2) : "0",
            approvedBy: "policy",
          },
          meta(),
        );
      }

      case "ate_decide": {
        const a = args as unknown as DecideInput;
        void a;
        const id = `dec_${hex16(++seq)}`;
        return ok<ToolOutput<"ate_decide">>({ decisionId: id, hash: `0x${id.slice(4)}${"0".repeat(48)}`, at: now() }, meta());
      }

      case "ate_execute": {
        const a = args as unknown as ExecuteInput;
        const p = proposals.get(a.proposalId);
        if (!p || p.used) return fail("ATE_PROPOSAL_UNKNOWN", `proposal ${a.proposalId} not found or already used`, "Call ate_propose again");
        p.used = true;
        const q = stubQuote(p.market, p.side, p.amountIn);
        return ok<ToolOutput<"ate_execute">>(
          {
            proposalId: a.proposalId,
            executionId: `exec_${a.proposalId.slice(5)}`,
            txHash: `0x${"e1".repeat(32)}`,
            blockNumber: FIXTURE_BLOCK,
            amountIn: p.amountIn,
            amountOut: q.amountOut,
            minAmountOut: ((BigInt(q.amountOut) * 995n) / 1000n).toString(),
            quoterOut: q.amountOut,
            notionalUsdE8: q.policy.notionalUsdE8,
            exitPath: false,
            rationaleHash: `0x${"7a".repeat(32)}`,
            attestation: { status: "queued" },
          },
          meta(),
        );
      }

      case "ate_positions":
        return ok<ToolOutput<"ate_positions">>({ ...STUB_POSITIONS, markets: pick(STUB_POSITIONS.markets, market) }, meta());

      case "ate_strategy_get":
        return ok<ToolOutput<"ate_strategy_get">>(STUB_STRATEGY, meta());

      case "ate_strategy_set":
        return strategySet(args as unknown as StrategySetInput);

      case "ate_journal_read": {
        const a = args as unknown as JournalReadInput;
        let entries = STUB_JOURNAL.filter((e) => (!a.market || (e.market ?? e.intent?.market) === a.market) && (!a.kind || a.kind.includes(e.kind)) && (!a.id || e.id === a.id));
        entries = entries.slice(0, a.limit ?? 20).map((e) => ({ ...e, rationale: wrapUntrusted(e.rationale) }));
        return ok<ToolOutput<"ate_journal_read">>({ entries, head: { seq: 3, hash: STUB_JOURNAL[0]!.hash as `0x${string}` } }, meta());
      }

      case "ate_signal_buy":
        return ok<ToolOutput<"ate_signal_buy">>({ paymentId: `pay_${hex16(++seq)}`, state: "AWAITING_SIGN_APPROVAL", approvalsRequired: 2 }, meta());

      case "ate_pause":
        return ok<ToolOutput<"ate_pause">>(
          {
            vaults: MARKET_IDS.map((m) => ({ market: m, vault: STUB_MARKETS[m].vault.address, txHash: `0x${"9a".repeat(32)}` as const, status: "submitted" as const })),
            decisionId: `pause_${hex16(++seq)}`,
            daemonLocked: true,
          },
          meta(),
        );
    }
  }

  function strategySet(a: StrategySetInput): ToolResult<unknown> {
    const patch = a.patch;
    const scopeMarkets: MarketId[] = patch.market ? [patch.market] : [...MARKET_IDS];
    if (opts.scope === "agent") {
      const bad = (Object.keys(patch) as (keyof StrategyPatch)[]).filter((k) => !AGENT_FIELDS.has(k));
      if (bad.length) return fail("ATE_TOOL_NOT_ALLOWED", `agent scope may not change: ${bad.join(", ")}`, "Agent scope may change only entrySpreadBps, minNetEdgeBps, tradeSizeUsd, cycleSeconds");
    }
    const changes: StrategyFieldChange[] = [];
    const cur = STUB_STRATEGY.strategy;
    // riskProfile expands first; explicit fields in the same patch win (§11.5, additive v0.9).
    const expanded: Record<string, unknown> = { ...(patch.riskProfile ? RISK_PROFILES[patch.riskProfile] : {}), ...patch };
    delete expanded.riskProfile;
    for (const [k, v] of Object.entries(expanded) as [keyof StrategyPatch, unknown][]) {
      if (k === "market") continue;
      const portfolioField = k in cur.portfolio;
      const scopes = portfolioField ? (["portfolio"] as const) : scopeMarkets;
      for (const s of scopes) {
        const before = s === "portfolio" ? (cur.portfolio as unknown as Record<string, unknown>)[k] : (cur.markets[s] as unknown as Record<string, unknown>)[k];
        const dir = LOOSENING_DIRECTION[k];
        const loosening =
          (dir === "up" && Number(v) > Number(before ?? 0) && !(k === "rebalanceTargetPct" && Number(v) === 0)) ||
          (dir === "down" && Number(v) < Number(before)) ||
          (dir === "any" && v !== before) ||
          (k === "targetAssets" && (v as string[]).some((x) => !cur.portfolio.targetAssets.includes(x as "WHSK"))) ||
          (k === "enabled" && v === true);
        changes.push({ scope: s, field: k, before, after: v, loosening });
      }
    }
    if (opts.scope !== "agent" && changes.some((c) => c.loosening)) {
      const r = fail("ATE_APPROVAL_REQUIRED", "this change loosens risk and needs an ate-approve signature", "Approve the rendered diff with Touch ID within 60 s");
      if (!r.ok)
        r.error.details = {
          changeId: `chg_${hex16(++seq)}`,
          diff: changes,
          renderedDiff: changes.map((c) => `${c.scope} ${c.field}: ${String(c.before)} → ${String(c.after)}`).join("\n"),
          expiresAt: now() + 60,
        };
      return r;
    }
    return ok<ToolOutput<"ate_strategy_set">>(
      { status: "applied", decisionId: `strat_${hex16(++seq)}`, changes, clamped: false, strategy: STUB_STRATEGY.strategy },
      meta(),
    );
  }

  return { listTools, callTool, scope: opts.scope };
}

export type StubHandler = ReturnType<typeof createStubHandler>;
