// Resumable setup progress (desktop onboarding, docs/design/flow 00–06): <ATE_HOME>/setup.json, mode 0600.
// No secrets live here: addresses, timestamps and the step the user reached.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TraderMode = "autonomous" | "confirm" | "watch";
export type VaultSource = "deployment" | "deploy" | "custom";

export interface HandoffRecord {
  id: string;
  kind: string;
  market?: string;
  createdAt: number;
  doneAt?: number;
  txs: { label: string; to: string | null; data: string; value: string }[];
}

export interface SetupState {
  v: 1;
  /** 0 = welcome, 1..6 = the six setup steps, 7 = done. The step the user is on (resume here). */
  step: number;
  chainId: 133 | 177 | null;
  vaultSource: VaultSource | null;
  vaultsConfirmedAt: number | null;
  agent: { address: string; createdAt: number; imported: boolean } | null;
  healthPassedAt: number | null;
  limitsAckAt: number | null;
  plannedDepositUsd: number | null;
  traderMode: TraderMode | null;
  /** Default model for the in-app agents (Settings → AI & data). */
  model: string | null;
  completedAt: number | null;
  handoffs: Record<string, HandoffRecord>;
  updatedAt: number;
}

export const EMPTY_SETUP: SetupState = {
  v: 1,
  step: 0,
  chainId: null,
  vaultSource: null,
  vaultsConfirmedAt: null,
  agent: null,
  healthPassedAt: null,
  limitsAckAt: null,
  plannedDepositUsd: null,
  traderMode: null,
  model: null,
  completedAt: null,
  handoffs: {},
  updatedAt: 0,
};

export const setupPath = (home: string) => join(home, "setup.json");

export function readSetup(home: string): SetupState {
  const p = setupPath(home);
  if (!existsSync(p)) return structuredClone(EMPTY_SETUP);
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<SetupState>;
    return { ...structuredClone(EMPTY_SETUP), ...j, handoffs: j.handoffs ?? {} };
  } catch {
    return structuredClone(EMPTY_SETUP);
  }
}

export function writeSetup(home: string, s: SetupState): SetupState {
  const p = setupPath(home);
  const next = { ...s, updatedAt: Math.floor(Date.now() / 1000) };
  writeFileSync(`${p}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  chmodSync(p, 0o600);
  return next;
}

const PATCHABLE = ["step", "plannedDepositUsd", "traderMode", "limitsAckAt", "healthPassedAt"] as const;

/** Renderer-driven fields only (step pointer, acknowledgements). Chain facts are written by the routes. */
export function patchSetup(home: string, patch: Record<string, unknown>): SetupState {
  const s = readSetup(home);
  for (const k of PATCHABLE) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (k === "step") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 7) throw new Error("step must be an integer 0..7");
      s.step = v;
    } else if (k === "traderMode") {
      if (v !== "autonomous" && v !== "confirm" && v !== "watch") throw new Error("bad traderMode");
      s.traderMode = v;
    } else if (k === "plannedDepositUsd") {
      if (typeof v !== "number" || !(v >= 0) || v > 1e9) throw new Error("bad plannedDepositUsd");
      s.plannedDepositUsd = v;
    } else {
      if (v !== null && typeof v !== "number") throw new Error(`bad ${k}`);
      s[k] = v as number | null;
    }
  }
  return writeSetup(home, s);
}
