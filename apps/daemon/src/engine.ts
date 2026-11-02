// In-app agent engine (Flow v1): the trader and the chat agent run inside the daemon, on one internal interface over
// several model providers (./providers.ts). Anthropic is the default: @anthropic-ai/sdk, claude-opus-5-5, manual
// streaming tool-use loop with tools 1:1 with the daemon's MCP tools (agent scope for the trader, the chat allowlist
// for chat). No external CLI is needed; the Claude Code CLI engine stays an optional fallback (Anthropic only).
//
// Anthropic request shape (per the claude-api guidance):
// - thinking left at the model default (adaptive; Opus 5.5 can't disable it); speed set with output_config.effort,
//   explicitly "low" for trader cycles and chat (Opus 5.5 defaults to "medium").
// - tool_choice "auto" (forced any/tool 400s on Opus/Sonnet 5.5); `strict: true` tools with closed schemas. The
//   daemon still validates every input against the frozen MCP schema.
// - refusal fallbacks on: client.beta.messages + `server-side-fallback-2026-07-01` + `fallbacks: "default"` (not on
//   Haiku 5.5, not through a proxy). stop_reason (refusal / max_tokens) is checked before any tool call runs.
// - prompt caching: deterministic tool list, frozen system prompt with a breakpoint (no timestamps in it), top-level
//   automatic caching for the growing conversation; usage.cache_read_input_tokens is reported.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool, BetaToolResultBlockParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Content } from "@google/genai";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolName } from "@ate/core";
import { TOOL_DEFINITIONS } from "@ate/mcp";
import { bestModel, type ProxySidecar } from "./sidecar.js";
import {
  PROVIDERS,
  PROVIDER_IDS,
  REQUEST_TIMEOUT_MS,
  abortable,
  ProviderKeys,
  ToolsUnsupportedError,
  anthropicFor,
  geminiClient,
  isProviderId,
  listModels,
  openaiClient,
  runGeminiLoop,
  runOpenAILoop,
  type GeminiLike,
  type LoopResult,
  type ModelInfo,
  type OpenAILike,
  type ProviderId,
  type ProviderSettings,
  type ToolCallResult,
} from "./providers.js";

export type { LoopResult, ToolCallResult, ProviderId } from "./providers.js";

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
  provider: ProviderId;
  model: string;
  engine: EngineKind;
  traderEffort: Effort;
  chatEffort: Effort;
  providers: Partial<Record<ProviderId, ProviderSettings>>;
}
export type CredentialSource = "keychain" | "file" | "env" | "profile" | "subscription" | "none";
export interface AiHealth {
  provider: ProviderId;
  providerLabel: string;
  engine: EngineKind;
  model: string;
  modelLabel: string;
  models: readonly { id: string; label: string; tools?: boolean | null }[];
  credential: CredentialSource;
  traderEffort: Effort;
  chatEffort: Effort;
  lastCheck: { at: number; reachable: boolean; error?: { kind: string; message: string } } | null;
  lastUsage: { at: number; kind: "trader" | "chat"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
  /** Path of the Claude Code CLI on this machine (the optional `engine: "claude-code"` runs it), or null. */
  claudeCli: string | null;
}
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  protocol: string;
  key: "required" | "optional" | "none";
  warning: string | null;
  settings: ProviderSettings;
  credential: { source: CredentialSource; hint: string | null; stored: boolean };
  configured: boolean;
  selected: boolean;
  caps: { tools: boolean; streaming: boolean };
  health: { at: number; ok: boolean; error?: { kind: string; message: string } } | null;
  models: ModelInfo[];
}

/**
 * The Claude Code CLI (`claude`), for the optional "claude-code" engine: ATE_CLAUDE_BIN, PATH, then the usual install
 * dirs (an app opened from Finder has a minimal PATH).
 */
export function findClaudeBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ATE_CLAUDE_BIN && existsSync(env.ATE_CLAUDE_BIN)) return env.ATE_CLAUDE_BIN;
  const dirs = [...(env.PATH ?? "").split(":"), join(homedir(), ".local/bin"), join(homedir(), ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) if (d && existsSync(join(d, "claude"))) return join(d, "claude");
  return null;
}

const isEffort = (e: unknown): e is Effort => e === "low" || e === "medium" || e === "high";
const nowSec = () => Math.floor(Date.now() / 1000);

/** One agent conversation, in the selected provider's native message format (append-only). */
export interface Conversation {
  provider: ProviderId;
  protocol: "anthropic" | "openai" | "gemini";
  model: string;
  items: unknown[];
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

export interface LoopOptions {
  model: string;
  /** Server-side refusal fallbacks (Anthropic API only; not through a proxy). Default: on except Haiku 5.5. */
  fallbacks?: boolean;
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

/** Minimal client surface the loop needs (the real Anthropic client, or a mock in tests). */
export interface LoopClient {
  beta: { messages: { stream(params: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout?: number }): { on(ev: "text", f: (d: string) => void): unknown; finalMessage(): Promise<BetaMessage> } } };
}

const hasFallback = (m: string) => m !== "claude-haiku-5-5";

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
      ...((o.fallbacks ?? true) && hasFallback(o.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };
    const stream = client.beta.messages.stream(params, { timeout: REQUEST_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}) });
    if (o.onText) stream.on("text", o.onText);
    // hard deadline: a stream that never settles still ends at the cycle kill
    const msg = await abortable(stream.finalMessage(), o.signal);
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
          const r = await abortable(o.call(u.name, u.input, u.id), o.signal);
          return { type: "tool_result" as const, tool_use_id: u.id, content: r.content, ...(r.isError ? { is_error: true } : {}) };
        } catch (e) {
          if (o.signal?.aborted) throw e;
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
  if (e instanceof ToolsUnsupportedError) return { kind: "no_tools", message: e.message, retryable: false };
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError) return { kind: "auth", message: "The API key was rejected", retryable: false };
  if (e instanceof Anthropic.PermissionDeniedError || e instanceof OpenAI.PermissionDeniedError) return { kind: "permission", message: "This key may not use the selected model", retryable: false };
  if (e instanceof Anthropic.NotFoundError || e instanceof OpenAI.NotFoundError) return { kind: "model", message: "The selected model is not available to this key", retryable: false };
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError) return { kind: "rate_limit", message: "Rate limited by the provider", retryable: true };
  if (e instanceof Anthropic.BadRequestError || e instanceof OpenAI.BadRequestError) return { kind: "bad_request", message: e.message.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1…").slice(0, 300), retryable: false };
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError) return { kind: "offline", message: "Cannot reach the model provider", retryable: true };
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) return { kind: "api", message: `Provider API error ${e.status ?? ""}`.trim(), retryable: (e.status ?? 0) >= 500 };
  const st = (e as { status?: number })?.status;
  if (st === 401 || st === 403) return { kind: "auth", message: "The API key was rejected", retryable: false };
  if (st === 404) return { kind: "model", message: "The selected model is not available", retryable: false };
  if (st === 429) return { kind: "rate_limit", message: "Rate limited by the provider", retryable: true };
  const m = (e as Error)?.message ?? String(e);
  if (/authentication method|apiKey|authToken|API key/i.test(m)) return { kind: "no_credentials", message: "No credentials for this provider: add an API key", retryable: false };
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(m)) return { kind: "offline", message: "Cannot reach the model provider", retryable: true };
  return { kind: "internal", message: m.split("\n")[0]!.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1…").slice(0, 300), retryable: false };
}


// ------------------------------------------------------------------ engine (providers, credentials, health)

type Clients = { anthropic?: (id: ProviderId, key: string | null, baseURL?: string) => LoopClient & Anthropic; openai?: (id: ProviderId, key: string | null, baseURL?: string) => OpenAILike; gemini?: (key: string | null) => GeminiLike };

export class AiEngine {
  private cfg: AiConfig;
  private lastCheck: AiHealth["lastCheck"] = null;
  private lastUsage: AiHealth["lastUsage"] = null;
  private health_: Partial<Record<ProviderId, ProviderStatus["health"]>> = {};
  private models_: Partial<Record<ProviderId, ModelInfo[]>> = {};
  readonly keys: ProviderKeys;
  /** False (per provider) after a strict-schema 400: later loops send plain schemas; the daemon validates anyway. */
  strictOk: Partial<Record<ProviderId, boolean>> = {};

  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clients: Clients = {},
    /** The CLIProxyAPI sidecar behind the default "subscription" provider. */
    readonly sidecar?: ProxySidecar,
  ) {
    this.keys = new ProviderKeys(home, env);
    // default: the user's own subscriptions through the sidecar; "" = pick the best model the subscription offers
    this.cfg = { provider: "subscription", model: "", engine: "sdk", traderEffort: "low", chatEffort: "low", providers: {} };
    try {
      const j = JSON.parse(readFileSync(join(home, "ai.json"), "utf8")) as Partial<AiConfig> & { models?: Partial<Record<ProviderId, ModelInfo[]>> };
      this.cfg = {
        ...this.cfg,
        ...(isProviderId(j.provider) ? { provider: j.provider } : {}),
        ...(typeof j.model === "string" && j.model ? { model: j.model } : {}),
        ...(j.engine === "claude-code" ? { engine: "claude-code" } : {}),
        ...(isEffort(j.traderEffort) ? { traderEffort: j.traderEffort } : {}),
        ...(isEffort(j.chatEffort) ? { chatEffort: j.chatEffort } : {}),
        ...(j.providers && typeof j.providers === "object" ? { providers: j.providers } : {}),
      };
      if (j.models) this.models_ = j.models;
    } catch {
      /* defaults */
    }
    if (isProviderId(env.ATE_AI_PROVIDER)) this.cfg.provider = env.ATE_AI_PROVIDER;
    if (typeof env.ATE_AI_MODEL === "string" && env.ATE_AI_MODEL) this.cfg.model = env.ATE_AI_MODEL;
    if (this.cfg.provider === "anthropic" && !this.cfg.model) this.cfg.model = DEFAULT_MODEL;
  }

  get config(): AiConfig {
    return JSON.parse(JSON.stringify(this.cfg)) as AiConfig;
  }
  private persist() {
    writeFileSync(join(this.home, "ai.json"), JSON.stringify({ ...this.cfg, models: this.models_ }, null, 2), { mode: 0o600 });
  }

  /** Model info from the provider's last listing (Anthropic: built in). */
  modelInfo(p: ProviderId, model: string): ModelInfo | null {
    if (p === "anthropic") {
      const m = AI_MODELS.find((x) => x.id === model);
      if (m) return { id: m.id, label: m.label, tools: true, streaming: true };
    }
    return this.models_[p]?.find((x) => x.id === model) ?? null;
  }

  setConfig(p: Partial<Omit<AiConfig, "providers">> & { providerSettings?: { id: ProviderId } & ProviderSettings }): AiConfig {
    const provider = p.provider === undefined ? this.cfg.provider : p.provider;
    if (!isProviderId(provider)) throw Object.assign(new Error(`unknown provider ${String(provider)}`), { status: 400, code: "ATE_CONFIG_INVALID" });
    let model = p.model ?? (provider !== this.cfg.provider ? (provider === "anthropic" ? DEFAULT_MODEL : (this.models_[provider]?.find((m) => m.tools !== false)?.id ?? "")) : this.cfg.model);
    if (typeof model !== "string" || model.length > 200 || (provider === "anthropic" && p.model !== undefined && !/^claude-[a-z0-9.-]+$/.test(model))) throw Object.assign(new Error(`unknown model ${String(model)}`), { status: 400, code: "ATE_CONFIG_INVALID" });
    const info = model ? this.modelInfo(provider, model) : null;
    if (info && info.tools === false) throw Object.assign(new ToolsUnsupportedError(provider, model), { status: 400, code: "ATE_CONFIG_INVALID" });
    if (p.engine === "claude-code" && provider !== "anthropic") throw Object.assign(new Error("the Claude Code CLI engine only runs Anthropic models"), { status: 400, code: "ATE_CONFIG_INVALID" });
    // subscription with no explicit model = automatic (best model the subscription offers)
    model = provider === "subscription" && !p.model && provider !== this.cfg.provider ? "" : model || this.cfg.model;
    this.cfg = {
      ...this.cfg,
      provider,
      model,
      ...(p.engine === "sdk" || p.engine === "claude-code" ? { engine: p.engine } : {}),
      ...(isEffort(p.traderEffort) ? { traderEffort: p.traderEffort } : {}),
      ...(isEffort(p.chatEffort) ? { chatEffort: p.chatEffort } : {}),
    };
    if (p.providerSettings) this.setProviderSettings(p.providerSettings.id, p.providerSettings);
    this.persist();
    return this.config;
  }

  setProviderSettings(id: ProviderId, s: ProviderSettings): void {
    const cur = this.cfg.providers[id] ?? {};
    const next: ProviderSettings = { ...cur };
    if (s.baseURL !== undefined) {
      if (s.baseURL === "") delete next.baseURL;
      else {
        let u: URL;
        try {
          u = new URL(s.baseURL);
        } catch {
          throw Object.assign(new Error("base URL is not a URL"), { status: 400, code: "ATE_CONFIG_INVALID" });
        }
        if (u.protocol !== "http:" && u.protocol !== "https:") throw Object.assign(new Error("base URL must be http(s)"), { status: 400, code: "ATE_CONFIG_INVALID" });
        next.baseURL = u.toString().replace(/\/$/, "");
      }
    }
    if (s.protocol === "openai" || s.protocol === "anthropic") next.protocol = s.protocol;
    this.cfg.providers = { ...this.cfg.providers, [id]: next };
    this.persist();
  }

  private baseURL(id: ProviderId): string | undefined {
    if (id === "subscription") return this.sidecar?.baseURL ?? PROVIDERS.subscription.baseURL;
    return this.cfg.providers[id]?.baseURL ?? PROVIDERS[id].baseURL;
  }
  /** Wire protocol: subscriptions speak Claude-compatible for Claude models and OpenAI-compatible for the rest. */
  private protocolOf(id: ProviderId, model = this.effectiveModel()): "anthropic" | "openai" | "gemini" {
    if (id === "subscription") return /^claude/i.test(model) ? "anthropic" : "openai";
    return id === "proxy" ? (this.cfg.providers.proxy?.protocol ?? "openai") : PROVIDERS[id].protocol;
  }
  /** The model the agents use: the chosen one, or (subscription, none chosen / gone) the best the subscription offers. */
  effectiveModel(): string {
    if (this.cfg.provider !== "subscription") return this.cfg.model;
    const ids = (this.models_.subscription ?? []).filter((m) => m.tools !== false).map((m) => m.id);
    if (this.cfg.model && (ids.length === 0 || ids.includes(this.cfg.model))) return this.cfg.model;
    return bestModel(ids) ?? this.cfg.model;
  }

  credentialOf(id: ProviderId): ProviderStatus["credential"] {
    if (id === "subscription") return { source: this.subscriptionReady() ? "subscription" : "none", hint: null, stored: false };
    return this.keys.source(id);
  }
  private subscriptionReady(): boolean {
    return !!this.sidecar?.ready || (!!this.health_.subscription?.ok && (this.models_.subscription?.length ?? 0) > 0);
  }
  configured(id: ProviderId): boolean {
    const def = PROVIDERS[id];
    if (id === "subscription") return this.subscriptionReady();
    // the proxy has a default URL; it counts as set up once the user saved settings or a test reached it
    if (id === "proxy") return !!this.cfg.providers.proxy?.baseURL || !!this.health_.proxy?.ok;
    if (def.key === "none") return true;
    return this.credentialOf(id).source !== "none";
  }
  credential(): CredentialSource {
    return this.credentialOf(this.cfg.provider).source;
  }
  available(): boolean {
    return this.configured(this.cfg.provider);
  }

  private anthropicClient(id: ProviderId): LoopClient & Anthropic {
    const key = id === "anthropic" ? null : this.keys.resolve(id);
    return this.clients.anthropic ? this.clients.anthropic(id, key, this.baseURL(id)) : (anthropicFor(this.home, this.env, id, key, this.baseURL(id)) as LoopClient & Anthropic);
  }
  private openaiClient(id: ProviderId): OpenAILike {
    const key = this.keys.resolve(id);
    return this.clients.openai ? this.clients.openai(id, key, this.baseURL(id)) : (openaiClient(PROVIDERS[id], key, this.baseURL(id)) as unknown as OpenAILike);
  }
  private geminiClient(): GeminiLike {
    const key = this.keys.resolve("gemini");
    return this.clients.gemini ? this.clients.gemini(key) : (geminiClient(key) as unknown as GeminiLike);
  }

  providers(): ProviderStatus[] {
    return PROVIDER_IDS.map((id) => {
      const def = PROVIDERS[id];
      const models = id === "anthropic" && !this.models_.anthropic?.length ? AI_MODELS.map((m) => ({ id: m.id, label: m.label, tools: true, streaming: true })) : (this.models_[id] ?? []);
      return {
        id,
        label: def.label,
        protocol: this.protocolOf(id),
        key: def.key,
        warning: def.warning ?? null,
        settings: this.cfg.providers[id] ?? (def.baseURL ? { baseURL: def.baseURL } : {}),
        credential: this.credentialOf(id),
        configured: this.configured(id),
        selected: this.cfg.provider === id,
        caps: { tools: true, streaming: def.caps.streaming },
        health: this.health_[id] ?? null,
        models,
      };
    });
  }

  /** List the provider's models (and so prove the key, URL and network). No tokens are spent. */
  async test(id: ProviderId): Promise<ProviderStatus> {
    const at = nowSec();
    try {
      if (id === "subscription" && this.sidecar) {
        const st = await this.sidecar.check();
        if (!st.healthy) throw Object.assign(new Error(st.installed ? "Your subscription proxy is not running" : "Your subscription proxy is not installed yet"), { kind: "no_credentials" });
      }
      if (id !== "proxy" && id !== "subscription" && !this.configured(id)) throw Object.assign(new Error("No API key for this provider"), { kind: "no_credentials" });
      // model listing always goes through the OpenAI-compatible /v1/models on the subscription proxy
      const proto = id === "subscription" ? "openai" : this.protocolOf(id);
      const client = proto === "anthropic" ? this.anthropicClient(id) : proto === "gemini" ? this.geminiClient() : this.openaiClient(id);
      const ms = await listModels(id, client, { baseURL: this.baseURL(id) });
      this.models_[id] = id === "anthropic" ? ms.filter((m) => /^claude-/.test(m.id)) : ms;
      this.health_[id] = { at, ok: true };
      this.persist();
    } catch (e) {
      const d = (e as { kind?: string }).kind === "no_credentials" ? { kind: "no_credentials", message: (e as Error).message } : describeAiError(e);
      this.health_[id] = { at, ok: false, error: { kind: d.kind, message: d.message } };
    }
    if (id === this.cfg.provider) this.lastCheck = { at, reachable: !!this.health_[id]?.ok, ...(this.health_[id]?.error ? { error: this.health_[id]!.error! } : {}) };
    return this.providers().find((p) => p.id === id)!;
  }

  health(): AiHealth {
    const p = this.cfg.provider;
    const eff = this.effectiveModel();
    const info = this.modelInfo(p, eff);
    const st = this.providers().find((x) => x.id === p)!;
    return {
      provider: p,
      providerLabel: PROVIDERS[p].label,
      engine: this.cfg.engine,
      model: eff,
      modelLabel: info?.label ?? (eff || "best available"),
      models: st.models.map((m) => ({ id: m.id, label: m.label, tools: m.tools })),
      credential: this.credential(),
      traderEffort: this.cfg.traderEffort,
      chatEffort: this.cfg.chatEffort,
      lastCheck: this.lastCheck,
      lastUsage: this.lastUsage,
      claudeCli: findClaudeBin(this.env),
    };
  }
  async check(): Promise<AiHealth> {
    if (this.cfg.engine === "claude-code") {
      // the CLI brings its own login; Flow only checks that it is installed (no tokens spent)
      const cli = findClaudeBin(this.env);
      this.lastCheck = { at: nowSec(), reachable: !!cli, ...(cli ? {} : { error: { kind: "no_credentials", message: "Claude Code is not installed on this Mac" } }) };
      return this.health();
    }
    await this.test(this.cfg.provider);
    return this.health();
  }

  /** Validate a pasted key against the provider (model listing), then store it in the keychain. Never logged or returned. */
  async setKey(apiKey: string, id: ProviderId = this.cfg.provider): Promise<AiHealth> {
    const k = String(apiKey ?? "").trim();
    const def = PROVIDERS[id];
    if (def.key === "none") throw Object.assign(new Error(`${def.label} needs no API key`), { status: 400, code: "ATE_CONFIG_INVALID" });
    if (!k || k.length > 400 || /\s/.test(k) || (def.keyPattern && !def.keyPattern.test(k))) throw Object.assign(new Error(`That does not look like a ${def.label} API key`), { status: 400, code: "ATE_CONFIG_INVALID" });
    this.keys.save(id, k);
    const st = await this.test(id);
    if (!st.health?.ok && (st.health?.error?.kind === "auth" || st.health?.error?.kind === "permission")) {
      this.keys.remove(id);
      throw Object.assign(new Error(st.health.error.message), { status: 400, code: "ATE_CONFIG_INVALID" });
    }
    return this.health();
  }
  clearKey(id: ProviderId = this.cfg.provider): AiHealth {
    this.keys.remove(id);
    delete this.health_[id];
    if (id === this.cfg.provider) this.lastCheck = null;
    return this.health();
  }

  /** A new, empty conversation on the selected provider and model. */
  conversation(): Conversation {
    const model = this.effectiveModel();
    return { provider: this.cfg.provider, protocol: this.protocolOf(this.cfg.provider, model), model, items: [] };
  }
  /** Append a user message in the conversation's native format. */
  pushUser(c: Conversation, text: string): void {
    c.items.push(c.protocol === "gemini" ? ({ role: "user", parts: [{ text }] } satisfies Content) : { role: "user", content: text });
  }

  /** Run the tool loop on the conversation's provider. Strict schemas fall back to plain ones after a 400. */
  async run(kind: "trader" | "chat", c: Conversation, o: { effort: Effort; system: string; toolNames: readonly string[]; call(name: string, input: unknown, id: string): Promise<ToolCallResult>; signal?: AbortSignal; onText?(d: string): void; maxTurns?: number; maxTokens?: number }): Promise<LoopResult> {
    const info = this.modelInfo(c.provider, c.model);
    if (info && info.tools === false) throw new ToolsUnsupportedError(c.provider, c.model);
    const start = c.items.length;
    const strict = this.strictOk[c.provider] !== false;
    const once = async (useStrict: boolean): Promise<LoopResult> => {
      if (c.protocol === "anthropic")
        return runToolLoop(this.anthropicClient(c.provider), { model: c.model, effort: o.effort, system: o.system, tools: toolsFor(o.toolNames, useStrict), messages: c.items as BetaMessageParam[], call: o.call, fallbacks: c.provider === "anthropic", ...(o.signal ? { signal: o.signal } : {}), ...(o.onText ? { onText: o.onText } : {}), ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}), ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}) });
      if (c.protocol === "gemini") return runGeminiLoop(this.geminiClient(), c.items as Content[], { model: c.model, system: o.system, toolNames: o.toolNames, call: o.call, ...(o.signal ? { signal: o.signal } : {}), ...(o.onText ? { onText: o.onText } : {}), ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}), ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}) });
      // strict function schemas only on OpenAI itself; OpenRouter / Ollama / proxies get plain schemas
      return runOpenAILoop(this.openaiClient(c.provider), c.items as ChatCompletionMessageParam[], { model: c.model, system: o.system, toolNames: o.toolNames, call: o.call, strict: useStrict && c.provider === "openai", stream: PROVIDERS[c.provider].caps.streaming, ...(o.signal ? { signal: o.signal } : {}), ...(o.onText ? { onText: o.onText } : {}), ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}), ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}) });
    };
    let r: LoopResult;
    try {
      r = await once(strict);
    } catch (e) {
      const is400 = e instanceof Anthropic.BadRequestError || e instanceof OpenAI.BadRequestError || (e as { status?: number })?.status === 400;
      if (!is400 || c.items.length !== start) throw e;
      if (!strict || c.protocol === "gemini" || (c.protocol === "openai" && c.provider !== "openai")) {
        // the model refused the tool definitions themselves
        if (info?.tools !== true) throw new ToolsUnsupportedError(c.provider, c.model);
        throw e;
      }
      this.strictOk[c.provider] = false;
      r = await once(false);
    }
    this.lastUsage = { at: nowSec(), kind, ...r.usage };
    return r;
  }
}
