// `ate rogue` engine (SPEC §22.3). The "stolen agent key" attacker: every on-chain attack is pre-asserted with
// the vault's own `check()` (or an eth_call for owner-only selectors), then broadcast through the daemon's
// rogue raw route (`POST /rogue/tx`, rogue token only, fixed gas, no pre-flight) so the revert lands on-chain.
// The daemon journals a `proposal` + `execution` pair per attempt (`profile=rogue`, `verdict.code` = expected).
// This process never holds a key: the agent key stays inside the daemon (§7.1).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MARKETS, REASON_NAMES, policyVaultAbi, type MarketId } from "@ate/core";
import { createPublicClient, decodeErrorResult, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem";

export type AttackId = "trade_cap" | "exposure" | "slippage" | "pair" | "withdraw" | "set_limits" | "paused";
export const FULL_RUN: AttackId[] = ["trade_cap", "exposure", "slippage", "pair", "withdraw", "set_limits", "paused"];
export const STAGE_RUN: AttackId[] = ["slippage", "withdraw"];

const EXPECTED: Record<AttackId, string> = {
  trade_cap: "ERR_TRADE_CAP",
  exposure: "ERR_EXPOSURE",
  slippage: "ERR_SLIPPAGE",
  pair: "ERR_PAIR_NOT_ALLOWED",
  withdraw: "OWNER_ONLY",
  set_limits: "OWNER_ONLY",
  paused: "ERR_PAUSED",
};

export interface RogueOptions {
  market: MarketId;
  attacks: AttackId[];
  stage: boolean;
  daemonUrl: string;
  rogueToken: string;
  rpcUrl: string;
  vault: Address;
  gas: bigint;
  /** tokenIn for the pair attack (a token the attacker deployed); default: a fresh address no vault allows. */
  fakeToken?: Address;
  /** Seconds to wait for a guardian pause before the paused attack (0 = skip if not paused). */
  waitPauseSec: number;
  dryRun: boolean;
  log: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  client?: PublicClient;
}

export interface AttackResult {
  attack: AttackId;
  expected: string;
  status: "reverted" | "skipped" | "unexpected" | "aborted" | "dry-run";
  checkCode?: string;
  txHash?: Hex;
  decoded?: string;
  decisionId?: string;
  note?: string;
}

const DEFAULT_FAKE_TOKEN = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as Address; // key 0x…01's address: no vault pairs it

export function resolveMarket(s: string | undefined): MarketId {
  const v = (s ?? "WHSK").toUpperCase();
  if (v === "WHSK" || v === "HSK") return "hsk-dex:WHSK/USDT:3000";
  if (v === "WBTC" || v === "BTC") return "hsk-dex:WBTC/USDT:3000";
  if (s && s in MARKETS) return s as MarketId;
  throw new Error(`unknown market ${s}`);
}

/** Reads ~/.ate (or ATE_HOME) config.json + runtime.json for the RPC, the vault and the daemon port. */
export function loadLocal(env: NodeJS.ProcessEnv, market: MarketId): { rpcUrl: string | null; vault: Address | null; daemonUrl: string | null } {
  const home = env.ATE_HOME ?? join(homedir(), ".ate");
  let rpcUrl: string | null = null;
  let vault: Address | null = null;
  let daemonUrl: string | null = null;
  try {
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { chain?: { rpcUrls?: string[] }; vaults?: { market: string; address: string }[] };
    rpcUrl = cfg.chain?.rpcUrls?.[0] ?? null;
    vault = (cfg.vaults?.find((v) => v.market === market)?.address as Address | undefined) ?? null;
  } catch {
    /* flags must supply them */
  }
  try {
    const rt = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")) as { port: number };
    daemonUrl = `http://127.0.0.1:${rt.port}`;
  } catch {
    /* --daemon-url */
  }
  return { rpcUrl, vault, daemonUrl };
}

const enc = (fn: string, args: unknown[]): Hex => encodeFunctionData({ abi: policyVaultAbi, functionName: fn, args } as never);

interface VaultRead {
  agent: Address;
  quote: Address;
  price: Address;
  paused: boolean;
  limits: { maxTradeUsd: bigint; maxEpochUsd: bigint; maxExposureUsd: bigint; cooldown: number; maxOracleDeviationBps: number };
  epoch: { spentUsd: bigint; capUsd: bigint };
  exposureUsd: bigint;
  lastTradeAt: bigint;
  quoteBal: bigint;
  blockTs: bigint;
}

const erc20BalanceAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;

async function readVault(c: PublicClient, v: Address): Promise<VaultRead> {
  const r = <T>(functionName: string, args: unknown[] = []) => c.readContract({ address: v, abi: policyVaultAbi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
  const [agent, quote, price, paused, limits, epoch, exposureUsd, lastTradeAt, block] = await Promise.all([
    r<Address>("agent"),
    r<Address>("quoteToken"),
    r<Address>("priceToken"),
    r<boolean>("paused"),
    r<{ maxTradeUsd: bigint; maxEpochUsd: bigint; maxExposureUsd: bigint; cooldown: number; maxOracleDeviationBps: number }>("limits"),
    r<readonly [bigint, bigint, bigint, bigint]>("epoch"),
    r<bigint>("exposureUsd"),
    r<bigint>("lastTradeAt"),
    c.getBlock(),
  ]);
  const quoteBal = (await c.readContract({ address: quote, abi: erc20BalanceAbi, functionName: "balanceOf", args: [v] })) as bigint;
  return { agent, quote, price, paused, limits, epoch: { spentUsd: epoch[2], capUsd: epoch[3] }, exposureUsd, lastTradeAt, quoteBal, blockTs: block.timestamp };
}

interface Swap {
  tokenIn: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
  proposalId: Hex;
}

async function check(c: PublicClient, v: Address, caller: Address, p: Swap): Promise<{ reason: number; name: string; minOutFloor: bigint; notionalUsd: bigint }> {
  const r = (await c.readContract({ address: v, abi: policyVaultAbi as never, functionName: "check" as never, args: [caller, p] as never })) as readonly [number, bigint, bigint, bigint, boolean];
  return { reason: Number(r[0]), name: REASON_NAMES[Number(r[0])] ?? `code ${r[0]}`, notionalUsd: r[1], minOutFloor: r[3] };
}

/** eth_call from the agent; returns the decoded custom error (or null when the call would succeed). */
async function simulate(c: PublicClient, v: Address, from: Address, data: Hex, blockNumber?: bigint): Promise<string | null> {
  try {
    await c.call({ account: from, to: v, data, ...(blockNumber !== undefined ? { blockNumber } : {}) });
    return null;
  } catch (e) {
    return decodeRevert(e);
  }
}

export function decodeRevert(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const d = (cur as { data?: unknown }).data;
    const hex = typeof d === "string" ? d : typeof (d as { data?: unknown })?.data === "string" ? (d as { data: string }).data : null;
    if (hex && /^0x[0-9a-fA-F]{8}/.test(hex)) {
      try {
        const r = decodeErrorResult({ abi: policyVaultAbi as never, data: hex as Hex });
        return `${r.errorName}(${(r.args ?? []).map((a) => String(a)).join(", ")})`;
      } catch {
        return `revert ${hex.slice(0, 10)}`;
      }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return `revert (${String((e as Error)?.message ?? e).split("\n")[0]})`;
}

const usd = (e8: bigint) => `$${(Number(e8) / 1e8).toFixed(2)}`;

export async function runRogue(o: RogueOptions): Promise<AttackResult[]> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const f = o.fetchImpl ?? fetch;
  const c = o.client ?? (createPublicClient({ transport: http(o.rpcUrl) }) as PublicClient);
  const daemon = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await f(o.daemonUrl + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.rogueToken}` }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const label = MARKETS[o.market].label;
  const out: AttackResult[] = [];
  let st = await readVault(c, o.vault);
  o.log(`ate rogue — ${label} vault ${o.vault} · agent ${st.agent} · ${o.stage ? "STAGE (slippage buy, then withdraw)" : "full run"}${o.dryRun ? " · DRY RUN (no broadcast)" : ""}`);
  o.log(`  limits: trade ${usd(st.limits.maxTradeUsd)} · epoch ${usd(st.limits.maxEpochUsd)} (spent ${usd(st.epoch.spentUsd)}) · exposure ${usd(st.limits.maxExposureUsd)} (now ${usd(st.exposureUsd)}) · cooldown ${st.limits.cooldown}s · paused ${st.paused}`);

  const pid = (a: string) => keccak256(toBytes(`ate-rogue|${a}|${Date.now()}`));
  const waitCooldown = async () => {
    for (let i = 0; i < 400; i++) {
      st = await readVault(c, o.vault);
      const ready = st.lastTradeAt + BigInt(st.limits.cooldown);
      if (st.blockTs >= ready) return;
      const s = Number(ready - st.blockTs);
      if (i === 0) o.log(`  waiting out cooldown: ${s}s`);
      await sleep(Math.min(5, Math.max(1, s)) * 1000);
    }
    throw new Error("cooldown did not elapse");
  };

  /** Hold candidate executes on this vault (cooldown + 30 s), wait out cooldown, return the queue seq to pin. */
  const prepare = async (): Promise<number | undefined> => {
    if (o.dryRun) {
      await waitCooldown();
      return undefined;
    }
    const h = await daemon("/rogue/hold", { market: o.market, seconds: st.limits.cooldown + 30 });
    if (h.status !== 200) throw new Error(`/rogue/hold → ${h.status} ${JSON.stringify(h.json)}`);
    await waitCooldown();
    // the seq is read after the cooldown wait: any daemon tx for this vault after this point aborts the attack
    const h2 = await daemon("/rogue/hold", { market: o.market, seconds: 60 });
    return Number(h2.json.vaultTxSeq);
  };

  const broadcast = async (attack: AttackId, data: Hex, seq: number | undefined, rationale: string, intent?: { side: "buy" | "sell"; tokenIn: string; amountIn: string }): Promise<AttackResult> => {
    const expected = EXPECTED[attack];
    if (o.dryRun) return { attack, expected, status: "dry-run" };
    const r = await daemon("/rogue/tx", { to: o.vault, data, gas: o.gas.toString(), attack, expected, rationale, ...(seq !== undefined ? { ifVaultTxSeq: seq } : {}), ...(intent ? { intent } : {}) });
    if (r.status === 409) return { attack, expected, status: "aborted", note: `a ${label} tx entered the queue between check() and broadcast — use the recorded E4` };
    if (r.status !== 200) return { attack, expected, status: "unexpected", note: `/rogue/tx → ${r.status} ${JSON.stringify(r.json).slice(0, 200)}` };
    const txHash = r.json.txHash as Hex;
    const bn = r.json.blockNumber ? BigInt(String(r.json.blockNumber)) : undefined;
    const decoded = bn !== undefined ? await simulate(c, o.vault, st.agent, data, bn - 1n) : null;
    const reverted = r.json.status === "reverted";
    return { attack, expected, status: reverted ? "reverted" : "unexpected", txHash, decisionId: String(r.json.decisionId), ...(decoded ? { decoded } : {}), ...(reverted ? {} : { note: `tx status ${String(r.json.status)}` }) };
  };

  const buyAttack = async (attack: AttackId, amountIn: bigint, minOut: "floor" | bigint, tokenIn: Address = st.quote): Promise<AttackResult> => {
    const expected = EXPECTED[attack];
    const seq = await prepare();
    const deadline = st.blockTs + 600n;
    let p: Swap = { tokenIn, amountIn, minAmountOut: minOut === "floor" ? 0n : minOut, deadline, proposalId: pid(attack) };
    if (minOut === "floor") {
      const pre = await check(c, o.vault, st.agent, p);
      p = { ...p, minAmountOut: pre.minOutFloor > 0n ? pre.minOutFloor : 1n };
    }
    const ck = await check(c, o.vault, st.agent, p);
    if (ck.name !== expected) return { attack, expected, status: o.stage ? "aborted" : "skipped", checkCode: ck.name, note: `check() returned ${ck.name}, not ${expected}${o.stage ? " — --stage aborts to the recorded E4" : ""}` };
    o.log(`  ${attack}: check() → ${ck.name} ✓ (notional ${usd(ck.notionalUsd)}, floor ${ck.minOutFloor}) — broadcasting with fixed gas ${o.gas}`);
    const rationaleHash = keccak256(toBytes(`rogue ${attack}`));
    const data = enc("execute", [p, rationaleHash]);
    return broadcast(attack, data, seq, `stolen-key ${attack}: tokenIn ${tokenIn} amountIn ${amountIn} minAmountOut ${p.minAmountOut}`, { side: "buy", tokenIn, amountIn: amountIn.toString() });
  };

  const ownerAttack = async (attack: "withdraw" | "set_limits"): Promise<AttackResult> => {
    const expected = EXPECTED[attack];
    st = await readVault(c, o.vault);
    const data =
      attack === "withdraw"
        ? enc("withdraw", [st.quote, st.agent, st.quoteBal])
        : enc("setLimits", [{ ...(await c.readContract({ address: o.vault, abi: policyVaultAbi as never, functionName: "limits" as never })) as object, maxTradeUsd: 1_000_000n * 10n ** 8n }]);
    const sim = await simulate(c, o.vault, st.agent, data);
    if (!sim || !/^NotOwner/.test(sim)) return { attack, expected, status: o.stage ? "aborted" : "skipped", checkCode: sim ?? "succeeds", note: `eth_call from the agent gave ${sim ?? "success"}, not NotOwner` };
    o.log(`  ${attack}: eth_call → ${sim} ✓ — broadcasting with fixed gas ${o.gas}`);
    const seq = o.dryRun ? undefined : Number((await daemon("/rogue/hold", { market: o.market, seconds: 60 })).json.vaultTxSeq);
    return broadcast(attack, data, seq, attack === "withdraw" ? `stolen-key withdraw(USDT, attacker, ${st.quoteBal})` : "stolen-key setLimits(maxTradeUsd = 1e6)");
  };

  for (const a of o.attacks) {
    let r: AttackResult;
    try {
      st = await readVault(c, o.vault);
      if (st.paused && a !== "paused" && a !== "withdraw" && a !== "set_limits") {
        r = { attack: a, expected: EXPECTED[a], status: "skipped", note: "vault is paused (every execute returns ERR_PAUSED first)" };
      } else if (a === "trade_cap") {
        r = await buyAttack(a, 5000n * 10n ** 6n, 1n);
      } else if (a === "slippage") {
        r = await buyAttack(a, 5n * 10n ** 6n, 1n);
      } else if (a === "pair") {
        r = await buyAttack(a, 5n * 10n ** 6n, 1n, o.fakeToken ?? DEFAULT_FAKE_TOKEN);
      } else if (a === "exposure") {
        // Size to the epoch headroom (≤ $100, ≤ trade cap, ≤ USDT held) so steps 9–13 pass and step 14 bites.
        const headroomE8 = st.epoch.capUsd - st.epoch.spentUsd;
        let e8 = [headroomE8, st.limits.maxTradeUsd, 100n * 10n ** 8n, st.quoteBal * 100n].reduce((m, x) => (x < m ? x : m));
        e8 = (e8 * 99n) / 100n;
        const need = ((st.limits.maxExposureUsd - st.exposureUsd) * (10_000n - BigInt(st.limits.maxOracleDeviationBps))) / 10_000n;
        if (e8 <= need) r = { attack: a, expected: EXPECTED[a], status: "skipped", note: `headroom ${usd(e8)} ≤ ${usd(need)} needed to lift exposure ${usd(st.exposureUsd)} above ${usd(st.limits.maxExposureUsd)} — run at the next epoch (§19)` };
        else r = await buyAttack(a, e8 / 100n, "floor");
      } else if (a === "withdraw" || a === "set_limits") {
        r = await ownerAttack(a);
      } else {
        // paused: needs the guardian's pause (signed off the agent's machine)
        for (let i = 0; !st.paused && i < o.waitPauseSec; i += 3) {
          if (i === 0) o.log(`  paused: waiting up to ${o.waitPauseSec}s for the guardian pause()…`);
          await sleep(3000);
          st = await readVault(c, o.vault);
        }
        if (!st.paused) r = { attack: a, expected: EXPECTED[a], status: "skipped", note: "vault not paused — run after the guardian pause (or --wait-pause <sec>)" };
        else {
          const p: Swap = { tokenIn: st.quote, amountIn: 5n * 10n ** 6n, minAmountOut: 1n, deadline: st.blockTs + 600n, proposalId: pid(a) };
          const ck = await check(c, o.vault, st.agent, p);
          if (ck.name !== "ERR_PAUSED") r = { attack: a, expected: EXPECTED[a], status: "skipped", checkCode: ck.name };
          else {
            o.log(`  paused: check() → ERR_PAUSED ✓ — broadcasting`);
            r = await broadcast(a, enc("execute", [p, keccak256(toBytes("rogue paused"))]), undefined, "stolen-key execute after guardian pause", { side: "buy", tokenIn: st.quote, amountIn: p.amountIn.toString() });
          }
        }
      }
    } catch (e) {
      r = { attack: a, expected: EXPECTED[a], status: "unexpected", note: (e as Error).message.split("\n")[0] };
    }
    out.push(r);
    o.log(`  → ${r.attack}: ${r.status}${r.txHash ? ` tx ${r.txHash}` : ""}${r.decoded ? ` ${r.decoded}` : ""}${r.note ? ` (${r.note})` : ""}`);
    if (o.stage && r.status !== "reverted" && r.status !== "dry-run") break;
  }
  if (!o.dryRun) await daemon("/rogue/hold", { market: o.market, seconds: 0 }).catch(() => null);
  o.log("  design-level: attacker pool routing — SwapParams has no pool/router/path field (pool fixed at deploy); stolen daemon tokens cannot change limits — the daemon holds no owner key and has no such endpoint.");
  return out;
}
