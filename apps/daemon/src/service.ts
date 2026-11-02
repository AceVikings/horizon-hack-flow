// AteService: the daemon core. Owns the market scan, candidates, proposals lifecycle (§7.3), execute path
// (guard re-run → re-quote → pre-flight → TxQueue), positions, strategy, pause and the journal writes.
// Every MCP tool is implemented here; transports (MCP over HTTP/stdio, /view) call `callTool`.

import type Database from "better-sqlite3";
import {
  AteError,
  CHAT_TOOL_ALLOWLIST,
  ERROR_RETRYABLE,
  EXECUTE_DEADLINE_SEC,
  HSKDEX,
  LOOSENING_DIRECTION,
  MARKETS,
  MARKET_IDS,
  PROPOSAL_TTL_SEC,
  RISK_PROFILES,
  ReasonCode,
  SUPRA_PAIRS,
  SUPRA_PROOF_URL,
  SUPRA_PULL,
  TOOL_NAMES,
  e8ToUsd,
  fail,
  isMarketId,
  minBig,
  ok,
  policyVaultAbi,
  poolPriceFromSqrtPriceX96,
  reasonToError,
  sellAmountForUsdCap,
  tokenInFor,
  toolsForScope,
  usdToE8,
  wrapUntrusted,
  type Address,
  type AteConfig,
  type Candidate,
  type CandidatesGetOutput,
  type DaemonEvent,
  type DecisionActor,
  type DecisionContext,
  type DecideInput,
  type Engine,
  type ExecuteInput,
  type Hex,
  type JournalEntry,
  type JournalReadInput,
  type LiveCandidate,
  type MarketBook,
  type MarketId,
  type MarketPosition,
  type MarketSnapshot,
  type MarketView,
  type OpenProposal,
  type PortfolioState,
  type Profile,
  type ProposalDraft,
  type ProposalOrigin,
  type ProposalStatus,
  type ProposeInput,
  type Quote,
  type QuoteInput,
  type Side,
  type StatusResponse,
  type StrategyFieldChange,
  type StrategyParams,
  type StrategyPatch,
  type StrategySetInput,
  type Suppressed,
  type TokenScope,
  type ToolName,
  type ToolOutput,
  type ToolResult,
  type VaultState,
} from "@ate/core";
import type { ChainClient } from "@ate/chain";
import { Journal, rationaleHash, type AppendInput } from "@ate/journal";
import { validateToolInput } from "@ate/mcp";
import { CexReader, MarketReader, buildSupraPullTx, fetchSupraProof, readAproCrossCheck, type CycleRead } from "@ate/oracle";
import { HskDexAdapter, checkReasonToAteError, quoterV2Abi } from "@ate/venues";
import type { AgentSigner } from "@ate/wallet";
import type { TransactionReceipt } from "viem";
import { applyFill, avgEntryE8, emptyBook, fmtE8, seedBook, unrealised, type Book, type FillRow } from "./positions.js";
import { candidateIdFor, type BreakerStateLike, type StrategyImpl } from "./strategy-stub.js";
import type { TxQueue, TxPriority } from "./txqueue.js";
import { chartError, type ChartService } from "./charts/service.js";

export type CallerScope = TokenScope | "internal";
export const ZERO_ADDR: Address = "0x0000000000000000000000000000000000000000";

export class InvalidParamsError extends Error {
  constructor(
    readonly tool: string,
    readonly errors: string[],
  ) {
    super(`invalid arguments for ${tool}: ${errors.join("; ")}`);
  }
}

export interface Attesterish {
  plan(input: unknown, decisionId: string, agentBalanceWei: bigint): { action: "enqueue"; tx: { to: Address; data: Hex; gasHint: bigint } } | { action: string };
  onSubmitted(proposalId: Hex, txHash: Hex): void;
  onMined(r: TransactionReceipt, bal: bigint): { record: { refId: string; engine: string; status: string; attestation?: { easUid: string; schemaUid: string; txHash: string }; rationale: string; verdict: { ok: boolean; code: string; message?: string } } } | { retry: unknown };
  onFailed(proposalId: Hex, error: string, bal: bigint): unknown;
  failureRecord(proposalId: Hex, status: "deferred" | "failed"): { refId: string; engine: string; rationale: string; verdict: { ok: boolean; code: string; message?: string } };
  deferredCount(): number;
}

export interface ServiceOptions {
  cfg: AteConfig;
  db: Database.Database;
  journal: Journal;
  chain: ChainClient;
  signer: AgentSigner;
  txq: TxQueue;
  strategy: StrategyImpl;
  candidateTtlSec: number;
  version: string;
  emit: (e: DaemonEvent | { type: string; at: number; data: unknown }) => void;
  now?: () => number;
  attester?: Attesterish | null;
  /** Profile label per market (`--profile WHSK=demo`). */
  profiles?: Partial<Record<MarketId, Profile>>;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

interface ProposalMeta {
  id: string;
  market: MarketId;
  vault: Address;
  side: Side;
  tokenIn: Address;
  amountIn: string;
  rationale: string;
  rationaleHash: Hex;
  journalHash: Hex;
  candidateId: string | null;
  origin: ProposalOrigin;
  generator?: string;
  leg?: "open" | "close";
  thesis: string | null;
  status: ProposalStatus;
  engine: Engine;
  profile: Profile;
  actor: DecisionActor;
  scope: CallerScope;
  createdAt: number;
  expiresAt: number;
  reservedTurnoverUsd: string;
  notionalUsdE8: string;
}

interface QuoterRead {
  buy: { amountIn: bigint; amountOut: bigint } | null;
  exit: { amountIn: bigint; amountOut: bigint } | null;
  prefilter: { reason: number; notionalUsdE8: bigint } | null;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const utcDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const dayStart = (t: number) => t - (t % 86_400);

export class AteService {
  readonly cfg: AteConfig;
  readonly journal: Journal;
  readonly venue: HskDexAdapter;
  readonly reader: MarketReader;
  readonly vaults: Partial<Record<MarketId, Address>>;
  readonly markets: MarketId[];
  readonly startedAt: number;
  strategy: StrategyParams;
  anchors: StrategyParams;
  strategyUpdatedAt: number;
  private readonly now: () => number;
  private cycle: CycleRead | null = null;
  private quoter: Partial<Record<MarketId, QuoterRead>> = {};
  private refreshing: Promise<CycleRead> | null = null;
  private candidates = new Map<string, LiveCandidate>();
  private suppressed: Suppressed[] = [];
  private proposals = new Map<string, ProposalMeta>();
  private scanCount = 0;
  private lastScanAt = 0;
  private scanTimer: NodeJS.Timeout | null = null;
  private apro: Partial<Record<MarketId, { answer: bigint; updatedAt: number } | null>> = {};
  private aproAt = 0;
  private gasLow = false;
  private health: Partial<Record<MarketId, string>> = {};
  private lastCycleRequestAt = 0;
  private lastSupraRefreshAt = 0;
  private supraRefreshing: Promise<void> | null = null;
  private pendingChanges = new Map<string, { patch: StrategyPatch; scope: CallerScope; rationale: string; changes: StrategyFieldChange[]; next: StrategyParams; expiresAt: number; renderedDiff: string; confirm?: "sells_now" }>();
  /** Lane D4 (additive): ate_chart / ate_data backend, set by the daemon bootstrap. */
  charts: ChartService | null = null;
  /** Lane E hook: notified with StrategyApprovalPending when ate_strategy_set returns ATE_APPROVAL_REQUIRED. */
  onStrategyPending: ((d: unknown) => void) | null = null;
  counters = { cycles: 0, trades: 0, routedUsdE8: 0n, lastCycleAt: null as number | null };
  /** Daily P&L (§11.4 rule 6): realised + exit-marked unrealised minus the UTC-day-start snapshot. */
  private pnlDay: { day: string; startE8: string } | null = null;
  private dailyPnlE8 = 0n;
  private breaker: BreakerStateLike = { state: "armed", since: null, day: "", cycles: 0 };
  /** `ate rogue --stage` hold (§22.3): candidate executes on this market wait until `until`; guard exits never wait. */
  private rogueHold: { market: MarketId; until: number } | null = null;
  /** Count of daemon-originated txs per vault (executes, exits, pauses, refreshes) — `--stage` aborts if it moves. */
  private vaultTxSeq: Partial<Record<MarketId, number>> = {};
  smokeMode = false;

  constructor(readonly o: ServiceOptions) {
    this.cfg = o.cfg;
    this.journal = o.journal;
    this.now = o.now ?? nowSec;
    this.startedAt = this.now();
    this.vaults = Object.fromEntries(o.cfg.vaults.map((v) => [v.market, v.address as Address])) as Partial<Record<MarketId, Address>>;
    this.markets = MARKET_IDS.filter((m) => o.cfg.venues.hskdex.markets.some((x) => x.id === m));
    this.venue = new HskDexAdapter({ client: o.chain.client, vaults: this.vaults, agent: () => this.agentAddress(), quoter: o.cfg.venues.hskdex.quoter as Address, now: this.now });
    this.reader = new MarketReader({
      client: o.chain.client,
      markets: this.markets,
      vaults: this.vaults,
      oracles: {},
      agent: o.signer.address ?? undefined,
      maxOracleAgeSec: o.cfg.oracle.apro.maxAgeSec,
      supra: { storage: o.cfg.supra.storage as Address, pairs: { ...SUPRA_PAIRS, ...(o.cfg.supra.pairs ?? {}) }, maxAgeSec: o.cfg.supra.maxAgeSec, maxDisagreeBps: o.cfg.supra.maxDisagreeBps },
      apro: () => this.apro,
      cex: new CexReader({ baseUrl: o.cfg.oracle.cex.baseUrl, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) }),
      now: this.now,
    });
    const s = this.loadStrategy();
    this.strategy = s.strategy;
    this.anchors = s.anchors;
    this.strategyUpdatedAt = s.updatedAt;
    this.ensureRows();
    this.loadProposals();
  }

  // ------------------------------------------------------------------ setup

  private loadStrategy(): { strategy: StrategyParams; anchors: StrategyParams; updatedAt: number } {
    const row = this.o.db.prepare("SELECT params, updated_at FROM strategy WHERE scope = 'portfolio'").get() as { params: string; updated_at: number } | undefined;
    if (row) {
      const j = JSON.parse(row.params) as { strategy: StrategyParams; anchors: StrategyParams };
      j.strategy.portfolio.candidateTtlSec = this.o.candidateTtlSec;
      return { ...j, updatedAt: row.updated_at };
    }
    const c = this.cfg.strategy;
    const st: StrategyParams = {
      engine: c.engine,
      mode: c.mode,
      enabled: c.enabled,
      portfolio: { ...c.portfolio, candidateTtlSec: this.o.candidateTtlSec } as StrategyParams["portfolio"],
      markets: JSON.parse(JSON.stringify(c.markets)) as StrategyParams["markets"],
    };
    return { strategy: st, anchors: JSON.parse(JSON.stringify(st)) as StrategyParams, updatedAt: this.now() };
  }

  private saveStrategy() {
    this.strategyUpdatedAt = this.now();
    this.o.db
      .prepare("INSERT INTO strategy (scope, params, updated_at) VALUES ('portfolio', ?, ?) ON CONFLICT(scope) DO UPDATE SET params = excluded.params, updated_at = excluded.updated_at")
      .run(JSON.stringify({ strategy: this.strategy, anchors: this.anchors }), this.strategyUpdatedAt);
  }

  private ensureRows() {
    const db = this.o.db;
    db.prepare("INSERT OR IGNORE INTO agents (id, label, address, chain_id, created_at) VALUES (?, 'agent', ?, ?, ?)").run(this.cfg.agentKeyId, this.o.signer.address ?? ZERO_ADDR, this.cfg.chain.id, this.now());
    for (const m of this.markets) {
      const v = this.vaults[m];
      if (!v) continue;
      const s = MARKETS[m];
      db.prepare("INSERT OR IGNORE INTO vaults (address, market, agent_id, price_token, price_decimals, oracle, pool, deployed_block) VALUES (?, ?, ?, ?, ?, ?, ?, 0)").run(
        v,
        m,
        this.cfg.agentKeyId,
        s.baseToken,
        s.baseDecimals,
        s.oracle,
        s.pool,
      );
    }
  }

  private loadProposals() {
    const rows = this.o.db.prepare("SELECT * FROM proposals WHERE status IN ('approved','awaiting_human','proposed')").all() as Record<string, unknown>[];
    for (const r of rows) {
      const e = this.journal.get(r.id as string);
      this.proposals.set(r.id as string, {
        id: r.id as string,
        market: r.market as MarketId,
        vault: r.vault as Address,
        side: r.side as Side,
        tokenIn: r.token_in as Address,
        amountIn: r.amount_in as string,
        rationale: r.rationale as string,
        rationaleHash: r.rationale_hash as Hex,
        journalHash: r.journal_hash as Hex,
        candidateId: (r.candidate_id as string) ?? null,
        origin: r.origin as ProposalOrigin,
        thesis: (r.thesis as string) ?? null,
        status: r.status as ProposalStatus,
        engine: e?.engine ?? "llm",
        profile: e?.profile ?? "default",
        actor: e?.actor ?? { kind: "agent" },
        scope: "agent",
        createdAt: r.created_at as number,
        expiresAt: r.expires_at as number,
        reservedTurnoverUsd: r.reserved_turnover_usd as string,
        notionalUsdE8: "0",
      });
    }
  }

  /** Reads each vault's immutable `oracle()` (SupraAggregatorAdapter since 974cbf0) for the enforcement read. */
  async init(): Promise<void> {
    for (const m of this.markets) {
      const v = this.vaults[m];
      if (!v) continue;
      try {
        const o = (await this.o.chain.client.readContract({ address: v, abi: policyVaultAbi, functionName: "oracle" })) as Address;
        (this.reader as unknown as { o: { oracles: Partial<Record<MarketId, Address>> } }).o.oracles[m] = o;
        this.o.db.prepare("UPDATE vaults SET oracle = ? WHERE address = ?").run(o, v);
      } catch (e) {
        this.o.log?.(`init: could not read ${m} vault oracle(): ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }

  agentAddress(): Address | null {
    return this.o.signer.address ?? null;
  }

  get locked(): boolean {
    return !this.o.signer.unlocked;
  }

  // ------------------------------------------------------------------ market reads

  /** One Multicall3 read (+ one quoter Multicall3) for both markets; single-flight, cached `maxAgeSec`. */
  async refresh(maxAgeSec = 5): Promise<CycleRead> {
    if (this.cycle && this.now() - this.cycle.at < maxAgeSec) return this.cycle;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        if (this.now() - this.aproAt > 300) {
          this.aproAt = this.now();
          this.apro = await readAproCrossCheck(this.o.chain.client, this.markets).catch(() => this.apro);
        }
        (this.reader as unknown as { o: { agent?: Address } }).o.agent = this.agentAddress() ?? undefined;
        const c = await this.reader.read();
        this.cycle = c;
        await this.readQuoter(c).catch((e) => this.o.log?.(`quoter read failed: ${(e as Error).message.split("\n")[0]}`));
        return c;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async readQuoter(c: CycleRead) {
    const calls: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }[] = [];
    const keys: { m: MarketId; kind: "buy" | "exit" | "check"; amt: bigint }[] = [];
    const agent = this.agentAddress() ?? this.cycle?.markets[this.markets[0]!]?.vault?.agent ?? ZERO_ADDR;
    for (const m of this.markets) {
      const s = MARKETS[m];
      const tradeUsdt = usdToE8(this.strategy.markets[m].tradeSizeUsd) / 100n;
      calls.push({ address: HSKDEX.quoter, abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn: s.quoteToken, tokenOut: s.baseToken, amountIn: tradeUsdt, fee: s.fee, sqrtPriceLimitX96: 0n }] });
      keys.push({ m, kind: "buy", amt: tradeUsdt });
      const bal = BigInt(c.markets[m]?.vault?.balancePrice ?? "0");
      if (bal > 0n) {
        calls.push({ address: HSKDEX.quoter, abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn: s.baseToken, tokenOut: s.quoteToken, amountIn: bal, fee: s.fee, sqrtPriceLimitX96: 0n }] });
        keys.push({ m, kind: "exit", amt: bal });
      }
      const v = this.vaults[m];
      if (v && c.markets[m]?.vault) {
        calls.push({
          address: v,
          abi: policyVaultAbi,
          functionName: "check",
          args: [agent, { tokenIn: s.quoteToken, amountIn: tradeUsdt, minAmountOut: 2n ** 255n, deadline: BigInt(c.blockTimestamp + 60), proposalId: `0x${"00".repeat(32)}` }],
        });
        keys.push({ m, kind: "check", amt: tradeUsdt });
      }
    }
    const res = (await this.o.chain.client.multicall({ contracts: calls as never, allowFailure: true, batchSize: 0 })) as { status: string; result?: unknown }[];
    const out: Partial<Record<MarketId, QuoterRead>> = {};
    keys.forEach(({ m: market, kind, amt }, i) => {
      const r = res[i];
      const q = (out[market] ??= { buy: null, exit: null, prefilter: null });
      if (!r || r.status !== "success") return;
      if (kind === "buy") q.buy = { amountIn: amt, amountOut: (r.result as readonly bigint[])[0]! };
      if (kind === "exit") q.exit = { amountIn: amt, amountOut: (r.result as readonly bigint[])[0]! };
      if (kind === "check") {
        const x = r.result as readonly [number, bigint];
        // minAmountOut = 2^255 makes step 11 fail; anything before it is the real verdict.
        const reason = x[0] === ReasonCode.ERR_SLIPPAGE ? ReasonCode.OK : x[0];
        q.prefilter = { reason, notionalUsdE8: x[1] };
      }
    });
    this.quoter = out;
  }

  exitMarkE8(m: MarketId): bigint | null {
    const q = this.quoter[m]?.exit;
    if (!q || q.amountIn === 0n) return null;
    // amountOut USDT(6) per amountIn base(d) → 8 dp price
    return (q.amountOut * 100n * 10n ** BigInt(MARKETS[m].baseDecimals)) / q.amountIn;
  }

  private placeholderVault(m: MarketId): VaultState {
    return {
      market: m,
      address: ZERO_ADDR,
      paused: true,
      agent: ZERO_ADDR,
      guardian: ZERO_ADDR,
      owner: ZERO_ADDR,
      priceDecimals: MARKETS[m].baseDecimals,
      balanceQuote: "0",
      balancePrice: "0",
      exposureUsdE8: "0",
      epoch: { index: "0", start: 0, spentUsdE8: "0", capUsdE8: "0" },
      limits: { maxTradeUsdE8: "0", maxEpochUsdE8: "0", maxExposureUsdE8: "0", epochDuration: 86400, maxSlippageBps: 0, maxOracleDeviationBps: 0, maxExitDiscountBps: 0, maxOracleAge: 0, cooldown: 0 },
      lastTradeAt: 0,
    };
  }

  snapshots(): Record<MarketId, MarketSnapshot> {
    const c = this.cycle;
    if (!c) throw new AteError("ChainError", "ATE_VENUE_ERROR", "no market read yet", { hint: "Retry in a few seconds" });
    const out = {} as Record<MarketId, MarketSnapshot>;
    for (const m of this.markets) {
      const r = c.markets[m];
      if (!r) continue;
      const q = this.quoter[m];
      const spot = BigInt(r.price.pool.price);
      const scale = 10n ** BigInt(MARKETS[m].baseDecimals + 2);
      const impactOf = (side: Side, a: { amountIn: bigint; amountOut: bigint } | null) => {
        if (!a || spot === 0n) return [];
        const ideal = side === "buy" ? (a.amountIn * scale) / spot : (a.amountIn * spot) / scale;
        return [{ amountIn: a.amountIn.toString(), amountOut: a.amountOut.toString(), impactBps: ideal > 0n ? Number(((ideal - a.amountOut) * 10_000n) / ideal) : 0 }];
      };
      const mark = this.exitMarkE8(m);
      out[m] = {
        market: m,
        at: c.blockTimestamp,
        price: r.price,
        vault: r.vault ?? this.placeholderVault(m),
        feeBps: r.feeBps,
        impact: { buy: impactOf("buy", q?.buy ?? null), sell: impactOf("sell", q?.exit ?? null) },
        exitMark: mark === null ? null : mark.toString(),
        prefilterBuy: q?.prefilter ? { reason: q.prefilter.reason as ReasonCode, notionalUsdE8: q.prefilter.notionalUsdE8.toString(), deviationBps: r.price.pool.deviationBps } : null,
      };
    }
    return out;
  }

  // ------------------------------------------------------------------ books / portfolio

  private fills(m: MarketId): FillRow[] {
    return (
      this.o.db.prepare("SELECT f.*, c.leg AS leg FROM fills f LEFT JOIN executions e ON e.id = f.execution_id LEFT JOIN proposals p ON p.id = e.proposal_id LEFT JOIN candidates c ON c.id = p.candidate_id WHERE f.market = ? ORDER BY f.at, f.rowid").all(m) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      market: m,
      generator: r.generator as string,
      side: r.side as Side,
      baseQty: BigInt(r.base_qty as string),
      quoteQty: BigInt(r.quote_qty as string),
      at: r.at as number,
      leg: (r.leg as "open" | "close" | null) ?? null,
    }));
  }

  /** Seed basis = enforcement oracle price the first time the daemon sees the vault (§11.4 seed basis). */
  private seedFor(m: MarketId): { qty: bigint; priceE8: bigint } {
    const key = `seed:${m}`;
    const row = this.o.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (row) {
      const j = JSON.parse(row.value) as { qty: string; priceE8: string };
      return { qty: BigInt(j.qty), priceE8: BigInt(j.priceE8) };
    }
    const r = this.cycle?.markets[m];
    if (!r?.vault || r.raw.oracleAnswer === 0n) return { qty: 0n, priceE8: 0n };
    const executed = this.fills(m).length;
    const qty = executed ? 0n : BigInt(r.vault.balancePrice);
    const v = { qty: qty.toString(), priceE8: r.raw.oracleAnswer.toString() };
    this.o.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(v));
    return { qty, priceE8: r.raw.oracleAnswer };
  }

  book(m: MarketId): Book {
    const d = MARKETS[m].baseDecimals;
    const seed = this.seedFor(m);
    let b = seed.qty > 0n ? seedBook(seed.qty, seed.priceE8, d) : emptyBook();
    for (const f of this.fills(m)) b = applyFill(b, f, d);
    return b;
  }

  private turnoverUsedE8(m: MarketId): bigint {
    const since = dayStart(this.now());
    const r = this.o.db
      .prepare("SELECT reserved_turnover_usd v FROM proposals WHERE market = ? AND status = 'executed' AND consumed_at >= ?")
      .all(m, since) as { v: string }[];
    return r.reduce((a, x) => a + usdToE8(x.v), 0n);
  }

  openProposals(): OpenProposal[] {
    return [...this.proposals.values()]
      .filter((p) => p.status === "approved" || p.status === "awaiting_human" || p.status === "proposed")
      .map((p) => ({
        proposalId: p.id,
        market: p.market,
        side: p.side,
        origin: p.origin,
        status: p.status,
        amountIn: p.amountIn,
        reservedTurnoverUsd: p.reservedTurnoverUsd,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
      }));
  }

  portfolio(): PortfolioState {
    const t = this.now();
    const snaps = this.cycle ? this.snapshots() : ({} as Record<MarketId, MarketSnapshot>);
    const markets = {} as Record<MarketId, MarketBook>;
    const tot = this.o.strategy.reservations.totals();
    const nTargets = Math.max(1, this.strategy.portfolio.targetAssets.length);
    let usedAll = 0n;
    for (const m of MARKET_IDS) {
      const vault = snaps[m]?.vault ?? this.placeholderVault(m);
      const b = this.markets.includes(m) ? this.book(m) : emptyBook();
      const d = MARKETS[m].baseDecimals;
      const used = this.turnoverUsedE8(m);
      usedAll += used;
      let alloc = usdToE8(this.strategy.portfolio.maxDailyTurnoverUsd) / BigInt(nTargets);
      const cap = BigInt(vault.limits.maxEpochUsdE8) - BigInt(vault.limits.maxExposureUsdE8);
      if (vault.address !== ZERO_ADDR && cap >= 0n) alloc = minBig(alloc, cap);
      if (!this.strategy.portfolio.targetAssets.includes(MARKETS[m].asset)) alloc = 0n;
      const lastEntry = this.o.db.prepare("SELECT MAX(consumed_at) t FROM proposals WHERE market = ? AND status = 'executed' AND side = 'buy'").get(m) as { t: number | null };
      const avg = avgEntryE8(b, d);
      markets[m] = {
        market: m,
        position: { qty: b.qty.toString(), avgEntry: avg === null ? null : avg.toString(), realisedUsd: fmtE8(b.realisedE8), lots: b.lots.filter((l) => l.closedAt === null) },
        exposureUsd: e8ToUsd(BigInt(vault.exposureUsdE8)),
        reentryLockUntil: null,
        lastEntryAt: lastEntry.t,
        lastGuardExitAt: null,
        turnover: { allocationUsd: e8ToUsd(alloc), usedUsd: e8ToUsd(used), reservedUsd: tot.byMarket[m] ?? "0" },
        vault,
      };
    }
    const discExec = (
      this.o.db.prepare("SELECT COUNT(*) c FROM proposals WHERE origin = 'discretionary' AND status = 'executed' AND consumed_at >= ?").get(dayStart(t)) as { c: number }
    ).c;
    const cands: Record<string, LiveCandidate> = {};
    for (const [k, v] of this.candidates) cands[k] = v;
    return {
      at: t,
      utcDay: utcDay(t),
      mode: this.strategy.mode,
      strategy: this.strategy,
      markets,
      turnover: { budgetUsd: this.strategy.portfolio.maxDailyTurnoverUsd, usedUsd: e8ToUsd(usedAll), reservedUsd: tot.turnoverUsd },
      discretionary: { executedToday: discExec, reservedToday: tot.discretionary },
      dailyPnlUsd: e8ToUsdSigned(this.dailyPnlE8),
      breaker: { state: this.breaker.state, since: this.breaker.since },
      candidates: cands,
      openProposals: this.openProposals(),
      candidateTtlSec: this.strategy.portfolio.candidateTtlSec,
    };
  }

  /** `ate smoke` is an explicit operator action: its one-shot candidate is guarded with the trader enabled. */
  private guardPortfolio(generator?: string): PortfolioState {
    const pf = this.portfolio();
    if (generator !== "smoke") return pf;
    return { ...pf, mode: "autonomous", strategy: { ...pf.strategy, enabled: true } };
  }

  // ------------------------------------------------------------------ scan loop (§11.1 deterministic scan)

  startScan() {
    const every = (this.strategy.portfolio.scanSeconds ?? 20) * 1000;
    const run = () => void this.scan().catch((e) => this.o.log?.(`scan: ${(e as Error).message.split("\n")[0]}`));
    run();
    this.scanTimer = setInterval(run, every);
  }
  stopScan() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  async scan(): Promise<void> {
    const c = await this.refresh(1);
    this.scanCount++;
    this.lastScanAt = this.now();
    const prevEntries = new Set([...this.candidates.values()].filter((x) => x.side === "buy" && x.expiresAt >= this.now()).map((x) => x.market));
    // expire old candidates/proposals
    const t = this.now();
    for (const [k, v] of this.candidates) if (v.expiresAt < t - 600) this.candidates.delete(k);
    this.expireProposals();
    try {
      this.stepDaily(true);
    } catch (e) {
      this.o.log?.(`daily pnl/breaker: ${(e as Error).message}`);
    }
    try {
      this.scoreOutcomes();
    } catch (e) {
      this.o.log?.(`veto outcomes: ${(e as Error).message}`);
    }
    const pf = this.portfolio();
    const snaps = this.snapshots();
    let res: { candidates: Candidate[]; suppressed: Suppressed[] };
    try {
      res = this.o.strategy.engine.run(snaps, pf);
    } catch (e) {
      this.o.log?.(`candidate engine failed: ${(e as Error).message}`);
      res = { candidates: [], suppressed: [] };
    }
    this.suppressed = res.suppressed;
    for (const cand of res.candidates) {
      if (!this.candidates.has(cand.candidateId)) {
        this.candidates.set(cand.candidateId, { ...cand, createdAt: cand.createdAt ?? t, consumedBy: null });
        this.persistCandidate(cand);
      }
    }
    // a gap just opened → one out-of-schedule cycle (≤ 1 per 30 s)
    const nowEntries = new Set(res.candidates.filter((x) => x.side === "buy" && x.generator !== "smoke").map((x) => x.market));
    for (const m of nowEntries) if (!prevEntries.has(m)) this.requestCycle("gap");
    // health / gas events
    for (const m of this.markets) {
      const r = c.markets[m];
      if (!r) continue;
      const h = `${r.price.oracle.health}:${r.price.readOnly}`;
      if (this.health[m] !== h) {
        this.health[m] = h;
        this.o.emit({ type: "oracle.health", at: t, data: { market: m, health: r.price.oracle.health, ageSec: r.price.oracle.ageSec, deviationBps: r.price.pool.deviationBps, readOnly: r.price.readOnly } });
      }
    }
    if (c.agentBalanceWei !== null) {
      const low = c.agentBalanceWei < BigInt(Math.round(Number(this.cfg.daemon.gasAlarmHsk) * 1e6)) * 10n ** 12n;
      if (low && !this.gasLow) this.o.emit({ type: "gas.low", at: t, data: { agentHsk: (Number(c.agentBalanceWei) / 1e18).toFixed(4), thresholdHsk: this.cfg.daemon.gasAlarmHsk } });
      this.gasLow = low;
    }
    // Supra pull refresh when the enforcement oracle is older than refreshAgeSec (background, low priority).
    const pull = this.cfg.supra.pull;
    if (pull?.enabled && !this.locked) {
      const old = this.markets.some((m) => (c.markets[m]?.price.oracle.ageSec ?? 0) > pull.refreshAgeSec);
      if (old && t - this.lastSupraRefreshAt > 600) void this.supraRefresh("age").catch((e) => this.o.log?.(`supra refresh: ${(e as Error).message}`));
    }
    // guard exits act without the LLM (§11.1)
    if (this.strategy.enabled && !this.locked) {
      for (const cand of res.candidates.filter((x) => x.generator === "guard_exit")) {
        if (this.candidates.get(cand.candidateId)?.consumedBy) continue;
        void this.runGuardExit(cand).catch((e) => this.o.log?.(`guard exit ${cand.market}: ${(e as Error).message}`));
      }
    }
  }

  private setting<T>(key: string): T | null {
    const r = this.o.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : null;
  }
  private saveSetting(key: string, v: unknown) {
    this.o.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(v));
  }

  /** Σ realised + exit-marked unrealised over both books (8 dp USD). */
  private pnlTotalE8(): bigint {
    let tot = 0n;
    for (const m of this.markets) {
      const b = this.book(m);
      tot += b.realisedE8 + unrealised(b, this.exitMarkE8(m), MARKETS[m].baseDecimals).usdE8;
    }
    return tot;
  }

  /**
   * Daily P&L + Lane C's breaker (§11.4 rule 6). The day-start snapshot and breaker state persist in `settings`
   * so a restart neither resets the loss count nor re-arms a tripped breaker.
   */
  stepDaily(cycle: boolean) {
    const t = this.now();
    const day = utcDay(t);
    if (!this.pnlDay) this.pnlDay = this.setting<{ day: string; startE8: string }>("pnl_day_start");
    const b0 = this.setting<BreakerStateLike>("breaker");
    if (b0 && !this.breaker.day) this.breaker = b0;
    if (!this.cycle) return;
    const total = this.pnlTotalE8();
    if (!this.pnlDay || this.pnlDay.day !== day) {
      this.pnlDay = { day, startE8: total.toString() };
      this.saveSetting("pnl_day_start", this.pnlDay);
    }
    this.dailyPnlE8 = total - BigInt(this.pnlDay.startE8);
    const step = this.o.strategy.stepBreaker;
    if (!step) return;
    const flat = this.markets.every((m) => BigInt(this.cycle?.markets[m]?.vault?.exposureUsdE8 ?? "0") < 50_000_000n);
    const before = JSON.stringify(this.breaker);
    const r = step(this.breaker.day ? this.breaker : { state: "armed", since: null, day, cycles: 0 }, {
      now: t,
      utcDay: day,
      dailyPnlUsd: e8ToUsdSigned(this.dailyPnlE8),
      dailyLossLimitUsd: this.strategy.portfolio.dailyLossLimitUsd,
      flat,
      cycle,
    });
    this.breaker = r.state;
    if (JSON.stringify(this.breaker) !== before) this.saveSetting("breaker", this.breaker);
    for (const a of r.actions) {
      if (a === "invalidate_buys") for (const id of this.o.strategy.invalidation.onBreaker()) this.setStatus(id, "invalidated");
      else if (a === "pause_all") void this.pause("internal", `Daily loss breaker tripped: daily P&L ${e8ToUsdSigned(this.dailyPnlE8)} USD ≤ −${this.strategy.portfolio.dailyLossLimitUsd}`).catch((e) => this.o.log?.(`breaker pause: ${(e as Error).message}`));
      else if (a === "notify") this.o.emit({ type: "breaker", at: t, data: { state: this.breaker.state, dailyPnlUsd: e8ToUsdSigned(this.dailyPnlE8), limitUsd: this.strategy.portfolio.dailyLossLimitUsd } });
      else if (a === "journal_unflattened")
        this.journal.append({
          at: t,
          kind: "no_trade",
          engine: "guard",
          profile: "default",
          actor: { kind: "guard" },
          rationale: `Daily loss breaker: flatten window elapsed with exposure left; vaults paused with unflattened exposure (${this.markets.map((m) => `${MARKETS[m].label} $${e8ToUsd(BigInt(this.cycle?.markets[m]?.vault?.exposureUsdE8 ?? "0"))}`).join(", ")})`,
          context: this.context(undefined),
          verdict: { ok: true, code: "NO_TRADE", message: "guard" },
        });
    }
  }

  /**
   * E13 (§11.1): 30 min after an LLM veto (`ate_decide` llm_veto bound to a candidate) or size-down (LLM proposal
   * below the candidate's maxAmountIn), journal an `outcome` with Lane C's `scoreVeto` counterfactual.
   */
  scoreOutcomes() {
    const score = this.o.strategy.scoreVeto;
    if (!score || !this.cycle) return;
    const t = this.now();
    const H = 1800;
    const due = this.o.db
      .prepare(
        `SELECT d.id, d.at, d.kind, d.record FROM decisions d
         WHERE d.at <= ? AND d.at >= ? AND (
           (d.kind = 'no_trade' AND json_extract(d.record,'$.verdict.message') = 'llm_veto' AND json_extract(d.record,'$.candidateId') IS NOT NULL)
           OR (d.kind = 'proposal' AND json_extract(d.record,'$.engine') = 'llm' AND json_extract(d.record,'$.candidateId') IS NOT NULL))
         AND NOT EXISTS (SELECT 1 FROM decisions o WHERE o.kind = 'outcome' AND o.ref_id = d.id)
         ORDER BY d.seq LIMIT 20`,
      )
      .all(t - H, t - 86_400) as { id: string; at: number; kind: string; record: string }[];
    for (const row of due) {
      const rec = JSON.parse(row.record) as JournalEntry;
      const cand = this.o.db.prepare("SELECT market, side, max_amount_in FROM candidates WHERE id = ?").get(rec.candidateId) as { market: MarketId; side: Side; max_amount_in: string } | undefined;
      if (!cand || !isMarketId(cand.market)) continue;
      const max = BigInt(cand.max_amount_in);
      const declined = row.kind === "no_trade" ? max : max - BigInt(rec.intent?.amountIn ?? cand.max_amount_in);
      if (declined <= 0n) continue; // a full-size LLM proposal is an act, not a size-down
      const m = cand.market;
      const fee = BigInt(MARKETS[m].fee);
      const pool = BigInt(rec.context.pool.price || "0");
      if (pool <= 0n) continue;
      const quoted = cand.side === "buy" ? (pool * (1_000_000n + fee)) / 1_000_000n : (pool * (1_000_000n - fee)) / 1_000_000n;
      const poolNow = BigInt(this.cycle.markets[m]?.price.pool.price ?? "0");
      const markThen = cand.side === "buy" ? (this.exitMarkE8(m) ?? (poolNow * (1_000_000n - fee)) / 1_000_000n) : (poolNow * (1_000_000n + fee)) / 1_000_000n;
      if (markThen <= 0n) continue;
      const s = score({ side: cand.side, declinedAmountIn: declined, quotedPriceE8: quoted, markThenE8: markThen, d: MARKETS[m].baseDecimals });
      this.journal.append({
        at: t,
        kind: "outcome",
        refId: row.id,
        market: m,
        engine: rec.engine,
        profile: rec.profile,
        actor: { kind: "guard" },
        rationale: `E13 ${row.kind === "no_trade" ? "veto" : "size-down"} outcome at +30 min: declined ${declined} of ${cand.side}, quoted ${quoted} vs mark ${markThen} → saved ${s.savedBps} bps ($${s.savedUsd})`,
        context: this.context(m),
        verdict: { ok: true, code: "OK" },
        outcome: { horizonSec: 1800, declinedAmountIn: declined.toString(), markThen: markThen.toString(), savedBps: s.savedBps, savedUsd: s.savedUsd },
      });
    }
  }

  private persistCandidate(c: Candidate) {
    this.o.db
      .prepare("INSERT OR IGNORE INTO candidates (id, market, generator, leg, side, max_amount_in, edge_bps, cost_bps, net_edge_bps, reason, created_at, expires_at, consumed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)")
      .run(c.candidateId, c.market, c.generator, c.leg ?? null, c.side, c.maxAmountIn, c.edgeBps, c.costBps, c.netEdgeBps, c.reason, c.createdAt ?? this.now(), c.expiresAt);
  }

  private async runGuardExit(cand: Candidate) {
    const ids = this.o.strategy.invalidation.onGuardExit(cand.market, cand.guardReason ?? "stop_loss");
    for (const id of ids) this.setStatus(id, "invalidated");
    const p = await this.callTool("internal", "ate_propose", {
      market: cand.market,
      side: cand.side,
      amountIn: cand.maxAmountIn,
      candidateId: cand.candidateId,
      rationale: `Guard exit (${cand.guardReason ?? "guard"}): ${cand.reason}`,
    });
    if (p.ok) await this.callTool("internal", "ate_execute", { proposalId: (p.data as ToolOutput<"ate_propose">).proposalId });
  }

  /** POST /cycle and gap triggers: ≤ 1 per 30 s; the runner listens on /events for `cycle.requested`. */
  requestCycle(reason: "manual" | "gap" | "strategy_change"): { started: boolean; reason?: "rate_limited"; cycle: number } {
    const t = this.now();
    if (t - this.lastCycleRequestAt < 30) return { started: false, reason: "rate_limited", cycle: this.counters.cycles };
    this.lastCycleRequestAt = t;
    this.o.emit({ type: "cycle.requested", at: t, data: { reason, cycle: this.counters.cycles + 1 } });
    return { started: true, cycle: this.counters.cycles + 1 };
  }

  /** Smoke: one-shot `generator=smoke` buy (only under `ate smoke`, §19 step 6). */
  addSmokeCandidate(m: MarketId, usd: string): Candidate {
    const t = this.now();
    const c: Candidate = {
      candidateId: candidateIdFor(`${m}|smoke|${t}|${usd}`),
      market: m,
      generator: "smoke",
      side: "buy",
      maxAmountIn: (usdToE8(usd) / 100n).toString(),
      edgeBps: 0,
      costBps: 30,
      netEdgeBps: -30,
      reason: `ate smoke: one-shot $${usd} buy to prove the execute path (labelled smoke, not Track 1 evidence)`,
      expiresAt: t + this.strategy.portfolio.candidateTtlSec,
      createdAt: t,
      profile: "default",
    };
    this.candidates.set(c.candidateId, { ...c, consumedBy: null });
    this.persistCandidate(c);
    return c;
  }

  private expireProposals() {
    const t = this.now();
    for (const p of this.proposals.values()) {
      if ((p.status === "approved" || p.status === "awaiting_human" || p.status === "proposed") && p.expiresAt < t) {
        this.setStatus(p.id, "expired");
        this.o.strategy.reservations.release(p.id, "expired");
      }
    }
  }

  private setStatus(id: string, status: ProposalStatus) {
    const p = this.proposals.get(id);
    if (p) p.status = status;
    this.o.db.prepare("UPDATE proposals SET status = ?, consumed_at = CASE WHEN ? IN ('executed','failed') THEN ? ELSE consumed_at END WHERE id = ?").run(status, status, this.now(), id);
  }

  // ------------------------------------------------------------------ helpers

  actorFor(scope: CallerScope): DecisionActor {
    switch (scope) {
      case "agent":
        return { kind: "agent", via: "mcp", ...(this.agentAddress() ? { address: this.agentAddress()! } : {}) };
      case "chat":
        return { kind: "human", via: "chat" };
      case "ui":
        return { kind: "human", via: "ui" };
      case "session":
        return { kind: "human", via: "cli" };
      case "rogue":
        return { kind: "agent", via: "cli" };
      default:
        return { kind: "guard" };
    }
  }

  engineFor(scope: CallerScope, hint?: Engine): Engine {
    if (hint) return hint;
    if (scope === "agent") return this.strategy.engine;
    if (scope === "internal") return "guard";
    return "human";
  }

  profileFor(m: MarketId | undefined, generator?: string): Profile {
    if (generator === "smoke") return "default";
    return (m && (this.o.profiles?.[m] ?? this.strategy.markets[m]?.profile)) === "demo" ? "demo" : "default";
  }

  context(m: MarketId | undefined, extra: Partial<DecisionContext> = {}): DecisionContext {
    const r = m ? this.cycle?.markets[m] : undefined;
    const v = r?.vault;
    const book = m && this.cycle ? this.portfolio().markets[m] : undefined;
    const cooldownRemaining = v ? Math.max(0, v.lastTradeAt + v.limits.cooldown - (this.cycle?.blockTimestamp ?? this.now())) : 0;
    return {
      oracle: { price: r?.price.oracle.price ?? "0", updatedAt: r?.price.oracle.updatedAt ?? 0, roundId: r?.price.oracle.roundId ?? "0", ageSec: r?.price.oracle.ageSec ?? 0 },
      pool: {
        price: r?.price.pool.price ?? "0",
        twap: r?.price.pool.twap ?? "0",
        liquidity: r?.price.pool.liquidity ?? "0",
        deviationBps: r?.price.pool.deviationBps ?? 0,
        twapDeviationBps: r?.price.pool.twapDeviationBps ?? 0,
      },
      ...(r?.price.cex ? { cex: { mid: r.price.cex.mid, halfSpreadBps: r.price.cex.halfSpreadBps, topDepthUsd: r.price.cex.topDepthUsd, at: r.price.cex.at } } : {}),
      policy: {
        maxTradeUsd: v ? e8ToUsd(BigInt(v.limits.maxTradeUsdE8)) : "0",
        epochRemainingUsd: v ? e8ToUsd(BigInt(v.epoch.capUsdE8) - BigInt(v.epoch.spentUsdE8)) : "0",
        turnoverRemainingUsd: book ? e8ToUsd(usdToE8(book.turnover.allocationUsd) - usdToE8(book.turnover.usedUsd) - usdToE8(book.turnover.reservedUsd)) : "0",
        cooldownRemainingSec: cooldownRemaining,
      },
      blockNumber: (this.cycle?.blockNumber ?? 0n).toString(),
      ...extra,
    };
  }

  private meta() {
    return { latencyMs: 0, blockNumber: (this.cycle?.blockNumber ?? 0n).toString() };
  }

  // ------------------------------------------------------------------ tool dispatch

  listTools(scope: "agent" | "chat" | "ui"): ToolName[] {
    if (scope === "ui") return [...CHAT_TOOL_ALLOWLIST, "ate_propose", "ate_execute"];
    return toolsForScope(scope, { hsp: this.cfg.payments.enabled });
  }

  /** A proposal waiting for a human (confirm mode, §7.3), for POST /trade/approve. */
  pendingHuman(id: string): ProposalMeta | null {
    const p = this.proposals.get(id);
    return p && p.status === "awaiting_human" && p.expiresAt >= this.now() ? p : null;
  }

  /** Called by /trade/approve after the ate-approve signature verified: awaiting_human → approved(by=human). */
  approveHuman(id: string): { proposalId: string; status: ProposalStatus; approvedBy: "human"; approvedAt: number } {
    const p = this.pendingHuman(id);
    if (!p) throw new AteError("PolicyError", "ATE_PROPOSAL_UNKNOWN", `proposal ${id} is not awaiting a human approval`);
    const t = this.now();
    p.status = "approved";
    this.o.db.prepare("UPDATE proposals SET status = 'approved', approved_by = 'human', approved_at = ? WHERE id = ?").run(t, id);
    return { proposalId: id, status: "approved", approvedBy: "human", approvedAt: t };
  }

  /**
   * Calls a tool as `scope`. Throws InvalidParamsError for schema-invalid args (→ JSON-RPC InvalidParams).
   * `internal` is the daemon itself (guard exits, smoke); `ui`/`session` use the chat allowlist + execute for confirm.
   */
  async callTool(scope: CallerScope, name: string, rawArgs: unknown, opts: { engine?: Engine } = {}): Promise<ToolResult<unknown>> {
    const t0 = Date.now();
    if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new InvalidParamsError(name, [`unknown tool ${name}`]);
    const tool = name as ToolName;
    if (scope !== "internal") {
      const allowed: readonly string[] =
        scope === "agent" ? this.listTools("agent") : scope === "ui" ? this.listTools("ui") : scope === "chat" || scope === "session" ? CHAT_TOOL_ALLOWLIST : scope === "view" ? ["ate_market_get", "ate_candidates_get", "ate_positions", "ate_strategy_get", "ate_journal_read", "ate_chart", "ate_data"] : [];
      if (!allowed.includes(tool)) {
        return fail("ATE_TOOL_NOT_ALLOWED", `${tool} is not available to the ${scope} scope`, scope === "chat" ? `Chat may call only: ${CHAT_TOOL_ALLOWLIST.join(", ")}` : "Use an agent-scope token");
      }
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const v = validateToolInput(tool, args);
    if (!v.ok) throw new InvalidParamsError(tool, v.errors);
    try {
      const r = await this.dispatch(scope, tool, args, opts);
      if (r.ok) r.meta = { ...this.meta(), latencyMs: Date.now() - t0 };
      return r;
    } catch (e) {
      if (e instanceof AteError) {
        const te = e.toToolError();
        return { ok: false, error: te };
      }
      this.o.log?.(`tool ${tool} internal error: ${(e as Error).stack ?? String(e)}`);
      return fail("ATE_INTERNAL", `internal error: ${(e as Error).message?.split("\n")[0] ?? String(e)}`);
    }
  }

  private async dispatch(scope: CallerScope, tool: ToolName, args: Record<string, unknown>, opts: { engine?: Engine }): Promise<ToolResult<unknown>> {
    switch (tool) {
      case "ate_market_get":
        return this.marketGet(args.market as MarketId | undefined);
      case "ate_candidates_get":
        return this.candidatesGet(scope, args.market as MarketId | undefined);
      case "ate_quote":
        return this.quote(args as unknown as QuoteInput);
      case "ate_propose":
        return this.propose(scope, args as unknown as ProposeInput, opts.engine);
      case "ate_decide":
        return this.decide(scope, args as unknown as DecideInput, opts.engine);
      case "ate_execute":
        return this.execute(scope, args as unknown as ExecuteInput);
      case "ate_positions":
        return this.positions(args.market as MarketId | undefined);
      case "ate_strategy_get":
        return ok(this.strategyGet(), this.meta());
      case "ate_strategy_set":
        return this.strategySet(scope, args as unknown as StrategySetInput);
      case "ate_journal_read":
        return this.journalRead(args as unknown as JournalReadInput);
      case "ate_pause":
        return this.pause(scope, String(args.rationale));
      case "ate_signal_buy":
        return fail("ATE_PAYMENT_UNAVAILABLE", "HSP payments are not live in this daemon", "Payments run in ate-pay on the worker (§9)");
      case "ate_chart":
      case "ate_data": {
        if (!this.charts) return fail("ATE_VENUE_ERROR", "charts are not available in this daemon", "Restart the daemon");
        try {
          const data = tool === "ate_chart" ? await this.charts.chart(args as never) : await this.charts.data(args as never);
          return ok(data, this.meta());
        } catch (e) {
          throw chartError(e);
        }
      }
    }
  }

  // ---- ate_market_get
  private async marketGet(market?: MarketId): Promise<ToolResult<ToolOutput<"ate_market_get">>> {
    const c = await this.refresh(5);
    const ms = this.markets.filter((m) => !market || m === market);
    const out: MarketView[] = [];
    for (const m of ms) {
      const r = c.markets[m];
      if (!r) continue;
      let cex = r.price.cex;
      if (cex && this.o.cfg.oracle.cex) cex = { ...cex };
      const mark = this.exitMarkE8(m);
      out.push({ ...r.price, vault: r.vault ?? this.placeholderVault(m), exitMark: mark === null ? null : mark.toString() });
    }
    return ok({ markets: out }, this.meta());
  }

  // ---- ate_candidates_get
  private async candidatesGet(scope: CallerScope, market?: MarketId): Promise<ToolResult<CandidatesGetOutput>> {
    if (!this.cycle || this.now() - this.lastScanAt > (this.strategy.portfolio.scanSeconds ?? 20) * 2) await this.scan();
    const t = this.now();
    const list = [...this.candidates.values()]
      .filter((c) => c.expiresAt >= t && !c.consumedBy && (!market || c.market === market))
      .map(({ consumedBy: _c, ...c }) => (scope === "chat" ? { ...c, reason: wrapUntrusted(c.reason) } : c));
    return ok(
      { candidates: list, suppressed: this.suppressed.filter((s) => !market || s.market === market), candidateTtlSec: this.strategy.portfolio.candidateTtlSec, cycle: this.scanCount, generatedAt: this.lastScanAt },
      this.meta(),
    );
  }

  // ---- ate_quote
  private async quote(a: QuoteInput): Promise<ToolResult<Quote>> {
    if (!isMarketId(a.market)) return fail("ATE_MARKET_UNKNOWN", `unknown market ${String(a.market)}`);
    const c = await this.refresh(5);
    const { quote } = await this.venue.quoteFull({ market: a.market, side: a.side, amountIn: a.amountIn }, { caller: this.callerFor(a.market) });
    quote.blockNumber = c.blockNumber.toString();
    return ok(quote, this.meta());
  }

  private callerFor(m: MarketId): Address {
    return this.agentAddress() ?? this.cycle?.markets[m]?.vault?.agent ?? ZERO_ADDR;
  }

  // ---- ate_propose
  private async propose(scope: CallerScope, a: ProposeInput, engineHint?: Engine): Promise<ToolResult<ToolOutput<"ate_propose">>> {
    if (!isMarketId(a.market) || !this.vaults[a.market]) return fail("ATE_MARKET_UNKNOWN", `unknown or unconfigured market ${String(a.market)}`, `Use one of ${MARKET_IDS.join(", ")}`);
    const m = a.market;
    const t = this.now();
    await this.refresh(5);
    const cand = a.candidateId ? this.candidates.get(a.candidateId) : undefined;
    // The frozen §7.4 schema defaults origin to "candidate" (Ajv useDefaults fills it), so a human scope's
    // unbound proposal is recognised by the missing candidateId rather than by a missing origin.
    const human = (scope === "ui" || scope === "session") && a.origin !== "discretionary" && !a.candidateId;
    const origin: ProposalOrigin = scope === "internal" && cand?.generator === "guard_exit" ? "guard" : human ? "human" : (a.origin ?? "candidate");
    const engine = this.engineFor(scope, engineHint ?? (cand?.generator === "smoke" || a.rationale.startsWith("[engine=rules]") ? "rules" : undefined));
    const mode = scope === "internal" ? "autonomous" : this.strategy.mode;
    if (mode === "autonomous" && origin === "candidate" && !a.candidateId) {
      return fail("ATE_CANDIDATE_REQUIRED", "autonomous mode: bind to a candidateId or use origin=discretionary with a thesis", "Call ate_candidates_get and pass one candidateId");
    }
    const { quote, check } = await this.venue.quoteFull({ market: m, side: a.side, amountIn: a.amountIn }, { caller: this.callerFor(m) });
    quote.blockNumber = (this.cycle?.blockNumber ?? 0n).toString();
    const draft: ProposalDraft = {
      market: m,
      side: a.side,
      tokenIn: tokenInFor(m, a.side).token,
      amountIn: a.amountIn,
      notionalUsdE8: check.notionalUsd.toString(),
      origin,
      ...(a.candidateId ? { candidateId: a.candidateId } : {}),
      ...(a.thesis ? { thesis: a.thesis } : {}),
      ...(cand ? { generator: cand.generator, ...(cand.leg ? { leg: cand.leg } : {}) } : {}),
      exitPath: check.exitPath,
      actor: this.actorFor(scope),
      scope: scope === "view" || scope === "rogue" ? "internal" : scope,
      mode,
    };
    const verdict = this.o.strategy.guard.check(draft, this.guardPortfolio(cand?.generator), "propose");
    const quoteCtx = { amountOut: quote.amountOut, impactBps: quote.impactBps, minOutFloor: quote.minOutFloor, exitPath: quote.exitPath, source: quote.source };
    const signal = cand ? { id: cand.candidateId, generator: cand.generator, ...(cand.leg ? { leg: cand.leg } : {}), edgeBps: cand.edgeBps, costBps: cand.costBps } : undefined;
    const base: AppendInput = {
      at: t,
      kind: "proposal",
      market: m,
      engine,
      profile: this.profileFor(m, cand?.generator),
      actor: this.actorFor(scope),
      origin,
      ...(a.candidateId ? { candidateId: a.candidateId } : {}),
      ...(a.thesis ? { thesis: a.thesis } : {}),
      intent: { market: m, vault: this.vaults[m]!, side: a.side, tokenIn: draft.tokenIn, amountIn: a.amountIn },
      rationale: a.rationale,
      context: this.context(m, { quote: quoteCtx, ...(signal ? { signal } : {}) }),
      verdict: { ok: true, code: "OK" },
    };
    const policyErr = checkReasonToAteError(check);
    if (policyErr || !verdict.ok) {
      const code = policyErr ? policyErr.code : (verdict as Extract<typeof verdict, { ok: false }>).code;
      const msg = policyErr ? policyErr.message : (verdict as Extract<typeof verdict, { ok: false }>).message;
      const hint = policyErr ? policyErr.hint : (verdict as Extract<typeof verdict, { ok: false }>).hint;
      const e = this.journal.append({ ...base, verdict: { ok: false, code, message: msg } });
      this.insertProposal(e, a, origin, check.oraclePrice, check.reason, "rejected", "0", null, t);
      this.o.emit({ type: "trade.rejected", at: t, data: { market: m, code, message: msg, decisionId: e.id } });
      const r = fail(code, msg, hint);
      if (!r.ok) r.error.details = { decisionId: e.id };
      return r as ToolResult<ToolOutput<"ate_propose">>;
    }
    const approvedBy = mode === "autonomous" ? "policy" : null;
    const status: ProposalStatus = mode === "autonomous" ? "approved" : "awaiting_human";
    const e = this.journal.append({ ...base, verdict: { ok: true, code: "OK", ...(approvedBy ? { approvedBy } : {}) } });
    const reserved = verdict.reserve.turnoverUsd;
    this.insertProposal(e, a, origin, check.oraclePrice, check.reason, status, reserved, approvedBy, t);
    this.o.strategy.reservations.reserve(e.id, verdict.reserve);
    if (cand) {
      cand.consumedBy = e.id;
      this.o.db.prepare("UPDATE candidates SET consumed_by = ? WHERE id = ?").run(e.id, cand.candidateId);
    }
    this.proposals.set(e.id, {
      id: e.id,
      market: m,
      vault: this.vaults[m]!,
      side: a.side,
      tokenIn: draft.tokenIn,
      amountIn: a.amountIn,
      rationale: a.rationale,
      rationaleHash: e.rationaleHash as Hex,
      journalHash: e.hash as Hex,
      candidateId: a.candidateId ?? null,
      origin,
      ...(cand ? { generator: cand.generator, ...(cand.leg ? { leg: cand.leg } : {}) } : origin === "discretionary" ? { generator: "discretionary" } : {}),
      thesis: a.thesis ?? null,
      status,
      engine,
      profile: base.profile,
      actor: base.actor,
      scope,
      createdAt: t,
      expiresAt: t + PROPOSAL_TTL_SEC,
      reservedTurnoverUsd: reserved,
      notionalUsdE8: check.notionalUsd.toString(),
    });
    return ok(
      {
        proposalId: e.id,
        journalHash: e.hash as Hex,
        status,
        origin,
        candidateId: a.candidateId ?? null,
        expiresAt: t + PROPOSAL_TTL_SEC,
        quote,
        reservedTurnoverUsd: reserved,
        approvedBy,
      },
      this.meta(),
    );
  }

  private insertProposal(e: JournalEntry, a: ProposeInput, origin: ProposalOrigin, oraclePrice: bigint, reason: number, status: ProposalStatus, reserved: string, approvedBy: string | null, t: number) {
    const r = this.cycle?.markets[a.market];
    this.o.db
      .prepare(
        `INSERT INTO proposals (id, market, vault, side, token_in, amount_in, min_amount_out, rationale, rationale_hash, candidate_id, signal_id, origin, thesis, journal_hash,
          oracle_price, oracle_updated_at, pool_price, policy_reason, status, reserved_turnover_usd, approved_by, approved_at, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.id,
        a.market,
        this.vaults[a.market]!,
        a.side,
        tokenInFor(a.market, a.side).token,
        a.amountIn,
        e.context.quote?.minOutFloor ?? "0",
        a.rationale,
        e.rationaleHash,
        a.candidateId ?? null,
        a.signalId ?? null,
        origin,
        a.thesis ?? null,
        e.hash,
        oraclePrice.toString(),
        r?.price.oracle.updatedAt ?? 0,
        r?.price.pool.price ?? "0",
        reason,
        status,
        reserved,
        approvedBy,
        approvedBy ? t : null,
        t,
        t + PROPOSAL_TTL_SEC,
      );
  }

  // ---- ate_decide
  private async decide(scope: CallerScope, a: DecideInput, engineHint?: Engine): Promise<ToolResult<ToolOutput<"ate_decide">>> {
    if (!isMarketId(a.market)) return fail("ATE_MARKET_UNKNOWN", `unknown market ${String(a.market)}`);
    const t = this.now();
    const cand = a.candidateId ? this.candidates.get(a.candidateId) : undefined;
    const e = this.journal.append({
      at: t,
      kind: "no_trade",
      market: a.market,
      engine: this.engineFor(scope, engineHint ?? (a.rationale.startsWith("[engine=rules]") ? "rules" : undefined)),
      profile: this.profileFor(a.market),
      actor: this.actorFor(scope),
      ...(a.candidateId ? { candidateId: a.candidateId } : {}),
      rationale: a.rationale,
      context: this.context(a.market, cand ? { signal: { id: cand.candidateId, generator: cand.generator, ...(cand.leg ? { leg: cand.leg } : {}), edgeBps: cand.edgeBps, costBps: cand.costBps } } : {}),
      verdict: { ok: true, code: "NO_TRADE", message: a.reason },
    });
    if (scope === "agent") {
      this.counters.cycles++;
      this.counters.lastCycleAt = t;
    }
    return ok({ decisionId: e.id, hash: e.hash as Hex, at: t }, this.meta());
  }

  // ---- ate_execute
  private async execute(scope: CallerScope, a: ExecuteInput): Promise<ToolResult<ToolOutput<"ate_execute">>> {
    const p = this.proposals.get(a.proposalId);
    if (!p || p.status === "executed" || p.status === "failed" || p.status === "rejected") return fail("ATE_PROPOSAL_UNKNOWN", `proposal ${a.proposalId} not found or already used`, "Call ate_propose again");
    const t = this.now();
    if (p.status === "invalidated" || this.o.strategy.invalidation.isInvalidated(p.id)) {
      this.setStatus(p.id, "invalidated");
      return fail("ATE_STRATEGY_BLOCKED", "proposal invalidated by a guard exit or breaker", "Re-read candidates; buys proposed before a stop-loss cannot execute after it");
    }
    if (p.expiresAt < t || p.status === "expired") {
      this.setStatus(p.id, "expired");
      this.o.strategy.reservations.release(p.id, "expired");
      return fail("ATE_PROPOSAL_EXPIRED", `proposal ${p.id} expired (120 s)`, "Propose again");
    }
    if (p.status === "awaiting_human") return fail("ATE_APPROVAL_REQUIRED", "confirm mode: this proposal awaits a human approval", "Approve it in the UI/CLI");
    if (this.locked) return fail("ATE_DAEMON_LOCKED", "daemon is locked", "Run `ate unlock`");
    const hold = this.rogueHold;
    if (hold && hold.market === p.market && hold.until > t && p.origin !== "guard") {
      return fail("ATE_STRATEGY_BLOCKED", `candidate executes on ${MARKETS[p.market].label} are held for ${hold.until - t} s (ate rogue --stage)`, "Retry after the hold; guard exits are never held", true);
    }
    if (scope === "agent") {
      this.counters.cycles++;
      this.counters.lastCycleAt = t;
    }
    p.status = "approved";
    const failExec = (code: string, message: string, hint?: string): ToolResult<ToolOutput<"ate_execute">> => {
      this.setStatus(p.id, "failed");
      this.o.strategy.reservations.release(p.id, "failed");
      const e = this.journal.append({
        at: this.now(),
        kind: "execution",
        refId: p.id,
        market: p.market,
        engine: p.engine,
        profile: p.profile,
        actor: p.actor,
        origin: p.origin,
        rationale: p.rationale,
        rationaleHash: p.rationaleHash,
        context: this.context(p.market),
        verdict: { ok: false, code: code as never, message },
      });
      this.o.db.prepare("INSERT INTO executions (id, proposal_id, status, error_code, error_message, created_at) VALUES (?,?,?,?,?,?)").run(e.id, p.id, "failed", code, message, this.now());
      this.o.emit({ type: "trade.rejected", at: this.now(), data: { market: p.market, proposalId: p.id, code: code as never, message, decisionId: e.id } });
      const r = fail(code as never, message, hint);
      return r as ToolResult<ToolOutput<"ate_execute">>;
    };

    await this.refresh(2);
    // Guard re-run (rules 2–9) at execute time.
    const draft: ProposalDraft = {
      proposalId: p.id,
      market: p.market,
      side: p.side,
      tokenIn: p.tokenIn,
      amountIn: p.amountIn,
      notionalUsdE8: p.notionalUsdE8,
      origin: p.origin,
      ...(p.candidateId ? { candidateId: p.candidateId } : {}),
      ...(p.thesis ? { thesis: p.thesis } : {}),
      ...(p.generator && p.generator !== "discretionary" ? { generator: p.generator as never } : {}),
      ...(p.leg ? { leg: p.leg } : {}),
      actor: p.actor,
      scope: p.scope === "view" || p.scope === "rogue" ? "internal" : p.scope,
      mode: p.scope === "internal" ? "autonomous" : this.strategy.mode,
    };
    const g = this.o.strategy.guard.check(draft, this.guardPortfolio(p.generator), "execute");
    if (!g.ok) return failExec(g.code, g.message, g.hint);

    // Re-quote (T18) with the proposal's journal hash as on-chain proposalId; refresh Supra if stale.
    const deadline = BigInt((this.cycle?.blockTimestamp ?? t) + EXECUTE_DEADLINE_SEC);
    const requote = () => this.venue.quoteFull({ market: p.market, side: p.side, amountIn: p.amountIn }, { deadline, proposalId: p.journalHash, caller: this.agentAddress()! });
    let q = await requote();
    if ((q.check.reason === ReasonCode.ERR_ORACLE_STALE || q.check.reason === ReasonCode.ERR_ORACLE_DEVIATION) && this.cfg.supra.pull?.enabled) {
      const age = this.cycle?.markets[p.market]?.price.oracle.ageSec ?? 0;
      if (q.check.reason === ReasonCode.ERR_ORACLE_STALE || age > this.cfg.supra.pull.refreshAgeSec) {
        await this.supraRefresh("pre-trade").catch((e) => this.o.log?.(`pre-trade supra refresh: ${(e as Error).message}`));
        q = await requote();
      }
    }
    const pe = checkReasonToAteError(q.check);
    if (pe) return failExec(pe.code, pe.message, pe.hint);
    const tx = this.venue.buildExecute(q.quote, { proposalId: p.journalHash, rationaleHash: p.rationaleHash, minAmountOut: q.minAmountOut, deadline });
    // Pre-flight eth_call of execute from the agent (exact, includes policy).
    let pre: { amountOut: bigint; gas: bigint | null };
    try {
      pre = await this.venue.preflight(tx, this.agentAddress()!);
    } catch (e) {
      const ae = e as AteError;
      return failExec(ae.code ?? "ATE_VENUE_ERROR", ae.message, ae.hint);
    }
    const priority: TxPriority = p.origin === "guard" ? "exit" : "execute";
    this.bumpVaultTx(p.market);
    const h = this.o.txq.enqueue({
      priority,
      to: tx.to,
      data: tx.data,
      ...(pre.gas ? { gas: (pre.gas * 13n) / 10n + 30_000n } : {}),
      label: `execute ${p.id}`,
      // the vault enforces `deadline` on chain time; locally only invalidation matters
      stillValid: () => !this.o.strategy.invalidation.isInvalidated(p.id),
    });
    let receipt: TransactionReceipt;
    let txHash: Hex;
    try {
      txHash = await h.submitted;
      receipt = await h.mined;
    } catch (e) {
      const ae = e as AteError;
      return failExec(ae.code ?? "ATE_VENUE_ERROR", ae.message ?? String(e), ae.hint);
    }
    if (receipt.status !== "success") {
      return failExec("ATE_VENUE_ERROR", `execute tx ${receipt.transactionHash} reverted on-chain`, "Inspect the tx on Blockscout; re-quote and retry");
    }
    txHash = receipt.transactionHash as Hex;
    const fill = this.venue.parseReceipt(receipt);
    const amountOut = fill?.amountOut ?? pre.amountOut;
    const notional = fill?.notionalUsd ?? q.check.notionalUsd;
    const exitPath = fill?.exitPath ?? q.check.exitPath;
    const et = this.now();
    const e = this.journal.append({
      at: et,
      kind: "execution",
      refId: p.id,
      market: p.market,
      engine: p.engine,
      profile: p.profile,
      actor: p.actor,
      origin: p.origin,
      ...(p.candidateId ? { candidateId: p.candidateId } : {}),
      intent: { market: p.market, vault: p.vault, side: p.side, tokenIn: p.tokenIn, amountIn: p.amountIn },
      rationale: p.rationale,
      rationaleHash: p.rationaleHash,
      context: this.context(p.market, { quote: { amountOut: q.quote.amountOut, impactBps: q.quote.impactBps, minOutFloor: q.quote.minOutFloor, exitPath, source: "simulation" } }),
      verdict: { ok: true, code: "OK", approvedBy: "policy" },
      execution: { txHash, blockNumber: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString(), amountOut: amountOut.toString(), exitPath },
    });
    const db = this.o.db;
    db.prepare("INSERT INTO executions (id, proposal_id, tx_hash, block_number, status, amount_out, gas_used, exit_path, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
      e.id,
      p.id,
      txHash,
      Number(receipt.blockNumber),
      "executed",
      amountOut.toString(),
      receipt.gasUsed.toString(),
      exitPath ? 1 : 0,
      et,
    );
    const base = p.side === "buy" ? amountOut : BigInt(p.amountIn);
    const quoteQty = p.side === "buy" ? BigInt(p.amountIn) : amountOut;
    const d = MARKETS[p.market].baseDecimals;
    const price = base > 0n ? (quoteQty * 100n * 10n ** BigInt(d)) / base : 0n;
    db.prepare("INSERT INTO fills (id, execution_id, market, generator, side, base_qty, quote_qty, price, cex_mid, at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      `fill_${e.id.slice(5)}`,
      e.id,
      p.market,
      p.generator ?? p.origin,
      p.side,
      base.toString(),
      quoteQty.toString(),
      price.toString(),
      this.cycle?.markets[p.market]?.price.cex?.mid ?? null,
      et,
    );
    this.setStatus(p.id, "executed");
    this.o.strategy.reservations.release(p.id, "executed");
    this.counters.trades++;
    this.counters.routedUsdE8 += notional;
    if (this.cycle) this.cycle = { ...this.cycle, at: 0 }; // force a re-read, keep last values for /status
    this.o.emit({ type: "trade.executed", at: et, data: { market: p.market, proposalId: p.id, txHash, side: p.side, amountIn: p.amountIn, amountOut: amountOut.toString(), exitPath, decisionId: e.id } });
    const attestation = this.attest(p, txHash, notional, exitPath, e.id);
    return ok(
      {
        proposalId: p.id,
        executionId: e.id,
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        amountIn: p.amountIn,
        amountOut: amountOut.toString(),
        minAmountOut: q.minAmountOut.toString(),
        quoterOut: q.quote.amountOut,
        notionalUsdE8: notional.toString(),
        exitPath,
        rationaleHash: p.rationaleHash,
        attestation,
      },
      this.meta(),
    );
  }

  /** EAS attestation via Lane E's Attester, lowest TxQueue priority; never blocks or reverses a trade (§13). */
  private attest(p: ProposalMeta, txHash: Hex, notional: bigint, exitPath: boolean, execId: string): { status: "queued" | "deferred"; decisionId?: string } {
    const at = this.o.attester;
    if (!at) return { status: "deferred" };
    const bal = this.cycle?.agentBalanceWei ?? 10n ** 19n;
    const input = { proposalId: p.journalHash, rationaleHash: p.rationaleHash, txHash, notionalUsdE8: notional, exitPath, engine: p.engine, origin: p.generator === "smoke" ? "smoke" : p.origin, vault: p.vault };
    const journalAtt = (rec: { refId: string; engine: string; rationale: string; verdict: { ok: boolean; code: string; message?: string }; attestation?: { easUid: string; schemaUid: string; txHash: string } }) =>
      this.journal.append({
        at: this.now(),
        kind: "attestation",
        refId: p.id,
        market: p.market,
        engine: p.engine,
        profile: p.profile,
        actor: { kind: "guard" },
        origin: p.origin,
        rationale: rec.rationale,
        context: this.context(p.market),
        verdict: rec.verdict as never,
        ...(rec.attestation ? { attestation: rec.attestation } : {}),
      });
    const run = (plan: ReturnType<Attesterish["plan"]>): void => {
      if (plan.action === "enqueue") {
        const tx = (plan as { tx: { to: Address; data: Hex; gasHint: bigint } }).tx;
        // estimate gas (Lane E gasHint 400k ran out of gas on the fork: attest uses ~520k)
        const h = this.o.txq.enqueue({ priority: "attest", to: tx.to, data: tx.data, label: `attest ${p.id}` });
        h.submitted.then((hash) => at.onSubmitted(p.journalHash, hash)).catch(() => {});
        h.mined
          .then((r) => {
            const res = at.onMined(r, this.cycle?.agentBalanceWei ?? bal);
            if ("record" in res) journalAtt(res.record);
            else run(res.retry as ReturnType<Attesterish["plan"]>);
          })
          .catch((err) => run(at.onFailed(p.journalHash, String((err as Error)?.message ?? err), this.cycle?.agentBalanceWei ?? bal) as ReturnType<Attesterish["plan"]>));
      } else if (plan.action === "defer") {
        journalAtt(at.failureRecord(p.journalHash, "deferred"));
      } else {
        journalAtt(at.failureRecord(p.journalHash, "failed"));
      }
    };
    try {
      const plan = at.plan(input, p.id, bal);
      run(plan);
      return { status: plan.action === "enqueue" ? "queued" : "deferred", decisionId: execId };
    } catch (e) {
      this.o.log?.(`attest: ${(e as Error).message}`);
      return { status: "deferred" };
    }
  }

  // ---- Supra pull refresh (contracts 974cbf0): verifyOracleProof through the TxQueue, journalled `oracle_refresh`.
  async supraRefresh(reason: "age" | "pre-trade" | "manual"): Promise<void> {
    const pull = this.cfg.supra.pull;
    if (!pull?.enabled && reason !== "manual") return;
    if (this.supraRefreshing) return this.supraRefreshing;
    this.supraRefreshing = (async () => {
      this.lastSupraRefreshAt = this.now();
      const pairs = [...new Set(this.markets.map((m) => (this.cfg.supra.pairs?.[m] ?? SUPRA_PAIRS[m]) as number | null).filter((x): x is number => x !== null))];
      const proof = await fetchSupraProof(pull?.proofUrl ?? SUPRA_PROOF_URL, pairs, this.o.fetchImpl);
      const tx = buildSupraPullTx((pull?.contract ?? SUPRA_PULL) as Address, proof);
      for (const m of this.markets) this.bumpVaultTx(m); // an oracle refresh changes check() for both vaults
      const h = this.o.txq.enqueue({ priority: reason === "pre-trade" ? "execute" : "refresh", to: tx.to, data: tx.data, gas: tx.gas, label: `supra refresh (${reason})` });
      let ok = false;
      let txHash: Hex | null = null;
      let msg = "";
      try {
        txHash = await h.submitted;
        const r = await h.mined;
        ok = r.status === "success";
        msg = ok ? "verifyOracleProof mined" : "verifyOracleProof reverted";
      } catch (e) {
        msg = (e as Error).message;
      }
      this.journal.append({
        at: this.now(),
        kind: "oracle_refresh",
        engine: "guard",
        profile: "default",
        actor: { kind: "guard" },
        rationale: `Supra pull refresh (${reason}) for pairs ${pairs.join(",")}${txHash ? ` tx ${txHash}` : ""}`,
        context: this.context(this.markets[0]),
        verdict: { ok, code: ok ? "OK" : "ATE_VENUE_ERROR", message: msg },
      });
      if (this.cycle) this.cycle = { ...this.cycle, at: 0 };
    })().finally(() => (this.supraRefreshing = null));
    return this.supraRefreshing;
  }

  // ---- ate_positions
  private async positions(market?: MarketId): Promise<ToolResult<ToolOutput<"ate_positions">>> {
    await this.refresh(10);
    const pf = this.portfolio();
    const out: MarketPosition[] = [];
    let realised = 0n;
    let uExit = 0n;
    let uCex = 0n;
    let exposure = 0n;
    for (const m of this.markets) {
      const r = this.cycle?.markets[m];
      const v = r?.vault ?? this.placeholderVault(m);
      const d = MARKETS[m].baseDecimals;
      const b = this.book(m);
      const mark = this.exitMarkE8(m);
      const cexMid = r?.price.cex ? BigInt(r.price.cex.mid) : null;
      const ue = unrealised(b, mark, d);
      const uc = unrealised(b, cexMid, d);
      realised += b.realisedE8;
      uExit += ue.usdE8;
      uCex += uc.usdE8;
      exposure += BigInt(v.exposureUsdE8);
      const book = pf.markets[m];
      const avg = avgEntryE8(b, d);
      const epochRem = BigInt(v.epoch.capUsdE8) - BigInt(v.epoch.spentUsdE8);
      const pos: MarketPosition = {
        market: m,
        vault: v.address,
        balanceQuote: v.balanceQuote,
        balancePrice: v.balancePrice,
        qty: v.balancePrice,
        exposureUsd: e8ToUsd(BigInt(v.exposureUsdE8)),
        avgEntry: avg === null ? null : avg.toString(),
        mark: mark === null ? null : mark.toString(),
        cexMid: cexMid === null ? null : cexMid.toString(),
        realisedUsd: fmtE8(b.realisedE8),
        unrealisedExitUsd: fmtE8(ue.usdE8),
        unrealisedExitBps: ue.bps,
        unrealisedCexUsd: fmtE8(uc.usdE8),
        unrealisedCexBps: uc.bps,
        feeDragUsd: fmtE8(b.feeDragE8),
        lots: b.lots,
        lotsRealisedUsd: fmtE8(b.lotsRealisedE8),
        epoch: { spentUsd: e8ToUsd(BigInt(v.epoch.spentUsdE8)), capUsd: e8ToUsd(BigInt(v.epoch.capUsdE8)), remainingUsd: e8ToUsd(epochRem > 0n ? epochRem : 0n), resetsAt: v.epoch.start + v.limits.epochDuration },
        exitReserveUsd: e8ToUsd(BigInt(v.exposureUsdE8)),
        turnoverRemainingUsd: book ? e8ToUsd(maxZero(usdToE8(book.turnover.allocationUsd) - usdToE8(book.turnover.usedUsd) - usdToE8(book.turnover.reservedUsd))) : "0",
        reentryLockUntil: book?.reentryLockUntil ?? null,
        paused: v.paused,
      };
      if (!market || market === m) out.push(pos);
    }
    const q = (sql: string, ...a: unknown[]) => (this.o.db.prepare(sql).get(...a) as { c: number }).c;
    const scoreboard = {
      acts: q("SELECT COUNT(*) c FROM decisions WHERE kind = 'execution' AND json_extract(record,'$.engine') = 'llm' AND json_extract(record,'$.verdict.ok') = 1"),
      vetoes: q("SELECT COUNT(*) c FROM decisions WHERE kind = 'no_trade' AND json_extract(record,'$.verdict.message') = 'llm_veto'"),
      sizeDowns: q("SELECT COUNT(*) c FROM decisions o JOIN decisions d ON d.id = o.ref_id WHERE o.kind = 'outcome' AND d.kind = 'proposal'"),
      savedBps: 0,
      savedUsd: "0",
      discretionary: q("SELECT COUNT(*) c FROM proposals WHERE origin = 'discretionary' AND status = 'executed'"),
    };
    const outcomes = this.journal.list({ kind: ["outcome"], limit: 500 });
    for (const o of outcomes) {
      scoreboard.savedBps += o.outcome?.savedBps ?? 0;
      scoreboard.savedUsd = e8ToUsdSigned(parseSignedUsd(scoreboard.savedUsd) + parseSignedUsd(o.outcome?.savedUsd ?? "0"));
    }
    return ok(
      {
        markets: out,
        portfolio: {
          exposureUsd: e8ToUsd(exposure),
          maxPortfolioExposureUsd: this.strategy.portfolio.maxPortfolioExposureUsd,
          dailyPnlUsd: pf.dailyPnlUsd,
          realisedUsd: fmtE8(realised),
          unrealisedExitUsd: fmtE8(uExit),
          unrealisedCexUsd: fmtE8(uCex),
          turnoverUsedUsd: pf.turnover.usedUsd,
          turnoverRemainingUsd: e8ToUsd(maxZero(usdToE8(pf.turnover.budgetUsd) - usdToE8(pf.turnover.usedUsd) - usdToE8(pf.turnover.reservedUsd))),
          discretionaryUsedToday: pf.discretionary.executedToday,
          breaker: pf.breaker.state,
        },
        scoreboard,
        counters: this.countersOut(),
      },
      this.meta(),
    );
  }

  countersOut() {
    const t = this.now();
    return {
      uptimeSec: t - this.startedAt,
      startedAt: this.startedAt,
      cycles: this.counters.cycles,
      trades: this.counters.trades,
      hskswapTrades: this.counters.trades,
      routedUsd: e8ToUsd(this.counters.routedUsdE8),
    };
  }

  // ---- strategy
  strategyGet(): ToolOutput<"ate_strategy_get"> {
    const anchors = Object.fromEntries(
      MARKET_IDS.map((m) => {
        const a = this.anchors.markets[m];
        return [m, { entrySpreadBps: a.entrySpreadBps, minNetEdgeBps: a.minNetEdgeBps, tradeSizeUsd: a.tradeSizeUsd, cycleSeconds: a.cycleSeconds }];
      }),
    ) as ToolOutput<"ate_strategy_get">["anchors"];
    return { strategy: this.strategy, anchors, updatedAt: this.strategyUpdatedAt };
  }

  private async strategySet(scope: CallerScope, a: StrategySetInput): Promise<ToolResult<ToolOutput<"ate_strategy_set">>> {
    const patch = a.patch;
    // Lane C's StrategyPatcher (riskProfile expansion, vault/agent clamps, loosening table); the inline clamp
    // below is the fallback for the lane-b stub only. Loosening → pending change + ATE_APPROVAL_REQUIRED.
    const patcher = this.o.strategy.patcher;
    if (patcher) {
      const pscope = scope === "agent" || scope === "chat" || scope === "ui" || scope === "session" ? scope : "ui";
      const vaults = {} as Record<MarketId, VaultState>;
      for (const m of this.markets) {
        const v = this.cycle?.markets[m]?.vault;
        if (v && this.vaults[m]) vaults[m] = v as VaultState;
      }
      const r = patcher.apply(patch, pscope, this.strategy, this.anchors, vaults);
      if (r.needsApproval) return this.pendStrategy(patch, scope, a.rationale, r.changes, r.next);
      if (scope === "chat" && this.sellsNow(r.changes)) return this.pendStrategy(patch, scope, a.rationale, r.changes, r.next, "sells_now");
      const dec = this.applyStrategy(scope, r.next, r.changes, a.rationale);
      return ok({ status: "applied", decisionId: dec, changes: r.changes, clamped: r.clamped, strategy: this.strategy }, this.meta());
    }
    const AGENT_FIELDS = new Set<string>(["entrySpreadBps", "minNetEdgeBps", "tradeSizeUsd", "cycleSeconds", "market"]);
    if (scope === "agent") {
      const bad = Object.keys(patch).filter((k) => !AGENT_FIELDS.has(k));
      if (bad.length) return fail("ATE_TOOL_NOT_ALLOWED", `agent scope may not change: ${bad.join(", ")}`, "Agent scope may change only entrySpreadBps, minNetEdgeBps, tradeSizeUsd, cycleSeconds");
    }
    const next = JSON.parse(JSON.stringify(this.strategy)) as StrategyParams;
    const changes: StrategyFieldChange[] = [];
    let clamped = false;
    const expanded: Record<string, unknown> = { ...(patch.riskProfile ? RISK_PROFILES[patch.riskProfile] : {}), ...patch };
    delete expanded.riskProfile;
    delete expanded.market;
    const scopeMarkets: MarketId[] = patch.market ? [patch.market] : [...MARKET_IDS];
    const [lo, hi] = this.strategy.portfolio.agentTuneRange;
    for (const [k, raw] of Object.entries(expanded)) {
      const pfField = k in next.portfolio || k === "enabled";
      const scopes: ("portfolio" | MarketId)[] = pfField ? ["portfolio"] : scopeMarkets;
      for (const s of scopes) {
        const target = (s === "portfolio" ? (k === "enabled" ? next : next.portfolio) : next.markets[s]) as unknown as Record<string, unknown>;
        const before = target[k];
        let v: unknown = raw;
        let requested: unknown;
        let clampedBy: string | undefined;
        if (scope === "agent" && s !== "portfolio") {
          const anchor = Number((this.anchors.markets[s] as unknown as Record<string, unknown>)[k]);
          const n = Number(raw);
          const c = Math.min(Math.max(n, anchor * lo), anchor * hi);
          if (c !== n) {
            requested = raw;
            clampedBy = `agentTuneRange ×${lo}–×${hi} of human anchor ${anchor}`;
            clamped = true;
          }
          v = typeof raw === "string" ? String(Math.round(c * 100) / 100) : Math.round(c);
        }
        if (k === "maxPositionUsd" && s !== "portfolio") {
          const vs = this.cycle?.markets[s]?.vault;
          if (vs) {
            const cap = e8ToUsd(BigInt(vs.limits.maxExposureUsdE8));
            if (Number(v) > Number(cap)) {
              requested = v;
              v = cap;
              clampedBy = "vault maxExposureUsd";
              clamped = true;
            }
          }
        }
        const dir = LOOSENING_DIRECTION[k as keyof StrategyPatch];
        const loosening =
          scope !== "agent" &&
          ((dir === "up" && Number(v) > Number(before ?? 0) && !(k === "rebalanceTargetPct" && Number(v) === 0)) ||
            (dir === "down" && Number(v) < Number(before)) ||
            (dir === "any" && v !== before) ||
            (k === "targetAssets" && (v as string[]).some((x) => !(before as string[]).includes(x))) ||
            (k === "enabled" && v === true && before !== true));
        if (JSON.stringify(before) === JSON.stringify(v)) continue;
        target[k] = v;
        changes.push({ scope: s, field: k as keyof StrategyPatch, before, after: v, ...(requested !== undefined ? { requested } : {}), ...(clampedBy ? { clampedBy } : {}), loosening });
      }
    }
    if (changes.some((c) => c.loosening)) return this.pendStrategy(patch, scope, a.rationale, changes, next);
    if (scope === "chat" && this.sellsNow(changes)) return this.pendStrategy(patch, scope, a.rationale, changes, next, "sells_now");
    const dec = this.applyStrategy(scope, next, changes, a.rationale);
    return ok({ status: "applied", decisionId: dec, changes, clamped, strategy: this.strategy }, this.meta());
  }

  /**
   * Additive (Flow v1, FLOW.md journey C): a chat change that drops a target asset (or sets a 0% allocation) makes
   * the guard sell at once. SPEC §11.5 classes it as tightening; v1 still holds it for a Touch ID confirmation.
   */
  private sellsNow(changes: StrategyFieldChange[]): boolean {
    return changes.some(
      (c) =>
        (c.field === "targetAssets" && Array.isArray(c.before) && (c.before as string[]).some((x) => !((c.after as string[] | undefined) ?? []).includes(x))) ||
        (c.field === "rebalanceTargetPct" && c.after === 0 && c.before !== 0),
    );
  }

  /** Additive (desktop Agent → Waiting for you): every unexpired pending change. */
  listPendingChanges(): { changeId: string; diff: StrategyFieldChange[]; renderedDiff: string; expiresAt: number; createdAt: number; via: CallerScope; rationale: string; confirm?: "sells_now" }[] {
    const t = this.now();
    const out = [];
    for (const [changeId, c] of this.pendingChanges) {
      if (c.expiresAt < t) {
        this.pendingChanges.delete(changeId);
        continue;
      }
      out.push({ changeId, diff: c.changes, renderedDiff: c.renderedDiff, expiresAt: c.expiresAt, createdAt: c.expiresAt - 60, via: c.scope, rationale: c.rationale, ...(c.confirm ? { confirm: c.confirm } : {}) });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Additive: the human rejects a pending change (nothing is applied; journalled nowhere: it never took effect). */
  rejectPendingChange(changeId: string): boolean {
    return this.pendingChanges.delete(changeId);
  }

  /** Loosening change: held for 60 s until ate-approve (or the armed TTY code) signs it via /strategy/approve. */
  private pendStrategy(patch: StrategyPatch, scope: CallerScope, rationale: string, changes: StrategyFieldChange[], next: StrategyParams, confirm?: "sells_now"): ToolResult<ToolOutput<"ate_strategy_set">> {
    const changeId = `chg_${rationaleHash(`${this.now()}|${rationale}|${Math.random()}`).slice(2, 18)}`;
    const expiresAt = this.now() + 60;
    const renderedDiff = changes
      .map((c) => `${c.scope === "portfolio" ? "portfolio" : MARKETS[c.scope].label} ${String(c.field)}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}${c.loosening ? "  [LOOSENING]" : ""}`)
      .join("\n");
    this.pendingChanges.set(changeId, { patch, scope, rationale, changes, next, expiresAt, renderedDiff, ...(confirm ? { confirm } : {}) });
    const r = confirm
      ? fail("ATE_APPROVAL_REQUIRED", "this change makes the guard sell now and needs a Touch ID confirmation", "Confirm the rendered diff with Touch ID within 60 s")
      : fail("ATE_APPROVAL_REQUIRED", "this change loosens risk and needs an ate-approve signature", "Approve the rendered diff with Touch ID within 60 s");
    if (!r.ok) r.error.details = { changeId, diff: changes, renderedDiff, expiresAt, ...(confirm ? { confirm } : {}) };
    try {
      this.onStrategyPending?.(r.ok ? null : r.error.details);
    } catch {
      /* hook never breaks the tool */
    }
    return r as ToolResult<ToolOutput<"ate_strategy_set">>;
  }

  private applyStrategy(scope: CallerScope, next: StrategyParams, changes: StrategyFieldChange[], rationale: string): string {
    this.strategy = next;
    if (scope !== "agent") {
      // human scopes set the anchors
      this.anchors = JSON.parse(JSON.stringify(next)) as StrategyParams;
    }
    this.saveStrategy();
    const e = this.journal.append({
      at: this.now(),
      kind: "strategy_change",
      engine: scope === "agent" ? this.strategy.engine : "human",
      profile: "default",
      actor: this.actorFor(scope),
      rationale,
      context: this.context(undefined),
      verdict: { ok: true, code: "OK", approvedBy: scope === "agent" ? "policy" : "human" },
    });
    this.o.emit({ type: "strategy.changed", at: this.now(), data: { decisionId: e.id, changes, actor: scope === "agent" ? "agent" : "human" } });
    if (scope !== "agent") this.requestCycle("strategy_change");
    return e.id;
  }

  /** For Lane E's POST /strategy/approve after the ate-approve signature verifies. */
  applyPendingChange(changeId: string): { decisionId: string; changes: StrategyFieldChange[] } {
    const c = this.pendingChanges.get(changeId);
    if (!c || c.expiresAt < this.now()) throw new AteError("AuthError", "ATE_APPROVAL_REQUIRED", "unknown or expired changeId", { hint: "Re-submit the strategy change (pending TTL 60 s)" });
    this.pendingChanges.delete(changeId);
    return { decisionId: this.applyStrategy(c.scope, c.next, c.changes, c.rationale), changes: c.changes };
  }

  pendingChange(changeId: string) {
    return this.pendingChanges.get(changeId) ?? null;
  }

  // ---- ate_journal_read
  private journalRead(a: JournalReadInput): ToolResult<ToolOutput<"ate_journal_read">> {
    const entries = this.journal.list(a).map((e) => ({ ...e, rationale: wrapUntrusted(e.rationale), ...(e.thesis ? { thesis: wrapUntrusted(e.thesis) } : {}) }));
    return ok({ entries, head: this.journal.head() }, this.meta());
  }

  // ---- ate_pause (kill switch: both vaults, then lock)
  private async pause(scope: CallerScope, rationale: string): Promise<ToolResult<ToolOutput<"ate_pause">>> {
    if (this.locked) return fail("ATE_DAEMON_LOCKED", "daemon is locked; the guardian can still pause from its own device", "Run `ate unlock` or use `ate-owner pause --guardian --all`");
    await this.refresh(2).catch(() => null);
    const res: ToolOutput<"ate_pause">["vaults"] = [];
    const handles: Promise<unknown>[] = [];
    for (const m of this.markets) {
      const v = this.vaults[m];
      if (!v) continue;
      if (this.cycle?.markets[m]?.vault?.paused) {
        res.push({ market: m, vault: v, txHash: `0x${"00".repeat(32)}`, status: "already_paused" });
        continue;
      }
      const tx = this.venue.buildPause(m);
      this.bumpVaultTx(m);
      const h = this.o.txq.enqueue({ priority: "pause", to: tx.to, data: tx.data, gas: 120_000n, label: `pause ${m}` });
      handles.push(h.mined.catch(() => null));
      res.push({ market: m, vault: v, txHash: await h.submitted, status: "submitted" });
    }
    const ids = this.o.strategy.invalidation.onBreaker();
    for (const id of ids) this.setStatus(id, "invalidated");
    for (const p of this.proposals.values()) if (p.status === "approved") this.setStatus(p.id, "invalidated");
    const e = this.journal.append({
      at: this.now(),
      kind: "pause",
      engine: this.engineFor(scope),
      profile: "default",
      actor: this.actorFor(scope),
      rationale,
      context: this.context(undefined),
      verdict: { ok: true, code: "OK" },
    });
    // Lock once the pause txs are signed (submitted); mining continues in the queue's broadcast loop.
    void Promise.all(handles).then(() => undefined);
    this.lock("ate_pause");
    return ok({ vaults: res, decisionId: e.id, daemonLocked: true }, this.meta());
  }

  lock(reason: string) {
    this.o.signer.lock();
    this.o.emit({ type: "daemon.locked", at: this.now(), data: { locked: true, reason } });
  }

  // ---- /status
  status(): StatusResponse {
    const g = this.cycle?.agentBalanceWei ?? null;
    return {
      ...this.countersOut(),
      version: this.o.version,
      chainId: this.cfg.chain.id,
      blockNumber: (this.cycle?.blockNumber ?? 0n).toString(),
      locked: this.locked,
      trader: { running: this.counters.lastCycleAt !== null && this.now() - this.counters.lastCycleAt < 600, mode: this.strategy.mode, engine: this.strategy.engine, lastCycleAt: this.counters.lastCycleAt },
      vaults: this.markets.filter((m) => this.vaults[m]).map((m) => ({ market: m, address: this.vaults[m]!, paused: this.cycle?.markets[m]?.vault?.paused ?? false })),
      gas: { agentHsk: g === null ? "0" : (Number(g) / 1e18).toFixed(4), low: this.gasLow, attestationsDeferred: this.o.attester?.deferredCount() ?? 0 },
    };
  }

  private bumpVaultTx(m: MarketId) {
    this.vaultTxSeq[m] = (this.vaultTxSeq[m] ?? 0) + 1;
  }

  /** `POST /rogue/hold` (rogue scope, §22.3 `--stage`): hold candidate executes on one vault; guard exits are never held. */
  rogueHoldSet(body: { market?: string; seconds?: number }): { market: MarketId; heldUntil: number; vaultTxSeq: number } {
    const m = (body?.market === "WHSK" || body?.market === "HSK" ? "hsk-dex:WHSK/USDT:3000" : body?.market === "WBTC" || body?.market === "BTC" ? "hsk-dex:WBTC/USDT:3000" : body?.market) as MarketId;
    if (!isMarketId(m) || !this.vaults[m]) throw new AteError("ConfigError", "ATE_MARKET_UNKNOWN", `rogue hold: unknown market ${String(body?.market)}`);
    const secs = Math.max(0, Math.min(300, Math.floor(Number(body?.seconds ?? 90))));
    const until = this.now() + secs;
    this.rogueHold = secs > 0 ? { market: m, until } : null;
    this.o.log?.(`rogue hold: ${MARKETS[m].label} candidate executes held ${secs} s`);
    return { market: m, heldUntil: until, vaultTxSeq: this.vaultTxSeq[m] ?? 0 };
  }

  /** Daemon-originated tx count for a vault (the `--stage` abort check). */
  rogueQueueSeq(m: MarketId): number {
    return this.vaultTxSeq[m] ?? 0;
  }

  /**
   * Rogue raw route (§10.1, §22.3): `to` ∈ vaults, selector ∈ {execute, withdraw, setLimits, pause}; fixed gas
   * (so a revert lands on-chain); journalled `profile=rogue` as a `proposal` + `execution` pair per attempt with
   * `verdict.code` = the expected code. `ifVaultTxSeq` (from `/rogue/hold`) aborts with ATE_STRATEGY_BLOCKED if
   * any daemon tx for that vault entered the queue since — `--stage` then falls back to the recorded E4.
   */
  async rogueBroadcast(body: {
    to: string;
    data: string;
    gas?: string;
    rationale?: string;
    attack?: string;
    expected?: string;
    ifVaultTxSeq?: number;
    intent?: { side: Side; tokenIn: string; amountIn: string };
  }): Promise<{ txHash: Hex; status: string; decisionId: string; proposalDecisionId: string; blockNumber: string | null; gasUsed: string | null }> {
    const SELECTORS = new Set(["execute", "withdraw", "setLimits", "pause"].map((fn) => selectorOf(fn)));
    const to = String(body.to).toLowerCase();
    const market = this.markets.find((m) => this.vaults[m]?.toLowerCase() === to);
    if (!market) throw new AteError("AuthError", "ATE_TOOL_NOT_ALLOWED", "rogue route: `to` is not one of the two vaults");
    const data = String(body.data) as Hex;
    if (!/^0x[0-9a-fA-F]{8}/.test(data) || !SELECTORS.has(data.slice(0, 10).toLowerCase())) throw new AteError("AuthError", "ATE_TOOL_NOT_ALLOWED", "rogue route: selector must be execute, withdraw, setLimits or pause");
    if (body.ifVaultTxSeq !== undefined && (this.vaultTxSeq[market] ?? 0) !== Number(body.ifVaultTxSeq)) {
      throw new AteError("StrategyError", "ATE_STRATEGY_BLOCKED", `a ${MARKETS[market].label} tx entered the queue after check(); aborting (use the recorded E4)`, { retryable: false });
    }
    if (this.locked) throw new AteError("WalletError", "ATE_DAEMON_LOCKED", "daemon is locked");
    const gas = BigInt(body.gas ?? "800000");
    if (gas < 50_000n || gas > 3_000_000n) throw new AteError("ConfigError", "ATE_CONFIG_INVALID", "rogue route: gas must be 50k–3M");
    const expected = String(body.expected ?? "");
    const reasonIdx = (ReasonCode as Record<string, number>)[expected];
    const code = (reasonIdx !== undefined && reasonIdx > 0 ? reasonToError(reasonIdx) : expected === "OWNER_ONLY" ? "ATE_TOOL_NOT_ALLOWED" : "ATE_VENUE_ERROR") ?? "ATE_VENUE_ERROR";
    const attack = String(body.attack ?? "raw").slice(0, 64);
    const rationale = `[rogue] ${attack}: ${String(body.rationale ?? "ate rogue raw broadcast").slice(0, 400)}`;
    const vault = this.vaults[market]!;
    const prop = this.journal.append({
      at: this.now(),
      kind: "proposal",
      market,
      engine: "rules",
      profile: "rogue",
      actor: this.actorFor("rogue"),
      ...(body.intent ? { intent: { market, vault, side: body.intent.side, tokenIn: String(body.intent.tokenIn), amountIn: String(body.intent.amountIn) } } : {}),
      rationale,
      context: this.context(market),
      verdict: { ok: false, code: code as never, message: `expected ${expected || "revert"} (rogue key, no pre-flight, fixed gas ${gas})` },
    });
    const h = this.o.txq.enqueue({ priority: "rogue", to: vault, data, gas, label: `rogue ${attack}` });
    const txHash = await h.submitted;
    const r = await h.mined.catch(() => null);
    const reverted = r ? r.status !== "success" : undefined;
    const e = this.journal.append({
      at: this.now(),
      kind: "execution",
      refId: prop.id,
      market,
      engine: "rules",
      profile: "rogue",
      actor: this.actorFor("rogue"),
      rationale,
      context: this.context(market),
      verdict: reverted
        ? { ok: false, code: code as never, message: `reverted on-chain as expected (${expected || "revert"}) tx ${txHash}` }
        : { ok: r?.status === "success", code: r ? ("OK" as const) : ("ATE_VENUE_ERROR" as const), message: r ? `UNEXPECTED: tx succeeded ${txHash}` : "not mined" },
      ...(r ? { execution: { txHash, blockNumber: Number(r.blockNumber), gasUsed: r.gasUsed.toString(), amountOut: "0", exitPath: false, reverted: r.status !== "success" } } : {}),
    });
    if (reverted) this.o.emit({ type: "policy.violation", at: this.now(), data: { market, reason: reasonIdx ?? 0, code, txHash, profile: "rogue", attack } });
    return { txHash, status: r?.status ?? "pending", decisionId: e.id, proposalDecisionId: prop.id, blockNumber: r ? r.blockNumber.toString() : null, gasUsed: r ? r.gasUsed.toString() : null };
  }
}

function maxZero(x: bigint) {
  return x > 0n ? x : 0n;
}
function parseSignedUsd(s: string): bigint {
  const neg = s.startsWith("-");
  const v = usdToE8(neg ? s.slice(1) : s);
  return neg ? -v : v;
}
function e8ToUsdSigned(v: bigint): string {
  return v < 0n ? `-${e8ToUsd(-v)}` : e8ToUsd(v);
}

import { toFunctionSelector } from "viem";
function selectorOf(fn: string): string {
  const item = (policyVaultAbi as readonly { type: string; name?: string }[]).find((x) => x.type === "function" && x.name === fn)!;
  return toFunctionSelector(item as never).toLowerCase();
}

export { reasonToError, ERROR_RETRYABLE, poolPriceFromSqrtPriceX96, sellAmountForUsdCap };
