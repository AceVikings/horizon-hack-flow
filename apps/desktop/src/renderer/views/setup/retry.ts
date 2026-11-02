// Setup reads that must not hang: a time budget per attempt, retries with backoff (StepConnect).
import type { Res } from "@shared/bridge";

/** Backoff before retry n (0-based): 1 s, 2 s, 4 s, 8 s. */
export const retryDelayMs = (n: number) => 1000 * 2 ** Math.min(n, 3);
/** Per-attempt time budget for a setup GET; the daemon itself gives up on a call after 20 s. */
export const SETUP_GET_TIMEOUT_MS = 15_000;

/** Run `get` with a time budget per attempt, retrying failures (or results `bad` rejects) with backoff. */
export async function getWithRetry<T>(get: () => Promise<Res<T>>, opts: { tries: number; timeoutMs?: number; bad?(d: T): boolean; alive?(): boolean; sleep?(ms: number): Promise<void> }): Promise<Res<T>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = opts.timeoutMs ?? SETUP_GET_TIMEOUT_MS;
  let last: Res<T> = { ok: false, error: { code: "ATE_INTERNAL", message: "timed out" } } as Res<T>;
  for (let i = 0; i < Math.max(1, opts.tries); i++) {
    if (i > 0) await sleep(retryDelayMs(i - 1));
    if (opts.alive && !opts.alive()) return last;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Res<T>>((r) => (timer = setTimeout(() => r({ ok: false, error: { code: "ATE_INTERNAL", message: "timed out" } } as Res<T>), budget)));
    last = await Promise.race([get().catch((e: Error) => ({ ok: false, error: { code: "ATE_INTERNAL", message: e.message } }) as Res<T>), timeout]);
    clearTimeout(timer);
    if (last.ok && !(opts.bad && opts.bad(last.data))) return last;
  }
  return last;
}

