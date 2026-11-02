// Markets, tokens and chain constants (SPEC §0.2, §4.1, §6.2, §16).
// FROZEN 04:30 IST — lanes may add, never change, without a lead-approved freeze bump.

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export const CHAIN_ID = 177 as const;

/** The only two valid `market` values in v0.1 (§6.2). Anything else → ATE_MARKET_UNKNOWN. */
export const MARKET_IDS = ["hsk-dex:WHSK/USDT:3000", "hsk-dex:WBTC/USDT:3000"] as const;
export type MarketId = (typeof MARKET_IDS)[number];

export const MARKET_WHSK: MarketId = "hsk-dex:WHSK/USDT:3000";
export const MARKET_WBTC: MarketId = "hsk-dex:WBTC/USDT:3000";

/** `targetAssets` values (§7.4 ate_strategy_set). */
export const TARGET_ASSETS = ["WHSK", "WBTC"] as const;
export type TargetAsset = (typeof TARGET_ASSETS)[number];

export type Side = "buy" | "sell";
export type PriceDecimals = 8 | 18;

export const TOKENS = {
  USDT: { symbol: "USDT", address: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029", decimals: 6 },
  WHSK: { symbol: "WHSK", address: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1", decimals: 18 },
  WBTC: { symbol: "WBTC", address: "0x6119ca49a79f5825c8b345f8d7ac36b272565b14", decimals: 8 },
} as const satisfies Record<string, { symbol: string; address: Address; decimals: number }>;

export const HSKDEX = {
  factory: "0x972cA9D1662F5e029cD18327D29026532E84c742",
  router: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3", // SwapRouter02 (7-field exactInputSingle)
  quoter: "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD", // QuoterV2
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, Address>;

export const EAS = {
  schemaRegistry: "0x4200000000000000000000000000000000000020",
  eas: "0x4200000000000000000000000000000000000021",
} as const satisfies Record<string, Address>;

export const SUPRA_STORAGE: Address = "0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57";

export interface MarketStatic {
  id: MarketId;
  venue: "hsk-dex";
  asset: TargetAsset;
  /** priceToken (token0 of the pool). */
  base: TargetAsset;
  baseToken: Address;
  baseDecimals: PriceDecimals;
  /** quoteToken (token1 of the pool). */
  quote: "USDT";
  quoteToken: Address;
  quoteDecimals: 6;
  /** Pool fee in hundredths of a bip (3000 = 0.30%). */
  fee: 3000;
  pool: Address;
  /** APRO AggregatorV3 feed, 8 dp. */
  oracle: Address;
  cexSymbol: "HSKUSDT" | "BTCUSDT";
  /** Human label used in UI and chat ("HSK", "BTC"). */
  label: "HSK" | "BTC";
}

export const MARKETS: Readonly<Record<MarketId, MarketStatic>> = {
  "hsk-dex:WHSK/USDT:3000": {
    id: "hsk-dex:WHSK/USDT:3000",
    venue: "hsk-dex",
    asset: "WHSK",
    base: "WHSK",
    baseToken: TOKENS.WHSK.address,
    baseDecimals: 18,
    quote: "USDT",
    quoteToken: TOKENS.USDT.address,
    quoteDecimals: 6,
    fee: 3000,
    pool: "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc",
    oracle: "0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b",
    cexSymbol: "HSKUSDT",
    label: "HSK",
  },
  "hsk-dex:WBTC/USDT:3000": {
    id: "hsk-dex:WBTC/USDT:3000",
    venue: "hsk-dex",
    asset: "WBTC",
    base: "WBTC",
    baseToken: TOKENS.WBTC.address,
    baseDecimals: 8,
    quote: "USDT",
    quoteToken: TOKENS.USDT.address,
    quoteDecimals: 6,
    fee: 3000,
    pool: "0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A",
    oracle: "0x204ED500ab56A2E19B051561258E3A45c850360F",
    cexSymbol: "BTCUSDT",
    label: "BTC",
  },
};

export function isMarketId(x: unknown): x is MarketId {
  return typeof x === "string" && (MARKET_IDS as readonly string[]).includes(x);
}

export function marketForAsset(asset: TargetAsset): MarketId {
  return asset === "WHSK" ? MARKET_WHSK : MARKET_WBTC;
}

export function assetForMarket(market: MarketId): TargetAsset {
  return MARKETS[market].asset;
}

/** tokenIn for a side: buy spends USDT, sell spends the priceToken (§7.4). */
export function tokenInFor(market: MarketId, side: Side): { token: Address; decimals: number; symbol: string } {
  const m = MARKETS[market];
  return side === "buy"
    ? { token: m.quoteToken, decimals: m.quoteDecimals, symbol: m.quote }
    : { token: m.baseToken, decimals: m.baseDecimals, symbol: m.base };
}

// ---- Additive (Lane B, after contracts 974cbf0): vault `oracle` = SupraAggregatorAdapter; APRO = cross-check only.
export const SUPRA_PULL: Address = "0x16f70cAD28dd621b0072B5A8a8c392970E87C3dD";
export const SUPRA_PROOF_URL = "https://rpc-mainnet-dora-2.supra.com/get_proof";
/** Supra S-Value pair index per market (HSK/USD 517, BTC/USD 0; contracts/ABI-NOTES.md). */
export const SUPRA_PAIRS: Readonly<Record<MarketId, number>> = {
  "hsk-dex:WHSK/USDT:3000": 517,
  "hsk-dex:WBTC/USDT:3000": 0,
};

// ---- Additive (testnet): HashKey Chain TESTNET 133. Mainnet (177) values above stay the defaults; a 133 config
// rewrites TOKENS / MARKETS / HSKDEX in place at startup via `configureNetwork` (see `applyConfigNetwork`).
export const SUPPORTED_CHAIN_IDS = [177, 133] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];
export const TESTNET_CHAIN_ID = 133 as const;

/** Static testnet addresses (HSKSwap V3 testnet, Supra testnet, OP-stack predeploys). Test tokens/pools/vaults
 * are per-deployment: deployments/133.json. */
export const HSK_TESTNET = {
  chainId: 133,
  rpcUrls: ["https://testnet.hsk.xyz"],
  explorer: "https://testnet-explorer.hskchain.net",
  hskdex: {
    factory: "0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0",
    router: "0xa6914E66690c6794244B5f66a09eAEbf66254237",
    quoter: "0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC",
    positionManager: "0x73dEc6bfa6751509b08480bd97f54b874E3b20e8",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  },
  supra: {
    storage: "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917",
    pull: "0x443A0f4Da5d2fdC47de3eeD45Af41d399F0E5702",
    proofUrl: "https://rpc-testnet-dora-2.supra.com/get_proof",
  },
  eas: EAS,
} as const;

export interface NetworkOverrides {
  chainId: SupportedChainId;
  hskdex?: { factory?: string; router?: string; quoter?: string; multicall3?: string };
  markets?: Partial<Record<MarketId, { pool?: string; oracle?: string; baseToken?: string; quoteToken?: string }>>;
}

let activeChain: SupportedChainId = CHAIN_ID;
/** Chain the process is configured for (177 unless `configureNetwork` ran). */
export function activeChainId(): SupportedChainId {
  return activeChain;
}

/** Points the shared market/token/venue constants at another network (testnet 133). Process-wide; call once at
 * startup, before any reads. A no-op for 177 without overrides. */
export function configureNetwork(o: NetworkOverrides): void {
  activeChain = o.chainId;
  const hx = HSKDEX as unknown as Record<string, string>;
  for (const [k, v] of Object.entries(o.hskdex ?? {})) if (v) hx[k] = v;
  const tok = TOKENS as unknown as Record<string, { address: string }>;
  for (const [id, ov] of Object.entries(o.markets ?? {})) {
    const m = MARKETS[id as MarketId] as unknown as Record<string, string>;
    if (!m || !ov) continue;
    if (ov.pool) m.pool = ov.pool;
    if (ov.oracle) m.oracle = ov.oracle;
    if (ov.baseToken) {
      m.baseToken = ov.baseToken;
      tok[m.base!]!.address = ov.baseToken;
    }
    if (ov.quoteToken) {
      m.quoteToken = ov.quoteToken;
      tok.USDT!.address = ov.quoteToken;
    }
  }
}
