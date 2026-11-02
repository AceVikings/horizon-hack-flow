// Integration-lane additions: /view CSP without inline script, ui MCP tool set, rogue hold + journalled rogue route
// guards, chat token/turn routes, Lane C's StrategyPatcher on ate_strategy_set (incl. loosening → approval).
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "@ate/core/fixtures";
import { createChainClient } from "@ate/chain";
import { Journal, migrate } from "@ate/journal";
import { connectDaemonClient } from "@ate/mcp";
import { AgentSigner } from "@ate/wallet";
import { registerChatRoutes } from "../src/chat.js";
import { DaemonHttp, Routes, TokenRegistry } from "../src/http.js";
import { AteService } from "../src/service.js";
import { loadStrategy } from "../src/strategy-stub.js";
import { TxQueue } from "../src/txqueue.js";

let http: DaemonHttp;
let svc: AteService;
const tokens = new TokenRegistry();
const exp = Math.floor(Date.now() / 1000) + 600;
const T = {
  agent: tokens.mint({ scope: "agent" }),
  ui: tokens.mint({ scope: "ui" }),
  rogue: tokens.mint({ scope: "rogue" }),
  session: tokens.mint({ scope: "session", sessionId: "chat_abc", expiresAt: exp }),
};
let base = "";
const events: { type: string; data: unknown }[] = [];

beforeAll(async () => {
  const db = new Database(":memory:");
  migrate(db);
  const journal = new Journal(db);
  const chain = createChainClient({ urls: ["http://127.0.0.1:9"], retries: 0 });
  const signer = new AgentSigner(FIXTURE_CONFIG.agentKeyId);
  const txq = new TxQueue({ chain: { pendingNonce: async () => 0, suggestFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), sendRaw: async () => "0x" as const, receipt: async () => null }, account: () => signer.get(), chainId: 177 });
  const strategy = await loadStrategy(() => svc.openProposals());
  expect(strategy.source).toBe("lane-c");
  expect(strategy.patcher).toBeDefined();
  const emit = (e: { type: string; at: number; data: unknown }) => {
    events.push(e);
    http?.broadcast(e);
  };
  svc = new AteService({ cfg: FIXTURE_CONFIG, db, journal, chain, signer, txq, strategy, candidateTtlSec: 180, version: "test", emit });
  const routes = new Routes();
  http = new DaemonHttp({ service: svc, tokens, routes, version: "test" });
  registerChatRoutes({ routes, tokens, service: svc, home: "/tmp", emit, runTurn: async (o) => ({ reply: `echo: ${o.text}`, engine: "rules", tool: "ate_positions" }) });
  base = `http://127.0.0.1:${await http.listen()}`;
});
afterAll(async () => http.close());

const post = (path: string, token: string, body: unknown) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/view CSP (§17.3)", () => {
  it("has no inline script; code is served from /view.js", async () => {
    const r = await fetch(base + "/view");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("script-src 'self'");
    const html = await r.text();
    expect(html).toContain('<script src="/view.js"></script>');
    expect(html).not.toMatch(/<script>/);
    const js = await fetch(base + "/view.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("/api/view/ate_positions");
  });
});

describe("ui scope over MCP", () => {
  it("gets the chat allowlist plus propose/execute", async () => {
    const ui = await connectDaemonClient(base + "/mcp", T.ui);
    const names = (await ui.listTools()).tools.map((t) => t.name);
    expect(names).toContain("ate_execute");
    expect(names).toContain("ate_propose");
    expect(names).not.toContain("ate_decide");
    await ui.close();
  });
});

describe("rogue routes (§22.3)", () => {
  it("/rogue/hold is rogue-only and returns the vault tx seq; stale seq → 409", async () => {
    expect((await post("/rogue/hold", T.agent, { market: "WHSK", seconds: 90 })).status).toBe(403);
    const h = await post("/rogue/hold", T.rogue, { market: "WHSK", seconds: 90 });
    expect(h.status).toBe(200);
    const j = (await h.json()) as { vaultTxSeq: number; heldUntil: number };
    expect(j.vaultTxSeq).toBe(0);
    const vault = FIXTURE_CONFIG.vaults.find((v) => v.market === "hsk-dex:WHSK/USDT:3000")!.address;
    const r = await post("/rogue/tx", T.rogue, { to: vault, data: "0x8456cb59", ifVaultTxSeq: 7, expected: "ERR_PAUSED" });
    expect(r.status).toBe(409);
    expect((await post("/rogue/hold", T.rogue, { market: "WHSK", seconds: 0 })).status).toBe(200);
  });
});

describe("chat routes", () => {
  it("/chat/token mints a chat token for the session; /chat runs a turn and streams chat.delta", async () => {
    const t = await post("/chat/token", T.session, {});
    expect(t.status).toBe(200);
    const tok = ((await t.json()) as { token: string }).token;
    expect(tokens.resolve(tok)?.scope).toBe("chat");
    expect((await post("/chat/token", T.ui, {})).status).toBe(403);
    expect((await post("/chat", T.session, { sessionId: "chat_other", text: "hi" })).status).toBe(403);
    const r = await post("/chat", T.session, { sessionId: "chat_abc", text: "how am I doing?" });
    expect(r.status).toBe(200);
    const { turnId } = (await r.json()) as { turnId: string };
    await new Promise((res) => setTimeout(res, 50));
    const done = events.find((e) => e.type === "chat.delta" && (e.data as { turnId: string; done: boolean }).turnId === turnId && (e.data as { done: boolean }).done);
    expect(done?.data).toMatchObject({ text: "echo: how am I doing?", engine: "rules" });
    expect(events.some((e) => e.type === "chat.tool")).toBe(true);
  });
  it("ui proposals without a candidate are origin=human (schema default origin=candidate notwithstanding)", async () => {
    const ui = await connectDaemonClient(base + "/mcp", T.ui);
    const r = (await ui.callTool({ name: "ate_propose", arguments: { market: "hsk-dex:WHSK/USDT:3000", side: "buy", amountIn: "5000000", rationale: "manual buy from the Trade view" } })) as { content: { text: string }[] };
    const j = JSON.parse(r.content[0]!.text) as { ok: boolean; error?: { code: string } };
    expect(j.error?.code).not.toBe("ATE_CANDIDATE_REQUIRED");
    await ui.close();
  });
  it("/trade/approve: unknown proposal → 404", async () => {
    expect((await post("/trade/approve", T.ui, { proposalId: "prop_0000000000000000" })).status).toBe(404);
  });
});

describe("ate_strategy_set via Lane C's StrategyPatcher", () => {
  it("tightening applies; loosening returns ATE_APPROVAL_REQUIRED with a changeId; agent non-tunable → ATE_TOOL_NOT_ALLOWED", async () => {
    const cur = svc.strategy.markets["hsk-dex:WHSK/USDT:3000"].stopLossBps;
    const tight = await svc.callTool("ui", "ate_strategy_set", { patch: { market: "hsk-dex:WHSK/USDT:3000", stopLossBps: Math.max(50, cur - 10) }, rationale: "tighten the HSK stop" });
    expect(tight).toMatchObject({ ok: true, data: { status: "applied" } });
    const loose = await svc.callTool("ui", "ate_strategy_set", { patch: { market: "hsk-dex:WHSK/USDT:3000", stopLossBps: cur + 500 }, rationale: "loosen the HSK stop" });
    expect(loose).toMatchObject({ ok: false, error: { code: "ATE_APPROVAL_REQUIRED" } });
    const changeId = (loose as unknown as { error: { details: { changeId: string } } }).error.details.changeId;
    expect(svc.pendingChange(changeId)).not.toBeNull();
    const pend = await fetch(`${base}/strategy/pending/${changeId}`, { headers: { authorization: `Bearer ${T.ui}` } });
    expect(pend.status).toBe(200);
    expect(await pend.json()).toMatchObject({ changeId, renderedDiff: expect.stringContaining("LOOSENING") });
    expect((await fetch(`${base}/strategy/pending/${changeId}`, { headers: { authorization: `Bearer ${T.agent}` } })).status).toBe(403);
    svc.applyPendingChange(changeId);
    expect(svc.strategy.markets["hsk-dex:WHSK/USDT:3000"].stopLossBps).toBe(cur + 500);
    const agentBad = await svc.callTool("agent", "ate_strategy_set", { patch: { stopLossBps: 100 }, rationale: "agent tries a human-only field" });
    expect(agentBad).toMatchObject({ ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED" } });
  });
  it("portfolio carries daily P&L and breaker state", () => {
    const pf = svc.portfolio();
    expect(pf.breaker.state).toBe("armed");
    expect(pf.dailyPnlUsd).toBe("0");
  });
});
