import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, type Address } from "viem";
import { parseConfig, policyVaultAbi, type AteConfig } from "@ate/core";
import { createChainClient } from "@ate/chain";
import { Journal, migrate } from "@ate/journal";
import { AgentSigner } from "@ate/wallet";
import { DaemonHttp, Routes, TokenRegistry } from "../src/http.js";
import { AteService } from "../src/service.js";
import { loadStrategy } from "../src/strategy-stub.js";
import { TxQueue } from "../src/txqueue.js";
import { buildConfig, loadDeployment } from "../src/setup/config-gen.js";
import { eip681, setAgentTx, setLimitsTx, validateLimits, type LimitsInput } from "../src/setup/handoff.js";
import { ensureSetupConfig, registerSetupRoutes, type SetupTty } from "../src/setup/routes.js";
import { patchSetup, readSetup } from "../src/setup/state.js";

const DEP = join(__dirname, "../../../deployments/133.json");
const env = { ...process.env, ATE_DEPLOYMENTS: DEP, ATE_KEYSTORE: "file" };
const DEF: LimitsInput = { maxTradeUsdE8: "10000000000", maxEpochUsdE8: "25000000000", maxExposureUsdE8: "15000000000", epochDuration: 86400, maxSlippageBps: 250, maxOracleDeviationBps: 250, maxExitDiscountBps: 500, maxOracleAge: 90000, cooldown: 60 };
const VAULT = "0xF80A74F4D9C17Db8a2a0F32558a9FC3A63e2Bcd2" as Address;
const AGENT = "0xC11CbceE5fDf41aa7175319691aA204eFb164f8a" as Address;

describe("setup config + handoff encoders", () => {
  it("builds a valid chain-133 config from deployments/133.json (strategy off, fallback armed)", () => {
    const d = loadDeployment(133, env)!;
    expect(d).not.toBeNull();
    const c = buildConfig({ chainId: 133, deployment: d.d, agentKeyId: "flow-133-test" });
    expect(c.chain.id).toBe(133);
    expect(c.vaults.map((v) => v.address)).toContain(VAULT);
    expect(c.strategy.enabled).toBe(false);
    expect(c.daemon.approvalFallback).toBe("armed");
    expect(c.supra.pull?.enabled).toBe(true);
  });
  it("setAgent is an EIP-681 URI; setLimits (tuple) falls back to tx JSON with exact calldata", () => {
    const a = setAgentTx(133, VAULT, AGENT, "x");
    expect(a.uri).toBe(`ethereum:${VAULT}@133/setAgent?address=${AGENT}`);
    expect(decodeFunctionData({ abi: policyVaultAbi, data: a.data }).args).toEqual([AGENT]);
    const l = setLimitsTx(133, VAULT, DEF, "y");
    expect(l.format).toBe("tx-json");
    const j = JSON.parse(l.uri) as { chainId: number; to: string; data: string };
    expect(j).toMatchObject({ chainId: 133, to: VAULT });
    const dec = decodeFunctionData({ abi: policyVaultAbi, data: l.data });
    expect(dec.functionName).toBe("setLimits");
    expect((dec.args![0] as { maxEpochUsd: bigint }).maxEpochUsd).toBe(25_000_000_000n);
    expect(eip681(VAULT, 133, "unpause")).toBe(`ethereum:${VAULT}@133/unpause`);
  });
  it("validateLimits mirrors the vault's InvalidLimits bounds", () => {
    expect(validateLimits(DEF)).toBeNull();
    expect(validateLimits({ ...DEF, maxSlippageBps: 1001 })).toMatch(/slippage/);
    expect(validateLimits({ ...DEF, maxExitDiscountBps: 200 })).toMatch(/exit discount/);
    expect(validateLimits({ ...DEF, maxEpochUsdE8: "1" })).toMatch(/daily budget/);
  });
  it("setup state is resumable and only accepts renderer-owned fields", () => {
    const home = mkdtempSync(join(tmpdir(), "flow-setup-"));
    expect(readSetup(home).step).toBe(0);
    patchSetup(home, { step: 3, traderMode: "confirm", chainId: 177 });
    const s = readSetup(home);
    expect(s.step).toBe(3);
    expect(s.traderMode).toBe("confirm");
    expect(s.chainId).toBeNull(); // chain facts are written by the routes, not the renderer
    expect(() => patchSetup(home, { step: 9 })).toThrow();
  });
  it("ensureSetupConfig writes a testnet config on a fresh home only", () => {
    const home = mkdtempSync(join(tmpdir(), "flow-setup-"));
    const p = join(home, "config.json");
    expect(ensureSetupConfig(home, p, env)).toBe(true);
    expect(parseConfig(JSON.parse(readFileSync(p, "utf8"))).chain.id).toBe(133);
    expect(ensureSetupConfig(home, p, env)).toBe(false);
  });
});

describe("/setup/* routes", () => {
  let http: DaemonHttp;
  let base = "";
  let home = "";
  const tokens = new TokenRegistry();
  const T = { ui: tokens.mint({ scope: "ui" }), agent: tokens.mint({ scope: "agent" }) };
  const issued = new Map<string, string>();
  const tty: SetupTty = {
    issue: (_p, nonce) => (issued.set(nonce, "12345678"), "12345678"),
    redeem: (_p, nonce, code) => (issued.get(nonce) === code ? (issued.delete(nonce), { ok: true }) : { ok: false, reason: "wrong_code" }),
    isEnabled: () => true,
    status: () => ({ mode: "armed", enabled: true, approveGreen: false }),
  };
  let cfg: AteConfig;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "flow-routes-"));
    const configPath = join(home, "config.json");
    ensureSetupConfig(home, configPath, env);
    cfg = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
    cfg.chain.rpcUrls = ["http://127.0.0.1:9"];
    writeFileSync(configPath, JSON.stringify(cfg));
    const db = new Database(":memory:");
    migrate(db);
    const journal = new Journal(db);
    const chain = createChainClient({ urls: cfg.chain.rpcUrls, retries: 0, chainId: 133 });
    const signer = new AgentSigner(cfg.agentKeyId);
    const txq = new TxQueue({ chain: { pendingNonce: async () => 0, suggestFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), sendRaw: async () => "0x" as const, receipt: async () => null }, account: () => signer.get(), chainId: 133 });
    let svc!: AteService;
    const strategy = await loadStrategy(() => svc.openProposals(), { forceStub: true });
    svc = new AteService({ cfg, db, journal, chain, signer, txq, strategy, candidateTtlSec: 180, version: "test", emit: () => {} });
    const routes = new Routes();
    http = new DaemonHttp({ service: svc, tokens, routes, version: "test" });
    const { loadEncryptedKey, FileKeyStore } = await import("@ate/wallet");
    registerSetupRoutes({
      routes,
      home,
      env,
      cfg,
      configPath,
      service: svc,
      unlock: async (pass) => {
        const f = loadEncryptedKey(cfg.agentKeyId, [new FileKeyStore(join(home, "keys"))])!;
        return signer.unlock(f.blob, pass);
      },
      broadcast: () => {},
      approval: { tty, verifier: null, hasPinnedKey: false },
    });
    base = `http://127.0.0.1:${await http.listen()}`;
  });
  afterAll(async () => http.close());

  const req = (method: string, path: string, token: string, body?: unknown) =>
    fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "ate://local" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  it("ui scope only: the agent token can never reach setup", async () => {
    expect((await req("GET", "/setup/status", T.agent)).status).toBe(403);
    const r = await req("GET", "/setup/status", T.ui);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: { chainId: number; key: { exists: boolean }; state: { step: number } } };
    expect(j.data.chainId).toBe(133);
    expect(j.data.key.exists).toBe(false);
  });
  it("progress patch persists to setup.json", async () => {
    const r = await req("POST", "/setup/state", T.ui, { step: 2 });
    expect(r.status).toBe(200);
    expect(readSetup(home).step).toBe(2);
    expect((await req("POST", "/setup/state", T.ui, { step: "x" })).status).toBe(400);
  });
  it("keygen imports into the encrypted store and unlocks; a second keygen is refused", async () => {
    const pk = `0x${"11".repeat(32)}`;
    const r = await req("POST", "/setup/keygen", T.ui, { passphrase: "p".repeat(32), privateKey: pk });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: { address: string } };
    expect(j.data.address).toBe("0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A");
    expect(existsSync(join(home, "keys", `${cfg.agentKeyId}.json`))).toBe(true);
    expect(readFileSync(join(home, "keys", `${cfg.agentKeyId}.json`), "utf8")).not.toContain("11".repeat(32));
    expect((await req("POST", "/setup/keygen", T.ui, { passphrase: "p".repeat(32) })).status).toBe(409);
    expect((await req("POST", "/setup/keygen", T.ui, { passphrase: "short" })).status).toBe(400);
  });
  it("handoff builds owner txs for the agent key without touching the chain", async () => {
    const r = await req("POST", "/setup/handoff", T.ui, { kind: "setAgent" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: { txs: { uri: string; to: string }[] } };
    expect(j.data.txs).toHaveLength(2);
    expect(j.data.txs[0]!.uri).toMatch(/^ethereum:0x[0-9a-fA-F]{40}@133\/setAgent\?address=0x19E7/);
    expect((await req("POST", "/setup/handoff", T.ui, { kind: "setLimits", limits: { ...DEF, maxSlippageBps: 5000 } })).status).toBe(400);
  });
  it("settings save is two-step: nonce + one-time code, then config.json is rewritten", async () => {
    const s1 = await req("POST", "/setup/config", T.ui, { changes: [{ key: "daemon.autoLockMinutes", after: 8 * 60 }] });
    expect(s1.status).toBe(200);
    const { data } = (await s1.json()) as { data: { nonce: string; codeIssued: boolean; payload: { kind: string; body: { changes: { before: number; after: number }[] } } } };
    expect(data.codeIssued).toBe(true);
    expect(data.payload.kind).toBe("config");
    expect(data.payload.body.changes[0]).toMatchObject({ before: cfg.daemon.autoLockMinutes, after: 480 });
    expect((await req("POST", "/setup/config", T.ui, { nonce: data.nonce, approval: "00000000" })).status).toBe(401);
  });
  it("a valid code applies the change", async () => {
    const s1 = await req("POST", "/setup/config", T.ui, { changes: [{ key: "daemon.autoLockMinutes", after: 480 }] });
    const { data } = (await s1.json()) as { data: { nonce: string } };
    const s2 = await req("POST", "/setup/config", T.ui, { nonce: data.nonce, approval: "12345678" });
    expect(s2.status).toBe(200);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).daemon.autoLockMinutes).toBe(480);
    expect((await req("POST", "/setup/config", T.ui, { changes: [{ key: "chain.id", after: 177 }] })).status).toBe(400);
  });
});

describe("AI model credentials (SDK, no CLI)", () => {
  it("prefers env, then the stored key; never returns the key itself", async () => {
    const { modelCredentials, storeApiKey, loadStoredApiKey, removeApiKey } = await import("../src/setup/model.js");
    const home = mkdtempSync(join(tmpdir(), "flow-model-"));
    const e = { HOME: home, ATE_KEYSTORE: "file" } as NodeJS.ProcessEnv;
    expect(modelCredentials(home, e).source).toBeNull();
    expect(() => storeApiKey(home, "nope", e)).toThrow();
    const key = `sk-ant-api03-${"a".repeat(40)}wxyz`;
    storeApiKey(home, key, e);
    expect(loadStoredApiKey(home, e)).toBe(key);
    expect(modelCredentials(home, e)).toMatchObject({ source: "keychain", hint: "…wxyz", stored: true });
    expect(modelCredentials(home, { ...e, ANTHROPIC_API_KEY: `sk-ant-x-${"b".repeat(30)}1234` })).toMatchObject({ source: "env", hint: "…1234" });
    removeApiKey(home, e);
    expect(modelCredentials(home, e).source).toBeNull();
  });
});
