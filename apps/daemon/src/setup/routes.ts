// /setup/* — the desktop's no-terminal onboarding and Settings (docs/design/flow 00–06, 90). `ui` scope only (the
// token minted by /ui/attach after Touch ID or a one-time code); the agent/chat scopes can never reach them.
// Routes that rewrite config.json answer `{ restart: true }`: the app restarts the daemon it owns.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { formatUnits, parseAbi, type Address, type PublicClient } from "viem";
import { MARKETS, e8ToUsd, parseConfig, policyVaultAbi, worstCase, type AteConfig, type MarketId } from "@ate/core";
import { probeRpcs } from "@ate/chain";
import { configPayload, validatePayload, type ApprovalVerifier, type ConfigApproval } from "@ate/approve";
import { loadEncryptedKey } from "@ate/wallet";
import type { Routes } from "../http.js";
import type { AteService } from "../service.js";
import { createAgentKey, keyStores } from "../daemon.js";
import { NETWORKS, buildConfig, isChainId, loadDeployment, newAgentKeyId, withVaults, type ChainId, type Deployment } from "./config-gen.js";
import { DOCTOR_GROUPS, runDoctor, verifiedOnExplorer, type DoctorCheck, type DoctorReport } from "./doctor.js";
import {
  HANDOFF_KINDS,
  deployVaultTx,
  depositTx,
  faucetTx,
  isAddr,
  predictCreate,
  runCheck,
  setAgentTx,
  setGuardianTx,
  setLimitsTx,
  unpauseTx,
  validateLimits,
  vaultBytecode,
  type HandoffCheck,
  type HandoffKind,
  type HandoffTx,
  type LimitsInput,
} from "./handoff.js";
import { patchSetup, readSetup, writeSetup } from "./state.js";
import { API_KEY_RE, DEFAULT_MODEL, checkModel, modelCredentials, removeApiKey, storeApiKey } from "./model.js";

export interface SetupTty {
  issue(purpose: "config", bindTo: string, label: string): string | null;
  redeem(purpose: "config", bindTo: string, code: string): { ok: true } | { ok: false; reason: string };
  isEnabled(): boolean;
  status(): { mode: string; enabled: boolean; approveGreen: boolean };
}

export interface SetupRouteDeps {
  routes: Routes;
  home: string;
  env: NodeJS.ProcessEnv;
  cfg: AteConfig;
  configPath: string;
  service: AteService;
  unlock: (passphrase: string) => Promise<string>;
  broadcast: (e: { type: string; at: number; data: unknown }) => void;
  approval?: { tty: SetupTty; verifier: ApprovalVerifier | null; hasPinnedKey: boolean } | null;
  log?: (m: string) => void;
  now?: () => number;
}

const UI = ["ui"] as const;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"]);
const asset = (m: MarketId) => (m.includes("WBTC") ? "BTC" : "HSK");
const PK = /^0x[0-9a-fA-F]{64}$/;
const HTTPS = /^https:\/\/[^\s/$.?#].[^\s]*$/;

class HttpErr extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const bad = (m: string) => new HttpErr(400, m);

export function writeConfigFile(path: string, cfg: AteConfig): void {
  parseConfig(cfg);
  writeFileSync(`${path}.tmp`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 0o600);
}

/** Bootstrap for `start --setup` on a fresh home: a testnet config from deployments/133.json (strategy off). */
export function ensureSetupConfig(home: string, configPath: string, env: NodeJS.ProcessEnv, chainId: ChainId = 133): boolean {
  if (existsSync(configPath)) return false;
  const dep = loadDeployment(chainId, env);
  writeConfigFile(configPath, buildConfig({ chainId, deployment: dep?.d ?? null, agentKeyId: newAgentKeyId(chainId) }));
  const s = readSetup(home);
  writeSetup(home, { ...s, chainId });
  return true;
}

function limitsOf(v: { limits: { maxTradeUsdE8: string; maxEpochUsdE8: string; maxExposureUsdE8: string; epochDuration: number; maxSlippageBps: number; maxOracleDeviationBps: number; maxExitDiscountBps: number; maxOracleAge: number; cooldown: number } }): LimitsInput {
  const l = v.limits;
  return {
    maxTradeUsdE8: l.maxTradeUsdE8,
    maxEpochUsdE8: l.maxEpochUsdE8,
    maxExposureUsdE8: l.maxExposureUsdE8,
    epochDuration: l.epochDuration,
    maxSlippageBps: l.maxSlippageBps,
    maxOracleDeviationBps: l.maxOracleDeviationBps,
    maxExitDiscountBps: l.maxExitDiscountBps,
    maxOracleAge: l.maxOracleAge,
    cooldown: l.cooldown,
  };
}

function parseLimits(x: unknown): LimitsInput {
  const o = (x ?? {}) as Record<string, unknown>;
  const int = (k: string) => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw bad(`limits.${k} must be a non-negative integer`);
    return v;
  };
  const usd = (k: string) => {
    const v = o[k];
    if (typeof v !== "string" || !/^[0-9]{1,30}$/.test(v)) throw bad(`limits.${k} must be a decimal string (USD × 1e8)`);
    return v;
  };
  const l: LimitsInput = {
    maxTradeUsdE8: usd("maxTradeUsdE8"),
    maxEpochUsdE8: usd("maxEpochUsdE8"),
    maxExposureUsdE8: usd("maxExposureUsdE8"),
    epochDuration: int("epochDuration"),
    maxSlippageBps: int("maxSlippageBps"),
    maxOracleDeviationBps: int("maxOracleDeviationBps"),
    maxExitDiscountBps: int("maxExitDiscountBps"),
    maxOracleAge: int("maxOracleAge"),
    cooldown: int("cooldown"),
  };
  const e = validateLimits(l);
  if (e) throw bad(e);
  return l;
}

interface PendingConfig {
  nonce: string;
  expiresAt: number;
  payload: ConfigApproval;
  next: AteConfig;
}

export function registerSetupRoutes(d: SetupRouteDeps): void {
  const { routes, home, env, cfg, service } = d;
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const client = service.o.chain.client as unknown as PublicClient;
  const chainId = cfg.chain.id as ChainId;
  const dep = () => loadDeployment(chainId, env);
  const handoffChecks = new Map<string, { checks: HandoffCheck[]; createdAt: number }>();
  const pendingConfig = new Map<string, PendingConfig>();
  let lastDoctor: DoctorReport | null = null;
  let doctorRun: Promise<DoctorReport> | null = null;

  const reg = (method: "GET" | "POST", path: string, fn: (body: unknown, query: URLSearchParams) => Promise<unknown> | unknown) =>
    routes.register({
      method,
      path,
      scopes: [...UI],
      handler: async ({ req, body, json }) => {
        try {
          json(200, { ok: true, data: await fn(body, new URL(req.url ?? "/", "http://127.0.0.1").searchParams) });
        } catch (e) {
          const status = e instanceof HttpErr ? e.status : 500;
          if (status === 500) d.log?.(`setup ${path}: ${(e as Error).message}`);
          json(status, { ok: false, error: { code: status === 400 ? "ATE_CONFIG_INVALID" : status === 401 ? "ATE_APPROVAL_REQUIRED" : "ATE_INTERNAL", message: (e as Error).message.split("\n")[0] } });
        }
      },
    });

  const keyInfo = () => {
    const found = loadEncryptedKey(cfg.agentKeyId, keyStores(home, env));
    return { keyId: cfg.agentKeyId, exists: !!found, address: found?.blob.address ?? null, store: found?.store.kind ?? keyStores(home, env)[0]!.kind, unlocked: !service.locked };
  };
  const vaultList = () => cfg.vaults.map((v) => ({ market: v.market, address: v.address as Address }));

  // ------------------------------------------------------------------ status / progress

  reg("GET", "/setup/status", () => ({
    state: readSetup(home),
    chainId,
    network: NETWORKS[chainId].label,
    explorer: cfg.chain.explorer,
    rpcUrls: cfg.chain.rpcUrls,
    vaults: vaultList(),
    guardian: cfg.guardian,
    key: keyInfo(),
    approval: { touchId: !!d.approval?.hasPinnedKey, fallback: d.approval?.tty.status() ?? null },
    strategy: { enabled: service.strategy.enabled, mode: service.strategy.mode },
  }));
  reg("POST", "/setup/state", (b) => {
    try {
      return patchSetup(home, (b ?? {}) as Record<string, unknown>);
    } catch (e) {
      throw bad((e as Error).message);
    }
  });

  // ------------------------------------------------------------------ 01 network

  reg("GET", "/setup/networks", async () =>
    Promise.all(
      ([133, 177] as const).map(async (id) => {
        const urls = id === chainId ? cfg.chain.rpcUrls : (loadDeployment(id, env)?.d.rpcUrls ?? [...NETWORKS[id].rpcUrls]);
        const [p] = await probeRpcs(urls.slice(0, 1));
        const dd = loadDeployment(id, env)?.d;
        return {
          chainId: id,
          label: NETWORKS[id].label,
          rpc: urls[0],
          ms: p?.ms ?? null,
          block: p?.head?.toString() ?? null,
          ok: p?.chainId === id,
          error: p?.error ?? null,
          explorer: dd?.explorer ?? NETWORKS[id].explorer,
          supraStorage: dd?.supra.storage ?? (id === chainId ? cfg.supra.storage : null),
          deployment: dd ? { vaults: Object.keys(dd.markets).length, owner: dd.owner ?? null } : null,
          current: id === chainId,
        };
      }),
    ),
  );
  reg("POST", "/setup/network", (b) => {
    const { chainId: want, rpcUrls } = (b ?? {}) as { chainId?: unknown; rpcUrls?: unknown };
    if (!isChainId(want)) throw bad("chainId must be 133 or 177");
    if (rpcUrls !== undefined && (!Array.isArray(rpcUrls) || !rpcUrls.length || !rpcUrls.every((u) => typeof u === "string" && HTTPS.test(u)))) throw bad("rpcUrls must be https URLs");
    const s = readSetup(home);
    if (want === chainId && !rpcUrls) {
      writeSetup(home, { ...s, chainId: want, step: Math.max(s.step, 2) });
      return { restart: false, chainId: want };
    }
    if (want !== chainId) {
      // Each network keeps its own config (vaults, agent key id) and setup progress; switch them in place.
      renameSync(d.configPath, join(home, `config.${chainId}.json`));
      writeFileSync(join(home, `setup.${chainId}.json`), JSON.stringify(s, null, 2), { mode: 0o600 });
      const stashedCfg = join(home, `config.${want}.json`);
      const stashedSetup = join(home, `setup.${want}.json`);
      const next = existsSync(stashedCfg) ? (JSON.parse(readFileSync(stashedCfg, "utf8")) as AteConfig) : buildConfig({ chainId: want, deployment: loadDeployment(want, env)?.d ?? null, agentKeyId: newAgentKeyId(want) });
      if (rpcUrls) next.chain.rpcUrls = rpcUrls as string[];
      writeConfigFile(d.configPath, next);
      const ns = existsSync(stashedSetup) ? (JSON.parse(readFileSync(stashedSetup, "utf8")) as typeof s) : { ...readSetup(join(home, "__none__")), chainId: want };
      writeSetup(home, { ...ns, step: Math.max(ns.step, 2) });
      return { restart: true, chainId: want };
    }
    writeConfigFile(d.configPath, { ...cfg, chain: { ...cfg.chain, rpcUrls: rpcUrls as string[] } });
    writeSetup(home, { ...s, step: Math.max(s.step, 2) });
    return { restart: true, chainId: want };
  });

  // ------------------------------------------------------------------ 02 vaults

  const readVault = async (address: Address) => {
    const r = <T>(functionName: string) => client.readContract({ address, abi: policyVaultAbi, functionName: functionName as never }) as Promise<T>;
    const [owner, agent, guardian, paused, pool, oracle, limits] = await Promise.all([r<Address>("owner"), r<Address>("agent"), r<Address>("guardian"), r<boolean>("paused"), r<Address>("pool"), r<Address>("oracle"), r<Record<string, bigint | number>>("limits")]);
    return { owner, agent, guardian, paused, pool, oracle, limits };
  };

  reg("GET", "/setup/vaults", async (_b, q) => {
    const depl = dep();
    const source = q.get("source") === "config" || !depl ? "config" : "deployment";
    const list: { market: MarketId; address: Address }[] =
      source === "deployment" ? Object.entries(depl!.d.markets).map(([m, x]) => ({ market: m as MarketId, address: x.vault as Address })) : vaultList();
    const vaults = await Promise.all(
      list.map(async (v) => {
        const [onchain, verified] = await Promise.all([readVault(v.address).catch((e: Error) => ({ error: e.message.split("\n")[0] }) as const), verifiedOnExplorer(cfg.chain.explorer, v.address)]);
        const want = depl?.d.markets[v.market];
        if ("error" in onchain) return { ...v, error: onchain.error, verified };
        const l = onchain.limits;
        return {
          ...v,
          verified,
          owner: onchain.owner,
          agent: onchain.agent,
          guardian: onchain.guardian,
          paused: onchain.paused,
          pool: onchain.pool,
          poolPinned: want ? want.pool.toLowerCase() === onchain.pool.toLowerCase() : true,
          oracle: onchain.oracle,
          supraPair: cfg.supra.pairs?.[v.market] ?? want?.supraPair ?? null,
          feeBps: 30,
          limits: {
            maxTradeUsdE8: String(l.maxTradeUsd),
            maxEpochUsdE8: String(l.maxEpochUsd),
            maxExposureUsdE8: String(l.maxExposureUsd),
            epochDuration: Number(l.epochDuration),
            maxSlippageBps: Number(l.maxSlippageBps),
            maxOracleDeviationBps: Number(l.maxOracleDeviationBps),
            maxExitDiscountBps: Number(l.maxExitDiscountBps),
            maxOracleAge: Number(l.maxOracleAge),
            cooldown: Number(l.cooldown),
          },
        };
      }),
    );
    const owners = [...new Set(vaults.map((v) => ("owner" in v ? v.owner?.toLowerCase() : undefined)).filter(Boolean))];
    const owner = owners.length === 1 ? (vaults.find((v) => "owner" in v) as { owner: Address }).owner : null;
    const ownerCode = owner ? await client.getCode({ address: owner }).catch(() => undefined) : undefined;
    return {
      source,
      deploymentPath: depl?.path ?? null,
      chainId,
      found: list.length,
      vaults,
      owner,
      ownerMatches: owners.length === 1 && (!depl?.d.owner || owners[0] === depl.d.owner.toLowerCase()),
      ownerIsContract: !!ownerCode && ownerCode !== "0x",
      readAtBlock: (await client.getBlockNumber().catch(() => 0n)).toString(),
    };
  });
  reg("POST", "/setup/vaults", async (b) => {
    const { source, vaults } = (b ?? {}) as { source?: string; vaults?: { market: string; address: string }[] };
    let list: { market: MarketId; address: `0x${string}` }[];
    if (source === "deployment") {
      const depl = dep();
      if (!depl) throw bad(`no deployments/${chainId}.json found`);
      list = Object.entries(depl.d.markets).map(([m, x]) => ({ market: m as MarketId, address: x.vault as `0x${string}` }));
    } else if (source === "custom" || source === "deploy") {
      if (!Array.isArray(vaults) || !vaults.length || vaults.length > 2) throw bad("vaults: 1–2 entries");
      list = vaults.map((v) => {
        if (!(v.market in MARKETS) || !isAddr(v.address)) throw bad("bad vault entry");
        return { market: v.market as MarketId, address: v.address };
      });
    } else throw bad("source must be deployment, custom or deploy");
    // Every vault must answer owner(): it is a PolicyVault on this chain.
    for (const v of list) await readVault(v.address).catch(() => {
      throw bad(`${v.address} is not a PolicyVault on chain ${chainId}`);
    });
    const same = list.length === cfg.vaults.length && list.every((v) => cfg.vaults.some((c) => c.market === v.market && c.address.toLowerCase() === v.address.toLowerCase()));
    if (!same) writeConfigFile(d.configPath, withVaults(cfg, list));
    const s = readSetup(home);
    writeSetup(home, { ...s, vaultSource: source as "deployment", vaultsConfirmedAt: now(), step: Math.max(s.step, 3) });
    return { restart: !same, vaults: list };
  });

  // ------------------------------------------------------------------ 03 agent key

  reg("GET", "/setup/agent", async () => {
    const k = keyInfo();
    const c = await service.refresh(5).catch(() => null);
    const gasWei = k.address ? await client.getBalance({ address: k.address as Address }).catch(() => null) : null;
    return {
      ...k,
      guardian: cfg.guardian,
      gasHsk: gasWei === null ? null : formatUnits(gasWei, 18),
      needsHsk: chainId === 133 ? "1" : cfg.daemon.gasAlarmHsk,
      faucet: NETWORKS[chainId].faucet,
      vaults: cfg.vaults.map((v) => {
        const st = c?.markets[v.market]?.vault;
        return { market: v.market, address: v.address, agent: st?.agent ?? null, matches: !!k.address && st?.agent?.toLowerCase() === k.address.toLowerCase() };
      }),
    };
  });
  reg("POST", "/setup/keygen", async (b) => {
    const { passphrase, privateKey } = (b ?? {}) as { passphrase?: unknown; privateKey?: unknown };
    if (typeof passphrase !== "string" || passphrase.length < 16) throw bad("passphrase must be ≥ 16 characters (the app generates it and seals it in the keychain)");
    if (privateKey !== undefined && (typeof privateKey !== "string" || !PK.test(privateKey))) throw bad("privateKey must be 0x + 64 hex");
    if (keyInfo().exists) throw new HttpErr(409, `agent key ${cfg.agentKeyId} already exists`);
    const r = createAgentKey(home, cfg.agentKeyId, passphrase, { ...env, ATE_IMPORT_PRIVATE_KEY: (privateKey as string | undefined) ?? "" });
    const address = await d.unlock(passphrase);
    const s = readSetup(home);
    writeSetup(home, { ...s, agent: { address, createdAt: now(), imported: !!privateKey } });
    d.log?.(`setup: agent key ${cfg.agentKeyId} ${privateKey ? "imported" : "created"} in ${r.store}: ${r.address}`);
    return { address, store: r.store, keyId: cfg.agentKeyId };
  });

  // ------------------------------------------------------------------ 04 health

  reg("GET", "/setup/doctor", async (_b, q) => {
    if (q.get("cached") === "1" && lastDoctor) return { groups: DOCTOR_GROUPS, report: lastDoctor };
    doctorRun ??= runDoctor({ cfg, home, model: readSetup(home).model ?? DEFAULT_MODEL, service, client, env, onCheck: (c: DoctorCheck) => d.broadcast({ type: "setup.check", at: now(), data: c }) }).finally(() => (doctorRun = null));
    lastDoctor = await doctorRun;
    if (lastDoctor.fail === 0) {
      const s = readSetup(home);
      writeSetup(home, { ...s, healthPassedAt: now() });
    }
    return { groups: DOCTOR_GROUPS, report: lastDoctor };
  });

  // ------------------------------------------------------------------ AI model (step 04 + Settings): SDK, no CLI

  const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
  const pendingKey = new Map<string, { expiresAt: number; action: "set" | "remove"; key: string | null; payload: ConfigApproval }>();
  reg("GET", "/setup/model", () => ({ ...modelCredentials(home, env), model: readSetup(home).model ?? DEFAULT_MODEL, models: MODELS }));
  reg("GET", "/setup/model/check", async () => checkModel(home, env, readSetup(home).model ?? DEFAULT_MODEL));
  reg("POST", "/setup/model", (b) => {
    const m = (b as { model?: string } | undefined)?.model;
    if (!m || !MODELS.includes(m)) throw bad(`model must be one of ${MODELS.join(", ")}`);
    const s = readSetup(home);
    return writeSetup(home, { ...s, model: m }).model;
  });
  /**
   * Set / replace / remove the stored API key. The first key during setup needs only the attached ui token; any
   * later change is two-step like a Settings save (Touch ID signature over a `config` payload, or a one-time code).
   */
  reg("POST", "/setup/model/key", (b) => {
    const o = (b ?? {}) as { action?: string; apiKey?: string; nonce?: string; approval?: string };
    const apply = (action: "set" | "remove", key: string | null) => {
      if (action === "remove") removeApiKey(home, env);
      else storeApiKey(home, key!, env);
      d.log?.(`setup: Anthropic API key ${action === "remove" ? "removed" : "stored"}`);
      return { saved: true, ...modelCredentials(home, env) };
    };
    if (o.nonce) {
      const p = pendingKey.get(o.nonce);
      if (!p || p.expiresAt < now()) throw new HttpErr(401, "unknown or expired nonce");
      const a = String(o.approval ?? "");
      const ok = /^[0-9]{8}$/.test(a) ? d.approval?.tty.redeem("config", o.nonce, a).ok : d.approval?.verifier?.verify(p.payload, a).ok;
      if (!ok) throw new HttpErr(401, "approval rejected");
      pendingKey.delete(o.nonce);
      return apply(p.action, p.key);
    }
    const action = o.action === "remove" ? "remove" : o.action === "set" ? "set" : null;
    if (!action) throw bad("action must be set or remove");
    if (action === "set" && (typeof o.apiKey !== "string" || !API_KEY_RE.test(o.apiKey.trim()))) throw bad("that does not look like an Anthropic API key (sk-ant-…)");
    const key = action === "set" ? o.apiKey!.trim() : null;
    const creds = modelCredentials(home, env);
    if (action === "set" && !creds.stored && !readSetup(home).completedAt) return apply("set", key);
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = now() + 60;
    const payload = configPayload({ nonce, expiresAt, changes: [{ key: "anthropic.apiKey", before: creds.stored ? `stored ${creds.hint ?? ""}`.trim() : "none", after: action === "remove" ? "none" : `…${key!.slice(-4)}` }] });
    pendingKey.set(nonce, { expiresAt, action, key, payload });
    const code = d.approval?.tty.issue("config", nonce, `Anthropic API key ${action}`);
    return { nonce, expiresAt, payload, codeIssued: !!code };
  });

  // ------------------------------------------------------------------ 05 limits

  reg("GET", "/setup/limits", async () => {
    const c = await service.refresh(5);
    const vaults = cfg.vaults.map((v) => {
      const st = c.markets[v.market]?.vault;
      return { market: v.market, address: v.address, limits: st ? limitsOf(st) : null };
    });
    const have = vaults.filter((v) => v.limits).map((v) => v.limits!);
    const wc = worstCase(have);
    const same = have.length > 1 && have.every((l) => JSON.stringify(l) === JSON.stringify(have[0]));
    return {
      vaults,
      same,
      worstCase: {
        maxLossUsd: e8ToUsd(wc.maxLossUsdE8),
        normalLossUsd: e8ToUsd(wc.normalLossUsdE8),
        rolling24hUsd: e8ToUsd(wc.rolling24hUsdE8),
        perVault: wc.vaults.map((x) => ({ totalBps: x.totalBps, oracleBps: x.oracleBps, exitBps: x.exitBps, slippageBps: x.slippageBps, feeBps: x.feeBps, maxLossUsd: e8ToUsd(x.maxLossUsdE8) })),
      },
    };
  });

  // ------------------------------------------------------------------ 06 fund

  reg("GET", "/setup/fund", async () => {
    const c = await service.refresh(5);
    const depl = dep()?.d;
    const sym = (addr: string, fallback: string) => Object.values(depl?.tokens ?? {}).find((t) => t.address.toLowerCase() === addr.toLowerCase())?.symbol ?? fallback;
    let total = 0;
    const vaults = cfg.vaults.map((v) => {
      const r = c.markets[v.market];
      const s = MARKETS[v.market] as unknown as { quoteToken: Address; baseToken: Address; baseDecimals: number; base: string };
      const st = r?.vault;
      const px = r ? Number(r.price.oracle.price) / 1e8 : 0;
      const q = st ? Number(st.balanceQuote) / 1e6 : 0;
      const p = st ? Number(st.balancePrice) / 10 ** s.baseDecimals : 0;
      total += q + p * px;
      return {
        market: v.market,
        address: v.address,
        paused: st?.paused ?? false,
        usd: (q + p * px).toFixed(2),
        tokens: [
          { symbol: sym(s.quoteToken, "USDT"), address: s.quoteToken, decimals: 6, amount: q.toFixed(2), usd: q.toFixed(2) },
          { symbol: sym(s.baseToken, s.base), address: s.baseToken, decimals: s.baseDecimals, amount: p.toFixed(s.baseDecimals === 8 ? 6 : 2), usd: (p * px).toFixed(2) },
        ],
      };
    });
    const agent = keyInfo().address as Address | null;
    const gasWei = agent ? await client.getBalance({ address: agent }).catch(() => null) : null;
    const lim = cfg.vaults.map((v) => c.markets[v.market]?.vault).filter(Boolean).map((st) => limitsOf(st!));
    const wc = worstCase(lim);
    return {
      chainId,
      vaults,
      totalUsd: total.toFixed(2),
      worstDayUsd: e8ToUsd(wc.maxLossUsdE8),
      exposureCapUsd: lim[0] ? e8ToUsd(BigInt(lim[0].maxExposureUsdE8)) : null,
      agent: agent ? { address: agent, hsk: gasWei === null ? null : formatUnits(gasWei, 18) } : null,
      faucets:
        chainId === 133 && depl?.tokens
          ? Object.values(depl.tokens).map((t) => ({ symbol: t.symbol, address: t.address, amount: t.faucetAmount ? formatUnits(BigInt(t.faucetAmount), t.decimals) : null }))
          : [],
      hskFaucet: NETWORKS[chainId].faucet,
      explorer: cfg.chain.explorer,
    };
  });
  reg("POST", "/setup/complete", (b) => {
    const mode = (b as { mode?: string } | undefined)?.mode;
    if (mode !== "autonomous" && mode !== "confirm" && mode !== "watch") throw bad("mode must be autonomous, confirm or watch");
    const next = structuredClone(cfg);
    next.strategy.enabled = mode !== "watch";
    next.strategy.mode = mode === "confirm" ? "confirm" : "autonomous";
    const changed = next.strategy.enabled !== cfg.strategy.enabled || next.strategy.mode !== cfg.strategy.mode;
    if (changed) writeConfigFile(d.configPath, next);
    const s = readSetup(home);
    writeSetup(home, { ...s, traderMode: mode, completedAt: now(), step: 7 });
    return { restart: changed, mode };
  });

  // ------------------------------------------------------------------ owner-device handoff (QR) + landing poll

  reg("POST", "/setup/handoff", async (b) => {
    const o = (b ?? {}) as { kind?: string; market?: string; agent?: string; guardian?: string; limits?: unknown; token?: string; amount?: string; owner?: string };
    const kind = o.kind as HandoffKind;
    if (!HANDOFF_KINDS.includes(kind)) throw bad(`kind must be one of ${HANDOFF_KINDS.join(", ")}`);
    const targets = o.market ? cfg.vaults.filter((v) => v.market === o.market) : cfg.vaults;
    if (o.market && !targets.length) throw bad(`no vault for ${o.market}`);
    const txs: HandoffTx[] = [];
    const checks: HandoffCheck[] = [];
    if (kind === "setAgent") {
      const agent = (o.agent ?? keyInfo().address) as string | null;
      if (!isAddr(agent)) throw bad("no agent key yet (step 3) or bad agent address");
      for (const v of targets) {
        txs.push(setAgentTx(chainId, v.address as Address, agent, `setAgent on Vault-${asset(v.market)}`));
        checks.push({ kind: "agent", vault: v.address as Address, want: agent });
      }
    } else if (kind === "setGuardian") {
      const g = o.guardian ?? cfg.guardian;
      if (!isAddr(g)) throw bad("bad guardian address");
      for (const v of targets) {
        txs.push(setGuardianTx(chainId, v.address as Address, g, `setGuardian on Vault-${asset(v.market)}`));
        checks.push({ kind: "guardian", vault: v.address as Address, want: g });
      }
    } else if (kind === "setLimits") {
      const l = parseLimits(o.limits);
      for (const v of targets) {
        txs.push(setLimitsTx(chainId, v.address as Address, l, `setLimits on Vault-${asset(v.market)}`));
        checks.push({ kind: "limits", vault: v.address as Address, want: l });
      }
    } else if (kind === "unpause") {
      for (const v of targets) {
        txs.push(unpauseTx(chainId, v.address as Address, `unpause Vault-${asset(v.market)}`));
        checks.push({ kind: "unpaused", vault: v.address as Address });
      }
    } else if (kind === "faucet") {
      if (chainId !== 133) throw bad("test-token faucets exist on testnet only");
      if (!isAddr(o.token)) throw bad("token required");
      const t = Object.values(dep()?.d.tokens ?? {}).find((x) => x.address.toLowerCase() === o.token!.toLowerCase());
      if (!t) throw bad("not a test token of this deployment");
      txs.push(faucetTx(chainId, o.token, `faucet() on ${t.symbol}`));
      checks.push({ kind: "minted", token: o.token, fromBlock: (await client.getBlockNumber()).toString() });
    } else if (kind === "deposit") {
      if (!isAddr(o.token) || typeof o.amount !== "string" || !/^[0-9]{1,40}$/.test(o.amount) || targets.length !== 1) throw bad("deposit needs market, token and amount (base units)");
      const v = targets[0]!;
      const s = MARKETS[v.market] as unknown as { quoteToken: Address; baseToken: Address };
      if (![s.quoteToken, s.baseToken].some((a) => a.toLowerCase() === o.token!.toLowerCase())) throw bad("token is not one of this vault's tokens");
      const before = (await client.readContract({ address: o.token, abi: erc20, functionName: "balanceOf", args: [v.address as Address] })) as bigint;
      txs.push(depositTx(chainId, o.token, v.address as Address, BigInt(o.amount), `deposit into Vault-${asset(v.market)}`));
      checks.push({ kind: "balance", token: o.token, holder: v.address as Address, atLeast: (before + BigInt(o.amount)).toString() });
    } else if (kind === "deploy") {
      if (!isAddr(o.owner)) throw bad("owner address required (the wallet that will deploy and own the vaults)");
      const code = vaultBytecode(env);
      if (!code) throw bad("PolicyVault artifact not found (contracts/out); deploy-new needs a built contracts tree");
      const depl = dep()?.d;
      const nonce = BigInt(await client.getTransactionCount({ address: o.owner }));
      const mk = (depl ? Object.keys(depl.markets) : cfg.vaults.map((v) => v.market)) as MarketId[];
      const agent = keyInfo().address;
      mk.forEach((m, i) => {
        const vm = cfg.venues.hskdex.markets.find((x) => x.id === m)!;
        txs.push(deployVaultTx(chainId, code, { quoteToken: (vm.quoteToken ?? MARKETS[m].quoteToken) as Address, priceToken: (vm.baseToken ?? MARKETS[m].baseToken) as Address, oracle: vm.oracle as Address, router: cfg.venues.hskdex.router as Address, pool: vm.pool as Address, factory: cfg.venues.hskdex.factory as Address }, `deploy Vault-${asset(m)}`));
        checks.push({ kind: "code", address: predictCreate(o.owner as Address, nonce + BigInt(i)) });
      });
      const l = depl ? parseLimits({ maxTradeUsdE8: String(depl.limits.maxTradeUsd), maxEpochUsdE8: String(depl.limits.maxEpochUsd), maxExposureUsdE8: String(depl.limits.maxExposureUsd), epochDuration: depl.limits.epochDuration, maxSlippageBps: depl.limits.maxSlippageBps, maxOracleDeviationBps: depl.limits.maxOracleDeviationBps, maxExitDiscountBps: depl.limits.maxExitDiscountBps, maxOracleAge: depl.limits.maxOracleAge, cooldown: depl.limits.cooldown }) : null;
      mk.forEach((m, i) => {
        const at = predictCreate(o.owner as Address, nonce + BigInt(i));
        if (l) txs.push(setLimitsTx(chainId, at, l, `setLimits on new Vault-${asset(m)}`));
        if (isAddr(cfg.guardian)) txs.push(setGuardianTx(chainId, at, cfg.guardian, `setGuardian on new Vault-${asset(m)}`));
        if (agent) txs.push(setAgentTx(chainId, at, agent as Address, `setAgent on new Vault-${asset(m)}`));
      });
    }
    const id = `ho_${randomBytes(8).toString("hex")}`;
    handoffChecks.set(id, { checks, createdAt: now() });
    const s = readSetup(home);
    s.handoffs[id] = { id, kind, ...(o.market ? { market: o.market } : {}), createdAt: now(), txs: txs.map((t) => ({ label: t.label, to: t.to, data: t.data.length > 2000 ? `${t.data.slice(0, 66)}…` : t.data, value: t.value })) };
    writeSetup(home, s);
    return { id, kind, chainId, txs, checks, predicted: kind === "deploy" ? checks.map((c) => (c as { address: string }).address) : undefined };
  });
  reg("GET", "/setup/handoff", async (_b, q) => {
    const id = q.get("id") ?? "";
    const h = handoffChecks.get(id);
    if (!h) throw new HttpErr(404, "unknown handoff id");
    const results = await Promise.all(h.checks.map((c) => runCheck(client, c).catch((e: Error) => ({ done: false, detail: e.message.split("\n")[0] }))));
    const done = results.every((r) => r.done);
    if (done) {
      const s = readSetup(home);
      if (s.handoffs[id] && !s.handoffs[id]!.doneAt) {
        s.handoffs[id]!.doneAt = now();
        writeSetup(home, s);
      }
    }
    return { id, done, results };
  });

  // ------------------------------------------------------------------ 90 settings (read; write = two-step approval)

  reg("GET", "/setup/config", async () => {
    const probes = await probeRpcs(cfg.chain.rpcUrls);
    const c = await service.refresh(30).catch(() => null);
    return {
      chainId,
      network: NETWORKS[chainId].label,
      rpcs: probes.map((p, i) => ({ url: p.url, role: i === 0 ? "primary" : "fallback", ms: p.head !== null ? p.ms : null, ok: p.chainId === chainId, error: p.error ?? null })),
      oracleRefreshSec: cfg.supra.pull?.refreshAgeSec ?? null,
      oracleMaxAgeSec: cfg.supra.maxAgeSec,
      supra: cfg.vaults.map((v) => ({ market: v.market, ageSec: c?.markets[v.market]?.price.oracle.ageSec ?? null })),
      autoLockMinutes: cfg.daemon.autoLockMinutes,
      approval: { touchId: !!d.approval?.hasPinnedKey, keyId: d.approval?.verifier?.keyId ?? null, fallback: d.approval?.tty.status() ?? null, windowSec: 60 },
      agent: keyInfo(),
      model: cfg.chat.runner,
      journal: { records: service.journal.head().seq },
    };
  });

  const CONFIG_KEYS = ["chain.rpcUrls", "supra.pull.refreshAgeSec", "daemon.autoLockMinutes"] as const;
  reg("POST", "/setup/config", (b) => {
    const o = (b ?? {}) as { changes?: { key: string; after: unknown }[]; nonce?: string; approval?: string; confirm?: boolean };
    if (o.nonce) {
      const p = pendingConfig.get(o.nonce);
      if (!p || p.expiresAt < now()) throw new HttpErr(401, "unknown or expired nonce");
      const a = String(o.approval ?? "");
      let method: string;
      if (/^[0-9]{8}$/.test(a)) {
        const r = d.approval?.tty.redeem("config", p.nonce, a);
        if (!r?.ok) throw new HttpErr(401, `one-time code rejected (${r && !r.ok ? r.reason : "no fallback"})`);
        method = "tty";
      } else {
        const v = d.approval?.verifier?.verify(p.payload, a);
        if (!v?.ok) throw new HttpErr(401, `approval signature rejected${v && !v.ok ? ` (${v.reason})` : " (no approval key pinned)"}`);
        method = "ate-approve";
      }
      pendingConfig.delete(p.nonce);
      writeConfigFile(d.configPath, p.next);
      d.log?.(`setup: config saved (${method}): ${p.payload.body.changes.map((c) => c.key).join(", ")}`);
      return { saved: true, restart: true, method };
    }
    if (!Array.isArray(o.changes) || !o.changes.length) throw bad("changes required");
    const next = structuredClone(cfg);
    const changes: { key: string; before: unknown; after: unknown }[] = [];
    for (const c of o.changes) {
      if (!(CONFIG_KEYS as readonly string[]).includes(c.key)) throw bad(`${c.key} cannot be changed here`);
      if (c.key === "chain.rpcUrls") {
        const u = c.after;
        if (!Array.isArray(u) || !u.length || u.length > 5 || !u.every((x) => typeof x === "string" && HTTPS.test(x))) throw bad("rpcUrls: 1–5 https URLs");
        changes.push({ key: c.key, before: cfg.chain.rpcUrls, after: u });
        next.chain.rpcUrls = u as string[];
      } else if (c.key === "supra.pull.refreshAgeSec") {
        if (!cfg.supra.pull) throw bad("pull refresh is not configured");
        const v = Number(c.after);
        if (!Number.isInteger(v) || v < 600 || v >= cfg.supra.maxAgeSec) throw bad(`refresh threshold must be 10 min … < ${cfg.supra.maxAgeSec / 3600} h`);
        changes.push({ key: c.key, before: cfg.supra.pull.refreshAgeSec, after: v });
        next.supra.pull = { ...cfg.supra.pull, refreshAgeSec: v };
      } else {
        const v = Number(c.after);
        if (!Number.isInteger(v) || v < 1 || v > 24 * 60) throw bad("auto-lock: 1 … 1440 minutes");
        changes.push({ key: c.key, before: cfg.daemon.autoLockMinutes, after: v });
        next.daemon.autoLockMinutes = v;
      }
    }
    parseConfig(next);
    // Touch ID policy (v1): plain settings (RPCs, price refresh, auto-lock) save at once with the ui token; Touch ID is
    // kept for risk-raising strategy/limit changes, payments and replacing/removing stored credentials.
    if (o.confirm !== true) {
      writeConfigFile(d.configPath, next);
      d.log?.(`setup: config saved: ${changes.map((c) => c.key).join(", ")}`);
      return { saved: true, restart: true, method: "ui", changes };
    }
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = now() + 60;
    const payload = configPayload({ nonce, expiresAt, changes });
    validatePayload(structuredClone(payload));
    pendingConfig.set(nonce, { nonce, expiresAt, payload, next });
    const code = d.approval?.tty.issue("config", nonce, `Settings save: ${changes.map((c) => c.key).join(", ")}`);
    return { nonce, expiresAt, payload, codeIssued: !!code };
  });
}

export type { Deployment };
