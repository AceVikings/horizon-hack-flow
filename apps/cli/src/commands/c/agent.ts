// `ate agent run` — the reference trader runner (§11.1). `ate agent ttl` — measured candidate TTL.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MARKETS, MARKET_IDS, type MarketId } from "@ate/core";
import {
  TRADER_PROMPT_PATH,
  TraderRunner,
  connectAte,
  createClaudeExecutor,
  createRulesExecutor,
  createScanner,
  readCandidateTtl,
  readRuntimeJson,
  subscribeCycleRequests,
  stubMcpSpec,
  writeCandidateTtl,
  writeTimeoutRecords,
  type AteTools,
  type McpServerSpec,
} from "@ate/trader";
import type { CommandModule, CommandContext } from "../index.js";

const USAGE = `ate agent run [--engine llm|rules] [--mode autonomous] [--dry-run] [--once]
              [--profile WHSK=demo] [--cycle-seconds 120] [--scan-seconds 20] [--timeout-sec 90]
              [--stub | --mcp-command "<cmd> <args…>"] [--model <m>] [--effort low|medium|high] [--prompt agents/trader/PROMPT.md]
              [--deployments deployments/177.json] [--record-ttl] [--markets WHSK,WBTC]
ate agent ttl [--deployments deployments/177.json]

Each cycle runs \`claude -p\` headlessly with only the ate MCP server (strict config, no built-in tools,
--allowedTools mcp__ate__…), killed after 90 s (→ ate_decide reason=timeout). Cycles never overlap; a newly
opened entry candidate (scan) triggers an out-of-schedule cycle (≥ 30 s apart). --engine rules runs the same
candidates without an LLM (engine=rules, not Track 1 evidence). --dry-run never executes (latency
measurement for candidateTtlSec; --record-ttl writes max(120, 2 × p95) to deployments/177.json).`;

function selfMcpSpec(env: NodeJS.ProcessEnv): McpServerSpec {
  const custom = env.ATE_MCP_COMMAND;
  if (custom) {
    const parts = custom.trim().split(/\s+/);
    return { command: parts[0]!, args: parts.slice(1) };
  }
  // Re-invoke this very CLI (works under node dist and under tsx) as `ate mcp serve` (stdio proxy → daemon).
  return { command: process.execPath, args: [...process.execArgv, process.argv[1]!, "mcp", "serve"] };
}

async function run(ctx: CommandContext, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      engine: { type: "string", default: "llm" },
      mode: { type: "string", default: "autonomous" },
      "dry-run": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      profile: { type: "string", multiple: true },
      "cycle-seconds": { type: "string", default: "120" },
      "scan-seconds": { type: "string", default: "20" },
      "timeout-sec": { type: "string", default: "90" },
      stub: { type: "boolean", default: false },
      "mcp-command": { type: "string" },
      model: { type: "string" },
      effort: { type: "string", default: "low" },
      prompt: { type: "string" },
      deployments: { type: "string", default: "deployments/177.json" },
      "record-ttl": { type: "boolean", default: false },
      markets: { type: "string" },
      log: { type: "string" },
    },
  });
  if (values.mode !== "autonomous") throw new Error("only --mode autonomous is run by the trader (confirm mode is human-approved per trade)");
  const engine = values.engine === "rules" ? "rules" : "llm";
  const cycleSec = Math.max(30, Number(values["cycle-seconds"]));
  const scanSec = Math.max(5, Number(values["scan-seconds"]));
  const timeoutSec = Number(values["timeout-sec"]);
  const dryRun = values["dry-run"];
  const deployments = resolve(ctx.cwd, values.deployments!);
  const markets: MarketId[] = values.markets
    ? MARKET_IDS.filter((m) => values.markets!.toUpperCase().split(",").some((x) => x === MARKETS[m].asset || x === MARKETS[m].label))
    : [...MARKET_IDS];
  const profiles = (values.profile ?? []).map((p) => p.toUpperCase());
  if (profiles.some((p) => p.startsWith("WBTC=DEMO") || p.startsWith("BTC=DEMO"))) throw new Error("the WBTC market cannot be given the demo profile in v0.1 (§16)");
  const mcp: McpServerSpec = values.stub
    ? stubMcpSpec("agent")
    : values["mcp-command"]
      ? { command: values["mcp-command"].split(/\s+/)[0]!, args: values["mcp-command"].split(/\s+/).slice(1) }
      : selfMcpSpec(ctx.env);
  const logFile = values.log ?? join(ctx.env.ATE_HOME ?? join(homedir(), ".ate"), "trader-cycles.jsonl");
  const log = (m: string) => ctx.stderr.write(`[${new Date().toISOString()}] ${m}\n`);
  const ttl = readCandidateTtl(deployments);
  log(`trader: engine=${engine} mode=autonomous dryRun=${dryRun} cycle=${cycleSec}s scan=${scanSec}s timeout=${timeoutSec}s profiles=[${profiles.join(", ") || "default"}] candidateTtlSec=${ttl.ttlSec} (${ttl.source}) mcp=${mcp.command} ${mcp.args.join(" ")}`);

  // The runner's own MCP connection (rules engine, timeout records, scan). Lazily (re)connected.
  let tools: AteTools | null = null;
  const getTools = async () => (tools ??= await connectAte(mcp));

  const context = [
    `Profiles: WHSK=${profiles.includes("WHSK=DEMO") ? "demo (rebalance edge gate waived, $5 size; label trades profile=demo, never call them arbitrage)" : "default"}, WBTC=default (real spread capture, no waivers).`,
    `Markets enabled for this runner: ${markets.map((m) => MARKETS[m].label).join(", ")}.`,
  ];
  const executor =
    engine === "rules"
      ? createRulesExecutor(getTools, { markets, dryRun, log })
      : createClaudeExecutor({ promptFile: values.prompt ? resolve(ctx.cwd, values.prompt) : TRADER_PROMPT_PATH, mcp, dryRun, context, ...(values.model ? { model: values.model } : {}), effort: (values.effort as "low" | "medium" | "high") ?? "low", log });

  mkdirSync(join(logFile, ".."), { recursive: true });
  const runner = new TraderRunner({
    executor,
    timeoutMs: timeoutSec * 1000,
    log,
    onTimeout: async (cycle) => {
      const ids = await writeTimeoutRecords(await getTools(), cycle, timeoutSec, markets);
      log(`cycle ${cycle}: timeout records ${ids.join(", ")}`);
    },
    onRecord: (r) => appendFileSync(logFile, JSON.stringify({ ...r, engine, dryRun }) + "\n"),
  });

  if (values.once) {
    runner.tick("manual");
    await runner.idle();
  } else {
    const scan = createScanner(getTools);
    const scanTimer = setInterval(() => {
      scan()
        .then((opened) => {
          if (opened.length) log(`scan: entry candidate opened on ${opened.map((m) => MARKETS[m].label).join(", ")} → ${runner.trigger("scan")}`);
        })
        .catch((e: unknown) => log(`scan failed: ${e instanceof Error ? e.message : String(e)}`));
    }, scanSec * 1000);
    // The daemon's own deterministic scan / POST /cycle / human strategy changes arrive as cycle.requested.
    const rt = values.stub ? null : readRuntimeJson(ctx.env.ATE_HOME ?? join(homedir(), ".ate"));
    const sub = rt
      ? subscribeCycleRequests({
          port: rt.port,
          token: rt.agentToken,
          log,
          onRequest: (r) => log(`daemon cycle.requested (${r}) → ${runner.trigger(r === "gap" ? "scan" : r === "strategy_change" ? "strategy_change" : "manual")}`),
        })
      : null;
    runner.startTimer(cycleSec * 1000);
    await new Promise<void>((res) => {
      const stop = () => res();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    clearInterval(scanTimer);
    sub?.close();
    runner.stopTimer();
    await runner.idle();
  }
  const s = runner.stats();
  ctx.stdout.write(JSON.stringify({ ...s, engine, dryRun }, null, 2) + "\n");
  if (values["record-ttl"] && dryRun && engine === "llm") {
    writeCandidateTtl(deployments, { ttlSec: s.candidateTtlSec, p95Ms: s.p95Ms, cycles: s.cycles, at: Date.now() });
    log(`wrote candidateTtlSec=${s.candidateTtlSec} to ${deployments}`);
  }
  await (tools as AteTools | null)?.close().catch(() => {});
  return runner.records.some((r) => r.status === "ok") ? 0 : 1;
}

const cmd: CommandModule = {
  name: "agent",
  summary: "Run the reference trader (claude -p per cycle, or --engine rules); `agent ttl` shows the candidate TTL",
  usage: USAGE,
  async run(ctx) {
    const [sub, ...rest] = ctx.argv;
    if (sub === "run") return run(ctx, rest);
    if (sub === "ttl") {
      const { values } = parseArgs({ args: rest, options: { deployments: { type: "string", default: "deployments/177.json" } } });
      const t = readCandidateTtl(resolve(ctx.cwd, values.deployments!));
      ctx.stdout.write(`candidateTtlSec=${t.ttlSec} (${t.source})\n`);
      return 0;
    }
    ctx.stderr.write(USAGE + "\n");
    return 2;
  },
};

export default cmd;
