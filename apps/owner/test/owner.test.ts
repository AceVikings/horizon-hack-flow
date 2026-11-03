import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePayload, payloadBytes } from "@ate/approve";
import type { Address, Hex } from "viem";
import { Approver, DEFAULT_LIMITS, OwnerService, diffLimits, type Deployment, type VaultState } from "../src/index.js";

const OWNER = "0x00000000000000000000000000000000000000aa" as Address;
const V1 = "0x00000000000000000000000000000000000000b1" as Address;
const AGENT = "0x00000000000000000000000000000000000000c1" as Address;

function fakeChain() {
  const vault: VaultState = { market: "hsk-dex:WHSK/USDT:3000", address: V1, owner: OWNER, agent: AGENT, guardian: AGENT, paused: true, limits: { ...DEFAULT_LIMITS } };
  const calls: string[] = [];
  return {
    calls,
    vault,
    chain: {
      address: OWNER,
      dep: { chainId: 133, guardian: AGENT, explorer: "", rpcUrls: [], markets: { "hsk-dex:WHSK/USDT:3000": { vault: V1, pool: V1, adapter: V1, priceToken: V1, quoteToken: V1, supraPair: 517 } }, hskdex: { factory: V1, router: V1 }, supra: { storage: V1 } } as Deployment,
      vault: async () => structuredClone(vault),
      balance: async () => 10n ** 18n,
      call: async (label: string, _v: Address, fn: string) => (calls.push(fn), { label, hash: "0x01" as Hex }),
      send: async (label: string) => (calls.push("send"), { label, hash: "0x02" as Hex }),
      deploy: async () => (calls.push("deploy"), { vaults: [{ market: "hsk-dex:WHSK/USDT:3000", vault: V1, adapter: V1 }], txs: [] }),
      seed: async () => (calls.push("seed"), []),
    },
  };
}

function setup(o: { exportKey?: () => Hex } = {}) {
  const home = mkdtempSync(join(tmpdir(), "flow-owner-"));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const pub = `04${Buffer.from(jwk.x, "base64url").toString("hex")}${Buffer.from(jwk.y, "base64url").toString("hex")}`;
  writeFileSync(join(home, "pin.json"), JSON.stringify({ publicKey: pub }));
  const f = fakeChain();
  const svc = new OwnerService({ chain: f.chain as never, approver: new Approver({ passkeysPath: join(home, "passkeys.json"), pinnedKeyPath: join(home, "pin.json") }), home, ...o });
  const touchId = (payloadB64: string) => {
    const s = createSign("sha256");
    s.update(payloadBytes(decodePayload(payloadB64)));
    return s.sign({ key: privateKey, dsaEncoding: "der" }).toString("base64");
  };
  return { svc, f, touchId, home };
}

describe("risk direction", () => {
  it("classifies each limit field", () => {
    const up = diffLimits(DEFAULT_LIMITS, { ...DEFAULT_LIMITS, maxTradeUsd: DEFAULT_LIMITS.maxTradeUsd + 1n, cooldown: 30, maxSlippageBps: 100 });
    expect(Object.fromEntries(up.map((c) => [c.field, c.raisesRisk]))).toEqual({ maxTradeUsd: true, cooldown: true, maxSlippageBps: false });
  });
});

describe("owner service", () => {
  it("tightening and pause run at once; loosening and unpause wait for an approval it verifies itself", async () => {
    const { svc, f, touchId } = setup();
    const tight = await svc.request({ op: "setLimits", limits: { ...stringy(DEFAULT_LIMITS), maxTradeUsd: undefined, maxTradeUsdE8: "5000000000" } });
    expect(tight).toMatchObject({ done: true, approvedBy: null });
    expect(f.calls).toEqual(["setLimits"]);

    const loose = await svc.request({ op: "setLimits", limits: { ...stringy(DEFAULT_LIMITS), maxTradeUsd: "20000000000" } });
    if (!("needsApproval" in loose)) throw new Error("expected approval");
    expect(loose.prompt).toMatch(/maxTradeUsd/);
    await expect(svc.request({ nonce: loose.nonce })).rejects.toThrow(/approval required/);
    await expect(svc.request({ nonce: loose.nonce, approval: { signature: Buffer.alloc(70).toString("base64") } })).rejects.toThrow(/rejected/);
    const ok = await svc.request({ nonce: loose.nonce, approval: { signature: touchId(loose.payload) } });
    expect(ok).toMatchObject({ done: true, approvedBy: "touch-id" });
    // single use
    await expect(svc.request({ nonce: loose.nonce, approval: { signature: touchId(loose.payload) } })).rejects.toThrow(/expired/);

    const un = await svc.request({ op: "unpause" });
    expect("needsApproval" in un).toBe(true);
    for (const op of ["setAgent", "withdraw", "fundAgent"]) {
      const r = await svc.request({ op, agent: AGENT.replace("c1", "c2"), vault: V1, token: V1, amount: "1", wei: "1" });
      expect("needsApproval" in r).toBe(true);
    }
  });

  it("deploy with default limits needs nothing; looser defaults need approval", async () => {
    const { svc, f } = setup();
    expect(await svc.request({ op: "deploy", agent: AGENT, seed: true })).toMatchObject({ done: true, result: { vaults: [{ address: V1 }] } });
    expect(f.calls).toEqual(["deploy", "seed"]);
    // a dropped seed tx keeps the deploy result (the vaults are on chain) and says so
    f.chain.seed = async () => {
      throw new Error("tUSDT into HSK vault: not mined");
    };
    expect(await svc.request({ op: "deploy", agent: AGENT, seed: true })).toMatchObject({ done: true, result: { vaults: [{ address: V1 }], seedError: expect.stringMatching(/not mined/) } });
    const r = await svc.request({ op: "deploy", agent: AGENT, limits: { ...stringy(DEFAULT_LIMITS), maxExposureUsd: "99900000000" } });
    expect("needsApproval" in r).toBe(true);
  });

  it("a vault creation reports live steps, resumes an interrupted one, and keeps other markets' unfinished work", async () => {
    const { svc, f, home } = setup();
    const M = "hsk-dex:WHSK/USDT:3000";
    const priors: unknown[] = [];
    // first attempt: the adapter lands, then a tx is dropped
    f.chain.deploy = (async (o: { prior: unknown; onStep(p: unknown): void; onProgress(s: unknown[]): void }) => {
      priors.push(o.prior);
      o.onStep({ market: M, adapter: V1, vault: AGENT, pending: ["0xaa"] });
      o.onProgress([{ id: "a", market: M, group: "deploy", label: "HSK price adapter", state: "done" }]);
      throw new Error("HSK vault: not mined");
    }) as never;
    writeFileSync(join(home, "owner-state.json"), JSON.stringify({ deployed: [], partial: [{ market: "hsk-dex:WBTC/USDT:3000", vault: V1 }] }));
    await expect(svc.request({ op: "deploy", agent: AGENT, markets: ["hsk"] })).rejects.toThrow(/not mined/);
    expect(svc.job).toMatchObject({ state: "failed", error: expect.stringMatching(/not mined/), steps: [{ state: "done" }] });
    expect((await svc.state()).unfinished.map((u) => u.market).sort()).toEqual(["hsk-dex:WBTC/USDT:3000", M]);
    // second attempt gets the first one's contracts (only for its own market) and finishes
    f.chain.deploy = (async (o: { prior: unknown }) => (priors.push(o.prior), { vaults: [{ market: M, vault: AGENT, adapter: V1 }], txs: [], steps: [] })) as never;
    expect(await svc.request({ op: "deploy", agent: AGENT, markets: ["hsk"] })).toMatchObject({ done: true, result: { vaults: [{ address: AGENT }] } });
    expect(priors[1]).toEqual([{ market: M, adapter: V1, vault: AGENT, pending: ["0xaa"] }]);
    expect(svc.job).toMatchObject({ state: "done" });
    expect((await svc.state()).unfinished).toEqual([{ market: "hsk-dex:WBTC/USDT:3000", vault: V1 }]);
    expect(svc.knownVaults().map((v) => v.address)).toContain(AGENT);
  });

  it("first passkey registers freely, the second needs an approval", async () => {
    const { svc } = setup();
    const k = (n: string) => ({ id: n.repeat(20), publicKey: "A".repeat(80) });
    expect(await svc.addPasskey(k("a"))).toMatchObject({ added: true });
    expect("needsApproval" in (await svc.addPasskey(k("b")))).toBe(true);
  });

  it("exportKey shows the key only after an approval, and never for a key it cannot read", async () => {
    const KEY = `0x${"11".repeat(32)}` as Hex;
    const { svc, touchId, f } = setup({ exportKey: () => KEY });
    const r = await svc.request({ op: "exportKey" });
    if (!("needsApproval" in r)) throw new Error("expected approval");
    expect(JSON.stringify(r)).not.toContain(KEY.slice(2));
    expect(await svc.request({ nonce: r.nonce, approval: { signature: touchId(r.payload) } })).toMatchObject({ done: true, approvedBy: "touch-id", result: { privateKey: KEY } });
    expect(f.calls).toEqual([]);
    await expect(setup().svc.request({ op: "exportKey" })).rejects.toThrow(/cannot be exported/);
  });
});

describe("process boundary", () => {
  it("the agent runtime has no import of the owner service and reads no owner credential", () => {
    const root = join(__dirname, "../../daemon/src");
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") && files.push(join(d, f))));
    walk(root);
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/@ate\/owner|ATE_OWNER_KEY|signerFromEnv\("owner"/);
    }
  });
});

function stringy(l: typeof DEFAULT_LIMITS) {
  return Object.fromEntries(Object.entries(l).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
}
