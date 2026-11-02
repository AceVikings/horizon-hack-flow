// Fixtures for the Wallet view and setup step 1 (screenshots without a daemon): the owner bridge's status, and the few
// /setup reads those screens use. Every write answers "not in the demo". Public test addresses only, no keys.
import { MARKETS, MARKET_WBTC, MARKET_WHSK } from "@ate/core";
import type { Res } from "@shared/bridge";
import type { OwnerBridge, SetupBridge } from "@shared/setup-bridge";

const OWNER = "0xFF7Df888C4DE9df4c044Fd0C7144AAfd1937569e";
const AGENT = "0xC11CbceE5fDf41aa7175319691aA204eFb164f8a";
const V_HSK = "0x3B1d0aB5C7e2b8b3E4f14b8aE5b7F2C6d9A0e1F4";
const V_BTC = "0x6Da0c6EF7328d3aD6b0b8781770D941D065a6693";
const no = async (): Promise<Res<never>> => ({ ok: false, error: { code: "ATE_DAEMON_LOCKED", message: "Not available in the demo." } });
const ok = async <T,>(data: T): Promise<Res<T>> => ({ ok: true, data });
const tok = (m: typeof MARKET_WHSK, quote: string, base: string, baseUsd: string) => {
  const s = MARKETS[m] as unknown as { quoteToken: string; baseToken: string; baseDecimals: number; base: string };
  return [
    { symbol: "USDT", address: s.quoteToken, decimals: 6, amount: quote, usd: quote },
    { symbol: s.base, address: s.baseToken, decimals: s.baseDecimals, amount: base, usd: baseUsd },
  ];
};

const GET: Record<string, unknown> = {
  "/setup/fund": {
    chainId: 133,
    vaults: [
      { market: MARKET_WHSK, address: V_HSK, paused: false, usd: "212.40", tokens: tok(MARKET_WHSK, "146.86", "125.00", "65.54") },
      { market: MARKET_WBTC, address: V_BTC, paused: false, usd: "99.53", tokens: tok(MARKET_WBTC, "75.00", "0.000320", "24.53") },
    ],
    totalUsd: "311.93",
    worstDayUsd: "51.50",
    agent: { address: AGENT, hsk: "0.0062" },
    faucets: [],
    hskFaucet: "https://faucet.hsk.xyz/faucet",
  },
  "/setup/agent": { exists: false, address: null, unlocked: false, vaults: [] },
  "/setup/status": { chainId: 133, state: { vaultsConfirmedAt: null }, vaults: [] },
  "/setup/vaults": { found: 0, vaults: [], owner: null, ownerMatches: false, ownerIsContract: false },
  "/setup/networks": [
    { chainId: 133, rpc: "https://testnet.hsk.xyz", ms: 182, block: "4512331", ok: true, explorer: "https://testnet-explorer.hskchain.net", deployment: null, current: true },
    { chainId: 177, rpc: "https://mainnet.hsk.xyz", ms: 240, block: "9120044", ok: true, explorer: "https://hsk.blockscout.com", deployment: null, current: false },
  ],
};

const WRITES = ["post", "open", "unlock", "start", "stop", "daemon", "keygen", "approveStart", "approveFinish"];
export const FIXTURE_SETUP = new Proxy({} as SetupBridge, {
  get: (_t, k) => (k === "get" ? (path: string) => (path in GET ? ok(GET[path]) : no()) : WRITES.includes(String(k)) ? no : undefined),
});

export const FIXTURE_OWNER: OwnerBridge = {
  status: () => ok({ ready: true, address: OWNER, chainId: 133, gasHsk: location.hash.includes("setup") ? "0" : "0.4183" }),
  createVaults: no,
  setAgent: no,
  setLimits: no,
  unpause: no,
  withdraw: no,
  fundAgent: no,
  // Demo only: a made-up key so the backup screen can be shown. It controls nothing.
  exportKey: () => ok({ address: OWNER, privateKey: `0x${"5eed".repeat(16)}` }),
};
