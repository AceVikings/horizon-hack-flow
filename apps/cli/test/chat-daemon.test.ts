// `ate chat` ↔ daemon handshake against a fake daemon HTTP server (§10.1, §11.5).
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApproveError, chatSessionPayload, strategyPayload, type ApprovalPayload } from "@ate/approve";
import type { StrategyApprovalPending } from "@ate/core";
import {
  approveStrategyChange,
  changeIdsIn,
  chatMcpSpec,
  openChatSession,
  resolveDaemonBin,
  type ApprovalIo,
} from "../src/commands/c/_chat-daemon.js";

const AGENT = "agent-token-secret";
const SESSION = "session-token-secret";
const CHAT = "chat-token-secret";
const NONCE = "n".repeat(32);
const EXP = Math.floor(Date.now() / 1000) + 60;

interface Hit {
  path: string;
  auth: string | undefined;
  body: any;
}
let server: Server;
let port = 0;
const hits: Hit[] = [];
let home = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      hits.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      const send = (s: number, j: unknown) => {
        res.writeHead(s, { "content-type": "application/json" });
        res.end(JSON.stringify(j));
      };
      const bearer = req.headers.authorization?.replace(/^Bearer /, "");
      if (req.url === "/chat/session") {
        if (bearer !== AGENT) return send(401, { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: "bearer" } });
        if (!body.nonce) return send(200, { sessionId: "chat_0123456789abcdef", nonce: NONCE, expiresAt: EXP });
        if (body.approval === "bad") return send(401, { ok: false, error: { code: "ATE_APPROVAL_REQUIRED", message: "TTY code rejected (wrong)" } });
        return send(200, { sessionId: body.sessionId, sessionToken: SESSION, expiresAt: EXP + 1800 });
      }
      if (req.url === "/chat/token") {
        if (bearer !== SESSION) return send(403, { error: "session handle required" });
        return send(200, { sessionId: "chat_0123456789abcdef", token: CHAT, expiresAt: EXP + 1800, scope: "chat" });
      }
      if (req.url === "/strategy/approve") {
        if (bearer !== SESSION) return send(403, { ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", message: "scope" } });
        return send(200, { applied: true, decisionId: "dec_1", changes: [] });
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  home = mkdtempSync(join(tmpdir(), "ate-chat-test-"));
  writeFileSync(join(home, "runtime.json"), JSON.stringify({ pid: 4242, port, agentToken: AGENT, startedAt: 0, version: "test" }));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function io(answers: string[] = []): ApprovalIo & { logs: string[]; asked: string[] } {
  const logs: string[] = [];
  const asked: string[] = [];
  return { logs, asked, ask: async (q) => (asked.push(q), answers.shift() ?? ""), log: (l) => void logs.push(l) };
}

describe("ate chat → daemon session", () => {
  it("signs the daemon-issued chat_session payload and fetches the session's chat token", async () => {
    hits.length = 0;
    const signed: ApprovalPayload[] = [];
    const o = io();
    const s = await openChatSession({ env: { ATE_HOME: home }, io: o, signer: async (p) => (signed.push(p), "c2lnbmF0dXJl") });
    expect(signed).toEqual([chatSessionPayload({ sessionId: "chat_0123456789abcdef", nonce: NONCE, expiresAt: EXP })]);
    expect(hits.map((h) => h.path)).toEqual(["/chat/session", "/chat/session", "/chat/token"]);
    expect(hits[1]!.body).toEqual({ sessionId: "chat_0123456789abcdef", nonce: NONCE, approval: "c2lnbmF0dXJl" });
    expect(hits[0]!.auth).toBe(`Bearer ${AGENT}`);
    expect(hits[2]!.auth).toBe(`Bearer ${SESSION}`);
    expect(s).toMatchObject({ sessionId: "chat_0123456789abcdef", sessionToken: SESSION, chatToken: CHAT, home });
    // tokens never reach the user-visible log
    expect(o.logs.join("\n")).not.toMatch(/secret/);

    const spec = chatMcpSpec(s, "/x/bin.js");
    expect(spec).toEqual({ command: process.execPath, args: ["/x/bin.js", "mcp", "serve"], env: { ATE_MCP_TOKEN: CHAT, ATE_HOME: home } });
  });

  it("falls back to the daemon's 8-digit TTY code when ate-approve is not installed", async () => {
    hits.length = 0;
    const o = io(["12345678"]);
    await openChatSession({
      env: { ATE_HOME: home },
      io: o,
      signer: async () => {
        throw new ApproveError("not_installed", "missing");
      },
    });
    expect(o.asked[0]).toMatch(/8-digit code/);
    expect(hits[1]!.body.approval).toBe("12345678");
  });

  it("does not fall back when the user denies Touch ID", async () => {
    await expect(
      openChatSession({
        env: { ATE_HOME: home },
        io: io(["12345678"]),
        signer: async () => {
          throw new ApproveError("denied", "user cancelled");
        },
      }),
    ).rejects.toThrow(/user cancelled/);
  });

  it("surfaces daemon errors (rejected code)", async () => {
    await expect(openChatSession({ env: { ATE_HOME: home }, io: io(), signer: async () => "bad" })).rejects.toThrow(/ATE_APPROVAL_REQUIRED/);
  });

  it("reports a missing daemon clearly", async () => {
    await expect(openChatSession({ env: { ATE_HOME: join(home, "nope") }, io: io() })).rejects.toThrow(/daemon not running/);
  });
});

describe("loosening approvals", () => {
  const details: StrategyApprovalPending = {
    changeId: "chg_0123456789abcdef",
    diff: [{ scope: "hsk-dex:WHSK/USDT:3000", field: "stopLossBps", before: 50, after: 300, loosening: true }],
    renderedDiff: "WHSK stopLossBps 50 → 300",
    expiresAt: EXP,
  };
  const sess = () => ({ conn: { base: `http://127.0.0.1:${port}` }, sessionToken: SESSION });

  it("signs strategyPayload(details) and posts it with the session handle", async () => {
    hits.length = 0;
    const signed: ApprovalPayload[] = [];
    const r = await approveStrategyChange(sess(), { changeId: details.changeId, details }, { io: io(), signer: async (p) => (signed.push(p), "c2ln") });
    expect(r.applied).toBe(true);
    expect(signed).toEqual([strategyPayload(details)]);
    expect(hits[0]).toMatchObject({ path: "/strategy/approve", auth: `Bearer ${SESSION}`, body: { changeId: details.changeId, approval: "c2ln" } });
  });

  it("uses a TTY code when only the changeId is known", async () => {
    hits.length = 0;
    await approveStrategyChange(sess(), { changeId: details.changeId, details: null }, { io: io(["87654321"]) });
    expect(hits[0]!.body).toEqual({ changeId: details.changeId, approval: "87654321" });
  });

  it("finds daemon-issued changeIds in replies", () => {
    expect(changeIdsIn("needs Touch ID\nWHSK stop 0.5% → 3%\n(changeId chg_0123456789abcdef)")).toEqual(["chg_0123456789abcdef"]);
    expect(changeIdsIn("no change here")).toEqual([]);
  });

  it("resolves the daemon bin for the stdio proxy", () => {
    expect(resolveDaemonBin()).toMatch(/apps\/daemon\/dist\/bin\.js$/);
  });
});
