// A market can switch to a new vault (Wallet → Use this vault). The book, P&L seed and open proposals follow the
// active vault; the earlier vault's trades stay in the journal but never mix into the new vault's position.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "@ate/core/fixtures";
import { MARKETS, type AteConfig, type MarketId } from "@ate/core";
import { createChainClient } from "@ate/chain";
import { Journal, migrate } from "@ate/journal";
import { AgentSigner } from "@ate/wallet";
import { AteService } from "../src/service.js";
import { loadStrategy } from "../src/strategy-stub.js";
import { TxQueue } from "../src/txqueue.js";

const BTC = "hsk-dex:WBTC/USDT:3000" as MarketId;
const OLD = FIXTURE_CONFIG.vaults.find((v) => v.market === BTC)!.address;
const NEW = "0x00000000000000000000000000000000000000B2";

async function service(db: Database.Database, btcVault: string) {
  const cfg = structuredClone(FIXTURE_CONFIG) as AteConfig;
  cfg.vaults = cfg.vaults.map((v) => (v.market === BTC ? { ...v, address: btcVault as `0x${string}` } : v));
  const signer = new AgentSigner(cfg.agentKeyId);
  const txq = new TxQueue({ chain: { pendingNonce: async () => 0, suggestFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), sendRaw: async () => "0x" as const, receipt: async () => null }, account: () => signer.get(), chainId: 177 });
  let svc: AteService | null = null;
  const strategy = await loadStrategy(() => svc!.openProposals(), { forceStub: true });
  svc = new AteService({ cfg, db, journal: new Journal(db), chain: createChainClient({ urls: ["http://127.0.0.1:9"], retries: 0 }), signer, txq, strategy, candidateTtlSec: 180, version: "test" });
  return svc;
}

function trade(db: Database.Database, id: string, vault: string, side: "buy" | "sell", baseQty: string, quoteQty: string, status = "executed") {
  const s = MARKETS[BTC];
  db.prepare("INSERT OR IGNORE INTO vaults (address, market, agent_id, price_token, price_decimals, oracle, pool, deployed_block) VALUES (?, ?, NULL, ?, ?, ?, ?, 0)").run(vault, BTC, s.baseToken, s.baseDecimals, s.oracle, s.pool);
  db.prepare(
    "INSERT INTO proposals (id, market, vault, side, token_in, amount_in, min_amount_out, rationale, rationale_hash, origin, journal_hash, oracle_price, oracle_updated_at, pool_price, policy_reason, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, '0', 'r', '0x', 'human', '0x', '0', 0, '0', 0, ?, 1, 9999999999)",
  ).run(id, BTC, vault, side, s.quoteToken, quoteQty, status);
  if (status !== "executed") return;
  db.prepare("INSERT INTO executions (id, proposal_id, status, created_at) VALUES (?, ?, 'confirmed', 1)").run(`ex_${id}`, id);
  db.prepare("INSERT INTO fills (id, execution_id, market, generator, side, base_qty, quote_qty, price, at) VALUES (?, ?, ?, 'human', ?, ?, ?, '0', 1)").run(`f_${id}`, `ex_${id}`, BTC, side, baseQty, quoteQty);
}

describe("switching a market's vault", () => {
  it("the book follows the active vault, and switching back restores the old one", async () => {
    const db = new Database(":memory:");
    migrate(db);
    trade(db, "p1", OLD, "buy", "100000", "50000000"); // 0.001 BTC for $50 in the old vault
    const a = await service(db, OLD);
    expect(a.book(BTC).qty).toBe(100000n);
    const b = await service(db, NEW);
    expect(b.book(BTC).qty).toBe(0n);
    trade(db, "p2", NEW, "buy", "4000", "2000000"); // $2 buy in the new vault
    expect(b.book(BTC).qty).toBe(4000n);
    expect(b.book(BTC).costE8).toBe(200000000n);
    const back = await service(db, OLD);
    expect(back.book(BTC).qty).toBe(100000n);
    // both vault rows exist (journal FK), keyed by address
    expect((db.prepare("SELECT COUNT(*) c FROM vaults WHERE market = ?").get(BTC) as { c: number }).c).toBe(2);
  });

  it("open proposals made for another vault are dropped on start", async () => {
    const db = new Database(":memory:");
    migrate(db);
    trade(db, "p3", OLD, "buy", "0", "2000000", "approved");
    await service(db, NEW);
    expect((db.prepare("SELECT status FROM proposals WHERE id = 'p3'").get() as { status: string }).status).toBe("invalidated");
  });

  it("a per-market seed snapshot from before goes to the vault its trades used", async () => {
    const db = new Database(":memory:");
    migrate(db);
    trade(db, "p4", OLD, "buy", "100", "100");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(`seed:${BTC}`, JSON.stringify({ qty: "69974", priceE8: "7774004500000" }));
    const svc = await service(db, NEW);
    const key = (db.prepare("SELECT key FROM settings WHERE key LIKE ?").all(`seed:${BTC}:%`) as { key: string }[]).map((r) => r.key);
    expect(key).toEqual([`seed:${BTC}:${OLD.toLowerCase()}`]);
    expect(svc.book(BTC).qty).toBe(0n); // the new vault has no snapshot yet (taken on its first chain read)
  });
});
