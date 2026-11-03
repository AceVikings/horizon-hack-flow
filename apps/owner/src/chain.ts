// On-chain side of the owner service: reads vault state and sends owner transactions with the owner signer.
// `deploy` is contracts/script/Deploy.s.sol ported to viem: per market a SupraAggregatorAdapter, then the vault
// with oracle = adapter, then setLimits / setAgent / setGuardian. Testnet (133) can also seed the new vaults
// with test tokens (TestToken.mint is owner-only and the owner key is the token deployer).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, getContractAddress, http, keccak256, parseAbi, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
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
const erc20 = parseAbi(["function mint(address to, uint256 amount)", "function faucet()", "function faucetAmount() view returns (uint256)", "function lastFaucetAt(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)", "function owner() view returns (address)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
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

/** One on-chain step of a vault creation, for live progress. */
export interface JobStep {
  id: string;
  market: string;
  /** deploy = price adapter + vault; limits; agent = agent + guardian; seed = test tokens (testnet). */
  group: "deploy" | "limits" | "agent" | "seed";
  label: string;
  state: "waiting" | "sent" | "done" | "skipped" | "failed";
  hash?: Hex;
  sentAt?: number;
  doneAt?: number;
  error?: string;
}

/** A market's contracts from a vault creation that has not finished (resumed on the next attempt). */
export interface Partial_ {
  market: string;
  vault?: Address;
  adapter?: Address;
  /** Transactions sent and not yet confirmed. */
  pending?: Hex[];
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
    // JSON-RPC batching: the parallel reads and receipt polls of a vault creation go out as one HTTP request.
    this.pub = createPublicClient({ chain, transport: http(undefined, { batch: { wait: 10 } }), pollingInterval: 1000 }) as PublicClient;
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

  /**
   * Deploy.s.sol `_deployOne` for each market, pipelined: every transaction is signed locally with the next nonce and
   * sent without waiting for the one before (contract addresses follow from sender + nonce, so the vault can name its
   * price adapter and the settings can name the vault before either is mined). Then every receipt is awaited and the
   * result is read back from the chain (code, owner, oracle, limits, agent, guardian) before it counts as done.
   * Resumable: contracts from an interrupted run (`prior`) are reused when they have code, settings already on the
   * vault are skipped, and transactions still in flight from that run are settled first.
   */
  async deploy(o: {
    markets: ("hsk" | "btc")[];
    agent: Address;
    guardian?: Address;
    limits: VaultLimits;
    env?: NodeJS.ProcessEnv;
    /** Testnet: also put test tokens into each new vault, in the same batch. */
    seed?: boolean;
    /** Contracts from an interrupted deploy (resumed instead of redeployed). */
    prior?: Partial_[];
    onStep?: (p: Partial_) => void;
    onProgress?: (steps: JobStep[]) => void;
  }): Promise<{ vaults: { market: string; vault: Address; adapter: Address }[]; txs: { label: string; hash: Hex }[]; seedError?: string; steps: JobStep[] }> {
    const vaultCode = artifact("PolicyVault", o.env);
    const adapterCode = artifact("SupraAggregatorAdapter", o.env);
    const g = o.guardian ?? (this.dep.guardian as Address);
    const steps: JobStep[] = [];
    const emit = () => o.onProgress?.(steps.map((x) => ({ ...x })));
    const now = () => Date.now();

    // 0. Transactions an interrupted run left in flight: let them land (or be dropped) before reading the chain.
    const inflight = (o.prior ?? []).flatMap((p) => p.pending ?? []);
    if (inflight.length) await Promise.all(inflight.map((h) => this.settle(h)));

    // 1. One round of reads: nonce, fees, prior contracts, token owners and balances, the market price.
    const ids = o.markets.map((k) => {
      const id = MARKET_OF[k];
      const m = this.dep.markets[id];
      if (!m) throw new OwnerError(400, `no ${id} in deployments/${this.dep.chainId}.json`);
      return { k, id, m };
    });
    const seed = !!o.seed && this.dep.chainId === 133;
    const [chainNonce, fees, ...pre] = await Promise.all([
      this.pub.getTransactionCount({ address: this.address, blockTag: "pending" }),
      this.pub.estimateFeesPerGas().catch(async () => ({ maxFeePerGas: (await this.pub.getGasPrice()) * 2n, maxPriorityFeePerGas: 1_000_000n })),
      ...ids.map(async ({ id, m }) => {
        const prior = o.prior?.find((p) => p.market === id);
        const [adapterLive, vaultLive] = await Promise.all([prior?.adapter ? this.hasCode(prior.adapter) : false, prior?.vault ? this.hasCode(prior.vault) : false]);
        const st = vaultLive ? await this.vault(prior!.vault!, id) : null;
        if (st && st.owner.toLowerCase() !== this.address.toLowerCase()) throw new OwnerError(409, `${prior!.vault} from the earlier attempt is not owned by this wallet`);
        const oracle = st ? ((await this.pub.readContract({ address: st.address, abi: policyVaultAbi, functionName: "oracle" as never })) as Address) : null;
        const [answer, dec] = seed
          ? await Promise.all([
              this.pub.readContract({ address: (oracle ?? (m.adapter as Address)) as Address, abi: adapterAbi, functionName: "latestRoundData" }).then((r) => (r as readonly bigint[])[1]!),
              this.pub.readContract({ address: m.priceToken as Address, abi: erc20, functionName: "decimals" }).then(Number),
            ])
          : [0n, 0];
        const held = seed && st ? await Promise.all([this.erc20Balance(m.quoteToken as Address, st.address), this.erc20Balance(m.priceToken as Address, st.address)]) : [0n, 0n];
        return { prior, adapter: oracle ?? (adapterLive ? prior!.adapter! : null), st, answer: answer as bigint, dec: dec as number, held };
      }),
    ]);
    const tokens = seed ? [...new Set(ids.flatMap(({ m }) => [m.quoteToken, m.priceToken]).map((t) => t.toLowerCase() as Address))] : [];
    const tokInfo = new Map(
      await Promise.all(
        tokens.map(async (t) => {
          const [owner, bal, faucetAmount, last] = await Promise.all([
            this.pub.readContract({ address: t, abi: erc20, functionName: "owner" }) as Promise<Address>,
            this.erc20Balance(t, this.address),
            this.pub.readContract({ address: t, abi: erc20, functionName: "faucetAmount" }).catch(() => 0n) as Promise<bigint>,
            this.pub.readContract({ address: t, abi: erc20, functionName: "lastFaucetAt", args: [this.address] }).catch(() => 0n) as Promise<bigint>,
          ]);
          return [t, { mint: owner.toLowerCase() === this.address.toLowerCase(), bal, faucetAmount, faucetOk: last === 0n || BigInt(Math.floor(Date.now() / 1000)) >= last + 3600n }] as [Address, { mint: boolean; bal: bigint; faucetAmount: bigint; faucetOk: boolean }];
        }),
      ),
    );

    // 2. Plan every transaction with its nonce. Gas: estimated where the chain can already run it, else a fixed
    // ceiling well above what these calls use (adapter 0.43M, vault 3.06M, limits 0.12M, agent/guardian 0.05M).
    let nonce = Math.max(chainNonce, this.nonce ?? 0);
    type Tx = { step: JobStep; to: Address | null; data: Hex; gas: bigint | Promise<bigint>; nonce: number; critical: boolean };
    const plan: Tx[] = [];
    const out: { market: string; vault: Address; adapter: Address }[] = [];
    const add = (market: string, group: JobStep["group"], label: string, to: Address | null, data: Hex, gas: bigint | Promise<bigint>, critical = true) => {
      const step: JobStep = { id: `${market}:${label}`, market, group, label, state: "waiting" };
      steps.push(step);
      plan.push({ step, to, data, gas, nonce: nonce++, critical });
    };
    const est = (p: { to?: Address; data: Hex }, fallback: bigint) =>
      this.pub
        .estimateGas({ account: this.address, ...(p.to ? { to: p.to } : {}), data: p.data } as never)
        .then((x) => (x * 13n) / 10n)
        .catch(() => fallback);
    const later: (() => void)[] = [];
    const sym = (a: string) => Object.values((this.dep.tokens ?? {}) as Record<string, { address: string; symbol: string }>).find((t) => t.address.toLowerCase() === a.toLowerCase())?.symbol ?? "tokens";
    const skip = (market: string, group: JobStep["group"], label: string) => steps.push({ id: `${market}:${label}`, market, group, label, state: "skipped" });
    ids.forEach(({ k, id, m }, i) => {
      const r = pre[i] as Awaited<(typeof pre)[number]>;
      const name = k === "hsk" ? "HSK" : "BTC";
      const desc = `${name}/USD (Supra pair ${m.supraPair})`;
      let adapter = r.adapter;
      if (!adapter) {
        adapter = getContractAddress({ from: this.address, nonce: BigInt(nonce) });
        const data = `${adapterCode}${encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "string" }], [this.dep.supra.storage as Address, BigInt(m.supraPair), desc]).slice(2)}` as Hex;
        add(id, "deploy", `${name} price adapter`, null, data, est({ data }, 700_000n));
      } else skip(id, "deploy", `${name} price adapter`);
      let vault = r.st?.address ?? null;
      if (!vault) {
        vault = getContractAddress({ from: this.address, nonce: BigInt(nonce) });
        const enc = (oracle: Address) => `${vaultCode}${encodeAbiParameters(Array.from({ length: 6 }, () => ({ type: "address" })), [m.quoteToken, m.priceToken, oracle, this.dep.hskdex.router, m.pool, this.dep.hskdex.factory] as Address[]).slice(2)}` as Hex;
        // The constructor reads the oracle's decimals(): estimate against the deployment's live adapter for this pair.
        add(id, "deploy", `${name} vault`, null, enc(adapter), est({ data: enc((r.adapter ?? m.adapter) as Address) }, 4_200_000n));
      } else skip(id, "deploy", `${name} vault`);
      const st = r.st;
      const sameLimits = !!st && (Object.keys(o.limits) as (keyof VaultLimits)[]).every((f) => BigInt(st.limits[f]) === BigInt(o.limits[f]));
      const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: policyVaultAbi, functionName: fn as never, args: args as never });
      if (!sameLimits) add(id, "limits", `${name} limits`, vault, call("setLimits", [o.limits]), st ? est({ to: vault, data: call("setLimits", [o.limits]) }, 300_000n) : 300_000n);
      else skip(id, "limits", `${name} limits`);
      if (!st || st.agent.toLowerCase() !== o.agent.toLowerCase()) add(id, "agent", `${name} agent`, vault, call("setAgent", [o.agent]), 150_000n);
      else skip(id, "agent", `${name} agent`);
      if (g && (!st || st.guardian.toLowerCase() !== g.toLowerCase())) add(id, "agent", `${name} guardian`, vault, call("setGuardian", [g]), 150_000n);
      if (seed) later.push(() => {
        // ~$150 of tUSDT and ~$50 of the price token at the oracle price; a resumed vault that already holds them is skipped.
        const give = (token: Address, amount: bigint, have: bigint, label: string) => {
          if (amount === 0n || have >= amount) return skip(id, "seed", label);
          const t = tokInfo.get(token.toLowerCase() as Address)!;
          if (t.mint) return add(id, "seed", label, token, encodeFunctionData({ abi: erc20, functionName: "mint", args: [vault!, amount] }), 150_000n, false);
          if (t.bal < amount && t.faucetOk && t.faucetAmount > 0n) {
            add(id, "seed", `faucet for ${label}`, token, encodeFunctionData({ abi: erc20, functionName: "faucet" }), 200_000n, false);
            t.bal += t.faucetAmount;
            t.faucetOk = false;
          }
          if (t.bal < amount) return steps.push({ id: `${id}:${label}`, market: id, group: "seed", label, state: "failed", error: "this wallet has too few test tokens and the token faucet allows one claim an hour" });
          t.bal -= amount;
          add(id, "seed", label, token, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [vault!, amount] }), 150_000n, false);
        };
        give(m.quoteToken as Address, 150n * 10n ** 6n, r.held[0]!, `tUSDT into ${name} vault`);
        give(m.priceToken as Address, r.answer > 0n ? (50n * 10n ** 8n * 10n ** BigInt(r.dec)) / r.answer : 0n, r.held[1]!, `${sym(m.priceToken)} into ${name} vault`);
      });
      out.push({ market: id, vault, adapter });
      o.onStep?.({ market: id, adapter, vault, pending: [] });
    });
    // Test tokens take the nonces after every contract and setting: they are sent only once the vaults exist.
    for (const f of later) f();
    emit();

    // 3. Sign locally and send back to back. A send that fails stops the batch (later nonces would wait on it).
    const gases = await Promise.all(plan.map((t) => t.gas));
    const sent: { t: Tx; hash: Hex; raw: Hex; landed: Promise<void> }[] = [];
    let sendError: Error | null = null;
    const sendAll = async (list: Tx[]) => {
      for (const t of list) {
        if (sendError) {
          Object.assign(t.step, { state: "failed", error: "not sent" });
          continue;
        }
        try {
          const raw = (await this.account.signTransaction!({
            chainId: this.dep.chainId,
            type: "eip1559",
            nonce: t.nonce,
            ...(t.to ? { to: t.to } : {}),
            data: t.data,
            value: 0n,
            gas: gases[plan.indexOf(t)]!,
            maxFeePerGas: fees.maxFeePerGas!,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
          } as never)) as Hex;
          const hash = keccak256(raw);
          this.raws.set(hash, raw);
          await this.pub.sendRawTransaction({ serializedTransaction: raw }).catch((e: Error) => {
            if (!/already known/i.test(e.message)) throw e;
          });
          this.nonce = t.nonce + 1;
          Object.assign(t.step, { state: "sent", hash, sentAt: now() });
          // 4. Its receipt, polled at once (re-broadcast if a node dropped it).
          const landed = this.receipt(t.step.label, hash, raw)
            .then((r) => void Object.assign(t.step, r.status === "success" ? { state: "done", doneAt: now() } : { state: "failed", doneAt: now(), error: "reverted" }))
            .catch((e: Error) => void Object.assign(t.step, { state: "failed", error: e.message.split("\n")[0] }))
            .finally(emit);
          sent.push({ t, hash, raw, landed });
          const v = out.find((x) => x.market === t.step.market)!;
          o.onStep?.({ market: v.market, adapter: v.adapter, vault: v.vault, pending: sent.filter((x) => x.t.step.market === v.market).map((x) => x.hash) });
          emit();
        } catch (e) {
          sendError = e as Error;
          this.nonce = null; // resync from the chain next time
          Object.assign(t.step, { state: "failed", error: (e as Error).message.split("\n")[0] });
          emit();
        }
      }
    };
    await sendAll(plan.filter((t) => t.critical));
    const tokensTx = plan.filter((t) => !t.critical);
    if (tokensTx.length) {
      // Only into vaults that exist: wait for the contract creations (and their settings) first.
      await Promise.all(sent.map((x) => x.landed));
      if (sent.some((x) => x.t.step.state !== "done")) for (const t of tokensTx) Object.assign(t.step, { state: "failed", error: "not sent: a vault step failed" });
      else await sendAll(tokensTx);
    }
    await Promise.all(sent.map((x) => x.landed));
    emit();
    const txs = sent.filter((x) => x.t.step.state === "done").map((x) => ({ label: x.t.step.label, hash: x.hash }));
    const bad = steps.filter((x) => x.state === "failed" && plan.find((p) => p.step === x)?.critical);
    for (const v of out) o.onStep?.({ market: v.market, adapter: v.adapter, vault: v.vault, pending: [] });
    if (sendError || bad.length) {
      const first = bad[0];
      throw new OwnerError(502, `${first ? `${first.label}: ${first.error ?? "failed"}` : sendError!.message.split("\n")[0]}. Nothing is lost: start again to continue where it stopped.`);
    }

    // 5. Read the result back: code at both contracts, and the vault's owner, oracle, limits, agent and guardian.
    await Promise.all(
      out.map(async (v) => {
        await Promise.all([this.codeAt(v.adapter), this.codeAt(v.vault)]);
        const [st, oracle] = await Promise.all([this.vault(v.vault, v.market), this.pub.readContract({ address: v.vault, abi: policyVaultAbi, functionName: "oracle" as never }) as Promise<Address>]);
        const lim = (Object.keys(o.limits) as (keyof VaultLimits)[]).every((f) => BigInt(st.limits[f]) === BigInt(o.limits[f]));
        const problems = [
          st.owner.toLowerCase() !== this.address.toLowerCase() && "owner",
          oracle.toLowerCase() !== v.adapter.toLowerCase() && "price adapter",
          !lim && "limits",
          st.agent.toLowerCase() !== o.agent.toLowerCase() && "agent",
          g && st.guardian.toLowerCase() !== g.toLowerCase() && "guardian",
        ].filter(Boolean);
        if (problems.length) throw new OwnerError(502, `${v.vault}: ${problems.join(", ")} not as expected after the transactions. Start again to fix it.`);
      }),
    );
    const seedBad = steps.filter((x) => x.group === "seed" && x.state === "failed");
    return { vaults: out, txs, steps, ...(seedBad.length ? { seedError: seedBad.map((x) => `${x.label}: ${x.error ?? "failed"}`).join("; ") } : {}) };
  }

  /** What a vault holds (quote + price token, smallest units) and its oracle price (8 dp), for the vault list. */
  async holdings(vault: Address, market: string): Promise<{ tokens: { symbol: string; address: Address; decimals: number; raw: string }[]; priceE8: string | null }> {
    const m = this.dep.markets[market];
    if (!m) return { tokens: [], priceE8: null };
    const toks = (this.dep.tokens ?? {}) as Record<string, { address: string; symbol: string; decimals: number }>;
    const meta = (a: string, fallback: string, dec: number) => {
      const t = Object.values(toks).find((x) => x.address.toLowerCase() === a.toLowerCase());
      return { symbol: t?.symbol ?? fallback, decimals: t?.decimals ?? dec };
    };
    const [q, p, oracle] = await Promise.all([
      this.erc20Balance(m.quoteToken as Address, vault),
      this.erc20Balance(m.priceToken as Address, vault),
      this.pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "oracle" as never }).catch(() => null) as Promise<Address | null>,
    ]);
    const answer = oracle ? await this.pub.readContract({ address: oracle, abi: adapterAbi, functionName: "latestRoundData" }).then((r) => (r as readonly bigint[])[1]!).catch(() => null) : null;
    const base = market.includes("WBTC") ? "WBTC" : "WHSK";
    return {
      tokens: [
        { ...meta(m.quoteToken, "USDT", 6), address: m.quoteToken as Address, raw: q.toString() },
        { ...meta(m.priceToken, base, m.priceDecimals ?? (base === "WBTC" ? 8 : 18)), address: m.priceToken as Address, raw: p.toString() },
      ],
      priceE8: answer === null ? null : answer.toString(),
    };
  }

  /** Signed transactions this process sent (by hash), so a dropped one can be sent again. */
  private raws = new Map<Hex, Hex>();

  private async hasCode(a: Address): Promise<boolean> {
    const c = await this.pub.getCode({ address: a }).catch(() => undefined);
    return !!c && c !== "0x";
  }

  private async erc20Balance(token: Address, who: Address): Promise<bigint> {
    return (await this.pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] })) as bigint;
  }

  /** Polls for the receipt every 700 ms (viem's default here is 4 s); re-broadcasts when no node knows the tx. */
  private async receipt(label: string, hash: Hex, raw?: Hex, budgetMs = 240_000) {
    const until = Date.now() + budgetMs;
    let checks = 0;
    while (Date.now() < until) {
      const r = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (r) return r;
      if (++checks % 20 === 0) {
        const known = await this.pub.getTransaction({ hash }).catch(() => null);
        if (!known && raw) await this.pub.sendRawTransaction({ serializedTransaction: raw }).catch(() => undefined);
      }
      await new Promise((res) => setTimeout(res, 700));
    }
    throw new OwnerError(504, `${label}: not mined after ${Math.round(budgetMs / 1000)} s (${hash})`);
  }

  /** A tx from an interrupted run: wait for it to land, or give up once no node knows it (dropped). */
  private async settle(hash: Hex): Promise<void> {
    const raw = this.raws.get(hash);
    for (let i = 0; i < 90; i++) {
      if (await this.pub.getTransactionReceipt({ hash }).catch(() => null)) return;
      const known = await this.pub.getTransaction({ hash }).catch(() => null);
      if (!known) {
        if (!raw) return;
        await this.pub.sendRawTransaction({ serializedTransaction: raw }).catch(() => undefined);
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
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
