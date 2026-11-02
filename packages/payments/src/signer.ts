// HSP typed-data signers (SPEC §8.4). Primary: OKX Agentic Wallet (`onchainos` CLI) on the worker.
// Fallback: a dedicated payer EOA whose key file is owned by the ate-pay service user, mode 0400.
// Both run only after human approval #1 (digest-bound) — the PaymentAgent enforces that, not the signer.
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { AteError } from "@ate/core";
import { hashTypedData, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TypedDataPayload } from "./hsp.js";

export interface TypedDataSigner {
  readonly kind: "okx-agentic-wallet" | "local-eoa";
  address(): Promise<Address>;
  signTypedData(td: TypedDataPayload): Promise<Hex>;
}

/** viem's typed-data args, with the implicit EIP712Domain type removed. */
export function toViemTypedData(td: TypedDataPayload) {
  const { EIP712Domain: _d, ...types } = td.types;
  // HSP JSON carries integers as strings; coerce (u)int fields of the primary struct to bigint.
  const fields = types[td.primaryType] ?? [];
  const message: Record<string, unknown> = { ...td.message };
  for (const f of fields) {
    const v = message[f.name];
    if (/^u?int\d*$/.test(f.type) && (typeof v === "string" || typeof v === "number")) message[f.name] = BigInt(v);
  }
  const domain: Record<string, unknown> = { ...td.domain };
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId);
  return { domain, types, primaryType: td.primaryType, message } as Parameters<typeof hashTypedData>[0];
}

/** EIP-712 digest the approvals are bound to (§8.4). */
export function typedDataDigest(td: TypedDataPayload): Hex {
  return hashTypedData(toViemTypedData(td));
}

export function createLocalEoaSigner(opts: { keyFile: string; skipModeCheck?: boolean } | { privateKey: Hex }): TypedDataSigner {
  let pk: Hex;
  if ("privateKey" in opts) pk = opts.privateKey;
  else {
    if (!opts.skipModeCheck) {
      const st = statSync(opts.keyFile);
      if ((st.mode & 0o077) !== 0) {
        throw new AteError("WalletError", "ATE_CONFIG_INVALID", `${opts.keyFile} must be mode 0400 (owned by the ate-pay user)`);
      }
    }
    const raw = readFileSync(opts.keyFile, "utf8").trim();
    pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  }
  if (!isHex(pk) || pk.length !== 66) throw new AteError("WalletError", "ATE_CONFIG_INVALID", "payer key must be 32-byte hex");
  const account = privateKeyToAccount(pk);
  return {
    kind: "local-eoa",
    address: async () => account.address,
    signTypedData: async (td) => account.signTypedData(toViemTypedData(td) as Parameters<typeof account.signTypedData>[0]),
  };
}

/**
 * OKX Agentic Wallet via the checksum-verified `onchainos` CLI. EIP-712 support on the HSP-returned network
 * is UNVERIFIED until `get_chain_config` runs on the worker (§8.4); the argv is configurable so the exact
 * subcommand can be fixed on the worker without a code change. Output must contain a 65-byte signature.
 */
export function createOnchainosSigner(opts: {
  binary?: string;
  address: Address;
  chainId: number;
  /** Default: ["wallet", "sign-message", "--type", "eip712", "--chain", "{chainId}", "--message", "{typedData}"]. */
  argv?: string[];
  timeoutMs?: number;
}): TypedDataSigner {
  const bin = opts.binary ?? "onchainos";
  const tmpl = opts.argv ?? ["wallet", "sign-message", "--type", "eip712", "--chain", "{chainId}", "--message", "{typedData}"];
  return {
    kind: "okx-agentic-wallet",
    address: async () => opts.address,
    signTypedData: (td) =>
      new Promise((resolve, reject) => {
        const json = JSON.stringify({ ...td, types: td.types });
        const args = tmpl.map((a) => a.replace("{chainId}", String(opts.chainId)).replace("{typedData}", json));
        execFile(bin, args, { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 256 * 1024 }, (err, stdout) => {
          const m = /0x[0-9a-fA-F]{130}/.exec(stdout.toString());
          if (m) resolve(m[0] as Hex);
          else reject(new AteError("WalletError", "ATE_PAYMENT_UNAVAILABLE", `onchainos did not return a signature${err ? `: ${err.message}` : ""}`));
        });
      }),
  };
}
