import { describe, expect, it } from "vitest";
import { getWithRetry, retryDelayMs } from "../src/renderer/views/setup/retry";

const noSleep = async () => {};

describe("setup reads retry and time out", () => {
  it("backs off 1 s, 2 s, 4 s, 8 s", () => {
    expect([0, 1, 2, 3, 9].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 8000]);
  });
  it("retries a timed-out first call and returns the next answer", async () => {
    let n = 0;
    const r = await getWithRetry(() => (n++ === 0 ? new Promise<never>(() => {}) : Promise.resolve({ ok: true as const, data: 7 })), { tries: 3, timeoutMs: 20, sleep: noSleep });
    expect(r).toEqual({ ok: true, data: 7 });
    expect(n).toBe(2);
  });
  it("retries results the caller marks bad, then gives up with the last result", async () => {
    let n = 0;
    const r = await getWithRetry(async () => ({ ok: true as const, data: ++n }), { tries: 3, bad: () => true, sleep: noSleep });
    expect(n).toBe(3);
    expect(r).toEqual({ ok: true, data: 3 });
  });
  it("turns a rejected call into an error after all tries", async () => {
    const r = await getWithRetry(() => Promise.reject(new Error("ECONNREFUSED")), { tries: 2, sleep: noSleep });
    expect(r.ok).toBe(false);
  });
});
