// The public HTTP server (TLS is terminated by the host). Static web app + auth + the web bridge + /api/events.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { DaemonEvent } from "@ate/core";
import { RateLimiter, type Auth, type Session } from "./auth.js";
import type { CloudBridge } from "./invoke.js";
import type { Runs } from "./runs.js";

const BODY_LIMIT = 64 * 1024;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };

export interface ServerDeps {
  auth: Auth;
  runs: Runs;
  bridge: CloudBridge;
  webDir: string;
  health: () => Record<string, unknown>;
  ownerAddPasskey: (ctx: Parameters<Parameters<Runs["start"]>[1]>[0], k: { id: string; publicKey: string; counter: number; transports?: string[] }) => Promise<unknown>;
  trustProxy: boolean;
  log: (m: string) => void;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > BODY_LIMIT) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

export function createGateway(d: ServerDeps) {
  const secure = d.auth.origin.startsWith("https://");
  const COOKIE = secure ? "__Host-flow" : "flow";
  const loginLimiter = new RateLimiter(10);
  const apiLimiter = new RateLimiter(600);
  const approveLimiter = new RateLimiter(30);
  const host = new URL(d.auth.origin).host;
  const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${secure ? "wss" : "ws"}://${host}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`;
  const sockets = new Map<WebSocket, string>();

  const ip = (req: IncomingMessage) => (d.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() : "") || req.socket.remoteAddress || "?";
  const cookie = (req: IncomingMessage) => {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE.replace(/[-]/g, "\\-")}=([^;]+)`).exec(req.headers.cookie ?? "");
    return m ? m[1]! : null;
  };
  const setCookie = (res: ServerResponse, v: string, maxAge: number) =>
    res.setHeader("set-cookie", `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);

  const base = (res: ServerResponse) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (secure) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  };
  const json = (res: ServerResponse, status: number, v: unknown) => {
    if (res.headersSent) return;
    base(res);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  };

  const outcome = (o: Awaited<ReturnType<Runs["start"]>>, res: ServerResponse) =>
    o.kind === "result"
      ? json(res, 200, { result: o.value })
      : void d.auth.assertionOptions(o.ask.challenge).then((options) => json(res, 200, { ticket: o.ticket, prompt: o.ask.prompt, options }));

  const serveStatic = (req: IncomingMessage, res: ServerResponse, path: string) => {
    const root = resolve(d.webDir);
    let p = normalize(join(root, decodeURIComponent(path)));
    if (!p.startsWith(root)) return json(res, 404, { error: "not found" });
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(root, "index.html");
    if (!existsSync(p)) return json(res, 503, { error: "web app not built" });
    base(res);
    const ext = extname(p);
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-security-policy": csp,
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(p).pipe(res);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const method = req.method ?? "GET";
      const path = url.pathname;
      if (path === "/healthz") return json(res, 200, d.health());
      if (method === "GET" || method === "HEAD") {
        if (path.startsWith("/api/") || path.startsWith("/auth/")) {
          if (path !== "/auth/state") return json(res, 404, { error: "not found" });
        } else return serveStatic(req, res, path);
      }
      // Every write must come from our own origin (CSRF, layer 1); authed writes also carry x-flow-csrf (layer 2).
      if (method !== "GET" && req.headers.origin !== d.auth.origin) return json(res, 403, { error: "bad origin" });
      const sess = d.auth.session(cookie(req));
      const needSession = (): Session | null => {
        if (!sess) return (json(res, 401, { error: "sign in" }), null);
        if (method !== "GET" && !d.auth.checkCsrf(sess, req.headers["x-flow-csrf"] as string | undefined)) return (json(res, 403, { error: "bad csrf token" }), null);
        return sess;
      };
      const login = (s: Session | null) => {
        if (!s) return json(res, 401, { error: "sign-in failed" });
        setCookie(res, s.id, 12 * 3600);
        return json(res, 200, { authenticated: true, csrf: s.csrf, via: s.via });
      };

      switch (`${method} ${path}`) {
        case "GET /auth/state":
          return json(res, 200, { authenticated: !!sess, ...(sess ? { csrf: sess.csrf, via: sess.via } : {}), passkeys: d.auth.passkeys().length, password: d.auth.passwordEnabled });
        case "POST /auth/password": {
          if (!loginLimiter.allow(`login:${ip(req)}`)) return json(res, 429, { error: "too many attempts; wait a minute" });
          const b = await readJson(req);
          return login(d.auth.passwordLogin(String(b.password ?? "")));
        }
        case "POST /auth/passkey/options":
          if (!loginLimiter.allow(`opts:${ip(req)}`)) return json(res, 429, { error: "too many attempts" });
          return json(res, 200, await d.auth.loginOptions());
        case "POST /auth/passkey/login": {
          if (!loginLimiter.allow(`login:${ip(req)}`)) return json(res, 429, { error: "too many attempts; wait a minute" });
          const b = await readJson(req);
          return login(await d.auth.passkeyLogin(b.flow, b.response));
        }
        case "POST /auth/logout":
          if (sess) d.auth.logout(sess.id);
          setCookie(res, "", 0);
          return json(res, 200, { authenticated: false });
        case "POST /auth/passkey/register/options": {
          if (!needSession()) return;
          return json(res, 200, await d.auth.registerOptions());
        }
        case "POST /auth/passkey/register": {
          const s = needSession();
          if (!s) return;
          const b = await readJson(req);
          const k = await d.auth.register(b.flow, b.response);
          if (!k) return json(res, 400, { error: "the passkey could not be registered" });
          // The same passkey approves owner actions: hand its public key to the owner service.
          return outcome(await d.runs.start(s.id, (ctx) => d.ownerAddPasskey(ctx, k)), res);
        }
        case "POST /api/rpc": {
          const s = needSession();
          if (!s) return;
          if (!apiLimiter.allow(`api:${s.id}`)) return json(res, 429, { error: "rate limited" });
          const b = await readJson(req);
          if (typeof b.method !== "string" || !Array.isArray(b.args) || b.args.length > 4) return json(res, 400, { error: "method and args[] required" });
          return outcome(await d.runs.start(s.id, (ctx) => d.bridge.dispatch(ctx, b.method, b.args)), res);
        }
        case "POST /api/approve": {
          const s = needSession();
          if (!s) return;
          if (!approveLimiter.allow(`ap:${s.id}`)) return json(res, 429, { error: "rate limited" });
          const b = await readJson(req);
          const next = d.runs.resume(s.id, String(b.ticket ?? ""), b.response && typeof b.response === "object" ? b.response : null);
          if (!next) return json(res, 410, { error: "this approval is no longer pending" });
          return outcome(await next, res);
        }
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (status === 500) d.log(`gateway: ${(e as Error).stack}`);
      json(res, status, { error: status === 500 ? "internal error" : (e as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const sess = d.auth.session(cookie(req));
    if (url.pathname !== "/api/events" || !sess || req.headers.origin !== d.auth.origin) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, sess.id);
      ws.on("close", () => sockets.delete(ws));
      ws.on("message", () => undefined);
    });
  });

  return {
    server,
    broadcast(e: DaemonEvent) {
      const s = JSON.stringify(e);
      for (const [ws, sid] of sockets) {
        if (!d.auth.session(sid)) {
          ws.close();
          continue;
        }
        if (ws.readyState === 1) ws.send(s);
      }
    },
  };
}
