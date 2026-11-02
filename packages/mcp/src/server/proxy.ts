// `ate mcp serve`: stdio MCP server that proxies to the running daemon's Streamable HTTP endpoint with the
// `agent` token from runtime.json (§7.1). It never loads a key or opens a chain connection.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SERVER_NAME } from "./index.js";

export interface ProxyOptions {
  url: string;
  token: string;
  version: string;
  /** Override the downstream (stdio by default; tests pass an in-memory transport). */
  downstream?: Transport;
}

export async function connectDaemonClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "ate-mcp-proxy", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

export async function runStdioProxy(o: ProxyOptions): Promise<{ close(): Promise<void> }> {
  const upstream = await connectDaemonClient(o.url, o.token);
  const server = new Server({ name: SERVER_NAME, version: o.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());
  // Errors (incl. InvalidParams McpError) propagate unchanged to the stdio client.
  server.setRequestHandler(CallToolRequestSchema, async (req) => upstream.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }) as never);
  await server.connect(o.downstream ?? new StdioServerTransport());
  return {
    close: async () => {
      await server.close();
      await upstream.close();
    },
  };
}
