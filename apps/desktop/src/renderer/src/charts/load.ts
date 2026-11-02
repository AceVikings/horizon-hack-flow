// Chart request with a hard timeout: never leaves a chart "loading" forever. A rejected IPC call (e.g. a main
// process without the handler), a thrown error or a slow daemon all become a plain error result.
import type { Res } from "@shared/bridge";

export const CHART_TIMEOUT_MS = 15_000;

export async function loadWithTimeout<T>(call: () => Promise<Res<T>>, ms = CHART_TIMEOUT_MS): Promise<Res<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Res<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: { code: "ATE_INTERNAL", message: "The price took too long to load." } }), ms);
  });
  try {
    const r = await Promise.race([
      Promise.resolve()
        .then(call)
        .catch((e: unknown): Res<T> => ({ ok: false, error: { code: "ATE_INTERNAL", message: e instanceof Error ? e.message : String(e) } })),
      timeout,
    ]);
    return r && typeof r === "object" && "ok" in r ? r : { ok: false, error: { code: "ATE_INTERNAL", message: "No answer from Flow." } };
  } finally {
    clearTimeout(timer);
  }
}

/** True when a spec has no data points at all. */
export function isEmptySpec(spec: { series: { candles?: unknown[]; points?: unknown[] }[] }): boolean {
  return spec.series.every((s) => (s.candles?.length ?? 0) + (s.points?.length ?? 0) === 0);
}
