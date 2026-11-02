import { describe, expect, it } from "vitest";
import { JsonRpcError, RpcPool } from "../src/index.js";

type R = { status: number; body: string; headers?: Record<string, string> };
function fakeFetch(script: Record<string, R[]>) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const q = script[url]!;
    const r = q.length > 1 ? q.shift()! : q[0]!;
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (result: string): R => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
const sleep = async () => {};

describe("RpcPool (§18.1 retry + failover)", () => {
  it("retries 429 honouring Retry-After, then succeeds", async () => {
    const slept: number[] = [];
    const { f } = fakeFetch({ a: [{ status: 429, body: "slow down", headers: { "retry-after": "2" } }, ok("0xb1")] });
    const p = new RpcPool({ urls: ["a"], fetchImpl: f, sleep: async (ms) => void slept.push(ms) });
    expect(await p.request("eth_chainId")).toBe("0xb1");
    expect(slept).toEqual([2000]);
  });

  it("fails over to the second RPC after 3 retries", async () => {
    const { f, calls } = fakeFetch({ a: [{ status: 502, body: "bad gateway" }], b: [ok("0x1")] });
    const p = new RpcPool({ urls: ["a", "b"], fetchImpl: f, sleep });
    expect(await p.request("eth_blockNumber")).toBe("0x1");
    expect(calls.filter((c) => c === "a")).toHaveLength(4);
    expect(p.activeUrl).toBe("b");
  });

  it("Cloudflare 1015 bans the RPC for 10 minutes", async () => {
    let now = 0;
    const { f, calls } = fakeFetch({ a: [{ status: 429, body: "error code: 1015" }], b: [ok("0x2")] });
    const p = new RpcPool({ urls: ["a", "b"], fetchImpl: f, sleep, now: () => now });
    await p.request("eth_blockNumber");
    await p.request("eth_blockNumber");
    expect(calls.filter((c) => c === "a")).toHaveLength(1);
    now = 10 * 60_000 + 1;
    (p as unknown as { cursor: number }).cursor = 0;
    await p.request("eth_blockNumber");
    expect(calls.filter((c) => c === "a")).toHaveLength(2);
  });

  it("JSON-RPC errors (reverts) are returned at once with data", async () => {
    const { f, calls } = fakeFetch({ a: [{ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0xdeadbeef" } }) }] });
    const p = new RpcPool({ urls: ["a", "b"], fetchImpl: f, sleep });
    await expect(p.request("eth_call")).rejects.toMatchObject({ code: 3, data: "0xdeadbeef" });
    await expect(p.request("eth_call")).rejects.toBeInstanceOf(JsonRpcError);
    expect(calls).toEqual(["a", "a"]);
  });

  it("429 from every RPC → ATE_RPC_RATE_LIMITED", async () => {
    const { f } = fakeFetch({ a: [{ status: 429, body: "x" }], b: [{ status: 429, body: "y" }] });
    const p = new RpcPool({ urls: ["a", "b"], fetchImpl: f, sleep });
    await expect(p.request("eth_blockNumber")).rejects.toMatchObject({ code: "ATE_RPC_RATE_LIMITED", retryable: true });
  });
});
