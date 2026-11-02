// On-chain side of the owner service: reads vault state and sends owner transactions with the owner signer.
// `deploy` is contracts/script/Deploy.s.sol ported to viem: per market a SupraAggregatorAdapter, then the vault
// with oracle = adapter, then setLimits / setAgent / setGuardian. Testnet (133) can also seed the new vaults
// with test tokens (TestToken.mint is owner-only and the owner key is the token deployer).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, http, parseAbi, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import { policyVaultAbi } from "@ate/core";
import { OwnerError, type VaultLimits } from "./ops.js";

export interface Deployment {
  chainId: number;
  owner?: string;
  agent?: string;
  guardian: string;
  explorer: string;
  rpcUrls: string[];
  markets: Record<string, { vault: string; pool: string; adapter: string; priceToken: string; quoteToken: string; supraPair: number; priceDecimals?: number }>;
  hskdex: { factory: string; router: string };
  supra: { storage: string };
  [k: string]: unknown;
}

export const MARKET_OF = { hsk: "hsk-dex:WHSK/USDT:3000", btc: "hsk-dex:WBTC/USDT:3000" } as const;
const erc20 = parseAbi(["function mint(address to, uint256 amount)", "function faucet()", "function transfer(address to, uint256 amount) returns (bool)", "function owner() view returns (address)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
const adapterAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

/** Foundry artifact (contracts/out, $ATE_CONTRACTS_OUT, or the slim contracts/artifacts copy the cloud image ships). */
export function artifact(name: "PolicyVault" | "SupraAggregatorAdapter", env: NodeJS.ProcessEnv = process.env): Hex {
  const rels = [`contracts/out/${name}.sol/${name}.json`, `contracts/artifacts/${name}.json`];
  const cands: string[] = [];
  if (env.ATE_CONTRACTS_OUT) cands.push(join(env.ATE_CONTRACTS_OUT, `${name}.sol/${name}.json`), join(env.ATE_CONTRACTS_OUT, `${name}.json`));
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const r of rels) cands.push(join(d, r));
    d = dirname(d);
  }
  for (const r of rels) cands.push(join(process.cwd(), r));
  const p = cands.find((c) => existsSync(c));
  if (!p) throw new OwnerError(500, `${name} bytecode not found (build contracts or set ATE_CONTRACTS_OUT)`);
  const j = JSON.parse(readFileSync(p, "utf8")) as { bytecode: { object: Hex } | Hex };
  return typeof j.bytecode === "string" ? j.bytecode : j.bytecode.object;
}

export interface VaultState {
  market: string | null;
  address: Address;
  owner: Address;
  agent: Address;
  guardian: Address;
  paused: boolean;
  limits: VaultLimits;
}

export class OwnerChain {
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  constructor(
    readonly account: LocalAccount,
    readonly dep: Deployment,
    rpcUrl?: string,
  ) {
    const chain = defineChain({ id: dep.chainId, name: `hashkey-${dep.chainId}`, nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl ?? dep.rpcUrls[0]!] } } });
    this.pub = createPublicClient({ chain, transport: http() }) as PublicClient;
    this.wallet = createWalletClient({ chain, account, transport: http() });
  }

  get address(): Address {
    return this.account.address;
  }

  async balance(a: Address = this.address): Promise<bigint> {
    return this.pub.getBalance({ address: a });
  }

  async vault(address: Address, market: string | null = null): Promise<VaultState> {
    const read = (functionName: string) => this.pub.readContract({ address, abi: policyVaultAbi, functionName: functionName as never }) as Promise<unknown>;
    const [owner, agent, guardian, paused, l] = await Promise.all([read("owner"), read("agent"), read("guardian"), read("paused"), read("limits")]);
    const x = l as Record<string, bigint | number>;
    return {
      market,
      address,
      owner: owner as Address,
      agent: agent as Address,
      guardian: guardian as Address,
      paused: paused as boolean,
      limits: {
        maxTradeUsd: BigInt(x.maxTradeUsd!),
        maxEpochUsd: BigInt(x.maxEpochUsd!),
        maxExposureUsd: BigInt(x.maxExposureUsd!),
        epochDuration: Number(x.epochDuration),
        maxSlippageBps: Number(x.maxSlippageBps),
        maxOracleDeviationBps: Number(x.maxOracleDeviationBps),
        maxExitDiscountBps: Number(x.maxExitDiscountBps),
        maxOracleAge: Number(x.maxOracleAge),
        cooldown: Number(x.cooldown),
      },
    };
  }

  /** One owner call, waited until mined; a revert is an error. */
  /**
   * Sends one owner tx and waits for it. The nonce is ours to track (a load-balanced RPC can report a stale pending
   * nonce right after a receipt); on a nonce clash (another tool used the same owner key) we resync and retry. We sign
   * locally and keep the raw tx, so a tx an RPC node accepted and then dropped is re-broadcast instead of lost.
   */
  private nonce: number | null = null;
  private async submit(tx: { to: Address | null; data: Hex; value?: bigint }): Promise<{ hash: Hex; raw: Hex }> {
    for (let attempt = 0; ; attempt++) {
      const chainNonce = await this.pub.getTransactionCount({ address: this.address, blockTag: "pending" });
      const nonce = Math.max(chainNonce, this.nonce ?? 0);
      try {
        const req = await this.wallet.prepareTransactionRequest({ account: this.account, chain: this.wallet.chain, to: tx.to as never, data: tx.data, value: tx.value ?? 0n, nonce } as never);
        const raw = (await this.account.signTransaction!(req as never)) as Hex;
        const hash = await this.pub.sendRawTransaction({ serializedTransaction: raw });
        this.nonce = nonce + 1;
        return { hash, raw };
      } catch (e) {
        const m = (e as Error).message;
        if (attempt < 4 && /nonce|underpriced|already known/i.test(m)) {
          this.nonce = nonce + 1;
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw e;
      }
    }
  }

  private async mined(label: string, t: { hash: Hex; raw: Hex }) {
    for (let round = 0; round < 6; round++) {
      try {
        return await this.pub.waitForTransactionReceipt({ hash: t.hash, timeout: 45_000 });
      } catch {
        const known = await this.pub.getTransaction({ hash: t.hash }).catch(() => null);
        if (!known) await this.pub.sendRawTransaction({ serializedTransaction: t.raw }).catch(() => undefined);
      }
    }
    throw new OwnerError(504, `${label}: not mined after several re-broadcasts (${t.hash})`);
  }

  /** Load-balanced RPCs can lag a block behind the node that gave us the receipt: wait until the code is visible. */
  private async codeAt(a: Address): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const c = await this.pub.getCode({ address: a }).catch(() => undefined);
      if (c && c !== "0x") return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async send(label: string, to: Address, data: Hex, value = 0n): Promise<{ label: string; hash: Hex }> {
    const t = await this.submit({ to, data, value });
    const r = await this.mined(label, t);
    if (r.status !== "success") throw new OwnerError(502, `${label} reverted (${t.hash})`);
    return { label, hash: t.hash };
  }

  async call(label: string, vault: Address, functionName: string, args: unknown[] = []): Promise<{ label: string; hash: Hex }> {
    return this.send(label, vault, encodeFunctionData({ abi: policyVaultAbi, functionName: functionName as never, args: args as never }));
  }

  private async create(label: string, data: Hex): Promise<{ label: string; hash: Hex; address: Address }> {
    const t = await this.submit({ to: null, data });
    const r = await this.mined(label, t);
    if (r.status !== "success" || !r.contractAddress) throw new OwnerError(502, `${label} failed (${t.hash})`);
    await this.codeAt(r.contractAddress);
    return { label, hash: t.hash, address: r.contractAddress };
  }

  /** Deploy.s.sol `_deployOne`, per market. Returns the new addresses and every tx. */
  async deploy(o: {
    markets: ("hsk" | "btc")[];
    agent: Address;
    guardian?: Address;
    limits: VaultLimits;
    env?: NodeJS.ProcessEnv;
    /** Contracts from an interrupted deploy (resumed instead of redeployed). */
    prior?: { market: string; vault?: Address; adapter?: Address }[];
    onStep?: (p: { market: string; vault?: Address; adapter?: Address }) => void;
  }) {
    const vaultCode = artifact("PolicyVault", o.env);
    const adapterCode = artifact("SupraAggregatorAdapter", o.env);
    const txs: { label: string; hash: Hex }[] = [];
    const out: { market: string; vault: Address; adapter: Address }[] = [];
    for (const k of o.markets) {
      const id = MARKET_OF[k];
      const m = this.dep.markets[id];
      if (!m) throw new OwnerError(400, `no ${id} in deployments/${this.dep.chainId}.json`);
      const desc = `${k === "hsk" ? "HSK" : "BTC"}/USD (Supra pair ${m.supraPair})`;
      const prior = o.prior?.find((p) => p.market === id);
      const a = prior?.adapter
        ? { address: prior.adapter }
        : await this.create(`${k.toUpperCase()} price adapter`, `${adapterCode}${encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "string" }], [this.dep.supra.storage as Address, BigInt(m.supraPair), desc]).slice(2)}` as Hex);
      if ("hash" in a) txs.push(a as { label: string; hash: Hex });
      o.onStep?.({ market: id, adapter: a.address });
      const args = [m.quoteToken, m.priceToken, a.address, this.dep.hskdex.router, m.pool, this.dep.hskdex.factory] as Address[];
      const v = prior?.vault ? { address: prior.vault } : await this.create(`${k.toUpperCase()} vault`, `${vaultCode}${encodeAbiParameters(args.map(() => ({ type: "address" })), args).slice(2)}` as Hex);
      if ("hash" in v) txs.push(v as { label: string; hash: Hex });
      o.onStep?.({ market: id, adapter: a.address, vault: v.address });
      await this.codeAt(v.address);
      const st = await this.vault(v.address, id);
      const g = o.guardian ?? (this.dep.guardian as Address);
      const sameLimits = (Object.keys(o.limits) as (keyof VaultLimits)[]).every((f) => BigInt(st.limits[f]) === BigInt(o.limits[f]));
      if (!sameLimits) txs.push(await this.call(`${k.toUpperCase()} limits`, v.address, "setLimits", [o.limits]));
      if (st.agent.toLowerCase() !== o.agent.toLowerCase()) txs.push(await this.call(`${k.toUpperCase()} agent`, v.address, "setAgent", [o.agent]));
      if (g && st.guardian.toLowerCase() !== g.toLowerCase()) txs.push(await this.call(`${k.toUpperCase()} guardian`, v.address, "setGuardian", [g]));
      out.push({ market: id, vault: v.address, adapter: a.address });
    }
    return { vaults: out, txs };
  }

  /**
   * Testnet only: put ~$150 of tUSDT and ~$50 of the price token (at the adapter price) into each vault. The token
   * deployer mints directly; any other owner key uses the public faucet() (once per hour per address) and transfers.
   */
  async seed(vaults: { market: string; vault: Address }[]): Promise<{ label: string; hash: Hex }[]> {
    if (this.dep.chainId !== 133) throw new OwnerError(403, "seeding with test tokens is testnet only");
    const txs: { label: string; hash: Hex }[] = [];
    const give = async (token: Address, to: Address, amount: bigint, label: string) => {
      const tokOwner = (await this.pub.readContract({ address: token, abi: erc20, functionName: "owner" })) as Address;
      if (tokOwner.toLowerCase() === this.address.toLowerCase()) {
        txs.push(await this.send(label, token, encodeFunctionData({ abi: erc20, functionName: "mint", args: [to, amount] })));
        return;
      }
      const bal = (await this.pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [this.address] })) as bigint;
      if (bal < amount) txs.push(await this.send(`faucet for ${label}`, token, encodeFunctionData({ abi: erc20, functionName: "faucet" })));
      txs.push(await this.send(label, token, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] })));
    };
    for (const v of vaults) {
      const m = this.dep.markets[v.market];
      if (!m) continue;
      const name = v.market.includes("WBTC") ? "BTC" : "HSK";
      await give(m.quoteToken as Address, v.vault, 150n * 10n ** 6n, `tUSDT into ${name} vault`);
      const oracle = (await this.pub.readContract({ address: v.vault, abi: policyVaultAbi, functionName: "oracle" as never })) as Address;
      const [, answer] = (await this.pub.readContract({ address: oracle, abi: adapterAbi, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
      const dec = Number(await this.pub.readContract({ address: m.priceToken as Address, abi: erc20, functionName: "decimals" }));
      if (answer > 0n) await give(m.priceToken as Address, v.vault, (50n * 10n ** 8n * 10n ** BigInt(dec)) / answer, `price token into ${name} vault`);
    }
    return txs;
  }
}

/** deployments/<chainId>.json: $ATE_DEPLOYMENTS (when its chain matches), cwd, then up from this module. */
export function loadDeployment(chainId: number, env: NodeJS.ProcessEnv = process.env): Deployment {
  const f = `deployments/${chainId}.json`;
  const cands = [env.ATE_DEPLOYMENTS, join(process.cwd(), f)];
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    cands.push(join(d, f));
    d = dirname(d);
  }
  for (const p of cands) {
    if (!p || !existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, "utf8")) as Deployment;
    if (j.chainId === chainId) return j;
  }
  throw new OwnerError(500, `${f} not found`);
}
