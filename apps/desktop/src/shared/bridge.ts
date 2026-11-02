// Frozen renderer bridge (SPEC §10.2). The renderer only ever sees `window.ate`; main proxies
// allowlisted calls to the daemon. Method names below are the IPC allowlist.

import type {
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
  /** Additive (lane D3): the daemon-supervised trader runner. Optional: absent in fixture bridges. */
  trader?: { status(): Promise<Res<TraderStatus>>; start(o: TraderStartInput): Promise<Res<TraderStatus>>; stop(): Promise<Res<TraderStatus>> };
  /** Additive (lane D3): pending strategy changes (approve with `strategy.approve`). */
  approvals?: { list(): Promise<Res<PendingChange[]>>; reject(changeId: string): Promise<Res<{ rejected: boolean }>> };
  /** Additive (lane D3): the in-app attack suite (testnet only) and the recorded proof. */
  proof?: { get(): Promise<Res<ProofState>>; run(o?: { market?: MarketId; waitPauseSec?: number }): Promise<Res<ProofRun>>; stop(): Promise<Res<{ run: ProofRun | null }>> };
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
  "proof.get",
  "proof.run",
  "proof.stop",
] as const;
export type IpcMethod = (typeof IPC_METHODS)[number];
export const EVENT_CHANNEL = "ate:event";
