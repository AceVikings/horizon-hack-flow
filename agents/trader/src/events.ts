// Daemon /events subscription (§10.1): `cycle.requested` (POST /cycle, scan gap, human strategy change) →
// an out-of-schedule cycle through the same no-overlap lock (§11.1). Node 22 global WebSocket, token in query.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeJson } from "@ate/core";

export type CycleRequestReason = "manual" | "gap" | "strategy_change";

export function readRuntimeJson(home: string): RuntimeJson | null {
  const p = join(home, "runtime.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RuntimeJson;
  } catch {
    return null;
  }
}

/** Parses one /events message; returns the cycle.requested reason or null. */
export function cycleRequestOf(msg: string): CycleRequestReason | null {
  try {
    const e = JSON.parse(msg) as { type?: string; data?: { reason?: string } };
    if (e.type !== "cycle.requested") return null;
    const r = e.data?.reason;
    return r === "gap" || r === "strategy_change" || r === "manual" ? r : "manual";
  } catch {
    return null;
  }
}

export function subscribeCycleRequests(o: { port: number; token: string; onRequest: (r: CycleRequestReason) => void; log?: (m: string) => void }): { close(): void } {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 1000;
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`ws://127.0.0.1:${o.port}/events?token=${encodeURIComponent(o.token)}`);
    ws.onopen = () => {
      backoff = 1000;
      o.log?.("subscribed to daemon /events (cycle.requested)");
    };
    ws.onmessage = (ev) => {
      const r = cycleRequestOf(String(ev.data));
      if (r) o.onRequest(r);
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, backoff).unref();
      backoff = Math.min(30_000, backoff * 2);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  };
  connect();
  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}
