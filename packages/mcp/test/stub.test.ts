import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { CHAT_TOOL_ALLOWLIST, type ToolResult } from "@ate/core";
import { createStubHandler, createStubServer, InvalidParamsError } from "../src/index.js";

const R = "Rationale long enough to pass the schema check.";

describe("stub handler", () => {
  const agent = createStubHandler({ scope: "agent", hsp: false });
  const chat = createStubHandler({ scope: "chat", hsp: false });

  it("scopes tool lists", () => {
    expect(agent.listTools().map((t) => t.name)).not.toContain("ate_signal_buy");
    expect(agent.listTools()).toHaveLength(14); // + ate_chart, ate_data (lane D4), ate_backtest (lane STRAT), additive
    expect(chat.listTools().map((t) => t.name)).toEqual([...CHAT_TOOL_ALLOWLIST]);
  });

  it("chat calling ate_execute → ATE_TOOL_NOT_ALLOWED", () => {
    const r = chat.callTool("ate_execute", { proposalId: "prop_0000000000000001" });
    expect(r).toMatchObject({ ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED", retryable: false } });
  });

  it("invalid args throw InvalidParamsError", () => {
    expect(() => agent.callTool("ate_quote", { market: "nope", side: "buy", amountIn: "1" })).toThrow(InvalidParamsError);
  });

  it("market_get returns both markets, or one", () => {
    const both = agent.callTool("ate_market_get", {}) as ToolResult<{ markets: { market: string }[] }>;
    expect(both.ok && both.data.markets.map((m) => m.market)).toEqual(["hsk-dex:WHSK/USDT:3000", "hsk-dex:WBTC/USDT:3000"]);
    const one = agent.callTool("ate_market_get", { market: "hsk-dex:WBTC/USDT:3000" }) as ToolResult<{ markets: unknown[] }>;
    expect(one.ok && one.data.markets).toHaveLength(1);
  });

  it("propose → execute happy path, then reuse is rejected", () => {
    const p = agent.callTool("ate_propose", {
      market: "hsk-dex:WBTC/USDT:3000",
      side: "buy",
      amountIn: "25000000",
      candidateId: "cand_0b5e2c7a9d1f4e60",
      rationale: R,
    }) as ToolResult<{ proposalId: string }>;
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.data.proposalId).toMatch(/^prop_[0-9a-f]{16}$/);
    const e = agent.callTool("ate_execute", { proposalId: p.data.proposalId });
    expect(e.ok).toBe(true);
    expect(agent.callTool("ate_execute", { proposalId: p.data.proposalId })).toMatchObject({ ok: false, error: { code: "ATE_PROPOSAL_UNKNOWN" } });
  });

  it("candidate binding errors", () => {
    expect(agent.callTool("ate_propose", { market: "hsk-dex:WBTC/USDT:3000", side: "buy", amountIn: "1", rationale: R })).toMatchObject({
      ok: false,
      error: { code: "ATE_CANDIDATE_REQUIRED" },
    });
    expect(
      agent.callTool("ate_propose", { market: "hsk-dex:WBTC/USDT:3000", side: "sell", amountIn: "1", candidateId: "cand_0b5e2c7a9d1f4e60", rationale: R }),
    ).toMatchObject({ ok: false, error: { code: "ATE_CANDIDATE_MISMATCH" } });
    expect(
      agent.callTool("ate_propose", {
        market: "hsk-dex:WHSK/USDT:3000",
        side: "buy",
        amountIn: "5000000",
        origin: "discretionary",
        thesis: "CEX ask thinning three cycles while pool flow is net buy; exit if mid < entry.",
        rationale: R,
      }).ok,
    ).toBe(true);
  });

  it("chat loosening → ATE_APPROVAL_REQUIRED with a diff; tightening applies", () => {
    const loosen = chat.callTool("ate_strategy_set", { patch: { market: "hsk-dex:WHSK/USDT:3000", stopLossBps: 500 }, rationale: R });
    expect(loosen).toMatchObject({ ok: false, error: { code: "ATE_APPROVAL_REQUIRED", details: { changeId: expect.any(String) } } });
    const tighten = chat.callTool("ate_strategy_set", { patch: { market: "hsk-dex:WHSK/USDT:3000", stopLossBps: 50 }, rationale: R });
    expect(tighten.ok).toBe(true);
    expect(agent.callTool("ate_strategy_set", { patch: { stopLossBps: 50 }, rationale: R })).toMatchObject({ ok: false, error: { code: "ATE_TOOL_NOT_ALLOWED" } });
  });

  it("riskProfile: aggressive loosens (approval), conservative tightens (applies)", () => {
    expect(chat.callTool("ate_strategy_set", { patch: { riskProfile: "aggressive" }, rationale: R })).toMatchObject({ ok: false, error: { code: "ATE_APPROVAL_REQUIRED" } });
    expect(chat.callTool("ate_strategy_set", { patch: { riskProfile: "conservative" }, rationale: R }).ok).toBe(true);
    expect(chat.callTool("ate_strategy_set", { patch: { entrySpreadBps: 30 }, rationale: R })).toMatchObject({ ok: false, error: { code: "ATE_APPROVAL_REQUIRED" } });
  });

  it("journal text is wrapped as untrusted", () => {
    const j = chat.callTool("ate_journal_read", { limit: 2 }) as ToolResult<{ entries: { rationale: string }[] }>;
    expect(j.ok && j.data.entries[0]!.rationale.startsWith("<untrusted_agent_text>")).toBe(true);
  });

  it("every visible tool returns a well-formed envelope with minimal args", () => {
    const h = createStubHandler({ scope: "agent", hsp: true });
    const minimal: Record<string, unknown> = {
      ate_quote: { market: "hsk-dex:WHSK/USDT:3000", side: "sell", amountIn: "100000000000000000000" },
      ate_chart: { kind: "price" },
      ate_data: { table: "swaps" },
      ate_propose: { market: "hsk-dex:WHSK/USDT:3000", side: "sell", amountIn: "1000", candidateId: "cand_c0ffee12ab34cd56", rationale: R },
      ate_decide: { decision: "no_trade", market: "hsk-dex:WHSK/USDT:3000", reason: "no_signal", rationale: R },
      ate_execute: { proposalId: "prop_ffffffffffffffff" },
      ate_strategy_set: { patch: { tradeSizeUsd: "20" }, rationale: R },
      ate_signal_buy: { offerId: "offer_1", rationale: R },
      ate_pause: { rationale: R },
    };
    for (const t of h.listTools()) {
      const r = h.callTool(t.name, minimal[t.name] ?? {});
      expect(typeof r.ok).toBe("boolean");
      if (r.ok) expect(r.meta.blockNumber).toMatch(/^\d+$/);
      else expect(r.error.code).toMatch(/^ATE_/);
    }
  });
});

describe("stub MCP server over a transport", () => {
  it("lists tools and returns JSON text content", async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createStubServer({ scope: "chat", hsp: false });
    await server.connect(st);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([...CHAT_TOOL_ALLOWLIST]);
    const res = await client.callTool({ name: "ate_positions", arguments: {} });
    const content = res.content as { type: string; text: string }[];
    const body = JSON.parse(content[0]!.text) as ToolResult<{ markets: unknown[] }>;
    expect(body.ok).toBe(true);
    const denied = await client.callTool({ name: "ate_execute", arguments: { proposalId: "prop_0000000000000001" } });
    expect(denied.isError).toBe(true);
    await client.close();
  });
});
