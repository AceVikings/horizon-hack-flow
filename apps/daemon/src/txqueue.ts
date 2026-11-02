// Single signer TxQueue (§7.1, T19). Depth-1: at most one agent-key tx in flight. Priority at every nonce:
// pause > guard exits > executes > oracle refresh > attests. Unmined after 20 s → replaced at the same nonce
// with fees max(original × 1.25, suggested). A pause/exit arriving while an execute/refresh/attest is pending
// replaces it at its nonce; if the displaced tx mines first, the pause/exit is re-signed at the next nonce.

import { AteError, type Address, type Hex } from "@ate/core";
import type { PrivateKeyAccount, TransactionReceipt } from "viem";

export type TxPriority = "pause" | "exit" | "execute" | "refresh" | "attest" | "rogue";
export const PRIORITY_RANK: Record<TxPriority, number> = { pause: 0, exit: 1, execute: 2, rogue: 2, refresh: 3, attest: 4 };

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface TxChain {
  pendingNonce(addr: Address): Promise<number>;
  suggestFees(): Promise<Fees>;
  sendRaw(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<TransactionReceipt | null>;
  estimateGas?(tx: { from: Address; to: Address; data: Hex; value?: bigint }): Promise<bigint>;
}

export interface TxJob {
  priority: TxPriority;
  to: Address;
  data: Hex;
  value?: bigint;
  /** Fixed gas limit (rogue route uses this to land reverts on-chain). */
  gas?: bigint;
  label?: string;
  /** For displaced executes: re-queue only while the proposal is still valid (§7.1). */
  stillValid?: () => boolean;
}

export interface TxHandle {
  id: number;
  submitted: Promise<Hex>;
  mined: Promise<TransactionReceipt>;
}

interface Entry {
  id: number;
  seq: number;
  job: TxJob;
  submittedDone: boolean;
  resolveSubmitted: (h: Hex) => void;
  resolveMined: (r: TransactionReceipt) => void;
  reject: (e: unknown) => void;
}

interface InFlight {
  entry: Entry;
  nonce: number;
  gas: bigint;
  fees: Fees;
  hashes: Hex[];
  sentAt: number;
  displaced?: { entry: Entry; hashes: Hex[] };
}

export interface TxQueueOptions {
  chain: TxChain;
  account: () => PrivateKeyAccount;
  chainId: number;
  replaceAfterMs?: number;
  pollMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
  /** Called for every broadcast (incl. replacements) — for journalling/events. */
  onBroadcast?: (e: { id: number; label?: string; priority: TxPriority; nonce: number; hash: Hex; replacement: boolean }) => void;
}

const bump = (x: bigint) => (x * 125n + 99n) / 100n;
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);
const isNonceErr = (e: unknown) => /nonce too low|nonce has already been used|already known|replacement transaction underpriced|invalid nonce|nonce.*(low|high)/i.test(String((e as Error)?.message ?? e));

export class TxQueue {
  private queue: Entry[] = [];
  private inflight: InFlight | null = null;
  private nonce: number | null = null;
  private ids = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly replaceAfterMs: number;
  private readonly now: () => number;

  constructor(private readonly o: TxQueueOptions) {
    this.replaceAfterMs = o.replaceAfterMs ?? 20_000;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), this.o.pollMs ?? 1000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get depth(): { queued: number; inflight: boolean; nonce: number | null } {
    return { queued: this.queue.length, inflight: !!this.inflight, nonce: this.nonce };
  }

  enqueue(job: TxJob): TxHandle {
    const id = ++this.ids;
    let resolveSubmitted!: (h: Hex) => void;
    let resolveMined!: (r: TransactionReceipt) => void;
    let rejectS!: (e: unknown) => void;
    let rejectM!: (e: unknown) => void;
    const submitted = new Promise<Hex>((res, rej) => ((resolveSubmitted = res), (rejectS = rej)));
    const mined = new Promise<TransactionReceipt>((res, rej) => ((resolveMined = res), (rejectM = rej)));
    submitted.catch(() => {});
    mined.catch(() => {});
    const entry: Entry = {
      id,
      seq: ++this.seq,
      job,
      submittedDone: false,
      resolveSubmitted: (h) => {
        if (!entry.submittedDone) {
          entry.submittedDone = true;
          resolveSubmitted(h);
        }
      },
      resolveMined,
      reject: (e) => {
        rejectS(e);
        rejectM(e);
      },
    };
    this.queue.push(entry);
    void this.tick();
    return { id, submitted, mined };
  }

  private pickNext(): Entry | undefined {
    if (!this.queue.length) return undefined;
    this.queue.sort((a, b) => PRIORITY_RANK[a.job.priority] - PRIORITY_RANK[b.job.priority] || a.seq - b.seq);
    return this.queue[0];
  }

  private async sign(job: TxJob, nonce: number, gas: bigint, fees: Fees): Promise<Hex> {
    const acct = this.o.account();
    return (await acct.signTransaction({
      chainId: this.o.chainId,
      type: "eip1559",
      nonce,
      to: job.to,
      data: job.data,
      value: job.value ?? 0n,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })) as Hex;
  }

  private async gasFor(job: TxJob): Promise<bigint> {
    if (job.gas) return job.gas;
    if (this.o.chain.estimateGas) {
      try {
        const g = await this.o.chain.estimateGas({ from: this.o.account().address, to: job.to, data: job.data, value: job.value });
        return (g * 13n) / 10n + 20_000n;
      } catch {
        /* reverting estimate: fall back to a fixed limit; pre-flight already decided to send */
      }
    }
    return job.priority === "pause" ? 120_000n : 700_000n;
  }

  private async syncNonce(): Promise<number> {
    this.nonce = await this.o.chain.pendingNonce(this.o.account().address);
    return this.nonce;
  }

  private current: Promise<void> | null = null;
  private again = false;

  /** One scheduling pass; serialised (a call during a pass schedules one more pass). Exposed for tests. */
  tick(): Promise<void> {
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      do {
        this.again = false;
        try {
          await this.step();
        } catch (e) {
          this.o.log?.(`txqueue: ${(e as Error).message}`);
        }
      } while (this.again);
    })().finally(() => (this.current = null));
    return this.current;
  }

  private async step(): Promise<void> {
    const f = this.inflight;
    if (f) {
      // 1. Displaced tx mined first? → it wins this nonce; the pre-empting job is re-signed at the next nonce.
      if (f.displaced) {
        for (const h of f.displaced.hashes) {
          const r = await this.o.chain.receipt(h);
          if (r) {
            f.displaced.entry.resolveSubmitted(h);
            f.displaced.entry.resolveMined(r);
            this.queue = this.queue.filter((e) => e !== f.displaced!.entry);
            this.queue.unshift(f.entry);
            this.nonce = f.nonce + 1;
            this.inflight = null;
            return this.step();
          }
        }
      }
      for (const h of [...f.hashes].reverse()) {
        const r = await this.o.chain.receipt(h);
        if (r) {
          f.entry.resolveSubmitted(h);
          f.entry.resolveMined(r);
          this.nonce = f.nonce + 1;
          this.inflight = null;
          return this.step();
        }
      }
      // 2. Pre-emption: pause/exit replaces a pending execute/refresh/attest at its nonce.
      const next = this.pickNext();
      if (next && !f.displaced && PRIORITY_RANK[next.job.priority] <= 1 && PRIORITY_RANK[f.entry.job.priority] >= 2) {
        const sug = await this.o.chain.suggestFees();
        const fees = { maxFeePerGas: maxB(bump(f.fees.maxFeePerGas), sug.maxFeePerGas), maxPriorityFeePerGas: maxB(bump(f.fees.maxPriorityFeePerGas), sug.maxPriorityFeePerGas) };
        const gas = await this.gasFor(next.job);
        const raw = await this.sign(next.job, f.nonce, gas, fees);
        try {
          const h = await this.o.chain.sendRaw(raw);
          this.queue = this.queue.filter((e) => e !== next);
          const old = f.entry;
          // Displaced: re-queue only if still valid (attests always re-queue).
          if (old.job.priority === "attest" || !old.job.stillValid || old.job.stillValid()) this.queue.push(old);
          else old.reject(new AteError("ProposalError", "ATE_STRATEGY_BLOCKED", "displaced by a pause/guard exit; proposal no longer valid"));
          this.inflight = { entry: next, nonce: f.nonce, gas, fees, hashes: [h], sentAt: this.now(), displaced: { entry: old, hashes: f.hashes } };
          next.resolveSubmitted(h);
          this.o.onBroadcast?.({ id: next.id, label: next.job.label, priority: next.job.priority, nonce: f.nonce, hash: h, replacement: true });
        } catch (e) {
          if (!isNonceErr(e)) this.o.log?.(`txqueue preempt send failed: ${(e as Error).message}`);
          // nonce too low → displaced mined; the next tick sees its receipt.
        }
        return;
      }
      // 3. Stuck → same-nonce replacement with bumped fees (identical body).
      if (this.now() - f.sentAt >= this.replaceAfterMs) {
        const sug = await this.o.chain.suggestFees();
        const fees = { maxFeePerGas: maxB(bump(f.fees.maxFeePerGas), sug.maxFeePerGas), maxPriorityFeePerGas: maxB(bump(f.fees.maxPriorityFeePerGas), sug.maxPriorityFeePerGas) };
        const raw = await this.sign(f.entry.job, f.nonce, f.gas, fees);
        try {
          const h = await this.o.chain.sendRaw(raw);
          f.hashes.push(h);
          f.fees = fees;
          f.sentAt = this.now();
          this.o.onBroadcast?.({ id: f.entry.id, label: f.entry.job.label, priority: f.entry.job.priority, nonce: f.nonce, hash: h, replacement: true });
        } catch (e) {
          f.sentAt = this.now();
          this.o.log?.(`txqueue replacement failed: ${(e as Error).message}`);
        }
      }
      return;
    }

    // 4. Idle → send the best queued job at the next nonce.
    const e = this.pickNext();
    if (!e) return;
    this.queue.shift();
    if (e.job.stillValid && !e.job.stillValid()) {
      e.reject(new AteError("ProposalError", "ATE_STRATEGY_BLOCKED", "proposal no longer valid at send time"));
      return this.step();
    }
    let nonce: number;
    try {
      nonce = this.nonce ?? (await this.syncNonce());
    } catch (err) {
      this.queue.unshift(e);
      throw err;
    }
    let raw: Hex;
    let gas: bigint;
    let fees: Fees;
    try {
      gas = await this.gasFor(e.job);
      fees = await this.o.chain.suggestFees();
      raw = await this.sign(e.job, nonce, gas, fees);
    } catch (err) {
      e.reject(err);
      return;
    }
    try {
      const h = await this.o.chain.sendRaw(raw);
      this.inflight = { entry: e, nonce, gas, fees, hashes: [h], sentAt: this.now() };
      e.resolveSubmitted(h);
      this.o.onBroadcast?.({ id: e.id, label: e.job.label, priority: e.job.priority, nonce, hash: h, replacement: false });
    } catch (err) {
      if (isNonceErr(err)) {
        await this.syncNonce().catch(() => (this.nonce = null));
        this.queue.unshift(e);
      } else {
        e.reject(err);
      }
    }
  }
}

/** viem-backed TxChain. */
export function viemTxChain(client: {
  getTransactionCount(a: { address: Address; blockTag: "pending" }): Promise<number>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }>;
  sendRawTransaction(a: { serializedTransaction: Hex }): Promise<Hex>;
  getTransactionReceipt(a: { hash: Hex }): Promise<TransactionReceipt>;
  estimateGas(a: { account: Address; to: Address; data: Hex; value?: bigint }): Promise<bigint>;
}): TxChain {
  return {
    pendingNonce: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
    suggestFees: async () => {
      const f = await client.estimateFeesPerGas();
      const prio = f.maxPriorityFeePerGas ?? 1_000_000n;
      return { maxFeePerGas: f.maxFeePerGas ?? f.gasPrice ?? 1_000_000_000n, maxPriorityFeePerGas: prio };
    },
    sendRaw: (raw) => client.sendRawTransaction({ serializedTransaction: raw }),
    receipt: async (hash) => {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch {
        return null;
      }
    },
    estimateGas: (tx) => client.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: tx.value }),
  };
}
