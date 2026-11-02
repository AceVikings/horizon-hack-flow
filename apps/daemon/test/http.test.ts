import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FIXTURE_CONFIG } from "@ate/core/fixtures";
import { createChainClient } from "@ate/chain";
import { Journal, migrate } from "@ate/journal";
import { connectDaemonClient, runStdioProxy } from "@ate/mcp";
import { AgentSigner } from "@ate/wallet";
import { DaemonHttp, Routes, TokenRegistry } from "../src/http.js";
import { AteService } from "../src/service.js";
import { loadStrategy } from "../src/strategy-stub.js";
import { TxQueue } from "../src/txqueue.js";

let http: DaemonHttp;
let svc: AteService;
const tokens = new TokenRegistry();
const T = { agent: tokens.mint({ scope: "agent" }), chat: tokens.mint({ scope: "chat" }), view: tokens.mint({ scope: "view" }), rogue: tokens.mint({ scope: "rogue" }) };
let base = "";
const R = "No edge after fees on either market this cycle.";

beforeAll(async () => {
  const db = new Database(":memory:");
  migrate(db);
  const journal = new Journal(db);
  const chain = createChainClient({ urls: ["http://127.0.0.1:9"], retries: 0 });
  const signer = new AgentSigner(FIXTURE_CONFIG.agentKeyId);
  const txq = new TxQueue({ chain: { pendingNonce: async () => 0, suggestFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), sendRaw: async () => "0x" as const, receipt: async () => null }, account: () => signer.get(), chainId: 177 });
  const strategy = await loadStrategy(() => svc.openProposals(), { forceStub: true });
  svc = new AteService({ cfg: FIXTURE_CONFIG, db, journal, chain, signer, txq, strategy, candidateTtlSec: 180, version: "test", emit: (e) => http?.broadcast(e) });
  http = new DaemonHttp({ service: svc, tokens, routes: new Routes(), version: "test" });
  base = `http://127.0.0.1:${await http.listen()}`;
});
afterAll(async () => http.close());

const get = (path: string, token?: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return JSON.parse(r.content[0]!.text) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };
}

describe("local API auth (§10.1)", () => {
  it("requires a bearer token and rejects browser origins", async () => {
    expect((await get("/status")).status).toBe(401);
    expect((await get("/status", T.agent)).status).toBe(200);
    expect((await get("/status", T.agent, { origin: "https://evil.example" })).status).toBe(403);
    expect((await get("/status", T.agent, { origin: "ate://local" })).status).toBe(200);
  });
  it("rogue raw route: agent token → 403; foreign `to` → refused", async () => {
    const post = (t: string, body: unknown) => fetch(base + "/rogue/tx", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(T.agent, { to: "0x00", data: "0x" })).status).toBe(403);
    expect((await post(T.rogue, { to: "0x000000000000000000000000000000000000beef", data: "0x8456cb59" })).status).toBe(403);
  });
  it("32 KB body limit", async () => {
    const r = await fetch(base + "/cycle", { method: "POST", headers: { authorization: `Bearer ${T.agent}` }, body: "x".repeat(40_000) });
    expect([403, 413]).toContain(r.status);
  });
  it("/view page is served with a CSP", async () => {
    const r = await get("/view");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("MCP over Streamable HTTP (§7.1)", () => {
  it("scope decides the tool set; chat cannot execute", async () => {
    const agent = await connectDaemonClient(base + "/mcp", T.agent);
    const chat = await connectDaemonClient(base + "/mcp", T.chat);
    expect((await agent.listTools()).tools).toHaveLength(11);
    expect((await chat.listTools()).tools.map((t) => t.name)).not.toContain("ate_execute");
    expect(await call(chat, "ate_execute", { proposalId: "prop_0000000000000001" })).toMatchObject({ ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED" } });
    await agent.close();
    await chat.close();
  });
  it("view token cannot open MCP", async () => {
    await expect(connectDaemonClient(base + "/mcp", T.view)).rejects.toThrow();
  });
  it("ate_decide journals with actor from scope; journal_read wraps agent text", async () => {
    const agent = await connectDaemonClient(base + "/mcp", T.agent);
    const d = await call(agent, "ate_decide", { decision: "no_trade", market: "hsk-dex:WBTC/USDT:3000", reason: "no_signal", rationale: R });
    expect(d.ok).toBe(true);
    const j = await call(agent, "ate_journal_read", { limit: 5 });
    const e = (j.data!.entries as { id: string; actor: unknown; rationale: string; kind: string }[])[0]!;
    expect(e).toMatchObject({ id: d.data!.decisionId, kind: "no_trade", actor: { kind: "agent", via: "mcp" } });
    expect(e.rationale).toBe(`<untrusted_agent_text>${R}</untrusted_agent_text>`);
    expect(svc.journal.verify().ok).toBe(true);
    await agent.close();
  });
  it("schema-invalid args → InvalidParams; autonomous propose without candidate → ATE_CANDIDATE_REQUIRED", async () => {
    const agent = await connectDaemonClient(base + "/mcp", T.agent);
    await expect(agent.callTool({ name: "ate_quote", arguments: { market: "hsk-dex:ETH/USDT:3000", side: "buy", amountIn: "1" } })).rejects.toThrow(/Invalid|invalid/);
    expect(await call(agent, "ate_propose", { market: "hsk-dex:WHSK/USDT:3000", side: "buy", amountIn: "5000000", rationale: R })).toMatchObject({ ok: false, error: { code: "ATE_CANDIDATE_REQUIRED" } });
    await agent.close();
  });
  it("strategy: agent clamp ×0.5–×1.5 and field allowlist; human loosening → ATE_APPROVAL_REQUIRED, tightening applies", async () => {
    const agent = await connectDaemonClient(base + "/mcp", T.agent);
    const chat = await connectDaemonClient(base + "/mcp", T.chat);
    const a = await call(agent, "ate_strategy_set", { patch: { market: "hsk-dex:WHSK/USDT:3000", entrySpreadBps: 10 }, rationale: R });
    expect(a).toMatchObject({ ok: true, data: { clamped: true } });
    expect((a.data!.strategy as { markets: Record<string, { entrySpreadBps: number }> }).markets["hsk-dex:WHSK/USDT:3000"]!.entrySpreadBps).toBe(30);
    expect(await call(agent, "ate_strategy_set", { patch: { stopLossBps: 900 }, rationale: R })).toMatchObject({ ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED" } });
    const loosen = await call(chat, "ate_strategy_set", { patch: { stopLossBps: 900 }, rationale: R });
    expect(loosen).toMatchObject({ ok: false, error: { code: "ATE_APPROVAL_REQUIRED" } });
    const changeId = (loosen.error as unknown as { details: { changeId: string } }).details.changeId;
    expect(svc.pendingChange(changeId)).not.toBeNull();
    expect(await call(chat, "ate_strategy_set", { patch: { stopLossBps: 200 }, rationale: R })).toMatchObject({ ok: true });
    const ch = svc.journal.list({ kind: ["strategy_change"], limit: 1 })[0]!;
    expect(ch.actor).toMatchObject({ kind: "human", via: "chat" });
    await agent.close();
    await chat.close();
  });
  it("stdio proxy forwards to the daemon with the agent token", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const p = await runStdioProxy({ url: base + "/mcp", token: T.agent, version: "test", downstream: serverT });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(clientT);
    expect((await c.listTools()).tools).toHaveLength(11);
    expect((await call(c, "ate_decide", { decision: "no_trade", market: "hsk-dex:WHSK/USDT:3000", reason: "llm_veto", rationale: R })).ok).toBe(true);
    await c.close();
    await p.close();
  });
});
