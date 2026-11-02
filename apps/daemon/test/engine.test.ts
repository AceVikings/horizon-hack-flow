// In-app agent engine with a mocked Anthropic client: request shape (model, effort, strict tools, caching,
// fallbacks), the tool loop (parallel results in one message, refusal / max_tokens never run tools), strict → plain
// schema fallback on a 400, the trader executor (agent scope, dry run without ate_execute), chat streaming + tool
// cards, and the API key store.
import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiEngine, runToolLoop, strictSchema, toolsFor, type LoopClient } from "../src/engine.js";
import { createSdkTraderExecutor, runSdkChatTurn } from "../src/engine-agents.js";
import { openaiStrictSchema, runGeminiLoop, runOpenAILoop, type OpenAILike, type GeminiLike } from "../src/providers.js";

type Msg = { content: unknown[]; stop_reason: string; stop_details?: unknown; model?: string; usage?: Record<string, number> };

function mockClient(script: (Msg | Error)[]) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          calls.push(JSON.parse(JSON.stringify(params)));
          const next = script.shift();
          let onText: ((d: string) => void) | null = null;
          return {
            on(_ev: "text", f: (d: string) => void) {
              onText = f;
              return this;
            },
            async finalMessage() {
              if (!next) throw new Error("script exhausted");
              if (next instanceof Error) throw next;
              for (const b of next.content as { type: string; text?: string }[]) if (b.type === "text" && onText) onText(b.text!);
              return { model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, stop_details: null, ...next };
            },
          };
        },
      },
    },
    models: { retrieve: async () => ({ id: "claude-opus-5-5" }) },
  };
  return { client: client as unknown as LoopClient & Anthropic, calls };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

describe("runToolLoop", () => {
  it("sends the documented request shape and returns all tool results in one user message", async () => {
    const { client, calls } = mockClient([
      { content: [{ type: "text", text: "Checking." }, toolUse("t1", "ate_positions", {}), toolUse("t2", "ate_market_get", {})], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "All good." }], stop_reason: "end_turn" },
    ]);
    const messages: Parameters<typeof runToolLoop>[1]["messages"] = [{ role: "user", content: "How am I doing?" }];
    const seen: string[] = [];
    const r = await runToolLoop(client, {
      model: "claude-opus-5-5",
      effort: "low",
      system: "frozen system",
      tools: toolsFor(["ate_positions", "ate_market_get"]),
      messages,
      call: async (n) => (seen.push(n), { content: JSON.stringify({ ok: true }), isError: false }),
    });
    expect(r.stop).toBe("end_turn");
    expect(r.text).toBe("Checking.\nAll good.");
    expect(seen.sort()).toEqual(["ate_market_get", "ate_positions"]);
    expect(r.usage.cacheReadTokens).toBe(14);
    const p = calls[0]!;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.output_config).toEqual({ effort: "low" });
    expect(p.tool_choice).toEqual({ type: "auto" });
    expect(p).not.toHaveProperty("thinking");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.fallbacks).toBe("default");
    expect(p.cache_control).toEqual({ type: "ephemeral" });
    expect((p.system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: "ephemeral" });
    const tools = p.tools as { name: string; strict?: boolean; input_schema: { additionalProperties?: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(["ate_market_get", "ate_positions"]); // sorted: stable cache prefix
    expect(tools.every((t) => t.strict === true && t.input_schema.additionalProperties === false)).toBe(true);
    // append-only history: user, assistant(tool_use), user(2 tool_results), assistant(final)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect((messages[2]!.content as unknown[]).length).toBe(2);
  });

  it("never runs tools on a refusal or a max_tokens cut", async () => {
    for (const stop of ["refusal", "max_tokens"]) {
      const { client } = mockClient([{ content: [toolUse("t1", "ate_execute", { proposalId: "prop_0000000000000000" })], stop_reason: stop, stop_details: stop === "refusal" ? { category: "cyber", explanation: "x" } : null }]);
      let ran = 0;
      const r = await runToolLoop(client, { model: "claude-opus-5-5", effort: "low", system: "s", tools: [], messages: [{ role: "user", content: "x" }], call: async () => (ran++, { content: "", isError: false }) });
      expect(r.stop).toBe(stop);
      expect(ran).toBe(0);
      if (stop === "refusal") expect(r.refusal?.category).toBe("cyber");
    }
  });

  it("Haiku 5.5 gets no server-side fallback", async () => {
    const { client, calls } = mockClient([{ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }]);
    await runToolLoop(client, { model: "claude-haiku-5-5", effort: "low", system: "s", tools: [], messages: [{ role: "user", content: "x" }], call: async () => ({ content: "", isError: false }) });
    expect(calls[0]).not.toHaveProperty("fallbacks");
    expect(calls[0]).not.toHaveProperty("betas");
  });
});

describe("strict schemas", () => {
  it("closes objects and moves unsupported keywords into the description", () => {
    const s = strictSchema({ type: "object", properties: { rationale: { type: "string", minLength: 16, maxLength: 1000 } }, required: ["rationale"] });
    expect(s.additionalProperties).toBe(false);
    const r = (s.properties as Record<string, Record<string, unknown>>).rationale!;
    expect(r).not.toHaveProperty("minLength");
    expect(String(r.description)).toContain("minLength 16");
  });
});

describe("AiEngine", () => {
  const home = () => mkdtempSync(join(tmpdir(), "ate-ai-"));
  const anth = (client: LoopClient & Anthropic) => ({ anthropic: () => client });

  it("falls back to plain tool schemas after a strict-mode 400", async () => {
    const bad = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "schema" } }, "schema", new Headers());
    const { client, calls } = mockClient([bad, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
    const ai = new AiEngine(home(), { ATE_KEYSTORE: "file", ANTHROPIC_API_KEY: "sk-ant-test" }, anth(client));
    const c = ai.conversation();
    ai.pushUser(c, "x");
    const r = await ai.run("chat", c, { effort: "low", system: "s", toolNames: ["ate_positions"], call: async () => ({ content: "", isError: false }) });
    expect(r.text).toBe("ok");
    expect((calls[0]!.tools as { strict?: boolean }[])[0]!.strict).toBe(true);
    expect((calls[1]!.tools as { strict?: boolean }[])[0]).not.toHaveProperty("strict");
    expect(ai.strictOk.anthropic).toBe(false);
  });

  it("stores a pasted key per provider (file mode), never in ai.json or health", async () => {
    const h = home();
    const openai: OpenAILike = { chat: { completions: { create: async () => ({}) } }, models: { list: async () => (async function* () { yield { id: "gpt-x" }; yield { id: "text-embedding-3" }; })() } } as never;
    const ai = new AiEngine(h, { ATE_KEYSTORE: "file" }, { openai: () => openai });
    expect(ai.credentialOf("openai").source).toBe("none");
    await expect(ai.setKey("not a key", "openai")).rejects.toThrow(/API key/);
    const key = "sk-proj-" + "x".repeat(40);
    await ai.setKey(key, "openai");
    const st = ai.providers().find((p) => p.id === "openai")!;
    expect(st).toMatchObject({ configured: true, credential: { source: "file", stored: true, hint: "…xxxx" }, health: { ok: true } });
    expect(st.models.map((m) => m.id)).toEqual(["gpt-x"]); // embeddings are filtered out
    expect(readFileSync(join(h, "keys", "openai-api-key"), "utf8")).toBe(key);
    ai.setConfig({ provider: "openai", model: "gpt-x" });
    expect(readFileSync(join(h, "ai.json"), "utf8")).not.toContain("sk-");
    expect(JSON.stringify(ai.providers())).not.toContain(key);
    expect(new AiEngine(h, { ATE_KEYSTORE: "file" }).config).toMatchObject({ provider: "openai", model: "gpt-x" });
    ai.clearKey("openai");
    expect(ai.credentialOf("openai").source).toBe("none");
  });

  it("defaults to Anthropic / Opus 5.5 with low effort; refuses a model without tool use", () => {
    const h = home();
    const ai = new AiEngine(h, { ATE_KEYSTORE: "file" });
    expect(ai.config).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", engine: "sdk", traderEffort: "low", chatEffort: "low" });
    writeFileSync(join(h, "ai.json"), JSON.stringify({ provider: "anthropic", model: "claude-opus-5-5", models: { ollama: [{ id: "tiny", label: "tiny", tools: false, streaming: true }] } }));
    const ai2 = new AiEngine(h, { ATE_KEYSTORE: "file" });
    expect(() => ai2.setConfig({ provider: "ollama", model: "tiny" })).toThrow(/does not support tool use/);
    expect(() => ai2.setConfig({ provider: "openai", engine: "claude-code" })).toThrow();
    expect(ai2.configured("ollama")).toBe(true); // local, no key
    expect(ai2.configured("proxy")).toBe(false); // needs a base URL
    ai2.setProviderSettings("proxy", { baseURL: "http://127.0.0.1:8317/v1", protocol: "openai" });
    expect(ai2.configured("proxy")).toBe(true);
    expect(ai2.providers().find((p) => p.id === "proxy")!.warning).toMatch(/terms/);
  });
});

describe("OpenAI-compatible and Gemini loops", () => {
  it("OpenAI: strict nullable schemas, streamed tool-call assembly, nulls dropped before the daemon sees them", async () => {
    const s = openaiStrictSchema({ type: "object", required: ["market"], properties: { market: { type: "string", enum: ["a"] }, candidateId: { type: "string" } } });
    expect(s.required).toEqual(["market", "candidateId"]);
    expect((s.properties as Record<string, { type: unknown }>).candidateId!.type).toEqual(["string", "null"]);
    const bodies: Record<string, unknown>[] = [];
    const turns = [
      [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "ate_positions", arguments: '{"market":' } }] }, finish_reason: null }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a","candidateId":null}' } }] }, finish_reason: "tool_calls" }] }],
      [{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }],
    ];
    const client: OpenAILike = {
      chat: { completions: { create: async (b: Record<string, unknown>) => (bodies.push(b), (async function* () { yield* turns.shift()!; })()) } },
      models: { list: async () => [] },
    };
    const seen: unknown[] = [];
    const hist: never[] = [];
    const r = await runOpenAILoop(client, hist, { model: "gpt-x", system: "sys", toolNames: ["ate_positions"], strict: true, stream: true, call: async (_n, i) => (seen.push(i), { content: "{}", isError: false }) });
    expect(r).toMatchObject({ text: "Done.", stop: "end_turn", toolCalls: 1 });
    expect(seen).toEqual([{ market: "a" }]);
    expect(bodies[0]!.tool_choice).toBe("auto");
    expect(((bodies[0]!.tools as { function: { strict?: boolean } }[])[0]!.function.strict)).toBe(true);
    expect((bodies[0]!.messages as { role: string }[])[0]!.role).toBe("system");
  });

  it("Gemini: function calls run, responses go back, model content kept verbatim", async () => {
    const replies = [
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "f1", name: "ate_positions", args: {} } }] }, finishReason: "STOP" }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "All good." }] }, finishReason: "STOP" }] },
    ];
    const client: GeminiLike = { models: { generateContent: async () => replies.shift()!, list: async () => (async function* () {})() } } as never;
    const hist: never[] = [];
    let ran = 0;
    const r = await runGeminiLoop(client, hist, { model: "gemini-x", system: "s", toolNames: ["ate_positions"], call: async () => (ran++, { content: '{"ok":true}', isError: false }) });
    expect(r).toMatchObject({ text: "All good.", stop: "end_turn" });
    expect(ran).toBe(1);
    expect(hist).toHaveLength(3);
  });
});

describe("in-app agents", () => {
  const prompt = join(mkdtempSync(join(tmpdir(), "ate-p-")), "PROMPT.md");
  writeFileSync(prompt, "You are the trader.");
  it("the trader executor calls tools as the agent scope; dry run drops ate_execute", async () => {
    const { client, calls } = mockClient([
      { content: [toolUse("t1", "ate_decide", { decision: "no_trade", market: "hsk-dex:WHSK/USDT:3000", reason: "no_signal", rationale: "nothing worth doing this cycle" })], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "No trade." }], stop_reason: "end_turn" },
    ]);
    const ai = new AiEngine(mkdtempSync(join(tmpdir(), "ate-ai-")), { ATE_KEYSTORE: "file", ANTHROPIC_API_KEY: "sk-ant-test" }, { anthropic: () => client });
    const scopes: string[] = [];
    const ex = createSdkTraderExecutor({
      ai,
      service: { callTool: async (scope: string) => (scopes.push(scope), { ok: true, data: { decisionId: "dec_1" } }) } as never,
      promptFile: prompt,
      toolNames: ["ate_market_get", "ate_decide", "ate_propose"],
      dryRun: true,
      context: ["Profiles: WHSK=default"],
    });
    const r = await ex.run({ cycle: 1, reason: "tick", startedAt: Date.now(), signal: new AbortController().signal });
    expect(r).toMatchObject({ ok: true, summary: "No trade." });
    expect(scopes).toEqual(["agent"]);
    const p = calls[0]!;
    expect((p.system as { text: string }[])[0]!.text).toBe("You are the trader."); // no timestamp in the cached prefix
    expect(JSON.stringify(p.messages)).toContain("DRY RUN");
    expect((p.tools as { name: string }[]).map((t) => t.name)).not.toContain("ate_execute");
  });

  it("chat streams text deltas and emits a tool card per call (chat scope)", async () => {
    const { client } = mockClient([
      { content: [toolUse("t1", "ate_positions", {})], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Up $0.31 today." }], stop_reason: "end_turn" },
    ]);
    const ai = new AiEngine(mkdtempSync(join(tmpdir(), "ate-ai-")), { ATE_KEYSTORE: "file", ANTHROPIC_API_KEY: "sk-ant-test" }, { anthropic: () => client });
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const scopes: string[] = [];
    const r = await runSdkChatTurn(
      { ai, service: { callTool: async (scope: string) => (scopes.push(scope), { ok: true, data: { markets: [] } }) } as never, promptFile: prompt, emit: (e) => events.push(e as never) },
      { sessionId: "s1", turnId: "turn_1", text: "How am I doing?" },
    );
    expect(r).toMatchObject({ reply: "Up $0.31 today.", streamed: true, unstreamed: "" });
    expect(scopes).toEqual(["chat"]);
    expect(events.map((e) => e.type)).toEqual(["chat.tool", "chat.delta"]);
    expect(events[0]!.data).toMatchObject({ tool: "ate_positions", turnId: "turn_1", result: { ok: true } });
    expect(events[1]!.data).toMatchObject({ text: "Up $0.31 today.", done: false });
  });
});

describe("hard per-cycle deadline (the 523 s hang)", () => {
  const prompt = join(mkdtempSync(join(tmpdir(), "ate-p-")), "PROMPT.md");
  writeFileSync(prompt, "You are the trader.");
  const never = <T,>() => new Promise<T>(() => {});

  it("a request that never settles ends at the abort, and the timeout reaches the SDK call", async () => {
    const opts: unknown[] = [];
    const client = { beta: { messages: { stream: (_p: unknown, o: unknown) => (opts.push(o), { on() {}, finalMessage: () => never<never>() }) } }, models: { retrieve: async () => ({}) } } as unknown as LoopClient & Anthropic;
    const ai = new AiEngine(mkdtempSync(join(tmpdir(), "ate-ai-")), { ATE_KEYSTORE: "file", ANTHROPIC_API_KEY: "sk-ant-test" }, { anthropic: () => client });
    const ex = createSdkTraderExecutor({ ai, service: { callTool: async () => ({ ok: true, data: {} }) } as never, promptFile: prompt, toolNames: ["ate_decide"], dryRun: false, context: [] });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    const r = await ex.run({ cycle: 1, reason: "tick", startedAt: t0, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.ok).toBe(false);
    expect(opts[0]).toMatchObject({ timeout: 85_000, signal: ac.signal });
  });

  it("a tool call that never settles ends at the abort too (OpenAI-compatible loop)", async () => {
    const client: OpenAILike = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "ate_positions", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }) } },
      models: { list: async () => [] },
    };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    await expect(runOpenAILoop(client, [], { model: "m", system: "s", toolNames: ["ate_positions"], strict: false, stream: false, signal: ac.signal, call: () => never() })).rejects.toThrow(/abort/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("the runner records the timeout and the next cycle starts on schedule", async () => {
    const { TraderRunner } = await import("@ate/trader");
    const timeouts: number[] = [];
    const runner = new TraderRunner({ executor: { run: () => never() }, timeoutMs: 60, onTimeout: async (c) => void timeouts.push(c) });
    runner.tick("tick");
    await new Promise((r) => setTimeout(r, 5_300));
    expect(timeouts).toEqual([1]);
    expect(runner.tick("tick")).toBe("started");
  }, 10_000);
});
