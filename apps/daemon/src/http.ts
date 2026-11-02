// Loopback HTTP API (§10.1): bearer tokens with scopes, Origin check, 32 KB bodies, 60 req/min per tool,
// Streamable HTTP MCP at /mcp (stateless, scope-bound server per request), /events WebSocket, /status,
// /cycle, /view (read-only page) + /api/view/*, the rogue raw route, unlock/lock. Lane E mounts the
// approval routes (/ui/attach, /chat/session, /strategy/approve) through `routes.register`.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AteError, type DaemonEvent, type TokenScope } from "@ate/core";
import { createAteMcpServer } from "@ate/mcp";
import { WebSocketServer, type WebSocket } from "ws";
import type { AteService } from "./service.js";
import { VIEW_HTML } from "./view.js";

export const BODY_LIMIT = 32 * 1024;
export const ALLOWED_ORIGIN = "ate://local";

export interface TokenInfo {
  scope: TokenScope;
  expiresAt?: number;
  /** For `session` tokens: the chat session they authorise. */
  sessionId?: string;
  /** Engine label for decisions made with this token (e.g. `rules` for --engine rules runners). */
  engine?: "llm" | "rules";
}

export class TokenRegistry {
  private tokens = new Map<string, TokenInfo>();
  mint(info: TokenInfo): string {
    const t = randomBytes(32).toString("base64url");
    this.tokens.set(t, info);
    return t;
  }
  resolve(token: string | undefined | null, now = Date.now() / 1000): TokenInfo | null {
    if (!token) return null;
    const i = this.tokens.get(token);
    if (!i) return null;
    if (i.expiresAt !== undefined && i.expiresAt < now) {
      this.tokens.delete(token);
      return null;
    }
    return i;
  }
  revoke(token: string) {
    this.tokens.delete(token);
  }
}

export type RouteHandler = (ctx: { req: IncomingMessage; res: ServerResponse; body: unknown; auth: TokenInfo | null; json: (status: number, v: unknown) => void }) => Promise<void> | void;

export interface RouteDef {
  method: string;
  path: string;
  /** Scopes allowed; `null` = unauthenticated (only /ui/attach step 1 per §10.1). */
  scopes: TokenScope[] | null;
  handler: RouteHandler;
}

export class Routes {
  readonly list: RouteDef[] = [];
  register(r: RouteDef) {
    this.list.push(r);
  }
  find(method: string, path: string) {
    return this.list.find((r) => r.method === method && r.path === path);
  }
}

class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly perMin: number) {}
  allow(key: string, now = Date.now()): boolean {
    const a = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (a.length >= this.perMin) {
      this.hits.set(key, a);
      return false;
    }
    a.push(now);
    this.hits.set(key, a);
    return true;
  }
}

export interface HttpOptions {
  service: AteService;
  tokens: TokenRegistry;
  routes: Routes;
  version: string;
  port?: number;
  host?: string;
  unlock?: (passphrase: string) => Promise<string>;
  log?: (m: string) => void;
}

function bearer(req: IncomingMessage, url: URL): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return url.searchParams.get("token");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > BODY_LIMIT) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  if (!n) return undefined;
  const s = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(s);
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

export class DaemonHttp {
  server: HttpServer;
  wss: WebSocketServer;
  port = 0;
  private sockets = new Set<WebSocket>();
  private toolLimiter = new RateLimiter(60);
  private routeLimiter = new RateLimiter(120);

  constructor(private readonly o: HttpOptions) {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const auth = this.o.tokens.resolve(bearer(req, url));
      if (url.pathname !== "/events" || !auth || !this.originOk(req, auth)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.on("close", () => this.sockets.delete(ws));
      });
    });
    this.registerCore();
  }

  broadcast(e: DaemonEvent | { type: string; at: number; data: unknown }) {
    const s = JSON.stringify(e);
    for (const ws of this.sockets) if (ws.readyState === 1) ws.send(s);
  }

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(this.o.port ?? 0, this.o.host ?? "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  async close() {
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Origin, if present, must be ate://local; the /view page's own origin is allowed for `view`/`ui` reads. */
  private originOk(req: IncomingMessage, auth: TokenInfo | null): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (origin === ALLOWED_ORIGIN) return true;
    const self = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
    return !!auth && (auth.scope === "view" || auth.scope === "ui") && self.includes(origin);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const json = (status: number, v: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(v));
    };
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      if (method === "GET" && (url.pathname === "/view" || url.pathname === "/view/")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        });
        res.end(VIEW_HTML);
        return;
      }
      const auth = this.o.tokens.resolve(bearer(req, url));
      const route = this.o.routes.find(method, url.pathname);
      if (route && route.scopes === null) {
        if (!this.originOk(req, auth)) return json(403, { error: "forbidden origin" });
        if (!this.routeLimiter.allow(`anon:${url.pathname}`)) return json(429, { error: "rate limited" });
        const body = method === "GET" ? undefined : await readBody(req);
        return await route.handler({ req, res, body, auth, json });
      }
      if (!auth) return json(401, { error: "missing or invalid bearer token" });
      if (!this.originOk(req, auth)) return json(403, { error: "forbidden origin" });

      if (url.pathname === "/mcp") return await this.mcp(req, res, auth, json);

      if (route) {
        if (!route.scopes?.includes(auth.scope)) return json(403, { error: `scope ${auth.scope} may not call ${route.path}` });
        if (!this.routeLimiter.allow(`${auth.scope}:${route.path}`)) return json(429, { error: "rate limited" });
        const body = method === "GET" ? undefined : await readBody(req);
        return await route.handler({ req, res, body, auth, json });
      }
      if (method === "GET" && url.pathname.startsWith("/api/view/")) {
        if (!["view", "ui", "agent", "chat", "session"].includes(auth.scope)) return json(403, { error: "forbidden" });
        const tool = url.pathname.slice("/api/view/".length);
        const args = Object.fromEntries([...url.searchParams.entries()].filter(([k]) => k !== "token").map(([k, v]) => [k, k === "limit" ? Number(v) : v]));
        if (!this.toolLimiter.allow(`${auth.scope}:${tool}`)) return json(429, { error: "rate limited" });
        try {
          return json(200, await this.o.service.callTool("view", tool, args));
        } catch (e) {
          return json(400, { error: (e as Error).message });
        }
      }
      return json(404, { error: "not found" });
    } catch (e) {
      const status = (e as { status?: number }).status ?? (e instanceof AteError ? 400 : 500);
      if (status === 500) this.o.log?.(`http: ${(e as Error).stack}`);
      json(status, e instanceof AteError ? { error: e.toToolError() } : { error: (e as Error).message });
    }
  }

  private async mcp(req: IncomingMessage, res: ServerResponse, auth: TokenInfo, json: (s: number, v: unknown) => void) {
    if (auth.scope !== "agent" && auth.scope !== "chat") return json(403, { error: "MCP requires an agent or chat token" });
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }));
      return;
    }
    const body = await readBody(req);
    const scope = auth.scope;
    const svc = this.o.service;
    const engine = auth.engine;
    const server = createAteMcpServer(
      {
        listTools: () => svc.listTools(scope),
        callTool: async (name, args) => {
          if (!this.toolLimiter.allow(`${scope}:${name}`)) {
            return { ok: false, error: { code: "ATE_RPC_RATE_LIMITED", message: "60 req/min per tool exceeded", retryable: true } };
          }
          return svc.callTool(scope, name, args, engine ? { engine } : {});
        },
      },
      { version: this.o.version, instructions: `ATE daemon (scope=${scope}). Two markets: hsk-dex:WHSK/USDT:3000, hsk-dex:WBTC/USDT:3000.` },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private registerCore() {
    const svc = this.o.service;
    const r = this.o.routes;
    r.register({ method: "GET", path: "/status", scopes: ["agent", "chat", "ui", "session", "view", "rogue"], handler: ({ json }) => json(200, svc.status()) });
    r.register({ method: "POST", path: "/cycle", scopes: ["ui", "session"], handler: ({ json }) => json(200, svc.requestCycle("manual")) });
    r.register({
      method: "POST",
      path: "/unlock",
      scopes: ["agent", "ui", "session"],
      handler: async ({ body, json }) => {
        const pass = (body as { passphrase?: string })?.passphrase;
        if (!pass || !this.o.unlock) return json(400, { error: "passphrase required" });
        try {
          const addr = await this.o.unlock(pass);
          return json(200, { unlocked: true, address: addr });
        } catch (e) {
          return json(401, { error: e instanceof AteError ? e.toToolError() : (e as Error).message });
        }
      },
    });
    r.register({ method: "POST", path: "/lock", scopes: ["agent", "ui", "session"], handler: ({ json }) => (svc.lock("manual"), json(200, { locked: true })) });
    r.register({
      method: "POST",
      path: "/rogue/tx",
      scopes: ["rogue"],
      handler: async ({ body, json }) => {
        try {
          json(200, await svc.rogueBroadcast(body as { to: string; data: string; gas?: string; rationale?: string }));
        } catch (e) {
          json(e instanceof AteError && e.code === "ATE_TOOL_NOT_ALLOWED" ? 403 : 400, { error: e instanceof AteError ? e.toToolError() : (e as Error).message });
        }
      },
    });
    r.register({
      method: "POST",
      path: "/smoke",
      scopes: ["agent"],
      handler: async ({ body, json }) => {
        const b = body as { market?: string; usd?: string };
        if (!b?.market || !/^(hsk-dex:WHSK\/USDT:3000|hsk-dex:WBTC\/USDT:3000)$/.test(b.market) || !/^[0-9]+(\.[0-9]{1,2})?$/.test(b.usd ?? "")) return json(400, { error: "market and usd required" });
        await svc.refresh(5).catch(() => null);
        json(200, { candidate: svc.addSmokeCandidate(b.market as never, b.usd!) });
      },
    });
    r.register({
      method: "POST",
      path: "/journal/verify",
      scopes: ["agent", "ui", "view", "session", "rogue"],
      handler: ({ json }) => json(200, svc.journal.verify()),
    });
  }
}
