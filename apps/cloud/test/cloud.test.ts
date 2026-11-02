import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerify } from "node:crypto";
import { decodePayload, encodePayload, payloadBytes, configPayload } from "@ate/approve";
import { Auth, RateLimiter } from "../src/auth.js";
import { GatewayApprovalKey } from "../src/invoke.js";
import { Runs } from "../src/runs.js";

const auth = () => new Auth({ passkeysPath: join(mkdtempSync(join(tmpdir(), "flow-gw-")), "pk.json"), password: "correct horse battery", origin: "https://flow.example", rpId: "flow.example" });

describe("auth", () => {
  it("password sign-in, session and CSRF", () => {
    const a = auth();
    expect(a.passwordLogin("wrong")).toBeNull();
    const s = a.passwordLogin("correct horse battery")!;
    expect(a.session(s.id)?.via).toBe("password");
    expect(a.checkCsrf(s, s.csrf)).toBe(true);
    expect(a.checkCsrf(s, "x".repeat(s.csrf.length))).toBe(false);
    expect(a.checkCsrf(s, undefined)).toBe(false);
    a.logout(s.id);
    expect(a.session(s.id)).toBeNull();
  });
  it("short passwords are disabled", () => {
    expect(new Auth({ passkeysPath: "/nonexistent/x", password: "short", origin: "https://a", rpId: "a" }).passwordEnabled).toBe(false);
  });
  it("rate limits", () => {
    const r = new RateLimiter(2);
    expect([r.allow("k"), r.allow("k"), r.allow("k")]).toEqual([true, true, false]);
  });
  it("assertions over an unknown credential fail", async () => {
    expect(await auth().verifyAssertion({ id: "nope" } as never, "abc")).toBe(false);
  });
});

describe("approval tickets", () => {
  it("pauses a call for a passkey and resumes the same call", async () => {
    const runs = new Runs();
    let step1 = 0;
    const o1 = await runs.start("s1", async (ctx) => {
      step1++; // a daemon nonce issued here must survive the approval
      const a = await ctx.passkey({ challenge: "c", prompt: "Raise limits" });
      return { ok: true, data: { id: (a as { id: string }).id, step1 } };
    });
    expect(o1.kind).toBe("ticket");
    if (o1.kind !== "ticket") return;
    expect(runs.resume("other-session", o1.ticket, { id: "x" } as never)).toBeNull();
    const o2 = await runs.resume("s1", o1.ticket, { id: "pk1" } as never)!;
    expect(o2).toEqual({ kind: "result", value: { ok: true, data: { id: "pk1", step1: 1 } } });
  });
  it("cancel turns into ATE_APPROVAL_REQUIRED", async () => {
    const runs = new Runs();
    const o1 = await runs.start("s", async (ctx) => (await ctx.passkey({ challenge: "c", prompt: "p" }), 1));
    if (o1.kind !== "ticket") throw new Error("ticket expected");
    expect(await runs.resume("s", o1.ticket, null)).toMatchObject({ kind: "result", value: { ok: false, error: { code: "ATE_APPROVAL_REQUIRED" } } });
  });
});

describe("gateway approval key", () => {
  it("signs payloads the daemon verifier accepts (P-256, DER)", () => {
    const k = new GatewayApprovalKey();
    const p = decodePayload(encodePayload(configPayload({ nonce: "n", expiresAt: Math.floor(Date.now() / 1000) + 60, changes: [{ key: "k", before: 1, after: 2 }] })));
    const sig = k.sign(p);
    const raw = Buffer.from(k.publicKeyHex, "hex");
    const v = createVerify("sha256");
    v.update(payloadBytes(p));
    const key = { key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" as const, dsaEncoding: "der" as const };
    expect(v.verify(key, Buffer.from(sig, "base64"))).toBe(true);
  });
});
