// Frozen renderer bridge (SPEC §10.2). The renderer only ever sees `window.ate`; main proxies
// allowlisted calls to the daemon. Method names below are the IPC allowlist.

import type {
  CandidatesGetOutput,
  DaemonEvent,
  DecisionKind,
  JournalEntry,
  MarketId,
  MarketView,
  PositionsOutput,
  Quote,
  QuoteInput,
  ProposeInput,
  ProposeOutput,
  ExecuteOutput,
  PauseOutput,
  StatusResponse,
  StrategyGetOutput,
  StrategyApproveResponse,
  StrategyPatch,
  StrategySetOutput,
  ToolError,
} from "@ate/core";

export type Res<T> = { ok: true; data: T } | { ok: false; error: Pick<ToolError, "code" | "message"> & { hint?: string; details?: Record<string, unknown> } };

export type ConnectionMode = "live" | "fixtures" | "offline";
export interface ConnectionInfo {
  mode: ConnectionMode;
  detail?: string;
  port?: number;
  scope?: "ui";
}

export interface JournalFilter {
  limit?: number;
  market?: MarketId;
  kind?: DecisionKind[];
  before?: number;
}
export interface JournalPage {
  entries: JournalEntry[];
  head: { seq: number; hash: string };
}

export interface VaultsStatus {
  status: StatusResponse;
  positions: PositionsOutput;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "tool";
  text: string;
  at: number;
  turnId?: string;
  /** Additive: engine reported by the daemon's chat.delta (llm | rules). */
  engine?: string;
  tool?: { name: string; args: unknown; result: unknown; decisionId?: string };
}

export interface PaymentRow {
  paymentId: string;
  state: string;
  amountUsd: string;
  payTo: string;
  offerId: string;
  at: number;
  needsApproval?: 1 | 2;
  gatewayTx?: string;
  /** Additive (live): ate-approve prompt text and the EIP-712 digest being approved, rebuilt from the worker's payload. */
  approvalPrompt?: string;
  digest?: string;
}
export interface PaymentsList {
  /** "no-go": G-HSP is not live; the leg is built and tested on recorded responses (SPEC §9, §21.4). */
  gate: "go" | "no-go";
  rows: PaymentRow[];
}

export interface Settings {
  rpcUrls: string[];
  unlockTimeoutMin: number;
  daemonPort: number | null;
}

// ---- Flow v1 lane D3 (additive): supervised trader, pending approvals, in-app proof suite ----
export interface TraderStatus {
  supervised: boolean;
  running: boolean;
  stopping: boolean;
  /** An `ate agent run` outside the app is cycling (the app cannot stop it). */
  external: boolean;
  mode: "autonomous" | "propose";
  engine: "llm" | "rules";
  model: string;
  /** Where the LLM runs: in-app engine, the optional Claude Code CLI, or the rules engine. */
  runtime?: "sdk" | "claude-code" | "rules";
  cycleSeconds: number;
  toolsAllowed: number;
  startedAt: number | null;
  cycles: number;
  lastCycleAt: number | null;
  lastCycle: { cycle: number; status: string; at: number; latencyMs: number; summary?: string } | null;
  lastError: string | null;
}
export interface TraderStartInput {
  mode?: "autonomous" | "propose";
  engine?: "llm" | "rules";
  model?: string;
  cycleSeconds?: number;
}
export interface PendingChange {
  changeId: string;
  diff: { scope: string; field: string; before: unknown; after: unknown; loosening: boolean; clampedBy?: string }[];
  renderedDiff: string;
  expiresAt: number;
  createdAt: number;
  via: string;
  rationale: string;
  /** "sells_now": a tightening that sells immediately (chat go-to-cash), confirmed with Touch ID. */
  confirm?: "sells_now";
}
export interface ProofAttack {
  attack: "trade_cap" | "exposure" | "slippage" | "pair" | "withdraw" | "set_limits" | "paused";
  expected: string;
  status: "queued" | "running" | "reverted" | "skipped" | "unexpected" | "aborted" | "dry-run";
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
export interface ProofState {
  chainId: number;
  runnable: boolean;
  explorer: string;
  target: { vault: string | null; market: MarketId; agent: string | null; guardian: string | null; owner: string | null };
  paused: Partial<Record<MarketId, boolean>>;
  run: ProofRun | null;
  recorded: ProofRun[];
  pauses: PauseEvent[];
}

export interface AiHealth {
  provider: string;
  providerLabel: string;
  engine: "sdk" | "claude-code";
  model: string;
  modelLabel: string;
  models: readonly { id: string; label: string; tools?: boolean | null }[];
  credential: "keychain" | "file" | "env" | "profile" | "none";
  traderEffort: "low" | "medium" | "high";
  chatEffort: "low" | "medium" | "high";
  lastCheck: { at: number; reachable: boolean; error?: { kind: string; message: string } } | null;
  lastUsage: { at: number; kind: "trader" | "chat"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
  /** Claude Code CLI found on this Mac (the optional "claude-code" engine runs it with its own login). */
  claudeCli?: string | null;
}
/** No AI to run the agents: no credential, and not the Claude Code CLI engine with the CLI installed. */
export const aiMissing = (h: Pick<AiHealth, "credential" | "engine" | "claudeCli" | "provider">): boolean => h.credential === "none" && !(viaClaudeCode(h));
/** The Claude Code CLI runs the agents (Anthropic provider only; another provider ignores the engine flag). */
export const viaClaudeCode = (h: Pick<AiHealth, "engine" | "claudeCli" | "provider">): boolean => h.engine === "claude-code" && h.provider === "anthropic" && !!h.claudeCli;

export interface AiConfigPatch {
  model?: string;
  engine?: "sdk" | "claude-code";
  traderEffort?: "low" | "medium" | "high";
  chatEffort?: "low" | "medium" | "high";
}

export interface EngineProvider {
  id: "opencode" | "subscription" | "anthropic" | "openai" | "gemini" | "openrouter" | "ollama" | "proxy";
  label: string;
  protocol: string;
  key: "required" | "optional" | "none";
  warning: string | null;
  settings: { baseURL?: string; protocol?: "openai" | "anthropic" };
  credential: { source: string; hint: string | null; stored: boolean };
  configured: boolean;
  selected: boolean;
  caps: { tools: boolean; streaming: boolean };
  health: { at: number; ok: boolean; error?: { kind: string; message: string } } | null;
  models: { id: string; label: string; tools: boolean | null; streaming: boolean }[];
}
export interface EngineProviders {
  /** `auto`: the model is picked automatically (best the subscription offers). */
  selected: { provider: EngineProvider["id"]; model: string; auto?: boolean; engine: "sdk" | "claude-code" };
  providers: EngineProvider[];
  /** Ask's model: its own choice (`own`) or the trader's. */
  chat?: { provider: EngineProvider["id"]; model: string; own: boolean };
}
/** Credential change result: applied, or waiting for the daemon's one-time code (Touch ID unavailable). */
export type EngineCredentialResult = { saved: true; provider: EngineProvider } | { needsCode: true; nonce: string; expiresAt: number };

/** The daemon-managed CLIProxyAPI sidecar behind the default "subscription" provider. */
export interface SubscriptionStatus {
  installed: boolean;
  bin: string | null;
  source: "flow" | "user" | null;
  version: string | null;
  running: boolean;
  owned: boolean;
  pid: number | null;
  port: number;
  baseURL: string;
  healthy: boolean;
  models: string[];
  lastError: string | null;
  checkedAt: number | null;
  loginFlags: string[];
  /** Flow's proxy config: a terminal sign-in must pass `-config <configPath>`. */
  configPath: string;
  selectedModel: string | null;
}

/** Tools (MCP): Flow's server, the user's opencode servers and servers added in Flow. */
export interface McpServerInfo {
  id: string;
  name: string;
  source: "flow" | "opencode" | "user";
  type: "builtin" | "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  headerKeys?: string[];
  enabled: { chat: boolean; trader: boolean };
  state: "connected" | "available" | "error";
  error: string | null;
  tools: { name: string; description: string }[];
  checkedAt: number | null;
}
export type McpEnableResult = { servers: McpServerInfo[] } | { needsCode: true; nonce: string; expiresAt: number };

export interface AteBridge {
  readonly fixtures: boolean;
  connection(): Promise<ConnectionInfo>;
  markets: { list(): Promise<Res<MarketView[]>>; get(id: MarketId): Promise<Res<MarketView>> };
  quote: { get(req: QuoteInput): Promise<Res<Quote>> };
  trade: {
    propose(req: ProposeInput): Promise<Res<ProposeOutput>>;
    approve(id: string, digest: string): Promise<Res<{ approved: true }>>;
    execute(id: string): Promise<Res<ExecuteOutput>>;
  };
  vaults: { status(): Promise<Res<VaultsStatus>>; pause(): Promise<Res<PauseOutput>> };
  strategy: {
    get(): Promise<Res<StrategyGetOutput>>;
    set(patch: StrategyPatch, rationale: string): Promise<Res<StrategySetOutput>>;
    /**
     * ADDITIVE (not in the frozen §10.2 list; needed for in-UI loosening approval, §11.5): approve a pending change
     * that `set` (or a chat turn) returned as ATE_APPROVAL_REQUIRED. Main signs `strategyPayload(details)` with
     * ate-approve (Touch ID); `ttyCode` (8 digits, §10.1 armed fallback) is used instead when given. → /strategy/approve.
     */
    approve(changeId: string, ttyCode?: string): Promise<Res<StrategyApproveResponse>>;
  };
  journal: { list(filter: JournalFilter): Promise<Res<JournalPage>>; get(id: string): Promise<Res<JournalEntry>> };
  chat: {
    send(sessionId: string, text: string): Promise<Res<{ turnId: string }>>;
    history(sessionId: string): Promise<Res<ChatMessage[]>>;
  };
  payments: {
    list(): Promise<Res<PaymentsList>>;
    approve(id: string, digest: string): Promise<Res<{ approved: true }>>;
    deny(id: string): Promise<Res<{ denied: true }>>;
  };
  settings: { get(): Promise<Res<Settings>>; set(patch: Partial<Settings>): Promise<Res<Settings>> };
  /** Lane D2: setup wizard + daemon lifecycle (shared/setup-bridge.ts). Absent in fixtures. */
  setup?: import("./setup-bridge").SetupBridge;
  /** Additive (lane D3): the daemon-supervised trader runner. Optional: absent in fixture bridges. */
  trader?: { status(): Promise<Res<TraderStatus>>; start(o: TraderStartInput): Promise<Res<TraderStatus>>; stop(): Promise<Res<TraderStatus>> };
  /** Additive (lane D3): pending strategy changes (approve with `strategy.approve`). */
  approvals?: {
    list(): Promise<Res<PendingChange[]>>;
    reject(changeId: string): Promise<Res<{ rejected: boolean }>>;
    /** Plain confirmation (no Touch ID) for a change that only tightens risk but sells now (go to cash). */
    confirm(changeId: string): Promise<Res<{ applied: true; decisionId: string }>>;
  };
  /** Additive (lane D3): the in-app attack suite (testnet only) and the recorded proof. */
  proof?: { get(): Promise<Res<ProofState>>; run(o?: { market?: MarketId; waitPauseSec?: number }): Promise<Res<ProofRun>>; stop(): Promise<Res<{ run: ProofRun | null }>> };
  /** Additive (lane D1): live candidates for Markets (ate_candidates_get) and an out-of-schedule cycle (POST /cycle). */
  candidates?: { get(market?: MarketId): Promise<Res<CandidatesGetOutput>> };
  /** Additive (lane D4): read-only charts and tables (ate_chart / ate_data). */
  charts?: { chart(input: import("@ate/core").ChartInput): Promise<Res<import("@ate/core").ChartSpec>>; data(input: import("@ate/core").DataInput): Promise<Res<import("@ate/core").DataTable>> };
  cycle?: { request(): Promise<Res<{ started: boolean; reason?: string; cycle: number }>> };
  /** Additive (lane STRAT): custom strategies, backtests, practice runs, training (daemon routes in STRAT_PATHS). */
  strat?: { call<T = unknown>(path: StratPath, body?: unknown): Promise<Res<T>> };
  /** Additive (lane D3): the in-app agent engine (Anthropic SDK). setKey sends the key once to the daemon keychain. */
  ai?: { health(): Promise<Res<AiHealth>>; check(): Promise<Res<AiHealth>>; setKey(apiKey: string): Promise<Res<AiHealth>>; clearKey(): Promise<Res<AiHealth>>; config(p: AiConfigPatch): Promise<Res<AiHealth>> };
  /** Additive (lane D3): model providers for the in-app agents (Accounts). Replace/remove asks for Touch ID in main. */
  engine?: {
    providers(): Promise<Res<EngineProviders>>;
    test(id: EngineProvider["id"]): Promise<Res<EngineProvider>>;
    credential(id: EngineProvider["id"], body: { action?: "set" | "remove"; apiKey?: string; baseURL?: string; protocol?: "openai" | "anthropic" }): Promise<Res<EngineCredentialResult>>;
    confirm(id: EngineProvider["id"], nonce: string, code: string): Promise<Res<EngineCredentialResult>>;
    select(provider: EngineProvider["id"], model?: string): Promise<Res<EngineProviders>>;
    /** Ask's own model (null = follow the trader's). */
    selectChat(provider: EngineProvider["id"] | null, model?: string): Promise<Res<EngineProviders>>;
  };
  /** Additive (lane D3): your subscriptions through the CLIProxyAPI sidecar (install / start / stop / restart / check). */
  subscription?: {
    status(): Promise<Res<SubscriptionStatus>>;
    op(op: "install" | "start" | "stop" | "restart" | "check"): Promise<Res<SubscriptionStatus>>;
    /** In-app sign-in: the provider's login URL (open in the browser) and a state to poll. */
    login(provider: "claude" | "codex" | "antigravity" | "kimi" | "kimi-ai" | "xai" | "devin" | "meta"): Promise<Res<{ url: string; state: string | null }>>;
    loginStatus(state: string): Promise<Res<{ login: unknown; models: string[]; selectedModel: string | null }>>;
  };
  /** Additive (lane D3): Tools (MCP). Turning a server on for the trader asks for Touch ID in main (code fallback). */
  mcp?: {
    list(): Promise<Res<{ servers: McpServerInfo[] }>>;
    add(def: { name: string; type: "stdio" | "http"; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> }): Promise<Res<{ servers: McpServerInfo[] }>>;
    remove(id: string): Promise<Res<{ servers: McpServerInfo[] }>>;
    test(id: string): Promise<Res<{ servers: McpServerInfo[] }>>;
    enable(id: string, agent: "chat" | "trader", on: boolean): Promise<Res<McpEnableResult>>;
    confirm(nonce: string, code: string): Promise<Res<{ servers: McpServerInfo[] }>>;
  };
  events: { subscribe(handler: (e: DaemonEvent) => void): () => void };
}

/** IPC channel allowlist: `ate:<namespace>.<method>`. Nothing else is reachable from the renderer. */
export const IPC_METHODS = [
  "connection",
  "markets.list",
  "markets.get",
  "quote.get",
  "trade.propose",
  "trade.approve",
  "trade.execute",
  "vaults.status",
  "vaults.pause",
  "strategy.get",
  "strategy.set",
  "strategy.approve", // additive: see AteBridge.strategy.approve
  "journal.list",
  "journal.get",
  "chat.send",
  "chat.history",
  "payments.list",
  "payments.approve",
  "payments.deny",
  "settings.get",
  "settings.set",
  // lane D3 (additive)
  "trader.status",
  "trader.start",
  "trader.stop",
  "approvals.list",
  "approvals.reject",
  "approvals.confirm",
  "proof.get",
  "proof.run",
  "proof.stop",
  "ai.health",
  "ai.check",
  "ai.setKey",
  "ai.clearKey",
  "ai.config",
  "engine.providers",
  "engine.test",
  "engine.credential",
  "engine.confirm",
  "engine.select",
  "engine.selectChat",
  "mcp.list",
  "mcp.add",
  "mcp.remove",
  "mcp.test",
  "mcp.enable",
  "mcp.confirm",
  "subscription.status",
  "subscription.op",
  "subscription.login",
  "subscription.loginStatus",
  // lane D1 (additive)
  "candidates.get",
  // lane D4 (additive)
  "charts.chart",
  "charts.data",
  "cycle.request",
  // lane STRAT (additive)
  "strat.call",
] as const;

/** Lane STRAT: the daemon routes `strat.call` may reach (GET for /strategies, POST otherwise). */
export const STRAT_PATHS = [
  "/strategies",
  "/strategies/describe",
  "/strategies/draft",
  "/strategies/save",
  "/strategies/remove",
  "/strategies/use",
  "/strategies/confirm-save",
  "/strategies/drop-save",
  "/strategies/adopt",
  "/backtest",
  "/practice/estimate",
  "/practice/start",
  "/practice/state",
  "/practice/control",
  "/train",
  "/sweep",
] as const;
export type StratPath = (typeof STRAT_PATHS)[number];
export type IpcMethod = (typeof IPC_METHODS)[number];
export const EVENT_CHANNEL = "ate:event";
