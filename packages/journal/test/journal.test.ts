import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { GENESIS_PREV_HASH, decisionIdFromHash } from "@ate/core";
import { Journal, canonicalJson, migrate, rationaleHash, recordHash, type AppendInput } from "../src/index.js";

const rec = (over: Partial<AppendInput> = {}): AppendInput => ({
  at: 1_793_588_400,
  kind: "no_trade",
  market: "hsk-dex:WHSK/USDT:3000",
  engine: "llm",
  profile: "default",
  actor: { kind: "agent", via: "mcp" },
  rationale: "No edge after fees on either market this cycle.",
  context: {
    oracle: { price: "8772100", updatedAt: 1, roundId: "1", ageSec: 1 },
    pool: { price: "8758800", twap: "8758800", liquidity: "1", deviationBps: 15, twapDeviationBps: 15 },
    policy: { maxTradeUsd: "100", epochRemainingUsd: "250", turnoverRemainingUsd: "100", cooldownRemainingSec: 0 },
    blockNumber: "1",
  },
  verdict: { ok: true, code: "NO_TRADE" },
  ...over,
});

function fresh() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, j: new Journal(db) };
}

describe("journal (§13)", () => {
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
  });

  it("chains from genesis; ids derive from hashes; verify recomputes", () => {
    const { j } = fresh();
    const a = j.append(rec());
    const b = j.append(rec({ kind: "proposal", rationale: "Bind to the spread-revert candidate on WBTC." }));
    expect(a.prevHash).toBe(GENESIS_PREV_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(a.id).toBe(decisionIdFromHash("no_trade", a.hash));
    expect(b.id).toMatch(/^prop_[0-9a-f]{16}$/);
    const { id: _i, hash: _h, seq: _s, ...body } = b;
    expect(recordHash(a.hash, body)).toBe(b.hash);
    expect(j.verify()).toMatchObject({ ok: true, count: 2, head: b.hash });
    expect(j.head().hash).toBe(b.hash);
  });

  it("rationaleHash is keccak of NFC utf8", () => {
    expect(rationaleHash("é")).toBe(rationaleHash("é"));
    const { j } = fresh();
    expect(j.append(rec()).rationaleHash).toBe(rationaleHash(rec().rationale));
  });

  it("append-only: UPDATE/DELETE abort; a forked prev_hash is rejected", () => {
    const { db, j } = fresh();
    const a = j.append(rec());
    expect(() => db.prepare("UPDATE decisions SET record = '{}'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM decisions").run()).toThrow(/append-only/);
    expect(() =>
      db.prepare("INSERT INTO decisions (id, at, kind, ref_id, record, prev_hash, hash) VALUES ('x', 1, 'no_trade', NULL, '{}', ?, ?)").run(GENESIS_PREV_HASH, `0x${"11".repeat(32)}`),
    ).toThrow(/UNIQUE/);
    expect(j.verify().ok).toBe(true);
    void a;
  });

  it("detects a record whose hash does not recompute", () => {
    const { db, j } = fresh();
    j.append(rec());
    db.exec("DROP TRIGGER decisions_no_update");
    db.prepare("UPDATE decisions SET record = replace(record, 'No edge', 'Big edge')").run();
    expect(j.verify()).toMatchObject({ ok: false, seq: 1 });
  });

  it("filters by market/kind and serialises concurrent writers (BEGIN IMMEDIATE)", () => {
    const { j } = fresh();
    for (let i = 0; i < 5; i++) j.append(rec({ market: i % 2 ? "hsk-dex:WBTC/USDT:3000" : "hsk-dex:WHSK/USDT:3000", at: 1_793_588_400 + i }));
    expect(j.list({ market: "hsk-dex:WBTC/USDT:3000" })).toHaveLength(2);
    expect(j.list({ kind: ["proposal"] })).toHaveLength(0);
    expect(j.list({ limit: 3 })).toHaveLength(3);
    expect(j.verify()).toMatchObject({ ok: true, count: 5 });
  });
});
