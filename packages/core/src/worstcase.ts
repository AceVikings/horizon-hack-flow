// Worst-case execution loss (SPEC §4.6), from live `limits()`. Pure and shared by the daemon (setup routes) and
// the desktop (Limits screen recomputes as sliders move). Per vault; the portfolio bound is the sum over vaults.
//
//   A                 = max(maxOracleDeviationBps, 250)
//   normalPerEpoch    = maxEpochUsd × (A + maxSlippageBps + feeBps) / 10000
//   maxLossPerEpoch   = maxEpochUsd × (A + maxExitDiscountBps + maxSlippageBps + feeBps) / 10000
//   rolling 24 h      = 2 × per-epoch (one epoch boundary inside the window)

/** The oracle assumption: Supra within 250 bps of fair value (§4.6). */
export const ORACLE_ASSUMPTION_BPS = 250;
/** HSKSwap pool fee tier of both markets (0.30%). */
export const POOL_FEE_BPS = 30;

export interface WorstCaseLimits {
  /** USD with 8 decimals (wire form `maxEpochUsdE8`). */
  maxEpochUsdE8: string | bigint;
  maxSlippageBps: number;
  maxOracleDeviationBps: number;
  maxExitDiscountBps: number;
  feeBps?: number;
}

export interface WorstCaseVault {
  /** Basis points of the per-epoch budget that the worst path can lose. */
  oracleBps: number;
  exitBps: number;
  slippageBps: number;
  feeBps: number;
  totalBps: number;
  normalBps: number;
  epochUsdE8: bigint;
  /** Per vault, per epoch (UTC day), all paths. */
  maxLossUsdE8: bigint;
  /** Per vault, per epoch, normal path only. */
  normalLossUsdE8: bigint;
}

export interface WorstCase {
  vaults: WorstCaseVault[];
  /** Portfolio, per epoch, all paths (the pitch number: $51.50 at defaults). */
  maxLossUsdE8: bigint;
  normalLossUsdE8: bigint;
  rolling24hUsdE8: bigint;
}

export function worstCaseVault(l: WorstCaseLimits): WorstCaseVault {
  const feeBps = l.feeBps ?? POOL_FEE_BPS;
  const oracleBps = Math.max(l.maxOracleDeviationBps, ORACLE_ASSUMPTION_BPS);
  const normalBps = oracleBps + l.maxSlippageBps + feeBps;
  const totalBps = normalBps + l.maxExitDiscountBps;
  const epochUsdE8 = BigInt(l.maxEpochUsdE8);
  return {
    oracleBps,
    exitBps: l.maxExitDiscountBps,
    slippageBps: l.maxSlippageBps,
    feeBps,
    totalBps,
    normalBps,
    epochUsdE8,
    maxLossUsdE8: (epochUsdE8 * BigInt(totalBps)) / 10_000n,
    normalLossUsdE8: (epochUsdE8 * BigInt(normalBps)) / 10_000n,
  };
}

export function worstCase(limits: WorstCaseLimits[]): WorstCase {
  const vaults = limits.map(worstCaseVault);
  const maxLossUsdE8 = vaults.reduce((a, v) => a + v.maxLossUsdE8, 0n);
  return { vaults, maxLossUsdE8, normalLossUsdE8: vaults.reduce((a, v) => a + v.normalLossUsdE8, 0n), rolling24hUsdE8: 2n * maxLossUsdE8 };
}
