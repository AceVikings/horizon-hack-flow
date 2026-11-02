// The two in-app agents on the AiEngine (./engine.ts):
//  - the trader: a CycleExecutor for TraderRunner (no overlap, 90 s kill → no_trade(timeout), candidate binding and
//    guard checks are unchanged: every tool call goes through AteService.callTool("agent", …)).
//  - the chat agent: one streamed turn per user message, chat scope + allowlist, tool cards emitted live.

import { readFileSync } from "node:fs";
import { CHAT_TOOL_ALLOWLIST } from "@ate/core";
import { describeAiError, toolResultContent, type AiEngine, type Conversation } from "./engine.js";
import type { AteService } from "./service.js";

/** Structural copy of @ate/trader's CycleExecutor (kept local so this module has no runtime import of the trader). */
interface CycleCtx {
  cycle: number;
  reason: string;
  startedAt: number;
  signal: AbortSignal;
}
interface CycleOut {
  ok: boolean;
  summary?: string;
  costUsd?: number;
  turns?: number;
}

export interface SdkTraderOptions {
  ai: AiEngine;
  service: Pick<AteService, "callTool">;
  promptFile: string;
  toolNames: readonly string[];
  dryRun: boolean;
  context: string[];
  log?: (m: string) => void;
}

export function createSdkTraderExecutor(o: SdkTraderOptions): { run(ctx: CycleCtx): Promise<CycleOut> } {
  // frozen system prompt (read once; no timestamps): the cycle's volatile lines go in the user message
  const system = readFileSync(o.promptFile, "utf8");
  return {
    async run(ctx) {
      const lines = [
        `Cycle ${ctx.cycle} (${ctx.reason}) at ${new Date(ctx.startedAt).toISOString()}.`,
        ...o.context,
        o.dryRun
          ? "DRY RUN: evaluate exactly as usual and end each market with ate_propose or ate_decide, but never call ate_execute (it is not available)."
          : "Run the cycle now: read state, evaluate every candidate and the discretionary lane, and end each market in ate_execute (after ate_propose) or ate_decide.",
      ];
      const conv = o.ai.conversation();
      o.ai.pushUser(conv, lines.join("\n"));
      try {
        const r = await o.ai.run("trader", conv, {
          effort: o.ai.config.traderEffort,
          system,
          toolNames: o.toolNames,
          signal: ctx.signal,
          maxTurns: 24,
          call: async (name: string, input: unknown) => toolResultContent(await o.service.callTool("agent", name, input, { engine: "llm" }).catch((e: Error) => ({ ok: false, error: { code: "ATE_INVALID_PARAMS", message: e.message } }))),
        });
        o.log?.(`cycle ${ctx.cycle}: ${r.stop} · ${r.turns} turns · ${r.toolCalls} tool calls · ${conv.provider}/${conv.model}${r.servedBy !== conv.model ? ` (served by ${r.servedBy})` : ""} · in ${r.usage.inputTokens} out ${r.usage.outputTokens} cache read ${r.usage.cacheReadTokens} write ${r.usage.cacheWriteTokens}`);
        if (r.stop === "refusal") return { ok: false, summary: `model refused (${r.refusal?.category ?? "unspecified"})`, turns: r.turns };
        if (r.stop === "max_tokens" || r.stop === "max_turns") return { ok: false, summary: `${r.stop}: ${r.text.slice(0, 1500)}`, turns: r.turns };
        return { ok: r.stop !== "aborted", summary: r.text.slice(0, 2000), turns: r.turns };
      } catch (e) {
        if (ctx.signal.aborted) return { ok: false, summary: "aborted at the cycle timeout" };
        const d = describeAiError(e);
        return { ok: false, summary: `${d.kind}: ${d.message}` };
      }
    },
  };
}

// ------------------------------------------------------------------ chat

export interface SdkChatTurn {
  sessionId: string;
  turnId: string;
  text: string;
}
export interface SdkChatOptions {
  ai: AiEngine;
  service: Pick<AteService, "callTool">;
  promptFile: string;
  emit: (e: { type: string; at: number; data: unknown }) => void;
}

/** Per-session append-only histories (expire with the chat session). */
const histories = new Map<string, { at: number; conv: Conversation }>();

export async function runSdkChatTurn(o: SdkChatOptions, t: SdkChatTurn): Promise<{ reply: string; engine: "llm"; streamed: true; unstreamed: string; model: string }> {
  const now = () => Math.floor(Date.now() / 1000);
  for (const [k, v] of histories) if (now() - v.at > 30 * 60) histories.delete(k);
  let h = histories.get(t.sessionId);
  const cfg = o.ai.config;
  // a provider or model switch starts a fresh conversation (histories are in each provider's native format)
  if (!h || h.conv.provider !== cfg.provider || h.conv.model !== cfg.model) h = { at: now(), conv: o.ai.conversation() };
  h.at = now();
  histories.set(t.sessionId, h);
  o.ai.pushUser(h.conv, t.text);
  const system = readFileSync(o.promptFile, "utf8");
  const r = await o.ai.run("chat", h.conv, {
    effort: cfg.chatEffort,
    system,
    toolNames: CHAT_TOOL_ALLOWLIST,
    maxTurns: 8,
    maxTokens: 8000,
    onText: (d: string) => o.emit({ type: "chat.delta", at: now(), data: { sessionId: t.sessionId, turnId: t.turnId, role: "agent", text: d, engine: "llm", model: cfg.model, provider: cfg.provider, done: false } }),
    call: async (name: string, input: unknown) => {
      const result = await o.service.callTool("chat", name, input).catch((e: Error) => ({ ok: false, error: { code: "ATE_INVALID_PARAMS", message: e.message } }));
      o.emit({ type: "chat.tool", at: now(), data: { sessionId: t.sessionId, turnId: t.turnId, tool: name, args: input, result } });
      return toolResultContent(result);
    },
  });
  const unstreamed = r.stop === "refusal" ? "\n\nI can't help with that request." : r.stop === "max_tokens" || r.stop === "max_turns" ? `\n\n(stopped early: ${r.stop.replace("_", " ")})` : "";
  return { reply: (r.text + unstreamed).trim(), engine: "llm", streamed: true, unstreamed, model: cfg.model };
}
