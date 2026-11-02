// Signer abstraction (SPEC §8.1, Flow cloud). Two roles, each with its own backend and its own env namespace:
//   agent → ATE_AGENT_*   (the daemon / TxQueue / trader; trades within the vault's on-chain limits)
//   owner → ATE_OWNER_*   (the owner service only; deploy, setLimits, setAgent/Guardian, unpause, withdraw)
// Backends: keychain/file keystore (desktop, scrypt + AES-GCM blob, passphrase), env secret (the same blob plus its
// passphrase in two env secrets; for containers), AWS KMS (ECC_SECG_P256K1, the key never leaves KMS).
// A role's factory reads only its own namespace, so the agent runtime has no code path to the owner credentials.
import { AteError } from "@ate/core";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { decryptKey, type EncryptedKey, type SignerRole } from "./index.js";
import { awsKms, createKmsSigner, type KmsLike } from "./kms.js";

export type SignerBackend = "keystore" | "secret" | "kms" | "raw";

export interface RoleSigner {
  role: SignerRole;
  backend: SignerBackend;
  account: LocalAccount;
}

const PREFIX: Record<SignerRole, string> = { agent: "ATE_AGENT_", owner: "ATE_OWNER_" };

/** Env names a role may read. The agent runtime refuses to start while any owner name is set (assertNoOwnerCredentials). */
export function roleEnvNames(role: SignerRole): string[] {
  const p = PREFIX[role];
  return [`${p}SIGNER`, `${p}KEY_ENC`, `${p}KEY_SECRET`, `${p}KMS_KEY_ID`, `${p}KMS_REGION`, `${p}KEY_ID`];
}

/** Parses an EncryptedKey given as JSON or base64(JSON). */
export function parseEncryptedKey(s: string): EncryptedKey {
  const t = s.trim();
  const json = t.startsWith("{") ? t : Buffer.from(t, "base64").toString("utf8");
  try {
    return JSON.parse(json) as EncryptedKey;
  } catch {
    throw new AteError("WalletError", "ATE_CONFIG_INVALID", "encrypted key secret is not JSON or base64(JSON)");
  }
}

/** Env-secret backend: an scrypt + AES-256-GCM blob sealed for `role`, opened with its own secret. */
export function signerFromSecret(role: SignerRole, blob: EncryptedKey, secret: string): RoleSigner {
  const pk = decryptKey(blob, secret, role);
  return { role, backend: "secret", account: privateKeyToAccount(pk) };
}

export type SignerKind = "keychain" | "file" | "secret" | "kms";

/** Which backend a role is configured for (ATE_<ROLE>_SIGNER; default keychain/file = the passphrase keystore). */
export function signerKind(role: SignerRole, env: NodeJS.ProcessEnv = process.env): SignerKind {
  const v = env[`${PREFIX[role]}SIGNER`];
  if (v === "secret" || v === "kms" || v === "file" || v === "keychain") return v;
  if (v) throw new AteError("ConfigError", "ATE_CONFIG_INVALID", `${PREFIX[role]}SIGNER must be keychain|file|secret|kms`);
  return env[`${PREFIX[role]}KEY_ENC`] ? "secret" : env[`${PREFIX[role]}KMS_KEY_ID`] ? "kms" : "keychain";
}

/**
 * Builds the env-configured signer for `role` (secret or kms). Keystore backends need a passphrase prompt and are
 * opened by the caller (AgentSigner.unlock / the owner service). Reads only the role's own ATE_<ROLE>_* names.
 */
export async function signerFromEnv(role: SignerRole, env: NodeJS.ProcessEnv = process.env, o: { kms?: KmsLike } = {}): Promise<RoleSigner | null> {
  const p = PREFIX[role];
  const kind = signerKind(role, env);
  if (kind === "secret") {
    const enc = env[`${p}KEY_ENC`];
    const secret = env[`${p}KEY_SECRET`];
    if (!enc || !secret) throw new AteError("ConfigError", "ATE_CONFIG_INVALID", `${p}SIGNER=secret needs ${p}KEY_ENC and ${p}KEY_SECRET`);
    return signerFromSecret(role, parseEncryptedKey(enc), secret);
  }
  if (kind === "kms") {
    const keyId = env[`${p}KMS_KEY_ID`];
    if (!keyId) throw new AteError("ConfigError", "ATE_CONFIG_INVALID", `${p}SIGNER=kms needs ${p}KMS_KEY_ID`);
    const kms = o.kms ?? awsKms(env[`${p}KMS_REGION`] ?? env.AWS_REGION);
    return { role, backend: "kms", account: await createKmsSigner(kms, keyId) };
  }
  return null;
}

/** Fail closed: the agent runtime must never be started with owner credentials in its environment. */
export function assertNoOwnerCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const found = roleEnvNames("owner").filter((k) => env[k] !== undefined && env[k] !== "");
  if (found.length) {
    throw new AteError("ConfigError", "ATE_CONFIG_INVALID", `owner credentials present in the agent runtime's environment (${found.join(", ")})`, {
      hint: "Owner keys belong to the owner service only; the supervisor must not pass ATE_OWNER_* to the daemon.",
    });
  }
}

/** Copy of `env` without any owner-role names (what a supervisor hands the agent runtime). */
export function withoutOwnerCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k.startsWith(PREFIX.owner)) delete out[k];
  return out;
}
