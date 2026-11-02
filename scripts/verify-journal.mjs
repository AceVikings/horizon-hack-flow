#!/usr/bin/env node
// Recompute every record hash, id, rationaleHash and the chain head of a journal export, offline, no deps.
// Usage: node scripts/verify-journal.mjs [docs/testnet-133-journal.json]
// Rule (packages/journal/src/journal.ts): hash = keccak256(prevHash || utf8(canonicalJson(record))),
// record = entry minus seq/id/hash; id = kind prefix + hash[2:18]; rationaleHash = keccak256(utf8(NFC(rationale))).
import { readFileSync } from "node:fs";

// keccak256 (original Keccak padding 0x01, not NIST SHA3), 64-bit lanes as BigInt.
const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n,
  0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn,
  0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an,
  0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M);
function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & M & b[((x + 2) % 5) + y]);
    s[0] ^= RC[r];
  }
}
function keccak256(bytes) {
  const rate = 136;
  const len = bytes.length + 1 + ((rate - ((bytes.length + 1) % rate)) % rate);
  const p = new Uint8Array(len);
  p.set(bytes);
  p[bytes.length] ^= 0x01;
  p[len - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < len; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n;
      for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(p[off + i * 8 + k]);
      s[i] ^= v;
    }
    keccakF(s);
  }
  let hex = "0x";
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) hex += Number((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
  return hex;
}

// RFC 8785 canonical JSON, same as canonicalJson() in packages/journal.
function canonicalJson(v) {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

const PREFIX = { proposal: "prop_", no_trade: "dec_", execution: "exec_", attestation: "att_", strategy_change: "strat_", pause: "pause_", outcome: "out_", payment: "pay_", payment_update: "payu_", oracle_refresh: "orf_" };
const hexBytes = (h) => Uint8Array.from(h.slice(2).match(/../g).map((b) => parseInt(b, 16)));
const utf8 = (s) => new TextEncoder().encode(s);

// Self-test against the known keccak256("") so a broken hasher can never report "ok".
if (keccak256(new Uint8Array()) !== "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") throw new Error("keccak self-test failed");

const file = process.argv[2] ?? new URL("../docs/testnet-133-journal.json", import.meta.url);
const exp = JSON.parse(readFileSync(file, "utf8"));
let prev = "0x" + "00".repeat(32);
let bad = 0;
for (const e of exp.entries) {
  const { seq, id, hash, ...record } = e;
  const fail = (why) => (bad++, console.log(`seq ${seq}: ${why}`));
  if (record.prevHash !== prev) fail("prevHash does not link to the previous record");
  const body = utf8(canonicalJson(record));
  const buf = new Uint8Array(32 + body.length);
  buf.set(hexBytes(prev));
  buf.set(body, 32);
  const h = keccak256(buf);
  if (h !== hash) fail(`hash ${hash} recomputes to ${h}`);
  if (PREFIX[record.kind] + h.slice(2, 18) !== id) fail(`id ${id} is not derived from the hash`);
  if (typeof record.rationale === "string" && keccak256(utf8(record.rationale.normalize("NFC"))) !== record.rationaleHash) fail("rationaleHash mismatch");
  prev = hash; // link on the stated hash so one bad record is reported once, not cascaded
}
if (exp.count !== undefined && exp.count !== exp.entries.length) bad++, console.log(`count ${exp.count} != ${exp.entries.length} entries`);
if (exp.head && exp.head !== prev) bad++, console.log(`head ${exp.head} != recomputed ${prev}`);
console.log(bad ? `FAIL: ${bad} problem(s)` : `ok: ${exp.entries.length} records, every hash, id and rationaleHash recomputed, head ${prev}`);
process.exit(bad ? 1 : 0);
