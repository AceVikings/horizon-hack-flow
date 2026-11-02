// MCP stub server (§21.4 `packages/mcp/stub`): serves the frozen schemas, returns canned ToolResults.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createStubHandler, InvalidParamsError, UnknownToolError, type StubOptions } from "./handler.js";

export const STUB_SERVER_NAME = "ate";
export const STUB_SERVER_VERSION = "0.1.0-stub";

export function createStubServer(opts: StubOptions): Server {
  const h = createStubHandler(opts);
  const server = new Server(
    { name: STUB_SERVER_NAME, version: STUB_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: `ATE MCP STUB (scope=${opts.scope}, hsp=${opts.hsp}). Canned fixture data for both markets; no chain access.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: h.listTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = h.callTool(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
    } catch (e) {
      if (e instanceof InvalidParamsError) throw new McpError(ErrorCode.InvalidParams, e.message, { errors: e.errors });
      if (e instanceof UnknownToolError) throw new McpError(ErrorCode.InvalidParams, e.message);
      throw e;
    }
  });

  return server;
}

export function stubOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): StubOptions {
  const scope = env.ATE_STUB_SCOPE === "chat" ? "chat" : "agent";
  return { scope, hsp: env.ATE_STUB_HSP === "1" };
}
