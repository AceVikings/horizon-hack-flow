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
  strategy: { get(): Promise<Res<StrategyGetOutput>>; set(patch: StrategyPatch, rationale: string): Promise<Res<StrategySetOutput>> };
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
  "journal.list",
  "journal.get",
  "chat.send",
  "chat.history",
  "payments.list",
  "payments.approve",
  "payments.deny",
  "settings.get",
  "settings.set",
] as const;
export type IpcMethod = (typeof IPC_METHODS)[number];
export const EVENT_CHANNEL = "ate:event";
