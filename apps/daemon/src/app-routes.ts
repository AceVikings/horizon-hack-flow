// Flow desktop v1 routes (additive; ui scope unless noted). Nothing here needs a terminal:
//
//   GET  /trader                → supervised trader state (+ whether an external `ate agent run` is cycling)
//   POST /trader/start          { mode?: "autonomous"|"propose", engine?: "llm"|"rules", model?, cycleSeconds? }
//   POST /trader/stop           → stops the in-daemon runner after its current cycle; vaults stay open (guard exits)
//   GET  /strategy/pending      → every unexpired pending change (Agent → Waiting for you)
//   POST /strategy/reject       { changeId } → drops it (never applied)
//   GET  /proof                 (ui|view) → network, current/last in-app run, recorded rogue runs (journal, decoded
//                                 from the chain), pause/unpause history (vault logs), target addresses
//   POST /proof/run             { market?, waitPauseSec? } → runs the rogue suite in-process (testnet 133 only)
//   POST /proof/stop            → stop after the current attack
//
// The trader runs in-process (TraderRunner + `claude -p` per cycle, or the rules engine) against this daemon's own
// MCP over a stdio proxy with a dedicated agent token, exactly like `ate agent run`. Its wanted state persists in
// <home>/trader.json so a daemon restart resumes it. The proof suite is the same engine as `ate rogue` (./rogue.ts),
// talking to this daemon's /rogue routes with an ephemeral rogue token minted per run (never printed, revoked after).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKETS, MARKET_IDS, policyVaultAbi, type MarketId } from "@ate/core";
import { createPublicClient, http as viemHttp, type Address, type Hex, type PublicClient } from "viem";
import { chatMcpSpec } from "./chat.js";
import { randomBytes } from "node:crypto";
import { configPayload, type ApprovalPayload } from "@ate/approve";
import { DEFAULT_MODEL, type AiConfig, type AiEngine } from "./engine.js";
import { PROVIDERS, PROVIDER_IDS, isProviderId, type ProviderId } from "./providers.js";
import { createSdkTraderExecutor } from "./engine-agents.js";
import type { Routes, TokenRegistry } from "./http.js";
import { EXPECTED, FULL_RUN, decodeRevert, runRogue, type AttackId, type AttackResult } from "./rogue.js";
import type { AteService } from "./service.js";

type Trader = typeof import("@ate/trader");
type Json = (status: number, v: unknown) => void;

export interface AppRoutesOptions {
  routes: Routes;
  tokens: TokenRegistry;
  service: AteService;
  home: string;
  port: number;
  /** deployments/<chainId>.json path (deployedBlock, guardian, owner, explorer). */
  deploymentsPath: string | null;
  /** In-app agent engine shared with the chat routes. */
  ai: AiEngine;
  /** Lane E approval handle (Touch ID verifier + one-time codes) for credential replace/remove. */
  approval?: { tty: { issue(purpose: "config", bindTo: string, label: string): string | null; redeem(purpose: "config", bindTo: string, code: string): { ok: boolean } }; verifier: { verify(p: ApprovalPayload, sig: string): { ok: boolean } } | null } | null;
  log?: (m: string) => void;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const errBody = (code: string, message: string, hint?: string) => ({ error: { code, message, ...(hint ? { hint } : {}) } });

// ------------------------------------------------------------------ trader supervisor

export type TraderMode = "autonomous" | "propose";
export interface TraderState {
  supervised: boolean;
  running: boolean;
  stopping: boolean;
  mode: TraderMode;
  engine: "llm" | "rules";
  model: string;
  /** "sdk" (in-app, Anthropic SDK), "claude-code" (optional CLI fallback) or "rules". */
  runtime: "sdk" | "claude-code" | "rules";
  cycleSeconds: number;
  toolsAllowed: number;
  startedAt: number | null;
  cycles: number;
  lastCycle: { cycle: number; status: string; at: number; latencyMs: number; summary?: string } | null;
  lastError: string | null;
}

interface Wanted {
  wanted: boolean;
  mode: TraderMode;
  engine: "llm" | "rules";
  model?: string;
  cycleSeconds: number;
}

class TraderSupervisor {
  private st: TraderState = { supervised: true, running: false, stopping: false, mode: "autonomous", engine: "llm", model: DEFAULT_MODEL, runtime: "sdk", cycleSeconds: 120, toolsAllowed: 0, startedAt: null, cycles: 0, lastCycle: null, lastError: null };
  private stopFns: (() => void | Promise<void>)[] = [];
  private runner: { idle(): Promise<void>; stopTimer(): void } | null = null;
  private token: string | null = null;
  private readonly file: string;

  constructor(private readonly o: AppRoutesOptions) {
    this.file = join(o.home, "trader.json");
  }

  state(): TraderState & { external: boolean; lastCycleAt: number | null } {
    const s = this.o.service.status();
    const lastCycleAt = s.trader.lastCycleAt;
    return { ...this.st, external: !this.st.running && s.trader.running, lastCycleAt };
  }

  private save(w: Wanted) {
    try {
      writeFileSync(this.file, JSON.stringify(w, null, 2), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  /** Resume a trader the user left running (daemon restart). */
  async resume(): Promise<void> {
    if (!existsSync(this.file)) return;
    try {
      const w = JSON.parse(readFileSync(this.file, "utf8")) as Wanted;
      if (w.wanted) await this.start(w);
    } catch (e) {
      this.o.log?.(`trader resume: ${(e as Error).message}`);
    }
  }

  async start(b: Partial<Wanted>): Promise<void> {
    if (this.st.running) await this.stop(false);
    const mode: TraderMode = b.mode === "propose" ? "propose" : "autonomous";
    const engine = b.engine === "rules" ? "rules" : "llm";
    if (typeof b.model === "string" && b.model && b.model !== this.o.ai.config.model) this.o.ai.setConfig({ model: b.model });
    const model = this.o.ai.config.model;
    const viaCli = engine === "llm" && this.o.ai.config.engine === "claude-code" && this.o.ai.config.provider === "anthropic";
    if (engine === "llm" && !viaCli && !this.o.ai.available()) throw Object.assign(new Error(`${PROVIDERS[this.o.ai.config.provider].label} is not set up: add its API key under Accounts (or run on the rules engine)`), { status: 409, code: "ATE_CONFIG_INVALID" });
    const cycleSeconds = Math.max(30, Math.min(3600, Number(b.cycleSeconds) || 120));
    const name = "@ate/trader";
    const t = (await import(name)) as Trader;
    const dryRun = mode === "propose";
    // the WS subscription for cycle.requested (and the optional Claude Code CLI engine's MCP proxy) use this token
    this.token = this.o.tokens.mint({ scope: "agent", ...(engine === "rules" ? { engine: "rules" as const } : {}) });
    const log = (m: string) => {
      this.o.log?.(`trader: ${m}`);
      try {
        appendFileSync(join(this.o.home, "trader.log"), `[${new Date().toISOString()}] ${m}\n`);
      } catch {
        /* best effort */
      }
    };
    // in-process tools: the agent scope of this daemon, no stdio proxy
    const svc = this.o.service;
    const label = engine === "rules" ? ({ engine: "rules" } as const) : ({ engine: "llm" } as const);
    const inProc = {
      call: async (n: string, a: unknown) => {
        try {
          return await svc.callTool("agent", n, a, label);
        } catch (e) {
          return { ok: false, error: { code: "ATE_INVALID_PARAMS", message: (e as Error).message } };
        }
      },
      close: async () => {},
    } as unknown as Awaited<ReturnType<Trader["connectAte"]>>;
    const getTools = async () => inProc;
    const markets = [...MARKET_IDS];
    const profiles = markets.map((m) => `${MARKETS[m].asset}=${svc.strategy.markets[m]?.profile ?? "default"}`);
    const context = [
      `Profiles: ${profiles.join(", ")}${profiles.some((p) => p.endsWith("=demo")) ? " (demo: rebalance edge gate waived, $5 size; label trades profile=demo, never call them arbitrage)" : ""}.`,
      `Markets enabled for this runner: ${markets.map((m) => MARKETS[m].label).join(", ")}.`,
    ];
    const toolNames = svc.listTools("agent").filter((n) => !(dryRun && n === "ate_execute"));
    const executor =
      engine === "rules"
        ? t.createRulesExecutor(getTools, { markets, dryRun, log })
        : viaCli
          ? t.createClaudeExecutor({ promptFile: t.TRADER_PROMPT_PATH, mcp: chatMcpSpec(this.o.home, this.token), dryRun, context, model, effort: this.o.ai.config.traderEffort === "high" ? "high" : this.o.ai.config.traderEffort, log })
          : createSdkTraderExecutor({ ai: this.o.ai, service: svc, promptFile: t.TRADER_PROMPT_PATH, toolNames, dryRun, context, log });
    const cyclesFile = join(this.o.home, "trader-cycles.jsonl");
    const runner = new t.TraderRunner({
      executor,
      timeoutMs: 90_000,
      log,
      onTimeout: async (cycle) => {
        await t.writeTimeoutRecords(await getTools(), cycle, 90, markets).catch(() => []);
      },
      onRecord: (r) => {
        this.st.cycles++;
        this.st.lastCycle = { cycle: r.cycle, status: r.status, at: Math.floor(r.startedAt / 1000), latencyMs: r.latencyMs, ...(r.summary ? { summary: r.summary.slice(0, 400) } : {}) };
        if (r.status !== "ok") this.st.lastError = r.summary?.slice(0, 300) ?? r.status;
        try {
          appendFileSync(cyclesFile, JSON.stringify({ ...r, engine, dryRun, supervised: true }) + "\n");
        } catch {
          /* best effort */
        }
        this.o.service.o.emit({ type: "trader.cycle", at: nowSec(), data: { cycle: r.cycle, status: r.status } });
      },
    });
    const scan = t.createScanner(getTools);
    const scanTimer = setInterval(() => {
      scan()
        .then((opened) => {
          if (opened.length) log(`scan: entry candidate on ${opened.map((m) => MARKETS[m].label).join(", ")} → ${runner.trigger("scan")}`);
        })
        .catch((e: unknown) => log(`scan failed: ${e instanceof Error ? e.message : String(e)}`));
    }, 20_000);
    const sub = t.subscribeCycleRequests({
      port: this.o.port,
      token: this.token,
      log,
      onRequest: (r) => log(`cycle.requested (${r}) → ${runner.trigger(r === "gap" ? "scan" : r === "strategy_change" ? "strategy_change" : "manual")}`),
    });
    this.stopFns = [() => clearInterval(scanTimer), () => sub.close()];
    this.runner = runner;
    this.st = { ...this.st, running: true, stopping: false, mode, engine, model, runtime: engine === "rules" ? "rules" : viaCli ? "claude-code" : "sdk", cycleSeconds, toolsAllowed: engine === "llm" ? toolNames.length : 0, startedAt: nowSec(), lastError: null };
    runner.startTimer(cycleSeconds * 1000);
    this.save({ wanted: true, mode, engine, model, cycleSeconds });
    log(`started (supervised by the daemon): engine=${engine} mode=${mode} model=${model} cycle=${cycleSeconds}s`);
    this.o.service.o.emit({ type: "trader.state", at: nowSec(), data: { running: true, mode, engine } });
  }

  /** Stop ticking now; the current cycle (≤ 90 s) finishes in the background. */
  async stop(persist = true): Promise<void> {
    const r = this.runner;
    if (persist) this.save({ wanted: false, mode: this.st.mode, engine: this.st.engine, model: this.st.model, cycleSeconds: this.st.cycleSeconds });
    if (!r) return;
    r.stopTimer();
    this.runner = null;
    this.st.running = false;
    this.st.stopping = true;
    const fns = this.stopFns;
    this.stopFns = [];
    const token = this.token;
    this.token = null;
    void r.idle().finally(async () => {
      for (const f of fns) await f();
      if (token) this.o.tokens.revoke(token);
      this.st.stopping = false;
      this.o.service.o.emit({ type: "trader.state", at: nowSec(), data: { running: false } });
    });
  }
}

// ------------------------------------------------------------------ proof (in-app rogue suite)

export interface ProofAttack {
  attack: AttackId;
  expected: string;
  status: "queued" | "running" | AttackResult["status"];
  txHash?: string;
  decoded?: string;
  checkCode?: string;
  note?: string;
  at?: number;
}
export interface ProofRun {
  id: string;
  source: "app" | "journal";
  market: MarketId;
  vault: string;
  agent: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "done" | "stopped" | "failed";
  stopRequested?: boolean;
  attacks: ProofAttack[];
  log: { at: number; text: string }[];
}
export interface PauseEvent {
  vault: string;
  market: MarketId | null;
  kind: "paused" | "unpaused";
  by: string;
  role: "guardian" | "owner" | "agent" | "other";
  txHash: string;
  blockNumber: string;
  at: number | null;
}

const ATTACK_RE = /^\[rogue\] ([a-z_]+):/;

class Proof {
  private run: ProofRun | null = null;
  private decoded = new Map<string, string>();
  private pauses: { at: number; list: PauseEvent[] } | null = null;
  private client: PublicClient | null = null;
  private deployments: { deployedBlock?: number; guardian?: string; owner?: string; explorer?: string } = {};
  private readonly cacheFile: string;

  constructor(private readonly o: AppRoutesOptions) {
    this.cacheFile = join(o.home, "proof-decoded.json");
    try {
      this.decoded = new Map(Object.entries(JSON.parse(readFileSync(this.cacheFile, "utf8")) as Record<string, string>));
    } catch {
      /* empty cache */
    }
    try {
      if (o.deploymentsPath) this.deployments = JSON.parse(readFileSync(o.deploymentsPath, "utf8"));
    } catch {
      /* optional */
    }
  }

  private chainId(): number {
    return this.o.service.cfg.chain.id;
  }
  runnable(): boolean {
    return this.chainId() === 133;
  }
  private pc(): PublicClient {
    return (this.client ??= createPublicClient({ transport: viemHttp(this.o.service.cfg.chain.rpcUrls[0]) }) as PublicClient);
  }
  private vaultFor(m: MarketId): Address | null {
    return (this.o.service.cfg.vaults.find((v) => v.market === m)?.address as Address | undefined) ?? null;
  }

  /** The decoded custom error of a recorded revert: replay its calldata at the parent block. Cached on disk. */
  private async decode(txHash: string): Promise<string | null> {
    const hit = this.decoded.get(txHash);
    if (hit) return hit;
    try {
      const c = this.pc();
      const tx = await c.getTransaction({ hash: txHash as Hex });
      let d: string;
      try {
        await c.call({ account: tx.from, to: tx.to!, data: tx.input, blockNumber: (tx.blockNumber ?? 1n) - 1n });
        d = "succeeded on replay";
      } catch (e) {
        d = decodeRevert(e);
      }
      this.decoded.set(txHash, d);
      writeFileSync(this.cacheFile, JSON.stringify(Object.fromEntries(this.decoded)), { mode: 0o600 });
      return d;
    } catch {
      return null;
    }
  }

  /** Rogue runs recorded in the journal (profile=rogue executions), grouped by ≤ 30 min gaps, newest first. */
  private async recorded(): Promise<ProofRun[]> {
    const ex = this.o.service.journal
      .list({ kind: ["execution"], limit: 500 })
      .filter((e) => e.profile === "rogue")
      .reverse();
    const runs: ProofRun[] = [];
    let cur: ProofRun | null = null;
    for (const e of ex) {
      const attack = (ATTACK_RE.exec(e.rationale)?.[1] ?? "unknown") as AttackId;
      const x = (e as { execution?: { txHash?: string; reverted?: boolean } }).execution;
      const market = ((e as { market?: MarketId }).market ?? "hsk-dex:WHSK/USDT:3000") as MarketId;
      if (!cur || e.at - (cur.finishedAt ?? cur.startedAt) > 1800 || cur.market !== market) {
        cur = { id: `journal_${e.id}`, source: "journal", market, vault: this.vaultFor(market) ?? "", agent: "", startedAt: e.at, finishedAt: e.at, status: "done", attacks: [], log: [] };
        runs.push(cur);
      }
      cur.finishedAt = e.at;
      // a re-run of the same attack in one window replaces the earlier row
      cur.attacks = cur.attacks.filter((a) => a.attack !== attack);
      cur.attacks.push({ attack, expected: EXPECTED[attack] ?? String(e.verdict.code), status: x?.reverted ? "reverted" : "unexpected", ...(x?.txHash ? { txHash: x.txHash } : {}), at: e.at });
    }
    runs.reverse();
    const latest = runs[0];
    if (latest) {
      latest.attacks.sort((a, b) => FULL_RUN.indexOf(a.attack) - FULL_RUN.indexOf(b.attack));
      await Promise.all(latest.attacks.map(async (a) => a.txHash && !a.decoded && (a.decoded = (await this.decode(a.txHash)) ?? undefined)));
    }
    return runs.slice(0, 10);
  }

  /** Paused / Unpaused logs on both vaults since deployment (cached 60 s). */
  private async pauseHistory(): Promise<PauseEvent[]> {
    if (this.pauses && nowSec() - this.pauses.at < 60) return this.pauses.list;
    const vaults = this.o.service.cfg.vaults;
    if (!vaults.length) return [];
    try {
      const c = this.pc();
      const head = await c.getBlockNumber();
      const from = this.deployments.deployedBlock ? BigInt(this.deployments.deployedBlock) : head > 500_000n ? head - 500_000n : 0n;
      const ev = policyVaultAbi.filter((x) => x.type === "event" && (x.name === "Paused" || x.name === "Unpaused"));
      const logs = await c.getLogs({ address: vaults.map((v) => v.address as Address), events: ev as never, fromBlock: from, toBlock: head });
      const roles = new Map<string, "guardian" | "owner" | "agent">();
      for (const v of vaults) {
        for (const fn of ["guardian", "owner", "agent"] as const) {
          const a = (await c.readContract({ address: v.address as Address, abi: policyVaultAbi as never, functionName: fn as never }).catch(() => null)) as string | null;
          if (a) roles.set(a.toLowerCase(), fn);
        }
      }
      const times = new Map<bigint, number>();
      const list: PauseEvent[] = [];
      for (const l of logs as unknown as { address: string; eventName: string; args: { by: string }; transactionHash: string; blockNumber: bigint }[]) {
        if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await c.getBlock({ blockNumber: l.blockNumber }).catch(() => ({ timestamp: 0n }))).timestamp));
        const market = (vaults.find((v) => v.address.toLowerCase() === l.address.toLowerCase())?.market ?? null) as MarketId | null;
        list.push({ vault: l.address, market, kind: l.eventName === "Paused" ? "paused" : "unpaused", by: l.args.by, role: roles.get(l.args.by.toLowerCase()) ?? "other", txHash: l.transactionHash, blockNumber: l.blockNumber.toString(), at: times.get(l.blockNumber) || null });
      }
      list.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)));
      this.pauses = { at: nowSec(), list };
      return list;
    } catch (e) {
      this.o.log?.(`proof: pause history: ${(e as Error).message.split("\n")[0]}`);
      return this.pauses?.list ?? [];
    }
  }

  async get(): Promise<unknown> {
    const s = this.o.service.status();
    const [recorded, pauses] = await Promise.all([this.recorded(), this.pauseHistory()]);
    const hsk = this.vaultFor("hsk-dex:WHSK/USDT:3000");
    const paused = Object.fromEntries(s.vaults.map((v) => [v.market, v.paused]));
    return {
      chainId: this.chainId(),
      runnable: this.runnable(),
      explorer: this.deployments.explorer ?? (this.chainId() === 133 ? "https://testnet-explorer.hskchain.net" : "https://hsk.blockscout.com"),
      target: { vault: hsk, market: "hsk-dex:WHSK/USDT:3000", agent: this.o.service.o.signer?.address ?? this.deployments.guardian ?? null, guardian: this.deployments.guardian ?? null, owner: this.deployments.owner ?? null },
      paused,
      run: this.run,
      recorded,
      pauses,
    };
  }

  start(b: { market?: string; waitPauseSec?: number }): ProofRun {
    if (!this.runnable()) throw Object.assign(new Error("The attack suite only runs on testnet (chain 133). Mainnet is view-only."), { status: 403, code: "ATE_TOOL_NOT_ALLOWED" });
    if (this.run?.status === "running") throw Object.assign(new Error("a suite is already running"), { status: 409, code: "ATE_STRATEGY_BLOCKED" });
    if (this.o.service.o.signer && !this.o.service.o.signer.unlocked) throw Object.assign(new Error("the agent key is locked: unlock the daemon first"), { status: 409, code: "ATE_DAEMON_LOCKED" });
    const market: MarketId = b.market === "hsk-dex:WBTC/USDT:3000" || b.market === "WBTC" ? "hsk-dex:WBTC/USDT:3000" : "hsk-dex:WHSK/USDT:3000";
    const vault = this.vaultFor(market);
    if (!vault) throw Object.assign(new Error(`no vault configured for ${market}`), { status: 400, code: "ATE_CONFIG_INVALID" });
    const waitPauseSec = Math.max(0, Math.min(900, Number(b.waitPauseSec ?? 240)));
    const run: ProofRun = {
      id: `run_${Date.now().toString(36)}`,
      source: "app",
      market,
      vault,
      agent: this.o.service.o.signer?.address ?? "",
      startedAt: nowSec(),
      finishedAt: null,
      status: "running",
      attacks: FULL_RUN.map((attack) => ({ attack, expected: EXPECTED[attack], status: "queued" as const })),
      log: [],
    };
    this.run = run;
    const token = this.o.tokens.mint({ scope: "rogue", expiresAt: nowSec() + 3600 });
    const push = (text: string) => {
      run.log.push({ at: nowSec(), text });
      if (run.log.length > 400) run.log.shift();
    };
    const emit = () => this.o.service.o.emit({ type: "proof.progress", at: nowSec(), data: { id: run.id, status: run.status, done: run.attacks.filter((a) => a.status !== "queued" && a.status !== "running").length } });
    void runRogue({
      market,
      attacks: FULL_RUN,
      stage: false,
      daemonUrl: `http://127.0.0.1:${this.o.port}`,
      rogueToken: token,
      rpcUrl: this.o.service.cfg.chain.rpcUrls[0]!,
      vault: vault as Address,
      gas: 800_000n,
      waitPauseSec,
      dryRun: false,
      log: (s) => push(s.trim()),
      shouldStop: () => !!run.stopRequested,
      onProgress: (e) => {
        const row = run.attacks[e.index]!;
        if (e.type === "start") {
          row.status = "running";
          row.at = nowSec();
          if (e.attack === "paused") push(`[7] waiting up to ${waitPauseSec}s for the guardian pause() (sign it on the guardian device)`);
        } else {
          Object.assign(row, { status: e.result.status, at: nowSec(), ...(e.result.txHash ? { txHash: e.result.txHash } : {}), ...(e.result.decoded ? { decoded: e.result.decoded } : {}), ...(e.result.checkCode ? { checkCode: e.result.checkCode } : {}), ...(e.result.note ? { note: e.result.note } : {}) });
        }
        emit();
      },
    })
      .then(() => {
        run.status = run.stopRequested ? "stopped" : "done";
      })
      .catch((e: Error) => {
        run.status = "failed";
        push(`suite failed: ${e.message.split("\n")[0]}`);
      })
      .finally(() => {
        run.finishedAt = nowSec();
        for (const a of run.attacks) if (a.status === "queued" || a.status === "running") a.status = "skipped";
        this.o.tokens.revoke(token);
        this.pauses = null;
        emit();
      });
    push(`suite start · vault ${vault} · key ${run.agent}`);
    emit();
    return run;
  }

  stop(): ProofRun | null {
    if (this.run?.status === "running") this.run.stopRequested = true;
    return this.run;
  }
}

// ------------------------------------------------------------------ registration

export function registerAppRoutes(o: AppRoutesOptions): { trader: TraderSupervisor } {
  const trader = new TraderSupervisor(o);
  const proof = new Proof(o);
  const r = o.routes;
  const guard = async (json: Json, f: () => unknown) => {
    try {
      json(200, await f());
    } catch (e) {
      const x = e as { status?: number; code?: string; message: string };
      json(x.status ?? 400, errBody(x.code ?? "ATE_INTERNAL", x.message));
    }
  };

  r.register({ method: "GET", path: "/trader", scopes: ["ui", "view"], handler: ({ json }) => json(200, trader.state()) });
  r.register({
    method: "POST",
    path: "/trader/start",
    scopes: ["ui"],
    handler: ({ body, json }) =>
      guard(json, async () => {
        await trader.start((body ?? {}) as Partial<Wanted>);
        return trader.state();
      }),
  });
  r.register({
    method: "POST",
    path: "/trader/stop",
    scopes: ["ui"],
    handler: ({ json }) =>
      guard(json, async () => {
        await trader.stop();
        return trader.state();
      }),
  });

  // ---- in-app agent engine (Anthropic SDK): health, credentials, model (D2 Setup/Settings call these too)
  const ai = o.ai;
  r.register({ method: "GET", path: "/ai", scopes: ["ui", "view"], handler: ({ json }) => json(200, ai.health()) });
  r.register({ method: "POST", path: "/ai/check", scopes: ["ui"], handler: ({ json }) => guard(json, () => ai.check()) });
  r.register({
    method: "POST",
    path: "/ai/key",
    scopes: ["ui"],
    handler: ({ body, json }) =>
      guard(json, () => {
        // first key only; replacing a stored key goes through /engine/providers/<id>/credential (Touch ID)
        if (ai.credentialOf(ai.config.provider).stored) throw Object.assign(new Error("A key is already stored: replace it under Accounts (Touch ID)"), { status: 409, code: "ATE_APPROVAL_REQUIRED" });
        return ai.setKey(String((body as { apiKey?: unknown })?.apiKey ?? ""));
      }),
  });
  r.register({
    method: "POST",
    path: "/ai/config",
    scopes: ["ui"],
    handler: ({ body, json }) =>
      guard(json, async () => {
        const before = ai.config;
        ai.setConfig((body ?? {}) as Partial<AiConfig>);
        await restartIfChanged(before);
        return ai.health();
      }),
  });

  // ---- providers (D2's Accounts page): list, credential set/replace/remove (Touch ID for replace/remove), test, select
  const restartIfChanged = async (before: AiConfig) => {
    // a running LLM trader picks up a new provider / model / engine on restart
    const st = trader.state();
    if (st.running && st.engine === "llm" && (before.provider !== ai.config.provider || before.model !== ai.config.model || before.engine !== ai.config.engine)) await trader.start({ mode: st.mode, engine: "llm", cycleSeconds: st.cycleSeconds });
  };
  r.register({ method: "GET", path: "/engine/providers", scopes: ["ui", "view"], handler: ({ json }) => json(200, { selected: { provider: ai.config.provider, model: ai.config.model, engine: ai.config.engine }, providers: ai.providers() }) });
  r.register({
    method: "POST",
    path: "/engine/select",
    scopes: ["ui"],
    handler: ({ body, json }) =>
      guard(json, async () => {
        const b = (body ?? {}) as { provider?: unknown; model?: unknown; engine?: unknown };
        if (!isProviderId(b.provider)) throw Object.assign(new Error("unknown provider"), { status: 400, code: "ATE_CONFIG_INVALID" });
        const before = ai.config;
        ai.setConfig({ provider: b.provider, ...(typeof b.model === "string" ? { model: b.model } : {}), ...(b.engine === "sdk" || b.engine === "claude-code" ? { engine: b.engine } : {}) });
        await restartIfChanged(before);
        return { selected: { provider: ai.config.provider, model: ai.config.model, engine: ai.config.engine }, providers: ai.providers() };
      }),
  });
  const pendingCred = new Map<string, { id: ProviderId; action: "set" | "remove"; key: string | null; expiresAt: number; payload: ApprovalPayload }>();
  for (const id of PROVIDER_IDS) {
    r.register({ method: "POST", path: `/engine/providers/${id}/test`, scopes: ["ui"], handler: ({ json }) => guard(json, () => ai.test(id)) });
    r.register({
      method: "POST",
      path: `/engine/providers/${id}/credential`,
      scopes: ["ui"],
      handler: ({ body, json }) =>
        guard(json, async () => {
          const b = (body ?? {}) as { action?: string; apiKey?: string; baseURL?: string; protocol?: "openai" | "anthropic"; nonce?: string; approval?: string };
          const t = nowSec();
          const apply = async (action: "set" | "remove", key: string | null) => {
            if (action === "remove") ai.clearKey(id);
            else if (key) await ai.setKey(key, id);
            o.log?.(`engine: ${PROVIDERS[id].label} credential ${action === "remove" ? "removed" : "stored"}`);
            return { saved: true, provider: ai.providers().find((p) => p.id === id) };
          };
          // step 2: Touch ID signature over the config payload, or the daemon's one-time code
          if (b.nonce) {
            const p = pendingCred.get(b.nonce);
            pendingCred.delete(b.nonce);
            if (!p || p.id !== id || p.expiresAt < t) throw Object.assign(new Error("unknown or expired nonce"), { status: 401, code: "ATE_APPROVAL_REQUIRED" });
            const a = String(b.approval ?? "");
            const ok = /^[0-9]{8}$/.test(a) ? o.approval?.tty.redeem("config", b.nonce, a).ok : o.approval?.verifier?.verify(p.payload, a).ok;
            if (!ok) throw Object.assign(new Error("approval rejected"), { status: 401, code: "ATE_APPROVAL_REQUIRED" });
            return apply(p.action, p.key);
          }
          // non-secret settings (base URL, proxy protocol) need no approval
          if (b.baseURL !== undefined || b.protocol !== undefined) ai.setProviderSettings(id, { ...(b.baseURL !== undefined ? { baseURL: String(b.baseURL) } : {}), ...(b.protocol ? { protocol: b.protocol } : {}) });
          const action = b.action === "remove" ? "remove" : b.action === "set" ? "set" : null;
          if (!action) return { saved: true, provider: ai.providers().find((p) => p.id === id) };
          const key = action === "set" ? String(b.apiKey ?? "").trim() : null;
          if (action === "set" && !key) throw Object.assign(new Error("apiKey required"), { status: 400, code: "ATE_CONFIG_INVALID" });
          const cur = ai.credentialOf(id);
          // the first key needs only the attached ui token; replacing or removing a stored key needs Touch ID
          if (action === "set" && !cur.stored) return apply("set", key);
          if (action === "remove" && !cur.stored) return { saved: true, provider: ai.providers().find((p) => p.id === id) };
          const nonce = randomBytes(16).toString("hex");
          const expiresAt = t + 60;
          const payload = configPayload({ nonce, expiresAt, changes: [{ key: `engine.${id}.apiKey`, before: `stored ${cur.hint ?? ""}`.trim(), after: action === "remove" ? "none" : `…${key!.slice(-4)}` }] });
          pendingCred.set(nonce, { id, action, key, expiresAt, payload });
          const code = o.approval?.tty.issue("config", nonce, `${PROVIDERS[id].label} API key ${action === "remove" ? "removal" : "replacement"}`) ?? null;
          return { nonce, expiresAt, payload, codeIssued: !!code };
        }),
    });
  }

  r.register({ method: "GET", path: "/strategy/pending", scopes: ["ui", "session"], handler: ({ json }) => json(200, { pending: o.service.listPendingChanges() }) });
  r.register({
    method: "POST",
    path: "/strategy/reject",
    scopes: ["ui", "session"],
    handler: ({ body, json }) => {
      const id = (body as { changeId?: unknown })?.changeId;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return json(400, errBody("ATE_APPROVAL_REQUIRED", "changeId required"));
      return json(200, { rejected: o.service.rejectPendingChange(id), changeId: id });
    },
  });

  r.register({ method: "GET", path: "/proof", scopes: ["ui", "view"], handler: ({ json }) => guard(json, () => proof.get()) });
  r.register({ method: "POST", path: "/proof/run", scopes: ["ui"], handler: ({ body, json }) => guard(json, () => proof.start((body ?? {}) as { market?: string; waitPauseSec?: number })) });
  r.register({ method: "POST", path: "/proof/stop", scopes: ["ui"], handler: ({ json }) => guard(json, () => ({ run: proof.stop() })) });

  return { trader };
}
