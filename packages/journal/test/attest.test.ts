import { describe, expect, it } from "vitest";
import {
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseEther,
  stringToHex,
  zeroHash,
  type Hex,
} from "viem";
import {
  ATTEST_MAX_ATTEMPTS,
  Attester,
  EAS_ADDRESS,
  SCHEMA_REGISTRY_ADDRESS,
  TRADE_ATTESTATION_SCHEMA,
  TRADE_ATTESTATION_SCHEMA_UID,
  buildAttestTx,
  buildRegisterSchemaTx,
  decodeTradeAttestationData,
  easAbi,
  parseAttestedUid,
  schemaRegistryAbi,
  type TradeAttestationInput,
} from "../src/attest/index.js";

const VAULT = "0x1111111111111111111111111111111111111111" as const;
const trade: TradeAttestationInput = {
  proposalId: `0x${"aa".repeat(32)}`,
  rationaleHash: `0x${"bb".repeat(32)}`,
  txHash: `0x${"cc".repeat(32)}`,
  notionalUsdE8: 2_500_000_000n,
  exitPath: false,
  engine: "llm",
  origin: "candidate",
  vault: VAULT,
};

function attestedReceipt(uid: Hex, txHash: Hex = `0x${"dd".repeat(32)}`) {
  const topics = encodeEventTopics({
    abi: easAbi,
    eventName: "Attested",
    args: { recipient: VAULT, attester: "0x2222222222222222222222222222222222222222", schemaUID: TRADE_ATTESTATION_SCHEMA_UID },
  }) as Hex[];
  return {
    status: "success" as const,
    transactionHash: txHash,
    logs: [{ address: EAS_ADDRESS, topics, data: encodeAbiParameters([{ type: "bytes32" }], [uid]) }],
  };
}

describe("EAS schema (§13)", () => {
  it("is the §13 field list verbatim, incl. origin", () => {
    expect(TRADE_ATTESTATION_SCHEMA).toBe(
      "bytes32 proposalId,bytes32 rationaleHash,bytes32 txHash,uint256 notionalUsd,bool exitPath,string engine,string origin",
    );
  });

  it("UID = keccak256(schema ‖ resolver ‖ revocable) (SchemaRegistry._getUID)", () => {
    const manual = keccak256(concatHex([stringToHex(TRADE_ATTESTATION_SCHEMA), `0x${"00".repeat(20)}`, "0x00"]));
    expect(TRADE_ATTESTATION_SCHEMA_UID).toBe(manual);
  });

  it("register tx targets the predeploy with the schema, no resolver, non-revocable", () => {
    const tx = buildRegisterSchemaTx();
    expect(tx.to).toBe(SCHEMA_REGISTRY_ADDRESS);
    const d = decodeFunctionData({ abi: schemaRegistryAbi, data: tx.data });
    expect(d.functionName).toBe("register");
    expect(d.args).toEqual([TRADE_ATTESTATION_SCHEMA, "0x0000000000000000000000000000000000000000", false]);
    expect(tx.expectedUid).toBe(TRADE_ATTESTATION_SCHEMA_UID);
  });
});

describe("buildAttestTx", () => {
  it("encodes EAS.attest with recipient = vault, non-revocable, no expiry, lowest priority", () => {
    const tx = buildAttestTx(trade);
    expect(tx.to).toBe("0x4200000000000000000000000000000000000021");
    expect(tx.priority).toBe("attest");
    expect(tx.value).toBe(0n);
    const d = decodeFunctionData({ abi: easAbi, data: tx.data });
    expect(d.functionName).toBe("attest");
    const req = (d.args as unknown as [{ schema: Hex; data: { recipient: string; expirationTime: bigint; revocable: boolean; refUID: Hex; data: Hex; value: bigint } }])[0];
    expect(req.schema).toBe(TRADE_ATTESTATION_SCHEMA_UID);
    expect(req.data.recipient.toLowerCase()).toBe(VAULT);
    expect(req.data.expirationTime).toBe(0n);
    expect(req.data.revocable).toBe(false);
    expect(req.data.refUID).toBe(zeroHash);
    expect(decodeTradeAttestationData(req.data.data)).toEqual({
      proposalId: trade.proposalId,
      rationaleHash: trade.rationaleHash,
      txHash: trade.txHash,
      notionalUsdE8: 2_500_000_000n,
      exitPath: false,
      engine: "llm",
      origin: "candidate",
    });
  });

  it("accepts a decimal-string notional and a custom schema UID", () => {
    const tx = buildAttestTx({ ...trade, notionalUsdE8: "500000000", exitPath: true, origin: "discretionary" }, { schemaUid: `0x${"ef".repeat(32)}` });
    expect(tx.schemaUid).toBe(`0x${"ef".repeat(32)}`);
  });

  it("rejects non-bytes32 hashes", () => {
    expect(() => buildAttestTx({ ...trade, txHash: "0x1234" })).toThrow(/bytes32/);
  });
});

describe("parseAttestedUid", () => {
  it("reads the UID from the Attested log", () => {
    const uid = `0x${"12".repeat(32)}` as Hex;
    expect(parseAttestedUid(attestedReceipt(uid))).toBe(uid);
  });
  it("returns null for a reverted receipt or foreign logs", () => {
    expect(parseAttestedUid({ ...attestedReceipt(zeroHash), status: "reverted" })).toBeNull();
    const r = attestedReceipt(zeroHash);
    expect(parseAttestedUid({ ...r, logs: r.logs.map((l) => ({ ...l, address: VAULT })) })).toBeNull();
  });
});

describe("Attester bookkeeping (retry 3×, defer below floor, back-fill)", () => {
  const rich = parseEther("5");
  const poor = parseEther("0.5");

  it("enqueue → mined → attestation journal record with UID", () => {
    const a = new Attester();
    const plan = a.plan(trade, "prop_aaaa", rich);
    expect(plan.action).toBe("enqueue");
    const txHash = `0x${"dd".repeat(32)}` as Hex;
    a.onSubmitted(trade.proposalId, txHash);
    const uid = `0x${"34".repeat(32)}` as Hex;
    const res = a.onMined(attestedReceipt(uid, txHash), rich);
    expect("record" in res && res.record).toMatchObject({
      kind: "attestation",
      refId: "prop_aaaa",
      status: "attested",
      attestation: { easUid: uid, schemaUid: TRADE_ATTESTATION_SCHEMA_UID, txHash },
      verdict: { ok: true, code: "OK" },
    });
  });

  it("retries 3× then gives up with a failed record", () => {
    const a = new Attester();
    expect(a.plan(trade, "prop_x", rich)).toMatchObject({ action: "enqueue", attempt: 1 });
    expect(a.onFailed(trade.proposalId, "nonce too low", rich)).toMatchObject({ action: "enqueue", attempt: 2 });
    expect(a.onFailed(trade.proposalId, "reverted", rich)).toMatchObject({ action: "enqueue", attempt: 3 });
    const last = a.onFailed(trade.proposalId, "reverted", rich);
    expect(last).toEqual({ action: "give_up", attempts: ATTEST_MAX_ATTEMPTS, lastError: "reverted" });
    expect(a.failureRecord(trade.proposalId, "failed")).toMatchObject({ status: "failed", verdict: { ok: false } });
  });

  it("defers below the gas floor and back-fills after top-up", () => {
    const a = new Attester({ attestFloorHsk: "1" });
    expect(a.plan(trade, "prop_x", poor)).toMatchObject({ action: "defer", agentHsk: "0.5", floorHsk: "1" });
    expect(a.deferredCount()).toBe(1);
    expect(a.failureRecord(trade.proposalId, "deferred")).toMatchObject({ status: "deferred", verdict: { code: "ATE_GAS_LOW" } });
    const plans = a.drainDeferred(rich);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ action: "enqueue", attempt: 1 });
    expect(a.deferredCount()).toBe(0);
  });

  it("a mined receipt without an Attested log counts as a failed attempt", () => {
    const a = new Attester();
    a.plan(trade, "prop_x", rich);
    const txHash = `0x${"ee".repeat(32)}` as Hex;
    a.onSubmitted(trade.proposalId, txHash);
    const res = a.onMined({ status: "reverted", transactionHash: txHash, logs: [] }, rich);
    expect("retry" in res && res.retry).toMatchObject({ action: "enqueue", attempt: 2 });
  });
});
