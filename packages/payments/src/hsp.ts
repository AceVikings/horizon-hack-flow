// HSP (`hsp-agentic-payment`) client over MCP Streamable HTTP (SPEC §9.7). Lane E.
//
// Field names of HSP tool results are normalised here, in one place: the shapes below follow the
// official hackathon guide (rev. 2026-10-30) and are exercised against RECORDED/synthesised responses
// (test/fixtures/hsp). When the live QA tool listing arrives, adjust only the `norm*` functions.
import { AteError } from "@ate/core";
import type { Address, Hex } from "viem";

export const HSP_QA_ENDPOINT = "https://mcp-qa.hashkeymerchant.com/";
export const HSP_SERVER_NAME = "hsp-agentic-payment";

export const REQUIRED_HSP_TOOLS = [
  "get_chain_config",
  "create_order",
  "get_order",
  "prepare_payment",
  "finalize_payment",
  "estimate_fee",
  "submit_payment",
  "query_payment",
] as const;
export type HspToolName = (typeof REQUIRED_HSP_TOOLS)[number];

/** HSP error code for an expired quote (§9.4: → EXPIRED, re-prepare + re-sign). */
export const HSP_QUOTE_EXPIRED = 30043;

export interface ChainConfig {
  network: string;
  chainId: number;
  token: Address;
  tokenSymbol: string;
  decimals: number;
  paymentProtocol: string;
  rpcUrl?: string;
}

export interface HspOrder {
  orderId: string;
  /** Decimal USD string ("0.02"). */
  amount: string;
  currency: string;
  payTo: Address;
  merchantName: string;
  status?: string;
}

export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface PreparedPayment {
  flowId: string;
  paymentRequestId: string;
  typedData: TypedDataPayload;
  /** Total the payer pays, smallest units, incl. fees. */
  tokenTotalRaw: bigint;
  feeRaw?: bigint;
  /** Quote validity (unix s); ~5 min. */
  validUntil: number;
}

export interface FeeEstimate {
  feeRaw: bigint;
  gasFeeAdvanced: boolean;
}

export type HspPaymentStatus = "payment-submitted" | "payment-safe" | "payment-finalized" | "payment-failed" | "pending" | "unknown";

export interface PaymentStatus {
  status: HspPaymentStatus;
  attributionVerified: boolean;
  orderId?: string;
  gatewayTx?: Hex;
  failureReason?: string;
}

export interface CreateOrderInput {
  merchantName: string;
  amountUsd: string;
  payTo: Address;
  productName: string;
}

/** The eight HSP tools, typed. Implementations: McpHspClient (live) and the recorded mock (tests). */
export interface HspClient {
  listTools(): Promise<string[]>;
  getChainConfig(): Promise<ChainConfig>;
  createOrder(i: CreateOrderInput): Promise<HspOrder>;
  getOrder(orderId: string): Promise<HspOrder>;
  preparePayment(i: { orderId: string; payer: Address }): Promise<PreparedPayment>;
  /** Sends the wallet signature; HSP builds the JWT server-side (never returned to logs). */
  finalizePayment(i: { flowId: string; paymentRequestId: string; signature: Hex }): Promise<{ ok: true }>;
  estimateFee(i: { flowId: string; paymentRequestId: string }): Promise<FeeEstimate>;
  submitPayment(i: { flowId: string; paymentRequestId: string }): Promise<{ status: HspPaymentStatus; gatewayTx?: Hex }>;
  queryPayment(i: { paymentRequestId: string; flowId?: string }): Promise<PaymentStatus>;
  close?(): Promise<void>;
}

/** HSP-level failure. `transport` = timeout / 5xx / connection (submit → UNCERTAIN, never resubmit). */
export class HspError extends Error {
  override name = "HspError";
  constructor(
    message: string,
    readonly hspCode: number | undefined,
    readonly transport: boolean,
  ) {
    super(message);
  }
  get quoteExpired(): boolean {
    return this.hspCode === HSP_QUOTE_EXPIRED;
  }
}

// ------------------------------------------------------------------ normalisers (single adjustment point)

type J = Record<string, unknown>;
const pick = (o: J, ...keys: string[]): unknown => {
  for (const k of keys) {
    const parts = k.split(".");
    let cur: unknown = o;
    for (const p of parts) cur = cur && typeof cur === "object" ? (cur as J)[p] : undefined;
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
};
const str = (o: J, ...k: string[]): string => {
  const v = pick(o, ...k);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  throw new HspError(`HSP response missing ${k[0]}`, undefined, false);
};
const optStr = (o: J, ...k: string[]): string | undefined => {
  const v = pick(o, ...k);
  return v === undefined ? undefined : String(v);
};
const num = (o: J, ...k: string[]): number => {
  const n = Number(str(o, ...k));
  if (!Number.isFinite(n)) throw new HspError(`HSP response ${k[0]} not a number`, undefined, false);
  return n;
};
const unix = (v: string): number => (/^\d+$/.test(v) ? Number(v) > 1e12 ? Math.floor(Number(v) / 1000) : Number(v) : Math.floor(Date.parse(v) / 1000));

export function normChainConfig(o: J): ChainConfig {
  const rpc = optStr(o, "rpc_url", "rpcUrl", "network.rpc_url");
  return {
    network: str(o, "network.name", "network", "network_name"),
    chainId: num(o, "chain_id", "chainId", "network.chain_id"),
    token: str(o, "token.address", "token_address", "token_contract", "tokenAddress") as Address,
    tokenSymbol: optStr(o, "token.symbol", "token_symbol") ?? "TOKEN",
    decimals: num(o, "token.decimals", "token_decimals", "decimals"),
    paymentProtocol: str(o, "payment_protocol", "paymentProtocol"),
    ...(rpc ? { rpcUrl: rpc } : {}),
  };
}

export function normOrder(o: J): HspOrder {
  const status = optStr(o, "status", "order_status");
  return {
    orderId: str(o, "order_id", "orderId", "id"),
    amount: str(o, "amount", "total_amount", "order_amount"),
    currency: str(o, "currency"),
    payTo: str(o, "pay_to", "payTo") as Address,
    merchantName: str(o, "merchant_name", "merchantName"),
    ...(status ? { status } : {}),
  };
}

export function normPrepared(o: J): PreparedPayment {
  const fee = optStr(o, "fee_raw", "fee.raw", "fee");
  const td = pick(o, "typed_data", "typedData", "eip712") as J | undefined;
  if (!td || typeof td !== "object") throw new HspError("prepare_payment: no typed data", undefined, false);
  return {
    flowId: str(o, "flow_id", "flowId"),
    paymentRequestId: str(o, "payment_request_id", "paymentRequestId"),
    typedData: {
      domain: (td.domain ?? {}) as J,
      types: (td.types ?? {}) as TypedDataPayload["types"],
      primaryType: String(td.primaryType ?? td.primary_type),
      message: (td.message ?? {}) as J,
    },
    tokenTotalRaw: BigInt(str(o, "token_total_raw", "quote.token_total_raw")),
    ...(fee !== undefined && /^\d+$/.test(fee) ? { feeRaw: BigInt(fee) } : {}),
    validUntil: unix(str(o, "valid_until", "quote.valid_until", "expires_at", "quote_expires_at")),
  };
}

export function normStatus(s: string | undefined): HspPaymentStatus {
  switch (s) {
    case "payment-submitted":
    case "payment-safe":
    case "payment-finalized":
    case "payment-failed":
    case "pending":
      return s;
    case "failed":
    case "payment-rejected":
    case "payment-reverted":
      return "payment-failed";
    default:
      return "unknown";
  }
}

export function normPaymentStatus(o: J): PaymentStatus {
  const tx = optStr(o, "tx_hash", "gateway_tx", "transaction_hash", "tx_ref");
  const orderId = optStr(o, "order_id", "orderId");
  const reason = optStr(o, "failure_reason", "error", "reason");
  return {
    status: normStatus(optStr(o, "status", "payment_status")),
    attributionVerified: pick(o, "attribution_verified", "attributionVerified") === true,
    ...(orderId ? { orderId } : {}),
    ...(tx ? { gatewayTx: tx as Hex } : {}),
    ...(reason ? { failureReason: reason } : {}),
  };
}

// ------------------------------------------------------------------ live client (MCP Streamable HTTP)

export interface McpHspClientOptions {
  endpoint?: string;
  /**
   * Must be true to construct the live client. Live use is gated on G-HSP (§21.4) and the worker's
   * allowlisted egress IP; tests never set it.
   */
  allowLive: boolean;
  timeoutMs?: number;
}

/** Tool-call result content → JSON; `isError` → HspError (with HSP numeric code when present). */
export function parseToolResult(res: { content?: unknown; isError?: boolean; structuredContent?: unknown }): J {
  let body: J | undefined;
  if (res.structuredContent && typeof res.structuredContent === "object") body = res.structuredContent as J;
  if (!body && Array.isArray(res.content)) {
    const t = res.content.find((c: unknown) => (c as J)?.type === "text") as { text?: string } | undefined;
    if (t?.text) {
      try {
        body = JSON.parse(t.text) as J;
      } catch {
        body = { message: t.text };
      }
    }
  }
  body ??= {};
  const inner = (body.data && typeof body.data === "object" ? body.data : body) as J;
  const code = pick(body, "code", "error.code", "error_code");
  const codeNum = code === undefined ? undefined : Number(code);
  const isErr = res.isError === true || (codeNum !== undefined && codeNum !== 0 && codeNum !== 200 && body.success !== true);
  if (isErr) {
    const msg = optStr(body, "message", "error.message", "msg") ?? "HSP tool error";
    throw new HspError(msg, Number.isFinite(codeNum) ? codeNum : undefined, false);
  }
  return inner;
}

export async function createMcpHspClient(opts: McpHspClientOptions): Promise<HspClient> {
  if (!opts.allowLive) {
    throw new AteError("PaymentError", "ATE_PAYMENT_UNAVAILABLE", "live HSP client disabled (G-HSP not go); use recorded responses");
  }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "ate-pay", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(opts.endpoint ?? HSP_QA_ENDPOINT));
  try {
    await client.connect(transport);
  } catch (e) {
    throw new HspError(`HSP connect failed: ${(e as Error).message}`, undefined, true);
  }
  const timeout = opts.timeoutMs ?? 20_000;
  const call = async (name: HspToolName, args: J): Promise<J> => {
    let res;
    try {
      res = await client.callTool({ name, arguments: args }, undefined, { timeout });
    } catch (e) {
      throw new HspError(`${name}: ${(e as Error).message}`, undefined, true);
    }
    return parseToolResult(res as { content?: unknown; isError?: boolean; structuredContent?: unknown });
  };
  return {
    async listTools() {
      const r = await client.listTools();
      return r.tools.map((t) => t.name);
    },
    getChainConfig: async () => normChainConfig(await call("get_chain_config", {})),
    createOrder: async (i) =>
      normOrder(
        await call("create_order", {
          merchant_name: i.merchantName,
          currency: "USD",
          amount: i.amountUsd,
          pay_to: i.payTo,
          payment_method: "x402",
          x402_version: 2,
          line_items: [{ name: i.productName, quantity: 1, unit_price: i.amountUsd }],
        }),
      ),
    getOrder: async (orderId) => normOrder(await call("get_order", { order_id: orderId })),
    preparePayment: async (i) => normPrepared(await call("prepare_payment", { order_id: i.orderId, payer: i.payer })),
    finalizePayment: async (i) => {
      await call("finalize_payment", { flow_id: i.flowId, payment_request_id: i.paymentRequestId, signature: i.signature });
      return { ok: true as const };
    },
    estimateFee: async (i) => {
      const o = await call("estimate_fee", { flow_id: i.flowId, payment_request_id: i.paymentRequestId });
      return { feeRaw: BigInt(str(o, "fee_raw", "fee", "estimated_fee_raw")), gasFeeAdvanced: pick(o, "gas_fee_advanced") === true };
    },
    submitPayment: async (i) => {
      const o = await call("submit_payment", { flow_id: i.flowId, payment_request_id: i.paymentRequestId });
      const s = normPaymentStatus(o);
      return { status: s.status, ...(s.gatewayTx ? { gatewayTx: s.gatewayTx } : {}) };
    },
    queryPayment: async (i) =>
      normPaymentStatus(await call("query_payment", { payment_request_id: i.paymentRequestId, ...(i.flowId ? { flow_id: i.flowId } : {}) })),
    close: async () => {
      await client.close();
    },
  };
}

/** Verifies all eight tools are listed (§9.7 "stop on a missing tool"). */
export function missingHspTools(listed: string[]): HspToolName[] {
  return REQUIRED_HSP_TOOLS.filter((t) => !listed.includes(t));
}

/** GET /health → {"status":"ok"} (health alone proves nothing about tools or payments). */
export async function hspHealth(endpoint = HSP_QA_ENDPOINT, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(new URL("health", endpoint), { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const j = (await r.json()) as { status?: string };
    return j.status === "ok";
  } catch {
    return false;
  }
}
