// OpenCode engine against a mocked `opencode serve`: models with tool calling, a prompt that enables only the scope's
// Flow tools (built-ins off), tool calls parsed for chat cards, hard abort at the cycle deadline, automatic default
// when an opencode login exists, and the journal label actor.agentId = "opencode:<model>".
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiEngine } from "../src/engine.js";
import { TokenRegistry } from "../src/http.js";
import { OpencodeEngine } from "../src/opencode.js";

let srv: Server;
let base = "";
const seen: { method: string; url: string; body: unknown }[] = [];
let hang = false;

beforeAll(async () => {
  srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : undefined;
      seen.push({ method: req.method!, url: req.url!, body });
      const send = (v: unknown) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(v)));
      const u = req.url!.split("?")[0]!;
      if (u === "/config/providers")
        return send({ providers: [{ id: "opencode", name: "OpenCode", source: "api", env: [], options: {}, models: { "deepseek-v4.1-flash": { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", capabilities: { toolcall: true } }, "img-1": { id: "img-1", name: "Image", capabilities: { toolcall: false } } } }], default: {} });
      if (u === "/experimental/tool/ids") return send(["bash", "read", "flowagent_ate_positions", "flowagent_ate_decide", "flowchat_ate_positions"]);
      if (u === "/session" && req.method === "POST") return send({ id: "ses_1" });
      if (u.endsWith("/abort")) return send(true);
      if (u.endsWith("/message")) {
        if (hang) return; // never answers: the engine must give up at the abort
        return send({
          info: { modelID: "deepseek-v4.1-flash", tokens: { input: 10, output: 4, cache: { read: 3, write: 0 } }, finish: "stop" },
          parts: [
            { type: "tool", tool: (body as { tools: Record<string, boolean> }).tools.flowchat_ate_positions ? "flowchat_ate_positions" : "flowagent_ate_positions", state: { status: "completed", input: {}, output: JSON.stringify({ ok: true, data: { markets: [] } }) } },
            { type: "text", text: "Nothing to do this cycle." },
          ],
        });
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(() => srv.close());

const home = () => mkdtempSync(join(tmpdir(), "flow-oc-"));

describe("OpenCode engine (mocked opencode serve)", () => {
  it("lists tool-calling models and prompts with only the scope's Flow tools enabled", async () => {
    const tokens = new TokenRegistry();
    const oc = new OpencodeEngine({ home: home(), daemonPort: 1, tokens, baseUrl: base });
    const ms = await oc.models();
    expect(ms).toEqual([
      { id: "opencode/deepseek-v4.1-flash", label: "OpenCode · DeepSeek V4.1 Flash", tools: true, streaming: false },
      { id: "opencode/img-1", label: "OpenCode · Image", tools: false, streaming: false },
    ]);
    const r = await oc.prompt({ scope: "agent", model: "opencode/deepseek-v4.1-flash", system: "sys", text: "cycle 1", toolNames: ["ate_positions", "ate_decide"], agentId: "opencode:opencode/deepseek-v4.1-flash" });
    expect(r).toMatchObject({ text: "Nothing to do this cycle.", stop: "end_turn", sessionId: "ses_1", calls: [{ tool: "ate_positions", ok: true, output: { ok: true } }] });
    const body = seen.find((x) => x.url.startsWith("/session/ses_1/message"))!.body as { model: unknown; system: string; tools: Record<string, boolean> };
    expect(body.model).toEqual({ providerID: "opencode", modelID: "deepseek-v4.1-flash" });
    expect(body.tools).toMatchObject({ bash: false, read: false, edit: false, webfetch: false, flowchat_ate_positions: false, flowagent_ate_positions: true, flowagent_ate_decide: true });
  });

  it("gives up at the abort and aborts the opencode session", async () => {
    hang = true;
    const oc = new OpencodeEngine({ home: home(), daemonPort: 1, tokens: new TokenRegistry(), baseUrl: base });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const t0 = Date.now();
    await expect(oc.prompt({ scope: "agent", model: "opencode/deepseek-v4.1-flash", system: "s", text: "x", toolNames: [], signal: ac.signal, agentId: "opencode:x" })).rejects.toThrow(/abort/);
    expect(Date.now() - t0).toBeLessThan(1500);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((x) => x.url.startsWith("/session/ses_1/abort"))).toBe(true);
    hang = false;
  });

  it("is the default when an opencode login exists and no subscription is signed in; chat gets tool cards", async () => {
    const h = home();
    const auth = join(h, "auth.json");
    writeFileSync(auth, JSON.stringify({ opencode: { type: "api", key: "x" } }));
    const env = { ATE_KEYSTORE: "file", ATE_OPENCODE_AUTH: auth };
    const oc = new OpencodeEngine({ home: h, daemonPort: 1, tokens: new TokenRegistry(), baseUrl: base, env });
    const ai = new AiEngine(h, env, {}, undefined, oc);
    expect(ai.config.provider).toBe("opencode");
    await ai.test("opencode");
    expect(ai.effectiveModel()).toBe("opencode/deepseek-v4.1-flash");
    const c = ai.conversation();
    ai.pushUser(c, "How am I doing?");
    const cards: string[] = [];
    const texts: string[] = [];
    const r = await ai.run("chat", c, { effort: "low", system: "s", toolNames: ["ate_positions"], call: async () => ({ content: "", isError: false }), onToolCall: (n) => cards.push(n), onText: (t) => texts.push(t) });
    expect(r.text).toBe("Nothing to do this cycle.");
    expect(cards).toEqual(["ate_positions"]);
    expect(texts).toEqual(["Nothing to do this cycle."]);
    // an explicit choice sticks (Flow stops choosing for the user)
    ai.setConfig({ provider: "anthropic" });
    expect(new AiEngine(h, env, {}, undefined, oc).config.provider).toBe("anthropic");
  });
});
