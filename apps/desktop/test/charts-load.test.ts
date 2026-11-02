import { describe, expect, it, vi } from "vitest";
import { isEmptySpec, loadWithTimeout } from "../src/renderer/src/charts/load";

describe("chart loading never hangs", () => {
  it("passes a result through", async () => {
    expect(await loadWithTimeout(async () => ({ ok: true as const, data: 1 }))).toEqual({ ok: true, data: 1 });
  });
  it("turns a rejected IPC call into an error result", async () => {
    const r = await loadWithTimeout(() => Promise.reject(new Error("No handler registered for 'ate:charts.chart'")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/No handler/);
  });
  it("turns a synchronous throw and an undefined answer into error results", async () => {
    expect((await loadWithTimeout(() => { throw new Error("boom"); })).ok).toBe(false);
    expect((await loadWithTimeout(async () => undefined as never)).ok).toBe(false);
  });
  it("times out a request that never answers", async () => {
    vi.useFakeTimers();
    const p = loadWithTimeout(() => new Promise(() => {}), 15_000);
    await vi.advanceTimersByTimeAsync(15_001);
    const r = await p;
    vi.useRealTimers();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/too long/);
  });
  it("detects an empty spec", () => {
    expect(isEmptySpec({ series: [{ candles: [] }] })).toBe(true);
    expect(isEmptySpec({ series: [{ candles: [{}] }] })).toBe(false);
  });
});
