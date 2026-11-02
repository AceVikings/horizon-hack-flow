// Minimal typed MCP client over stdio for the runner itself (rules engine, timeout records, scan).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolInput, ToolName, ToolOutput, ToolResult } from "@ate/core";
import type { McpServerSpec } from "./claude.js";

export interface AteTools {
  call<T extends ToolName>(name: T, args: ToolInput<T>): Promise<ToolResult<ToolOutput<T>>>;
  close(): Promise<void>;
}

export async function connectAte(spec: McpServerSpec): Promise<AteTools> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
    stderr: "ignore",
  });
  const client = new Client({ name: "ate-trader-runner", version: "0.1.0" });
  await client.connect(transport);
  return {
    async call(name, args) {
      const r = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { content?: { type: string; text?: string }[] };
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      return JSON.parse(text) as ToolResult<ToolOutput<typeof name>>;
    },
    close: () => client.close(),
  };
}
