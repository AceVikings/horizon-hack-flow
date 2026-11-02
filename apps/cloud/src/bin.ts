#!/usr/bin/env node
// flow-cloud — the whole product as one web service: gateway (this process) + owner service + daemon/trader.
// Env: PORT, FLOW_ORIGIN (https://<host>), FLOW_RP_ID (default: the origin's hostname), FLOW_PASSWORD (≥ 12 chars,
// password fallback), ATE_HOME (persistent dir), ATE_AGENT_* (agent signer, e.g. secret), ATE_OWNER_* (owner signer;
// only the owner child receives them), FLOW_DAEMON_ARGS (default "--approval-fallback=armed --profile WHSK=demo"),
// FLOW_CHAIN_ID (133), FLOW_TRUST_PROXY=1 behind the host's TLS proxy, FLOW_WEB_DIR.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../../desktop/src/main/daemon";
import { Auth } from "./auth.js";
import { CloudBridge, GatewayApprovalKey } from "./invoke.js";
import { Runs } from "./runs.js";
import { createGateway } from "./server.js";
import { DaemonProcess, OwnerProcess, homeDir } from "./supervisor.js";

const env = process.env;
const log = (m: string) => process.stderr.write(`[flow-cloud] ${m}\n`);
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const home = resolve(homeDir(env));
  mkdirSync(join(home, "gateway"), { recursive: true, mode: 0o700 });
  process.env.ATE_HOME = home; // DaemonClient reads <home>/runtime.json
  const port = Number(env.PORT ?? 8080);
  const origin = (env.FLOW_ORIGIN ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const rpId = env.FLOW_RP_ID ?? new URL(origin).hostname;
  const chainId = Number(env.FLOW_CHAIN_ID ?? 133);
  const password = env.FLOW_PASSWORD;

  // Daemon approvals in the cloud: an in-memory P-256 key, used only after a passkey assertion; pinned per boot.
  const approvalKey = new GatewayApprovalKey();
  const pin = join(home, "approve-pubkey.json");
  approvalKey.pin(pin);

  const childEnv: NodeJS.ProcessEnv = { ...env, ATE_HOME: home, FLOW_ORIGIN: origin, FLOW_RP_ID: rpId, FLOW_CHAIN_ID: String(chainId) };
  delete childEnv.FLOW_PASSWORD;
  // The owner service never trusts the gateway's approval key: owner approvals are passkeys it verifies itself.
  const ownerEnv = { ...childEnv };
  delete ownerEnv.ATE_APPROVE_PUBKEY;
  const owner = new OwnerProcess(ownerEnv, log);
  const proc = new DaemonProcess({ ...childEnv, ATE_APPROVE_PUBKEY: pin }, log, (env.FLOW_DAEMON_ARGS ?? "--approval-fallback=armed --profile WHSK=demo").split(/\s+/).filter(Boolean));
  // Secrets stay in the child environments only.
  for (const k of Object.keys(process.env)) if (k.startsWith("ATE_OWNER_") || k.startsWith("ATE_AGENT_") || k === "FLOW_PASSWORD") delete process.env[k];

  let gw: ReturnType<typeof createGateway> | null = null;
  let bridge!: CloudBridge;
  const daemon = new DaemonClient((e) => {
    bridge?.onEvent(e);
    gw?.broadcast(e);
  });
  const connect = async (token: string) => {
    daemon.setToken(token);
    for (let i = 0; i < 120; i++) {
      if ((await daemon.connect()).mode === "live") return;
      await new Promise((r) => setTimeout(r, 500));
    }
    log("daemon did not come up");
  };
  proc.restarted = (t) => void connect(t);
  const restartDaemon = async () => {
    daemon.close();
    await connect(await proc.restart());
  };

  const auth = new Auth({ passkeysPath: join(home, "gateway", "passkeys.json"), password, origin, rpId });
  const runs = new Runs();
  bridge = new CloudBridge({ daemon, proc, owner, auth, approvalKey, restartDaemon, chainId: () => chainId });
  gw = createGateway({
    auth,
    runs,
    bridge,
    webDir: env.FLOW_WEB_DIR ?? resolve(here, "../../desktop/out/web"),
    trustProxy: env.FLOW_TRUST_PROXY === "1",
    log,
    health: () => ({ ok: true, daemon: daemon.connection().mode, owner: owner.port ? "ready" : (owner.error ?? "starting"), chainId }),
    ownerAddPasskey: async (ctx, k) => {
      let r = await owner.call<{ added?: boolean; nonce?: string; challenge?: string; prompt?: string; error?: string }>("POST", "/owner/passkeys", k);
      if (r.status === 428 && r.body.nonce && r.body.challenge) {
        const a = await ctx.passkey({ challenge: r.body.challenge, prompt: r.body.prompt ?? "Add a passkey" });
        r = await owner.call("POST", "/owner/passkeys", { nonce: r.body.nonce, approval: { webauthn: a } });
      }
      return r.status === 200 ? { ok: true, data: { added: true } } : { ok: false, error: { code: "ATE_APPROVAL_REQUIRED", message: r.body.error ?? "the owner service did not accept the passkey" } };
    },
  });
  await new Promise<void>((r) => gw!.server.listen(port, "0.0.0.0", r));
  log(`listening on :${port} for ${origin} (rpId ${rpId}), home ${home}`);

  await owner.start();
  void proc.start().then(connect);

  const stop = async () => {
    daemon.close();
    await proc.stop();
    owner.child?.kill("SIGTERM");
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

main().catch((e) => {
  log((e as Error).stack ?? String(e));
  process.exit(1);
});
