import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "@ate/core";
import { TOOL_DEFINITIONS, validateToolInput } from "../src/index.js";

const schemasDir = fileURLToPath(new URL("../schemas/", import.meta.url));
const specPath = fileURLToPath(new URL("../../../SPEC.md", import.meta.url));

describe("frozen JSON schema files", () => {
  it("one file per tool, equal to the TS source (run schemas:emit if this fails)", () => {
    const files = readdirSync(schemasDir).filter((f) => f.startsWith("ate_"));
    expect(files.sort()).toEqual(TOOL_NAMES.map((n) => `${n}.json`).sort());
    for (const n of TOOL_NAMES) {
      expect(JSON.parse(readFileSync(`${schemasDir}${n}.json`, "utf8"))).toEqual(JSON.parse(JSON.stringify(TOOL_DEFINITIONS[n])));
    }
  });
});

describe("§7.4 schemas are verbatim from SPEC.md", () => {
  const spec = readFileSync(specPath, "utf8");
  const section = spec.slice(spec.indexOf("### 7.4 Schemas"), spec.indexOf("### 7.5 Response envelope"));
  const blocks = [...section.matchAll(/```jsonc\n\/\/ (\w+)\n([\s\S]*?)```/g)];
  it("finds the five spec-defined tools", () => {
    expect(blocks.map((b) => b[1]).sort()).toEqual(["ate_candidates_get", "ate_execute", "ate_propose", "ate_quote", "ate_strategy_set"]);
  });
  for (const b of blocks) {
    it(`${b[1]} matches`, () => {
      const fromSpec = JSON.parse(b[2]!);
      const ours = TOOL_DEFINITIONS[b[1] as keyof typeof TOOL_DEFINITIONS];
      expect({ name: ours.name, description: ours.description, inputSchema: ours.inputSchema }).toEqual(fromSpec);
    });
  }
});

describe("input validation", () => {
  it("accepts a candidate-bound proposal and applies the origin default", () => {
    const args: Record<string, unknown> = {
      market: "hsk-dex:WBTC/USDT:3000",
      side: "buy",
      amountIn: "25000000",
      candidateId: "cand_0b5e2c7a9d1f4e60",
      rationale: "WBTC pool 112 bps under CEX mid; acting on candidate.",
    };
    expect(validateToolInput("ate_propose", args).ok).toBe(true);
    expect(args.origin).toBe("candidate");
  });
  it("rejects unknown markets, float amounts and extra keys", () => {
    expect(validateToolInput("ate_quote", { market: "hsk-dex:WETH/USDT:3000", side: "buy", amountIn: "1" }).ok).toBe(false);
    expect(validateToolInput("ate_quote", { market: "hsk-dex:WHSK/USDT:3000", side: "buy", amountIn: "1.5" }).ok).toBe(false);
    expect(validateToolInput("ate_pause", { rationale: "stop everything right now", force: true }).ok).toBe(false);
    expect(validateToolInput("ate_strategy_set", { patch: { stopLossBps: 10 }, rationale: "tighten the stop please" }).ok).toBe(false);
  });
  it("ate_decide requires reason and rationale", () => {
    expect(validateToolInput("ate_decide", { decision: "no_trade", market: "hsk-dex:WHSK/USDT:3000", reason: "llm_veto", rationale: "CEX book too thin to trust" }).ok).toBe(true);
    expect(validateToolInput("ate_decide", { decision: "no_trade", market: "hsk-dex:WHSK/USDT:3000", rationale: "x".repeat(20) }).ok).toBe(false);
  });
});

describe("ate_chart (lane D4, additive): agent-built charts", () => {
  it("accepts compare, drawings and analyse", () => {
    const args = {
      kind: "price",
      market: "hsk-dex:WBTC/USDT:3000",
      interval: "1h",
      indicators: ["rsi14", "volume"],
      compare: ["cex", "oracle"],
      drawings: [
        { kind: "hline", a: { v: 77300 }, label: "1% under the exchange", role: "support" },
        { kind: "trend", a: { t: 1793500000, v: 76900 }, b: { t: 1793600000, v: 78100 } },
        { kind: "zone", a: { v: 76800 }, b: { v: 77000 }, label: "Support zone" },
        { kind: "fib", a: { t: 1793500000, v: 76500 }, b: { t: 1793600000, v: 78500 } },
        { kind: "text", a: { t: 1793550000, v: 77800 }, label: "Breakout" },
      ],
      analyse: true,
    };
    expect(validateToolInput("ate_chart", args).ok).toBe(true);
  });
  it("rejects unknown drawing kinds, extra keys and more than 20 drawings", () => {
    expect(validateToolInput("ate_chart", { kind: "price", drawings: [{ kind: "arrow", a: { v: 1 } }] }).ok).toBe(false);
    expect(validateToolInput("ate_chart", { kind: "price", drawings: [{ kind: "hline", a: { v: 1, x: 2 } }] }).ok).toBe(false);
    expect(validateToolInput("ate_chart", { kind: "price", drawings: Array.from({ length: 21 }, () => ({ kind: "hline", a: { v: 1 } })) }).ok).toBe(false);
    expect(validateToolInput("ate_chart", { kind: "price", compare: ["binance"] }).ok).toBe(false);
  });
});
