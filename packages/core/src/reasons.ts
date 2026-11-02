// Vault reason codes returned by PolicyVault.check() (§4.1). Names and values are exact.
// FROZEN 04:30 IST.

import type { AteErrorCode } from "./errors.js";

export const ReasonCode = {
  OK: 0,
  ERR_PAUSED: 1,
  ERR_NOT_AGENT: 2,
  ERR_ZERO_AMOUNT: 3,
  ERR_DEADLINE: 4,
  ERR_PAIR_NOT_ALLOWED: 5,
  ERR_ORACLE_INVALID: 6,
  ERR_ORACLE_STALE: 7,
  ERR_ORACLE_DEVIATION: 8,
  ERR_TRADE_CAP: 9,
  ERR_EPOCH_CAP: 10,
  ERR_COOLDOWN: 11,
  ERR_SLIPPAGE: 12,
  ERR_BALANCE: 13,
  ERR_EXPOSURE: 14,
  ERR_EXIT_PRICE: 15,
} as const;
export type ReasonName = keyof typeof ReasonCode;
export type ReasonCode = (typeof ReasonCode)[ReasonName];

export const REASON_NAMES: readonly ReasonName[] = [
  "OK",
  "ERR_PAUSED",
  "ERR_NOT_AGENT",
  "ERR_ZERO_AMOUNT",
  "ERR_DEADLINE",
  "ERR_PAIR_NOT_ALLOWED",
  "ERR_ORACLE_INVALID",
  "ERR_ORACLE_STALE",
  "ERR_ORACLE_DEVIATION",
  "ERR_TRADE_CAP",
  "ERR_EPOCH_CAP",
  "ERR_COOLDOWN",
  "ERR_SLIPPAGE",
  "ERR_BALANCE",
  "ERR_EXPOSURE",
  "ERR_EXIT_PRICE",
];

export function reasonName(code: number): ReasonName {
  const n = REASON_NAMES[code];
  if (n === undefined) throw new RangeError(`unknown vault reason code ${code}`);
  return n;
}

export function isReasonCode(x: unknown): x is ReasonCode {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 15;
}

/** Vault reason code → MCP error code (§7.6). OK has no error code. */
export const REASON_TO_ERROR: Readonly<Record<Exclude<ReasonName, "OK">, AteErrorCode>> = {
  ERR_PAUSED: "ATE_POLICY_PAUSED",
  ERR_NOT_AGENT: "ATE_POLICY_NOT_AGENT",
  ERR_ZERO_AMOUNT: "ATE_POLICY_ZERO_AMOUNT",
  ERR_DEADLINE: "ATE_DEADLINE",
  ERR_PAIR_NOT_ALLOWED: "ATE_POLICY_PAIR",
  ERR_ORACLE_INVALID: "ATE_ORACLE_INVALID",
  ERR_ORACLE_STALE: "ATE_ORACLE_STALE",
  ERR_ORACLE_DEVIATION: "ATE_ORACLE_DEVIATION",
  ERR_TRADE_CAP: "ATE_POLICY_TRADE_CAP",
  ERR_EPOCH_CAP: "ATE_POLICY_EPOCH_CAP",
  ERR_COOLDOWN: "ATE_POLICY_COOLDOWN",
  ERR_SLIPPAGE: "ATE_SLIPPAGE",
  ERR_BALANCE: "ATE_INSUFFICIENT_BALANCE",
  ERR_EXPOSURE: "ATE_POLICY_EXPOSURE",
  ERR_EXIT_PRICE: "ATE_EXIT_PRICE",
};

export function reasonToError(code: number): AteErrorCode | null {
  const name = reasonName(code);
  return name === "OK" ? null : REASON_TO_ERROR[name];
}

/** §20: PolicyError covers codes 1–5 and 9–14; OracleError covers 6–8 and 15. */
export function reasonErrorKind(code: number): "PolicyError" | "OracleError" | null {
  if (code === 0) return null;
  return (code >= 6 && code <= 8) || code === 15 ? "OracleError" : "PolicyError";
}

/**
 * Solidity custom error name that `execute()` reverts with for each reason (mirrored 1:1, §4.1/§4.3).
 * See abi/policyVault.ts for the parameter lists.
 */
export const REASON_TO_CUSTOM_ERROR: Readonly<Record<Exclude<ReasonName, "OK">, string>> = {
  ERR_PAUSED: "VaultPaused",
  ERR_NOT_AGENT: "NotAgent",
  ERR_ZERO_AMOUNT: "ZeroAmount",
  ERR_DEADLINE: "DeadlineExpired",
  ERR_PAIR_NOT_ALLOWED: "PairNotAllowed",
  ERR_ORACLE_INVALID: "OracleInvalid",
  ERR_ORACLE_STALE: "OracleStale",
  ERR_ORACLE_DEVIATION: "OracleDeviation",
  ERR_TRADE_CAP: "TradeCap",
  ERR_EPOCH_CAP: "EpochCap",
  ERR_COOLDOWN: "Cooldown",
  ERR_SLIPPAGE: "Slippage",
  ERR_BALANCE: "InsufficientBalance",
  ERR_EXPOSURE: "Exposure",
  ERR_EXIT_PRICE: "ExitPrice",
};

export const CUSTOM_ERROR_TO_REASON: Readonly<Record<string, ReasonCode>> = Object.fromEntries(
  Object.entries(REASON_TO_CUSTOM_ERROR).map(([k, v]) => [v, ReasonCode[k as ReasonName]]),
);
