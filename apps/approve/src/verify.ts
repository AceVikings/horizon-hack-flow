// Verify `ate-approve` signatures against the pinned public key (SPEC §10.1). Used by the daemon
// (approval endpoints) and by ate-pay (payment approvals #1/#2).
import { createHash, createPublicKey, verify as nodeVerify, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { payloadBytes, validatePayload, type ApprovalPayload } from "./payload.js";

/** ~/.ate/approve-pubkey.json, written once at setup (`ate-approve pubkey` output) and pinned. */
export const DEFAULT_PINNED_KEY_PATH = join(homedir(), ".ate", "approve-pubkey.json");

export interface PinnedApprovalKey {
  /** Uncompressed SEC1 point, 65 bytes hex (04‖X‖Y), as printed by `ate-approve pubkey`. */
  publicKey: string;
  keyId: string;
}

export function keyIdOf(publicKeyHex: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyHex.replace(/^0x/, ""), "hex")).digest("hex").slice(0, 16);
}

/** P-256 public KeyObject from a 65-byte uncompressed point. */
export function p256KeyFromX963(publicKeyHex: string): KeyObject {
  const raw = Buffer.from(publicKeyHex.replace(/^0x/, ""), "hex");
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("approval public key must be a 65-byte uncompressed P-256 point");
  return createPublicKey({
    key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") },
    format: "jwk",
  });
}

export function loadPinnedKey(path: string = DEFAULT_PINNED_KEY_PATH): PinnedApprovalKey {
  const j = JSON.parse(readFileSync(path, "utf8")) as Partial<PinnedApprovalKey>;
  if (typeof j.publicKey !== "string") throw new Error(`${path}: missing publicKey`);
  const keyId = keyIdOf(j.publicKey);
  if (j.keyId !== undefined && j.keyId !== keyId) throw new Error(`${path}: keyId does not match publicKey`);
  return { publicKey: j.publicKey, keyId };
}

export type VerifyFailure = "bad_signature" | "expired" | "not_yet_valid" | "invalid_payload" | "wrong_audience";

export interface ApprovalVerifier {
  readonly keyId: string;
  /**
   * Verifies `signatureB64` (DER, base64) over the canonical bytes of `expected` — a payload the
   * verifier rebuilt from its own state, never one supplied by the caller.
   */
  verify(expected: ApprovalPayload, signatureB64: string, now?: number): { ok: true } | { ok: false; reason: VerifyFailure };
}

export function createApprovalVerifier(pinned: PinnedApprovalKey, audience: ApprovalPayload["aud"]): ApprovalVerifier {
  const key = p256KeyFromX963(pinned.publicKey);
  return {
    keyId: pinned.keyId,
    verify(expected, signatureB64, now = Math.floor(Date.now() / 1000)) {
      try {
        validatePayload(expected);
      } catch {
        return { ok: false, reason: "invalid_payload" };
      }
      if (expected.aud !== audience) return { ok: false, reason: "wrong_audience" };
      if (now > expected.expiresAt) return { ok: false, reason: "expired" };
      if (expected.issuedAt > now + 60) return { ok: false, reason: "not_yet_valid" };
      let sig: Buffer;
      try {
        sig = Buffer.from(signatureB64, "base64");
      } catch {
        return { ok: false, reason: "bad_signature" };
      }
      if (sig.length < 8 || sig.length > 80) return { ok: false, reason: "bad_signature" };
      let ok = false;
      try {
        ok = nodeVerify("sha256", payloadBytes(expected), { key, dsaEncoding: "der" }, sig);
      } catch {
        ok = false;
      }
      return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
    },
  };
}

/** Setup: pin the key printed by `ate-approve pubkey` (mode 0600). Re-pinning is an owner action. */
export function writePinnedKey(publicKeyHex: string, path: string = DEFAULT_PINNED_KEY_PATH): PinnedApprovalKey {
  p256KeyFromX963(publicKeyHex); // validates
  const pinned = { publicKey: publicKeyHex.replace(/^0x/, "").toLowerCase(), keyId: keyIdOf(publicKeyHex) };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ ...pinned, pinnedAt: Math.floor(Date.now() / 1000) }, null, 2)}\n`, { mode: 0o600 });
  return pinned;
}
