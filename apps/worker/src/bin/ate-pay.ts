#!/usr/bin/env node
// ate-pay (payment agent) on the worker.
//   live:  ATE_HSP_LIVE=1 ate-pay           (G-HSP go; HSP via the allowlisted NAT egress)
//   demo:  ate-pay --mock                   (recorded HSP responses + in-process ate-signal; no network)
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { DEFAULT_PINNED_KEY_PATH, createApprovalVerifier, loadPinnedKey } from "@ate/approve";
import {
  CapLedger,
  JsonFilePaymentStore,
  PaymentAgent,
  createLocalEoaSigner,
  createMcpHspClient,
  createOnchainosSigner,
  missingHspTools,
  rawToMicroUsd,
  redact,
  type HspClient,
  type TypedDataSigner,
} from "@ate/payments";
import { MockHsp } from "@ate/payments/testing";
import { computeFairValue } from "../fairvalue.js";
import { PayService, httpSignalClient, startTicker, type SignalAgentClient } from "../pay.js";
import { SignalService } from "../signal.js";
import { WORKER_DIR, balanceReader, env, hspLiveAllowed, readToken, rotateToken, vaultPausedReader } from "../config.js";

async function main(argv: string[]): Promise<void> {
  const mock = argv.includes("--mock");
  if (!mock && !hspLiveAllowed()) {
    console.error("ate-pay: ATE_HSP_LIVE!=1 — refusing to connect to HSP (G-HSP not go). Run `ate-pay --mock` for recorded responses.");
    process.exit(2);
  }
  const now = () => Math.floor(Date.now() / 1000);
  let hsp: HspClient;
  let signal: SignalAgentClient;
  let signalAgent: Address;
  let payTo: Address;
  let signer: TypedDataSigner;
  let balanceOf: (t: Address, o: Address) => Promise<bigint>;

  if (mock) {
    hsp = new MockHsp({ now, queries: ["submitted", "safe", "finalized"] });
    const sigAcct = privateKeyToAccount(generatePrivateKey());
    const svc = new SignalService({
      hsp,
      account: sigAcct,
      payTo: sigAcct.address,
      token: "in-process",
      computeSignal: async () =>
        computeFairValue({ book: { bids: [[0.5, 1000], [0.499, 4000]], asks: [[0.501, 800], [0.502, 3000]], at: now() }, now: now() }),
    });
    signal = { offers: () => svc.createOffer(), redeem: (r) => svc.redeem(r) };
    signalAgent = sigAcct.address;
    payTo = sigAcct.address;
    signer = createLocalEoaSigner({ privateKey: generatePrivateKey() });
    balanceOf = async () => 10n ** 12n;
    console.log("ate-pay --mock: recorded HSP responses, throwaway keys, no network. NOT a real payment.");
  } else {
    hsp = await createMcpHspClient({ allowLive: true, endpoint: process.env.ATE_HSP_ENDPOINT });
    const missing = missingHspTools(await hsp.listTools());
    if (missing.length) throw new Error(`HSP tools missing: ${missing.join(", ")} — stop (§9.7)`);
    const chain = await hsp.getChainConfig();
    signal = httpSignalClient(env("ATE_SIGNAL_URL", "http://127.0.0.1:7402"), readToken(env("ATE_SIGNAL_TOKEN_FILE", join(WORKER_DIR, "signal.token"))));
    signalAgent = env("ATE_SIGNAL_AGENT") as Address;
    payTo = env("ATE_SIGNAL_PAY_TO", signalAgent) as Address;
    signer =
      env("ATE_SIGNER", "local-eoa") === "okx-agentic-wallet"
        ? createOnchainosSigner({ address: env("ATE_OKX_ADDRESS") as Address, chainId: chain.chainId })
        : createLocalEoaSigner({ keyFile: env("ATE_PAYER_KEY_FILE") });
    balanceOf = balanceReader(process.env.ATE_HSP_NETWORK_RPC ?? chain.rpcUrl);
    console.log(`ate-pay: HSP network ${chain.network} chain ${chain.chainId} token ${chain.token} (${chain.decimals} dp), signer ${signer.kind}`);
  }

  const pinned = loadPinnedKey(process.env.ATE_APPROVE_PUBKEY ?? DEFAULT_PINNED_KEY_PATH);
  const caps = new CapLedger({ perPaymentCapUsd: process.env.ATE_PER_PAYMENT_CAP_USD ?? "0.10", dailyCapUsd: process.env.ATE_DAILY_CAP_USD ?? "1.00" });
  const store = new JsonFilePaymentStore(process.env.ATE_PAY_STORE ?? join(WORKER_DIR, mock ? "payments.mock.json" : "payments.json"));
  // Re-seed today's cap usage from persisted payments.
  for (const r of store.all()) if (r.mandate && r.state !== "FAILED" && r.state !== "EXPIRED") {
    try {
      caps.reserve(r.id, rawToMicroUsd(BigInt(r.mandate.amountRaw), r.network.decimals), r.createdAt);
      if (r.state === "SETTLED" || r.state === "SETTLED_UNATTRIBUTED") caps.consume(r.id);
    } catch {
      /* over cap from history: leaves no headroom, which is the safe direction */
    }
  }
  const agent = new PaymentAgent({
    hsp,
    signer,
    store,
    caps,
    verifier: createApprovalVerifier(pinned, "ate-pay"),
    signalAgent,
    signalPayTo: payTo,
    merchantName: "Vikings",
    balanceOf,
    isVaultPaused: vaultPausedReader(process.env.ATE_HSK_RPC, process.env.ATE_VAULT_HSK as Address | undefined),
    onUpdate: (r, ev) => console.log(JSON.stringify(redact({ at: now(), payment: r.id, event: ev, state: r.state }))),
  });
  agent.recover();
  const token = rotateToken(env("ATE_PAY_TOKEN_FILE", join(WORKER_DIR, "pay.token")));
  const svc = new PayService({ agent, signal, token });
  const port = Number(process.env.ATE_PAY_PORT ?? 7401);
  await svc.listen(port);
  startTicker(agent);
  console.log(`ate-pay listening on 127.0.0.1:${port}; token in ${process.env.ATE_PAY_TOKEN_FILE ?? join(WORKER_DIR, "pay.token")} (0600)`);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`ate-pay: ${(e as Error).message}`);
  process.exit(1);
});
