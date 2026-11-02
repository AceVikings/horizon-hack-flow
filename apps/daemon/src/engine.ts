// In-app agent engine (Flow v1): the trader and the chat agent run inside the daemon on the Anthropic TypeScript SDK,
// with a manual streaming tool-use loop whose tools map 1:1 to the daemon's MCP tools (agent scope for the trader,
// the chat allowlist for chat). No external CLI is needed; the Claude Code CLI engine stays an optional fallback.
//
// - Model: claude-opus-5-5 by default; claude-sonnet-5-5 / claude-haiku-5-5 selectable (Agent screen).
// - Thinking is left at the model default (adaptive; Opus 5.5 can't disable it). Speed is set with
//   output_config.effort, explicitly: "low" for trader cycles and chat (Opus 5.5 defaults to "medium").
// - tool_choice stays "auto" (forced any/tool 400s on Opus/Sonnet 5.5); tools are `strict: true` with
//   additionalProperties:false. The daemon still validates every input against the frozen MCP schema.
// - Refusal fallbacks on by default: client.beta.messages with `server-side-fallback-2026-07-01` +
//   `fallbacks: "default"` (not on Haiku 5.5, which has no server-side fallback). stop_reason is checked
//   (refusal / max_tokens) before any tool call runs.
// - Prompt caching: deterministic tool list, frozen system prompt with a cache breakpoint (no timestamps in it),
//   top-level automatic caching for the growing conversation; usage.cache_read_input_tokens is reported.
// - Credentials: an API key pasted in-app lives in the macOS keychain (or <home>/keys with ATE_KEYSTORE=file),
//   never in config, logs or the renderer; otherwise `new Anthropic()` resolves ANTHROPIC_API_KEY /
//   ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool, BetaToolResultBlockParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolName } from "@ate/core";
import { TOOL_DEFINITIONS } from "@ate/mcp";

export const AI_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
] as const;
export type AiModel = (typeof AI_MODELS)[number]["id"];
export const DEFAULT_MODEL: AiModel = "claude-opus-5-5";
export type Effort = "low" | "medium" | "high";
export type EngineKind = "sdk" | "claude-code";

export interface AiConfig {
  model: AiModel;
  engine: EngineKind;
  traderEffort: Effort;
  chatEffort: Effort;
}
export type CredentialSource = "keychain" | "file" | "env" | "profile" | "none";
export interface AiHealth {
  engine: EngineKind;
  model: AiModel;
  modelLabel: string;
  models: typeof AI_MODELS;
  credential: CredentialSource;
  traderEffort: Effort;
  chatEffort: Effort;
  lastCheck: { at: number; reachable: boolean; error?: { kind: string; message: string } } | null;
  lastUsage: { at: number; kind: "trader" | "chat"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
}

const isModel = (m: unknown): m is AiModel => AI_MODELS.some((x) => x.id === m);
const isEffort = (e: unknown): e is Effort => e === "low" || e === "medium" || e === "high";
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const KEYCHAIN_SERVICE = "ate-anthropic-api-key";

// ------------------------------------------------------------------ API key store (keychain / file)

export class ApiKeyStore {
  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  get kind(): "keychain" | "file" {
    return this.env.ATE_KEYSTORE !== "file" && process.platform === "darwin" && existsSync("/usr/bin/security") ? "keychain" : "file";
  }
  private file(): string {
    return join(this.home, "keys", "anthropic-api-key");
  }
  load(): string | null {
    try {
      if (this.kind === "keychain") {
        const out = execFileSync("/usr/bin/security", ["find-generic-password", "-a", "ate", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return out || null;
      }
      return existsSync(this.file()) ? readFileSync(this.file(), "utf8").trim() || null : null;
    } catch {
      return null;
    }
  }
  save(key: string): void {
    if (this.kind === "keychain") {
      execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-a", "ate", "-s", KEYCHAIN_SERVICE, "-l", "Flow · Anthropic API key", "-w", key], { stdio: "ignore" });
      return;
    }
    mkdirSync(join(this.home, "keys"), { recursive: true, mode: 0o700 });
    writeFileSync(this.file(), key, { mode: 0o600 });
    chmodSync(this.file(), 0o600);
  }
  clear(): void {
    try {
      if (this.kind === "keychain") execFileSync("/usr/bin/security", ["delete-generic-password", "-a", "ate", "-s", KEYCHAIN_SERVICE], { stdio: "ignore" });
      else rmSync(this.file(), { force: true });
    } catch {
      /* nothing stored */
    }
  }
}

// ------------------------------------------------------------------ tools (1:1 with the daemon's MCP tools)

const STRIP = new Set(["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "default", "uniqueItems"]);

/** Strict-mode copy of an MCP schema: unsupported constraint keywords move into the description; objects are closed. */
export function strictSchema(s: unknown): Record<string, unknown> {
  if (!s || typeof s !== "object" || Array.isArray(s)) return s as Record<string, unknown>;
  const src = s as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (STRIP.has(k)) {
      notes.push(`${k} ${JSON.stringify(v)}`);
      continue;
    }
    if (k === "properties" && v && typeof v === "object") out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, strictSchema(pv)]));
    else if (k === "items") out[k] = strictSchema(v);
    else out[k] = v;
  }
  if (out.type === "object") out.additionalProperties = false;
  if (notes.length) out.description = `${out.description ? `${String(out.description)} ` : ""}(${notes.join(", ")})`;
  return out;
}

/** Anthropic tool definitions for `names`, in a fixed (sorted) order so the cached prefix never changes. */
export function toolsFor(names: readonly string[], strict = true): BetaTool[] {
  return [...new Set(names)]
    .filter((n): n is ToolName => n in TOOL_DEFINITIONS)
    .sort()
    .map((n) => {
      const d = TOOL_DEFINITIONS[n];
      return {
        name: d.name,
        description: d.description,
        input_schema: (strict ? strictSchema(d.inputSchema) : d.inputSchema) as BetaTool["input_schema"],
        ...(strict ? { strict: true } : {}),
      };
    });
}

// ------------------------------------------------------------------ the tool-use loop

export interface ToolCallResult {
  /** JSON (or text) returned to the model as the tool_result content. */
  content: string;
  isError: boolean;
}
export interface LoopOptions {
  model: AiModel;
  effort: Effort;
  system: string;
  tools: BetaTool[];
  /** Append-only conversation; the loop appends every assistant turn and tool-result turn. */
  messages: BetaMessageParam[];
  call(name: string, input: unknown, id: string): Promise<ToolCallResult>;
  signal?: AbortSignal;
  onText?(delta: string): void;
  maxTurns?: number;
  maxTokens?: number;
}
export interface LoopResult {
  text: string;
  stop: string;
  turns: number;
  toolCalls: number;
  refusal?: { category: string | null; explanation: string | null };
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  servedBy: string;
}

/** Minimal client surface the loop needs (the real Anthropic client, or a mock in tests). */
export interface LoopClient {
  beta: { messages: { stream(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): { on(ev: "text", f: (d: string) => void): unknown; finalMessage(): Promise<BetaMessage> } } };
}

const hasFallback = (m: AiModel) => m !== "claude-haiku-5-5";

export async function runToolLoop(client: LoopClient, o: LoopOptions): Promise<LoopResult> {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let text = "";
  let turns = 0;
  let toolCalls = 0;
  let servedBy: string = o.model;
  const max = o.maxTurns ?? 16;
  for (;;) {
    if (o.signal?.aborted) return { text, stop: "aborted", turns, toolCalls, usage, servedBy };
    const params: Record<string, unknown> = {
      model: o.model,
      max_tokens: o.maxTokens ?? 16000,
      // frozen system prompt + deterministic tools come first and carry the cache breakpoint
      system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
      tools: o.tools,
      tool_choice: { type: "auto" },
      messages: o.messages,
      output_config: { effort: o.effort },
      cache_control: { type: "ephemeral" },
      ...(hasFallback(o.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };
    const stream = client.beta.messages.stream(params, o.signal ? { signal: o.signal } : undefined);
    if (o.onText) stream.on("text", o.onText);
    const msg = await stream.finalMessage();
    turns++;
    servedBy = msg.model ?? servedBy;
    usage.inputTokens += msg.usage?.input_tokens ?? 0;
    usage.outputTokens += msg.usage?.output_tokens ?? 0;
    usage.cacheReadTokens += msg.usage?.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += msg.usage?.cache_creation_input_tokens ?? 0;
    // append the full content (thinking blocks included) so the history stays append-only
    o.messages.push({ role: "assistant", content: msg.content as unknown as BetaContentBlockParam[] });
    const t = msg.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
    if (t) text += (text ? "\n" : "") + t;
    if (msg.stop_reason === "refusal") {
      const d = msg.stop_details as { category?: string | null; explanation?: string | null } | null;
      return { text, stop: "refusal", turns, toolCalls, usage, servedBy, refusal: { category: d?.category ?? null, explanation: d?.explanation ?? null } };
    }
    if (msg.stop_reason === "pause_turn") continue;
    const uses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    // a tool input cut off at max_tokens is never run
    if (msg.stop_reason === "max_tokens") return { text, stop: "max_tokens", turns, toolCalls, usage, servedBy };
    if (msg.stop_reason !== "tool_use" || uses.length === 0) return { text, stop: msg.stop_reason ?? "end_turn", turns, toolCalls, usage, servedBy };
    if (turns >= max) return { text, stop: "max_turns", turns, toolCalls, usage, servedBy };
    const results: BetaToolResultBlockParam[] = await Promise.all(
      uses.map(async (u) => {
        toolCalls++;
        try {
          const r = await o.call(u.name, u.input, u.id);
          return { type: "tool_result" as const, tool_use_id: u.id, content: r.content, ...(r.isError ? { is_error: true } : {}) };
        } catch (e) {
          return { type: "tool_result" as const, tool_use_id: u.id, content: `tool failed: ${(e as Error).message}`, is_error: true };
        }
      }),
    );
    // every tool_result for this turn goes back in ONE user message
    o.messages.push({ role: "user", content: results });
  }
}

/** Daemon ToolResult → tool_result content (JSON, capped), is_error when the tool refused. */
export function toolResultContent(r: unknown): ToolCallResult {
  const s = JSON.stringify(r);
  return { content: s.length > 60_000 ? `${s.slice(0, 60_000)}…(truncated)` : s, isError: !!r && typeof r === "object" && (r as { ok?: boolean }).ok === false };
}

/** Typed SDK error → a short, user-facing reason (no string matching on messages). */
export function describeAiError(e: unknown): { kind: string; message: string; retryable: boolean } {
  if (e instanceof Anthropic.AuthenticationError) return { kind: "auth", message: "The Anthropic API key was rejected", retryable: false };
  if (e instanceof Anthropic.PermissionDeniedError) return { kind: "permission", message: "This key may not use the selected model", retryable: false };
  if (e instanceof Anthropic.NotFoundError) return { kind: "model", message: "The selected model is not available to this key", retryable: false };
  if (e instanceof Anthropic.RateLimitError) return { kind: "rate_limit", message: "Rate limited by the Anthropic API", retryable: true };
  if (e instanceof Anthropic.BadRequestError) return { kind: "bad_request", message: e.message.slice(0, 300), retryable: false };
  if (e instanceof Anthropic.APIConnectionError) return { kind: "offline", message: "Cannot reach the Anthropic API", retryable: true };
  if (e instanceof Anthropic.APIError) return { kind: "api", message: `Anthropic API error ${e.status ?? ""}`.trim(), retryable: (e.status ?? 0) >= 500 };
  const m = (e as Error)?.message ?? String(e);
  if (/authentication method|apiKey|authToken/i.test(m)) return { kind: "no_credentials", message: "No Anthropic credentials: paste an API key in Settings", retryable: false };
  return { kind: "internal", message: m.split("\n")[0]!.slice(0, 300), retryable: false };
}

// ------------------------------------------------------------------ engine (config, credentials, health)

export class AiEngine {
  private cfg: AiConfig;
  private lastCheck: AiHealth["lastCheck"] = null;
  private lastUsage: AiHealth["lastUsage"] = null;
  private cached: { key: string | null; client: LoopClient & Anthropic } | null = null;
  readonly keys: ApiKeyStore;
  /** False after a strict-tools 400: later loops send plain (non-strict) schemas. */
  strictTools = true;

  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly makeClient: (apiKey: string | null) => LoopClient & Anthropic = (k) => (k ? new Anthropic({ apiKey: k }) : new Anthropic()) as LoopClient & Anthropic,
  ) {
    this.keys = new ApiKeyStore(home, env);
    this.cfg = { model: DEFAULT_MODEL, engine: "sdk", traderEffort: "low", chatEffort: "low" };
    try {
      const j = JSON.parse(readFileSync(join(home, "ai.json"), "utf8")) as Partial<AiConfig>;
      this.cfg = { ...this.cfg, ...(isModel(j.model) ? { model: j.model } : {}), ...(j.engine === "claude-code" ? { engine: "claude-code" } : {}), ...(isEffort(j.traderEffort) ? { traderEffort: j.traderEffort } : {}), ...(isEffort(j.chatEffort) ? { chatEffort: j.chatEffort } : {}) };
    } catch {
      /* defaults */
    }
    if (isModel(env.ATE_AI_MODEL)) this.cfg.model = env.ATE_AI_MODEL;
  }

  get config(): AiConfig {
    return { ...this.cfg };
  }
  setConfig(p: Partial<AiConfig>): AiConfig {
    if (p.model !== undefined && !isModel(p.model)) throw Object.assign(new Error(`unknown model ${String(p.model)}`), { status: 400, code: "ATE_CONFIG_INVALID" });
    this.cfg = {
      ...this.cfg,
      ...(p.model ? { model: p.model } : {}),
      ...(p.engine === "sdk" || p.engine === "claude-code" ? { engine: p.engine } : {}),
      ...(isEffort(p.traderEffort) ? { traderEffort: p.traderEffort } : {}),
      ...(isEffort(p.chatEffort) ? { chatEffort: p.chatEffort } : {}),
    };
    writeFileSync(join(this.home, "ai.json"), JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
    return this.config;
  }

  credential(): CredentialSource {
    if (this.keys.load()) return this.keys.kind;
    if (this.env.ANTHROPIC_API_KEY || this.env.ANTHROPIC_AUTH_TOKEN) return "env";
    const prof = this.env.ANTHROPIC_CONFIG_DIR ?? join(homedir(), ".config", "anthropic");
    if (this.env.ANTHROPIC_PROFILE || existsSync(prof)) return "profile";
    return "none";
  }
  available(): boolean {
    return this.credential() !== "none";
  }

  client(): LoopClient & Anthropic {
    const key = this.keys.load();
    if (!this.cached || this.cached.key !== key) this.cached = { key, client: this.makeClient(key) };
    return this.cached.client;
  }

  health(): AiHealth {
    const m = AI_MODELS.find((x) => x.id === this.cfg.model)!;
    return { engine: this.cfg.engine, model: this.cfg.model, modelLabel: m.label, models: AI_MODELS, credential: this.credential(), traderEffort: this.cfg.traderEffort, chatEffort: this.cfg.chatEffort, lastCheck: this.lastCheck, lastUsage: this.lastUsage };
  }

  /** Live reachability: GET /v1/models/{model} (no tokens spent). */
  async check(client: LoopClient & Anthropic = this.client()): Promise<AiHealth> {
    const at = Math.floor(Date.now() / 1000);
    try {
      await client.models.retrieve(this.cfg.model);
      this.lastCheck = { at, reachable: true };
    } catch (e) {
      const d = describeAiError(e);
      this.lastCheck = { at, reachable: false, error: { kind: d.kind, message: d.message } };
    }
    return this.health();
  }

  /** Validate a pasted key against the API, then store it in the keychain. The key is never logged or returned. */
  async setKey(apiKey: string): Promise<AiHealth> {
    const k = String(apiKey ?? "").trim();
    if (!KEY_RE.test(k)) throw Object.assign(new Error("That does not look like an Anthropic API key (sk-ant-…)"), { status: 400, code: "ATE_CONFIG_INVALID" });
    try {
      await this.makeClient(k).models.retrieve(this.cfg.model);
    } catch (e) {
      const d = describeAiError(e);
      if (d.kind === "auth" || d.kind === "permission") throw Object.assign(new Error(d.message), { status: 400, code: "ATE_CONFIG_INVALID" });
      // offline / rate limited: store anyway, the health check will tell
    }
    this.keys.save(k);
    this.cached = null;
    return this.check();
  }
  clearKey(): AiHealth {
    this.keys.clear();
    this.cached = null;
    this.lastCheck = null;
    return this.health();
  }

  /** runToolLoop with this engine's client; strict tools fall back to plain schemas after a 400. */
  async run(kind: "trader" | "chat", o: Omit<LoopOptions, "tools"> & { toolNames: readonly string[] }): Promise<LoopResult> {
    const client = this.client();
    const start = o.messages.length;
    let r: LoopResult;
    try {
      r = await runToolLoop(client, { ...o, tools: toolsFor(o.toolNames, this.strictTools) });
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError) || !this.strictTools || o.messages.length !== start) throw e;
      this.strictTools = false; // a schema keyword strict mode rejects: the daemon validates inputs anyway
      r = await runToolLoop(client, { ...o, tools: toolsFor(o.toolNames, false) });
    }
    this.lastUsage = { at: Math.floor(Date.now() / 1000), kind, ...r.usage };
    return r;
  }
}
