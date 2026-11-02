// Cloud auth: passkey (WebAuthn) first, password fallback (FLOW_PASSWORD, compared via scrypt in constant time).
// Sessions are in memory: an httpOnly, Secure, SameSite=Strict cookie (`__Host-` prefixed) plus a CSRF token the web
// bridge sends as `x-flow-csrf` on every write. Passkeys are stored in <home>/gateway/passkeys.json.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

export interface Passkey {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  addedAt: number;
}

export interface Session {
  id: string;
  csrf: string;
  createdAt: number;
  lastSeen: number;
  via: "passkey" | "password";
}

export const SESSION_TTL_MS = 12 * 3600_000;
export const IDLE_TTL_MS = 2 * 3600_000;

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const a = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const ok = a.length < this.max;
    if (ok) a.push(now);
    this.hits.set(key, a);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return ok;
  }
}

export class Auth {
  private sessions = new Map<string, Session>();
  private challenges = new Map<string, { challenge: string; at: number }>();
  private readonly pwSalt = randomBytes(16);
  private readonly pwHash: Buffer | null;

  constructor(
    private readonly o: { passkeysPath: string; password?: string; origin: string; rpId: string; rpName?: string },
  ) {
    this.pwHash = o.password && o.password.length >= 12 ? this.hash(o.password) : null;
  }

  private hash(p: string): Buffer {
    return scryptSync(p.normalize("NFKC"), this.pwSalt, 32, { N: 2 ** 14, r: 8, p: 1 });
  }

  get origin() {
    return this.o.origin;
  }
  get rpId() {
    return this.o.rpId;
  }
  get passwordEnabled() {
    return !!this.pwHash;
  }

  passkeys(): Passkey[] {
    try {
      return existsSync(this.o.passkeysPath) ? (JSON.parse(readFileSync(this.o.passkeysPath, "utf8")) as Passkey[]) : [];
    } catch {
      return [];
    }
  }
  private savePasskeys(l: Passkey[]) {
    mkdirSync(dirname(this.o.passkeysPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.o.passkeysPath, JSON.stringify(l, null, 2), { mode: 0o600 });
    chmodSync(this.o.passkeysPath, 0o600);
  }

  // ---------------------------------------------------------------- sessions

  private newSession(via: Session["via"]): Session {
    const s = { id: randomBytes(32).toString("base64url"), csrf: randomBytes(24).toString("base64url"), createdAt: Date.now(), lastSeen: Date.now(), via };
    this.sessions.set(s.id, s);
    return s;
  }

  session(id: string | undefined | null): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    const now = Date.now();
    if (!s || now - s.createdAt > SESSION_TTL_MS || now - s.lastSeen > IDLE_TTL_MS) {
      if (s) this.sessions.delete(id);
      return null;
    }
    s.lastSeen = now;
    return s;
  }

  logout(id: string) {
    this.sessions.delete(id);
  }

  checkCsrf(s: Session, header: string | undefined): boolean {
    return typeof header === "string" && header.length === s.csrf.length && timingSafeEqual(Buffer.from(header), Buffer.from(s.csrf));
  }

  passwordLogin(password: string): Session | null {
    if (!this.pwHash || typeof password !== "string" || password.length > 256) return null;
    return timingSafeEqual(this.hash(password), this.pwHash) ? this.newSession("password") : null;
  }

  // ---------------------------------------------------------------- WebAuthn ceremonies

  /** Challenge handle: the browser gets `flow` (an opaque id) and must send it back with the response. */
  private remember(challenge: string): string {
    const h = randomBytes(16).toString("base64url");
    const now = Date.now();
    for (const [k, v] of this.challenges) if (now - v.at > 120_000) this.challenges.delete(k);
    this.challenges.set(h, { challenge, at: now });
    return h;
  }
  private take(h: unknown): string | null {
    if (typeof h !== "string") return null;
    const c = this.challenges.get(h);
    this.challenges.delete(h);
    return c && Date.now() - c.at < 120_000 ? c.challenge : null;
  }

  async loginOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.o.rpId, userVerification: "required", allowCredentials: this.passkeys().map((k) => ({ id: k.id, transports: k.transports as never })) });
    return { flow: this.remember(options.challenge), options };
  }

  async passkeyLogin(flow: unknown, response: AuthenticationResponseJSON): Promise<Session | null> {
    const challenge = this.take(flow);
    if (!challenge) return null;
    return (await this.verifyAssertion(response, challenge)) ? this.newSession("passkey") : null;
  }

  /** Verifies an assertion over a caller-chosen challenge (approval tickets use sha256(payload)). */
  async verifyAssertion(response: AuthenticationResponseJSON, challenge: string): Promise<boolean> {
    const list = this.passkeys();
    const k = list.find((x) => x.id === response?.id);
    if (!k) return false;
    try {
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.o.origin,
        expectedRPID: this.o.rpId,
        requireUserVerification: true,
        credential: { id: k.id, publicKey: Buffer.from(k.publicKey, "base64url"), counter: k.counter, transports: k.transports as never },
      });
      if (!v.verified) return false;
      k.counter = v.authenticationInfo.newCounter;
      this.savePasskeys(list);
      return true;
    } catch {
      return false;
    }
  }

  async registerOptions() {
    const options = await generateRegistrationOptions({
      rpName: this.o.rpName ?? "Flow",
      rpID: this.o.rpId,
      userName: "owner",
      userDisplayName: "Flow owner",
      userID: new Uint8Array(createHash("sha256").update(`flow:${this.o.rpId}`).digest()),
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: this.passkeys().map((k) => ({ id: k.id })),
    });
    return { flow: this.remember(options.challenge), options };
  }

  async register(flow: unknown, response: RegistrationResponseJSON): Promise<Passkey | null> {
    const challenge = this.take(flow);
    if (!challenge) return null;
    try {
      const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: this.o.origin, expectedRPID: this.o.rpId, requireUserVerification: true });
      if (!v.verified || !v.registrationInfo) return null;
      const c = v.registrationInfo.credential;
      const k: Passkey = { id: c.id, publicKey: Buffer.from(c.publicKey).toString("base64url"), counter: c.counter, ...(c.transports ? { transports: c.transports } : {}), addedAt: Math.floor(Date.now() / 1000) };
      const list = this.passkeys().filter((x) => x.id !== k.id);
      list.push(k);
      this.savePasskeys(list);
      return k;
    } catch {
      return null;
    }
  }

  async assertionOptions(challenge: string) {
    return generateAuthenticationOptions({ rpID: this.o.rpId, userVerification: "required", challenge: Buffer.from(challenge, "base64url"), allowCredentials: this.passkeys().map((k) => ({ id: k.id, transports: k.transports as never })) });
  }
}
