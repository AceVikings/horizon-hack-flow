// Daemon bootstrap: config → keystore → chain → TxQueue → strategy seam → journal → service → HTTP/MCP.

import { registerChatRoutes } from "./chat.js";
import { registerAppRoutes } from "./app-routes.js";
import { registerStrategyRoutes } from "./strategies/index.js";
import { AiEngine } from "./engine.js";
import { ProviderKeys } from "./providers.js";
import { ProxySidecar } from "./sidecar.js";
import { OpencodeEngine } from "./opencode.js";
import { McpServers } from "./mcp-servers.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AteError, MIN_CANDIDATE_TTL_SEC, WHSK_DEMO_PROFILE_OVERRIDES, type TokenScope, isMarketId, parseConfig, applyConfigNetwork, type AteConfig, type MarketId, type Profile, type RuntimeJson } from "@ate/core";
import { createChainClient } from "@ate/chain";
import { Journal, migrate } from "@ate/journal";
import { AgentSigner, FileKeyStore, assertNoOwnerCredentials, defaultKeyStore, encryptKey, generatePrivateKey, loadEncryptedKey, signerFromEnv, signerKind, type KeyStore } from "@ate/wallet";
import { DaemonHttp, Routes, TokenRegistry } from "./http.js";
import { AteService, type Attesterish } from "./service.js";
import { loadStrategy } from "./strategy-stub.js";
import { TxQueue, viemTxChain } from "./txqueue.js";
import { ensureSetupConfig, registerSetupRoutes, type SetupTty } from "./setup/routes.js";
import { createWriteStream } from "node:fs";
import { createChartService } from "./charts/index.js";

export const DAEMON_VERSION = "0.1.0";

export function ateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ATE_HOME ?? join(homedir(), ".ate");
}

export function loadConfigFile(path: string): AteConfig {
  if (!existsSync(path)) throw new AteError("ConfigError", "ATE_CONFIG_INVALID", `config not found: ${path}`, { hint: "Run `ate init` or set ATE_HOME / --config" });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new AteError("ConfigError", "ATE_CONFIG_INVALID", `config is not valid JSON: ${(e as Error).message}`);
  }
  const cfg = parseConfig(raw);
  applyConfigNetwork(cfg); // additive: testnet 133 rewrites the market/token constants; no-op on 177
  return cfg;
}

/** Finds deployments/<chainId>.json (177 default): ATE_DEPLOYMENTS, cwd, then up from this module (repo checkout). */
export function findDeployments(env: NodeJS.ProcessEnv = process.env, chainId: number = 177): string | null {
  const f = `deployments/${chainId}.json`;
  const cands = [env.ATE_DEPLOYMENTS, join(process.cwd(), f)];
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    cands.push(join(d, f));
    d = dirname(d);
  }
  return cands.find((p): p is string => !!p && existsSync(p)) ?? null;
}

export function resolveCandidateTtl(cfg: AteConfig, env: NodeJS.ProcessEnv = process.env): { ttl: number; source: string } {
  const v = cfg.strategy.portfolio.candidateTtlSec;
  if (typeof v === "number") return { ttl: Math.max(MIN_CANDIDATE_TTL_SEC, v), source: "config" };
  const p = findDeployments(env, cfg.chain.id);
  if (p) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { candidateTtlSec?: number; strategy?: { candidateTtlSec?: number } };
      const t = j.candidateTtlSec ?? j.strategy?.candidateTtlSec;
      if (typeof t === "number") return { ttl: Math.max(MIN_CANDIDATE_TTL_SEC, t), source: p };
    } catch {
      /* fallthrough */
    }
  }
  return { ttl: 180, source: "default (deployments/177.json has no candidateTtlSec yet)" };
}

export function keyStores(home: string, env: NodeJS.ProcessEnv = process.env): KeyStore[] {
  const primary = defaultKeyStore(home, env);
  return primary.kind === "file" ? [primary] : [primary, new FileKeyStore(join(home, "keys"))];
}

/** Creates the agent key (scrypt + AES-GCM) in the keychain (or file store). Returns its address. */
export function createAgentKey(home: string, id: string, passphrase: string, env: NodeJS.ProcessEnv = process.env, kdf?: { N: number; r: number; p: number }): { address: string; store: string } {
  const [store] = keyStores(home, env);
  if (store!.load(id)) throw new AteError("WalletError", "ATE_CONFIG_INVALID", `agent key ${id} already exists`);
  const blob = encryptKey(env.ATE_IMPORT_PRIVATE_KEY ? (env.ATE_IMPORT_PRIVATE_KEY as `0x${string}`) : generatePrivateKey(), passphrase, { id, ...(kdf ? { kdf } : {}) });
  store!.save(blob);
  return { address: blob.address, store: store!.kind };
}

export interface StartOptions {
  home?: string;
  config?: string;
  env?: NodeJS.ProcessEnv;
  port?: number;
  allowRogue?: boolean;
  approvalFallback?: "off" | "armed" | "tty";
  profiles?: Partial<Record<MarketId, Profile>>;
  scan?: boolean;
  forceStubStrategy?: boolean;
  log?: (m: string) => void;
  /** Printed once to the controlling TTY (rogue token, view URL). */
  tty?: (m: string) => void;
  /**
   * Additive (desktop onboarding): the app owns this daemon. A fresh home gets a testnet config from
   * deployments/133.json (strategy off) instead of failing, and the /setup/* routes drive the rest.
   */
  setup?: boolean;
}

export interface RunningDaemon {
  service: AteService;
  http: DaemonHttp;
  tokens: TokenRegistry;
  agentToken: string;
  rogueToken: string | null;
  viewToken: string;
  port: number;
  runtimePath: string;
  unlock(passphrase: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startDaemon(o: StartOptions = {}): Promise<RunningDaemon> {
  const env = o.env ?? process.env;
  const home = o.home ?? ateHome(env);
  const log = o.log ?? ((m: string) => process.stderr.write(`[ate-daemon] ${m}\n`));
  const tty = o.tty ?? ((m: string) => process.stderr.write(`${m}\n`));
  // The agent runtime never sees owner credentials (owner ops run in the separate owner service, apps/owner).
  assertNoOwnerCredentials(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = o.config ?? join(home, "config.json");
  if (o.setup && ensureSetupConfig(home, configPath, env)) log(`setup: wrote a fresh testnet config to ${configPath}`);
  const cfg = loadConfigFile(configPath);
  const { ttl, source } = resolveCandidateTtl(cfg, env);
  log(`candidateTtlSec = ${ttl} (${source})`);

  const db = new Database(env.ATE_DB ?? join(home, "ate.db"));
  migrate(db);
  const journal = new Journal(db);
  const v = journal.verify();
  if (!v.ok) throw new AteError("InternalError", "ATE_INTERNAL", `journal chain broken at seq ${v.seq}: ${v.reason}`);

  const chain = createChainClient({ urls: cfg.chain.rpcUrls, chainId: cfg.chain.id, log });
  const signer = new AgentSigner(cfg.agentKeyId);
  const txq = new TxQueue({ chain: viemTxChain(chain.client as never), account: () => signer.get(), chainId: cfg.chain.id, log });

  let service!: AteService;
  const strategy = await loadStrategy(() => service?.openProposals() ?? [], { forceStub: o.forceStubStrategy || env.ATE_STRATEGY_STUB === "1" });
  log(`strategy seam: ${strategy.source}`);

  let attester: Attesterish | null = null;
  try {
    const name = "@ate/journal/attest";
    const mod = (await import(name)) as { Attester?: new (o: { schemaUid?: string; attestFloorHsk?: string }) => Attesterish };
    if (mod.Attester) attester = new mod.Attester({ schemaUid: cfg.eas.schemaUid, attestFloorHsk: cfg.daemon.attestFloorHsk });
  } catch (e) {
    log(`EAS attester unavailable (${(e as Error).message.split("\n")[0]}); attestations deferred`);
  }

  const tokens = new TokenRegistry();
  const routes = new Routes();
  let http!: DaemonHttp;
  const emit = (e: { type: string; at: number; data: unknown }) => {
    try {
      db.prepare("INSERT INTO events (at, kind, payload) VALUES (?, ?, ?)").run(e.at, e.type, JSON.stringify(e.data));
    } catch {
      /* best effort */
    }
    http?.broadcast(e);
  };
  service = new AteService({ cfg, db, journal, chain, signer, txq, strategy, candidateTtlSec: ttl, version: DAEMON_VERSION, emit, attester, profiles: o.profiles ?? {}, log });
  service.charts = createChartService({ cfg, db, journal, chain, service, log }); // lane D4 (additive): ate_chart / ate_data

  for (const [m, prof] of Object.entries(o.profiles ?? {})) {
    if (prof === "demo" && m === "hsk-dex:WHSK/USDT:3000") Object.assign(service.strategy.markets[m], WHSK_DEMO_PROFILE_OVERRIDES);
  }
  const stores = keyStores(home, env);
  // Env-configured agent backends (cloud): ATE_AGENT_SIGNER=secret (sealed blob + secret) | kms. No passphrase prompt.
  const envBackend = signerKind("agent", env);
  const unlockFromEnv = async (): Promise<string> => {
    const s = await signerFromEnv("agent", env);
    const addr = signer.unlockSigner(s!);
    db.prepare("UPDATE agents SET address = ? WHERE id = ?").run(addr, cfg.agentKeyId);
    emit({ type: "daemon.locked", at: Math.floor(Date.now() / 1000), data: { locked: false } });
    log(`unlocked agent ${addr} (${envBackend})`);
    return addr;
  };
  const unlock = async (passphrase: string): Promise<string> => {
    if (envBackend === "secret" || envBackend === "kms") return unlockFromEnv();
    const found = loadEncryptedKey(cfg.agentKeyId, stores);
    if (!found) throw new AteError("WalletError", "ATE_DAEMON_LOCKED", `agent key ${cfg.agentKeyId} not found in ${stores.map((s) => s.kind).join("/")}`, { hint: "Create it with `ate-daemon keygen`" });
    const addr = signer.unlock(found.blob, passphrase);
    db.prepare("UPDATE agents SET address = ? WHERE id = ?").run(addr, cfg.agentKeyId);
    emit({ type: "daemon.locked", at: Math.floor(Date.now() / 1000), data: { locked: false } });
    log(`unlocked agent ${addr}`);
    return addr;
  };
  if (envBackend === "secret" || envBackend === "kms") {
    await unlockFromEnv().catch((e) => log(`agent signer (${envBackend}) failed: ${(e as Error).message}`));
  } else if (env.ATE_AGENT_PRIVATE_KEY && env.ATE_ALLOW_RAW_KEY === "1") {
    signer.unlockRaw(env.ATE_AGENT_PRIVATE_KEY as `0x${string}`);
    log(`unlocked from ATE_AGENT_PRIVATE_KEY (dev/fork only): ${signer.address}`);
  } else if (env.ATE_AGENT_PASSPHRASE) {
    await unlock(env.ATE_AGENT_PASSPHRASE).catch((e) => log(`auto-unlock failed: ${(e as Error).message}`));
  }

  http = new DaemonHttp({ service, tokens, routes, version: DAEMON_VERSION, port: o.port ?? cfg.daemon.port, unlock, log });
  const agentToken = tokens.mint({ scope: "agent" });
  const viewToken = tokens.mint({ scope: "view" });
  const rogueToken = o.allowRogue ? tokens.mint({ scope: "rogue" }) : null;

  const port = await http.listen();

  // Lane E's approval routes (/ui/attach, /chat/session, /strategy/approve) + armed TTY fallback (§10.1).
  // Desktop-owned daemon: one-time codes go to the parent app over an inherited pipe (ATE_APPROVAL_CODE_FD),
  // never to a log, and `approval-fallback enable` arrives on the stdin pipe (ATE_APPROVAL_STDIN=1).
  let approvalHandle: { tty: SetupTty; verifier: import("@ate/approve").ApprovalVerifier | null; hasPinnedKey: boolean } | null = null;
  const codeFd = env.ATE_APPROVAL_CODE_FD ? Number(env.ATE_APPROVAL_CODE_FD) : null;
  const codeSink = codeFd !== null && Number.isInteger(codeFd) && codeFd > 2 ? createWriteStream("", { fd: codeFd }) : null;
  // App-owned daemon (desktop): hand the parent its ui token over the private pipe, so opening the app needs no
  // Touch ID or code (v1 policy). Never logged; only an inherited fd the parent created can read it.
  if (codeSink) codeSink.write(`${JSON.stringify({ type: "ui.token", token: tokens.mint({ scope: "ui" }) })}\n`);
  try {
    const mod = (await import("./approval/index.js" as string)) as {
      createDaemonApproval?: (o: Record<string, unknown>) => {
        routes: { method: string; path: string; scopes: TokenScope[]; auth: string; handle: (body: unknown, scope: TokenScope | null) => Promise<{ status: number; body: unknown }> }[];
        tty: { handleTtyLine: (line: string) => unknown };
        service: { onStrategyPending?: (d: unknown) => void };
      };
    };
    if (mod.createDaemonApproval) {
      const approval = mod.createDaemonApproval({
        pid: process.pid,
        port,
        approvalFallback: o.approvalFallback ?? cfg.daemon.approvalFallback,
        // Additive (cloud): the pinned approval key may live in ATE_HOME (the web gateway's passkey-gated key).
        ...(env.ATE_APPROVE_PUBKEY ? { pinnedKeyPath: env.ATE_APPROVE_PUBKEY } : existsSync(join(home, "approve-pubkey.json")) ? { pinnedKeyPath: join(home, "approve-pubkey.json") } : {}),
        ...(codeSink ? { ttyWrite: (line: string) => void codeSink.write(`${JSON.stringify({ type: "approval.tty", line, code: /\b([0-9]{8})\b/.exec(line)?.[1] ?? null })}\n`) } : {}),
        mintUiToken: () => tokens.mint({ scope: "ui" }),
        mintSessionToken: (sessionId: string) => {
          const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
          return { token: tokens.mint({ scope: "session", sessionId, expiresAt }), expiresAt };
        },
        getPendingStrategyChange: (changeId: string) => {
          const p = service.pendingChange(changeId);
          return p ? { changeId, diff: p.changes, renderedDiff: p.renderedDiff, expiresAt: p.expiresAt } : undefined;
        },
        applyStrategyChange: async (changeId: string) => ({ applied: true, ...service.applyPendingChange(changeId) }),
        journalApproval: (e: unknown) => log(`approval: ${JSON.stringify(e)}`),
      });
      for (const r of approval.routes) {
        routes.register({
          method: r.method,
          path: r.path,
          scopes: r.auth === "required" ? r.scopes : null,
          handler: async ({ body, auth, json }) => {
            const out = await r.handle(body, auth?.scope ?? null);
            json(out.status, out.body);
          },
        });
      }
      approvalHandle = approval as unknown as typeof approvalHandle;
      if (process.stdin.isTTY || env.ATE_APPROVAL_STDIN === "1") {
        const { createInterface } = await import("node:readline");
        createInterface({ input: process.stdin }).on("line", (l) => void approval.tty.handleTtyLine(l));
      }
      service.onStrategyPending = (det) => approval.service.onStrategyPending?.(det);
      log(`approval routes mounted (${approval.routes.map((r) => r.path).join(", ")})`);
    }
  } catch (e) {
    log(`approval routes unavailable: ${(e as Error).message.split("\n")[0]}`);
  }
  // /chat/token, /chat (chat runner with a per-session chat token) and /trade/approve (confirm mode).
  // In-app agent engine (Anthropic SDK) shared by the chat routes and the supervised trader.
  // The default engine runs on the user's subscriptions through the CLIProxyAPI sidecar the daemon manages.
  const sidecar = new ProxySidecar(home, new ProviderKeys(home, env), env);
  // OpenCode: the user's opencode login, driven through a private `opencode serve` that calls Flow's MCP.
  // Extra MCP servers per agent (Tools (MCP)); a change restarts the private opencode server on its next prompt.
  const mcpServers = new McpServers(home, new ProviderKeys(home, env), env);
  const opencode = new OpencodeEngine({ home, daemonPort: port, tokens, env, log, mcp: mcpServers });
  mcpServers.onChange = () => opencode.stop();
  const ai = new AiEngine(home, env, {}, sidecar, opencode, mcpServers);
  registerChatRoutes({ routes, tokens, service, home, emit, log, ai });
  // /setup/* (desktop onboarding + Settings), ui scope only.
  registerSetupRoutes({ routes, home, env, cfg, configPath, service, unlock, broadcast: (e) => http.broadcast(e), approval: approvalHandle, log });
  // Flow desktop v1 (additive): supervised trader, pending-change list/reject, in-app proof suite (testnet only).
  const app = registerAppRoutes({ routes, tokens, service, home, port, deploymentsPath: findDeployments(env, cfg.chain.id), ai, approval: approvalHandle, log });
  // Lane STRAT (additive): custom strategies, backtests, practice runs and training (+ ate_backtest / ate_strategy_save).
  const traderMod = (await import("@ate/trader").catch(() => null)) as { TRADER_PROMPT_PATH?: string } | null;
  registerStrategyRoutes({ routes, cfg, db, service, ai, traderPromptFile: traderMod?.TRADER_PROMPT_PATH ?? "", emit, autonomous: () => {
    const t = app.trader.state();
    return t.running && t.mode === "autonomous";
  }, log });
  const runtime: RuntimeJson = { pid: process.pid, port, agentToken, startedAt: Math.floor(Date.now() / 1000), version: DAEMON_VERSION };
  const runtimePath = join(home, "runtime.json");
  writeFileSync(runtimePath, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  chmodSync(runtimePath, 0o600);

  await service.init().catch((e) => log(`init: ${(e as Error).message}`));
  txq.start();
  if (o.scan !== false) service.startScan();
  // start the subscription proxy first (if installed) so a resumed LLM trader finds its models
  const sidecarUp = ai.config.provider === "subscription" && sidecar.detect() && env.ATE_SIDECAR !== "0" ? sidecar.start().then(() => ai.test("subscription")).catch((e) => log(`subscription proxy: ${(e as Error).message}`)) : Promise.resolve();
  if (env.ATE_TRADER_RESUME !== "0") void sidecarUp.then(() => app.trader.resume());

  log(`listening on http://127.0.0.1:${port} (MCP: /mcp, events: /events) — ${signer.unlocked ? "unlocked" : "LOCKED (run `ate unlock`)"}`);
  tty(`read-only view: http://127.0.0.1:${port}/view#token=${viewToken}`);
  if (rogueToken) tty(`rogue token (printed once, --allow-rogue): ${rogueToken}`);

  return {
    service,
    http,
    tokens,
    agentToken,
    rogueToken,
    viewToken,
    port,
    runtimePath,
    unlock,
    stop: async () => {
      await app.trader.stop(false);
      await sidecar.stop();
      opencode.stop();
      await mcpServers.closeAll();
      service.stopScan();
      txq.stop();
      await http.close();
      db.close();
    },
  };
}

export function readRuntime(home: string): RuntimeJson {
  const p = join(home, "runtime.json");
  if (!existsSync(p)) throw new AteError("ConfigError", "ATE_DAEMON_LOCKED", `daemon not running (no ${p})`, { hint: "Start it with `ate-daemon start` (or `ate daemon start`)", retryable: true });
  return JSON.parse(readFileSync(p, "utf8")) as RuntimeJson;
}

export function parseProfiles(args: string[]): Partial<Record<MarketId, Profile>> {
  const out: Partial<Record<MarketId, Profile>> = {};
  for (const a of args) {
    const [asset, prof] = a.split("=");
    const m = asset === "WHSK" || asset === "HSK" ? "hsk-dex:WHSK/USDT:3000" : asset === "WBTC" || asset === "BTC" ? "hsk-dex:WBTC/USDT:3000" : asset;
    if (!isMarketId(m)) throw new AteError("ConfigError", "ATE_CONFIG_INVALID", `--profile: unknown market ${asset}`);
    if (prof !== "demo" && prof !== "default") throw new AteError("ConfigError", "ATE_CONFIG_INVALID", `--profile: ${prof}`);
    if (m === "hsk-dex:WBTC/USDT:3000" && prof === "demo") throw new AteError("ConfigError", "ATE_CONFIG_INVALID", "the WBTC market cannot take the demo profile in v0.1 (§16)");
    out[m] = prof;
  }
  return out;
}

export { resolve };
