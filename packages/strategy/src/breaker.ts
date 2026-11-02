// Daily loss circuit breaker (§11.4 rule 6): flatten first for at most 2 cycles or 5 min, then pause both
// vaults regardless, journal any unflattened exposure, notify the user.

import type { UnixSec } from "@ate/core";
import { usdE8 } from "./units.js";

export const BREAKER_MAX_FLATTEN_CYCLES = 2;
export const BREAKER_MAX_FLATTEN_SEC = 300;

export interface BreakerState {
  state: "armed" | "flattening" | "tripped";
  since: UnixSec | null;
  /** UTC day the state belongs to. */
  day: string;
  /** Cycles completed while flattening. */
  cycles: number;
}

export interface BreakerInput {
  now: UnixSec;
  utcDay: string;
  dailyPnlUsd: string;
  dailyLossLimitUsd: string;
  /** All positions below dust (flatten complete). */
  flat: boolean;
  /** True when this step is a cycle boundary (counts towards the 2-cycle bound). */
  cycle: boolean;
}

export type BreakerAction = "flatten" | "invalidate_buys" | "pause_all" | "notify" | "journal_unflattened";

export const initialBreaker = (day: string): BreakerState => ({ state: "armed", since: null, day, cycles: 0 });

export function stepBreaker(s: BreakerState, i: BreakerInput): { state: BreakerState; actions: BreakerAction[] } {
  // A new UTC day re-arms (the vaults stay paused until the owner unpauses).
  if (i.utcDay !== s.day) s = initialBreaker(i.utcDay);
  const actions: BreakerAction[] = [];
  if (s.state === "armed") {
    if (usdE8(i.dailyPnlUsd) <= -usdE8(i.dailyLossLimitUsd)) {
      return { state: { state: "flattening", since: i.now, day: s.day, cycles: 0 }, actions: ["invalidate_buys", "flatten", "notify"] };
    }
    return { state: s, actions };
  }
  if (s.state === "flattening") {
    const cycles = s.cycles + (i.cycle ? 1 : 0);
    const elapsed = i.now - (s.since ?? i.now);
    if (i.flat || cycles >= BREAKER_MAX_FLATTEN_CYCLES || elapsed >= BREAKER_MAX_FLATTEN_SEC) {
      const a: BreakerAction[] = ["pause_all", "notify"];
      if (!i.flat) a.push("journal_unflattened");
      return { state: { ...s, state: "tripped", cycles }, actions: a };
    }
    return { state: { ...s, cycles }, actions: ["flatten"] };
  }
  return { state: s, actions };
}
