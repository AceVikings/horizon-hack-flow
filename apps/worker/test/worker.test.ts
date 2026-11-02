import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { canonicalJson, createApprovalVerifier, decodePayload, keyIdOf, payloadBytes } from "@ate/approve";
import { CapLedger, MemoryPaymentStore, PaymentAgent, createLocalEoaSigner } from "@ate/payments";
import { MockHsp, type MockHspOptions } from "@ate/payments/testing";
import { PayService, SignalService, computeFairValue, depthMicroprice } from "../src/index.js";

let t = 1_800_000_000;
const now = () => t;
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function softKey(): { priv: KeyObject; pubHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return { priv: privateKey, pubHex: `04${Buffer.from(jwk.x, "base64url").toString("hex")}${Buffer.from(jwk.y, "base64url").toString("hex")}` };
}

const book = { bids: [[0.5, 1000], [0.499, 4000]] as [number, number][], asks: [[0.501, 800], [0.502, 3000]] as [number, number][], at: t };

async function setup(o: Partial<MockHspOptions> = {}) {
  t = 1_800_000_000;
  const hsp = new MockHsp({ now, queries: ["safe", "finalized"], ...o });
  const sigAcct = privateKeyToAccount(generatePrivateKey());
  const signal = new SignalService({ hsp, account: sigAcct, payTo: sigAcct.address, token: "sig-token", now, computeSignal: async () => computeFairValue({ book, now: now() }) });
  const se = softKey();
  const agent = new PaymentAgent({
    hsp,
    signer: createLocalEoaSigner({ privateKey: generatePrivateKey() }),
    store: new MemoryPaymentStore(),
    caps: new CapLedger({ perPaymentCapUsd: "0.10", dailyCapUsd: "1.00" }),
    verifier: createApprovalVerifier({ publicKey: se.pubHex, keyId: keyIdOf(se.pubHex) }, "ate-pay"),
    signalAgent: sigAcct.address,
    signalPayTo: sigAcct.address,
    merchantName: "Vikings",
    balanceOf: async () => 10n ** 9n,
    isVaultPaused: async () => false,
    now,
  });
  const sigServer = await signal.listen(0);
  servers.push(sigServer);
  const sigBase = `http://127.0.0.1:${(sigServer.address() as AddressInfo).port}`;
  const { httpSignalClient } = await import("../src/pay.js");
  const pay = new PayService({ agent, signal: httpSignalClient(sigBase, "sig-token"), token: "pay-token" });
  const payServer = await pay.listen(0);
  servers.push(payServer);
  const base = `http://127.0.0.1:${(payServer.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token = "pay-token") => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: (await r.json()) as { ok: boolean; data: any; error?: any } };
  };
  const approve = (data: any) => {
    const payload = decodePayload(data.approvalRequest.payload);
    return nodeSign("sha256", payloadBytes(payload), { key: se.priv, dsaEncoding: "der" }).toString("base64");
  };
  return { hsp, agent, signal, sigAcct, sigBase, call, approve };
}

describe("ate-pay + ate-signal over HTTP (recorded HSP responses)", () => {
  it("offer → buy → approval #1 → approval #2 → settled → signal released once", async () => {
    const s = await setup();
    const offer = await s.call("GET", "/offers");
    expect(offer.status).toBe(200);
    expect(offer.json.data).toMatchObject({ product: "whsk-fair-value-15m", merchantName: "Vikings", priceUsd: "0.02", signalTtlSec: 900 });

    let r = await s.call("POST", "/buy", { offerId: offer.json.data.offerId, context: { tradeSizeUsd: "25", netEdgeBps: 50, entrySpreadBps: 60 } });
    expect(r.status).toBe(200);
    expect(r.json.data.state).toBe("PREPARED");
    expect(r.json.data.approvalRequest.prompt).toMatch(/^Sign payment authorization: 0\.021 USDC/);
    const id = r.json.data.id;

    r = await s.call("POST", `/payments/${id}/approve`, { stage: "sign", approval: s.approve(r.json.data) });
    expect(r.json.data.state).toBe("AUTH_FINALIZED");
    expect(r.json.data.approvalRequest.stage).toBe("submit");

    const early = await s.call("GET", `/payments/${id}/signal`);
    expect(early.status).toBe(409);

    r = await s.call("POST", `/payments/${id}/approve`, { stage: "submit", approval: s.approve(r.json.data) });
    expect(r.json.data.state).toBe("SUBMITTED");
    await s.agent.poll(id);
    await s.agent.poll(id);
    expect(s.agent.get(id)!.state).toBe("SETTLED");

    const sig = await s.call("GET", `/payments/${id}/signal`);
    expect(sig.status).toBe(200);
    expect(sig.json.data).toMatchObject({ offerId: offer.json.data.offerId, validUntil: t + 900, signal: { product: "whsk-fair-value-15m" } });
    const { signature, ...unsigned } = sig.json.data;
    expect(await recoverMessageAddress({ message: canonicalJson(unsigned), signature })).toBe(s.sigAcct.address);
    // ate-pay caches; a direct second redeem at ate-signal is refused (once per payment_request_id)
    expect((await s.call("GET", `/payments/${id}/signal`)).status).toBe(200);
    const again = await fetch(`${s.sigBase}/redeem`, {
      method: "POST",
      headers: { authorization: "Bearer sig-token" },
      body: JSON.stringify({ payment_request_id: s.agent.get(id)!.mandate!.paymentRequestId, offerId: offer.json.data.offerId }),
    });
    expect(again.status).toBe(409);
  });

  it("every request needs the worker token; TTY codes never approve payments; economics gate", async () => {
    const s = await setup();
    expect((await s.call("GET", "/offers", undefined, "wrong")).status).toBe(401);
    const offer = await s.call("GET", "/offers");
    const no = await s.call("POST", "/buy", { offerId: offer.json.data.offerId, context: { tradeSizeUsd: "5", netEdgeBps: 50, entrySpreadBps: 60 } });
    expect(no.status).toBe(429);
    expect(no.json.error.message).toMatch(/not worth it/);
    const r = await s.call("POST", "/buy", { offerId: offer.json.data.offerId });
    const tty = await s.call("POST", `/payments/${r.json.data.id}/approve`, { stage: "sign", approval: "12345678" });
    expect(tty.status).toBe(403);
    const denied = await s.call("POST", `/payments/${r.json.data.id}/deny`, { stage: "sign" });
    expect(denied.json.data.state).toBe("FAILED_DENIED");
  });

  it("ate-signal refuses to release before payment-finalized", async () => {
    const s = await setup({ queries: ["safe"] });
    const c = await s.signal.createOffer();
    await expect(s.signal.redeem({ payment_request_id: "pr_x", offerId: c.offerId })).rejects.toThrow(/unknown payment_request_id/);
  });
});

describe("fair value", () => {
  it("depth microprice leans to the thinner side; pool flow blends in", () => {
    const d = depthMicroprice(book);
    expect(d.mid).toBeCloseTo(0.5005, 6);
    expect(d.imbalance).toBeGreaterThan(0); // more bid size
    expect(d.price).toBeGreaterThan(d.mid);
    const fv = computeFairValue({ book, swaps: [{ price: 0.49, usd: 5000, at: t - 60 }], now: t });
    expect(fv.components.weights.pool).toBeCloseTo(0.4);
    expect(Number(fv.fairValue)).toBeLessThan(d.price);
    expect(() => depthMicroprice({ bids: [], asks: [], at: t })).toThrow();
  });
});
