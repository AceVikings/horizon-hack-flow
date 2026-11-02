// Doctor as data (setup step 04, docs/design/flow 04-setup-health): the §19 pre-flight checks the CLI `doctor`
// prints, returned as three groups the desktop renders live. Each finished check is also reported through
// `onCheck` (the routes broadcast it on /events as `setup.check`) so the checklist fills in as it runs.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseAbi, type Address, type PublicClient } from "viem";
import { MARKETS, policyVaultAbi, reasonName, type AteConfig, type MarketId } from "@ate/core";
import { probeRpcs } from "@ate/chain";
import type { AteService } from "../service.js";

export type CheckStatus = "pass" | "warn" | "fail" | "running";
export interface DoctorCheck {
  id: string;
  group: "chain" | "prices" | "services";
  label: string;
  status: CheckStatus;
  value: string;
  detail?: string;
  /** Shown under a failure: what to do, in the app (never a shell command). */
  fix?: string;
}
export interface DoctorReport {
  at: number;
  chainId: number;
  checks: DoctorCheck[];
  pass: number;
  warn: number;
  fail: number;
  total: number;
}

export const DOCTOR_GROUPS = [
  { id: "chain", title: "Chain & vaults" },
  { id: "prices", title: "Prices & pools" },
  { id: "services", title: "Services" },
] as const;

const short = (a: string) => `${a.slice(0, 6)}…`;
const asset = (m: MarketId) => (m.includes("WBTC") ? "BTC" : "HSK");
const vaultLabel = (m: MarketId) => `Vault-${asset(m)}`;
export const fmtAge = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`);
const schemaRegistryAbi = parseAbi(["function getSchema(bytes32 uid) view returns ((bytes32 uid, address resolver, bool revocable, string schema))"]);
const SCHEMA_REGISTRY: Address = "0x4200000000000000000000000000000000000020";

/** Locate the chat/trader model runner binary (`claude`) the way a GUI-launched app must: PATH plus the usual dirs. */
export function findRunner(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
  const dirs = [...(env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", join(env.HOME ?? "", ".local/bin"), join(env.HOME ?? "", ".claude/local")];
  for (const d of dirs) if (d && existsSync(join(d, cmd))) return join(d, cmd);
  return null;
}

function runVersion(bin: string, timeoutMs = 8000): Promise<{ ok: boolean; out: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((res) => {
    execFile(bin, ["--version"], { timeout: timeoutMs }, (err, stdout) => res({ ok: !err, out: String(stdout).trim().split("\n")[0] ?? "", ms: Date.now() - t0 }));
  });
}

export async function verifiedOnExplorer(explorer: string, address: string, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const r = await fetchImpl(`${explorer.replace(/\/$/, "")}/api/v2/smart-contracts/${address}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return r.status === 404 ? false : null;
    const j = (await r.json()) as { is_verified?: boolean; is_fully_verified?: boolean; is_partially_verified?: boolean };
    return !!(j.is_verified || j.is_fully_verified || j.is_partially_verified);
  } catch {
    return null;
  }
}

export interface DoctorDeps {
  cfg: AteConfig;
  service: AteService;
  client: PublicClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  onCheck?: (c: DoctorCheck) => void;
}

export async function runDoctor(d: DoctorDeps): Promise<DoctorReport> {
  const { cfg, service, client } = d;
  const checks: DoctorCheck[] = [];
  const put = (c: DoctorCheck) => {
    const i = checks.findIndex((x) => x.id === c.id);
    if (i >= 0) checks[i] = c;
    else checks.push(c);
    d.onCheck?.(c);
  };
  const guard = async (id: string, group: DoctorCheck["group"], label: string, fn: () => Promise<Omit<DoctorCheck, "id" | "group" | "label">>) => {
    put({ id, group, label, status: "running", value: "" });
    try {
      put({ id, group, label, ...(await fn()) });
    } catch (e) {
      put({ id, group, label, status: "fail", value: "error", detail: (e as Error).message.split("\n")[0] });
    }
  };
  const markets = service.markets;
  const testnet = cfg.chain.id === 133;

  // ---- chain & vaults
  const rpc = guard("rpc", "chain", "RPC reachable", async () => {
    const p = await probeRpcs(cfg.chain.rpcUrls, d.fetchImpl);
    const ok = p.filter((x) => x.head !== null);
    if (!ok.length) return { status: "fail", value: "down", detail: p.map((x) => `${x.url}: ${x.error}`).join("; "), fix: "Add a working RPC in Settings → RPC endpoints." };
    const wrong = ok.find((x) => x.chainId !== cfg.chain.id);
    put({ id: "chain-id", group: "chain", label: `Chain ID is ${cfg.chain.id}`, status: wrong ? "fail" : "pass", value: wrong ? `got ${wrong.chainId}` : testnet ? "testnet" : "mainnet", ...(wrong ? { fix: "That RPC serves another chain; remove it in Settings." } : {}) });
    return { status: ok.length < p.length ? "warn" : "pass", value: `${Math.min(...ok.map((x) => x.ms))} ms`, detail: `${ok.length}/${p.length} healthy, head ${ok[0]!.head}` };
  });
  put({ id: "chain-id", group: "chain", label: `Chain ID is ${cfg.chain.id}`, status: "running", value: "" });

  const vaultsVerified = Promise.all(
    markets.map((m) =>
      guard(`verified-${asset(m)}`, "chain", `${vaultLabel(m)} source verified`, async () => {
        const a = service.vaults[m]!;
        const v = await verifiedOnExplorer(cfg.chain.explorer, a, d.fetchImpl);
        return v === true ? { status: "pass", value: short(a) } : v === false ? { status: "warn", value: "unverified", detail: `${cfg.chain.explorer}/address/${a}`, fix: "The explorer has no verified source for this address. Compare the bytecode before funding it." } : { status: "warn", value: "explorer down", detail: "could not reach the explorer API" };
      }),
    ),
  );

  const read = service.refresh(5);
  const agentChk = guard("agent", "chain", "agent() is this key", async () => {
    const c = await read;
    const me = service.agentAddress();
    const bad = markets.filter((m) => !me || c.markets[m]?.vault?.agent.toLowerCase() !== me.toLowerCase());
    if (!me) return { status: "fail", value: "locked", fix: "Unlock the agent key (step 3)." };
    return bad.length ? { status: "fail", value: bad.map(asset).join(", "), fix: "Scan the setAgent QR on your owner device (step 3)." } : { status: "pass", value: markets.length > 1 ? "both" : asset(markets[0]!) };
  });
  const paused = guard("paused", "chain", "Vaults not paused", async () => {
    const c = await read;
    const p = markets.filter((m) => c.markets[m]?.vault?.paused);
    return p.length ? { status: "fail", value: p.map(asset).join(", "), fix: "Unpause from your owner device (Settings → Agent key → unpause QR)." } : { status: "pass", value: markets.length > 1 ? "both" : asset(markets[0]!) };
  });

  // ---- prices & pools
  const maxAge = cfg.supra.maxAgeSec;
  const prices = (async () => {
    const c = await read.catch(() => null);
    for (const m of markets) {
      await guard(`supra-${asset(m)}`, "prices", `Supra ${asset(m)}/USD age`, async () => {
        const r = c?.markets[m];
        if (!r) return { status: "fail", value: "no read" };
        const age = r.price.oracle.ageSec;
        return { status: age >= maxAge ? "fail" : age >= (cfg.supra.pull?.refreshAgeSec ?? maxAge) ? "warn" : "pass", value: `${fmtAge(age)} / ${fmtAge(maxAge)}`, ...(age >= maxAge ? { fix: "Supra is stale: buys revert OracleStale. Use Refresh in Markets (pull refresh)." } : {}) };
      });
    }
    await guard("pull", "prices", "Pull refresh works", async () => {
      const p = cfg.supra.pull;
      if (!p?.enabled) return { status: "warn", value: "off", detail: "pull refresh disabled in config" };
      const r = await (d.fetchImpl ?? fetch)(p.proofUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(6000) }).catch(() => null);
      return r ? { status: "pass", value: testnet ? "DORA" : "Supra", detail: `${p.proofUrl} HTTP ${r.status}` } : { status: "warn", value: "unreachable", detail: p.proofUrl };
    });
    for (const m of markets) {
      await guard(`pool-${asset(m)}`, "prices", `W${asset(m)} pool vs oracle`, async () => {
        const r = c?.markets[m];
        if (!r) return { status: "fail", value: "no read" };
        const lim = r.vault?.limits.maxOracleDeviationBps ?? 250;
        const S = Number(r.price.pool.price);
        const P = Number(r.price.oracle.price);
        const signed = P > 0 ? Math.round(((S - P) / P) * 10_000) : r.price.pool.deviationBps;
        const over = Math.abs(signed) > lim || (r.price.pool.twapDeviationBps ?? 0) > lim;
        return { status: over ? "warn" : "pass", value: `${signed >= 0 ? "+" : "−"}${Math.abs(signed)} bps`, ...(over ? { detail: `beyond ${lim} bps: normal-path buys revert; exits still work` } : {}) };
      });
    }
    await guard("twap", "prices", "300 s TWAP ready", async () => {
      const notReady = markets.filter((m) => !c?.markets[m]?.price.pool.twap);
      const lowCard = markets.filter((m) => (c?.markets[m]?.price.pool.observationCardinality ?? 0) < 2);
      if (notReady.length) return { status: "fail", value: notReady.map(asset).join(", "), fix: "The pool needs 300 s of history; wait five minutes and re-run." };
      return { status: lowCard.length ? "warn" : "pass", value: markets.length > 1 ? "both" : asset(markets[0]!), detail: markets.map((m) => `${asset(m)} cardinality ${c?.markets[m]?.price.pool.observationCardinality}`).join(", ") };
    });
    await guard("apro", "prices", "APRO cross-check", async () => {
      if (testnet) return { status: "warn", value: "ok to go", detail: "not on testnet · inactive" };
      const have = markets.filter((m) => c?.markets[m]?.price.apro);
      return have.length === markets.length ? { status: "pass", value: "live" } : { status: "warn", value: "partial", detail: "APRO read failed; Supra still prices trades" };
    });
  })();

  // ---- services
  const services = (async () => {
    await guard("cex", "services", "HashKey Global books", async () => {
      const t0 = Date.now();
      const r = await (d.fetchImpl ?? fetch)(`${cfg.oracle.cex.baseUrl.replace(/\/$/, "")}/quote/v1/depth?symbol=BTCUSDT&limit=1`, { signal: AbortSignal.timeout(6000) }).catch(() => null);
      return r?.ok ? { status: "pass", value: `${Date.now() - t0} ms` } : { status: "warn", value: "unreachable", detail: "CEX marks unavailable; trading still works on Supra" };
    });
    await guard("model", "services", "AI model · Claude", async () => {
      const bin = findRunner(cfg.chat.runner.split(/\s+/)[0] ?? "claude", d.env);
      if (!bin) return { status: "fail", value: "not found", fix: "Install Claude Code and sign in; Flow runs the trader through it." };
      const v = await runVersion(bin);
      return v.ok ? { status: "pass", value: `${(v.ms / 1000).toFixed(1)} s`, detail: v.out } : { status: "fail", value: "error", detail: v.out || "runner did not answer --version" };
    });
    await guard("eas", "services", "EAS schema registered", async () => {
      const s = (await client.readContract({ address: SCHEMA_REGISTRY, abi: schemaRegistryAbi, functionName: "getSchema", args: [cfg.eas.schemaUid as `0x${string}`] })) as { uid: string };
      const ok = /^0x0{64}$/.test(s.uid) === false;
      return ok ? { status: "pass", value: `${cfg.eas.schemaUid.slice(0, 6)}…` } : { status: "warn", value: "missing", detail: "attestations will be deferred" };
    });
    await guard("journal", "services", "Journal writable", async () => {
      const v = service.journal.verify();
      return v.ok ? { status: "pass", value: "hash chain" } : { status: "fail", value: `broken at ${v.seq}`, detail: v.reason };
    });
    await guard("dryrun", "services", "Dry-run a $5 trade", async () => {
      const c = await read;
      const out: string[] = [];
      let worst: CheckStatus = "pass";
      for (const m of markets) {
        const v = c.markets[m]?.vault;
        if (!v) continue;
        const [reason] = (await client.readContract({
          address: v.address,
          abi: policyVaultAbi,
          functionName: "check",
          args: [v.agent, { tokenIn: MARKETS[m].quoteToken as Address, amountIn: 5_000_000n, minAmountOut: 2n ** 200n, deadline: BigInt(c.blockTimestamp + 600), proposalId: `0x${"00".repeat(31)}01` }],
        })) as readonly [number, bigint, bigint, bigint, boolean];
        out.push(`${asset(m)} ${reasonName(Number(reason))}`);
        if (Number(reason) !== 0) worst = "warn";
      }
      return { status: worst, value: worst === "pass" ? "check() OK" : "see detail", detail: `check() on both vaults: ${out.join(", ")}` };
    });
  })();

  await Promise.all([rpc, vaultsVerified, agentChk, paused, prices, services]);
  const order = ["rpc", "chain-id", ...markets.map((m) => `verified-${asset(m)}`), "agent", "paused", ...markets.map((m) => `supra-${asset(m)}`), "pull", ...markets.map((m) => `pool-${asset(m)}`), "twap", "apro", "cex", "model", "eas", "journal", "dryrun"];
  checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const n = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  return { at: Math.floor(Date.now() / 1000), chainId: cfg.chain.id, checks, pass: n("pass"), warn: n("warn"), fail: n("fail"), total: checks.length };
}
