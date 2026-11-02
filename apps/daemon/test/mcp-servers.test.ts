// Tools (MCP): a user-added stdio server (fake, built on the MCP SDK) with an env secret kept out of mcp.json,
// connect + tool list, per-agent enable (trader off by default; turning it on needs Touch ID or the one-time code),
// and the in-app engine offering + calling the extra tool for the chat agent only.
import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "@ate/core/fixtures";
import { createChainClient } from "@ate/chain";
import { Journal, migrate } from "@ate/journal";
import { AgentSigner } from "@ate/wallet";
import { registerAppRoutes } from "../src/app-routes.js";
import { AiEngine, type LoopClient } from "../src/engine.js";
import { DaemonHttp, Routes, TokenRegistry } from "../src/http.js";
import { McpServers } from "../src/mcp-servers.js";
import { ProviderKeys } from "../src/providers.js";
import { AteService } from "../src/service.js";
import { loadStrategy } from "../src/strategy-stub.js";
import { TxQueue } from "../src/txqueue.js";

const req = createRequire(import.meta.url);
const esm = (m: string) => req.resolve(m).replace("/dist/cjs/", "/dist/esm/");
const FAKE = (dir: string) => {
  const p = join(dir, "fake-mcp.mjs");
  writeFileSync(
    p,
    `import { McpServer } from "${esm("@modelcontextprotocol/sdk/server/mcp.js")}";
import { StdioServerTransport } from "${esm("@modelcontextprotocol/sdk/server/stdio.js")}";
const s = new McpServer({ name: "fake", version: "1.0.0" });
s.tool("echo_secret_len", "Length of the configured secret", async () => ({ content: [{ type: "text", text: String((process.env.FAKE_TOKEN ?? "").length) }] }));
await s.connect(new StdioServerTransport());`,
  );
  return p;
};

const home = mkdtempSync(join(tmpdir(), "flow-mcp-"));
const env = { ATE_KEYSTORE: "file", ATE_OPENCODE_CONFIG_DIR: join(home, "no-opencode"), ANTHROPIC_API_KEY: "sk-ant-test", ATE_AI_PROVIDER: "anthropic" };
const reg = new McpServers(home, new ProviderKeys(home, env), env);
afterAll(() => reg.closeAll());

describe("MCP servers registry", () => {
  let id = "";
  it("adds a stdio server, keeps its env secret out of mcp.json, connects and lists tools", async () => {
    const d = reg.add({ name: "Fake tools", type: "stdio", command: process.execPath, args: [FAKE(home)], env: { FAKE_TOKEN: "s3cret-value" } });
    id = d.id;
    expect(d.enabled).toEqual({ chat: true, trader: false });
    expect(readFileSync(join(home, "mcp.json"), "utf8")).not.toContain("s3cret-value");
    const st = await reg.test(id);
    expect(st).toMatchObject({ state: "connected", tools: [{ name: "echo_secret_len" }] });
    expect(reg.status()[0]).toMatchObject({ id: "flow", state: "connected", enabled: { chat: true, trader: true } });
    expect(reg.extraTools("chat").map((t) => t.name)).toEqual([`mcp__${id.replace(/-/g, "_")}__echo_secret_len`]);
    expect(reg.extraTools("trader")).toEqual([]);
    expect(await reg.call("chat", reg.extraTools("chat")[0]!.name, {})).toEqual({ content: "12", isError: false });
    expect((await reg.call("trader", reg.extraTools("chat")[0]!.name, {})).isError).toBe(true);
  }, 30_000);

  it("the chat agent is offered the extra tool and its call goes to the MCP server", async () => {
    const calls: Record<string, unknown>[] = [];
    const script = [
      { content: [{ type: "tool_use", id: "t1", name: reg.extraTools("chat")[0]!.name, input: {} }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    ];
    const client = {
      beta: { messages: { stream: (p: Record<string, unknown>) => (calls.push(JSON.parse(JSON.stringify(p))), { on() {}, finalMessage: async () => ({ model: "m", usage: {}, stop_details: null, ...script.shift()! }) }) } },
    } as unknown as LoopClient & Anthropic;
    const ai = new AiEngine(home, env, { anthropic: () => client }, undefined, undefined, reg);
    const c = ai.conversation("chat");
    ai.pushUser(c, "x");
    let flowCalls = 0;
    await ai.run("chat", c, { effort: "low", system: "s", toolNames: ["ate_positions"], call: async () => (flowCalls++, { content: "{}", isError: false }) });
    expect((calls[0]!.tools as { name: string }[]).map((t) => t.name)).toContain(reg.extraTools("chat")[0]!.name);
    expect(flowCalls).toBe(0);
    const last = (calls[1]!.messages as { content: { type: string; content?: string }[] }[]).at(-1)!.content[0]!;
    expect(last).toMatchObject({ type: "tool_result", content: "12" });
    // the trader is not offered it
    const tc = ai.conversation("trader");
    ai.pushUser(tc, "y");
    script.push({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    await ai.run("trader", tc, { effort: "low", system: "s", toolNames: ["ate_positions"], call: async () => ({ content: "{}", isError: false }) });
    expect((calls[2]!.tools as { name: string }[]).map((t) => t.name).some((n) => n.startsWith("mcp__"))).toBe(false);
  }, 30_000);
});

describe("/engine/mcp routes", () => {
  let http: DaemonHttp;
  let base = "";
  const tokens = new TokenRegistry();
  const ui = tokens.mint({ scope: "ui" });
  beforeAll(async () => {
    const db = new Database(":memory:");
    migrate(db);
    const signer = new AgentSigner(FIXTURE_CONFIG.agentKeyId);
    const txq = new TxQueue({ chain: { pendingNonce: async () => 0, suggestFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), sendRaw: async () => "0x" as const, receipt: async () => null }, account: () => signer.get(), chainId: 177 });
    let svc!: AteService;
    const strategy = await loadStrategy(() => svc.openProposals());
    svc = new AteService({ cfg: FIXTURE_CONFIG, db, journal: new Journal(db), chain: createChainClient({ urls: ["http://127.0.0.1:9"], retries: 0 }), signer, txq, strategy, candidateTtlSec: 180, version: "test", emit: () => {} });
    const routes = new Routes();
    http = new DaemonHttp({ service: svc, tokens, routes, version: "test" });
    const port = await http.listen();
    registerAppRoutes({ routes, tokens, service: svc, home, port, deploymentsPath: null, ai: new AiEngine(home, env, {}, undefined, undefined, reg), approval: { verifier: null, tty: { issue: () => "12345678", redeem: (_p, _n, c) => ({ ok: c === "12345678" }) } } });
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => http.close());
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { authorization: `Bearer ${ui}`, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<Record<string, unknown>>);

  it("chat toggles at once; turning a server on for the trader needs Touch ID or the one-time code", async () => {
    const id = reg.list().find((d) => d.source === "user")!.id;
    await post("/engine/mcp/enable", { id, agent: "chat", on: false });
    expect(reg.list().find((d) => d.id === id)!.enabled.chat).toBe(false);
    const s1 = await post("/engine/mcp/enable", { id, agent: "trader", on: true });
    expect(s1).toMatchObject({ codeIssued: true, payload: { kind: "config" } });
    expect(reg.list().find((d) => d.id === id)!.enabled.trader).toBe(false);
    await post("/engine/mcp/enable", { nonce: s1.nonce, approval: "12345678" });
    expect(reg.list().find((d) => d.id === id)!.enabled.trader).toBe(true);
    expect(((await post("/engine/mcp/enable", { id: "flow", agent: "chat", on: false })).error as { message: string }).message).toMatch(/always on/);
    const list = (await (await fetch(base + "/engine/mcp", { headers: { authorization: `Bearer ${ui}` } })).json()) as { servers: { id: string }[] };
    expect(list.servers.map((x) => x.id)).toEqual(["flow", id]);
  });
});
