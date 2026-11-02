import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { GENESIS_PREV_HASH } from "@ate/core";
import { migrate } from "../src/index.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
});

const insert = (id: string, prev: string, hash: string) =>
  db.prepare("INSERT INTO decisions (id, at, kind, ref_id, record, prev_hash, hash) VALUES (?, 1, 'no_trade', NULL, '{}', ?, ?)").run(id, prev, hash);

describe("001_init.sql", () => {
  it("applies once and records schema_version", () => {
    expect(migrate(db)).toEqual([1]);
    expect(migrate(db)).toEqual([]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["agents", "vaults", "limits", "strategy", "proposals", "executions", "candidates", "fills", "lots", "payments", "decisions", "chat_messages", "settings", "events", "schema_version"]),
    );
  });

  it("decisions are append-only", () => {
    migrate(db);
    insert("dec_0000000000000001", GENESIS_PREV_HASH, "0x01");
    expect(() => db.prepare("UPDATE decisions SET record = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM decisions").run()).toThrow(/append-only/);
  });

  it("UNIQUE(prev_hash) forbids forks; hash and id are unique", () => {
    migrate(db);
    insert("dec_0000000000000001", GENESIS_PREV_HASH, "0x01");
    expect(() => insert("dec_0000000000000002", GENESIS_PREV_HASH, "0x02")).toThrow(/UNIQUE/);
    insert("dec_0000000000000002", "0x01", "0x02");
    expect(() => insert("dec_0000000000000003", "0x02", "0x02")).toThrow(/UNIQUE/);
  });

  it("vault market is unique (one row per market)", () => {
    migrate(db);
    const v = db.prepare("INSERT INTO vaults (address, market, agent_id, price_token, price_decimals, oracle, pool, deployed_block) VALUES (?, ?, NULL, 'p', 8, 'o', 'pl', 1)");
    v.run("0xa", "hsk-dex:WBTC/USDT:3000");
    expect(() => v.run("0xb", "hsk-dex:WBTC/USDT:3000")).toThrow(/UNIQUE/);
  });
});
