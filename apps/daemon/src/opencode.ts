// OpenCode engine (Flow v1): the trader and the chat agent run on the user's existing opencode login through the
// official SDK (@opencode-ai/sdk). The daemon starts a private `opencode serve` on 127.0.0.1 and registers Flow's own
// MCP endpoint (Streamable HTTP /mcp) twice — `flowagent` with an agent-scope token, `flowchat` with a chat-scope
// token — so opencode's agent calls Flow's tools, which keep every server-side rule (allowlists, candidate binding,
// guard, approvals). Built-in shell / file / web tools are switched off in the config and denied by permission, and
// every prompt enables only the allowlisted Flow tools for its scope. Journal label: actor.agentId = "opencode:<model>".

import { createOpencodeClient, createOpencodeServer, type OpencodeClient } from "@opencode-ai/sdk";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import type { TokenInfo, TokenRegistry } from "./http.js";
import { abortable, type LoopResult, type ModelInfo } from "./providers.js";
import type { McpServers } from "./mcp-servers.js";

/** Built-in opencode tools Flow never allows (belt and braces with `permission` and per-prompt `tools`). */
const BUILTINS = ["bash", "edit", "write", "read", "grep", "glob", "list", "patch", "multiedit", "webfetch", "websearch", "codesearch", "task", "todowrite", "todoread", "skill", "lsp", "batch"];
const SERVERS = { agent: "flowagent", chat: "flowchat" } as const;
/** Preferred defaults (verified with the user's opencode login), then any tool-calling model. */
export const OPENCODE_PREFERRED = ["opencode/deepseek-v4.1-flash", "opencode/glm-5.3-flash"];

export function findOpencode(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ATE_OPENCODE_BIN && existsSync(env.ATE_OPENCODE_BIN)) return env.ATE_OPENCODE_BIN;
  const dirs = [...(env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".opencode/bin"), join(homedir(), ".local/bin")];
  for (const d of dirs) if (d && existsSync(join(d, "opencode"))) return join(d, "opencode");
  return null;
}

/** Provider ids the user is signed in to (from opencode's auth file; only the keys are read, never the secrets' use). */
export function opencodeLogins(env: NodeJS.ProcessEnv = process.env): string[] {
  const p = env.ATE_OPENCODE_AUTH ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode", "auth.json");
  try {
    return Object.keys(JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export interface OpencodeOptions {
  home: string;
  daemonPort: number;
  tokens: TokenRegistry;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
  /** Tests: use an already running (mock) server instead of spawning `opencode serve`. */
  baseUrl?: string;
  /** Extra MCP servers (Tools (MCP)): enabled ones are registered, the user's own opencode servers stay off otherwise. */
  mcp?: McpServers;
}

type Prompt = {
  scope: "agent" | "chat";
  model: string;
  system: string;
  text: string;
  toolNames: readonly string[];
  sessionId?: string;
  signal?: AbortSignal;
  agentId: string;
  noExtraTools?: boolean;
  /** Chat scope: the Flow chat session (Ask / Trade) this turn belongs to, so the MCP layer emits its tool cards there. */
  chatSessionId?: string;
};
type OcPart = { id?: string; type: string; text?: string; tool?: string; callID?: string; state?: { status: string; input?: unknown; output?: string; error?: string } };
export type OpencodeToolCall = { tool: string; input: unknown; output: unknown; ok: boolean };

export class OpencodeEngine {
  private client: OpencodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private starting: Promise<OpencodeClient> | null = null;
  private tokenInfo: Record<"agent" | "chat", TokenInfo> | null = null;
  private tokenIds: string[] = [];
  private readonly work: string;
  /** Chat prompts run one at a time: the chat token's sessionId is pointed at the running turn's Flow chat session. */
  private chatLock: Promise<unknown> = Promise.resolve();
  lastError: string | null = null;

  constructor(private readonly o: OpencodeOptions) {
    this.work = join(o.home, "opencode-work");
  }

  get installed(): boolean {
    return !!this.o.baseUrl || !!findOpencode(this.o.env);
  }
  get signedIn(): boolean {
    return !!this.o.baseUrl || opencodeLogins(this.o.env).length > 0;
  }
  get running(): boolean {
    return !!this.client;
  }

  private async freePort(): Promise<number> {
    return new Promise((res, rej) => {
      const s = createServer();
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => res(p));
      });
    });
  }

  /** Start (once) the private `opencode serve` with Flow's MCP registered and the built-in tools off. */
  async ensure(): Promise<OpencodeClient> {
    if (this.client) return this.client;
    this.starting ??= (async () => {
      mkdirSync(this.work, { recursive: true, mode: 0o700 });
      // scope tokens behind the two MCP registrations; agentId is set per prompt (cycles never overlap)
      const agent: TokenInfo = { scope: "agent", engine: "llm", agentId: "opencode" };
      const chat: TokenInfo = { scope: "chat", sessionId: "opencode", agentId: "opencode" };
      const at = this.o.tokens.mint(agent);
      const ct = this.o.tokens.mint(chat);
      this.tokenIds = [at, ct];
      this.tokenInfo = { agent: this.o.tokens.resolve(at)!, chat: this.o.tokens.resolve(ct)! };
      const mcp = (token: string) => ({ type: "remote" as const, url: `http://127.0.0.1:${this.o.daemonPort}/mcp`, headers: { authorization: `Bearer ${token}` }, oauth: false as const, enabled: true, timeout: 10_000 });
      let url = this.o.baseUrl;
      if (!url) {
        const bin = findOpencode(this.o.env);
        if (!bin) throw Object.assign(new Error("opencode is not installed on this Mac"), { status: 409, code: "ATE_CONFIG_INVALID" });
        // the SDK launches `opencode` from PATH: make sure the detected binary's folder is on it
        if (!(process.env.PATH ?? "").split(":").includes(dirname(bin))) process.env.PATH = `${dirname(bin)}:${process.env.PATH ?? ""}`;
        this.server = await createOpencodeServer({
          hostname: "127.0.0.1",
          port: await this.freePort(),
          timeout: 20_000,
          config: {
            autoupdate: false,
            share: "disabled",
            permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" },
            tools: Object.fromEntries(BUILTINS.map((t) => [t, false])),
            mcp: { ...this.extraMcp(), [SERVERS.agent]: mcp(at), [SERVERS.chat]: mcp(ct) },
          },
        });
        url = this.server.url;
        // never leave the private opencode server running without its daemon
        const srv = this.server;
        process.once("exit", () => srv.close());
        this.o.log?.(`opencode: server on ${url} (Flow MCP registered, built-in tools off)`);
      }
      this.client = createOpencodeClient({ baseUrl: url, directory: this.work });
      return this.client;
    })().catch((e) => {
      this.starting = null;
      this.lastError = (e as Error).message.split("\n")[0]!;
      throw e;
    });
    return this.starting;
  }

  /** opencode MCP entries for extra servers: Flow-enabled ones on, the user's other opencode servers off. */
  private extraMcp(): Record<string, unknown> {
    const reg = this.o.mcp;
    if (!reg) return {};
    const out: Record<string, unknown> = {};
    for (const d of reg.list()) {
      if (d.type === "builtin") continue;
      const on = d.enabled.chat || d.enabled.trader;
      const key = d.source === "opencode" ? d.name : `flowx-${d.id}`;
      out[key] = { ...reg.opencodeConfigFor(d), enabled: on };
    }
    return out;
  }
  /** Tool-id prefixes (as opencode names MCP tools) of the extra servers enabled for a scope. */
  private extraPrefixes(scope: "agent" | "chat"): string[] {
    const reg = this.o.mcp;
    if (!reg) return [];
    return reg.enabledFor(scope === "agent" ? "trader" : "chat").map((d) => `${(d.source === "opencode" ? d.name : `flowx-${d.id}`).replace(/[^A-Za-z0-9_-]/g, "_")}_`);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.client = null;
    this.starting = null;
    for (const t of this.tokenIds) this.o.tokens.revoke(t);
    this.tokenIds = [];
  }

  /** Tool-calling models from the providers the user is connected to in opencode, `provider/model`. */
  async models(): Promise<ModelInfo[]> {
    const c = await this.ensure();
    const r = await c.config.providers({ query: { directory: this.work } });
    const out: ModelInfo[] = [];
    for (const p of r.data?.providers ?? []) {
      for (const m of Object.values(p.models ?? {})) {
        const caps = (m as { capabilities?: { toolcall?: boolean } }).capabilities;
        const toolcall = (m as { tool_call?: boolean }).tool_call ?? caps?.toolcall;
        out.push({ id: `${p.id}/${m.id}`, label: `${p.name} · ${(m as { name?: string }).name ?? m.id}`, tools: toolcall === undefined ? null : !!toolcall, streaming: false });
      }
    }
    return out;
  }

  /**
   * One prompt: a fresh session per trader cycle (or the chat's session), only the scope's Flow tools enabled, hard
   * abort at the signal (session.abort + the request raced against it). Returns the final text and the tool calls.
   */
  async prompt(p: Prompt): Promise<LoopResult & { sessionId: string; calls: OpencodeToolCall[] }> {
    if (p.scope !== "chat") return this.promptOnce(p);
    const prev = this.chatLock;
    let release!: () => void;
    this.chatLock = new Promise<void>((r) => (release = r));
    try {
      await prev;
      await this.ensure();
      // MCP calls on the shared chat token now emit chat.tool on this chat session (http.ts reads auth.sessionId)
      if (this.tokenInfo) this.tokenInfo.chat.sessionId = p.chatSessionId ?? "opencode";
      return await this.promptOnce(p);
    } finally {
      if (this.tokenInfo) this.tokenInfo.chat.sessionId = "opencode";
      release();
    }
  }

  /** Every tool part of this turn: opencode answers with the last step's message only, earlier steps hold the calls. */
  private async turnParts(c: OpencodeClient, sessionId: string, last: OcPart[]): Promise<OcPart[]> {
    let all: OcPart[] = [];
    try {
      const r = await c.session.messages({ path: { id: sessionId }, query: { directory: this.work } });
      const msgs = (r.data ?? []) as { info: { role?: string }; parts: OcPart[] }[];
      let from = 0;
      for (let i = msgs.length - 1; i >= 0; i--)
        if (msgs[i]!.info?.role === "user") {
          from = i + 1;
          break;
        }
      all = msgs.slice(from).flatMap((m) => m.parts ?? []);
    } catch {
      /* fall back to the returned message's parts */
    }
    const seen = new Set(all.map((x) => x.id ?? x.callID).filter(Boolean));
    for (const x of last) if (!(x.id ?? x.callID) || !seen.has(x.id ?? x.callID)) all.push(x);
    return all;
  }

  private async promptOnce(p: Prompt): Promise<LoopResult & { sessionId: string; calls: OpencodeToolCall[] }> {
    const c = await this.ensure();
    const [providerID, ...rest] = p.model.split("/");
    const modelID = rest.join("/");
    if (!providerID || !modelID) throw Object.assign(new Error(`opencode model must be provider/model, got ${p.model}`), { status: 400, code: "ATE_CONFIG_INVALID" });
    if (this.tokenInfo) this.tokenInfo[p.scope].agentId = p.agentId;
    const server = SERVERS[p.scope];
    const allowed = new Set(p.toolNames.map((n) => `${server}_${n}`));
    const ids = ((await abortable(c.tool.ids({ query: { directory: this.work } }), p.signal)).data ?? []) as string[];
    // everything off except this scope's allowlisted Flow tools (the other scope's server stays off too)
    const tools: Record<string, boolean> = Object.fromEntries([...ids, ...BUILTINS].map((t) => [t, false]));
    for (const t of allowed) tools[t] = true;
    // extra MCP servers the user enabled for this agent (Tools (MCP))
    const prefixes = p.noExtraTools ? [] : this.extraPrefixes(p.scope);
    for (const id of ids) if (prefixes.some((x) => id.startsWith(x))) tools[id] = true;
    let sessionId = p.sessionId;
    if (!sessionId) {
      const s = await abortable(c.session.create({ body: { title: p.scope === "agent" ? "Flow trader cycle" : "Flow chat" }, query: { directory: this.work } }), p.signal);
      sessionId = (s.data as { id: string } | undefined)?.id;
      if (!sessionId) throw new Error("opencode did not create a session");
    }
    const onAbort = () => void c.session.abort({ path: { id: sessionId! }, query: { directory: this.work } }).catch(() => {});
    p.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await abortable(
        c.session.prompt({ path: { id: sessionId }, query: { directory: this.work }, body: { model: { providerID, modelID }, system: p.system, tools, parts: [{ type: "text", text: p.text }] } }),
        p.signal,
      );
      const data = r.data as { info?: { error?: { name?: string; data?: { message?: string } }; tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }; finish?: string; modelID?: string }; parts?: OcPart[] } | undefined;
      if (!data) throw new Error(`opencode prompt failed${r.error ? `: ${JSON.stringify(r.error).slice(0, 200)}` : ""}`);
      const parts = data.parts ?? [];
      const text = parts
        .filter((x) => x.type === "text" && x.text)
        .map((x) => x.text!)
        .join("\n")
        .trim();
      const calls: OpencodeToolCall[] = (await this.turnParts(c, sessionId, parts))
        .filter((x) => x.type === "tool" && x.tool?.startsWith(`${server}_`))
        .map((x) => {
          let output: unknown = x.state?.output ?? x.state?.error ?? null;
          try {
            output = typeof output === "string" ? JSON.parse(output) : output;
          } catch {
            /* text */
          }
          return { tool: x.tool!.slice(server.length + 1), input: x.state?.input ?? {}, output, ok: x.state?.status === "completed" };
        });
      const err = data.info?.error;
      const tk = data.info?.tokens;
      const usage = { inputTokens: tk?.input ?? 0, outputTokens: tk?.output ?? 0, cacheReadTokens: tk?.cache?.read ?? 0, cacheWriteTokens: tk?.cache?.write ?? 0 };
      if (err) {
        if (err.name === "MessageAbortedError") return { text, stop: "aborted", turns: 1, toolCalls: calls.length, usage, servedBy: p.model, sessionId, calls };
        throw Object.assign(new Error(`opencode: ${err.data?.message ?? err.name ?? "error"}`), { kind: err.name === "ProviderAuthError" ? "auth" : "api" });
      }
      return { text, stop: data.info?.finish === "length" ? "max_tokens" : "end_turn", turns: 1, toolCalls: calls.length, usage, servedBy: p.model, sessionId, calls };
    } finally {
      p.signal?.removeEventListener("abort", onAbort);
    }
  }
}
