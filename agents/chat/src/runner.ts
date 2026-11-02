// Allowlisted chat runner (§11.5): `claude -p` resumed per sessionId, strict MCP config with only the ate
// server (chat token), `--tools ""` (no Bash/Read/Write/Edit/Grep/Glob/WebFetch/WebSearch/Task), no skills,
// `--allowedTools mcp__ate__*`. The MCP server enforces the chat scope's tool set; this is defence in depth.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mcpConfigJson, parseClaudeJson, type McpServerSpec } from "@ate/trader";

export const CHAT_PROMPT_PATH = fileURLToPath(new URL("../PROMPT.md", import.meta.url));
/** §16 chat.runnerFlags / chat.allowedTools. */
export const CHAT_ALLOWED_TOOLS = ["mcp__ate__*"] as const;

export interface ChatTurnOptions {
  sessionId: string;
  /** First turn of the session: `--session-id`, later turns: `--resume`. */
  firstTurn: boolean;
  text: string;
  mcp: McpServerSpec;
  promptFile?: string;
  claudeBin?: string;
  model?: string;
  timeoutMs?: number;
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

export function chatArgs(o: ChatTurnOptions): string[] {
  const system = readFileSync(o.promptFile ?? CHAT_PROMPT_PATH, "utf8");
  const args = [
    "-p",
    o.text,
    "--system-prompt",
    system,
    "--mcp-config",
    mcpConfigJson(o.mcp),
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    CHAT_ALLOWED_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    "--disable-slash-commands",
    "--output-format",
    "json",
    ...(o.firstTurn ? ["--session-id", o.sessionId] : ["--resume", o.sessionId]),
  ];
  if (o.model) args.push("--model", o.model);
  return args;
}

export async function runChatTurn(o: ChatTurnOptions): Promise<{ ok: boolean; reply: string; engine: "llm" }> {
  const sp = o.spawnImpl ?? spawn;
  return await new Promise((resolve) => {
    const child = sp(o.claudeBin ?? "claude", chatArgs(o), { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (err += b.toString()));
    const t = setTimeout(() => child.kill("SIGTERM"), o.timeoutMs ?? 90_000);
    child.on("error", (e) => resolve({ ok: false, reply: `chat runner failed to start: ${e.message}`, engine: "llm" }));
    child.on("close", (code) => {
      clearTimeout(t);
      const r = parseClaudeJson(out);
      resolve({ ok: r.ok && code === 0, reply: r.ok ? (r.summary ?? "") : `${r.summary ?? ""} ${err.slice(0, 300)}`.trim(), engine: "llm" });
    });
  });
}
