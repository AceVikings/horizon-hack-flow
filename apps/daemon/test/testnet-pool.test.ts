import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { TestnetPool, gapBps, isqrt, targetSqrtPriceX96 } from "../src/testnet-pool.js";

const BTC = { answer: 7_800_000_000_000n, oracleDecimals: 8, dec0: 8, dec1: 6 }; // $78,000 (8-dec feed), WBTC/USDT
const MM_KEY = `0x${"11".repeat(32)}`;
const markets = () => [{ id: "hsk-dex:WBTC/USDT:3000", pool: "0x9d6A06ae873aD5d34ef13Ac8afE3BA80d1A5eF07" as const, oracle: "0x9bbb840B9e1086177507D958E40668f3cEF99372" as const }];

describe("testnet pool gap (RecenterTestnetPool port)", () => {
  it("isqrt is the floor square root", () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 40n + 7n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
  });
  it("the target sits on the oracle at 0 bps and the requested gap otherwise", () => {
    for (const offsetBps of [0, -150, 200]) {
      const sqrtPriceX96 = targetSqrtPriceX96({ ...BTC, offsetBps });
      expect(gapBps({ ...BTC, sqrtPriceX96 })).toBeCloseTo(offsetBps, 0);
    }
    expect(() => targetSqrtPriceX96({ ...BTC, offsetBps: 6000 })).toThrow(/offsetBps/);
    expect(() => targetSqrtPriceX96({ ...BTC, answer: 0n, offsetBps: 0 })).toThrow(/no price/);
  });
  it("matches the deployed BTC pool's initial price (deployments/133.json)", () => {
    // initSqrtPriceX96 2220892021050474177496512004077 at Supra $78,577.05
    const s = targetSqrtPriceX96({ answer: 7_857_705_000_000n, oracleDecimals: 8, dec0: 8, dec1: 6, offsetBps: 0 });
    expect(Number((s - 2220892021050474177496512004077n) * 10_000n / s)).toBe(0);
  });
  it("is off on any chain but 133, and never runs with the agent key or the Flow wallet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ate-mm-"));
    const keyFile = join(dir, "mm.json");
    writeFileSync(keyFile, JSON.stringify([{ address: privateKeyToAccount(MM_KEY as `0x${string}`).address, private_key: MM_KEY }]));
    const env = { ATE_TESTNET_MM_KEY: keyFile };
    const main = new TestnetPool({ chainId: () => 177, rpcUrl: () => "http://127.0.0.1:9", markets, forbidden: () => [], env });
    expect(await main.status()).toMatchObject({ available: false, chainId: 177, maker: null });
    await expect(main.move("btc", -150)).rejects.toThrow(/testnet/);
    const asAgent = new TestnetPool({ chainId: () => 133, rpcUrl: () => "http://127.0.0.1:9", markets, forbidden: () => [privateKeyToAccount(MM_KEY as `0x${string}`).address.toLowerCase()], env });
    await expect(asAgent.move("btc", -150)).rejects.toThrow(/must not be the agent key or the Flow wallet/);
    const none = new TestnetPool({ chainId: () => 133, rpcUrl: () => "http://127.0.0.1:9", markets, forbidden: () => [], env: { ATE_TESTNET_MM_KEY: join(dir, "missing.json") } });
    await expect(none.move("btc", -150)).rejects.toThrow(/no market-maker key/);
    await expect(none.move("eth", -150)).rejects.toThrow(/no eth market/);
    // the key itself never appears in an error
    await asAgent.move("btc", -150).catch((e: Error) => expect(e.message).not.toContain(MM_KEY.slice(2)));
  });
});
