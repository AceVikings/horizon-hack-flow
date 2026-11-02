// `ate chat` — the Chat view in a terminal (§11.5): allowlisted `claude -p` per turn (resumed per session),
// deterministic rules fallback (★ intents, engine=rules) when no LLM is configured or it fails.
//
// Default target is the running daemon: a `session` handle from POST /chat/session (ate-approve / Touch ID, or the
// armed TTY-code fallback), the session's `chat` token from POST /chat/token, and `ate mcp serve` with
// ATE_MCP_TOKEN=<chat token> as the chat-scoped stdio proxy. Loosening changes are approved in-line via
// POST /strategy/approve. Tokens are never printed or written to disk.
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import type { StrategyApprovalPending } from "@ate/core";
import { createRulesChat, runChatTurn } from "@ate/chat";
import { connectAte, stubMcpSpec, type AteTools, type McpServerSpec } from "@ate/trader";
import type { CommandContext, CommandModule } from "../index.js";
import { approveStrategyChange, changeIdsIn, chatMcpSpec, fetchPending, isPending, openChatSession, type ApprovalIo, type ChatDaemonSession } from "./_chat-daemon.js";

const USAGE = `ate chat [--engine llm|rules] [--stub | --mcp-command "<cmd> <args…>"] [--model <m>] [--once "<text>"]

Default: attach to the running daemon (runtime.json in $ATE_HOME or ~/.ate). Opening the session needs Touch ID
(ate-approve), or the 8-digit code printed on the daemon's terminal when it runs with --approval-fallback=armed.
The chat runs against a chat-scoped stdio proxy (\`ate mcp serve\` with the session's chat token).
--stub uses the packages/mcp stub with ATE_STUB_SCOPE=chat; --mcp-command / ATE_CHAT_MCP_COMMAND use your own
chat-scoped MCP server. Loosening changes return ATE_APPROVAL_REQUIRED; against the daemon you are offered to
approve them right away (Touch ID or TTY code).`;

/** Line reader over stdin that survives EOF (resolves null) and is shared by the REPL and approval prompts. */
function lineReader(input: NodeJS.ReadableStream, prompt: NodeJS.WritableStream) {
  let rl: Interface | null = null;
  const buf: string[] = [];
  const waiters: ((l: string | null) => void)[] = [];
  let closed = false;
  const ensure = () => {
    if (rl) return;
    rl = createInterface({ input, terminal: false });
    rl.on("line", (l) => (waiters.length ? waiters.shift()!(l) : buf.push(l)));
    rl.on("close", () => {
      closed = true;
      while (waiters.length) waiters.shift()!(null);
    });
  };
  return {
    read(q: string): Promise<string | null> {
      ensure();
      prompt.write(q);
      if (buf.length) return Promise.resolve(buf.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((r) => waiters.push(r));
    },
    close: () => rl?.close(),
  };
}

const cmd: CommandModule = {
  name: "chat",
  summary: "Talk to ATE: positions/P&L, strategy changes, go to cash, pause (LLM with rules fallback)",
  usage: USAGE,
  async run(ctx: CommandContext) {
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
    const lines = lineReader(process.stdin, ctx.stderr);
    const io: ApprovalIo = { ask: async (q) => (await lines.read(q)) ?? "", log: (l) => void ctx.stderr.write(`${l}\n`) };

    const custom = values["mcp-command"] ?? ctx.env.ATE_CHAT_MCP_COMMAND;
    let mcp: McpServerSpec;
    let daemon: ChatDaemonSession | null = null;
    if (values.stub) mcp = stubMcpSpec("chat");
    else if (custom) {
      const p = custom.trim().split(/\s+/);
      mcp = { command: p[0]!, args: p.slice(1) };
    } else {
      try {
        daemon = await openChatSession({ env: ctx.env, io });
      } catch (e) {
        lines.close();
        ctx.stderr.write(`ate chat: ${(e as Error).message}\n`);
        return 1;
      }
      mcp = chatMcpSpec(daemon);
    }

    // Capture ATE_APPROVAL_REQUIRED details from tool calls we make ourselves (rules engine).
    const pending = new Map<string, StrategyApprovalPending>();
    const capture = (t: AteTools): AteTools => ({
      async call(name, args) {
        const r = await t.call(name, args);
        if (!r.ok && r.error.code === "ATE_APPROVAL_REQUIRED" && isPending(r.error.details)) pending.set(r.error.details.changeId, r.error.details);
        return r;
      },
      close: () => t.close(),
    });
    let tools: AteTools | null = null;
    const getTools = async () => (tools ??= capture(await connectAte(mcp)));
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

    /** After a turn against the daemon: offer to approve every loosening change it left pending. */
    const offerApprovals = async (reply: string) => {
      if (!daemon) return;
      const ids = [...new Set([...pending.keys(), ...changeIdsIn(reply)])];
      for (const id of ids) {
        const ans = (await io.ask(`Approve loosening change ${id}? [y/N] `)).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          ctx.stdout.write(`(not approved; ${id} expires in 60 s)\n`);
          continue;
        }
        try {
          const details = pending.get(id) ?? (await fetchPending(daemon, id));
          const r = await approveStrategyChange(daemon, { changeId: id, details }, { io });
          ctx.stdout.write(`Approved ${id}: applied (journal ${r.decisionId}); ${r.changes.map((c) => `${c.scope} ${String(c.field)} ${String(c.before)} → ${String(c.after)}`).join(", ")}\n`);
        } catch (e) {
          ctx.stderr.write(`approval of ${id} failed: ${(e as Error).message}\n`);
        }
      }
      pending.clear();
    };

    try {
      if (values.once) {
        const reply = await turn(values.once);
        ctx.stdout.write(reply + "\n");
        await offerApprovals(reply);
        return 0;
      }
      ctx.stdout.write(
        `ATE chat (session ${daemon ? daemon.sessionId : sessionId.slice(0, 8)}${daemon ? `, daemon :${daemon.rt.port}` : ""}, engine=${values.engine}). Ctrl-D to exit.\n`,
      );
      for (;;) {
        const line = await lines.read("you> ");
        if (line === null) break;
        const text = line.trim();
        if (!text) continue;
        const reply = await turn(text);
        ctx.stdout.write(`ate> ${reply}\n`);
        await offerApprovals(reply);
      }
      return 0;
    } finally {
      lines.close();
      await (tools as AteTools | null)?.close().catch(() => {});
    }
  },
};

export default cmd;
