import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MARKET_WBTC, MARKET_WHSK } from "@ate/core";
import { connectAte } from "@ate/trader";
import { chatArgs, createRulesChat, parseIntent } from "../src/index.js";

describe("chat runner (allowlist, not denylist)", () => {
  it("strict MCP config, no built-in tools, only mcp__ate__*, resumed per session", () => {
    const base = { sessionId: "6f1c2b0e-1111-4c2a-9a1e-123456789abc", text: "How am I doing?", mcp: { command: "node", args: ["x"] } };
    const a = chatArgs({ ...base, firstTurn: true });
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("mcp__ate__*");
    expect(a).toContain("--disable-slash-commands");
    expect(a[a.indexOf("--session-id") + 1]).toBe(base.sessionId);
    const b = chatArgs({ ...base, firstTurn: false });
    expect(b[b.indexOf("--resume") + 1]).toBe(base.sessionId);
    expect(a[a.indexOf("--system-prompt") + 1]).toMatch(/untrusted_agent_text/);
  });
});

describe("rules intent matcher (★ intents)", () => {
  it("parses the five intents", () => {
    expect(parseIntent("How am I doing today?").kind).toBe("positions");
    expect(parseIntent("Be more conservative, stop out at 2%")).toMatchObject({ kind: "stop", field: "stopLossBps", bps: 200, markets: null });
    expect(parseIntent("Stop out HSK at 0.5%")).toMatchObject({ kind: "stop", bps: 50, markets: [MARKET_WHSK] });
    expect(parseIntent("Go to cash")).toMatchObject({ kind: "targets", patch: { targetAssets: [] } });
    expect(parseIntent("Go to cash on HSK, keep the BTC")).toMatchObject({ kind: "targets", patch: { targetAssets: ["WBTC"] } });
    expect(parseIntent("Only trade BTC")).toMatchObject({ kind: "targets", patch: { targetAssets: ["WBTC"] } });
    expect(parseIntent("Trade HSK again")).toMatchObject({ kind: "targets", patch: { targetAssets: ["WHSK", "WBTC"] } });
    expect(parseIntent("Target 20% HSK")).toMatchObject({ kind: "targets", patch: { market: MARKET_WHSK, rebalanceTargetPct: 20 } });
    expect(parseIntent("Why did you sell at 3am?")).toMatchObject({ kind: "why", hourUtc: 3 });
    expect(parseIntent("Stop everything").kind).toBe("pause");
    expect(parseIntent("both")).toEqual({ kind: "scope_answer", markets: [MARKET_WHSK, MARKET_WBTC] });
    expect(parseIntent("BTC")).toEqual({ kind: "scope_answer", markets: [MARKET_WBTC] });
  });
});

const stubMain = fileURLToPath(new URL("../../../packages/mcp/dist/stub/main.js", import.meta.url));

describe.skipIf(!existsSync(stubMain))("rules chat against the chat-scope MCP stub", () => {
  it("asks for scope before a stop-loss change and answers the other intents", async () => {
    const tools = await connectAte({ command: process.execPath, args: [stubMain], env: { ATE_STUB_SCOPE: "chat" } });
    try {
      const chat = createRulesChat(async () => tools);
      expect((await chat.handle("How am I doing?")).reply).toMatch(/Portfolio:/);
      expect((await chat.handle("Be more conservative, stop out at 2%")).reply).toBe("HSK, BTC or both?");
      const r = await chat.handle("both");
      expect(r.tool).toBe("ate_strategy_set");
      expect(r.reply).toMatch(/HSK stop-loss 2%/);
      expect((await chat.handle("Go to cash on HSK, keep the BTC")).reply).toMatch(/Applied|ATE_/);
      expect((await chat.handle("Stop everything")).reply).toMatch(/also stops stop-loss exits/);
      expect((await chat.handle("sing me a song")).engine).toBe("rules");
    } finally {
      await tools.close();
    }
  }, 30_000);
});

// Live check (opt-in, needs `claude` + auth): the runner's reported tool list equals the chat allowlist (§18.2).
describe.skipIf(process.env.ATE_LIVE_CLAUDE !== "1" || !existsSync(stubMain))("live: claude init tool list", () => {
  it("equals mcp__ate__ × CHAT_TOOL_ALLOWLIST, no built-ins, no skills", async () => {
    const { spawnSync } = await import("node:child_process");
    const { CHAT_TOOL_ALLOWLIST } = await import("@ate/core");
    const args = chatArgs({ sessionId: crypto.randomUUID(), firstTurn: true, text: "Reply OK.", mcp: { command: process.execPath, args: [stubMain], env: { ATE_STUB_SCOPE: "chat" } }, model: "haiku" });
    args[args.indexOf("--output-format") + 1] = "stream-json";
    args.push("--verbose", "--no-session-persistence");
    const r = spawnSync("claude", args, { encoding: "utf8", timeout: 90_000 });
    const init = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((d) => d.subtype === "init");
    expect([...init.tools].sort()).toEqual(CHAT_TOOL_ALLOWLIST.map((t) => `mcp__ate__${t}`).sort());
    expect(init.skills ?? []).toEqual([]);
  }, 120_000);
});
