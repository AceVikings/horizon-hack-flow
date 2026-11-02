// Parity: the Swift helper's Touch ID prompt equals the TS renderReason for every payload kind, and it
// rejects expired / malformed payloads with the documented exit codes (§10.1, §18.2 ate-approve row).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodePayload, renderReason, type ApprovalPayload } from "../src/payload.js";

const BIN = fileURLToPath(new URL("../bin/ate-approve", import.meta.url));
const HAVE_BIN = existsSync(BIN);
const itBin = HAVE_BIN ? it : it.skip;

const now = Math.floor(Date.now() / 1000);
const win = { v: 1 as const, issuedAt: now, expiresAt: now + 60 };
const ADDR = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6";
const ADDR2 = "0x1111111111111111111111111111111111111111";
const DIGEST = `0x${"ab".repeat(32)}`;

const samples: ApprovalPayload[] = [
  {
    ...win,
    kind: "payment",
    aud: "ate-pay",
    nonce: "pay_1:sign",
    body: {
      stage: "submit",
      paymentId: "pay_0123456789abcdef",
      paymentRequestId: "pr_42",
      amountRaw: "20500",
      decimals: 6,
      token: ADDR,
      tokenSymbol: "USDC",
      payTo: ADDR2,
      payer: ADDR,
      chainId: 133,
      typedDataDigest: DIGEST,
      validUntil: now + 300,
      feeRaw: "500",
    },
  },
  {
    ...win,
    kind: "trade",
    aud: "ate-daemon",
    nonce: "t1",
    body: { proposalId: `0x${"cd".repeat(32)}`, market: "hsk-dex:WHSK/USDT:3000", side: "buy", amountUsd: "25.5", amountIn: "25500000", tokenIn: ADDR },
  },
  { ...win, kind: "chat_session", aud: "ate-daemon", nonce: "c1", body: { sessionId: "sess_abc" } },
  { ...win, kind: "ui_attach", aud: "ate-daemon", nonce: "u1", body: { pid: 4242, port: 51234 } },
  {
    ...win,
    kind: "strategy",
    aud: "ate-daemon",
    nonce: "chg_1",
    body: {
      changeId: "chg_1",
      changes: [
        { scope: "hsk-dex:WHSK/USDT:3000", field: "stopLossBps", before: 50, after: 300 },
        { scope: "hsk-dex:WBTC/USDT:3000", field: "enabled", before: false, after: true },
        { scope: "portfolio", field: "targetAssets", before: ["WHSK"], after: ["WHSK", "WBTC"] },
        { scope: "portfolio", field: "tradeSizeUsd", before: "25", after: { v: 1.5, a: null } },
      ],
    },
  },
  {
    ...win,
    kind: "config",
    aud: "ate-daemon",
    nonce: "cfg1",
    body: { changes: [{ key: "rpc.urls", before: ["https://a"], after: ["https://a", "https://b/x"] }] },
  },
];

function run(b64: string): { code: number; out: { ok: boolean; reason?: string; error?: string; kind?: string } } {
  try {
    return { code: 0, out: JSON.parse(execFileSync(BIN, ["reason", b64], { encoding: "utf8" })) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: JSON.parse(err.stdout) };
  }
}

const raw = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

describe("ate-approve Swift parity", () => {
  for (const p of samples) {
    itBin(`reason matches TS renderReason: ${p.kind}`, () => {
      const r = run(encodePayload(p));
      expect(r.code).toBe(0);
      expect(r.out.kind).toBe(p.kind);
      expect(r.out.reason).toBe(renderReason(p));
    });
  }

  itBin("expired payload → exit 2 expired", () => {
    const p = { ...samples[3]!, issuedAt: now - 600, expiresAt: now - 300 };
    const r = run(raw(p));
    expect(r.code).toBe(2);
    expect(r.out.error).toBe("expired");
  });

  itBin("unknown extra field → exit 2 invalid_payload", () => {
    const r = run(raw({ ...samples[2]!, prompt: "Approve anything" }));
    expect(r.code).toBe(2);
    expect(r.out.error).toBe("invalid_payload");
    const r2 = run(raw({ ...samples[2]!, body: { sessionId: "s", reason: "x" } }));
    expect(r2.code).toBe(2);
    expect(r2.out.error).toBe("invalid_payload");
  });

  itBin("payment with aud ate-daemon → invalid", () => {
    const r = run(raw({ ...samples[0]!, aud: "ate-daemon" }));
    expect(r.code).toBe(2);
    expect(r.out.error).toBe("invalid_payload");
  });

  itBin("garbage → invalid_payload; unknown command → usage", () => {
    expect(run("not*base64").out.error).toBe("invalid_payload");
    let code = 0;
    try {
      execFileSync(BIN, ["frobnicate"], { encoding: "utf8" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(64);
  });
});
