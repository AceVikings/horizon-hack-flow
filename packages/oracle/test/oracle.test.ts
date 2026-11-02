import { describe, expect, it } from "vitest";
import { CexReader, buildSupraPullTx, decToUnits, fetchSupraProof, oracleHealth } from "../src/index.js";

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

describe("oracle helpers", () => {
  it("decToUnits truncates", () => {
    expect(decToUnits("0.0871", 8)).toBe(8_710_000n);
    expect(decToUnits("78502.123456789", 8)).toBe(7_850_212_345_678n);
  });
  it("health badges (§5.2)", () => {
    expect(oracleHealth(100, 90_000)).toBe("fresh");
    expect(oracleHealth(4000, 90_000)).toBe("aging");
    expect(oracleHealth(90_000, 90_000)).toBe("stale");
  });
  it("HashKey Global bookTicker → CexSnapshot (mid, half-spread, top depth, timestamp)", async () => {
    const f = (async () => json([{ s: "HSKUSDT", b: "0.0871", bq: "5704.16", a: "0.0873", aq: "2381.02", t: 1793594481562 }])) as unknown as typeof fetch;
    const s = await new CexReader({ baseUrl: "https://x", fetchImpl: f }).snapshot("HSKUSDT");
    expect(s).toMatchObject({ symbol: "HSKUSDT", mid: "8720000", halfSpreadBps: 11, at: 1793594481, topDepthUsd: "207.86" });
  });
  it("CEX failure → null (spread generators emit nothing, §5.3)", async () => {
    const f = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    expect(await new CexReader({ baseUrl: "https://x", fetchImpl: f }).snapshot("BTCUSDT")).toBeNull();
  });
  it("Supra pull: get_proof body and verifyOracleProof calldata", async () => {
    let body = "";
    const f = (async (_u: string, init: RequestInit) => ((body = String(init.body)), json({ proof_bytes: "abcd" }))) as unknown as typeof fetch;
    const p = await fetchSupraProof("https://supra", [0, 517], f);
    expect(JSON.parse(body)).toEqual({ pair_indexes: [0, 517], chain_type: "evm" });
    expect(p).toBe("0xabcd");
    expect(buildSupraPullTx("0x16f70cAD28dd621b0072B5A8a8c392970E87C3dD", p).data.slice(0, 10)).toBe("0xb3a076f4");
  });
});
