// The web bridge's server side: the same allowlisted methods Electron main serves over IPC (shared/bridge.ts
// IPC_METHODS, shared/setup-bridge.ts SETUP_IPC, the owner bridge), executed against the daemon with the gateway's ui
// token. The maps are typed Record<…> over those lists, so a method another lane adds fails the cloud typecheck until
// it is wired here. Touch ID becomes a passkey: daemon approval payloads are signed by the gateway's P-256 approval
// key only after a passkey assertion over sha256(payload); owner approvals go to the owner service as the assertion
// itself (the owner service verifies it).
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { MARKET_IDS, type DaemonEvent, type MarketId, type StrategyApprovalPending } from "@ate/core";
import { decodePayload, payloadBytes, renderReason, strategyPayload, tradePayload, writePinnedKey, type ApprovalPayload, type TradeApprovalBody } from "@ate/approve";
import type { DaemonClient } from "../../desktop/src/main/daemon";
import type { ChatMessage, IpcMethod, JournalFilter, Res, Settings } from "../../desktop/src/shared/bridge";
import { APPROVAL_RE, SETUP_GET_RE, SETUP_POST_RE, type DaemonState, type SetupIpc } from "../../desktop/src/shared/setup-bridge";
import type { Auth } from "./auth.js";
import type { RunCtx } from "./runs.js";
import type { DaemonProcess, OwnerProcess } from "./supervisor.js";

const bad = (message: string, code = "ATE_INTERNAL"): Res<never> => ({ ok: false, error: { code: code as never, message } });
const PROVIDER_ID = /^(anthropic|openai|gemini|openrouter|ollama|proxy|subscription)$/;

/** In-memory P-256 approval key; its public half is pinned for the daemon at every boot. */
export class GatewayApprovalKey {
  private readonly key: KeyObject;
  readonly publicKeyHex: string;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.publicKeyHex = `04${Buffer.from(jwk.x, "base64url").toString("hex")}${Buffer.from(jwk.y, "base64url").toString("hex")}`;
  }
  pin(path: string) {
    writePinnedKey(this.publicKeyHex, path);
  }
  sign(p: ApprovalPayload): string {
    return sign("sha256", payloadBytes(p), { key: this.key, dsaEncoding: "der" }).toString("base64");
  }
}

export type OwnerOut = { done?: boolean; txs?: { label: string; hash: string }[]; result?: { vaults?: { market: string; address: string }[] }; needsApproval?: boolean; nonce?: string; challenge?: string; prompt?: string; error?: string };

export class CloudBridge {
  readonly chatLog = new Map<string, ChatMessage[]>();
  private pending = new Map<string, StrategyApprovalPending>();
  private settings: Settings = { rpcUrls: [], unlockTimeoutMin: 30, daemonPort: null };
  status: { key?: { exists: boolean; unlocked: boolean; address: string | null }; state?: { step: number; completedAt: number | null } } | null = null;

  constructor(
    private readonly d: { daemon: DaemonClient; proc: DaemonProcess; owner: OwnerProcess; auth: Auth; approvalKey: GatewayApprovalKey; restartDaemon: () => Promise<void>; chainId: () => number; guardian?: () => string | undefined },
  ) {}

  // ---------------------------------------------------------------- events (same chat bookkeeping as main)
  onEvent(e: DaemonEvent): void {
    if (e.type === "chat.delta") {
      if ((e.data as { role?: string }).role === "user") return;
      const log = this.chatLog.get(e.data.sessionId) ?? [];
      const last = log[log.length - 1];
      if (last && last.role === "agent" && last.turnId === e.data.turnId) last.text += e.data.text;
      else {
        const engine = (e.data as { engine?: string }).engine;
        log.push({ id: `${e.data.turnId}:a`, role: "agent", text: e.data.text, at: e.at, turnId: e.data.turnId, ...(engine ? { engine } : {}) });
      }
      this.chatLog.set(e.data.sessionId, log);
    } else if (e.type === "chat.tool") {
      if ((e.data as { summary?: boolean }).summary) return;
      const r = e.data.result as { error?: { code?: string; details?: unknown } } | undefined;
      if (r?.error?.code === "ATE_APPROVAL_REQUIRED") this.remember(r.error.details);
      const log = this.chatLog.get(e.data.sessionId) ?? [];
      log.push({ id: `${e.data.turnId}:${log.length}`, role: "tool", text: e.data.tool, at: e.at, turnId: e.data.turnId, tool: { name: e.data.tool, args: e.data.args, result: e.data.result, decisionId: e.data.decisionId } });
      this.chatLog.set(e.data.sessionId, log);
    }
  }

  private remember(x: unknown) {
    const p = x as StrategyApprovalPending;
    if (p && typeof p.changeId === "string" && Array.isArray(p.diff) && typeof p.expiresAt === "number") this.pending.set(p.changeId, p);
  }

  /** Passkey → gateway approval signature over exactly `payload`. */
  private async approve(ctx: RunCtx, payload: ApprovalPayload): Promise<string> {
    if (!this.d.auth.passkeys().length) throw Object.assign(new Error("Add a passkey first (Settings → Sign-in): approvals in the cloud use your passkey"), { code: "ATE_APPROVAL_REQUIRED" });
    const challenge = createHash("sha256").update(payloadBytes(payload)).digest("base64url");
    const a = await ctx.passkey({ challenge, prompt: renderReason(payload) });
    if (!(await this.d.auth.verifyAssertion(a, challenge))) throw Object.assign(new Error("the passkey did not verify"), { code: "ATE_APPROVAL_REQUIRED" });
    return this.d.approvalKey.sign(payload);
  }

  // ---------------------------------------------------------------- owner (FREEZE-NOTES CLOUD.3)
  private async ownerOp(ctx: RunCtx, body: Record<string, unknown>): Promise<Res<OwnerOut>> {
    let r = await this.d.owner.call<OwnerOut>("POST", "/owner/op", body);
    if (r.status === 428 && r.body.nonce && r.body.challenge) {
      const a = await ctx.passkey({ challenge: r.body.challenge, prompt: r.body.prompt ?? "Owner action" });
      r = await this.d.owner.call<OwnerOut>("POST", "/owner/op", { nonce: r.body.nonce, approval: { webauthn: a } });
    }
    if (r.status !== 200) return bad(r.body.error ?? `owner service HTTP ${r.status}`, r.status === 403 || r.status === 428 ? "ATE_APPROVAL_REQUIRED" : "ATE_INTERNAL");
    return { ok: true, data: r.body };
  }

  private async configVaults(): Promise<string[]> {
    const r = await this.d.daemon.call<{ vaults: { market: string; address: string }[] }>("GET", "/setup/status");
    return r.ok ? r.data.vaults.map((v) => v.address) : [];
  }

  readonly owner = {
    status: async () => {
      const r = await this.d.owner.call<{ owner?: string; chainId?: number; error?: string }>("GET", "/owner/state");
      return r.status === 200 ? { ok: true, data: { ready: true, address: r.body.owner ?? null, chainId: r.body.chainId ?? this.d.chainId(), ...r.body } } : { ok: true, data: { ready: false, address: this.d.owner.address, chainId: this.d.chainId(), error: r.body.error } };
    },
    createVaults: async (ctx: RunCtx, o?: { markets?: string[] }) => {
      const ag = await this.d.daemon.call<{ address: string | null }>("GET", "/setup/agent");
      if (!ag.ok || !ag.data.address) return bad("the agent key is not ready yet");
      const markets = (o?.markets ?? ["hsk", "btc"]).map((m) => (/btc/i.test(m) ? "btc" : "hsk"));
      const guardian = this.d.guardian?.();
      const r = await this.ownerOp(ctx, { op: "deploy", markets: [...new Set(markets)], agent: ag.data.address, ...(guardian ? { guardian } : {}), seed: this.d.chainId() === 133 });
      if (!r.ok) return r;
      const vaults = r.data.result?.vaults ?? [];
      const sv = await this.d.daemon.call<{ restart?: boolean }>("POST", "/setup/vaults", { source: "deploy", vaults: vaults.map((v) => ({ market: v.market, address: v.address })) });
      if (sv.ok && sv.data.restart) await this.d.restartDaemon();
      return { ok: true, data: { txs: (r.data.txs ?? []).map((t) => t.hash), vaults } };
    },
    setAgent: async (ctx: RunCtx, agent: string) => this.txs(await this.ownerOp(ctx, { op: "setAgent", agent: String(agent), vaults: await this.configVaults() })),
    setLimits: async (ctx: RunCtx, limits: unknown, _o?: { markets?: string[] }) => this.txs(await this.ownerOp(ctx, { op: "setLimits", limits, vaults: await this.configVaults() })),
    unpause: async (ctx: RunCtx, _market?: string) => this.txs(await this.ownerOp(ctx, { op: "unpause", vaults: await this.configVaults() })),
  };
  private txs(r: Res<OwnerOut>): Res<{ txs: string[] }> {
    return r.ok ? { ok: true, data: { txs: (r.data.txs ?? []).map((t) => t.hash) } } : r;
  }

  // ---------------------------------------------------------------- setup (D2) in the cloud
  private async refreshStatus() {
    const r = await this.d.daemon.call<NonNullable<CloudBridge["status"]>>("GET", "/setup/status");
    if (r.ok) this.status = r.data;
  }
  private state(): DaemonState {
    const conn = this.d.daemon.connection();
    return {
      phase: conn.mode === "live" ? "ready" : this.d.proc.exited ? "error" : "starting",
      owned: true,
      home: "cloud",
      pid: this.d.proc.child?.pid ?? null,
      port: null,
      detail: conn.mode === "live" ? "" : (conn.detail ?? ""),
      touchId: { approve: true, unlock: false },
      code: null,
      agent: this.status?.key ? { ...this.status.key, sealed: true } : null,
      setupStep: this.status?.state?.step ?? null,
      setupDone: !!this.status?.state?.completedAt,
    };
  }
  private async passthrough(method: "GET" | "POST", path: string, body?: unknown) {
    const r = await this.d.daemon.call<Record<string, unknown>>(method, path, body);
    if (r.ok && r.data && (r.data as { restart?: boolean }).restart) await this.d.restartDaemon();
    if (r.ok && path.startsWith("/setup/state")) await this.refreshStatus();
    return r;
  }

  readonly setup: Record<SetupIpc, (ctx: RunCtx, ...a: any[]) => Promise<unknown>> = {
    "setup.daemon": async () => {
      if (this.d.daemon.connection().mode === "live") await this.refreshStatus().catch(() => undefined);
      return this.state();
    },
    "setup.start": async () => this.state(),
    "setup.stop": async () => this.state(),
    "setup.submitCode": async () => bad("not used in the cloud"),
    "setup.unlock": async () => ({ ok: true, data: this.state() }),
    "setup.get": async (_c, path: string, query?: Record<string, string>) => {
      if (!SETUP_GET_RE.test(String(path))) return bad("path not allowed");
      const q = query && typeof query === "object" ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [String(k), String(v)]))}` : "";
      return this.d.daemon.call("GET", path + q);
    },
    "setup.post": async (_c, path: string, body: unknown) => (SETUP_POST_RE.test(String(path)) ? this.passthrough("POST", path, body) : bad("path not allowed")),
    "setup.keygen": async () => bad("the cloud agent key comes from the service's sealed secret"),
    "setup.approveStart": async (ctx, path: string, body: unknown) => {
      if (!APPROVAL_RE.test(String(path))) return bad("path not allowed");
      const r1 = await this.d.daemon.call<{ nonce?: string; expiresAt?: number; payload?: ApprovalPayload; saved?: boolean }>("POST", path, body);
      if (!r1.ok) return r1;
      if (r1.data.saved || !r1.data.nonce || !r1.data.payload) return { ok: true, data: { nonce: "", expiresAt: 0, applied: true, result: r1.data } };
      const sig = await this.approve(ctx, r1.data.payload);
      const r2 = await this.passthrough("POST", path, { nonce: r1.data.nonce, approval: sig });
      return r2.ok ? { ok: true, data: { nonce: r1.data.nonce, expiresAt: r1.data.expiresAt, applied: true, result: r2.data } } : r2;
    },
    "setup.approveFinish": async () => bad("the cloud approves with a passkey"),
    "setup.open": async () => undefined,
    "setup.saveJson": async () => bad("download is handled by the browser"),
    "setup.proxy": async () => bad("the local proxy is a desktop feature"),
    "setup.strategyCode": async () => null,
    "setup.proxyCli": async () => bad("the local proxy is a desktop feature"),
    // The passkey prompt comes from the owner call itself, bound to the exact change (FREEZE-NOTES CLOUD.3).
    "setup.confirmRisk": async () => ({ ok: true, data: { method: "passkey" } }),
  };

  // ---------------------------------------------------------------- the frozen bridge (+ additive lanes)
  readonly ipc: Record<IpcMethod, (ctx: RunCtx, a?: any, b?: any) => Promise<unknown>> = {
    connection: async () => ({ ...this.d.daemon.connection(), port: undefined }),
    "markets.list": async () => {
      const r = await this.d.daemon.tool("ate_market_get", {});
      return r.ok ? { ok: true, data: r.data.markets } : r;
    },
    "markets.get": async (_c, a) => {
      if (!(MARKET_IDS as readonly string[]).includes(a)) return bad("unknown market");
      const r = await this.d.daemon.tool("ate_market_get", { market: a as MarketId });
      return r.ok ? (r.data.markets[0] ? { ok: true, data: r.data.markets[0] } : bad("no market")) : r;
    },
    "quote.get": async (_c, a) => this.d.daemon.tool("ate_quote", a),
    "trade.propose": async (_c, a) => this.d.daemon.tool("ate_propose", a),
    "trade.execute": async (_c, a) => this.d.daemon.tool("ate_execute", { proposalId: String(a) }),
    "trade.approve": async (ctx, a) => {
      const s1 = await this.d.daemon.call<{ nonce: string; expiresAt: number; body: TradeApprovalBody }>("POST", "/trade/approve", { proposalId: String(a) });
      if (!s1.ok) return s1;
      const sig = await this.approve(ctx, tradePayload({ nonce: s1.data.nonce, expiresAt: s1.data.expiresAt, ...s1.data.body }));
      const s2 = await this.d.daemon.call("POST", "/trade/approve", { proposalId: String(a), nonce: s1.data.nonce, approval: sig });
      return s2.ok ? { ok: true, data: { approved: true } } : s2;
    },
    "vaults.status": async () => {
      const [st, pos] = await Promise.all([this.d.daemon.status().then((d) => ({ ok: true as const, d })).catch((e: Error) => ({ ok: false as const, e })), this.d.daemon.tool("ate_positions", {})]);
      if (!st.ok) return bad(st.e.message);
      if (!pos.ok) return pos;
      return { ok: true, data: { status: st.d, positions: pos.data } };
    },
    "vaults.pause": async () => this.d.daemon.tool("ate_pause", { rationale: "Pause-all from the web app" }),
    "strategy.get": async () => this.d.daemon.tool("ate_strategy_get", {}),
    "strategy.set": async (_c, a, b) => {
      const r = await this.d.daemon.tool("ate_strategy_set", { patch: a, rationale: String(b ?? "web app").padEnd(16, ".") });
      if (!r.ok && r.error.code === "ATE_APPROVAL_REQUIRED") this.remember(r.error.details);
      return r;
    },
    "strategy.approve": async (ctx, a) => {
      const changeId = String(a);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(changeId)) return bad("bad changeId", "ATE_APPROVAL_REQUIRED");
      let p = this.pending.get(changeId);
      if (!p) {
        const r = await this.d.daemon.call<StrategyApprovalPending>("GET", `/strategy/pending/${encodeURIComponent(changeId)}`);
        if (r.ok) this.remember(r.data);
        p = this.pending.get(changeId);
      }
      if (!p) return bad("this change is no longer pending", "ATE_APPROVAL_REQUIRED");
      const sig = await this.approve(ctx, strategyPayload(p));
      const r = await this.d.daemon.call("POST", "/strategy/approve", { changeId, approval: sig });
      if (r.ok) this.pending.delete(changeId);
      return r;
    },
    "journal.list": async (_c, a) => {
      const f = (a ?? {}) as JournalFilter;
      return this.d.daemon.tool("ate_journal_read", { limit: Math.min(f.limit ?? 100, 200), ...(f.market ? { market: f.market } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(f.before ? { before: f.before } : {}) });
    },
    "journal.get": async (_c, a) => this.d.daemon.tool("ate_journal_read", { id: String(a) }).then((r) => (r.ok ? (r.data.entries[0] ? { ok: true, data: r.data.entries[0] } : bad("not found")) : r)),
    "chat.send": async (_c, a, b) => {
      const sessionId = String(a).slice(0, 80);
      const text = String(b ?? "").slice(0, 4000);
      const log = this.chatLog.get(sessionId) ?? [];
      log.push({ id: `u${Date.now()}`, role: "user", text, at: Math.floor(Date.now() / 1000) });
      this.chatLog.set(sessionId, log);
      try {
        const r = await this.d.daemon.chat({ sessionId, text });
        return { ok: true, data: { turnId: r.turnId } };
      } catch (e) {
        return bad((e as Error).message);
      }
    },
    "chat.history": async (_c, a) => ({ ok: true, data: this.chatLog.get(String(a)) ?? [] }),
    "payments.list": async () => ({ ok: true, data: { gate: "no-go", rows: [] } }),
    "payments.approve": async () => bad("payments run on the desktop app", "ATE_PAYMENT_UNAVAILABLE"),
    "payments.deny": async () => bad("payments run on the desktop app", "ATE_PAYMENT_UNAVAILABLE"),
    "settings.get": async () => ({ ok: true, data: this.settings }),
    "settings.set": async (_c, a) => {
      if (a && "rpcUrls" in a) return bad("RPC changes are made in Settings with approval");
      this.settings = { ...this.settings, ...(typeof a?.unlockTimeoutMin === "number" ? { unlockTimeoutMin: a.unlockTimeoutMin } : {}) };
      return { ok: true, data: this.settings };
    },
    "trader.status": async () => this.d.daemon.call("GET", "/trader"),
    "trader.start": async (_c, a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      return this.d.daemon.call("POST", "/trader/start", {
        mode: o.mode === "propose" ? "propose" : "autonomous",
        engine: o.engine === "rules" ? "rules" : "llm",
        ...(typeof o.model === "string" ? { model: o.model } : {}),
        ...(typeof o.cycleSeconds === "number" ? { cycleSeconds: o.cycleSeconds } : {}),
      });
    },
    "trader.stop": async () => this.d.daemon.call("POST", "/trader/stop", {}),
    "approvals.list": async () => {
      const r = await this.d.daemon.call<{ pending: unknown[] }>("GET", "/strategy/pending");
      if (!r.ok) return r;
      for (const p of r.data.pending) this.remember(p);
      return { ok: true, data: r.data.pending };
    },
    "approvals.confirm": async (_c, a) => this.d.daemon.call("POST", "/strategy/confirm", { changeId: String(a) }),
    "approvals.reject": async (_c, a) => this.d.daemon.call("POST", "/strategy/reject", { changeId: String(a) }),
    "proof.get": async () => this.d.daemon.call("GET", "/proof"),
    "proof.run": async (_c, a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      return this.d.daemon.call("POST", "/proof/run", { ...(typeof o.market === "string" ? { market: o.market } : {}), ...(typeof o.waitPauseSec === "number" ? { waitPauseSec: o.waitPauseSec } : {}) });
    },
    "proof.stop": async () => this.d.daemon.call("POST", "/proof/stop", {}),
    "ai.health": async () => this.d.daemon.call("GET", "/ai"),
    "ai.check": async () => this.d.daemon.call("POST", "/ai/check", {}),
    "ai.setKey": async (_c, a) => (typeof a === "string" && a.length < 400 ? this.d.daemon.call("POST", "/ai/key", { apiKey: a }) : bad("expected an API key string")),
    "ai.clearKey": async () => this.d.daemon.call("POST", "/ai/key/clear", {}),
    "ai.config": async (_c, a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const pick = (k: string) => (typeof o[k] === "string" ? { [k]: o[k] } : {});
      return this.d.daemon.call("POST", "/ai/config", { ...pick("model"), ...pick("engine"), ...pick("traderEffort"), ...pick("chatEffort") });
    },
    "subscription.status": async () => this.d.daemon.call("GET", "/engine/subscription"),
    "subscription.op": async (_c, a) => (/^(install|start|stop|restart|check)$/.test(String(a)) ? this.d.daemon.call("POST", `/engine/subscription/${a}`, {}) : bad("unknown operation")),
    "subscription.login": async (_c, a) => this.d.daemon.call("POST", "/engine/subscription/login", { provider: String(a) }),
    "subscription.loginStatus": async (_c, a) => this.d.daemon.call("POST", "/engine/subscription/login-status", { state: String(a) }),
    "engine.providers": async () => this.d.daemon.call("GET", "/engine/providers"),
    "engine.test": async (_c, a) => (PROVIDER_ID.test(String(a)) ? this.d.daemon.call("POST", `/engine/providers/${a}/test`, {}) : bad("unknown provider")),
    "engine.credential": async (ctx, a, b) => {
      if (!PROVIDER_ID.test(String(a))) return bad("unknown provider");
      const o = (b ?? {}) as Record<string, unknown>;
      const clean = {
        ...(o.action === "set" || o.action === "remove" ? { action: o.action } : {}),
        ...(typeof o.apiKey === "string" && o.apiKey.length < 400 ? { apiKey: o.apiKey } : {}),
        ...(typeof o.baseURL === "string" && o.baseURL.length < 300 ? { baseURL: o.baseURL } : {}),
        ...(o.protocol === "openai" || o.protocol === "anthropic" ? { protocol: o.protocol } : {}),
      };
      const r1 = await this.d.daemon.call<{ nonce?: string; payload?: ApprovalPayload }>("POST", `/engine/providers/${a}/credential`, clean);
      if (!r1.ok || !r1.data.nonce || !r1.data.payload) return r1;
      const sig = await this.approve(ctx, r1.data.payload);
      return this.d.daemon.call("POST", `/engine/providers/${a}/credential`, { nonce: r1.data.nonce, approval: sig });
    },
    "engine.confirm": async () => bad("the cloud approves with a passkey"),
    "engine.select": async (_c, a, b) => (PROVIDER_ID.test(String(a)) ? this.d.daemon.call("POST", "/engine/select", { provider: String(a), ...(typeof b === "string" ? { model: b } : {}) }) : bad("unknown provider")),
    "candidates.get": async (_c, a) => this.d.daemon.tool("ate_candidates_get", (MARKET_IDS as readonly string[]).includes(a) ? { market: a as MarketId } : {}),
    "charts.chart": async (_c, a) => (a && typeof a === "object" ? this.d.daemon.tool("ate_chart", a as never) : bad("expected a chart input")),
    "charts.data": async (_c, a) => (a && typeof a === "object" ? this.d.daemon.tool("ate_data", a as never) : bad("expected a data input")),
    "cycle.request": async () => this.d.daemon.call("POST", "/cycle", {}),
  };

  /** Dispatch `ns.method` with positional args. */
  async dispatch(ctx: RunCtx, method: string, args: unknown[]): Promise<unknown> {
    if (method in this.ipc) return this.ipc[method as IpcMethod](ctx, args[0], args[1]);
    if (method in this.setup) return this.setup[method as SetupIpc](ctx, ...args);
    if (method.startsWith("owner.")) {
      const fn = this.owner[method.slice(6) as keyof CloudBridge["owner"]] as ((ctx: RunCtx, ...a: unknown[]) => Promise<unknown>) | undefined;
      if (fn && method !== "owner.status") return fn(ctx, ...args);
      if (method === "owner.status") return this.owner.status();
    }
    return bad("method not allowed");
  }
}

export { decodePayload };
