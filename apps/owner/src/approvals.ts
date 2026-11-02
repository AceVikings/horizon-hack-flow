// Approvals the owner service verifies itself, so whoever relays a request (Electron main, the cloud gateway) cannot
// approve a risk-raising op on the user's behalf:
//   - desktop: an ate-approve signature (Secure Enclave, Touch ID) over the config payload, against the pinned key;
//   - cloud:   a WebAuthn assertion (passkey) whose challenge is base64url(sha256(payload bytes)).
// Passkeys live in <ownerHome>/passkeys.json. The first one is registered freely (before it exists nothing
// risk-raising can be approved); adding another needs an assertion from one already registered.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createApprovalVerifier, loadPinnedKey, payloadBytes, type ApprovalVerifier, type ConfigApproval } from "@ate/approve";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { OwnerError } from "./ops.js";

export interface StoredPasskey {
  id: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  transports?: string[];
  addedAt: number;
}

export interface WebAuthnConfig {
  origin: string;
  rpId: string;
}

export const challengeFor = (p: ConfigApproval): string => createHash("sha256").update(payloadBytes(p)).digest("base64url");

export type ApprovalInput = { signature: string } | { webauthn: AuthenticationResponseJSON };

export class Approver {
  private p256: ApprovalVerifier | null = null;
  constructor(
    private readonly o: { passkeysPath: string; pinnedKeyPath?: string; webauthn?: WebAuthnConfig | null },
  ) {
    if (o.pinnedKeyPath && existsSync(o.pinnedKeyPath)) this.p256 = createApprovalVerifier(loadPinnedKey(o.pinnedKeyPath), "ate-daemon");
  }

  get methods(): { touchId: boolean; passkeys: number } {
    return { touchId: !!this.p256, passkeys: this.passkeys().length };
  }

  passkeys(): StoredPasskey[] {
    try {
      return existsSync(this.o.passkeysPath) ? (JSON.parse(readFileSync(this.o.passkeysPath, "utf8")) as StoredPasskey[]) : [];
    } catch {
      return [];
    }
  }

  private save(list: StoredPasskey[]) {
    mkdirSync(dirname(this.o.passkeysPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.o.passkeysPath, JSON.stringify(list, null, 2), { mode: 0o600 });
    chmodSync(this.o.passkeysPath, 0o600);
  }

  /** First passkey: free. Later ones: `approved` must be true (an existing passkey approved the addition). */
  addPasskey(k: Omit<StoredPasskey, "addedAt">, approved: boolean): void {
    const list = this.passkeys();
    if (list.some((x) => x.id === k.id)) return;
    if (list.length && !approved) throw new OwnerError(428, "adding a passkey needs approval from one already registered");
    if (!/^[A-Za-z0-9_-]{16,1400}$/.test(k.id) || !/^[A-Za-z0-9_-]{40,1400}$/.test(k.publicKey)) throw new OwnerError(400, "bad passkey");
    list.push({ ...k, addedAt: Math.floor(Date.now() / 1000) });
    this.save(list);
  }

  /** Verifies an approval of exactly `payload`. Throws 403 on anything else. */
  async verify(payload: ConfigApproval, a: ApprovalInput | undefined): Promise<"touch-id" | "passkey"> {
    if (!a) throw new OwnerError(428, "approval required");
    if ("signature" in a && typeof a.signature === "string") {
      if (!this.p256) throw new OwnerError(403, "Touch ID approvals are not set up for the owner service");
      const r = this.p256.verify(payload, a.signature);
      if (!r.ok) throw new OwnerError(403, `approval rejected (${r.reason})`);
      return "touch-id";
    }
    if ("webauthn" in a && a.webauthn && typeof a.webauthn === "object") {
      const wa = this.o.webauthn;
      if (!wa) throw new OwnerError(403, "passkey approvals are not configured (FLOW_ORIGIN / FLOW_RP_ID)");
      const list = this.passkeys();
      const k = list.find((x) => x.id === a.webauthn.id);
      if (!k) throw new OwnerError(403, "unknown passkey");
      if (Math.floor(Date.now() / 1000) > payload.expiresAt) throw new OwnerError(403, "approval expired");
      let ok = false;
      try {
        const v = await verifyAuthenticationResponse({
          response: a.webauthn,
          expectedChallenge: challengeFor(payload),
          expectedOrigin: wa.origin,
          expectedRPID: wa.rpId,
          requireUserVerification: true,
          credential: { id: k.id, publicKey: Buffer.from(k.publicKey, "base64url"), counter: k.counter, transports: k.transports as never },
        });
        ok = v.verified;
        if (ok) {
          k.counter = v.authenticationInfo.newCounter;
          this.save(list);
        }
      } catch (e) {
        throw new OwnerError(403, `passkey rejected: ${(e as Error).message}`);
      }
      if (!ok) throw new OwnerError(403, "passkey rejected");
      return "passkey";
    }
    throw new OwnerError(400, "approval must be { signature } or { webauthn }");
  }
}
