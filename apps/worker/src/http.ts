// Minimal JSON-over-HTTP helpers for the worker services (loopback only; reached via SSM port-forward).
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AteError, ERROR_RETRYABLE, isAteErrorCode } from "@ate/core";

export const MAX_BODY = 32 * 1024;

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body > 32 KB");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

/** Constant-time bearer check. The worker token is mandatory on every request (§3.4). */
export function checkBearer(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const STATUS_FOR: Record<string, number> = {
  ATE_PAYMENT_DENIED: 403,
  ATE_PAYMENT_EXPIRED: 410,
  ATE_PAYMENT_LIMIT: 429,
  ATE_PAYMENT_UNCERTAIN: 409,
  ATE_PAYMENT_NETWORK_UNSUPPORTED: 422,
  ATE_PAYMENT_UNAVAILABLE: 503,
  ATE_PAYMENT_ORDER_MISMATCH: 422,
  ATE_PAYMENT_CONDITIONS_INVALID: 422,
  ATE_POLICY_PAUSED: 423,
  ATE_INSUFFICIENT_BALANCE: 402,
};

export function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof HttpError) {
    send(res, e.status, { ok: false, error: { code: "ATE_INTERNAL", message: e.message, retryable: false } });
    return;
  }
  if (e instanceof AteError && isAteErrorCode(e.code)) {
    send(res, STATUS_FOR[e.code] ?? 400, { ok: false, error: e.toToolError() });
    return;
  }
  send(res, 500, { ok: false, error: { code: "ATE_INTERNAL", message: (e as Error)?.message ?? "internal", retryable: ERROR_RETRYABLE.ATE_INTERNAL } });
}
