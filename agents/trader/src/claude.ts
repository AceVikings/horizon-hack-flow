// Headless Claude Code executor: `claude -p` with a strict MCP config that exposes only the ate server,
// no built-in tools, and an allowlist of mcp__ate__* tools (§11.1, §11.5). Killed on abort (90 s).

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import type { CycleContext, CycleExecutor, CycleOutcome } from "./runner.js";

export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Tools the trader may call. `ate_execute` is removed in --dry-run (decide/propose only). */
export const TRADER_TOOLS = [
  "ate_market_get",
  "ate_candidates_get",
  "ate_quote",
  "ate_propose",
  "ate_decide",
  "ate_execute",
  "ate_positions",
  "ate_strategy_get",
  "ate_strategy_set",
  "ate_journal_read",
] as const;

export interface ClaudeOptions {
  claudeBin?: string;
  promptFile: string;
  mcp: McpServerSpec;
  model?: string;
  /** Claude Code --effort (default low: the run must finish well inside the 90 s kill). */
  effort?: "low" | "medium" | "high";
  dryRun?: boolean;
  /** Extra per-cycle context lines (profiles, mode). */
  context?: string[];
  cwd?: string;
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  log?: (msg: string) => void;
}

export function mcpConfigJson(mcp: McpServerSpec): string {
  return JSON.stringify({ mcpServers: { ate: { type: "stdio", command: mcp.command, args: mcp.args, env: mcp.env ?? {} } } });
}

export function allowedTools(dryRun: boolean): string[] {
  return TRADER_TOOLS.filter((t) => !(dryRun && t === "ate_execute")).map((t) => `mcp__ate__${t}`);
}

/** argv for one cycle. Built-in tools disabled (`--tools ""`), strict MCP config, explicit allowlist. */
export function claudeArgs(o: ClaudeOptions, ctx: Pick<CycleContext, "cycle" | "reason" | "startedAt">): string[] {
  const system = readFileSync(o.promptFile, "utf8");
  const lines = [
    `Cycle ${ctx.cycle} (${ctx.reason}) at ${new Date(ctx.startedAt).toISOString()}.`,
    ...(o.context ?? []),
    o.dryRun
      ? "DRY RUN: evaluate exactly as usual and end each market with ate_propose or ate_decide, but never call ate_execute (it is not available)."
      : "Run the cycle now: read state, evaluate every candidate and the discretionary lane, and end each market in ate_execute (after ate_propose) or ate_decide.",
  ];
  const args = [
    "-p",
    lines.join("\n"),
    "--system-prompt",
    system,
    "--mcp-config",
    mcpConfigJson(o.mcp),
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    allowedTools(!!o.dryRun).join(","),
    "--permission-mode",
    "dontAsk",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  if (o.dryRun) args.push("--disallowedTools", "mcp__ate__ate_execute");
  if (o.model) args.push("--model", o.model);
  args.push("--effort", o.effort ?? "low");
  return args;
}

export function parseClaudeJson(stdout: string): CycleOutcome {
  const last = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    const j = JSON.parse(last) as { is_error?: boolean; result?: string; total_cost_usd?: number; num_turns?: number; subtype?: string };
    return { ok: !j.is_error && j.subtype !== "error", summary: (j.result ?? "").slice(0, 2000), ...(j.total_cost_usd !== undefined ? { costUsd: j.total_cost_usd } : {}), ...(j.num_turns !== undefined ? { turns: j.num_turns } : {}) };
  } catch {
    return { ok: false, summary: `unparseable claude output: ${stdout.slice(0, 300)}` };
  }
}

export function createClaudeExecutor(o: ClaudeOptions): CycleExecutor {
  const sp = o.spawnImpl ?? spawn;
  return {
    run(ctx) {
      return new Promise<CycleOutcome>((resolve) => {
        const child = sp(o.claudeBin ?? "claude", claudeArgs(o, ctx), { cwd: o.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
        child.stderr?.on("data", (b: Buffer) => (err += b.toString()));
        const kill = () => {
          child.kill("SIGTERM");
          setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2_000).unref();
        };
        ctx.signal.addEventListener("abort", kill, { once: true });
        child.on("error", (e) => resolve({ ok: false, summary: `spawn failed: ${e.message}` }));
        child.on("close", (code) => {
          ctx.signal.removeEventListener("abort", kill);
          if (ctx.signal.aborted) return resolve({ ok: false, summary: "killed (timeout)" });
          const r = parseClaudeJson(out);
          if (code !== 0 && r.ok) r.ok = false;
          if (!r.ok && err) r.summary = `${r.summary ?? ""} ${err.slice(0, 500)}`.trim();
          resolve(r);
        });
      });
    },
  };
}
