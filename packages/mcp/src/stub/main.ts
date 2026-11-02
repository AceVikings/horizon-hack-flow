#!/usr/bin/env node
// stdio entry: `pnpm --filter @ate/mcp stub` (agent scope) or `stub:chat` (chat allowlist).
// Env: ATE_STUB_SCOPE=agent|chat, ATE_STUB_HSP=1 to register ate_signal_buy.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStubServer, stubOptionsFromEnv } from "./server.js";

const opts = stubOptionsFromEnv();
const server = createStubServer(opts);
await server.connect(new StdioServerTransport());
process.stderr.write(`ate MCP stub listening on stdio (scope=${opts.scope}, hsp=${opts.hsp})\n`);
