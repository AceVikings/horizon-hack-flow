import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MARKET_WBTC, MARKET_WHSK } from "@ate/core";
import {
  TRADER_PROMPT_PATH,
  TraderRunner,
  allowedTools,
  candidateTtlFromP95,
  claudeArgs,
  connectAte,
  createRulesExecutor,
  parseClaudeJson,
  readCandidateTtl,
  writeCandidateTtl,
  writeTimeoutRecords,
  type CycleExecutor,
} from "../src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cycle rules (§11.1)", () => {
  it("an overlapping tick is skipped while the previous run is active", async () => {
    let release!: () => void;
    const ex: CycleExecutor = { run: () => new Promise((r) => (release = () => r({ ok: true }))) };
    const r = new TraderRunner({ executor: ex });
    expect(r.tick()).toBe("started");
    expect(r.tick()).toBe("skipped");
    expect(r.trigger("scan")).toBe("rate_limited");
    release();
    await r.idle();
    expect(r.skipped).toBe(1);
    expect(r.stats().cycles).toBe(1);
    expect(r.tick()).toBe("started");
    release();
    await r.idle();
  });

  it("a run still active at the timeout is killed and recorded as no_trade(timeout)", async () => {
    let aborted = false;
    const ex: CycleExecutor = {
      run: (ctx) =>
        new Promise((res) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            res({ ok: false, summary: "killed" });
          });
        }),
    };
    const timeouts: number[] = [];
    const r = new TraderRunner({ executor: ex, timeoutMs: 50, onTimeout: async (c) => void timeouts.push(c) });
    r.tick();
    await r.idle();
    expect(aborted).toBe(true);
    expect(timeouts).toEqual([1]);
    expect(r.records[0]!.status).toBe("timeout");
    expect(r.stats().timeouts).toBe(1);
  });

  it("out-of-schedule cycles are ≥ 30 s apart and obey the lock", async () => {
    let t = 1_000_000;
    const r = new TraderRunner({ executor: { run: async () => ({ ok: true }) }, now: () => t });
    expect(r.trigger("strategy_change")).toBe("started");
    await r.idle();
    t += 10_000;
    expect(r.trigger("scan")).toBe("rate_limited");
    t += 21_000;
    expect(r.trigger("scan")).toBe("started");
    await r.idle();
  });

  it("a gap trigger during a run is queued and runs once that run ends", async () => {
    let t = 1_000_000;
    let release!: () => void;
    const reasons: string[] = [];
    const ex: CycleExecutor = { run: (ctx) => (reasons.push(ctx.reason), new Promise((r) => (release = () => r({ ok: true })))) };
    const r = new TraderRunner({ executor: ex, now: () => t });
    expect(r.tick()).toBe("started");
    t += 40_000;
    expect(r.trigger("scan")).toBe("skipped");
    expect(r.trigger("scan")).toBe("skipped"); // still one queued cycle, not two
    release();
    await sleep(0);
    expect(reasons).toEqual(["tick", "scan"]);
    release();
    await r.idle();
    expect(r.stats().cycles).toBe(2);
  });

  it("candidateTtlSec = max(120, 2 × p95) and records latency", async () => {
    expect(candidateTtlFromP95(null)).toBe(120);
    expect(candidateTtlFromP95(45_000)).toBe(120);
    expect(candidateTtlFromP95(75_500)).toBe(151);
    const r = new TraderRunner({ executor: { run: async () => (await sleep(5), { ok: true }) } });
    r.tick();
    await r.idle();
    expect(r.stats().p95Ms).toBeGreaterThanOrEqual(4);
  });

  it("TTL is read from deployments/177.json (and written back from measurements)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ate-ttl-"));
    const p = join(dir, "177.json");
    expect(readCandidateTtl(p).ttlSec).toBe(120);
    writeFileSync(p, JSON.stringify({ chainId: 177, vaults: {} }));
    writeCandidateTtl(p, { ttlSec: 151, p95Ms: 75_500, cycles: 20, at: 0 });
    const j = JSON.parse(readFileSync(p, "utf8"));
    expect(j.chainId).toBe(177);
    expect(readCandidateTtl(p)).toEqual({ ttlSec: 151, source: p });
  });
});

describe("claude runner invocation (allowlist, not denylist)", () => {
  const mcp = { command: "node", args: ["stub.js"] };
  it("strict MCP config, no built-in tools, only mcp__ate__* trading tools", () => {
    const a = claudeArgs({ promptFile: TRADER_PROMPT_PATH, mcp }, { cycle: 3, reason: "tick", startedAt: 0 });
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    const allowed = a[a.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed.every((t) => t.startsWith("mcp__ate__"))).toBe(true);
    expect(allowed).toContain("mcp__ate__ate_execute");
    expect(JSON.parse(a[a.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: { ate: { type: "stdio", command: "node", args: ["stub.js"], env: {} } } });
    expect(a[a.indexOf("--system-prompt") + 1]).toMatch(/discretionary lane/);
  });
  it("--dry-run removes ate_execute", () => {
    expect(allowedTools(true)).not.toContain("mcp__ate__ate_execute");
    const a = claudeArgs({ promptFile: TRADER_PROMPT_PATH, mcp, dryRun: true }, { cycle: 1, reason: "tick", startedAt: 0 });
    expect(a[a.indexOf("--disallowedTools") + 1]).toBe("mcp__ate__ate_execute");
  });
  it("parses the json result", () => {
    expect(parseClaudeJson('{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.12,"num_turns":7}')).toEqual({ ok: true, summary: "done", costUsd: 0.12, turns: 7 });
    expect(parseClaudeJson("garbage").ok).toBe(false);
  });
});

const stubMain = fileURLToPath(new URL("../../../packages/mcp/dist/stub/main.js", import.meta.url));

describe.skipIf(!existsSync(stubMain))("rules engine against the MCP stub", () => {
  it("decides both markets and writes timeout records", async () => {
    const tools = await connectAte({ command: process.execPath, args: [stubMain] });
    try {
      const ex = createRulesExecutor(async () => tools);
      const out = await ex.run({ cycle: 1, reason: "tick", startedAt: 1_793_588_400_000, signal: new AbortController().signal });
      expect(out.ok).toBe(true);
      expect(out.summary).toMatch(/WHSK|WBTC/);
      const ids = await writeTimeoutRecords(tools, 1, 90, [MARKET_WHSK, MARKET_WBTC]);
      expect(ids).toHaveLength(2);
    } finally {
      await tools.close();
    }
  }, 30_000);
});

describe("daemon /events", () => {
  it("maps cycle.requested to an out-of-schedule reason", async () => {
    const { cycleRequestOf } = await import("../src/index.js");
    expect(cycleRequestOf(JSON.stringify({ type: "cycle.requested", at: 1, data: { reason: "gap", cycle: 3 } }))).toBe("gap");
    expect(cycleRequestOf(JSON.stringify({ type: "trade.executed", at: 1, data: {} }))).toBeNull();
    expect(cycleRequestOf("nope")).toBeNull();
  });
});
