// Single-writer, append-only, hash-chained decision journal (§13).
//   hash = keccak256(prevHash ‖ canonical(record without id and hash)); id = kind-prefix + hash[2:18].
// Every append runs inside BEGIN IMMEDIATE (read head, hash, insert, commit). prev_hash UNIQUE forbids forks.

import type Database from "better-sqlite3";
import {
  AteError,
  GENESIS_PREV_HASH,
  decisionIdFromHash,
  type Decision,
  type DecisionKind,
  type DecisionRow,
  type Hex,
  type JournalEntry,
  type MarketId,
} from "@ate/core";
import { concat, hexToBytes, keccak256, toBytes, type Hex as VHex } from "viem";

/** RFC 8785 (JCS) canonical JSON for the value shapes the journal stores (strings, finite numbers, bools, null, arrays, objects). */
export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("canonicalJson: non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "bigint") throw new TypeError("canonicalJson: bigint must be a decimal string");
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof v}`);
}

export function recordHash(prevHash: string, record: Omit<Decision, "id">): Hex {
  const body = canonicalJson(record);
  return keccak256(concat([hexToBytes(prevHash as VHex), toBytes(body)])) as Hex;
}

/** rationaleHash = keccak256(utf8(NFC(rationale))) (§7.5). */
export function rationaleHash(rationale: string): Hex {
  return keccak256(toBytes(rationale.normalize("NFC"))) as Hex;
}

export type AppendInput = Omit<Decision, "id" | "prevHash" | "rationaleHash"> & { rationaleHash?: string };

export interface JournalFilter {
  limit?: number;
  market?: MarketId;
  kind?: DecisionKind[];
  since?: number;
  before?: number;
  id?: string;
  refId?: string;
}

interface Row {
  seq: number;
  id: string;
  at: number;
  kind: DecisionKind;
  ref_id: string | null;
  record: string;
  prev_hash: string;
  hash: string;
}

export class Journal {
  private readonly appendTx: (input: AppendInput) => JournalEntry;
  private listeners: ((e: JournalEntry) => void)[] = [];

  constructor(private readonly db: Database.Database) {
    const headStmt = db.prepare("SELECT seq, hash FROM decisions ORDER BY seq DESC LIMIT 1");
    const ins = db.prepare("INSERT INTO decisions (id, at, kind, ref_id, record, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const tx = db.transaction((input: AppendInput): JournalEntry => {
      const head = headStmt.get() as { seq: number; hash: string } | undefined;
      const prevHash = head?.hash ?? GENESIS_PREV_HASH;
      const record: Omit<Decision, "id"> = {
        ...input,
        prevHash,
        rationaleHash: input.rationaleHash ?? rationaleHash(input.rationale),
      } as Omit<Decision, "id">;
      const hash = recordHash(prevHash, record);
      const id = decisionIdFromHash(record.kind, hash);
      const r = ins.run(id, record.at, record.kind, record.refId ?? null, canonicalJson(record), prevHash, hash);
      return { ...(record as Decision), id, hash, seq: Number(r.lastInsertRowid) };
    });
    this.appendTx = (input) => tx.immediate(input);
  }

  onAppend(fn: (e: JournalEntry) => void): () => void {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((x) => x !== fn));
  }

  /** The only write path (single writer, §13). */
  append(input: AppendInput): JournalEntry {
    const e = this.appendTx(input);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* listeners never break the writer */
      }
    }
    return e;
  }

  head(): { seq: number; hash: Hex } {
    const h = this.db.prepare("SELECT seq, hash FROM decisions ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: Hex } | undefined;
    return h ?? { seq: 0, hash: GENESIS_PREV_HASH };
  }

  private toEntry(r: Row): JournalEntry {
    return { ...(JSON.parse(r.record) as Omit<Decision, "id">), id: r.id, hash: r.hash, seq: r.seq } as JournalEntry;
  }

  get(id: string): JournalEntry | null {
    const r = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toEntry(r) : null;
  }

  list(f: JournalFilter = {}): JournalEntry[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.id) {
      where.push("id = ?");
      args.push(f.id);
    }
    if (f.refId) {
      where.push("ref_id = ?");
      args.push(f.refId);
    }
    if (f.kind?.length) {
      where.push(`kind IN (${f.kind.map(() => "?").join(",")})`);
      args.push(...f.kind);
    }
    if (f.since !== undefined) {
      where.push("at >= ?");
      args.push(f.since);
    }
    if (f.before !== undefined) {
      where.push("at < ?");
      args.push(f.before);
    }
    if (f.market) {
      where.push("(json_extract(record, '$.market') = ? OR json_extract(record, '$.intent.market') = ?)");
      args.push(f.market, f.market);
    }
    const limit = Math.min(Math.max(f.limit ?? 20, 1), 500);
    const sql = `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.toEntry(r));
  }

  count(kind?: DecisionKind): number {
    const r = (kind ? this.db.prepare("SELECT COUNT(*) c FROM decisions WHERE kind = ?").get(kind) : this.db.prepare("SELECT COUNT(*) c FROM decisions").get()) as { c: number };
    return r.c;
  }

  /** Recompute the chain from genesis: every hash, every prev link, every id (§18.2). */
  verify(): { ok: true; head: Hex; count: number } | { ok: false; seq: number; reason: string } {
    let prev: string = GENESIS_PREV_HASH;
    let n = 0;
    for (const r of this.db.prepare("SELECT * FROM decisions ORDER BY seq ASC").iterate() as Iterable<Row>) {
      if (r.prev_hash !== prev) return { ok: false, seq: r.seq, reason: "prev_hash does not link to the previous record" };
      const rec = JSON.parse(r.record) as Omit<Decision, "id">;
      if (rec.prevHash !== r.prev_hash) return { ok: false, seq: r.seq, reason: "record.prevHash mismatch" };
      const h = recordHash(prev, rec);
      if (h !== r.hash) return { ok: false, seq: r.seq, reason: "hash does not recompute" };
      if (decisionIdFromHash(r.kind, r.hash) !== r.id) return { ok: false, seq: r.seq, reason: "id is not derived from hash" };
      prev = r.hash;
      n++;
    }
    return { ok: true, head: prev as Hex, count: n };
  }

  rows(): DecisionRow[] {
    return (this.db.prepare("SELECT * FROM decisions ORDER BY seq ASC").all() as Row[]).map((r) => ({
      seq: r.seq,
      id: r.id,
      at: r.at,
      kind: r.kind,
      refId: r.ref_id,
      record: r.record,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }
}

export function assertJournalOk(j: Journal): void {
  const v = j.verify();
  if (!v.ok) throw new AteError("InternalError", "ATE_INTERNAL", `journal chain broken at seq ${v.seq}: ${v.reason}`);
}
