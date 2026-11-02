import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createPublicClient, http, parseAbi, type Address } from "viem";

export const WORKER_DIR = process.env.ATE_WORKER_DIR ?? join(homedir(), ".ate-worker");

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

/** Fresh 32-byte token per start, written mode 0600 for the daemon to fetch over SSM (§3.4). */
export function rotateToken(file: string): string {
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export const readToken = (file: string): string => readFileSync(file, "utf8").trim();

/** Live HSP only when G-HSP is go and the operator says so explicitly. */
export function hspLiveAllowed(): boolean {
  return process.env.ATE_HSP_LIVE === "1";
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const vaultAbi = parseAbi(["function paused() view returns (bool)"]);

export function balanceReader(rpcUrl: string | undefined) {
  return async (token: Address, owner: Address): Promise<bigint> => {
    if (!rpcUrl) throw new Error("no RPC for the HSP network (get_chain_config returned none; set ATE_HSP_NETWORK_RPC)");
    const c = createPublicClient({ transport: http(rpcUrl) });
    return c.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [owner] });
  };
}

/** Vault-HSK paused() on chain 177; no purchases while paused (§9.5). */
export function vaultPausedReader(rpc177: string | undefined, vault: Address | undefined) {
  return async (): Promise<boolean> => {
    if (!rpc177 || !vault) return false;
    const c = createPublicClient({ transport: http(rpc177) });
    return c.readContract({ address: vault, abi: vaultAbi, functionName: "paused" });
  };
}
