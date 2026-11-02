// Writes packages/mcp/schemas/<tool>.json from src/schemas.ts (the TS objects are the source of truth).
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHAT_TOOL_ALLOWLIST, HSP_GATED_TOOLS, TOOL_NAMES } from "@ate/core";
import { TOOL_LIST } from "../src/schemas.js";

const dir = fileURLToPath(new URL("../schemas/", import.meta.url));
mkdirSync(dir, { recursive: true });
for (const t of TOOL_LIST) writeFileSync(`${dir}${t.name}.json`, JSON.stringify(t, null, 2) + "\n");
writeFileSync(
  `${dir}_scopes.json`,
  JSON.stringify({ agent: TOOL_NAMES, chat: CHAT_TOOL_ALLOWLIST, hspGated: HSP_GATED_TOOLS }, null, 2) + "\n",
);
console.log(`wrote ${TOOL_LIST.length} schemas to ${dir}`);
