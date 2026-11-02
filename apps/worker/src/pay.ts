// ate-pay — the payment agent service on the worker (SPEC §3.4, §9.3–§9.6). Reached only through the SSM
// port-forward; every request needs the per-start worker bearer token; payment approvals additionally need
// an ate-approve (Secure Enclave) signature over the agent-built payload.
//
// Routes (all JSON, Bearer <worker token>):
//   GET  /offers                         → fetch fresh signed conditions from ate-signal (cached by offerId)
//   POST /buy { offerId, context? }      → §9.5 economics (if context given) → mandate → PREPARED + approval #1
//   GET  /payments | /payments/:id       → records (redacted) + pending approval payload (base64url) + prompt text
//   POST /payments/:id/approve { stage, approval }   → approval #1 (sign) / #2 (submit)
//   POST /payments/:id/deny { stage }
//   GET  /payments/:id/signal            → after SETTLED*: redeem once from ate-signal, cached
import { createServer, type Server } from "node:http";
import { AteError } from "@ate/core";
import { encodePayload, renderReason } from "@ate/approve";
import { isTerminal, redact, shouldBuySignal, type PaymentAgent, type PaymentConditions, type PaymentRecord } from "@ate/payments";
import type { DeliveredSignal } from "./signal.js";
import { HttpError, checkBearer, readJson, send, sendError } from "./http.js";

export interface SignalAgentClient {
  offers(): Promise<PaymentConditions>;
  redeem(req: { payment_request_id: string; offerId: string; conditionsHash: string }): Promise<DeliveredSignal>;
}

/** HTTP client for ate-signal (same worker, its own token). */
export function httpSignalClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): SignalAgentClient {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const r = await fetchImpl(new URL(path, baseUrl), { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    const j = (await r.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!j.ok) throw new AteError("PaymentError", (j.error?.code as never) ?? "ATE_PAYMENT_UNAVAILABLE", j.error?.message ?? `ate-signal ${r.status}`);
    return j.data as T;
  };
  return {
    offers: () => call<PaymentConditions>("/offers"),
    redeem: (req) => call<DeliveredSignal>("/redeem", { method: "POST", body: JSON.stringify(req) }),
  };
}

export interface PayServiceOptions {
  agent: PaymentAgent;
  signal: SignalAgentClient;
  token: string;
  /** Emits payment.state for the daemon's /events (via the daemon's poll or a future push). */
  onState?: (r: PaymentRecord) => void;
}

export function viewPayment(r: PaymentRecord) {
  const { typedData: _td, conditions, ...rest } = r;
  return {
    ...redact(rest),
    offer: { offerId: conditions.offerId, priceUsd: conditions.priceUsd, payTo: conditions.payTo, expiresAt: conditions.expiresAt },
    approvalRequest: r.awaiting
      ? { stage: r.awaiting.stage, payload: encodePayload(r.awaiting.payload), prompt: renderReason(r.awaiting.payload), expiresAt: r.awaiting.payload.expiresAt }
      : null,
  };
}

export class PayService {
  private readonly offers = new Map<string, PaymentConditions>();
  private readonly delivered = new Map<string, DeliveredSignal>();
  constructor(private readonly o: PayServiceOptions) {}

  async fetchOffer(): Promise<PaymentConditions> {
    const c = await this.o.signal.offers();
    this.offers.set(c.offerId, c);
    return c;
  }

  async buy(body: unknown): Promise<PaymentRecord> {
    const b = (body ?? {}) as { offerId?: unknown; context?: { tradeSizeUsd: string; netEdgeBps: number; entrySpreadBps: number } };
    if (typeof b.offerId !== "string") throw new HttpError(400, "expected { offerId }");
    const c = this.offers.get(b.offerId);
    if (!c) throw new AteError("PaymentError", "ATE_PAYMENT_CONDITIONS_INVALID", "unknown offer; GET /offers first");
    if (b.context) {
      const d = shouldBuySignal(b.context, c.priceUsd);
      if (!d.buy) throw new AteError("PaymentError", "ATE_PAYMENT_LIMIT", `purchase not worth it: ${d.reason}`, { retryable: false });
    }
    return this.o.agent.start(c);
  }

  async signalFor(id: string): Promise<DeliveredSignal> {
    const cached = this.delivered.get(id);
    if (cached) return cached;
    const r = this.o.agent.get(id);
    if (!r) throw new HttpError(404, "unknown payment");
    if (r.state !== "SETTLED" && r.state !== "SETTLED_UNATTRIBUTED") {
      throw new AteError("PaymentError", "ATE_PAYMENT_UNCERTAIN", `payment is ${r.state}; signal released only after payment-finalized`);
    }
    const s = await this.o.signal.redeem({ payment_request_id: r.mandate!.paymentRequestId, offerId: r.offerId, conditionsHash: r.conditionsHash });
    this.delivered.set(id, s);
    return s;
  }

  listen(port: number, host = "127.0.0.1"): Promise<Server> {
    const server = createServer((req, res) => {
      void (async () => {
        try {
          if (!checkBearer(req, this.o.token)) return send(res, 401, { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: "worker token required" } });
          const path = (req.url ?? "").split("?")[0]!;
          const m = /^\/payments\/(pay_[0-9a-f]{16})(?:\/(approve|deny|signal))?$/.exec(path);
          if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
          if (req.method === "GET" && path === "/offers") return send(res, 200, { ok: true, data: await this.fetchOffer() });
          if (req.method === "POST" && path === "/buy") {
            const r = await this.buy(await readJson(req));
            this.o.onState?.(r);
            return send(res, 200, { ok: true, data: viewPayment(r) });
          }
          if (req.method === "GET" && path === "/payments") return send(res, 200, { ok: true, data: this.o.agent.list().map(viewPayment) });
          if (m) {
            const id = m[1]!;
            if (req.method === "GET" && !m[2]) {
              const r = this.o.agent.get(id);
              if (!r) throw new HttpError(404, "unknown payment");
              return send(res, 200, { ok: true, data: viewPayment(r) });
            }
            if (req.method === "GET" && m[2] === "signal") return send(res, 200, { ok: true, data: await this.signalFor(id) });
            if (req.method === "POST" && (m[2] === "approve" || m[2] === "deny")) {
              const b = (await readJson(req)) as { stage?: unknown; approval?: unknown };
              if (b.stage !== "sign" && b.stage !== "submit") throw new HttpError(400, "stage must be sign|submit");
              const stage = b.stage;
              let r: PaymentRecord;
              if (m[2] === "deny") r = await this.o.agent.deny(id, stage);
              else {
                // TTY codes are never accepted for payments (§10.1): only a Secure Enclave signature.
                if (typeof b.approval !== "string" || /^[0-9]{8}$/.test(b.approval)) throw new AteError("AuthError", "ATE_PAYMENT_DENIED", "payments require an ate-approve signature");
                r = await this.o.agent.approve(id, stage, b.approval);
              }
              this.o.onState?.(r);
              return send(res, 200, { ok: true, data: viewPayment(r) });
            }
          }
          send(res, 404, { ok: false, error: { code: "ATE_INTERNAL", message: "not found" } });
        } catch (e) {
          sendError(res, e);
        }
      })();
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }
}

/** Background driver: approval timeouts, quote lapses, polling schedule. */
export function startTicker(agent: PaymentAgent, everyMs = 1000, onState?: (r: PaymentRecord) => void): () => void {
  let running = false;
  const h = setInterval(() => {
    if (running) return;
    running = true;
    const before = new Map(agent.list().map((r) => [r.id, r.state]));
    agent
      .tick()
      .then(() => {
        for (const r of agent.list()) if (before.get(r.id) !== r.state || (!isTerminal(r.state) && !before.has(r.id))) onState?.(r);
      })
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  }, everyMs);
  return () => clearInterval(h);
}
