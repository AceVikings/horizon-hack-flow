// AWS KMS signer (ECC_SECG_P256K1). The private key never leaves KMS: we ask KMS to sign a 32-byte digest
// (MessageType DIGEST, ECDSA_SHA_256), parse the DER signature into (r, s), normalise s to the low half of the curve
// order (EIP-2), and find the recovery id by trying yParity 0/1 against the address from GetPublicKey.
import { hashMessage, hashTypedData, keccak256, recoverAddress, serializeSignature, serializeTransaction, type Address, type Hex } from "viem";
import { publicKeyToAddress, toAccount, type LocalAccount } from "viem/accounts";

/** secp256k1 group order n. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N >> 1n;

/** The two KMS calls we need. `awsKms()` adapts @aws-sdk/client-kms; tests pass a mock. */
export interface KmsLike {
  /** DER SubjectPublicKeyInfo of the key. */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  /** DER ECDSA signature over a 32-byte digest. */
  sign(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

export function awsKms(region?: string): KmsLike {
  let client: Promise<{ send(c: unknown): Promise<any>; mod: any }> | null = null;
  const get = () =>
    (client ??= import("@aws-sdk/client-kms").then((mod: any) => {
      const c = new mod.KMSClient(region ? { region } : {});
      return { send: (x: unknown) => c.send(x), mod };
    }));
  return {
    async getPublicKey(keyId) {
      const { send, mod } = await get();
      const r = await send(new mod.GetPublicKeyCommand({ KeyId: keyId }));
      if (r.KeySpec && r.KeySpec !== "ECC_SECG_P256K1") throw new Error(`KMS key ${keyId} is ${r.KeySpec}, expected ECC_SECG_P256K1`);
      return r.PublicKey as Uint8Array;
    },
    async sign(keyId, digest) {
      const { send, mod } = await get();
      const r = await send(new mod.SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }));
      return r.Signature as Uint8Array;
    },
  };
}

/** Uncompressed point (0x04‖X‖Y) from a DER SubjectPublicKeyInfo (its BIT STRING is the last 65 bytes). */
export function spkiToPoint(spki: Uint8Array): Hex {
  const b = Buffer.from(spki);
  if (b.length < 65) throw new Error("public key too short");
  const pt = b.subarray(b.length - 65);
  if (pt[0] !== 0x04) throw new Error("expected an uncompressed secp256k1 point");
  return `0x${pt.toString("hex")}`;
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` → bigints. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const b = Buffer.from(der);
  let i = 0;
  const len = () => {
    let l = b[i++]!;
    if (l & 0x80) {
      const n = l & 0x7f;
      l = 0;
      for (let k = 0; k < n; k++) l = (l << 8) | b[i++]!;
    }
    return l;
  };
  if (b[i++] !== 0x30) throw new Error("DER: expected SEQUENCE");
  len();
  const int = () => {
    if (b[i++] !== 0x02) throw new Error("DER: expected INTEGER");
    const l = len();
    const v = b.subarray(i, i + l);
    i += l;
    return BigInt(`0x${v.toString("hex") || "0"}`);
  };
  const r = int();
  const s = int();
  if (r <= 0n || r >= SECP256K1_N || s <= 0n || s >= SECP256K1_N) throw new Error("DER: r or s out of range");
  return { r, s };
}

const hex32 = (x: bigint): Hex => `0x${x.toString(16).padStart(64, "0")}`;

/** KMS signature → Ethereum (r, s, yParity) with low s; the recovery id is the one that recovers `address`. */
export async function toEthSignature(der: Uint8Array, hash: Hex, address: Address): Promise<{ r: Hex; s: Hex; yParity: 0 | 1 }> {
  const { r, s: s0 } = parseDerSignature(der);
  const s = s0 > HALF_N ? SECP256K1_N - s0 : s0;
  for (const yParity of [0, 1] as const) {
    const sig = { r: hex32(r), s: hex32(s), yParity };
    const rec = await recoverAddress({ hash, signature: sig });
    if (rec.toLowerCase() === address.toLowerCase()) return sig;
  }
  throw new Error("KMS signature does not recover to the key's address");
}

/** viem LocalAccount whose every signature is made by KMS. */
export async function createKmsSigner(kms: KmsLike, keyId: string): Promise<LocalAccount> {
  const address = publicKeyToAddress(spkiToPoint(await kms.getPublicKey(keyId)));
  const signHash = async (hash: Hex) => toEthSignature(await kms.sign(keyId, Buffer.from(hash.slice(2), "hex")), hash, address);
  const account = toAccount({
    address,
    async signMessage({ message }) {
      return serializeSignature(await signHash(hashMessage(message)));
    },
    async signTypedData(td) {
      return serializeSignature(await signHash(hashTypedData(td as never)));
    },
    async signTransaction(tx, opts) {
      const ser = (opts?.serializer ?? serializeTransaction) as typeof serializeTransaction;
      const sig = await signHash(keccak256(ser(tx as never)));
      return ser(tx as never, sig);
    },
  });
  return account;
}
