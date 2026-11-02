import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Address, type Hex } from "viem";
import { createApprovalVerifier, keyIdOf, payloadBytes, type ApprovalPayload } from "@ate/approve";
import {
  CapLedger,
  MemoryPaymentStore,
  PAYMENT_EVENTS,
  PAYMENT_STATES,
  PaymentAgent,
  TERMINAL_STATES,
  TRANSITIONS,
  capEffect,
  conditionsHash,
  createLocalEoaSigner,
  createMcpHspClient,
  missingHspTools,
  newOfferId,
  nextPollDelaySec,
  nextState,
  redact,
  shouldBuySignal,
  signConditions,
  toViemTypedData,
  transition,
  usdToMicro,
  verifyConditions,
  type PaymentConditions,
  type PaymentRecord,
} from "../src/index.js";
import { MockHsp, type MockHspOptions } from "../src/testing.js";

// ------------------------------------------------------------------ harness

function softKey(): { priv: KeyObject; pubHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return { priv: privateKey, pubHex: `04${Buffer.from(jwk.x, "base64url").toString("hex")}${Buffer.from(jwk.y, "base64url").toString("hex")}` };
}
const seSign = (priv: KeyObject, p: ApprovalPayload) => nodeSign("sha256", payloadBytes(p), { key: priv, dsaEncoding: "der" }).toString("base64");

const signalAgent = privateKeyToAccount(generatePrivateKey());
const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
const PAY_TO = signalAgent.address;
const TOKEN = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6" as Address;

let t: number;
const now = () => t;

async function harness(o: Partial<MockHspOptions> & { dailyCapUsd?: string; paused?: boolean; balance?: bigint } = {}) {
  const hsp = new MockHsp({ now, ...o });
  const se = softKey();
  const store = new MemoryPaymentStore();
  const caps = new CapLedger({ perPaymentCapUsd: "0.10", dailyCapUsd: o.dailyCapUsd ?? "1.00" });
  const updates: { id: string; state: string; event: string }[] = [];
  let signerCalls = 0;
  const inner = createLocalEoaSigner({ privateKey: payerKey });
  const agent = new PaymentAgent({
    hsp,
    signer: { kind: "local-eoa", address: inner.address, signTypedData: (td) => (signerCalls++, inner.signTypedData(td)) },
    store,
    caps,
    verifier: createApprovalVerifier({ publicKey: se.pubHex, keyId: keyIdOf(se.pubHex) }, "ate-pay"),
    signalAgent: signalAgent.address,
    signalPayTo: PAY_TO,
    merchantName: "Vikings",
    balanceOf: async () => o.balance ?? 10_000_000n,
    isVaultPaused: async () => o.paused ?? false,
    now,
    onUpdate: (r, event) => updates.push({ id: r.id, state: r.state, event }),
  });
  const offer = async (price = "0.02"): Promise<PaymentConditions> => {
    const order = await hsp.createOrder({ merchantName: "Vikings", amountUsd: price, payTo: PAY_TO, productName: "whsk-fair-value-15m" });
    return signConditions(
      {
        offerId: newOfferId(),
        orderId: order.orderId,
        product: "whsk-fair-value-15m",
        priceUsd: price,
        payTo: PAY_TO,
        merchantName: "Vikings",
        network: { chainId: 133, token: TOKEN, decimals: 6 },
        expiresAt: now() + 300,
        signalTtlSec: 900,
      },
      signalAgent,
    );
  };
  const approve = (r: PaymentRecord, stage: "sign" | "submit", key = se.priv) => agent.approve(r.id, stage, seSign(key, r.awaiting!.payload));
  return { hsp, agent, store, caps, updates, offer, approve, se, signerCalls: () => signerCalls };
}

beforeEach(() => {
  t = 1_800_000_000;
});

// ------------------------------------------------------------------ state machine

describe("§9.4 transition table", () => {
  it("every row is reachable and maps to the spec's next state", () => {
    const expectRows: [string, string, string][] = [
      ["CREATED", "prepared", "PREPARED"],
      ["PREPARED", "sign_approved", "SIGN_APPROVED"],
      ["PREPARED", "sign_denied", "FAILED_DENIED"],
      ["SIGN_APPROVED", "sign_denied", "FAILED_DENIED"],
      ["SIGN_APPROVED", "signed", "SIGNED"],
      ["SIGNED", "finalized", "AUTH_FINALIZED"],
      ["AUTH_FINALIZED", "submit_approved", "SUBMIT_APPROVED"],
      ["AUTH_FINALIZED", "submit_denied", "FAILED_DENIED"],
      ["SUBMIT_APPROVED", "submit_ok", "SUBMITTED"],
      ["SUBMIT_APPROVED", "submit_uncertain", "UNCERTAIN"],
      ["SUBMITTED", "query_safe", "SAFE"],
      ["UNCERTAIN", "query_safe", "SAFE"],
      ["SUBMITTED", "query_finalized_attributed", "SETTLED"],
      ["SAFE", "query_finalized_attributed", "SETTLED"],
      ["UNCERTAIN", "query_finalized_attributed", "SETTLED"],
      ["SAFE", "query_finalized_unattributed", "SETTLED_UNATTRIBUTED"],
      ["SUBMITTED", "no_definitive_result", "UNCERTAIN"],
      ["SAFE", "no_definitive_result", "UNCERTAIN"],
    ];
    for (const [from, ev, to] of expectRows) expect(transition(from as never, ev as never)).toBe(to);
    for (const s of ["CREATED", "PREPARED", "SIGN_APPROVED", "SIGNED", "AUTH_FINALIZED", "SUBMIT_APPROVED"] as const) {
      expect(nextState(s, "quote_expired")).toBe("EXPIRED");
    }
    for (const s of ["SUBMITTED", "SAFE", "UNCERTAIN"] as const) expect(nextState(s, "quote_expired")).toBeUndefined();
    for (const s of PAYMENT_STATES.filter((x) => !TERMINAL_STATES.includes(x))) expect(nextState(s, "query_failed")).toBe("FAILED");
  });

  it("terminal states accept no event; illegal transitions throw", () => {
    for (const s of TERMINAL_STATES) for (const e of PAYMENT_EVENTS) expect(nextState(s, e)).toBeUndefined();
    expect(() => transition("PREPARED", "submit_ok")).toThrow(/illegal/);
    expect(() => transition("UNCERTAIN", "submit_ok")).toThrow(/illegal/); // never resubmit
    expect(TRANSITIONS.every((r) => PAYMENT_EVENTS.includes(r.event))).toBe(true);
  });

  it("cap effects: release on FAILED/EXPIRED/early denial, lapse-release on denial #2, consume on settle", () => {
    expect(capEffect("FAILED", "SUBMITTED")).toBe("release");
    expect(capEffect("EXPIRED", "PREPARED")).toBe("release");
    expect(capEffect("FAILED_DENIED", "PREPARED")).toBe("release");
    expect(capEffect("FAILED_DENIED", "AUTH_FINALIZED")).toBe("release_when_lapsed");
    expect(capEffect("UNCERTAIN", "SUBMIT_APPROVED")).toBe("keep");
    expect(capEffect("SETTLED_UNATTRIBUTED", "SAFE")).toBe("consume");
  });

  it("polling: 3 s for 120 s, then 30 s up to 10 min", () => {
    expect(nextPollDelaySec(0)).toBe(3);
    expect(nextPollDelaySec(119)).toBe(3);
    expect(nextPollDelaySec(120)).toBe(30);
    expect(nextPollDelaySec(599)).toBe(30);
    expect(nextPollDelaySec(600)).toBeNull();
  });
});

// ------------------------------------------------------------------ conditions + policy

describe("§9.2/§9.3 conditions", () => {
  const chain = { network: "hashkey-testnet", chainId: 133, token: TOKEN, tokenSymbol: "USDC", decimals: 6, paymentProtocol: "x402-v2" };
  const base = async () =>
    signConditions(
      {
        offerId: newOfferId(),
        orderId: "ord_1",
        product: "whsk-fair-value-15m",
        priceUsd: "0.02",
        payTo: PAY_TO,
        merchantName: "Vikings",
        network: { chainId: 133, token: TOKEN, decimals: 6 },
        expiresAt: now() + 300,
        signalTtlSec: 900,
      },
      signalAgent,
    );

  it("verifies signer, expiry and network; hash is stable and signature-independent", async () => {
    const c = await base();
    const r = await verifyConditions(c, { signalAgent: signalAgent.address, chain, now: now() });
    expect(r.conditionsHash).toBe(conditionsHash({ ...c, signature: "0x" }));
  });

  it("rejects a foreign signer, tampering, expiry, > 300 s ahead, network or protocol mismatch", async () => {
    const c = await base();
    const v = (x: PaymentConditions, ch = chain, n = now()) => verifyConditions(x, { signalAgent: signalAgent.address, chain: ch, now: n });
    const mallory = privateKeyToAccount(generatePrivateKey());
    const { signature: _s, ...unsigned } = c;
    await expect(v(await signConditions(unsigned, mallory))).rejects.toMatchObject({ code: "ATE_PAYMENT_CONDITIONS_INVALID" });
    await expect(v({ ...c, priceUsd: "0.01" })).rejects.toMatchObject({ code: "ATE_PAYMENT_CONDITIONS_INVALID" });
    await expect(v(c, chain, now() + 301)).rejects.toThrow(/expired/);
    await expect(v(await signConditions({ ...unsigned, expiresAt: now() + 301 }, signalAgent))).rejects.toThrow(/300 s/);
    await expect(v(c, { ...chain, chainId: 177 })).rejects.toThrow(/network/);
    await expect(v(c, { ...chain, decimals: 18 })).rejects.toThrow(/network/);
    await expect(v(c, { ...chain, paymentProtocol: "lightning" })).rejects.toMatchObject({ code: "ATE_PAYMENT_NETWORK_UNSUPPORTED" });
  });
});

describe("§9.5 economics and caps", () => {
  it("buys only when size × |edge| ≥ 5 × price and the free signal is borderline", () => {
    expect(shouldBuySignal({ tradeSizeUsd: "25", netEdgeBps: 40, entrySpreadBps: 60 }, "0.02").buy).toBe(true);
    expect(shouldBuySignal({ tradeSizeUsd: "25", netEdgeBps: -45, entrySpreadBps: 60 }, "0.02").buy).toBe(true);
    expect(shouldBuySignal({ tradeSizeUsd: "25", netEdgeBps: 39, entrySpreadBps: 60 }, "0.02").buy).toBe(false);
    expect(shouldBuySignal({ tradeSizeUsd: "5", netEdgeBps: 80, entrySpreadBps: 60 }, "0.02").buy).toBe(false); // demo size
    expect(shouldBuySignal({ tradeSizeUsd: "25", netEdgeBps: 100, entrySpreadBps: 60 }, "0.02").buy).toBe(false); // not borderline
  });
  it("per-payment $0.10 and daily $1.00 caps; released reservations free headroom", () => {
    const c = new CapLedger({ perPaymentCapUsd: "0.10", dailyCapUsd: "1.00" });
    expect(() => c.reserve("p0", usdToMicro("0.11"), t)).toThrow(/per-payment/);
    for (let i = 0; i < 10; i++) c.reserve(`p${i}`, usdToMicro("0.10"), t);
    expect(() => c.reserve("p10", usdToMicro("0.01"), t)).toThrow(/daily/);
    c.release("p3");
    expect(() => c.reserve("p10", usdToMicro("0.10"), t)).not.toThrow();
    expect(() => c.reserve("next-day", usdToMicro("0.10"), t + 86_400)).not.toThrow();
  });
});

// ------------------------------------------------------------------ agent flows on recorded responses

describe("PaymentAgent on recorded HSP responses", () => {
  it("happy path: CREATED → PREPARED → … → SETTLED, two digest-bound approvals, cap consumed", async () => {
    const h = await harness({ queries: ["submitted", "safe", "finalized"] });
    const c = await h.offer();
    let r = await h.agent.start(c);
    expect(r.state).toBe("PREPARED");
    expect(r.mandate).toMatchObject({ orderId: c.orderId, amountRaw: "21000", conditionsHash: conditionsHash(c) });
    expect(r.awaiting?.payload.body).toMatchObject({ stage: "sign", typedDataDigest: r.mandate!.typedDataDigest, payTo: PAY_TO, chainId: 133 });
    expect(h.caps.get(r.id)).toMatchObject({ state: "reserved", amount: 21_000n });

    r = await h.approve(r, "sign");
    expect(r.state).toBe("AUTH_FINALIZED");
    expect(r.awaiting?.payload.body).toMatchObject({ stage: "submit", feeRaw: "1000" });
    expect(r.signatureDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify({ ...r, conditions: null })).not.toMatch(/0x[0-9a-fA-F]{130}/); // wallet signature never stored

    r = await h.approve(r, "submit");
    expect(r.state).toBe("SUBMITTED");
    r = await h.agent.poll(r.id); // submitted
    expect(r.state).toBe("SUBMITTED");
    r = await h.agent.poll(r.id); // safe
    expect(r.state).toBe("SAFE");
    r = await h.agent.poll(r.id); // finalized + attributed
    expect(r.state).toBe("SETTLED");
    expect(r.attributionVerified).toBe(true);
    expect(r.gatewayTx).toMatch(/^0x/);
    expect(h.caps.get(r.id)?.state).toBe("consumed");
    expect(r.history.map((x) => x.to)).toEqual(["PREPARED", "SIGN_APPROVED", "SIGNED", "AUTH_FINALIZED", "SUBMIT_APPROVED", "SUBMITTED", "SAFE", "SETTLED"]);
    expect(h.hsp.count("submit_payment")).toBe(1);
  });

  it("the wallet signature is a valid EIP-712 signature by the payer over the prepared typed data", async () => {
    const h = await harness();
    const r = await h.agent.start(await h.offer());
    const sig = await createLocalEoaSigner({ privateKey: payerKey }).signTypedData(r.typedData!);
    expect(await verifyTypedData({ address: payer.address, signature: sig, ...(toViemTypedData(r.typedData!) as object) } as Parameters<typeof verifyTypedData>[0])).toBe(true);
  });

  it("attribution_verified=false → SETTLED_UNATTRIBUTED (terminal, cap consumed)", async () => {
    const h = await harness({ queries: ["finalized_unattributed"] });
    let r = await h.agent.start(await h.offer());
    r = await h.approve(r, "sign");
    r = await h.approve(r, "submit");
    r = await h.agent.poll(r.id);
    expect(r.state).toBe("SETTLED_UNATTRIBUTED");
    expect(h.caps.get(r.id)?.state).toBe("consumed");
  });

  it("30043 at prepare → EXPIRED, cap released", async () => {
    const h = await harness({ expireOn: ["prepare_payment"] });
    await expect(h.agent.start(await h.offer())).rejects.toMatchObject({ code: "ATE_PAYMENT_EXPIRED" });
    const r = h.agent.list()[0]!;
    expect(r.state).toBe("EXPIRED");
    expect(h.caps.get(r.id)?.state).toBe("released");
  });

  it("30043 at finalize → EXPIRED (new prepare + signature needed), never submitted", async () => {
    const h = await harness({ expireOn: ["finalize_payment"] });
    const r = await h.agent.start(await h.offer());
    await expect(h.approve(r, "sign")).rejects.toMatchObject({ code: "ATE_PAYMENT_EXPIRED" });
    expect(h.agent.get(r.id)!.state).toBe("EXPIRED");
    expect(h.hsp.count("submit_payment")).toBe(0);
  });

  it("quote lapse before approval → EXPIRED", async () => {
    const h = await harness({ quoteTtlSec: 60 });
    const r = await h.agent.start(await h.offer());
    t += 61;
    await expect(h.approve(r, "sign")).rejects.toMatchObject({ code: "ATE_PAYMENT_EXPIRED" });
  });

  it("denial at approval #1 → FAILED(denied), nothing signed, cap released", async () => {
    const h = await harness();
    const r = await h.agent.start(await h.offer());
    const d = await h.agent.deny(r.id, "sign");
    expect(d.state).toBe("FAILED_DENIED");
    expect(h.signerCalls()).toBe(0);
    expect(h.hsp.count("finalize_payment")).toBe(0);
    expect(h.caps.get(r.id)?.state).toBe("released");
  });

  it("denial at approval #2 → FAILED(denied), never submitted; cap reserved until validUntil lapses", async () => {
    const h = await harness();
    let r = await h.agent.start(await h.offer());
    r = await h.approve(r, "sign");
    r = await h.agent.deny(r.id, "submit");
    expect(r.state).toBe("FAILED_DENIED");
    expect(h.hsp.count("submit_payment")).toBe(0);
    expect(h.caps.get(r.id)?.state).toBe("reserved");
    t = r.mandate!.validUntil + 1;
    await h.agent.tick();
    expect(h.caps.get(r.id)?.state).toBe("released");
  });

  it("approval timeout (120 s) → FAILED(denied) via tick", async () => {
    const h = await harness();
    const r = await h.agent.start(await h.offer());
    t += 121;
    await h.agent.tick();
    expect(h.agent.get(r.id)!.state).toBe("FAILED_DENIED");
    expect(h.agent.get(r.id)!.reason).toMatch(/timed out/);
  });

  it("rejects an approval by another key or for the other stage; state unchanged", async () => {
    const h = await harness();
    const r = await h.agent.start(await h.offer());
    await expect(h.approve(r, "sign", softKey().priv)).rejects.toMatchObject({ code: "ATE_PAYMENT_DENIED" });
    await expect(h.agent.approve(r.id, "submit", "AAAA")).rejects.toMatchObject({ code: "ATE_PAYMENT_DENIED" });
    expect(h.agent.get(r.id)!.state).toBe("PREPARED");
    expect(h.signerCalls()).toBe(0);
  });

  it("uncertain submit (timeout) → UNCERTAIN, resolved by query_payment — never resubmitted", async () => {
    const h = await harness({ submit: "timeout", queries: ["timeout", "finalized"] });
    let r = await h.agent.start(await h.offer());
    r = await h.approve(r, "sign");
    r = await h.approve(r, "submit");
    expect(r.state).toBe("UNCERTAIN");
    expect(h.caps.get(r.id)?.state).toBe("reserved");
    await h.agent.tick(); // first poll: transport timeout → still UNCERTAIN
    expect(h.agent.get(r.id)!.state).toBe("UNCERTAIN");
    t += 60;
    await h.agent.tick(); // reconcile every 60 s
    expect(h.agent.get(r.id)!.state).toBe("SETTLED");
    expect(h.hsp.count("submit_payment")).toBe(1);
  });

  it("5xx at submit → UNCERTAIN; start() on the same offer queries instead of re-preparing", async () => {
    const h = await harness({ submit: "5xx", queries: ["safe"] });
    const c = await h.offer();
    let r = await h.agent.start(c);
    r = await h.approve(r, "sign");
    r = await h.approve(r, "submit");
    expect(r.state).toBe("UNCERTAIN");
    const again = await h.agent.start(c);
    expect(again.id).toBe(r.id);
    expect(again.state).toBe("SAFE");
    expect(h.hsp.count("prepare_payment")).toBe(1);
    expect(h.hsp.count("submit_payment")).toBe(1);
  });

  it("crash after SUBMIT_APPROVED → recover() marks UNCERTAIN, never resubmits", async () => {
    const h = await harness();
    let r = await h.agent.start(await h.offer());
    r = await h.approve(r, "sign");
    const crashed = { ...h.agent.get(r.id)!, state: "SUBMIT_APPROVED" as const };
    delete crashed.awaiting;
    h.store.put(crashed);
    h.agent.recover();
    expect(h.agent.get(r.id)!.state).toBe("UNCERTAIN");
    expect(h.hsp.count("submit_payment")).toBe(0);
  });

  it("no definitive result after 10 min → UNCERTAIN, then 60 s reconcile", async () => {
    const h = await harness({ queries: ["submitted"] });
    let r = await h.agent.start(await h.offer());
    r = await h.approve(r, "sign");
    r = await h.approve(r, "submit");
    for (let s = 0; s < 600; s += 3) {
      await h.agent.tick();
      t += 3;
    }
    await h.agent.tick();
    expect(h.agent.get(r.id)!.state).toBe("UNCERTAIN");
    const q = h.hsp.count("query_payment");
    expect(q).toBeGreaterThan(40); // 3 s cadence for 120 s, then 30 s
    expect(q).toBeLessThan(60);
  });

  it("definitive failure from query_payment → FAILED, cap released", async () => {
    const h = await harness({ queries: ["failed"] });
    let r = await h.agent.start(await h.offer());
    r = await h.approve(r, "sign");
    r = await h.approve(r, "submit");
    r = await h.agent.poll(r.id);
    expect(r.state).toBe("FAILED");
    expect(h.caps.get(r.id)?.state).toBe("released");
  });

  it("get_order mismatch → ATE_PAYMENT_ORDER_MISMATCH, nothing reserved", async () => {
    const h = await harness({ orderOverride: { pay_to: "0x000000000000000000000000000000000000dEaD" } });
    await expect(h.agent.start(await h.offer())).rejects.toMatchObject({ code: "ATE_PAYMENT_ORDER_MISMATCH" });
    expect(h.agent.list()).toHaveLength(0);
    expect(h.caps.snapshot()).toHaveLength(0);
  });

  it("network mismatch with live get_chain_config → ATE_PAYMENT_CONDITIONS_INVALID", async () => {
    const h = await harness({ chainConfigOverride: { chain_id: 177 } });
    await expect(h.agent.start(await h.offer())).rejects.toMatchObject({ code: "ATE_PAYMENT_CONDITIONS_INVALID" });
  });

  it("daily cap: payments beyond it → ATE_PAYMENT_LIMIT; per-payment > $0.10 refused", async () => {
    const h = await harness({ dailyCapUsd: "0.05" });
    await h.agent.start(await h.offer());
    await h.agent.start(await h.offer());
    await expect(h.agent.start(await h.offer())).rejects.toMatchObject({ code: "ATE_PAYMENT_LIMIT" });
    await expect(h.agent.start(await h.offer("0.11"))).rejects.toMatchObject({ code: "ATE_PAYMENT_LIMIT" });
  });

  it("no purchases while Vault-HSK is paused; insufficient payer balance fails before signing", async () => {
    const p = await harness({ paused: true });
    await expect(p.agent.start(await p.offer())).rejects.toMatchObject({ code: "ATE_POLICY_PAUSED" });
    const b = await harness({ balance: 100n });
    await expect(b.agent.start(await b.offer())).rejects.toMatchObject({ code: "ATE_INSUFFICIENT_BALANCE" });
    expect(b.caps.snapshot()[0]?.state).toBe("released");
  });

  it("emits an update per persisted transition (journal / payment.state)", async () => {
    const h = await harness();
    const r = await h.agent.start(await h.offer());
    expect(h.updates.filter((u) => u.id === r.id).map((u) => u.event)).toEqual(["created", "prepared", "updated"]);
  });
});

describe("HSP client guards", () => {
  it("lists the eight tools in the recorded listing; flags a missing finalize_payment", async () => {
    const h = new MockHsp({ now });
    expect(missingHspTools(await h.listTools())).toEqual([]);
    const h2 = new MockHsp({ now, tools: ["get_chain_config", "create_order", "get_order", "prepare_payment", "estimate_fee", "submit_payment", "query_payment"] });
    expect(missingHspTools(await h2.listTools())).toEqual(["finalize_payment"]);
  });
  it("the live client refuses to construct without allowLive (tests never touch the QA endpoint)", async () => {
    await expect(createMcpHspClient({ allowLive: false })).rejects.toMatchObject({ code: "ATE_PAYMENT_UNAVAILABLE" });
  });
  it("redacts signatures, JWTs and secret keys", () => {
    const sig = `0x${"1b".repeat(65)}` as Hex;
    const out = redact({ signature: sig, note: `sig ${sig} jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijkl`, nested: { token: "abc" } });
    expect(JSON.stringify(out)).not.toContain("1b1b");
    expect(JSON.stringify(out)).not.toContain("eyJhbGci");
    expect(out.nested.token).toBe("[redacted]");
  });
});
