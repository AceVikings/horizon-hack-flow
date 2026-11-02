import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, type TransactionReceipt } from "viem";
import { TxQueue, type TxChain } from "../src/txqueue.js";

const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const VAULT = "0x00000000000000000000000000000000000000aa" as const;

function fakeChain() {
  const sent: { nonce: number; data: string; maxFee: bigint; hash: `0x${string}` }[] = [];
  const mined = new Map<string, TransactionReceipt>();
  let fees = { maxFeePerGas: 1000n, maxPriorityFeePerGas: 10n };
  const chain: TxChain = {
    pendingNonce: async () => 7,
    suggestFees: async () => fees,
    sendRaw: async (raw) => {
      const tx = parseTransaction(raw);
      const hash = keccak256(raw);
      if (sent.some((s) => s.nonce === tx.nonce! && mined.has(s.hash))) throw new Error("nonce too low");
      sent.push({ nonce: tx.nonce!, data: tx.data!, maxFee: tx.maxFeePerGas!, hash });
      return hash;
    },
    receipt: async (h) => mined.get(h) ?? null,
  };
  const mine = (h: `0x${string}`) => mined.set(h, { transactionHash: h, status: "success", blockNumber: 1n, gasUsed: 21000n, logs: [] } as unknown as TransactionReceipt);
  return { chain, sent, mine, setFees: (f: typeof fees) => (fees = f) };
}

describe("TxQueue (§7.1, T19)", () => {
  it("depth-1, priority order pause > exit > execute > attest at every nonce", async () => {
    const f = fakeChain();
    const q = new TxQueue({ chain: f.chain, account: () => acct, chainId: 177 });
    const att = q.enqueue({ priority: "attest", to: VAULT, data: "0x04", gas: 50_000n });
    await att.submitted;
    const ex = q.enqueue({ priority: "execute", to: VAULT, data: "0x03", gas: 50_000n });
    const exit = q.enqueue({ priority: "exit", to: VAULT, data: "0x02", gas: 50_000n });
    await q.tick();
    expect(f.sent).toHaveLength(2); // the exit pre-empted the pending attest at nonce 7
    expect(f.sent[1]).toMatchObject({ nonce: 7, data: "0x02" });
    expect(f.sent[1]!.maxFee).toBe(1250n);
    f.mine(f.sent[1]!.hash);
    await q.tick();
    await exit.mined;
    // next nonce: execute before the re-queued attest
    expect(f.sent[2]).toMatchObject({ nonce: 8, data: "0x03" });
    f.mine(f.sent[2]!.hash);
    await q.tick();
    await ex.mined;
    expect(f.sent[3]).toMatchObject({ nonce: 9, data: "0x04" });
    f.mine(f.sent[3]!.hash);
    await q.tick();
    await att.mined;
    const nonces = f.sent.filter((s) => [...new Set([s.hash])].length).map((s) => s.nonce);
    expect(nonces).toEqual([7, 7, 8, 9]);
  });

  it("stuck tx → same-nonce replacement at max(original × 1.25, suggested) after 20 s", async () => {
    const f = fakeChain();
    let now = 0;
    const q = new TxQueue({ chain: f.chain, account: () => acct, chainId: 177, now: () => now });
    const h = q.enqueue({ priority: "execute", to: VAULT, data: "0x03", gas: 50_000n });
    await h.submitted;
    now = 19_000;
    await q.tick();
    expect(f.sent).toHaveLength(1);
    now = 20_000;
    f.setFees({ maxFeePerGas: 2000n, maxPriorityFeePerGas: 5n });
    await q.tick();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toMatchObject({ nonce: 7, data: "0x03", maxFee: 2000n });
    f.mine(f.sent[0]!.hash); // the original mines
    await q.tick();
    expect((await h.mined).transactionHash).toBe(f.sent[0]!.hash);
  });

  it("displaced tx mined first → pause re-signed at the next nonce", async () => {
    const f = fakeChain();
    const q = new TxQueue({ chain: f.chain, account: () => acct, chainId: 177 });
    const att = q.enqueue({ priority: "attest", to: VAULT, data: "0x04", gas: 50_000n });
    await att.submitted;
    const pause = q.enqueue({ priority: "pause", to: VAULT, data: "0x01", gas: 50_000n });
    await q.tick();
    expect(f.sent[1]).toMatchObject({ nonce: 7, data: "0x01" });
    f.mine(f.sent[0]!.hash); // the attest wins nonce 7
    await q.tick();
    await att.mined;
    expect(f.sent[2]).toMatchObject({ nonce: 8, data: "0x01" });
    f.mine(f.sent[2]!.hash);
    await q.tick();
    expect((await pause.mined).transactionHash).toBe(f.sent[2]!.hash);
  });

  it("a displaced execute whose proposal is no longer valid is dropped", async () => {
    const f = fakeChain();
    const q = new TxQueue({ chain: f.chain, account: () => acct, chainId: 177 });
    let valid = true;
    const ex = q.enqueue({ priority: "execute", to: VAULT, data: "0x03", gas: 50_000n, stillValid: () => valid });
    await ex.submitted;
    valid = false;
    q.enqueue({ priority: "pause", to: VAULT, data: "0x01", gas: 50_000n });
    await q.tick();
    await expect(ex.mined).rejects.toMatchObject({ code: "ATE_STRATEGY_BLOCKED" });
  });
});
