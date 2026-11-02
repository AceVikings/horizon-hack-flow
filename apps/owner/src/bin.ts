#!/usr/bin/env node
// flow-owner — run the owner service (its own process, its own credentials).
//   flow-owner serve   Reads the owner signer from ATE_OWNER_* (secret | kms | keychain/file keystore whose secret is
//                      ATE_OWNER_KEY_SECRET), and a first stdin line { "token": "<bearer>" } from its supervisor
//                      (or FLOW_OWNER_TOKEN). Prints one JSON line { type: "owner.ready", port, owner } on stdout.
//   flow-owner seal    Seal a private key for the owner role: stdin line { "privateKey", "secret" } → blob JSON.
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { encryptKey, loadEncryptedKey, signerFromEnv, signerFromSecret, signerKind, FileKeyStore } from "@ate/wallet";
import { Approver } from "./approvals.js";
import { OwnerChain, loadDeployment } from "./chain.js";
import { createOwnerServer } from "./server.js";
import { OwnerService } from "./service.js";

const env = process.env;
const log = (m: string) => process.stderr.write(`[flow-owner] ${m}\n`);

async function firstLine(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin });
  for await (const l of rl) {
    rl.close();
    return l;
  }
  return null;
}

async function ownerSigner(home: string) {
  const kind = signerKind("owner", env);
  if (kind === "secret" || kind === "kms") return (await signerFromEnv("owner", env))!;
  const id = env.ATE_OWNER_KEY_ID ?? "owner";
  const found = loadEncryptedKey(id, [new FileKeyStore(join(home, "owner-keys"))]);
  if (!found || !env.ATE_OWNER_KEY_SECRET) throw new Error(`owner key ${id} not found in ${home}/owner-keys (or ATE_OWNER_KEY_SECRET unset)`);
  return signerFromSecret("owner", found.blob, env.ATE_OWNER_KEY_SECRET);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "seal") {
    const j = JSON.parse((await firstLine()) ?? "{}") as { privateKey?: `0x${string}`; secret?: string };
    if (!j.privateKey || !j.secret) throw new Error("stdin: { privateKey, secret }");
    process.stdout.write(`${JSON.stringify(encryptKey(j.privateKey, j.secret, { role: "owner", id: env.ATE_OWNER_KEY_ID ?? "owner" }))}\n`);
    return;
  }
  if (cmd !== "serve") {
    process.stderr.write("usage: flow-owner serve | seal\n");
    process.exit(2);
  }
  const home = env.FLOW_OWNER_HOME ?? join(env.ATE_HOME ?? join(homedir(), ".ate"), "owner");
  const token = env.FLOW_OWNER_STDIN === "1" ? (JSON.parse((await firstLine()) ?? "{}") as { token?: string }).token : env.FLOW_OWNER_TOKEN;
  if (!token) throw new Error("no supervisor token (stdin { token } with FLOW_OWNER_STDIN=1, or FLOW_OWNER_TOKEN)");
  const chainId = Number(env.FLOW_CHAIN_ID ?? 133);
  const dep = loadDeployment(chainId, env);
  const signer = await ownerSigner(home);
  const chain = new OwnerChain(signer.account, dep, env.FLOW_RPC_URL);
  const approver = new Approver({
    passkeysPath: join(home, "passkeys.json"),
    ...(env.ATE_APPROVE_PUBKEY ? { pinnedKeyPath: env.ATE_APPROVE_PUBKEY } : {}),
    webauthn: env.FLOW_ORIGIN && env.FLOW_RP_ID ? { origin: env.FLOW_ORIGIN, rpId: env.FLOW_RP_ID } : null,
  });
  const svc = new OwnerService({ chain, approver, home, env, log });
  const port = await createOwnerServer(svc, token, log).listen(Number(env.FLOW_OWNER_PORT ?? 0));
  process.stdout.write(`${JSON.stringify({ type: "owner.ready", port, owner: signer.account.address, backend: signer.backend })}\n`);
  log(`owner ${signer.account.address} (${signer.backend}) on 127.0.0.1:${port}, chain ${chainId}`);
}

main().catch((e) => {
  log((e as Error).message);
  process.exit(1);
});
