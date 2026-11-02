// Real ATE MCP server plumbing (§7.1). Transport-agnostic: the daemon supplies a ToolBackend bound to the
// caller's token scope; this module exposes it over the MCP SDK (Streamable HTTP in the daemon, stdio via
// the proxy below). Results are JSON text content; `isError` mirrors `ok:false` (same as the stub).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolName, ToolResult } from "@ate/core";
import { TOOL_DEFINITIONS } from "../schemas.js";

export const SERVER_NAME = "ate";

export interface ToolBackend {
  listTools(): ToolName[];
  /** Throw an error with `name === "InvalidParamsError"` (and `errors: string[]`) for schema-invalid args. */
  callTool(name: string, args: unknown): Promise<ToolResult<unknown>>;
}

export function createAteMcpServer(backend: ToolBackend, opts: { version: string; instructions?: string }): Server {
  const server = new Server({ name: SERVER_NAME, version: opts.version }, { capabilities: { tools: {} }, ...(opts.instructions ? { instructions: opts.instructions } : {}) });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: backend.listTools().map((n) => {
      const t = TOOL_DEFINITIONS[n];
      return { name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await backend.callTool(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
    } catch (e) {
      const err = e as { name?: string; message?: string; errors?: string[] };
      if (err?.name === "InvalidParamsError" || err?.errors) throw new McpError(ErrorCode.InvalidParams, err.message ?? "invalid params", { errors: err.errors });
      throw e;
    }
  });
  return server;
}
