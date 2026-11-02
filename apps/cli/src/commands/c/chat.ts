// `ate chat` — the Chat view in a terminal (§11.5): allowlisted `claude -p` per turn (resumed per session),
// deterministic rules fallback (★ intents, engine=rules) when no LLM is configured or it fails.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createRulesChat, runChatTurn } from "@ate/chat";
import { connectAte, stubMcpSpec, type AteTools, type McpServerSpec } from "@ate/trader";
import type { CommandModule } from "../index.js";

const USAGE = `ate chat [--engine llm|rules] [--stub | --mcp-command "<cmd> <args…>"] [--model <m>] [--once "<text>"]

The MCP server must be chat-scoped (the chat tool allowlist). --stub uses the packages/mcp stub with
ATE_STUB_SCOPE=chat; against the daemon pass a chat-token stdio proxy via --mcp-command or ATE_CHAT_MCP_COMMAND.
Loosening changes return ATE_APPROVAL_REQUIRED with the diff to approve with ate-approve (Touch ID).`;

const cmd: CommandModule = {
  name: "chat",
  summary: "Talk to ATE: positions/P&L, strategy changes, go to cash, pause (LLM with rules fallback)",
  usage: USAGE,
  async run(ctx) {
    const { values } = parseArgs({
      args: ctx.argv,
      options: {
        engine: { type: "string", default: "llm" },
        stub: { type: "boolean", default: false },
        "mcp-command": { type: "string" },
        model: { type: "string" },
        once: { type: "string" },
      },
    });
    const custom = values["mcp-command"] ?? ctx.env.ATE_CHAT_MCP_COMMAND;
    let mcp: McpServerSpec;
    if (values.stub) mcp = stubMcpSpec("chat");
    else if (custom) {
      const p = custom.trim().split(/\s+/);
      mcp = { command: p[0]!, args: p.slice(1) };
    } else {
      ctx.stderr.write(USAGE + "\n");
      return 2;
    }
    let tools: AteTools | null = null;
    const getTools = async () => (tools ??= await connectAte(mcp));
    const rules = createRulesChat(getTools);
    const sessionId = randomUUID();
    let first = true;

    const turn = async (text: string): Promise<string> => {
      if (values.engine !== "rules") {
        const r = await runChatTurn({ sessionId, firstTurn: first, text, mcp, ...(values.model ? { model: values.model } : {}) });
        if (r.ok) {
          first = false;
          return r.reply;
        }
        ctx.stderr.write(`(LLM unavailable: ${r.reply.slice(0, 200)} — falling back to rules)\n`);
      }
      const r = await rules.handle(text);
      return `${r.reply}\n[engine=rules${r.tool ? `, tool=${r.tool}` : ""}]`;
    };

    try {
      if (values.once) {
        ctx.stdout.write((await turn(values.once)) + "\n");
        return 0;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
      ctx.stdout.write(`ATE chat (session ${sessionId.slice(0, 8)}, engine=${values.engine}). Ctrl-D to exit.\n`);
      rl.prompt();
      for await (const line of rl) {
        const text = line.trim();
        if (text) ctx.stdout.write(`ate> ${await turn(text)}\n`);
        rl.prompt();
      }
      return 0;
    } finally {
      await (tools as AteTools | null)?.close().catch(() => {});
    }
  },
};

export default cmd;
