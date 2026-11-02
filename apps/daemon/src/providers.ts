// Model providers for the in-app agent engine, behind one interface (`ProviderLoop`). Every provider gets the same
// tools (1:1 with the daemon's MCP tools), the same append-only loop rules (stop on refusal / truncation before any
// tool runs; all tool results of a turn go back together) and the same guard: every call still goes through
// AteService.callTool, which re-validates inputs against the frozen MCP schema.
//
//   anthropic   @anthropic-ai/sdk (default; claude-opus-5-5; strict tools, cached prompt, server-side fallbacks)
//   openai      openai SDK, Chat Completions (strict function schemas)
//   gemini      @google/genai
//   openrouter  openai SDK at https://openrouter.ai/api/v1
//   ollama      openai SDK at http://127.0.0.1:11434/v1 (local, no key)
//   proxy       "Local proxy (advanced)": a user-run OpenAI- or Claude-compatible base URL. Not bundled; requests are sent
//               as-is (no "cloaking"). Routing a consumer subscription through a proxy may violate the provider's terms.
//
// Credentials: one keychain item per provider (macOS login keychain, `<home>/keys/<id>-api-key` 0600 with
// ATE_KEYSTORE=file). Anthropic shares the setup slot (./setup/model.ts) so Setup, Settings and the engine agree.

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolName } from "@ate/core";
import { TOOL_DEFINITIONS } from "@ate/mcp";
import { anthropicClient, loadStoredApiKey, modelCredentials, removeApiKey, storeApiKey } from "./setup/model.js";

export type ProviderId = "subscription" | "anthropic" | "openai" | "gemini" | "openrouter" | "ollama" | "proxy";
/** Keychain slots that are not a provider's own key (the managed proxy's management key). */
export type SecretSlot = ProviderId | "subscription-mgmt";
export type Protocol = "anthropic" | "openai" | "gemini";

export interface ProviderDef {
  id: ProviderId;
  label: string;
  protocol: Protocol;
  /** Fixed base URL (openrouter, ollama default); proxy takes a user URL. */
  baseURL?: string;
  key: "required" | "optional" | "none";
  keyPattern?: RegExp;
  /** Text shown next to the provider (proxy terms warning). */
  warning?: string;
  caps: { streaming: boolean };
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  // Default: the user's own subscriptions (Claude, ChatGPT/Codex, Gemini) through the CLIProxyAPI sidecar the daemon
  // installs, starts and health-checks on 127.0.0.1 (./sidecar.ts). Its local client key is generated, never typed.
  subscription: { id: "subscription", label: "Your subscriptions", protocol: "openai", baseURL: "http://127.0.0.1:8317/v1", key: "none", caps: { streaming: true } },
  anthropic: { id: "anthropic", label: "Anthropic", protocol: "anthropic", key: "required", keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,200}$/, caps: { streaming: true } },
  openai: { id: "openai", label: "OpenAI", protocol: "openai", key: "required", keyPattern: /^sk-[A-Za-z0-9_-]{20,300}$/, caps: { streaming: true } },
  gemini: { id: "gemini", label: "Google Gemini", protocol: "gemini", key: "required", keyPattern: /^[A-Za-z0-9_-]{30,100}$/, caps: { streaming: false } },
  openrouter: { id: "openrouter", label: "OpenRouter", protocol: "openai", baseURL: "https://openrouter.ai/api/v1", key: "required", keyPattern: /^sk-or-[A-Za-z0-9_-]{20,300}$/, caps: { streaming: true } },
  ollama: { id: "ollama", label: "Ollama (local)", protocol: "openai", baseURL: "http://127.0.0.1:11434/v1", key: "none", caps: { streaming: true } },
  proxy: {
    id: "proxy",
    label: "Local proxy (advanced)",
    protocol: "openai",
    // e.g. a CLIProxyAPI the user runs (sign-in happens in their terminal; Flow handles no OAuth)
    baseURL: "http://127.0.0.1:8317/v1",
    key: "optional",
    caps: { streaming: true },
    warning: "Advanced: Flow sends requests to a proxy you run yourself and does not alter them. Routing a consumer subscription (for example a chat plan) through a proxy may violate the provider's terms; use an API plan where you can.",
  },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProviderId = (x: unknown): x is ProviderId => typeof x === "string" && x in PROVIDERS;

export interface ProviderSettings {
  /** proxy (required), ollama (override). */
  baseURL?: string;
  /** proxy only: which wire protocol it speaks. */
  protocol?: "openai" | "anthropic";
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Tool use support: true / false / null (unknown: tried at run time, clear error if refused). */
  tools: boolean | null;
  streaming: boolean;
}

// ------------------------------------------------------------------ credentials

const svc = (id: SecretSlot) => `flow/${id}-api-key`;
const useKeychain = (env: NodeJS.ProcessEnv) => env.ATE_KEYSTORE !== "file" && process.platform === "darwin" && existsSync("/usr/bin/security");

export class ProviderKeys {
  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  get kind(): "keychain" | "file" {
    return useKeychain(this.env) ? "keychain" : "file";
  }
  private file(id: SecretSlot) {
    return join(this.home, "keys", `${id}-api-key`);
  }
  load(id: SecretSlot): string | null {
    if (id === "anthropic") return loadStoredApiKey(this.home, this.env);
    try {
      if (useKeychain(this.env)) return execFileSync("/usr/bin/security", ["find-generic-password", "-a", "ate", "-s", svc(id), "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
      return existsSync(this.file(id)) ? readFileSync(this.file(id), "utf8").trim() || null : null;
    } catch {
      return null;
    }
  }
  save(id: SecretSlot, key: string): void {
    if (id === "anthropic") return void storeApiKey(this.home, key, this.env);
    if (useKeychain(this.env)) {
      execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-a", "ate", "-s", svc(id), "-l", `Flow · ${id in PROVIDERS ? PROVIDERS[id as ProviderId].label : id} key`, "-w", key], { stdio: "ignore" });
      return;
    }
    mkdirSync(join(this.home, "keys"), { recursive: true, mode: 0o700 });
    writeFileSync(this.file(id), key, { mode: 0o600 });
    chmodSync(this.file(id), 0o600);
  }
  remove(id: SecretSlot): void {
    if (id === "anthropic") return removeApiKey(this.home, this.env);
    try {
      if (useKeychain(this.env)) execFileSync("/usr/bin/security", ["delete-generic-password", "-a", "ate", "-s", svc(id)], { stdio: "ignore" });
      else rmSync(this.file(id), { force: true });
    } catch {
      /* not stored */
    }
  }
  /** Where the credential comes from (never the value): env | keychain | file | profile | none. */
  source(id: ProviderId): { source: "env" | "keychain" | "file" | "profile" | "none"; hint: string | null; stored: boolean } {
    const tail = (k: string) => `…${k.slice(-4)}`;
    if (id === "anthropic") {
      const c = modelCredentials(this.home, this.env);
      return { source: c.source === "keychain" ? this.kind : (c.source ?? "none"), hint: c.hint, stored: c.stored };
    }
    const envKey = id === "openai" ? this.env.OPENAI_API_KEY : id === "gemini" ? (this.env.GEMINI_API_KEY ?? this.env.GOOGLE_API_KEY) : id === "openrouter" ? this.env.OPENROUTER_API_KEY : undefined;
    const stored = this.load(id);
    if (stored) return { source: this.kind, hint: tail(stored), stored: true };
    if (envKey) return { source: "env", hint: tail(envKey), stored: false };
    return { source: "none", hint: null, stored: false };
  }
  resolve(id: ProviderId): string | null {
    if (id === "openai") return this.load(id) ?? this.env.OPENAI_API_KEY ?? null;
    if (id === "gemini") return this.load(id) ?? this.env.GEMINI_API_KEY ?? this.env.GOOGLE_API_KEY ?? null;
    if (id === "openrouter") return this.load(id) ?? this.env.OPENROUTER_API_KEY ?? null;
    return this.load(id);
  }
}

// ------------------------------------------------------------------ tool schemas per provider

const STRIP = new Set(["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "default", "uniqueItems"]);
function clean(s: unknown, notes: string[]): unknown {
  if (!s || typeof s !== "object" || Array.isArray(s)) return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (STRIP.has(k)) notes.push(`${k} ${JSON.stringify(v)}`);
    else out[k] = v;
  }
  return out;
}

/**
 * OpenAI strict function schema: closed objects, every property required, optional ones nullable (null = omitted;
 * `dropNulls` removes them before the daemon validates). Unsupported keywords move into the description.
 */
export function openaiStrictSchema(s: unknown): Record<string, unknown> {
  const notes: string[] = [];
  const o = clean(s, notes) as Record<string, unknown>;
  if (o.type === "object" && o.properties) {
    const req = new Set((o.required as string[] | undefined) ?? []);
    o.properties = Object.fromEntries(
      Object.entries(o.properties as Record<string, unknown>).map(([k, v]) => {
        const p = openaiStrictSchema(v);
        if (!req.has(k)) {
          if (Array.isArray(p.enum)) p.enum = [...(p.enum as unknown[]), null];
          p.type = [p.type, "null"];
        }
        return [k, p];
      }),
    );
    o.required = Object.keys(o.properties as object);
    o.additionalProperties = false;
  } else if (o.type === "array" && o.items) o.items = openaiStrictSchema(o.items);
  if (notes.length) o.description = `${o.description ? `${String(o.description)} ` : ""}(${notes.join(", ")})`;
  return o;
}

export function dropNulls(x: unknown): unknown {
  if (!x || typeof x !== "object" || Array.isArray(x)) return x;
  return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)]));
}

const defsFor = (names: readonly string[]) =>
  [...new Set(names)]
    .filter((n): n is ToolName => n in TOOL_DEFINITIONS)
    .sort()
    .map((n) => TOOL_DEFINITIONS[n]);

export function openaiTools(names: readonly string[], strict: boolean): ChatCompletionTool[] {
  return defsFor(names).map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: strict ? openaiStrictSchema(d.inputSchema) : (d.inputSchema as Record<string, unknown>), ...(strict ? { strict: true } : {}) } }));
}

export function geminiTools(names: readonly string[]): FunctionDeclaration[] {
  return defsFor(names).map((d) => ({ name: d.name, description: d.description, parametersJsonSchema: d.inputSchema }));
}

// ------------------------------------------------------------------ the shared loop contract

export interface ToolCallResult {
  content: string;
  isError: boolean;
}
export interface LoopUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface LoopResult {
  text: string;
  stop: string;
  turns: number;
  toolCalls: number;
  refusal?: { category: string | null; explanation: string | null };
  usage: LoopUsage;
  servedBy: string;
}
export interface GenericLoopOptions {
  model: string;
  system: string;
  toolNames: readonly string[];
  call(name: string, input: unknown, id: string): Promise<ToolCallResult>;
  signal?: AbortSignal;
  onText?(delta: string): void;
  maxTurns?: number;
  maxTokens?: number;
}

/** Thrown when the selected model refuses tool definitions (or lists no tool support). */
export class ToolsUnsupportedError extends Error {
  constructor(provider: ProviderId, model: string) {
    super(`${PROVIDERS[provider].label} model ${model} does not support tool use, which the trader and chat need. Pick a model with tool support.`);
  }
}


/**
 * Hard deadline: resolves/rejects with `p`, or rejects as soon as `signal` aborts — even when the underlying request
 * or tool never settles (an SDK stream that hangs, a stuck RPC). The trader's 90 s cycle kill relies on this.
 */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  return new Promise<T>((res, rej) => {
    const on = () => rej(Object.assign(new Error("aborted at the cycle deadline"), { name: "AbortError" }));
    signal.addEventListener("abort", on, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", on), res(v)),
      (e) => (signal.removeEventListener("abort", on), rej(e)),
    );
  });
}
/** Per-request ceiling handed to every SDK call (the cycle deadline aborts sooner). */
export const REQUEST_TIMEOUT_MS = 85_000;

// ------------------------------------------------------------------ OpenAI-compatible loop (openai, openrouter, ollama, proxy)

export interface OpenAILike {
  chat: { completions: { create(body: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout?: number }): Promise<unknown> } };
  models: { list(): Promise<unknown> };
}

export async function runOpenAILoop(client: OpenAILike, history: ChatCompletionMessageParam[], o: GenericLoopOptions & { strict: boolean; stream: boolean }): Promise<LoopResult> {
  const usage: LoopUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let text = "";
  let turns = 0;
  let toolCalls = 0;
  let servedBy = o.model;
  const tools = openaiTools(o.toolNames, o.strict);
  for (;;) {
    if (o.signal?.aborted) return { text, stop: "aborted", turns, toolCalls, usage, servedBy };
    const body: Record<string, unknown> = {
      model: o.model,
      messages: [{ role: "system", content: o.system }, ...history],
      tools,
      tool_choice: "auto",
      max_completion_tokens: o.maxTokens ?? 16000,
      ...(o.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    let content = "";
    let finish: string | null = null;
    const calls: { id: string; name: string; args: string }[] = [];
    let refusal: string | null = null;
    if (o.stream) {
      const s = (await abortable(client.chat.completions.create(body, { timeout: REQUEST_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}) }), o.signal)) as AsyncIterable<{
        model?: string;
        choices: { delta: { content?: string | null; refusal?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
      }>;
      for await (const ch of s) {
        if (ch.model) servedBy = ch.model;
        if (ch.usage) {
          usage.inputTokens += ch.usage.prompt_tokens ?? 0;
          usage.outputTokens += ch.usage.completion_tokens ?? 0;
          usage.cacheReadTokens += ch.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }
        const c = ch.choices[0];
        if (!c) continue;
        if (c.delta.content) {
          content += c.delta.content;
          o.onText?.(c.delta.content);
        }
        if (c.delta.refusal) refusal = (refusal ?? "") + c.delta.refusal;
        for (const tc of c.delta.tool_calls ?? []) {
          const cur = (calls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
        if (c.finish_reason) finish = c.finish_reason;
      }
    } else {
      const r = (await abortable(client.chat.completions.create(body, { timeout: REQUEST_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}) }), o.signal)) as {
        model?: string;
        choices: { message: { content?: string | null; refusal?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };
      servedBy = r.model ?? servedBy;
      usage.inputTokens += r.usage?.prompt_tokens ?? 0;
      usage.outputTokens += r.usage?.completion_tokens ?? 0;
      usage.cacheReadTokens += r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const m = r.choices[0]?.message;
      content = m?.content ?? "";
      if (content) o.onText?.(content);
      refusal = m?.refusal ?? null;
      for (const tc of m?.tool_calls ?? []) calls.push({ id: tc.id, name: tc.function.name, args: tc.function.arguments });
      finish = r.choices[0]?.finish_reason ?? null;
    }
    turns++;
    const live = calls.filter(Boolean);
    history.push({ role: "assistant", content: content || null, ...(live.length ? { tool_calls: live.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })) } : {}) } as ChatCompletionMessageParam);
    if (content) text += (text ? "\n" : "") + content;
    if (refusal || finish === "content_filter") return { text, stop: "refusal", turns, toolCalls, usage, servedBy, refusal: { category: finish === "content_filter" ? "content_filter" : null, explanation: refusal } };
    if (finish === "length") return { text, stop: "max_tokens", turns, toolCalls, usage, servedBy };
    if (!live.length) return { text, stop: "end_turn", turns, toolCalls, usage, servedBy };
    if (turns >= (o.maxTurns ?? 16)) return { text, stop: "max_turns", turns, toolCalls, usage, servedBy };
    for (const c of live) {
      toolCalls++;
      let r: ToolCallResult;
      try {
        r = await abortable(o.call(c.name, dropNulls(JSON.parse(c.args || "{}")), c.id), o.signal);
      } catch (e) {
        if (o.signal?.aborted) throw e;
        r = { content: `tool failed: ${(e as Error).message}`, isError: true };
      }
      history.push({ role: "tool", tool_call_id: c.id, content: r.isError ? `ERROR ${r.content}` : r.content });
    }
  }
}

// ------------------------------------------------------------------ Gemini loop

export interface GeminiLike {
  models: { generateContent(p: Record<string, unknown>): Promise<{ candidates?: { content?: Content; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }; modelVersion?: string; promptFeedback?: { blockReason?: string } }>; list(p?: unknown): Promise<AsyncIterable<{ name?: string; displayName?: string; supportedActions?: string[] }>> };
}

export async function runGeminiLoop(client: GeminiLike, history: Content[], o: GenericLoopOptions): Promise<LoopResult> {
  const usage: LoopUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let text = "";
  let turns = 0;
  let toolCalls = 0;
  let servedBy = o.model;
  const decls = geminiTools(o.toolNames);
  for (;;) {
    if (o.signal?.aborted) return { text, stop: "aborted", turns, toolCalls, usage, servedBy };
    const r = await abortable(client.models.generateContent({
      model: o.model,
      contents: history,
      config: { systemInstruction: o.system, tools: [{ functionDeclarations: decls }], maxOutputTokens: o.maxTokens ?? 16000, httpOptions: { timeout: REQUEST_TIMEOUT_MS }, ...(o.signal ? { abortSignal: o.signal } : {}) },
    }), o.signal);
    turns++;
    servedBy = r.modelVersion ?? servedBy;
    usage.inputTokens += r.usageMetadata?.promptTokenCount ?? 0;
    usage.outputTokens += r.usageMetadata?.candidatesTokenCount ?? 0;
    usage.cacheReadTokens += r.usageMetadata?.cachedContentTokenCount ?? 0;
    const cand = r.candidates?.[0];
    if (!cand?.content) return { text, stop: "refusal", turns, toolCalls, usage, servedBy, refusal: { category: r.promptFeedback?.blockReason ?? cand?.finishReason ?? null, explanation: null } };
    // the model's content goes back verbatim (keeps thought signatures)
    history.push(cand.content);
    const parts = cand.content.parts ?? [];
    const t = parts.filter((p) => p.text && !(p as { thought?: boolean }).thought).map((p) => p.text).join("");
    if (t) {
      text += (text ? "\n" : "") + t;
      o.onText?.(t);
    }
    const fr = cand.finishReason;
    if (fr === "SAFETY" || fr === "PROHIBITED_CONTENT" || fr === "BLOCKLIST" || fr === "SPII") return { text, stop: "refusal", turns, toolCalls, usage, servedBy, refusal: { category: fr, explanation: null } };
    if (fr === "MAX_TOKENS") return { text, stop: "max_tokens", turns, toolCalls, usage, servedBy };
    const fcs = parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
    if (!fcs.length) return { text, stop: "end_turn", turns, toolCalls, usage, servedBy };
    if (turns >= (o.maxTurns ?? 16)) return { text, stop: "max_turns", turns, toolCalls, usage, servedBy };
    const out: Part[] = [];
    for (const fc of fcs) {
      toolCalls++;
      let res: ToolCallResult;
      try {
        res = await abortable(o.call(fc.name ?? "", fc.args ?? {}, fc.id ?? fc.name ?? ""), o.signal);
      } catch (e) {
        if (o.signal?.aborted) throw e;
        res = { content: `tool failed: ${(e as Error).message}`, isError: true };
      }
      let parsed: unknown = res.content;
      try {
        parsed = JSON.parse(res.content);
      } catch {
        /* text */
      }
      out.push({ functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name ?? "", response: res.isError ? { error: parsed } : { output: parsed } } });
    }
    history.push({ role: "user", parts: out });
  }
}

// ------------------------------------------------------------------ clients + model listing

export function openaiClient(def: ProviderDef, key: string | null, baseURL?: string): OpenAI {
  return new OpenAI({ apiKey: key ?? (def.key === "none" || def.key === "optional" ? "not-needed" : undefined), ...(baseURL ?? def.baseURL ? { baseURL: baseURL ?? def.baseURL } : {}), maxRetries: 2 });
}
export function geminiClient(key: string | null): GoogleGenAI {
  return new GoogleGenAI({ ...(key ? { apiKey: key } : {}) });
}
export function anthropicFor(home: string, env: NodeJS.ProcessEnv, id: ProviderId, key: string | null, baseURL?: string): Anthropic {
  if (id === "anthropic") return anthropicClient(home, env);
  return new Anthropic({
    apiKey: key ?? "not-needed",
    ...(baseURL ? { baseURL: baseURL.replace(/\/v1\/?$/, "") } : {}),
    // the subscription proxy takes its client key as a bearer as well as x-api-key
    ...(id === "subscription" && key ? { defaultHeaders: { authorization: `Bearer ${key}` } } : {}),
  });
}

const NON_CHAT = /(embed|whisper|tts|dall-e|image|audio|moderation|transcribe|realtime|search|davinci|babbage|computer-use)/i;

export async function listModels(id: ProviderId, client: unknown, opts: { baseURL?: string } = {}): Promise<ModelInfo[]> {
  const def = PROVIDERS[id];
  const streaming = def.caps.streaming;
  if (def.protocol === "anthropic" || (id === "proxy" && client instanceof Anthropic)) {
    const out: ModelInfo[] = [];
    for await (const m of (client as Anthropic).models.list()) out.push({ id: m.id, label: m.display_name ?? m.id, tools: true, streaming });
    return out;
  }
  if (def.protocol === "gemini") {
    const out: ModelInfo[] = [];
    for await (const m of await (client as GeminiLike).models.list()) {
      if (!m.name || !(m.supportedActions ?? []).includes("generateContent") || NON_CHAT.test(m.name)) continue;
      out.push({ id: m.name.replace(/^models\//, ""), label: m.displayName ?? m.name, tools: true, streaming });
    }
    return out;
  }
  const page = (await (client as OpenAI).models.list()) as unknown as AsyncIterable<{ id: string; name?: string; supported_parameters?: string[] }>;
  const raw: { id: string; name?: string; supported_parameters?: string[] }[] = [];
  for await (const m of page) raw.push(m);
  const ms = raw.filter((m) => !NON_CHAT.test(m.id));
  if (id === "openrouter") return ms.map((m) => ({ id: m.id, label: m.name ?? m.id, tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : null, streaming }));
  if (id === "ollama") {
    const root = (opts.baseURL ?? def.baseURL!).replace(/\/v1\/?$/, "");
    return Promise.all(
      ms.slice(0, 40).map(async (m) => {
        let tools: boolean | null = null;
        try {
          const r = await fetch(`${root}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m.id }), signal: AbortSignal.timeout(5000) });
          const j = (await r.json()) as { capabilities?: string[] };
          if (Array.isArray(j.capabilities)) tools = j.capabilities.includes("tools");
        } catch {
          /* unknown */
        }
        return { id: m.id, label: m.id, tools, streaming };
      }),
    );
  }
  return ms.map((m) => ({ id: m.id, label: m.id, tools: id === "proxy" ? null : true, streaming }));
}
