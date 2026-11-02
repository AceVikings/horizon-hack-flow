// Route table for Lane B's HTTP server. Auth: Lane B resolves the bearer token to a scope (or null) and
// enforces `Origin` (must be absent or ate://local), the 32 KB body limit and per-route rate limits, then
// calls `handle(body, scope)`. Routes marked `auth: "none-for-step1"` must let an unauthenticated `{}`
// through (only /ui/attach step 1 is unauthenticated, §10.1).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TokenScope } from "@ate/core";
import type { ApprovalService, HandlerResult } from "./service.js";

export interface ApprovalRoute {
  method: "POST";
  path: "/ui/attach" | "/chat/session" | "/strategy/approve";
  /** Scopes accepted when a bearer token is present. */
  scopes: readonly TokenScope[];
  auth: "required" | "none-for-step1";
  handle: (body: unknown, scope: TokenScope | null) => Promise<HandlerResult>;
}

export function approvalRoutes(svc: ApprovalService): ApprovalRoute[] {
  return [
    {
      method: "POST",
      path: "/ui/attach",
      scopes: ["agent", "ui"],
      auth: "none-for-step1",
      handle: (body, scope) => {
        const empty = body === null || body === undefined || (typeof body === "object" && Object.keys(body).length === 0);
        // Step 2 must carry a bearer token (agent token from runtime.json); the signature is the real gate.
        if (!empty && scope !== "agent" && scope !== "ui") {
          return Promise.resolve({ status: 401, body: { ok: false as const, error: { code: "ATE_TOOL_NOT_ALLOWED", message: "bearer token required" } } });
        }
        return svc.uiAttach(body);
      },
    },
    { method: "POST", path: "/chat/session", scopes: ["agent", "ui"], auth: "required", handle: (b, s) => svc.chatSession(b, s) },
    { method: "POST", path: "/strategy/approve", scopes: ["ui", "session"], auth: "required", handle: (b, s) => svc.strategyApprove(b, s) },
  ];
}

const MAX_BODY = 32 * 1024;

/**
 * Optional plain node:http adapter. Returns true if the request matched an approval route (and was
 * answered). `resolveScope` maps the Authorization header to a scope (null if absent/invalid).
 */
export function createNodeApprovalHandler(
  svc: ApprovalService,
  resolveScope: (authorization: string | undefined) => TokenScope | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const routes = approvalRoutes(svc);
  return async (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    const route = routes.find((r) => r.path === url && r.method === req.method);
    if (!route) return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "ate://local") {
      send(403, { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: "browser origins are rejected" } });
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) {
        send(413, { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: "body > 32 KB" } });
        return true;
      }
      chunks.push(c as Buffer);
    }
    let body: unknown = {};
    if (size > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(400, { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: "invalid JSON" } });
        return true;
      }
    }
    const scope = resolveScope(req.headers.authorization);
    if (scope !== null && !route.scopes.includes(scope)) {
      send(403, { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: `scope ${scope} not allowed on ${route.path}` } });
      return true;
    }
    if (route.auth === "required" && scope === null) {
      send(401, { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: "bearer token required" } });
      return true;
    }
    const r = await route.handle(body, scope);
    send(r.status, r.body);
    return true;
  };
}
