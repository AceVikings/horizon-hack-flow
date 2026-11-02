// Payment conditions: receiving agent (ate-signal) → payment agent (ate-pay) (SPEC §9.2, §9.3 step 1).
import { randomBytes } from "node:crypto";
import { AteError } from "@ate/core";
import { canonicalJson } from "@ate/approve";
import { getAddress, keccak256, recoverMessageAddress, toBytes, type Address, type Hex, type LocalAccount } from "viem";
import type { ChainConfig } from "./hsp.js";

export const SIGNAL_PRODUCT = "whsk-fair-value-15m" as const;
export const CONDITIONS_MAX_AHEAD_SEC = 300;
export const SIGNAL_TTL_SEC = 900 as const;

export interface PaymentConditions {
  offerId: string;
  orderId: string;
  product: typeof SIGNAL_PRODUCT;
  priceUsd: string;
  payTo: Address;
  merchantName: "Vikings";
  network: { chainId: number; token: Address; decimals: number };
  expiresAt: number;
  signalTtlSec: typeof SIGNAL_TTL_SEC;
  signature: Hex;
}

export type UnsignedConditions = Omit<PaymentConditions, "signature">;

export function newOfferId(): string {
  return `sig_${randomBytes(8).toString("hex")}`;
}

/** The exact bytes signed (EIP-191) and hashed: canonical JSON of the conditions without `signature`. */
export function conditionsMessage(c: UnsignedConditions | PaymentConditions): string {
  const { signature: _sig, ...rest } = c as PaymentConditions;
  return canonicalJson({ ...rest, payTo: rest.payTo.toLowerCase(), network: { ...rest.network, token: rest.network.token.toLowerCase() } });
}

export function conditionsHash(c: UnsignedConditions | PaymentConditions): Hex {
  return keccak256(toBytes(conditionsMessage(c)));
}

export async function signConditions(c: UnsignedConditions, signer: LocalAccount): Promise<PaymentConditions> {
  const signature = await signer.signMessage({ message: conditionsMessage(c) });
  return { ...c, signature };
}

const fail = (msg: string): never => {
  throw new AteError("PaymentError", "ATE_PAYMENT_CONDITIONS_INVALID", msg);
};

/** Payment protocols ate-pay can sign for (x402 v2, §9.2). */
export const SUPPORTED_PROTOCOLS = ["x402-v2", "x402v2", "x402_v2", "x402"];

/**
 * §9.3 step 1: signature by the configured signal-agent key, expiry (future, ≤ 300 s ahead) and network
 * equal to live `get_chain_config` (chain ID, token contract, decimals, payment protocol).
 */
export async function verifyConditions(
  c: PaymentConditions,
  expect: { signalAgent: Address; chain: ChainConfig; now: number },
): Promise<{ conditionsHash: Hex }> {
  if (!/^sig_[0-9a-f]{16}$/.test(c.offerId)) fail("bad offerId");
  if (c.product !== SIGNAL_PRODUCT) fail("unexpected product");
  if (c.merchantName !== "Vikings") fail("unexpected merchantName");
  if (c.signalTtlSec !== SIGNAL_TTL_SEC) fail("unexpected signalTtlSec");
  if (!/^\d+(\.\d+)?$/.test(c.priceUsd)) fail("bad priceUsd");
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: conditionsMessage(c), signature: c.signature });
  } catch {
    return fail("unrecoverable conditions signature");
  }
  if (getAddress(signer) !== getAddress(expect.signalAgent)) fail("conditions not signed by the configured signal agent");
  if (c.expiresAt <= expect.now) fail("conditions expired");
  if (c.expiresAt > expect.now + CONDITIONS_MAX_AHEAD_SEC) fail("conditions expiry > 300 s ahead");
  const ch = expect.chain;
  const protocolOk = SUPPORTED_PROTOCOLS.includes(ch.paymentProtocol.toLowerCase().replace(/\s+/g, ""));
  if (!protocolOk) {
    throw new AteError("PaymentError", "ATE_PAYMENT_NETWORK_UNSUPPORTED", `unsupported payment protocol ${ch.paymentProtocol}`);
  }
  if (c.network.chainId !== ch.chainId || c.network.token.toLowerCase() !== ch.token.toLowerCase() || c.network.decimals !== ch.decimals) {
    fail("conditions network does not match live get_chain_config");
  }
  return { conditionsHash: conditionsHash(c) };
}
