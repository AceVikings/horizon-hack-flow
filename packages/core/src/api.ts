// Daemon local HTTP API payloads (§10.1). FROZEN 04:30 IST.

import type { AteErrorCode } from "./errors.js";
import type { Address, Hex, MarketId, Side } from "./markets.js";
import type { DaemonCounters, StrategyFieldChange, UnixSec } from "./types.js";

/** ~/.ate/runtime.json (mode 0600). */
export interface RuntimeJson {
  pid: number;
  port: number;
  agentToken: string;
  startedAt: UnixSec;
  version: string;
}

// ---- POST /ui/attach (two steps) and POST /chat/session ----
export type UiAttachStep1Request = Record<string, never>;
export interface UiAttachStep1Response {
  nonce: string;
  expiresAt: UnixSec;
}
export interface UiAttachStep2Request {
  nonce: string;
  /** ate-approve P-256 signature (base64) over the nonce payload, or the TTY code under the §10.1 degradation. */
  approval: string;
}
export interface UiAttachStep2Response {
  uiToken: string;
}

export type ChatSessionStep1Request = Record<string, never>;
export interface ChatSessionStep1Response {
  sessionId: string;
  nonce: string;
  expiresAt: UnixSec;
}
export interface ChatSessionStep2Request {
  sessionId: string;
  nonce: string;
  approval: string;
}
export interface ChatSessionStep2Response {
  sessionId: string;
  /** `session` scope handle: authorises /chat turns for this session only. */
  sessionToken: string;
  expiresAt: UnixSec;
}

// ---- POST /chat ----
export interface ChatRequest {
  sessionId: string;
  text: string;
}
export interface ChatResponse {
  sessionId: string;
  turnId: string;
  /** Reply and tool cards stream over /events (chat.delta, chat.tool). */
  accepted: true;
}

// ---- POST /cycle ----
export type CycleRequest = Record<string, never>;
export interface CycleResponse {
  started: boolean;
  /** When not started: overlapping run or rate limit (one per 30 s). */
  reason?: "running" | "rate_limited";
  cycle: number;
}

// ---- POST /strategy/approve ----
export interface StrategyApproveRequest {
  changeId: string;
  approval: string;
}
export interface StrategyApproveResponse {
  applied: true;
  decisionId: string;
  changes: StrategyFieldChange[];
}

// ---- GET /status ----
export interface StatusResponse extends DaemonCounters {
  version: string;
  chainId: 177 | 133; // 133 = testnet (additive)
  blockNumber: string;
  locked: boolean;
  trader: { running: boolean; mode: "autonomous" | "confirm"; engine: "llm" | "rules"; lastCycleAt: UnixSec | null };
  vaults: { market: MarketId; address: Address; paused: boolean }[];
  gas: { agentHsk: string; low: boolean; attestationsDeferred: number };
}

// ---- WebSocket /events ----
export type DaemonEvent =
  | {
      type: "trade.executed";
      at: UnixSec;
      data: { market: MarketId; proposalId: string; txHash: Hex; side: Side; amountIn: string; amountOut: string; exitPath: boolean; decisionId: string };
    }
  | {
      type: "trade.rejected";
      at: UnixSec;
      data: { market: MarketId; proposalId?: string; code: AteErrorCode; message: string; decisionId?: string };
    }
  | { type: "policy.violation"; at: UnixSec; data: { market: MarketId; reason: number; code: AteErrorCode; txHash?: Hex } }
  | {
      type: "oracle.health";
      at: UnixSec;
      data: { market: MarketId; health: "fresh" | "aging" | "stale"; ageSec: number; deviationBps: number; readOnly: boolean };
    }
  | { type: "strategy.changed"; at: UnixSec; data: { decisionId: string; changes: StrategyFieldChange[]; actor: "agent" | "human" } }
  | { type: "payment.state"; at: UnixSec; data: { paymentId: string; state: string } }
  | { type: "daemon.locked"; at: UnixSec; data: { locked: boolean; reason?: string } }
  | { type: "gas.low"; at: UnixSec; data: { agentHsk: string; thresholdHsk: string } }
  | { type: "chat.delta"; at: UnixSec; data: { sessionId: string; turnId: string; text: string; done: boolean } }
  | {
      type: "chat.tool";
      at: UnixSec;
      data: { sessionId: string; turnId: string; tool: string; args: unknown; result: unknown; decisionId?: string };
    }
  // Additive (Lane B): out-of-schedule trader cycle request (POST /cycle, scan gap, human strategy change).
  // The runner subscribes to /events and starts a cycle (no-overlap rule applies, §11.1).
  | { type: "cycle.requested"; at: UnixSec; data: { reason: "manual" | "gap" | "strategy_change"; cycle: number } };

export type DaemonEventType = DaemonEvent["type"];
export const DAEMON_EVENT_TYPES: readonly DaemonEventType[] = [
  "trade.executed",
  "trade.rejected",
  "policy.violation",
  "oracle.health",
  "strategy.changed",
  "payment.state",
  "daemon.locked",
  "gas.low",
  "chat.delta",
  "chat.tool",
  "cycle.requested",
];
