// candidateTtlSec in deployments/177.json (§11.1): measured over the --dry-run cycles, max(120, 2 × p95).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MIN_CANDIDATE_TTL_SEC } from "@ate/core";

/** Reads `candidateTtlSec` (top level or under `trader`) from deployments/177.json; falls back to 120. */
export function readCandidateTtl(path: string): { ttlSec: number; source: string } {
  if (!existsSync(path)) return { ttlSec: MIN_CANDIDATE_TTL_SEC, source: `default (${path} missing)` };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { candidateTtlSec?: unknown; trader?: { candidateTtlSec?: unknown } };
    const v = Number(j.trader?.candidateTtlSec ?? j.candidateTtlSec);
    if (Number.isInteger(v) && v >= MIN_CANDIDATE_TTL_SEC) return { ttlSec: v, source: path };
    return { ttlSec: MIN_CANDIDATE_TTL_SEC, source: `default (no valid candidateTtlSec in ${path})` };
  } catch {
    return { ttlSec: MIN_CANDIDATE_TTL_SEC, source: `default (${path} unreadable)` };
  }
}

/** Merges `trader: { candidateTtlSec, p95LatencyMs, measuredCycles, measuredAt }` into deployments/177.json. */
export function writeCandidateTtl(path: string, m: { ttlSec: number; p95Ms: number | null; cycles: number; at: number }): void {
  const j = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  j.candidateTtlSec = m.ttlSec;
  j.trader = { ...((j.trader as object) ?? {}), candidateTtlSec: m.ttlSec, p95LatencyMs: m.p95Ms, measuredCycles: m.cycles, measuredAt: new Date(m.at).toISOString() };
  writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
}
