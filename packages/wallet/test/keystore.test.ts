import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSigner, FileKeyStore, decryptKey, encryptKey, generatePrivateKey, loadEncryptedKey } from "../src/index.js";

const KDF = { N: 2 ** 10, r: 8, p: 1 };

describe("keystore (§8.1)", () => {
  it("round-trips scrypt + AES-256-GCM and rejects a wrong passphrase", () => {
    const pk = generatePrivateKey();
    const blob = encryptKey(pk, "correct horse", { kdf: KDF });
    expect(blob.version).toBe(1);
    expect(JSON.stringify(blob)).not.toContain(pk.slice(2));
    expect(decryptKey(blob, "correct horse")).toBe(pk);
    expect(() => decryptKey(blob, "wrong")).toThrow(/wrong passphrase/);
  });

  it("default KDF params are N=2^17, r=8, p=1", () => {
    const blob = encryptKey(generatePrivateKey(), "pw-1234567", {});
    expect(blob.kdf).toMatchObject({ name: "scrypt", N: 131072, r: 8, p: 1, dkLen: 32 });
  });

  it("file store writes 0600 and the signer unlocks/locks", () => {
    const dir = mkdtempSync(join(tmpdir(), "ate-ks-"));
    const s = new FileKeyStore(dir);
    const blob = encryptKey(generatePrivateKey(), "pw", { id: "k1", kdf: KDF });
    s.save(blob);
    expect(statSync(join(dir, "k1.json")).mode & 0o777).toBe(0o600);
    const found = loadEncryptedKey("k1", [s])!;
    const sig = new AgentSigner("k1");
    expect(() => sig.get()).toThrow(/locked/);
    expect(sig.unlock(found.blob, "pw")).toBe(blob.address);
    sig.lock();
    expect(sig.unlocked).toBe(false);
  });
});
