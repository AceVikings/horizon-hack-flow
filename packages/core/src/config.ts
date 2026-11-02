// ~/.ate/config.json schema (§16). Validated with Zod at startup; unknown keys are an error.
// FROZEN 04:30 IST.

import { z } from "zod";
import { AteError } from "./errors.js";
import { MARKET_IDS, MARKETS, TARGET_ASSETS, type MarketId } from "./markets.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x address");
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x hex value");
const usd = z.string().regex(/^[0-9]+(\.[0-9]{1,2})?$/, "expected a USD decimal string, e.g. \"25\" or \"0.10\"");
const hsk = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);
const marketId = z.enum(MARKET_IDS);
const bps = (min: number, max: number) => z.number().int().min(min).max(max);

export const marketStrategySchema = z
  .object({
    profile: z.enum(["default", "demo"]),
    generators: z.array(z.enum(["spread-revert", "rebalance"])).min(1),
    enabled: z.boolean().optional(),
    tradeSizeUsd: usd,
    maxPositionUsd: usd,
    cycleSeconds: z.number().int().min(30).max(86_400),
    entrySpreadBps: bps(10, 2000),
    minNetEdgeBps: bps(0, 2000),
    rebalanceTargetPct: z.number().int().min(0).max(100).nullable(),
    rebalanceBandPct: z.number().int().min(1).max(50),
    stopLossBps: bps(50, 5000),
    takeProfitBps: bps(10, 5000),
    reentryCooldownSec: z.number().int().min(0).max(86_400),
    /** Additive v0.9 (§11.4 rule 7), optional: default 0 (WHSK), 1800 (WBTC). */
    minEntryIntervalSec: z.number().int().min(0).max(86_400).optional(),
  })
  .strict();

export const portfolioStrategySchema = z
  .object({
    targetAssets: z.array(z.enum(TARGET_ASSETS)).refine((a) => new Set(a).size === a.length, "duplicate target asset"),
    maxDailyTurnoverUsd: usd,
    maxPortfolioExposureUsd: usd,
    dailyLossLimitUsd: usd,
    discretionaryTradesPerDay: z.number().int().min(0).max(3),
    discretionaryUsd: usd.refine((v) => Number(v) <= 10, "v0.1 maximum is $10"),
    agentTuneRange: z.tuple([z.number().positive(), z.number().positive()]),
    runTimeoutSec: z.number().int().min(10).max(600),
    /** Additive v0.9 (§11.1), optional: default 20. */
    scanSeconds: z.number().int().min(5).max(3600).optional(),
    /** max(120, 2 × p95 LLM latency); the literal string means "read deployments/177.json". */
    candidateTtlSec: z.union([z.number().int().min(120), z.literal("from deployments/177.json")]),
  })
  .strict();

const venueMarketSchema = z
  .object({
    id: marketId,
    base: z.enum(TARGET_ASSETS),
    baseDecimals: z.union([z.literal(8), z.literal(18)]),
    quote: z.literal("USDT"),
    fee: z.literal(3000),
    pool: address,
    oracle: address,
    cexSymbol: z.enum(["HSKUSDT", "BTCUSDT"]),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    chain: z
      .object({
        id: z.literal(177),
        rpcUrls: z.array(z.string().url()).min(1),
        explorer: z.string().url(),
      })
      .strict(),
    agentKeyId: z.string().min(1),
    guardian: address,
    vaults: z
      .array(z.object({ market: marketId, address }).strict())
      .min(1)
      .max(2)
      .refine((v) => new Set(v.map((x) => x.market)).size === v.length, "duplicate vault market"),
    eas: z.object({ address, schemaUid: bytes32 }).strict(),
    venues: z
      .object({
        hskdex: z
          .object({
            factory: address,
            router: address,
            quoter: address,
            routerKind: z.literal("swaprouter02"),
            markets: z.array(venueMarketSchema).min(1).max(2),
          })
          .strict(),
      })
      .strict(),
    oracle: z
      .object({
        apro: z.object({ maxAgeSec: z.number().int().min(300).max(172_800) }).strict(),
        cex: z
          .object({
            provider: z.literal("hashkey-public-market"),
            site: z.literal("glb"),
            baseUrl: z.string().url(),
            skillCommit: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    strategy: z
      .object({
        engine: z.enum(["llm", "rules"]),
        mode: z.enum(["autonomous", "confirm"]),
        enabled: z.boolean(),
        portfolio: portfolioStrategySchema,
        markets: z
          .object({
            "hsk-dex:WHSK/USDT:3000": marketStrategySchema,
            "hsk-dex:WBTC/USDT:3000": marketStrategySchema.refine(
              (m) => m.profile === "default",
              "the WBTC market cannot be given the demo profile in v0.1 (§16)",
            ),
          })
          .strict(),
      })
      .strict(),
    chat: z
      .object({
        runner: z.string().min(1),
        prompt: z.string().min(1),
        fallback: z.literal("rules"),
        runnerFlags: z.array(z.string()),
        allowedTools: z.array(z.literal("mcp__ate__*")).length(1),
      })
      .strict(),
    payments: z
      .object({
        enabled: z.boolean(),
        worker: z.string().url(),
        provider: z.literal("hsp"),
        endpoint: z.string().url(),
        transport: z.literal("streamable-http"),
        merchantName: z.string(),
        signer: z.enum(["okx-agentic-wallet", "local-eoa"]),
        fallbackSigner: z.enum(["okx-agentic-wallet", "local-eoa"]),
        requireSignApproval: z.literal(true),
        requireSubmitApproval: z.literal(true),
        signalPriceUsd: usd,
        perPaymentCapUsd: usd,
        dailyCapUsd: usd,
      })
      .strict(),
    daemon: z
      .object({
        autoLockMinutes: z.number().int().min(1),
        port: z.number().int().min(0).max(65_535),
        gasAlarmHsk: hsk,
        attestFloorHsk: hsk,
        approvalFallback: z.enum(["off", "armed", "tty"]), // "armed" additive v0.9 (§10.1)
      })
      .strict(),
    supra: z
      .object({
        storage: address,
        use: z.literal("entry-gate+crosscheck"),
        maxDisagreeBps: bps(1, 10_000),
        maxAgeSec: z.number().int().positive(),
        /** Additive (Lane B): Supra pair index per market (HSK = 517, BTC = 0). */
        pairs: z.record(marketId, z.number().int().min(0).nullable()).optional(),
        /** Additive (Lane B): Supra pull refresh (verifyOracleProof) through the TxQueue. */
        pull: z
          .object({
            enabled: z.boolean(),
            contract: address,
            proofUrl: z.string().url(),
            refreshAgeSec: z.number().int().min(60),
          })
          .strict()
          .optional(),
      })
      .strict(),
    ui: z.object({ theme: z.enum(["dark", "light"]), reducedMotion: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const venueIds = new Set(c.venues.hskdex.markets.map((m) => m.id));
    for (const v of c.vaults) {
      if (!venueIds.has(v.market)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["vaults"], message: `no venues.hskdex.markets entry for ${v.market}` });
      }
    }
    for (const m of c.venues.hskdex.markets) {
      const s = MARKETS[m.id];
      if (m.base !== s.base || m.baseDecimals !== s.baseDecimals || m.cexSymbol !== s.cexSymbol) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["venues", "hskdex", "markets"], message: `${m.id}: base/baseDecimals/cexSymbol do not match the market` });
      }
    }
  });

export type AteConfig = z.infer<typeof configSchema>;
export type MarketStrategyConfig = z.infer<typeof marketStrategySchema>;
export type PortfolioStrategyConfig = z.infer<typeof portfolioStrategySchema>;

/** Parse and validate; throws AteError(ConfigError, ATE_CONFIG_INVALID) with every issue listed. */
export function parseConfig(input: unknown): AteConfig {
  const r = configSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new AteError("ConfigError", "ATE_CONFIG_INVALID", `invalid config: ${issues.join("; ")}`, {
      hint: "Fix ~/.ate/config.json (unknown keys are an error; see SPEC §16)",
      context: { issues },
    });
  }
  return r.data;
}

/** §16 defaults for the strategy block (both markets, default profile). */
export const DEFAULT_STRATEGY_CONFIG: AteConfig["strategy"] = {
  engine: "llm",
  mode: "autonomous",
  enabled: false,
  portfolio: {
    targetAssets: ["WHSK", "WBTC"],
    maxDailyTurnoverUsd: "200",
    maxPortfolioExposureUsd: "200",
    dailyLossLimitUsd: "10",
    discretionaryTradesPerDay: 3,
    discretionaryUsd: "10",
    agentTuneRange: [0.5, 1.5],
    runTimeoutSec: 90,
    scanSeconds: 20,
    candidateTtlSec: "from deployments/177.json",
  },
  markets: {
    "hsk-dex:WHSK/USDT:3000": {
      profile: "default",
      generators: ["spread-revert", "rebalance"],
      tradeSizeUsd: "25",
      maxPositionUsd: "150",
      cycleSeconds: 120,
      entrySpreadBps: 60,
      minNetEdgeBps: 15,
      rebalanceTargetPct: 40,
      rebalanceBandPct: 10,
      stopLossBps: 300,
      takeProfitBps: 150,
      reentryCooldownSec: 14_400,
      minEntryIntervalSec: 0,
    },
    "hsk-dex:WBTC/USDT:3000": {
      profile: "default",
      generators: ["spread-revert"],
      tradeSizeUsd: "25",
      maxPositionUsd: "150",
      cycleSeconds: 120,
      entrySpreadBps: 60,
      minNetEdgeBps: 15,
      rebalanceTargetPct: null,
      rebalanceBandPct: 10,
      stopLossBps: 300,
      takeProfitBps: 150,
      reentryCooldownSec: 14_400,
      minEntryIntervalSec: 1800,
    },
  },
};

/** `--profile WHSK=demo` overrides (§11.3). WBTC never takes the demo profile. */
export const WHSK_DEMO_PROFILE_OVERRIDES = {
  profile: "demo",
  entrySpreadBps: 10,
  minNetEdgeBps: 0,
  tradeSizeUsd: "5",
  reentryCooldownSec: 600,
  rebalanceBandPct: 2,
  /** Waives the rebalance edge gate (not a config field; generators read the profile). */
} as const satisfies Partial<MarketStrategyConfig>;

export const DEFAULT_SCAN_SECONDS = 20;
export const DEFAULT_MIN_ENTRY_INTERVAL_SEC: Readonly<Record<MarketId, number>> = {
  "hsk-dex:WHSK/USDT:3000": 0,
  "hsk-dex:WBTC/USDT:3000": 1800,
};

export const CONFIG_MARKET_IDS: readonly MarketId[] = MARKET_IDS;
