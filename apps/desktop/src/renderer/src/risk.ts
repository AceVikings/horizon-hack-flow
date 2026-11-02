// Worst-case loss USED today (SPEC §4.6, README §6), over @ate/core's worstCaseVault (the bound itself):
//   bound bps  = max(maxOracleDeviationBps, 250) + maxExitDiscountBps + maxSlippageBps + feeBps   (1030 at defaults)
//   max/epoch  = maxEpochUsd × bound / 10000      ($25.75 per vault per UTC day; $51.50 for two)
//   used       = epoch().spentUsd × bound / 10000 (the part of that ceiling already put at risk this epoch)
import { worstCaseVault, type VaultState } from "@ate/core";

export interface VaultRisk {
  market: VaultState["market"];
  bps: number;
  /** 8-dp USD integers. */
  usedE8: bigint;
  maxE8: bigint;
  spentE8: bigint;
  capE8: bigint;
  exposureE8: bigint;
  maxExposureE8: bigint;
  /** Epoch end (the UTC day boundary for 86,400 s epochs). */
  resetsAt: number;
}

export function vaultRisk(v: VaultState): VaultRisk {
  const w = worstCaseVault(v.limits);
  const bps = BigInt(w.totalBps);
  const spent = BigInt(v.epoch.spentUsdE8);
  return {
    market: v.market,
    bps: w.totalBps,
    usedE8: (spent * bps) / 10_000n,
    maxE8: w.maxLossUsdE8,
    spentE8: spent,
    capE8: BigInt(v.epoch.capUsdE8 || v.limits.maxEpochUsdE8),
    exposureE8: BigInt(v.exposureUsdE8),
    maxExposureE8: BigInt(v.limits.maxExposureUsdE8),
    resetsAt: v.epoch.start + v.limits.epochDuration,
  };
}

export function portfolioRisk(vs: VaultState[]): { usedE8: bigint; maxE8: bigint; pct: number; vaults: VaultRisk[] } {
  const vaults = vs.map(vaultRisk);
  const usedE8 = vaults.reduce((a, v) => a + v.usedE8, 0n);
  const maxE8 = vaults.reduce((a, v) => a + v.maxE8, 0n);
  return { usedE8, maxE8, pct: maxE8 > 0n ? Number((usedE8 * 10_000n) / maxE8) / 100 : 0, vaults };
}

/** 8-dp integer → "$6.44" (half-up to cents). Grouped, never abbreviated. */
export function centsE8(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const cents = (a + 500_000n) / 1_000_000n;
  const s = `${cents / 100n}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + `${cents % 100n}`.padStart(2, "0");
  return `${neg ? "−" : ""}$${s}`;
}
