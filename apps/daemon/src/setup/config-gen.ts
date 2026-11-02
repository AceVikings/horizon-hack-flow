// config.json from deployments/<chainId>.json (the in-app equivalent of scripts/testnet-config.mjs, no terminal).
// Starts from the §16 fixture config and swaps in the chain, vaults, tokens, venue, Supra and EAS of the deployment.
// The strategy ships disabled; "Start trading" (setup step 6) enables it.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { MARKET_IDS, parseConfig, type AteConfig, type MarketId } from "@ate/core";
import { FIXTURE_CONFIG } from "@ate/core/fixtures";
import { findDeployments } from "../daemon.js";

export interface Deployment {
  chainId: number;
  owner?: string;
  agent?: string;
  guardian: string;
  explorer: string;
  rpcUrls: string[];
  candidateTtlSec?: number;
  deployedBlock?: number;
  eas: { address: string; schemaUid: string; schemaRegistry?: string };
  hskdex: { factory: string; router: string; quoter: string };
  limits: Record<string, number>;
  markets: Record<string, { vault: string; pool: string; adapter: string; priceToken: string; quoteToken: string; supraPair: number; fee?: number }>;
  supra: { storage: string; pull: string; proofUrl: string };
  tokens?: Record<string, { address: string; decimals: number; symbol: string; faucetAmount?: number }>;
}

export const NETWORKS = {
  133: { label: "HashKey Chain testnet", rpcUrls: ["https://testnet.hsk.xyz"], explorer: "https://testnet-explorer.hskchain.net", faucet: "https://faucet.hsk.xyz/faucet" },
  177: { label: "HashKey Chain", rpcUrls: ["https://mainnet.hsk.xyz"], explorer: "https://hsk.blockscout.com", faucet: null },
} as const;
export type ChainId = keyof typeof NETWORKS;
export const isChainId = (x: unknown): x is ChainId => x === 133 || x === 177;

export function loadDeployment(chainId: ChainId, env: NodeJS.ProcessEnv = process.env): { path: string; d: Deployment } | null {
  // ATE_DEPLOYMENTS points at one file; only use it when its chain matches.
  const p = findDeployments({ ...env, ATE_DEPLOYMENTS: env.ATE_DEPLOYMENTS && existsSync(env.ATE_DEPLOYMENTS) && JSON.parse(readFileSync(env.ATE_DEPLOYMENTS, "utf8")).chainId === chainId ? env.ATE_DEPLOYMENTS : undefined }, chainId);
  if (!p) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as Deployment;
    return d.chainId === chainId ? { path: p, d } : null;
  } catch {
    return null;
  }
}

export const newAgentKeyId = (chainId: number) => `flow-${chainId}-${randomBytes(4).toString("hex")}`;

export function buildConfig(o: { chainId: ChainId; deployment: Deployment | null; agentKeyId: string; rpcUrls?: string[] }): AteConfig {
  const c = structuredClone(FIXTURE_CONFIG) as unknown as AteConfig;
  const net = NETWORKS[o.chainId];
  c.agentKeyId = o.agentKeyId;
  c.strategy.enabled = false;
  c.daemon = { ...c.daemon, approvalFallback: "armed" };
  const d = o.deployment;
  c.chain = { id: o.chainId, rpcUrls: o.rpcUrls?.length ? o.rpcUrls : d?.rpcUrls?.length ? d.rpcUrls : [...net.rpcUrls], explorer: d?.explorer ?? net.explorer };
  if (!d) return parseConfig(c);
  const ids = MARKET_IDS.filter((m) => d.markets[m]);
  c.guardian = d.guardian as AteConfig["guardian"];
  c.vaults = ids.map((m) => ({ market: m, address: d.markets[m]!.vault as `0x${string}` }));
  c.eas = { address: d.eas.address as `0x${string}`, schemaUid: d.eas.schemaUid as `0x${string}` };
  c.venues.hskdex = {
    ...c.venues.hskdex,
    factory: d.hskdex.factory as `0x${string}`,
    router: d.hskdex.router as `0x${string}`,
    quoter: d.hskdex.quoter as `0x${string}`,
    markets: c.venues.hskdex.markets
      .filter((m) => d.markets[m.id])
      .map((m) => ({ ...m, pool: d.markets[m.id]!.pool as `0x${string}`, oracle: d.markets[m.id]!.adapter as `0x${string}`, baseToken: d.markets[m.id]!.priceToken as `0x${string}`, quoteToken: d.markets[m.id]!.quoteToken as `0x${string}` })),
  };
  if (d.limits.maxOracleAge) c.oracle.apro.maxAgeSec = Math.min(172_800, Math.max(300, d.limits.maxOracleAge));
  c.strategy.portfolio.candidateTtlSec = d.candidateTtlSec ?? 180;
  if (o.chainId === 133) {
    c.strategy.portfolio.scanSeconds = 20;
    // testnet gas is ~1 gwei and the faucet gives 1 HSK/day: alarm and attest floor scaled down
    c.daemon = { ...c.daemon, gasAlarmHsk: "0.01", attestFloorHsk: "0.001" };
  }
  c.supra = {
    storage: d.supra.storage as `0x${string}`,
    use: "entry-gate+crosscheck",
    maxDisagreeBps: 250,
    maxAgeSec: d.limits.maxOracleAge ?? c.supra.maxAgeSec,
    pairs: Object.fromEntries(ids.map((m) => [m, d.markets[m]!.supraPair])) as Partial<Record<MarketId, number>>,
    pull: { enabled: true, contract: d.supra.pull as `0x${string}`, proofUrl: d.supra.proofUrl, refreshAgeSec: 43_200 },
  };
  return parseConfig(c);
}

/** Replace the vault addresses (custom / freshly deployed vaults on the same venue). */
export function withVaults(cfg: AteConfig, vaults: { market: MarketId; address: `0x${string}` }[]): AteConfig {
  return parseConfig({ ...structuredClone(cfg), vaults });
}
