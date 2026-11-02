// @ate/trader — the reference trader runner (`ate agent run`, §11.1).
import { fileURLToPath } from "node:url";

export * from "./runner.js";
export * from "./claude.js";
export * from "./mcp.js";
export * from "./rules.js";
export * from "./ttl.js";

/** Absolute path of the shipped trader prompt. */
export const TRADER_PROMPT_PATH = fileURLToPath(new URL("../PROMPT.md", import.meta.url));

/** MCP stub server (packages/mcp) — for developing against fixtures before the daemon is up. */
export function stubMcpSpec(scope: "agent" | "chat" = "agent"): { command: string; args: string[]; env: Record<string, string> } {
  return { command: process.execPath, args: [fileURLToPath(new URL("../../../packages/mcp/dist/stub/main.js", import.meta.url))], env: { ATE_STUB_SCOPE: scope } };
}
export * from "./events.js";
