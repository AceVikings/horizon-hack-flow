// EAS attester for executed trades (SPEC §13, §4.2 gas float, §7.1 TxQueue). Lane E.
//
// This module never signs or sends. It builds the unsigned `EAS.attest` call for the daemon's TxQueue
// (lowest priority, "attest"), decides enqueue vs. defer from the gas float, tracks retries (3×, then
// failed), parses the attestation UID from the receipt and shapes the `attestation` journal record.
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  isHex,
  parseAbiParameters,
  parseEther,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { AteError } from "@ate/core";
import {
  EAS_ADDRESS,
  SCHEMA_REGISTRY_ADDRESS,
  TRADE_ATTESTATION_RESOLVER,
  TRADE_ATTESTATION_REVOCABLE,
  TRADE_ATTESTATION_SCHEMA,
  TRADE_ATTESTATION_SCHEMA_UID,
  easAbi,
  schemaRegistryAbi,
} from "./schema.js";

const DATA_PARAMS = parseAbiParameters(TRADE_ATTESTATION_SCHEMA);

export type AttestEngine = "llm" | "rules" | "guard" | "human";
export type AttestOrigin = "candidate" | "discretionary" | "guard" | "human" | "smoke";

/** One executed trade, as known after its `TradeExecuted` receipt. */
export interface TradeAttestationInput {
  /** Full journal hash of the proposal record (= on-chain `SwapParams.proposalId`), bytes32. */
  proposalId: Hex;
  rationaleHash: Hex;
  /** Hash of the vault `execute` tx. */
  txHash: Hex;
  /** Trade notional in 8-dp USD (the vault's `notionalUsd` from `TradeExecuted`/`check()`). */
  notionalUsdE8: bigint | string;
  exitPath: boolean;
  engine: AttestEngine;
  origin: AttestOrigin;
  /** The trade's vault — the attestation `recipient`, identifies the market (§13). */
  vault: Address;
}

export interface DecodedTradeAttestation {
  proposalId: Hex;
  rationaleHash: Hex;
  txHash: Hex;
  notionalUsdE8: bigint;
  exitPath: boolean;
  engine: string;
  origin: string;
}

/** Unsigned tx for the daemon's TxQueue. `priority: "attest"` is the lowest class (§7.1). */
export interface AttestTxRequest {
  kind: "eas.attest";
  priority: "attest";
  to: Address;
  data: Hex;
  value: 0n;
  /** Conservative gas limit hint; the queue may estimate instead. */
  gasHint: bigint;
  /** Correlates the receipt back to the proposal. */
  proposalId: Hex;
  schemaUid: Hex;
}

function bytes32(x: Hex, name: string): Hex {
  if (!isHex(x) || x.length !== 66) throw new AteError("AttestationError", "ATE_INTERNAL", `${name} must be bytes32`);
  return x.toLowerCase() as Hex;
}

export function encodeTradeAttestationData(t: TradeAttestationInput): Hex {
  const notional = typeof t.notionalUsdE8 === "bigint" ? t.notionalUsdE8 : BigInt(t.notionalUsdE8);
  if (notional < 0n) throw new AteError("AttestationError", "ATE_INTERNAL", "notionalUsdE8 must be ≥ 0");
  return encodeAbiParameters(DATA_PARAMS, [
    bytes32(t.proposalId, "proposalId"),
    bytes32(t.rationaleHash, "rationaleHash"),
    bytes32(t.txHash, "txHash"),
    notional,
    t.exitPath,
    t.engine,
    t.origin,
  ]);
}

export function decodeTradeAttestationData(data: Hex): DecodedTradeAttestation {
  const [proposalId, rationaleHash, txHash, notionalUsdE8, exitPath, engine, origin] = decodeAbiParameters(DATA_PARAMS, data);
  return { proposalId, rationaleHash, txHash, notionalUsdE8, exitPath, engine, origin };
}

export interface BuildAttestOptions {
  schemaUid?: Hex;
  eas?: Address;
}

/** Builds the `EAS.attest` call: recipient = vault, no expiry, non-revocable, no refUID, value 0. */
export function buildAttestTx(t: TradeAttestationInput, opts: BuildAttestOptions = {}): AttestTxRequest {
  const schema = opts.schemaUid ?? TRADE_ATTESTATION_SCHEMA_UID;
  const data = encodeFunctionData({
    abi: easAbi,
    functionName: "attest",
    args: [
      {
        schema,
        data: {
          recipient: t.vault,
          expirationTime: 0n,
          revocable: TRADE_ATTESTATION_REVOCABLE,
          refUID: zeroHash,
          data: encodeTradeAttestationData(t),
          value: 0n,
        },
      },
    ],
  });
  return {
    kind: "eas.attest",
    priority: "attest",
    to: opts.eas ?? EAS_ADDRESS,
    data,
    value: 0n,
    gasHint: 400_000n,
    proposalId: bytes32(t.proposalId, "proposalId"),
    schemaUid: schema,
  };
}

/** Unsigned `SchemaRegistry.register` call (§19 step 2; signed by ops, not the daemon). */
export function buildRegisterSchemaTx(): { to: Address; data: Hex; value: 0n; expectedUid: Hex } {
  return {
    to: SCHEMA_REGISTRY_ADDRESS,
    data: encodeFunctionData({
      abi: schemaRegistryAbi,
      functionName: "register",
      args: [TRADE_ATTESTATION_SCHEMA, TRADE_ATTESTATION_RESOLVER, TRADE_ATTESTATION_REVOCABLE],
    }),
    value: 0n,
    expectedUid: TRADE_ATTESTATION_SCHEMA_UID,
  };
}

export interface ReceiptLike {
  status: "success" | "reverted";
  transactionHash: Hex;
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
}

/** Attestation UID from the `Attested` event of an `EAS.attest` receipt, or null if absent. */
export function parseAttestedUid(receipt: ReceiptLike, eas: Address = EAS_ADDRESS): Hex | null {
  if (receipt.status !== "success") return null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== eas.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: easAbi, eventName: "Attested", topics: log.topics as [Hex, ...Hex[]], data: log.data });
      return ev.args.uid;
    } catch {
      // not an Attested log
    }
  }
  return null;
}

// ------------------------------------------------------------------ retry / defer bookkeeping

export const ATTEST_MAX_ATTEMPTS = 3;

export type AttestPlan =
  | { action: "enqueue"; tx: AttestTxRequest; attempt: number }
  | { action: "defer"; reason: "gas_floor"; agentHsk: string; floorHsk: string }
  | { action: "give_up"; attempts: number; lastError: string };

/** Payload for the daemon's single-writer journal API: an `attestation` record (§13). */
export interface AttestationJournalInput {
  kind: "attestation";
  /** Proposal decision id (`prop_…`). */
  refId: string;
  engine: AttestEngine;
  origin: AttestOrigin;
  status: "attested" | "deferred" | "failed";
  attestation?: { easUid: Hex; schemaUid: Hex; txHash: Hex };
  rationale: string;
  verdict: { ok: boolean; code: "OK" | "ATE_GAS_LOW" | "ATE_INTERNAL"; message?: string };
}

interface Pending {
  input: TradeAttestationInput;
  decisionId: string;
  attempts: number;
  lastError?: string;
  deferred: boolean;
}

export interface AttesterOptions {
  schemaUid?: Hex;
  eas?: Address;
  /** §16 `daemon.attestFloorHsk` (default "1"). Below it, attestations are deferred (§4.2 gas float). */
  attestFloorHsk?: string;
}

/**
 * Stateful helper the daemon owns (one instance). Flow:
 *   plan(trade) → enqueue tx in TxQueue → onMined(receipt) | onFailed(err) → journal record.
 * Deferred items are back-filled by `drainDeferred(agentHsk)` after a top-up.
 */
export class Attester {
  readonly schemaUid: Hex;
  readonly eas: Address;
  private readonly floorWei: bigint;
  private readonly floorHsk: string;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: AttesterOptions = {}) {
    this.schemaUid = opts.schemaUid ?? TRADE_ATTESTATION_SCHEMA_UID;
    this.eas = opts.eas ?? EAS_ADDRESS;
    this.floorHsk = opts.attestFloorHsk ?? "1";
    this.floorWei = parseEther(this.floorHsk);
  }

  private key(proposalId: Hex): string {
    return proposalId.toLowerCase();
  }

  /** Call once per `TradeExecuted` receipt. `agentBalanceWei` = agent key's HSK balance. */
  plan(input: TradeAttestationInput, decisionId: string, agentBalanceWei: bigint): AttestPlan {
    const k = this.key(input.proposalId);
    const p = this.pending.get(k) ?? { input, decisionId, attempts: 0, deferred: false };
    this.pending.set(k, p);
    return this.next(p, agentBalanceWei);
  }

  private next(p: Pending, agentBalanceWei: bigint): AttestPlan {
    if (p.attempts >= ATTEST_MAX_ATTEMPTS) {
      return { action: "give_up", attempts: p.attempts, lastError: p.lastError ?? "unknown" };
    }
    if (agentBalanceWei < this.floorWei) {
      p.deferred = true;
      return { action: "defer", reason: "gas_floor", agentHsk: formatHsk(agentBalanceWei), floorHsk: this.floorHsk };
    }
    p.deferred = false;
    p.attempts += 1;
    return { action: "enqueue", tx: buildAttestTx(p.input, { schemaUid: this.schemaUid, eas: this.eas }), attempt: p.attempts };
  }

  /** Attest tx mined. Returns the journal record (attested, or a retry plan if the receipt has no UID). */
  onMined(
    receipt: ReceiptLike,
    agentBalanceWei: bigint,
  ): { record: AttestationJournalInput } | { retry: AttestPlan } {
    const uid = parseAttestedUid(receipt, this.eas);
    const p = this.findByTx(receipt) ?? null;
    if (!p) throw new AteError("AttestationError", "ATE_INTERNAL", "receipt does not match a pending attestation");
    if (!uid) return { retry: this.onFailed(p.input.proposalId, `attest tx ${receipt.transactionHash} ${receipt.status}`, agentBalanceWei) };
    this.pending.delete(this.key(p.input.proposalId));
    return {
      record: {
        kind: "attestation",
        refId: p.decisionId,
        engine: p.input.engine,
        origin: p.input.origin,
        status: "attested",
        attestation: { easUid: uid, schemaUid: this.schemaUid, txHash: receipt.transactionHash },
        rationale: `EAS attestation of executed trade ${p.input.txHash}`,
        verdict: { ok: true, code: "OK" },
      },
    };
  }

  private lastTx = new Map<string, string>();

  /** The queue reports which tx hash carries the attest for `proposalId` (needed to match receipts). */
  onSubmitted(proposalId: Hex, txHash: Hex): void {
    this.lastTx.set(txHash.toLowerCase(), this.key(proposalId));
  }

  private findByTx(receipt: ReceiptLike): Pending | undefined {
    const k = this.lastTx.get(receipt.transactionHash.toLowerCase());
    if (k) return this.pending.get(k);
    return this.pending.size === 1 ? [...this.pending.values()][0] : undefined;
  }

  /** Attest send/revert failed. Returns the next plan; `give_up` after 3 attempts. */
  onFailed(proposalId: Hex, error: string, agentBalanceWei: bigint): AttestPlan {
    const p = this.pending.get(this.key(proposalId));
    if (!p) throw new AteError("AttestationError", "ATE_INTERNAL", `no pending attestation for ${proposalId}`);
    p.lastError = error;
    return this.next(p, agentBalanceWei);
  }

  /** Journal record for a give-up (after 3 attempts) or a deferral. Drops give-ups from the pending set. */
  failureRecord(proposalId: Hex, status: "deferred" | "failed"): AttestationJournalInput {
    const k = this.key(proposalId);
    const p = this.pending.get(k);
    if (!p) throw new AteError("AttestationError", "ATE_INTERNAL", `no pending attestation for ${proposalId}`);
    if (status === "failed") this.pending.delete(k);
    return {
      kind: "attestation",
      refId: p.decisionId,
      engine: p.input.engine,
      origin: p.input.origin,
      status,
      rationale:
        status === "deferred"
          ? `EAS attestation deferred: agent gas below ${this.floorHsk} HSK; back-filled after top-up`
          : `EAS attestation failed after ${p.attempts} attempts: ${p.lastError ?? "unknown"}`,
      verdict:
        status === "deferred"
          ? { ok: false, code: "ATE_GAS_LOW", message: "attestation deferred" }
          : { ok: false, code: "ATE_INTERNAL", message: p.lastError ?? "attestation failed" },
    };
  }

  /** Deferred attestations count (for `/status` `gas.attestationsDeferred`). */
  deferredCount(): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.deferred) n++;
    return n;
  }

  /** After a top-up: plans for every deferred attestation (oldest first). */
  drainDeferred(agentBalanceWei: bigint): AttestPlan[] {
    const out: AttestPlan[] = [];
    for (const p of this.pending.values()) if (p.deferred) out.push(this.next(p, agentBalanceWei));
    return out;
  }
}

function formatHsk(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Blockscout read link for the judge path tx → attestation → journal (§13). */
export function easGetAttestationCall(uid: Hex): { to: Address; data: Hex } {
  return { to: EAS_ADDRESS, data: encodeFunctionData({ abi: easAbi, functionName: "getAttestation", args: [uid] }) };
}
