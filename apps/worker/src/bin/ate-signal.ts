#!/usr/bin/env node
// ate-signal (receiving agent) on the worker. Live HSP only with ATE_HSP_LIVE=1 (G-HSP go).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { createMcpHspClient, missingHspTools } from "@ate/payments";
import { computeFairValue, fetchDepth } from "../fairvalue.js";
import { SignalService } from "../signal.js";
import { WORKER_DIR, env, hspLiveAllowed, rotateToken } from "../config.js";

async function main(): Promise<void> {
  if (!hspLiveAllowed()) {
    console.error("ate-signal: ATE_HSP_LIVE!=1 — refusing to connect to HSP (G-HSP not go). Use `ate-pay --mock` for the recorded-response demo.");
    process.exit(2);
  }
  const hsp = await createMcpHspClient({ allowLive: true, endpoint: process.env.ATE_HSP_ENDPOINT });
  const missing = missingHspTools(await hsp.listTools());
  if (missing.length) throw new Error(`HSP tools missing: ${missing.join(", ")} — stop (§9.7)`);
  const key = readFileSync(env("ATE_SIGNAL_KEY_FILE"), "utf8").trim() as Hex;
  const account = privateKeyToAccount(key);
  const token = rotateToken(env("ATE_SIGNAL_TOKEN_FILE", join(WORKER_DIR, "signal.token")));
  const svc = new SignalService({
    hsp,
    account,
    payTo: (process.env.ATE_SIGNAL_PAY_TO ?? account.address) as Address,
    priceUsd: process.env.ATE_SIGNAL_PRICE_USD ?? "0.02",
    token,
    computeSignal: async () => computeFairValue({ book: await fetchDepth("HSKUSDT", process.env.ATE_HASHKEY_GLOBAL_URL), now: Math.floor(Date.now() / 1000) }),
  });
  const port = Number(process.env.ATE_SIGNAL_PORT ?? 7402);
  await svc.listen(port);
  console.log(`ate-signal listening on 127.0.0.1:${port} (signal agent ${account.address})`);
}

main().catch((e: unknown) => {
  console.error(`ate-signal: ${(e as Error).message}`);
  process.exit(1);
});
