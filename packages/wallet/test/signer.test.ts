import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, parseTransaction, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AgentSigner,
  SECP256K1_N,
  assertNoOwnerCredentials,
  createKmsSigner,
  decryptKey,
  encryptKey,
  generatePrivateKey,
  parseDerSignature,
  signerFromEnv,
  withoutOwnerCredentials,
  type KmsLike,
} from "../src/index.js";

const KDF = { N: 2 ** 10, r: 8, p: 1 };
const SPKI_HDR = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");

/** Mock KMS over a local key. `highS` forces the non-canonical s half to exercise normalisation. */
function mockKms(pk: Hex, o: { highS?: boolean } = {}): KmsLike & { calls: number } {
  const priv = Buffer.from(pk.slice(2), "hex");
  const pub = Buffer.from(secp256k1.getPublicKey(priv, false));
  const m = {
    calls: 0,
    async getPublicKey() {
      return new Uint8Array(Buffer.concat([SPKI_HDR, pub]));
    },
    async sign(_k: string, digest: Uint8Array) {
      m.calls++;
      let sig = secp256k1.sign(digest, priv, { lowS: true });
      if (o.highS) sig = new secp256k1.Signature(sig.r, SECP256K1_N - sig.s) as unknown as typeof sig;
      return sig.toDERRawBytes();
    },
  };
  return m;
}

describe("KMS signer (ECC_SECG_P256K1)", () => {
  const pk = generatePrivateKey();
  const ref = privateKeyToAccount(pk);

  it("derives the address from GetPublicKey", async () => {
    const a = await createKmsSigner(mockKms(pk), "alias/flow-agent");
    expect(a.address).toBe(ref.address);
  });

  it("signs transactions that recover to the key (high-s from KMS is normalised to low-s)", async () => {
    for (const highS of [false, true]) {
      const a = await createKmsSigner(mockKms(pk, { highS }), "k");
      const tx = { chainId: 133, type: "eip1559" as const, nonce: 7, to: ref.address, data: "0x1234" as Hex, value: 1n, gas: 21_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n };
      const raw = await a.signTransaction(tx);
      expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(ref.address);
      const p = parseTransaction(raw);
      expect(BigInt(p.s!)).toBeLessThanOrEqual(SECP256K1_N / 2n);
      // byte-identical to a local signature (RFC 6979 is deterministic)
      expect(raw).toBe(await ref.signTransaction(tx));
    }
  });

  it("signs messages and typed data", async () => {
    const a = await createKmsSigner(mockKms(pk, { highS: true }), "k");
    const sig = await a.signMessage({ message: "flow" });
    expect(await recoverMessageAddress({ message: "flow", signature: sig })).toBe(ref.address);
    const td = { domain: { name: "Flow", chainId: 133 }, types: { M: [{ name: "x", type: "uint256" }] }, primaryType: "M" as const, message: { x: 1n } };
    expect(await recoverTypedDataAddress({ ...td, signature: await a.signTypedData(td) })).toBe(ref.address);
  });

  it("rejects a signature that does not recover to the key", async () => {
    const other = mockKms(generatePrivateKey());
    const kms: KmsLike = { getPublicKey: mockKms(pk).getPublicKey, sign: other.sign };
    const a = await createKmsSigner(kms, "k");
    await expect(a.signMessage({ message: "x" })).rejects.toThrow(/does not recover/);
  });

  it("parses DER with leading zero bytes", () => {
    const sig = secp256k1.sign(keccak256("0x01").slice(2), Buffer.from(pk.slice(2), "hex"));
    expect(parseDerSignature(sig.toDERRawBytes())).toEqual({ r: sig.r, s: sig.s });
  });
});

describe("roles are separate", () => {
  it("a blob sealed for the owner never opens as agent (AAD + role check)", () => {
    const pk = generatePrivateKey();
    const owner = encryptKey(pk, "s3cret", { kdf: KDF, role: "owner" });
    expect(owner.role).toBe("owner");
    expect(() => decryptKey(owner, "s3cret")).toThrow(/owner role/);
    expect(decryptKey(owner, "s3cret", "owner")).toBe(pk);
    // forging the role field does not help: the AAD binds it
    expect(() => decryptKey({ ...owner, role: undefined }, "s3cret")).toThrow(/wrong passphrase/);
  });

  it("signerFromEnv reads only its own role's names", async () => {
    const agentPk = generatePrivateKey();
    const ownerPk = generatePrivateKey();
    const env = {
      ATE_AGENT_SIGNER: "secret",
      ATE_AGENT_KEY_ENC: Buffer.from(JSON.stringify(encryptKey(agentPk, "a", { kdf: KDF }))).toString("base64"),
      ATE_AGENT_KEY_SECRET: "a",
      ATE_OWNER_SIGNER: "secret",
      ATE_OWNER_KEY_ENC: JSON.stringify(encryptKey(ownerPk, "o", { kdf: KDF, role: "owner" })),
      ATE_OWNER_KEY_SECRET: "o",
    };
    const a = await signerFromEnv("agent", env);
    const o = await signerFromEnv("owner", env);
    expect(a!.account.address).toBe(privateKeyToAccount(agentPk).address);
    expect(o!.account.address).toBe(privateKeyToAccount(ownerPk).address);
    // swapping the secrets across roles fails
    await expect(signerFromEnv("agent", { ATE_AGENT_KEY_ENC: env.ATE_OWNER_KEY_ENC, ATE_AGENT_KEY_SECRET: "o" })).rejects.toThrow(/owner role/);
  });

  it("the agent signer refuses an owner signer and the agent runtime refuses owner env", async () => {
    const pk = generatePrivateKey();
    const o = await signerFromEnv("owner", { ATE_OWNER_KEY_ENC: JSON.stringify(encryptKey(pk, "o", { kdf: KDF, role: "owner" })), ATE_OWNER_KEY_SECRET: "o" });
    expect(() => new AgentSigner("x").unlockSigner(o!)).toThrow(/non-agent/);
    expect(() => assertNoOwnerCredentials({ ATE_OWNER_KEY_SECRET: "x" })).toThrow(/owner credentials/);
    expect(() => assertNoOwnerCredentials(withoutOwnerCredentials({ ATE_OWNER_KEY_SECRET: "x", ATE_AGENT_KEY_SECRET: "y" }))).not.toThrow();
  });

  it("kms backend via env", async () => {
    const pk = generatePrivateKey();
    const s = await signerFromEnv("agent", { ATE_AGENT_SIGNER: "kms", ATE_AGENT_KMS_KEY_ID: "alias/a" }, { kms: mockKms(pk) });
    expect(s).toMatchObject({ role: "agent", backend: "kms" });
    expect(s!.account.address).toBe(privateKeyToAccount(pk).address);
  });
});
