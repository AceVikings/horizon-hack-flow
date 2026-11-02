// Chat + human trade approval routes (§10.1, §11.5, §7.3 confirm mode).
//
//   POST /chat/token   (session)     → { token, expiresAt }: the daemon's `chat` token behind one `ate chat` session
//                                      (`ate chat` hands it to its chat-scoped stdio proxy; never written to disk).
//   POST /chat         (ui|session)  { sessionId, text } → { sessionId, turnId, accepted }; the turn runs the
//                                      allowlisted chat runner (Lane C's `claude -p`, rules fallback) with a chat
//                                      token; the reply streams over /events as `chat.delta` (+ `chat.tool`).
//   POST /trade/approve (ui|session) step 1 { proposalId } → { nonce, expiresAt, body } (the `trade` payload body);
//                                      step 2 { proposalId, nonce, approval } → ate-approve signature (Secure
//                                      Enclave only — confirm-mode trades never accept a TTY code, §10.1).
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AteError, e8ToUsd, type TokenScope } from "@ate/core";
import type { Routes, TokenRegistry } from "./http.js";
import type { AteService } from "./service.js";
import { describeAiError, findClaudeBin, type AiEngine } from "./engine.js";
import { runSdkChatTurn } from "./engine-agents.js";

export interface ChatRoutesOptions {
  routes: Routes;
  tokens: TokenRegistry;
  service: AteService;
  home: string;
  emit: (e: { type: string; at: number; data: unknown }) => void;
  log?: (m: string) => void;
  /** Override the chat turn (tests). */
  runTurn?: (o: { sessionId: string; claudeSession: string; firstTurn: boolean; text: string; chatToken: string; turnId: string }) => Promise<{ reply: string; engine: "llm" | "rules"; tool?: string; streamed?: boolean; unstreamed?: string; model?: string; cliSession?: boolean }>;
  /** In-app agent engine (Anthropic SDK). When it has credentials and engine = "sdk", chat turns run on it. */
  ai?: AiEngine;
  /** Pinned ate-approve key path (defaults to Lane E's). */
  pinnedKeyPath?: string;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Additive (Flow v1 tool cards): the running turn per chat session, so MCP calls can emit `chat.tool` with args + result. */
export const activeChatTurns = new Map<string, string>();
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface ChatSess {
  claudeSession: string;
  first: boolean;
  chatToken: string;
  expiresAt: number;
  busy: boolean;
}

/** stdio MCP spec for a chat-scoped proxy: this daemon's own bin, `mcp serve`, chat token via env only. */
export function chatMcpSpec(home: string, chatToken: string) {
  const bin = fileURLToPath(new URL("./bin.js", import.meta.url));
  return { command: process.execPath, args: [existsSync(bin) ? bin : fileURLToPath(new URL("../dist/bin.js", import.meta.url)), "mcp", "serve"], env: { ATE_HOME: home, ATE_MCP_TOKEN: chatToken, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) } };
}

/** The plain error Ask shows (with Try again) when the AI engine is set up but did not answer. */
export const aiNoAnswer = (reason: string) => `The AI didn't answer (${reason.replace(/\s+/g, " ").trim().slice(0, 240) || "no reply"}). Try again.`;
export class ChatAiError extends Error {}

type TurnResult = { reply: string; engine: "llm" | "rules"; tool?: string; streamed?: boolean; unstreamed?: string; model?: string; cliSession?: boolean };

async function defaultRunTurn(
  co: ChatRoutesOptions,
  o: { sessionId: string; turnId: string; claudeSession: string; firstTurn: boolean; text: string; chatToken: string },
): Promise<TurnResult> {
  const home = co.home;
  const name = "@ate/chat";
  const chat = (await import(name)) as typeof import("@ate/chat");
  const rulesOnly = process.env.ATE_CHAT_ENGINE === "rules" || !co.ai;
  // the Claude Code CLI engine only runs Anthropic models (a provider switch leaves engine = "claude-code" behind)
  const viaCli = !rulesOnly && co.ai!.config.engine === "claude-code" && co.ai!.config.provider === "anthropic";
  // In-app engine first (Anthropic SDK / OpenAI / opencode, chat scope + allowlist, streamed text and tool cards)
  if (!rulesOnly && !viaCli && co.ai!.available()) {
    try {
      return await runSdkChatTurn({ ai: co.ai!, service: co.service, promptFile: chat.CHAT_PROMPT_PATH, emit: co.emit }, { sessionId: o.sessionId, turnId: o.turnId, text: o.text });
    } catch (e) {
      throw new ChatAiError(aiNoAnswer(describeAiError(e).message));
    }
  }
  const traderName = "@ate/trader";
  const trader = (await import(traderName)) as typeof import("@ate/trader");
  const mcp = chatMcpSpec(home, o.chatToken);
  // optional: the Claude Code CLI engine, resumed per chat session
  if (viaCli) {
    const turn = (firstTurn: boolean) => chat.runChatTurn({ claudeBin: findClaudeBin() ?? "claude", sessionId: o.claudeSession, firstTurn, text: o.text, mcp });
    let r = await turn(o.firstTurn);
    // the CLI holds no conversation under this id yet (earlier turns ran on another engine): start it;
    // or a failed first turn already created it: resume it
    if (!r.ok && !o.firstTurn && /no conversation found/i.test(r.reply)) r = await turn(true);
    else if (!r.ok && o.firstTurn && /already in use/i.test(r.reply)) r = await turn(false);
    if (r.ok) return { reply: r.reply, engine: "llm", cliSession: true };
    co.log?.(`chat: Claude Code turn failed: ${r.reply.slice(0, 200)}`);
    throw new ChatAiError(aiNoAnswer(r.reply ? `Claude Code: ${r.reply}` : "Claude Code exited without a reply"));
  }
  // rules: its known intents only when an AI engine is chosen but not reachable; everything when there is no AI
  const aiChosen = !rulesOnly && co.ai!.chosen;
  let tools: Awaited<ReturnType<typeof trader.connectAte>> | null = null;
  try {
    if (aiChosen && chat.parseIntent(o.text).kind === "unknown") throw new ChatAiError(aiNoAnswer(`${co.ai!.config.provider} is not reachable right now`));
    const rules = chat.createRulesChat(async () => (tools ??= await trader.connectAte(mcp)));
    const r = await rules.handle(o.text);
    return { reply: r.reply, engine: "rules", ...(r.tool ? { tool: r.tool } : {}) };
  } finally {
    await (tools as { close(): Promise<void> } | null)?.close().catch(() => {});
  }
}

export function registerChatRoutes(o: ChatRoutesOptions) {
  const sessions = new Map<string, ChatSess>();
  const t0 = () => nowSec();

  const sessFor = (sessionId: string, expiresAt: number): ChatSess => {
    let s = sessions.get(sessionId);
    if (!s || s.expiresAt < t0()) {
      if (s) o.tokens.revoke(s.chatToken);
      s = { claudeSession: randomUUID(), first: true, chatToken: o.tokens.mint({ scope: "chat", sessionId, expiresAt }), expiresAt, busy: false };
      sessions.set(sessionId, s);
    }
    return s;
  };

  o.routes.register({
    method: "POST",
    path: "/chat/token",
    scopes: ["session"],
    handler: ({ auth, json }) => {
      if (!auth?.sessionId) return json(403, { error: "session handle required" });
      const exp = auth.expiresAt ?? t0() + 30 * 60;
      const s = sessFor(auth.sessionId, exp);
      json(200, { sessionId: auth.sessionId, token: s.chatToken, expiresAt: s.expiresAt, scope: "chat" });
    },
  });

  o.routes.register({
    method: "POST",
    path: "/chat",
    scopes: ["ui", "session"],
    handler: ({ body, auth, json }) => {
      const b = (body ?? {}) as { sessionId?: unknown; text?: unknown };
      if (typeof b.sessionId !== "string" || !SESSION_RE.test(b.sessionId) || typeof b.text !== "string" || !b.text.trim() || b.text.length > 4000) {
        return json(400, { error: "expected { sessionId, text } (text ≤ 4000 chars)" });
      }
      if (auth?.scope === "session" && auth.sessionId !== b.sessionId) return json(403, { error: "this session handle authorises a different session" });
      const s = sessFor(b.sessionId, auth?.expiresAt ?? t0() + 30 * 60);
      if (s.busy) return json(409, { error: "a turn is already running for this session" });
      s.busy = true;
      // 30 min idle: every turn extends the chat token's life (bounded by the session handle's TTL for `session`).
      const turnId = `turn_${randomBytes(6).toString("hex")}`;
      const sessionId = b.sessionId;
      const text = b.text;
      o.service.o.db.prepare("INSERT INTO chat_messages (id, session_id, role, content, at) VALUES (?, ?, 'user', ?, ?)").run(`${turnId}_u`, sessionId, text, t0());
      o.emit({ type: "chat.delta", at: t0(), data: { sessionId, turnId, role: "user", text, done: false } });
      const run = o.runTurn ?? ((x) => defaultRunTurn(o, x));
      activeChatTurns.set(sessionId, turnId);
      void run({ sessionId, turnId, claudeSession: s.claudeSession, firstTurn: s.first, text, chatToken: s.chatToken })
        .then((r) => {
          // only a Claude Code CLI turn creates the CLI conversation that later turns `--resume`
          if (r.cliSession) s.first = false;
          o.service.o.db.prepare("INSERT INTO chat_messages (id, session_id, role, content, tool_name, at) VALUES (?, ?, 'assistant', ?, ?, ?)").run(`${turnId}_a`, sessionId, r.reply, r.tool ?? null, t0());
          // (the MCP layer already emitted a full chat.tool for each call; this name-only one is kept for `ate chat`)
          if (r.tool) o.emit({ type: "chat.tool", at: t0(), data: { sessionId, turnId, tool: r.tool, summary: true } });
          // streamed turns already sent their text as deltas: the closing delta carries only what was not streamed
          o.emit({ type: "chat.delta", at: t0(), data: { sessionId, turnId, role: "agent", text: r.streamed ? (r.unstreamed ?? "") : r.reply, engine: r.engine, ...(r.model ? { model: r.model } : {}), done: true } });
        })
        .catch((e) => {
          const text = e instanceof ChatAiError ? e.message : aiNoAnswer(describeAiError(e).message);
          try {
            o.service.o.db.prepare("INSERT INTO chat_messages (id, session_id, role, content, tool_name, at) VALUES (?, ?, 'assistant', ?, NULL, ?)").run(`${turnId}_a`, sessionId, text, t0());
          } catch {
            /* already recorded */
          }
          o.emit({ type: "chat.delta", at: t0(), data: { sessionId, turnId, role: "agent", text, error: true, done: true } });
        })
        .finally(() => {
          s.busy = false;
          if (activeChatTurns.get(sessionId) === turnId) activeChatTurns.delete(sessionId);
        });
      json(200, { sessionId, turnId, accepted: true });
    },
  });

  // ---- confirm-mode trade approvals (signature only)
  const tradeNonces = new Map<string, { proposalId: string; expiresAt: number }>();
  let verifier: { verify: (p: unknown, sig: string, now: number) => { ok: boolean; reason?: string } } | null | undefined;
  const getVerifier = async () => {
    if (verifier !== undefined) return verifier;
    try {
      const name = "@ate/approve";
      const m = (await import(name)) as { createApprovalVerifier: (k: unknown, aud: string) => typeof verifier; loadPinnedKey: (p: string) => unknown; DEFAULT_PINNED_KEY_PATH: string };
      const p = o.pinnedKeyPath ?? m.DEFAULT_PINNED_KEY_PATH;
      verifier = existsSync(p) ? m.createApprovalVerifier(m.loadPinnedKey(p), "ate-daemon") : null;
    } catch (e) {
      o.log?.(`trade approve verifier unavailable: ${(e as Error).message}`);
      verifier = null;
    }
    return verifier;
  };

  o.routes.register({
    method: "POST",
    path: "/trade/approve",
    scopes: ["ui", "session"] as TokenScope[],
    handler: async ({ body, json }) => {
      const b = (body ?? {}) as { proposalId?: string; nonce?: string; approval?: string };
      if (typeof b.proposalId !== "string") return json(400, { error: "proposalId required" });
      const p = o.service.pendingHuman(b.proposalId);
      if (!p) return json(404, { error: { code: "ATE_PROPOSAL_UNKNOWN", message: "no proposal awaiting a human approval with that id" } });
      const tradeBody = { proposalId: p.id, market: p.market, side: p.side, amountUsd: e8ToUsd(BigInt(p.notionalUsdE8)), amountIn: p.amountIn, tokenIn: p.tokenIn };
      if (b.nonce === undefined) {
        const nonce = randomBytes(16).toString("hex");
        const expiresAt = Math.min(t0() + 60, p.expiresAt);
        tradeNonces.set(nonce, { proposalId: p.id, expiresAt });
        return json(200, { nonce, expiresAt, body: tradeBody });
      }
      const n = tradeNonces.get(b.nonce);
      tradeNonces.delete(String(b.nonce));
      if (!n || n.proposalId !== p.id) return json(404, { error: { code: "ATE_APPROVAL_REQUIRED", message: "unknown or used nonce" } });
      if (n.expiresAt < t0()) return json(410, { error: { code: "ATE_APPROVAL_REQUIRED", message: "nonce expired" } });
      if (typeof b.approval !== "string" || /^\d{8}$/.test(b.approval)) return json(401, { error: { code: "ATE_APPROVAL_REQUIRED", message: "confirm-mode trades need an ate-approve signature (no TTY codes, §10.1)" } });
      const v = await getVerifier();
      if (!v) return json(401, { error: { code: "ATE_APPROVAL_REQUIRED", message: "no approval key pinned (~/.ate/approve-pubkey.json)" } });
      const m = (await import("@ate/approve" as string)) as { tradePayload: (a: unknown) => unknown };
      const r = v.verify(m.tradePayload({ nonce: b.nonce, expiresAt: n.expiresAt, ...tradeBody }), b.approval, t0());
      if (!r.ok) return json(401, { error: { code: "ATE_APPROVAL_REQUIRED", message: `approval signature rejected (${r.reason ?? "invalid"})` } });
      try {
        json(200, o.service.approveHuman(p.id));
      } catch (e) {
        json(400, { error: e instanceof AteError ? e.toToolError() : (e as Error).message });
      }
    },
  });
}
