// Owner operations and the one rule that decides whether the user must approve them (Touch ID / passkey):
// anything that raises risk does (looser limits, unpause, a new agent or guardian, withdraw, sending gas); anything
// that only lowers risk does not (tighter limits, pause). Deploying new vaults with limits no looser than the §19
// defaults is not risk-raising either: it creates empty vaults that only the owner can fund.
import type { Address } from "viem";

export interface VaultLimits {
  maxTradeUsd: bigint;
  maxEpochUsd: bigint;
  maxExposureUsd: bigint;
  epochDuration: number;
  maxSlippageBps: number;
  maxOracleDeviationBps: number;
  maxExitDiscountBps: number;
  maxOracleAge: number;
  cooldown: number;
}

export const LIMIT_FIELDS = ["maxTradeUsd", "maxEpochUsd", "maxExposureUsd", "epochDuration", "maxSlippageBps", "maxOracleDeviationBps", "maxExitDiscountBps", "maxOracleAge", "cooldown"] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];

/** Which direction raises risk. A shorter epoch refills the budget sooner; a shorter cooldown trades more often. */
export const RISK_UP: Record<LimitField, "up" | "down"> = {
  maxTradeUsd: "up",
  maxEpochUsd: "up",
  maxExposureUsd: "up",
  epochDuration: "down",
  maxSlippageBps: "up",
  maxOracleDeviationBps: "up",
  maxExitDiscountBps: "up",
  maxOracleAge: "up",
  cooldown: "down",
};

/** §19 step 3 defaults (also deployments/133.json). */
export const DEFAULT_LIMITS: VaultLimits = {
  maxTradeUsd: 100n * 10n ** 8n,
  maxEpochUsd: 250n * 10n ** 8n,
  maxExposureUsd: 150n * 10n ** 8n,
  epochDuration: 86_400,
  maxSlippageBps: 250,
  maxOracleDeviationBps: 250,
  maxExitDiscountBps: 500,
  maxOracleAge: 90_000,
  cooldown: 60,
};

export interface LimitChange {
  field: LimitField;
  before: string;
  after: string;
  raisesRisk: boolean;
}

export function diffLimits(before: VaultLimits, after: VaultLimits): LimitChange[] {
  const out: LimitChange[] = [];
  for (const f of LIMIT_FIELDS) {
    const a = BigInt(before[f]);
    const b = BigInt(after[f]);
    if (a === b) continue;
    out.push({ field: f, before: fmt(f, a), after: fmt(f, b), raisesRisk: RISK_UP[f] === "up" ? b > a : b < a });
  }
  return out;
}

function fmt(f: LimitField, v: bigint): string {
  if (f === "maxTradeUsd" || f === "maxEpochUsd" || f === "maxExposureUsd") return `$${(Number(v) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (f.endsWith("Bps")) return `${v} bps`;
  return `${v} s`;
}

/** Mirrors PolicyVault.setLimits bounds (FREEZE-NOTES A.6) so we never send a reverting call. */
export function validateLimits(l: VaultLimits): string | null {
  if (l.maxEpochUsd < l.maxTradeUsd) return "the daily budget must be at least the per-trade cap";
  if (!(l.epochDuration > 0)) return "epochDuration must be > 0";
  if (l.maxSlippageBps > 1000) return "slippage must be ≤ 1000 bps";
  if (l.maxOracleDeviationBps > 1000) return "oracle deviation must be ≤ 1000 bps";
  if (l.maxExitDiscountBps < l.maxOracleDeviationBps || l.maxExitDiscountBps > 2000) return "exit discount must be ≥ oracle deviation and ≤ 2000 bps";
  if (l.maxOracleAge < 300 || l.maxOracleAge > 172_800) return "maxOracleAge must be 300–172800 s";
  if (l.cooldown < 0) return "cooldown must be ≥ 0";
  return null;
}

export function parseLimits(x: unknown): VaultLimits {
  const o = (x ?? {}) as Record<string, unknown>;
  const big = (k: LimitField) => {
    const v = o[k] ?? o[`${k}E8`]; // the daemon's /setup/limits shape names the USD caps maxTradeUsdE8 etc.
    if (typeof v === "string" && /^[0-9]{1,30}$/.test(v)) return BigInt(v);
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    throw new OwnerError(400, `limits.${k} must be a non-negative integer (USD × 1e8 for the USD caps)`);
  };
  const int = (k: LimitField) => Number(big(k));
  const l: VaultLimits = {
    maxTradeUsd: big("maxTradeUsd"),
    maxEpochUsd: big("maxEpochUsd"),
    maxExposureUsd: big("maxExposureUsd"),
    epochDuration: int("epochDuration"),
    maxSlippageBps: int("maxSlippageBps"),
    maxOracleDeviationBps: int("maxOracleDeviationBps"),
    maxExitDiscountBps: int("maxExitDiscountBps"),
    maxOracleAge: int("maxOracleAge"),
    cooldown: int("cooldown"),
  };
  const e = validateLimits(l);
  if (e) throw new OwnerError(400, e);
  return l;
}

export const limitsJson = (l: VaultLimits) => Object.fromEntries(LIMIT_FIELDS.map((f) => [f, String(l[f])])) as Record<LimitField, string>;

export type OwnerOp =
  | { op: "deploy"; markets: ("hsk" | "btc")[]; agent: Address; guardian?: Address; limits?: VaultLimits; seed?: boolean }
  | { op: "setLimits"; vaults: Address[]; limits: VaultLimits }
  | { op: "setAgent"; vaults: Address[]; agent: Address }
  | { op: "setGuardian"; vaults: Address[]; guardian: Address }
  | { op: "pause"; vaults: Address[] }
  | { op: "unpause"; vaults: Address[] }
  | { op: "withdraw"; vault: Address; token: Address; amount: bigint; to: Address }
  | { op: "fundAgent"; agent: Address; wei: bigint }
  | { op: "seed"; vaults: Address[] }
  | { op: "exportKey" };

export const OP_NAMES = ["deploy", "setLimits", "setAgent", "setGuardian", "pause", "unpause", "withdraw", "fundAgent", "seed", "exportKey"] as const;

export class OwnerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
