// @ate/payments/testing — MockHsp: an in-memory HSP that answers from the recorded/synthesised responses in
// fixtures/hsp (templated), run through the SAME parse + normalise path as the live client. Never networked.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import {
  HspError,
  normChainConfig,
  normOrder,
  normPaymentStatus,
  normPrepared,
  parseToolResult,
  type HspClient,
  type HspToolName,
} from "./hsp.js";
import { usdToMicro } from "./policy.js";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "hsp");

export function loadFixture(name: string, vars: Record<string, string | number | boolean> = {}): Record<string, unknown> {
  let raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8");
  raw = raw.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`fixture ${name}: missing var ${k}`);
    return String(vars[k]);
  });
  return JSON.parse(raw) as Record<string, unknown>;
}

const asToolResult = (body: Record<string, unknown>) => parseToolResult({ content: [{ type: "text", text: JSON.stringify(body) }] });

export type SubmitBehaviour = "ok" | "timeout" | "5xx" | "30043";
export type QueryOutcome = "submitted" | "safe" | "finalized" | "finalized_unattributed" | "failed" | "timeout";

export interface MockHspOptions {
  now: () => number;
  feeRaw?: bigint;
  quoteTtlSec?: number;
  /** Tool names that answer 30043 (quote expired) on their next call. */
  expireOn?: HspToolName[];
  submit?: SubmitBehaviour;
  /** Outcomes of successive query_payment calls; the last one repeats. */
  queries?: QueryOutcome[];
  /** Override listed tools (e.g. drop finalize_payment). */
  tools?: string[];
  chainConfigOverride?: Record<string, unknown>;
  /** Mutate the order get_order returns (ORDER_MISMATCH tests). */
  orderOverride?: Record<string, unknown>;
}

interface Flow {
  flowId: string;
  paymentRequestId: string;
  orderId: string;
  payer: Address;
  total: bigint;
  validUntil: number;
  finalized: boolean;
  submitted: boolean;
}

/** Records every call (tool name + args) so tests can assert "never resubmitted", "never re-prepared". */
export class MockHsp implements HspClient {
  readonly calls: { tool: HspToolName | "list_tools"; args: unknown }[] = [];
  private readonly orders = new Map<string, Record<string, unknown>>();
  private readonly flows = new Map<string, Flow>();
  private queryIdx = 0;
  constructor(public opts: MockHspOptions) {}

  private hit(tool: HspToolName, args: unknown): void {
    this.calls.push({ tool, args });
    const i = this.opts.expireOn?.indexOf(tool) ?? -1;
    if (i >= 0) {
      this.opts.expireOn!.splice(i, 1);
      asToolResult(loadFixture("error_30043")); // throws HspError(30043) through the real parser
    }
  }

  count(tool: HspToolName): number {
    return this.calls.filter((c) => c.tool === tool).length;
  }

  async listTools(): Promise<string[]> {
    this.calls.push({ tool: "list_tools", args: {} });
    return this.opts.tools ?? (loadFixture("tools_list").tools as { name: string }[]).map((t) => t.name);
  }

  async getChainConfig() {
    this.hit("get_chain_config", {});
    const body = loadFixture("get_chain_config");
    if (this.opts.chainConfigOverride) body.data = { ...(body.data as object), ...this.opts.chainConfigOverride };
    return normChainConfig(asToolResult(body));
  }

  async createOrder(i: { merchantName: string; amountUsd: string; payTo: Address; productName: string }) {
    this.hit("create_order", i);
    const orderId = `ord_${randomBytes(6).toString("hex")}`;
    const vars = { orderId, merchantName: i.merchantName, amount: i.amountUsd, payTo: i.payTo };
    this.orders.set(orderId, vars);
    return normOrder(asToolResult(loadFixture("create_order", vars)));
  }

  async getOrder(orderId: string) {
    this.hit("get_order", { orderId });
    const vars = this.orders.get(orderId);
    if (!vars) asToolResult({ code: 40004, message: "order not found" });
    const body = loadFixture("get_order", vars as Record<string, string>);
    if (this.opts.orderOverride) body.data = { ...(body.data as object), ...this.opts.orderOverride };
    return normOrder(asToolResult(body));
  }

  async preparePayment(i: { orderId: string; payer: Address }) {
    this.hit("prepare_payment", i);
    const order = this.orders.get(i.orderId);
    if (!order) asToolResult({ code: 40004, message: "order not found" });
    const fee = this.opts.feeRaw ?? 1000n;
    const total = usdToMicro(String(order!.amount)) + fee; // 6-dp USDC
    const validUntil = this.opts.now() + (this.opts.quoteTtlSec ?? 300);
    const f: Flow = {
      flowId: `flow_${randomBytes(6).toString("hex")}`,
      paymentRequestId: `pr_${randomBytes(8).toString("hex")}`,
      orderId: i.orderId,
      payer: i.payer,
      total,
      validUntil,
      finalized: false,
      submitted: false,
    };
    this.flows.set(f.paymentRequestId, f);
    return normPrepared(
      asToolResult(
        loadFixture("prepare_payment", {
          flowId: f.flowId,
          paymentRequestId: f.paymentRequestId,
          tokenTotalRaw: total.toString(),
          feeRaw: fee.toString(),
          validUntil,
          payer: i.payer,
          payTo: String(order!.payTo),
          nonce: `0x${randomBytes(32).toString("hex")}`,
        }),
      ),
    );
  }

  private flow(paymentRequestId: string): Flow {
    const f = this.flows.get(paymentRequestId);
    if (!f) throw new HspError("unknown payment_request_id", 40004, false);
    return f;
  }

  async finalizePayment(i: { flowId: string; paymentRequestId: string; signature: Hex }) {
    this.hit("finalize_payment", { flowId: i.flowId, paymentRequestId: i.paymentRequestId, signature: "[sig]" });
    const f = this.flow(i.paymentRequestId);
    if (!/^0x[0-9a-fA-F]{130}$/.test(i.signature)) asToolResult({ code: 40010, message: "bad signature" });
    f.finalized = true;
    asToolResult(loadFixture("finalize_payment", { flowId: f.flowId, paymentRequestId: f.paymentRequestId }));
    return { ok: true as const };
  }

  async estimateFee(i: { flowId: string; paymentRequestId: string }) {
    this.hit("estimate_fee", i);
    const o = asToolResult(loadFixture("estimate_fee", { feeRaw: (this.opts.feeRaw ?? 1000n).toString() }));
    return { feeRaw: BigInt(String(o.fee_raw)), gasFeeAdvanced: o.gas_fee_advanced === true };
  }

  async submitPayment(i: { flowId: string; paymentRequestId: string }) {
    this.hit("submit_payment", i);
    const f = this.flow(i.paymentRequestId);
    if (!f.finalized) asToolResult({ code: 40011, message: "not finalized" });
    const b = this.opts.submit ?? "ok";
    if (b === "30043") asToolResult(loadFixture("error_30043"));
    f.submitted = true; // the gateway accepted it even if the response is lost
    if (b === "timeout") throw new HspError("submit_payment: request timed out", undefined, true);
    if (b === "5xx") throw new HspError("submit_payment: 502 Bad Gateway", undefined, true);
    const s = normPaymentStatus(asToolResult(loadFixture("submit_payment", { paymentRequestId: f.paymentRequestId })));
    return { status: s.status };
  }

  async queryPayment(i: { paymentRequestId: string; flowId?: string }) {
    this.hit("query_payment", i);
    const f = this.flow(i.paymentRequestId);
    const qs = this.opts.queries ?? ["finalized"];
    const outcome = qs[Math.min(this.queryIdx++, qs.length - 1)]!;
    if (outcome === "timeout") throw new HspError("query_payment: timeout", undefined, true);
    const name = outcome === "finalized_unattributed" ? "query_payment.finalized" : `query_payment.${outcome}`;
    return normPaymentStatus(
      asToolResult(
        loadFixture(name, {
          paymentRequestId: f.paymentRequestId,
          orderId: f.orderId,
          attributionVerified: outcome !== "finalized_unattributed",
        }),
      ),
    );
  }

  /** Whether the gateway saw a submission for this payment request (for "never resubmit" assertions). */
  wasSubmitted(paymentRequestId: string): boolean {
    return this.flows.get(paymentRequestId)?.submitted ?? false;
  }
}
