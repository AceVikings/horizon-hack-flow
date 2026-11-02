// Approval payloads signed by `ate-approve` (SPEC §10.1). This file is the wire format's source of truth;
// swift/ate-approve.swift decodes the same bytes and builds the Touch ID prompt from them alone.
//
// Wire format: base64url(canonicalJson(payload)). The Secure Enclave signs the decoded bytes
// (ECDSA P-256 over SHA-256, DER). Verifiers rebuild the payload from their own state, canonicalise it and
// verify the signature over those bytes — so a caller-chosen encoding or prompt can never verify.

export const APPROVAL_PAYLOAD_VERSION = 1 as const;

export const APPROVAL_KINDS = ["payment", "trade", "chat_session", "ui_attach", "strategy", "config"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Which verifier the approval is for. A daemon approval cannot be replayed at ate-pay and vice versa. */
export type ApprovalAudience = "ate-daemon" | "ate-pay";

interface Base<K extends ApprovalKind> {
  v: typeof APPROVAL_PAYLOAD_VERSION;
  kind: K;
  aud: ApprovalAudience;
  /** Daemon/worker-issued single-use nonce (for strategy: the changeId; for payments: paymentId:stage). */
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PaymentApprovalBody {
  /** Approval #1 (before signing typed data) or #2 (before submit_payment), §9.4. */
  stage: "sign" | "submit";
  paymentId: string;
  paymentRequestId: string;
  /** Smallest units, including fees (`token_total_raw`). */
  amountRaw: string;
  decimals: number;
  token: string;
  tokenSymbol: string;
  payTo: string;
  payer: string;
  chainId: number;
  /** EIP-712 digest of the typed data being authorised (§8.4); a changed digest invalidates the approval. */
  typedDataDigest: string;
  validUntil: number;
  /** Network fee in token smallest units, when known (stage "submit": from estimate_fee). */
  feeRaw?: string;
}
export interface TradeApprovalBody {
  proposalId: string;
  market: string;
  side: "buy" | "sell";
  amountUsd: string;
  amountIn: string;
  tokenIn: string;
}
export interface ChatSessionApprovalBody {
  sessionId: string;
}
export interface UiAttachApprovalBody {
  pid: number;
  port: number;
}
export interface StrategyApprovalChange {
  scope: string;
  field: string;
  before: unknown;
  after: unknown;
}
export interface StrategyApprovalBody {
  changeId: string;
  changes: StrategyApprovalChange[];
}
export interface ConfigApprovalBody {
  changes: { key: string; before: unknown; after: unknown }[];
}

export type PaymentApproval = Base<"payment"> & { body: PaymentApprovalBody };
export type TradeApproval = Base<"trade"> & { body: TradeApprovalBody };
export type ChatSessionApproval = Base<"chat_session"> & { body: ChatSessionApprovalBody };
export type UiAttachApproval = Base<"ui_attach"> & { body: UiAttachApprovalBody };
export type StrategyApproval = Base<"strategy"> & { body: StrategyApprovalBody };
export type ConfigApproval = Base<"config"> & { body: ConfigApprovalBody };

export type ApprovalPayload =
  | PaymentApproval
  | TradeApproval
  | ChatSessionApproval
  | UiAttachApproval
  | StrategyApproval
  | ConfigApproval;

// ------------------------------------------------------------------ canonical JSON

/** Deterministic JSON: object keys sorted (UTF-16 order), no whitespace, `undefined` fields dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(value.toString());
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function payloadBytes(p: ApprovalPayload): Buffer {
  return Buffer.from(canonicalJson(p), "utf8");
}

export function encodePayload(p: ApprovalPayload): string {
  validatePayload(p);
  return payloadBytes(p).toString("base64url");
}

export function decodePayload(b64: string): ApprovalPayload {
  const raw = Buffer.from(b64, "base64url").toString("utf8");
  const parsed = JSON.parse(raw) as unknown;
  validatePayload(parsed);
  return parsed;
}

// ------------------------------------------------------------------ validation (mirrored in Swift)

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^[0-9]+$/;
const DEC = /^[0-9]+(\.[0-9]+)?$/;

export class ApprovalPayloadError extends Error {
  override name = "ApprovalPayloadError";
}

function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ApprovalPayloadError(msg);
}

const isStr = (x: unknown, max = 256): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) req(allowed.includes(k), `${where}: unexpected field ${k}`);
}

export function validatePayload(x: unknown): asserts x is ApprovalPayload {
  req(typeof x === "object" && x !== null && !Array.isArray(x), "payload must be an object");
  const p = x as Record<string, unknown>;
  onlyKeys(p, ["v", "kind", "aud", "nonce", "issuedAt", "expiresAt", "body"], "payload");
  req(p.v === APPROVAL_PAYLOAD_VERSION, "unsupported payload version");
  req((APPROVAL_KINDS as readonly unknown[]).includes(p.kind), "unknown kind");
  req(p.aud === "ate-daemon" || p.aud === "ate-pay", "bad aud");
  req(isStr(p.nonce, 128), "bad nonce");
  req(isInt(p.issuedAt) && isInt(p.expiresAt) && p.expiresAt > p.issuedAt, "bad validity window");
  req(typeof p.body === "object" && p.body !== null && !Array.isArray(p.body), "bad body");
  const b = p.body as Record<string, unknown>;
  switch (p.kind as ApprovalKind) {
    case "payment":
      req(p.aud === "ate-pay", "payment approvals are for ate-pay");
      onlyKeys(
        b,
        ["stage", "paymentId", "paymentRequestId", "amountRaw", "decimals", "token", "tokenSymbol", "payTo", "payer", "chainId", "typedDataDigest", "validUntil", "feeRaw"],
        "payment",
      );
      req(b.stage === "sign" || b.stage === "submit", "payment: bad stage");
      req(isStr(b.paymentId, 64) && isStr(b.paymentRequestId, 128), "payment: bad ids");
      req(typeof b.amountRaw === "string" && UINT.test(b.amountRaw), "payment: bad amountRaw");
      req(isInt(b.decimals) && (b.decimals as number) <= 36, "payment: bad decimals");
      req(typeof b.token === "string" && HEX_ADDR.test(b.token), "payment: bad token");
      req(isStr(b.tokenSymbol, 16), "payment: bad tokenSymbol");
      req(typeof b.payTo === "string" && HEX_ADDR.test(b.payTo), "payment: bad payTo");
      req(typeof b.payer === "string" && HEX_ADDR.test(b.payer), "payment: bad payer");
      req(isInt(b.chainId) && (b.chainId as number) > 0, "payment: bad chainId");
      req(typeof b.typedDataDigest === "string" && HEX_32.test(b.typedDataDigest), "payment: bad digest");
      req(isInt(b.validUntil), "payment: bad validUntil");
      req(b.feeRaw === undefined || (typeof b.feeRaw === "string" && UINT.test(b.feeRaw)), "payment: bad feeRaw");
      break;
    case "trade":
      onlyKeys(b, ["proposalId", "market", "side", "amountUsd", "amountIn", "tokenIn"], "trade");
      req(isStr(b.proposalId, 80) && isStr(b.market, 64), "trade: bad ids");
      req(b.side === "buy" || b.side === "sell", "trade: bad side");
      req(typeof b.amountUsd === "string" && DEC.test(b.amountUsd), "trade: bad amountUsd");
      req(typeof b.amountIn === "string" && UINT.test(b.amountIn), "trade: bad amountIn");
      req(typeof b.tokenIn === "string" && HEX_ADDR.test(b.tokenIn), "trade: bad tokenIn");
      break;
    case "chat_session":
      onlyKeys(b, ["sessionId"], "chat_session");
      req(isStr(b.sessionId, 80), "chat_session: bad sessionId");
      break;
    case "ui_attach":
      onlyKeys(b, ["pid", "port"], "ui_attach");
      req(isInt(b.pid) && (b.pid as number) > 0, "ui_attach: bad pid");
      req(isInt(b.port) && (b.port as number) > 0 && (b.port as number) < 65536, "ui_attach: bad port");
      break;
    case "strategy":
      onlyKeys(b, ["changeId", "changes"], "strategy");
      req(isStr(b.changeId, 80), "strategy: bad changeId");
      req(Array.isArray(b.changes) && b.changes.length > 0 && b.changes.length <= 32, "strategy: bad changes");
      for (const c of b.changes as unknown[]) {
        req(typeof c === "object" && c !== null, "strategy: bad change");
        const cc = c as Record<string, unknown>;
        onlyKeys(cc, ["scope", "field", "before", "after"], "strategy change");
        req(isStr(cc.scope, 64) && isStr(cc.field, 64), "strategy: bad scope/field");
      }
      break;
    case "config":
      onlyKeys(b, ["changes"], "config");
      req(Array.isArray(b.changes) && b.changes.length > 0 && b.changes.length <= 32, "config: bad changes");
      for (const c of b.changes as unknown[]) {
        req(typeof c === "object" && c !== null, "config: bad change");
        const cc = c as Record<string, unknown>;
        onlyKeys(cc, ["key", "before", "after"], "config change");
        req(isStr(cc.key, 128), "config: bad key");
      }
      break;
  }
}

// ------------------------------------------------------------------ prompt text (mirrored in Swift)

/** Decimal rendering of a smallest-unit integer string. */
export function formatUnits(raw: string, decimals: number): string {
  const s = raw.replace(/^0+(?=\d)/, "");
  if (decimals === 0) return s;
  const padded = s.padStart(decimals + 1, "0");
  const int = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

function short(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return canonicalJson(v);
}

/**
 * The Touch ID `localizedReason`, built only from the decoded payload (§10.1). The Swift helper
 * implements the identical function; a parity test compares them when the binary is built.
 */
export function renderReason(p: ApprovalPayload): string {
  switch (p.kind) {
    case "payment": {
      const b = p.body;
      const step = b.stage === "sign" ? "Sign payment authorization" : "Submit payment";
      const fee = b.feeRaw !== undefined ? ` (fee ${formatUnits(b.feeRaw, b.decimals)})` : "";
      return `${step}: ${formatUnits(b.amountRaw, b.decimals)} ${b.tokenSymbol} (${short(b.token)})${fee} to ${b.payTo} on chain ${b.chainId}, digest ${short(b.typedDataDigest)}`;
    }
    case "trade":
      return `Approve trade: ${p.body.side.toUpperCase()} $${p.body.amountUsd} on ${p.body.market} (proposal ${short(p.body.proposalId)})`;
    case "chat_session":
      return `Open ATE chat session ${p.body.sessionId}`;
    case "ui_attach":
      return `Attach ATE desktop to daemon pid ${p.body.pid} on port ${p.body.port}`;
    case "strategy":
      return `Loosen ATE strategy: ${p.body.changes
        .map((c) => `${c.scope === "portfolio" ? "portfolio" : c.scope} ${c.field} ${renderValue(c.before)} → ${renderValue(c.after)}`)
        .join("; ")}`;
    case "config":
      return `Change ATE config: ${p.body.changes.map((c) => `${c.key} ${renderValue(c.before)} → ${renderValue(c.after)}`).join("; ")}`;
  }
}
