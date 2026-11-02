// Loopback HTTP for the owner service. Every route except /health needs the supervisor's bearer token; the agent
// runtime (daemon, trader, chat) is never given it and has no route that reaches this service.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OwnerError } from "./ops.js";
import type { OwnerService } from "./service.js";

const LIMIT = 64 * 1024;

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > LIMIT) throw new OwnerError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!n) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OwnerError(400, "invalid JSON");
  }
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createOwnerServer(svc: OwnerService, token: string, log?: (m: string) => void): { server: Server; listen(port?: number, host?: string): Promise<number> } {
  if (token.length < 32) throw new Error("owner service token must be ≥ 32 chars");
  const server = createServer(async (req, res) => {
    const json = (s: number, v: unknown) => {
      res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    };
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") return json(200, { ok: true });
      if (req.headers.origin) return json(403, { error: "browser origins are not accepted" });
      const h = req.headers.authorization ?? "";
      if (!h.startsWith("Bearer ") || !same(h.slice(7), token)) return json(401, { error: "unauthorized" });
      if (req.method === "GET" && url.pathname === "/owner/state") return json(200, await svc.state());
      if (req.method === "POST" && url.pathname === "/owner/op") {
        const r = await svc.request(await body(req));
        return json("needsApproval" in r ? 428 : 200, r);
      }
      if (req.method === "POST" && url.pathname === "/owner/passkeys") {
        const r = await svc.addPasskey(await body(req));
        return json("needsApproval" in r ? 428 : 200, r);
      }
      return json(404, { error: "not found" });
    } catch (e) {
      const status = e instanceof OwnerError ? e.status : 500;
      if (status === 500) log?.(`owner: ${(e as Error).stack ?? e}`);
      json(status, { error: (e as Error).message.split("\n")[0] });
    }
  });
  return {
    server,
    listen: (port = 0, host = "127.0.0.1") => new Promise((r) => server.listen(port, host, () => r((server.address() as AddressInfo).port))),
  };
}
