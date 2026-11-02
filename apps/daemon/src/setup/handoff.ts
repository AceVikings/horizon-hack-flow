// Owner-device handoff (setup steps 02/03/05/06, Settings): the daemon builds the unsigned transactions an owner
// (Safe / hardware / mobile wallet) must send, renders each as an EIP-681 URI where the call fits the standard
// (setAgent, setGuardian, unpause, faucet, ERC-20 transfer), else as a compact tx JSON, and reports when the effect
// is visible on chain. The owner key never touches this Mac: nothing here signs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeDeployData, encodeFunctionData, getContractAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { policyVaultAbi } from "@ate/core";

export type HandoffKind = "setAgent" | "setGuardian" | "setLimits" | "unpause" | "faucet" | "deposit" | "deploy";
export const HANDOFF_KINDS: readonly HandoffKind[] = ["setAgent", "setGuardian", "setLimits", "unpause", "faucet", "deposit", "deploy"];

export interface HandoffTx {
  label: string;
  /** null = contract creation. */
  to: Address | null;
  data: Hex;
  value: string;
  chainId: number;
  /** What the QR encodes: an EIP-681 URI, or a tx JSON for calls EIP-681 cannot express (tuples, creation). */
  uri: string;
  format: "eip681" | "tx-json";
  /** Contract creation: too large for a QR; exported as a file instead. */
  qr: boolean;
}

export interface LimitsInput {
  maxTradeUsdE8: string;
  maxEpochUsdE8: string;
  maxExposureUsdE8: string;
  epochDuration: number;
  maxSlippageBps: number;
  maxOracleDeviationBps: number;
  maxExitDiscountBps: number;
  maxOracleAge: number;
  cooldown: number;
}

const erc20 = parseAbi(["function faucet()", "function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddr = (x: unknown): x is Address => typeof x === "string" && ADDR.test(x);

function txJson(chainId: number, to: Address | null, data: Hex, value = "0"): string {
  return JSON.stringify({ chainId, ...(to ? { to } : {}), value, data });
}

/** EIP-681: `ethereum:<to>@<chainId>/<fn>?<type>=<value>&…` (value params are raw integers). */
export function eip681(to: Address, chainId: number, fn?: string, params: [string, string][] = []): string {
  const q = params.map(([t, v]) => `${t}=${v}`).join("&");
  return `ethereum:${to}@${chainId}${fn ? `/${fn}` : ""}${q ? `?${q}` : ""}`;
}

function call(label: string, chainId: number, to: Address, data: Hex, uri?: string): HandoffTx {
  return { label, to, data, value: "0", chainId, uri: uri ?? txJson(chainId, to, data), format: uri ? "eip681" : "tx-json", qr: true };
}

export function limitsTuple(l: LimitsInput) {
  return {
    maxTradeUsd: BigInt(l.maxTradeUsdE8),
    maxEpochUsd: BigInt(l.maxEpochUsdE8),
    maxExposureUsd: BigInt(l.maxExposureUsdE8),
    epochDuration: l.epochDuration,
    maxSlippageBps: l.maxSlippageBps,
    maxOracleDeviationBps: l.maxOracleDeviationBps,
    maxExitDiscountBps: l.maxExitDiscountBps,
    maxOracleAge: l.maxOracleAge,
    cooldown: l.cooldown,
  } as const;
}

/** Mirrors PolicyVault.setLimits bounds (InvalidLimits field codes) so a QR is never built for a reverting call. */
export function validateLimits(l: LimitsInput): string | null {
  try {
    if (BigInt(l.maxTradeUsdE8) <= 0n) return "maxTradeUsd must be > 0";
    if (BigInt(l.maxEpochUsdE8) < BigInt(l.maxTradeUsdE8)) return "daily budget must be ≥ max per trade";
    if (BigInt(l.maxExposureUsdE8) <= 0n) return "maxExposureUsd must be > 0";
  } catch {
    return "USD limits must be integers (8 decimals)";
  }
  if (!(l.epochDuration > 0)) return "epochDuration must be > 0";
  if (l.maxSlippageBps > 1000) return "slippage ≤ 1000 bps";
  if (l.maxOracleDeviationBps > 1000) return "oracle deviation ≤ 1000 bps";
  if (l.maxExitDiscountBps < l.maxOracleDeviationBps || l.maxExitDiscountBps > 2000) return "exit discount must be ≥ oracle deviation and ≤ 2000 bps";
  if (!(l.maxOracleAge > 0)) return "maxOracleAge must be > 0";
  if (!(l.cooldown >= 0)) return "cooldown must be ≥ 0";
  return null;
}

export function setAgentTx(chainId: number, vault: Address, agent: Address, label: string): HandoffTx {
  return call(label, chainId, vault, encodeFunctionData({ abi: policyVaultAbi, functionName: "setAgent", args: [agent] }), eip681(vault, chainId, "setAgent", [["address", agent]]));
}
export function setGuardianTx(chainId: number, vault: Address, guardian: Address, label: string): HandoffTx {
  return call(label, chainId, vault, encodeFunctionData({ abi: policyVaultAbi, functionName: "setGuardian", args: [guardian] }), eip681(vault, chainId, "setGuardian", [["address", guardian]]));
}
export function setLimitsTx(chainId: number, vault: Address, l: LimitsInput, label: string): HandoffTx {
  return call(label, chainId, vault, encodeFunctionData({ abi: policyVaultAbi, functionName: "setLimits", args: [limitsTuple(l)] }));
}
export function unpauseTx(chainId: number, vault: Address, label: string): HandoffTx {
  return call(label, chainId, vault, encodeFunctionData({ abi: policyVaultAbi, functionName: "unpause" }), eip681(vault, chainId, "unpause"));
}
export function faucetTx(chainId: number, token: Address, label: string): HandoffTx {
  return call(label, chainId, token, encodeFunctionData({ abi: erc20, functionName: "faucet" }), eip681(token, chainId, "faucet"));
}
export function depositTx(chainId: number, token: Address, vault: Address, amount: bigint, label: string): HandoffTx {
  return call(label, chainId, token, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [vault, amount] }), eip681(token, chainId, "transfer", [["address", vault], ["uint256", amount.toString()]]));
}

/** PolicyVault creation bytecode from the Foundry artifact (contracts/out), found up from this module or $ATE_CONTRACTS_OUT. */
export function vaultBytecode(env: NodeJS.ProcessEnv = process.env): Hex | null {
  const rel = "contracts/out/PolicyVault.sol/PolicyVault.json";
  const cands = [env.ATE_CONTRACTS_OUT ? join(env.ATE_CONTRACTS_OUT, "PolicyVault.sol/PolicyVault.json") : "", join(process.cwd(), rel)];
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    cands.push(join(d, rel));
    d = dirname(d);
  }
  const p = cands.find((c) => c && existsSync(c));
  if (!p) return null;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { bytecode: { object: Hex } }).bytecode.object;
  } catch {
    return null;
  }
}

export function deployVaultTx(chainId: number, bytecode: Hex, a: { quoteToken: Address; priceToken: Address; oracle: Address; router: Address; pool: Address; factory: Address }, label: string): HandoffTx {
  const abi = [{ type: "constructor", stateMutability: "nonpayable", inputs: ["quoteToken_", "priceToken_", "oracle_", "router_", "pool_", "factory_"].map((name) => ({ name, type: "address" })) }] as const;
  const data = encodeDeployData({ abi, bytecode, args: [a.quoteToken, a.priceToken, a.oracle, a.router, a.pool, a.factory] });
  return { label, to: null, data, value: "0", chainId, uri: txJson(chainId, null, data), format: "tx-json", qr: false };
}

/** CREATE address of the owner's `nonce`-th transaction (vault deploys are the first txs of the bundle). */
export const predictCreate = (from: Address, nonce: bigint): Address => getContractAddress({ from, nonce });

// ------------------------------------------------------------------ landing checks (polled by the app)

export type HandoffCheck =
  | { kind: "agent"; vault: Address; want: Address }
  | { kind: "guardian"; vault: Address; want: Address }
  | { kind: "limits"; vault: Address; want: LimitsInput }
  | { kind: "unpaused"; vault: Address }
  | { kind: "minted"; token: Address; fromBlock: string }
  | { kind: "balance"; token: Address; holder: Address; atLeast: string }
  | { kind: "code"; address: Address };

export interface CheckResult {
  done: boolean;
  detail: string;
  txHash?: Hex;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function runCheck(c: PublicClient, k: HandoffCheck): Promise<CheckResult> {
  switch (k.kind) {
    case "agent":
    case "guardian": {
      const v = (await c.readContract({ address: k.vault, abi: policyVaultAbi, functionName: k.kind })) as Address;
      return { done: same(v, k.want), detail: `${k.kind}() = ${v}` };
    }
    case "limits": {
      const l = (await c.readContract({ address: k.vault, abi: policyVaultAbi, functionName: "limits" })) as unknown as Record<string, bigint | number>;
      const w = limitsTuple(k.want) as unknown as Record<string, bigint | number>;
      const diff = Object.keys(w).filter((f) => BigInt(l[f]!) !== BigInt(w[f]!));
      return { done: diff.length === 0, detail: diff.length ? `differs: ${diff.join(", ")}` : "limits() match" };
    }
    case "unpaused": {
      const p = (await c.readContract({ address: k.vault, abi: policyVaultAbi, functionName: "paused" })) as boolean;
      return { done: !p, detail: p ? "paused" : "not paused" };
    }
    case "minted": {
      const logs = await c.getLogs({ address: k.token, event: erc20[3], args: { from: "0x0000000000000000000000000000000000000000" }, fromBlock: BigInt(k.fromBlock) });
      const l = logs[logs.length - 1];
      return l ? { done: true, detail: `minted ${l.args.value} to ${l.args.to}`, txHash: l.transactionHash } : { done: false, detail: "waiting for faucet()" };
    }
    case "balance": {
      const b = (await c.readContract({ address: k.token, abi: erc20, functionName: "balanceOf", args: [k.holder] })) as bigint;
      return { done: b >= BigInt(k.atLeast), detail: `balance ${b}` };
    }
    case "code": {
      const code = await c.getCode({ address: k.address });
      return { done: !!code && code !== "0x", detail: code && code !== "0x" ? `deployed at ${k.address}` : `no code at ${k.address} yet` };
    }
  }
}
