// @ate/wallet — agent keystore (§8.1): scrypt(N=2^17, r=8, p=1) → AES-256-GCM, versioned header with KDF
// params. Pluggable store: macOS login keychain (`security`), file (~/.ate/keys) for headless, or env.
// Private material is never logged or serialised outside the encrypted blob (§8.2).

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AteError, CHAIN_ID } from "@ate/core";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface KdfParams {
  name: "scrypt";
  N: number;
  r: number;
  p: number;
  dkLen: 32;
  salt: string;
}

export interface EncryptedKey {
  version: 1;
  id: string;
  address: `0x${string}`;
  kdf: KdfParams;
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
}

export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;

function derive(pass: string, kdf: KdfParams): Buffer {
  return scryptSync(pass.normalize("NFKC"), Buffer.from(kdf.salt, "hex"), kdf.dkLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.N * kdf.r + 1024 * 1024,
  });
}

export function encryptKey(privateKey: `0x${string}`, passphrase: string, opts: { id?: string; kdf?: { N: number; r: number; p: number } } = {}): EncryptedKey {
  const k = opts.kdf ?? DEFAULT_KDF;
  const kdf: KdfParams = { name: "scrypt", N: k.N, r: k.r, p: k.p, dkLen: 32, salt: randomBytes(16).toString("hex") };
  const key = derive(passphrase, kdf);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const id = opts.id ?? randomUUID();
  c.setAAD(Buffer.from(`ate/${CHAIN_ID}/agent/${id}`));
  const ct = Buffer.concat([c.update(Buffer.from(privateKey.slice(2), "hex")), c.final()]);
  key.fill(0);
  return {
    version: 1,
    id,
    address: privateKeyToAccount(privateKey).address,
    kdf,
    cipher: { name: "aes-256-gcm", iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex") },
    ciphertext: ct.toString("hex"),
  };
}

export function decryptKey(blob: EncryptedKey, passphrase: string): `0x${string}` {
  if (blob.version !== 1 || blob.kdf.name !== "scrypt" || blob.cipher.name !== "aes-256-gcm") {
    throw new AteError("WalletError", "ATE_DAEMON_LOCKED", "unsupported keystore format");
  }
  const key = derive(passphrase, blob.kdf);
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.cipher.iv, "hex"));
    d.setAAD(Buffer.from(`ate/${CHAIN_ID}/agent/${blob.id}`));
    d.setAuthTag(Buffer.from(blob.cipher.tag, "hex"));
    const pt = Buffer.concat([d.update(Buffer.from(blob.ciphertext, "hex")), d.final()]);
    const pk = `0x${pt.toString("hex")}` as `0x${string}`;
    pt.fill(0);
    return pk;
  } catch {
    throw new AteError("WalletError", "ATE_DAEMON_LOCKED", "wrong passphrase or corrupted keystore", { hint: "Re-run `ate unlock` with the correct passphrase", retryable: true });
  } finally {
    key.fill(0);
  }
}

// ------------------------------------------------------------------ stores

export interface KeyStore {
  readonly kind: "keychain" | "file" | "memory";
  load(id: string): EncryptedKey | null;
  save(blob: EncryptedKey): void;
}

export const keychainService = (id: string) => `ate/${CHAIN_ID}/agent/${id}`;

/** macOS login keychain via /usr/bin/security (generic password, account = "ate"). */
export class MacKeychainStore implements KeyStore {
  readonly kind = "keychain" as const;
  static available(): boolean {
    return process.platform === "darwin" && existsSync("/usr/bin/security");
  }
  load(id: string): EncryptedKey | null {
    try {
      const out = execFileSync("/usr/bin/security", ["find-generic-password", "-a", "ate", "-s", keychainService(id), "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return JSON.parse(Buffer.from(out.trim(), "base64").toString("utf8")) as EncryptedKey;
    } catch {
      return null;
    }
  }
  save(blob: EncryptedKey): void {
    const data = Buffer.from(JSON.stringify(blob)).toString("base64");
    execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-a", "ate", "-s", keychainService(blob.id), "-w", data], { stdio: "ignore" });
  }
}

/** Headless fallback: ~/.ate/keys/<id>.json (mode 0600; still scrypt+AES-GCM encrypted). */
export class FileKeyStore implements KeyStore {
  readonly kind = "file" as const;
  constructor(private readonly dir: string) {}
  path(id: string) {
    return join(this.dir, `${id}.json`);
  }
  load(id: string): EncryptedKey | null {
    const p = this.path(id);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as EncryptedKey) : null;
  }
  save(blob: EncryptedKey): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path(blob.id), JSON.stringify(blob, null, 2), { mode: 0o600 });
    chmodSync(this.path(blob.id), 0o600);
  }
}

export class MemoryKeyStore implements KeyStore {
  readonly kind = "memory" as const;
  private m = new Map<string, EncryptedKey>();
  load(id: string) {
    return this.m.get(id) ?? null;
  }
  save(b: EncryptedKey) {
    this.m.set(b.id, b);
  }
}

/** Store selection: ATE_KEYSTORE=keychain|file (default keychain on macOS, else file). */
export function defaultKeyStore(ateHome: string, env: NodeJS.ProcessEnv = process.env): KeyStore {
  const want = env.ATE_KEYSTORE;
  if (want === "file" || (want !== "keychain" && !MacKeychainStore.available())) return new FileKeyStore(join(ateHome, "keys"));
  return new MacKeychainStore();
}

/** Look up the key in the preferred store, falling back to the file store. */
export function loadEncryptedKey(id: string, stores: KeyStore[]): { blob: EncryptedKey; store: KeyStore } | null {
  for (const s of stores) {
    const b = s.load(id);
    if (b) return { blob: b, store: s };
  }
  return null;
}

/** Holds the unlocked agent account in memory only (§8.3). */
export class AgentSigner {
  private account: PrivateKeyAccount | null = null;
  constructor(readonly keyId: string) {}
  get unlocked(): boolean {
    return this.account !== null;
  }
  get address(): `0x${string}` | null {
    return this.account?.address ?? null;
  }
  unlock(blob: EncryptedKey, passphrase: string): `0x${string}` {
    const pk = decryptKey(blob, passphrase);
    this.account = privateKeyToAccount(pk);
    return this.account.address;
  }
  /** Test / env helper: ATE_AGENT_PRIVATE_KEY (never logged). */
  unlockRaw(pk: `0x${string}`): `0x${string}` {
    this.account = privateKeyToAccount(pk);
    return this.account.address;
  }
  lock(): void {
    this.account = null; // best-effort zeroing (§8.2)
  }
  get(): PrivateKeyAccount {
    if (!this.account) throw new AteError("WalletError", "ATE_DAEMON_LOCKED", "daemon is locked", { hint: "Run `ate unlock`" });
    return this.account;
  }
}

export { generatePrivateKey };
