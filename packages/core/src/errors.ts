// Error codes (§7.6, §9.6), response envelope (§7.5) and daemon error taxonomy (§20).
// FROZEN 04:30 IST.

export const ATE_ERROR_CODES = [
  "ATE_POLICY_PAUSED",
  "ATE_POLICY_NOT_AGENT",
  "ATE_POLICY_PAIR",
  "ATE_POLICY_TRADE_CAP",
  "ATE_POLICY_EPOCH_CAP",
  "ATE_POLICY_COOLDOWN",
  "ATE_ORACLE_STALE",
  "ATE_ORACLE_INVALID",
  "ATE_ORACLE_DEVIATION",
  "ATE_EXIT_PRICE",
  "ATE_SLIPPAGE",
  "ATE_DEADLINE",
  "ATE_POLICY_ZERO_AMOUNT",
  "ATE_INSUFFICIENT_BALANCE",
  "ATE_POLICY_EXPOSURE",
  "ATE_STRATEGY_BLOCKED",
  "ATE_MARKET_UNKNOWN",
  "ATE_CANDIDATE_REQUIRED",
  "ATE_DISCRETIONARY_LIMIT",
  "ATE_TOOL_NOT_ALLOWED",
  "ATE_APPROVAL_REQUIRED",
  "ATE_GAS_LOW",
  "ATE_CANDIDATE_MISMATCH",
  "ATE_PROPOSAL_UNKNOWN",
  "ATE_PROPOSAL_EXPIRED",
  "ATE_PAYMENT_DENIED",
  "ATE_PAYMENT_EXPIRED",
  "ATE_PAYMENT_LIMIT",
  "ATE_PAYMENT_UNCERTAIN",
  "ATE_PAYMENT_NETWORK_UNSUPPORTED",
  "ATE_PAYMENT_UNAVAILABLE",
  "ATE_PAYMENT_ORDER_MISMATCH",
  "ATE_PAYMENT_CONDITIONS_INVALID",
  "ATE_VENUE_ERROR",
  "ATE_RPC_RATE_LIMITED",
  "ATE_DAEMON_LOCKED",
  // Freeze addition (FREEZE-NOTES §E1): unexpected daemon fault surfaced over MCP (§20 InternalError).
  "ATE_INTERNAL",
  // Freeze addition: config file failed Zod validation or vault-immutable cross-checks (§16, §20 ConfigError).
  "ATE_CONFIG_INVALID",
] as const;
export type AteErrorCode = (typeof ATE_ERROR_CODES)[number];

export function isAteErrorCode(x: unknown): x is AteErrorCode {
  return typeof x === "string" && (ATE_ERROR_CODES as readonly string[]).includes(x);
}

/** Default retryability per §7.6 ("maybe"/"varies" resolved as noted). */
export const ERROR_RETRYABLE: Readonly<Record<AteErrorCode, boolean>> = {
  ATE_POLICY_PAUSED: false,
  ATE_POLICY_NOT_AGENT: false,
  ATE_POLICY_PAIR: false,
  ATE_POLICY_TRADE_CAP: false,
  ATE_POLICY_EPOCH_CAP: true,
  ATE_POLICY_COOLDOWN: true,
  ATE_ORACLE_STALE: true,
  ATE_ORACLE_INVALID: true,
  ATE_ORACLE_DEVIATION: true,
  ATE_EXIT_PRICE: true,
  ATE_SLIPPAGE: true,
  ATE_DEADLINE: true,
  ATE_POLICY_ZERO_AMOUNT: false,
  ATE_INSUFFICIENT_BALANCE: false,
  ATE_POLICY_EXPOSURE: false,
  ATE_STRATEGY_BLOCKED: true,
  ATE_MARKET_UNKNOWN: false,
  ATE_CANDIDATE_REQUIRED: false,
  ATE_DISCRETIONARY_LIMIT: true,
  ATE_TOOL_NOT_ALLOWED: false,
  ATE_APPROVAL_REQUIRED: true,
  ATE_GAS_LOW: true,
  ATE_CANDIDATE_MISMATCH: false,
  ATE_PROPOSAL_UNKNOWN: false,
  ATE_PROPOSAL_EXPIRED: true,
  ATE_PAYMENT_DENIED: false,
  ATE_PAYMENT_EXPIRED: true,
  ATE_PAYMENT_LIMIT: true,
  ATE_PAYMENT_UNCERTAIN: true,
  ATE_PAYMENT_NETWORK_UNSUPPORTED: false,
  ATE_PAYMENT_UNAVAILABLE: true,
  ATE_PAYMENT_ORDER_MISMATCH: false,
  ATE_PAYMENT_CONDITIONS_INVALID: false,
  ATE_VENUE_ERROR: true, // "maybe" — callers override per cause
  ATE_RPC_RATE_LIMITED: true,
  ATE_DAEMON_LOCKED: true,
  ATE_INTERNAL: false,
  ATE_CONFIG_INVALID: false,
};

// ---- §7.5 envelope ----

export interface ToolMeta {
  latencyMs: number;
  /** Decimal string. */
  blockNumber: string;
}

export interface ToolError {
  code: AteErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
  /**
   * Freeze addition (FREEZE-NOTES §E2): structured context for the caller. For ATE_APPROVAL_REQUIRED it is
   * a StrategyApprovalPending ({ changeId, diff, renderedDiff, expiresAt }).
   */
  details?: Record<string, unknown>;
}

export type ToolResult<T> =
  | { ok: true; data: T; meta: ToolMeta }
  | { ok: false; error: ToolError };

export function ok<T>(data: T, meta: ToolMeta): ToolResult<T> {
  return { ok: true, data, meta };
}

export function fail<T = never>(code: AteErrorCode, message: string, hint?: string, retryable?: boolean): ToolResult<T> {
  const error: ToolError = { code, message, retryable: retryable ?? ERROR_RETRYABLE[code] };
  if (hint !== undefined) error.hint = hint;
  return { ok: false, error };
}

// ---- §20 taxonomy ----

export type AteErrorKind =
  | "ConfigError"
  | "WalletError"
  | "ChainError"
  | "PolicyError"
  | "StrategyError"
  | "VenueError"
  | "OracleError"
  | "ProposalError"
  | "ChatError"
  | "AuthError"
  | "AttestationError"
  | "PaymentError"
  | "InternalError";

/** Every error carries `{ code, message, hint, retryable, context }` (§20). */
export class AteError extends Error {
  readonly kind: AteErrorKind;
  readonly code: AteErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;

  constructor(
    kind: AteErrorKind,
    code: AteErrorCode,
    message: string,
    opts: { hint?: string; retryable?: boolean; context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = kind;
    this.kind = kind;
    this.code = code;
    this.hint = opts.hint;
    this.retryable = opts.retryable ?? ERROR_RETRYABLE[code];
    this.context = opts.context ?? {};
  }

  toToolError(): ToolError {
    const e: ToolError = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.hint !== undefined) e.hint = this.hint;
    return e;
  }
}
