import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { StrategyApprovalPending } from "@ate/core";
import {
  chatSessionPayload,
  createApprovalVerifier,
  decodePayload,
  encodePayload,
  keyIdOf,
  paymentPayload,
  payloadBytes,
  renderReason,
  strategyPayload,
  uiAttachPayload,
  validatePayload,
  type ApprovalPayload,
} from "../src/index.js";
import { ApprovalService, TtyFallback, createNodeApprovalHandler, type FallbackMode } from "../src/daemon/index.js";

// A software P-256 key stands in for the Secure Enclave (same curve, same DER signature format).
function softKey(): { priv: KeyObject; pubHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const pubHex = `04${Buffer.from(jwk.x, "base64url").toString("hex")}${Buffer.from(jwk.y, "base64url").toString("hex")}`;
  return { priv: privateKey, pubHex };
}
const sig = (priv: KeyObject, p: ApprovalPayload) => nodeSign("sha256", payloadBytes(p), { key: priv, dsaEncoding: "der" }).toString("base64");

const PID = 4242;
const PORT = 51515;

function setup(mode: FallbackMode = "armed", opts: { pinned?: boolean } = {}) {
  let t = 1_800_000_000;
  const now = () => t;
  const { priv, pubHex } = softKey();
  const tty: string[] = [];
  const journal: unknown[] = [];
  const pending = new Map<string, StrategyApprovalPending>();
  const appliedCalls: string[] = [];
  const ttyF = new TtyFallback({ mode, ttyWrite: (l) => tty.push(l), now });
  const svc = new ApprovalService({
    pid: PID,
    port: PORT,
    verifier: opts.pinned === false ? null : createApprovalVerifier({ publicKey: pubHex, keyId: keyIdOf(pubHex) }, "ate-daemon"),
    tty: ttyF,
    mintUiToken: () => "ui-token",
    mintSessionToken: (id) => ({ token: `sess-${id}`, expiresAt: t + 1800 }),
    getPendingStrategyChange: (id) => pending.get(id),
    applyStrategyChange: async (id) => {
      appliedCalls.push(id);
      return { applied: true, decisionId: "strat_1", changes: pending.get(id)!.diff };
    },
    journalApproval: (e) => journal.push(e),
    now,
  });
  const lastCode = () => /: (\d{8}) /.exec(tty.at(-1) ?? "")?.[1];
  return { svc, priv, pubHex, tty, journal, pending, appliedCalls, ttyF, lastCode, advance: (s: number) => (t += s), now };
}

const pendingChange = (expiresAt: number): StrategyApprovalPending => ({
  changeId: "chg_1",
  diff: [
    { scope: "hsk-dex:WHSK/USDT:3000", field: "stopLossBps", before: 50, after: 300, loosening: true },
    { scope: "portfolio", field: "targetAssets", before: ["WBTC"], after: ["WBTC", "WHSK"], loosening: true },
  ],
  renderedDiff: "WHSK stopLossBps 50 → 300\nportfolio targetAssets [WBTC] → [WBTC, WHSK]",
  expiresAt,
});

describe("payload codec", () => {
  it("round-trips through base64url canonical JSON and rejects extra fields", () => {
    const p = uiAttachPayload({ nonce: "n1", expiresAt: 1060, pid: 1, port: 2 });
    expect(decodePayload(encodePayload(p))).toEqual(p);
    expect(() => validatePayload({ ...p, prompt: "Approve $1" })).toThrow(/unexpected field prompt/);
    expect(() => validatePayload({ ...p, body: { pid: 1, port: 2, reason: "x" } })).toThrow();
  });
  it("prompt text comes only from payload fields", () => {
    expect(renderReason(uiAttachPayload({ nonce: "n", expiresAt: 100, pid: 77, port: 8080 }))).toBe("Attach ATE desktop to daemon pid 77 on port 8080");
    expect(renderReason(chatSessionPayload({ sessionId: "chat_ab", nonce: "n", expiresAt: 100 }))).toBe("Open ATE chat session chat_ab");
    expect(renderReason(strategyPayload(pendingChange(100)))).toBe(
      'Loosen ATE strategy: hsk-dex:WHSK/USDT:3000 stopLossBps 50 → 300; portfolio targetAssets ["WBTC"] → ["WBTC","WHSK"]',
    );
    const pay = paymentPayload({
      issuedAt: 100,
      body: {
        stage: "sign",
        paymentId: "pay_1",
        paymentRequestId: "pr_1",
        amountRaw: "20000",
        decimals: 6,
        token: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
        tokenSymbol: "USDC",
        payTo: "0x1111111111111111111111111111111111111111",
        payer: "0x2222222222222222222222222222222222222222",
        chainId: 133,
        typedDataDigest: `0x${"ab".repeat(32)}`,
        validUntil: 400,
      },
    });
    expect(renderReason(pay)).toContain("Sign payment authorization: 0.02 USDC");
    expect(renderReason(pay)).toContain("to 0x1111111111111111111111111111111111111111 on chain 133");
  });
});

describe("verifier", () => {
  it("accepts a signature over the rebuilt payload; rejects tampering, other keys, expiry and audience", () => {
    const { priv, pubHex } = softKey();
    const v = createApprovalVerifier({ publicKey: pubHex, keyId: keyIdOf(pubHex) }, "ate-daemon");
    const p = uiAttachPayload({ nonce: "n1", expiresAt: 1060, pid: 1, port: 2 });
    const s = sig(priv, p);
    expect(v.verify(p, s, 1030)).toEqual({ ok: true });
    expect(v.verify({ ...p, body: { pid: 1, port: 3 } }, s, 1030)).toEqual({ ok: false, reason: "bad_signature" });
    expect(v.verify(p, sig(softKey().priv, p), 1030)).toEqual({ ok: false, reason: "bad_signature" });
    expect(v.verify(p, s, 1061)).toEqual({ ok: false, reason: "expired" });
    expect(v.verify(p, "not-base64!!", 1030).ok).toBe(false);
    const payV = createApprovalVerifier({ publicKey: pubHex, keyId: "k" }, "ate-pay");
    expect(payV.verify(p, s, 1030)).toEqual({ ok: false, reason: "wrong_audience" });
  });
});

describe("/ui/attach", () => {
  it("issues a ui token only for a valid signature over a fresh nonce", async () => {
    const s = setup();
    const r1 = await s.svc.uiAttach({});
    expect(r1.status).toBe(200);
    const { nonce, expiresAt } = r1.body as { nonce: string; expiresAt: number };
    const payload = uiAttachPayload({ nonce, expiresAt, pid: PID, port: PORT });
    const r2 = await s.svc.uiAttach({ nonce, approval: sig(s.priv, payload) });
    expect(r2).toEqual({ status: 200, body: { uiToken: "ui-token" } });
    expect(s.journal).toEqual([expect.objectContaining({ purpose: "ui_attach", method: "secure-enclave", ref: nonce })]);
    // replay of the same nonce fails
    expect((await s.svc.uiAttach({ nonce, approval: sig(s.priv, payload) })).status).toBe(404);
  });

  it("rejects a signature bound to another daemon pid/port, an expired nonce, and >5 step-1/min", async () => {
    const s = setup();
    const { nonce, expiresAt } = (await s.svc.uiAttach({})).body as { nonce: string; expiresAt: number };
    const wrong = uiAttachPayload({ nonce, expiresAt, pid: PID + 1, port: PORT });
    expect((await s.svc.uiAttach({ nonce, approval: sig(s.priv, wrong) })).status).toBe(401);

    const n2 = (await s.svc.uiAttach({})).body as { nonce: string; expiresAt: number };
    s.advance(61);
    const p2 = uiAttachPayload({ ...n2, pid: PID, port: PORT });
    expect((await s.svc.uiAttach({ nonce: n2.nonce, approval: sig(s.priv, p2) })).status).toBe(410);

    s.advance(120);
    for (let i = 0; i < 5; i++) expect((await s.svc.uiAttach({})).status).toBe(200);
    expect((await s.svc.uiAttach({})).status).toBe(429);
  });
});

describe("/chat/session", () => {
  it("requires agent/ui scope and issues a session handle for a valid signature", async () => {
    const s = setup();
    expect((await s.svc.chatSession({}, "chat")).status).toBe(403);
    const r1 = (await s.svc.chatSession({}, "agent")).body as { sessionId: string; nonce: string; expiresAt: number };
    const p = chatSessionPayload(r1);
    const r2 = await s.svc.chatSession({ ...r1, approval: sig(s.priv, p) }, "agent");
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ sessionId: r1.sessionId, sessionToken: `sess-${r1.sessionId}` });
  });
  it("rejects a sessionId swap", async () => {
    const s = setup();
    const r1 = (await s.svc.chatSession({}, "agent")).body as { sessionId: string; nonce: string; expiresAt: number };
    const r2 = await s.svc.chatSession({ ...r1, sessionId: "chat_other", approval: sig(s.priv, chatSessionPayload(r1)) }, "agent");
    expect(r2.status).toBe(400);
  });
});

describe("/strategy/approve", () => {
  it("strategy-diff payload signs and applies once (ui/session scope only)", async () => {
    const s = setup();
    const p = pendingChange(s.now() + 60);
    s.pending.set(p.changeId, p);
    const approval = sig(s.priv, strategyPayload(p));
    expect((await s.svc.strategyApprove({ changeId: p.changeId, approval }, "agent")).status).toBe(403);
    expect((await s.svc.strategyApprove({ changeId: p.changeId, approval }, "chat")).status).toBe(403);
    const r = await s.svc.strategyApprove({ changeId: p.changeId, approval }, "ui");
    expect(r.status).toBe(200);
    expect(s.appliedCalls).toEqual(["chg_1"]);
    expect((await s.svc.strategyApprove({ changeId: p.changeId, approval }, "session")).status).toBe(409);
  });
  it("rejects a signature over a different diff and an expired change", async () => {
    const s = setup();
    const p = pendingChange(s.now() + 60);
    s.pending.set(p.changeId, p);
    const tampered = { ...p, diff: [{ ...p.diff[0]!, after: 3000 }] };
    expect((await s.svc.strategyApprove({ changeId: p.changeId, approval: sig(s.priv, strategyPayload(tampered)) }, "ui")).status).toBe(401);
    s.advance(61);
    expect((await s.svc.strategyApprove({ changeId: p.changeId, approval: sig(s.priv, strategyPayload(p)) }, "ui")).status).toBe(410);
    expect(s.appliedCalls).toEqual([]);
  });
});

describe("TTY one-time-code degradation (§10.1)", () => {
  it("armed: codes refused until `approval-fallback enable` is typed on the TTY; no restart", async () => {
    const s = setup("armed", { pinned: false });
    const { nonce } = (await s.svc.uiAttach({})).body as { nonce: string };
    expect(s.tty).toEqual([]); // nothing printed while armed
    expect((await s.svc.uiAttach({ nonce, approval: "12345678" })).status).toBe(401);

    expect(s.ttyF.handleTtyLine("approval-fallback enable")).toBe(true);
    expect(s.ttyF.isEnabled()).toBe(true);
    const n2 = (await s.svc.uiAttach({})).body as { nonce: string };
    const code = s.lastCode();
    expect(code).toMatch(/^\d{8}$/);
    const r = await s.svc.uiAttach({ nonce: n2.nonce, approval: code });
    expect(r).toEqual({ status: 200, body: { uiToken: "ui-token" } });
    expect(s.journal).toContainEqual(expect.objectContaining({ purpose: "ui_attach", method: "tty" }));
  });

  it("codes are single use, 60 s, 5 attempts, bound to their purpose", () => {
    const s = setup("tty");
    const code = s.ttyF.issue("chat_session", "nonceA", "x")!;
    expect(s.ttyF.redeem("ui_attach", "nonceA", code)).toEqual({ ok: false, reason: "wrong_purpose" });
    const wrong = code.slice(0, 7) + String((Number(code[7]) + 1) % 10);
    for (let i = 0; i < 5; i++) expect(s.ttyF.redeem("chat_session", "nonceA", wrong)).toEqual({ ok: false, reason: "wrong_code" });
    expect(s.ttyF.redeem("chat_session", "nonceA", code)).toEqual({ ok: false, reason: "no_code" });

    const c2 = s.ttyF.issue("strategy", "chg", "x")!;
    expect(s.ttyF.redeem("strategy", "chg", c2)).toEqual({ ok: true });
    expect(s.ttyF.redeem("strategy", "chg", c2)).toEqual({ ok: false, reason: "no_code" });

    const c3 = s.ttyF.issue("strategy", "chg2", "x")!;
    s.advance(61);
    expect(s.ttyF.redeem("strategy", "chg2", c3)).toEqual({ ok: false, reason: "expired" });
  });

  it("strategy loosening accepts a TTY code when enabled", async () => {
    const s = setup("tty", { pinned: false });
    const p = pendingChange(s.now() + 60);
    s.pending.set(p.changeId, p);
    s.svc.onStrategyPending(p);
    const r = await s.svc.strategyApprove({ changeId: p.changeId, approval: s.lastCode() }, "ui");
    expect(r.status).toBe(200);
  });

  it("switches itself off once ate-approve verifies, and refuses enable afterwards", async () => {
    const s = setup("tty");
    expect(s.ttyF.isEnabled()).toBe(true);
    const { nonce, expiresAt } = (await s.svc.uiAttach({})).body as { nonce: string; expiresAt: number };
    await s.svc.uiAttach({ nonce, approval: sig(s.priv, uiAttachPayload({ nonce, expiresAt, pid: PID, port: PORT })) });
    expect(s.ttyF.isEnabled()).toBe(false);
    s.ttyF.handleTtyLine("approval-fallback enable");
    expect(s.ttyF.isEnabled()).toBe(false);
    expect(s.tty.at(-1)).toMatch(/refused/);
  });

  it("off: enable is refused", () => {
    const s = setup("off");
    s.ttyF.handleTtyLine("approval-fallback enable");
    expect(s.ttyF.isEnabled()).toBe(false);
  });
});

describe("node:http adapter", () => {
  it("rejects browser origins, requires a token for step 2, serves step 1 unauthenticated", async () => {
    const s = setup();
    const handler = createNodeApprovalHandler(s.svc, (a) => (a === "Bearer agent" ? "agent" : null));
    const server = createServer((req, res) => {
      void handler(req, res).then((hit) => {
        if (!hit) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const evil = await fetch(`${base}/ui/attach`, { method: "POST", body: "{}", headers: { origin: "https://evil.example" } });
      expect(evil.status).toBe(403);
      const s1 = await fetch(`${base}/ui/attach`, { method: "POST", body: "{}", headers: { origin: "ate://local" } });
      expect(s1.status).toBe(200);
      const { nonce, expiresAt } = (await s1.json()) as { nonce: string; expiresAt: number };
      const approval = sig(s.priv, uiAttachPayload({ nonce, expiresAt, pid: PID, port: PORT }));
      const noTok = await fetch(`${base}/ui/attach`, { method: "POST", body: JSON.stringify({ nonce, approval }) });
      expect(noTok.status).toBe(401);
      const ok = await fetch(`${base}/ui/attach`, { method: "POST", body: JSON.stringify({ nonce, approval }), headers: { authorization: "Bearer agent" } });
      expect(ok.status).toBe(200);
      const chatNoTok = await fetch(`${base}/chat/session`, { method: "POST", body: "{}" });
      expect(chatNoTok.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
