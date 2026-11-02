// AI model credentials and reachability (setup "AI model" part of step 04, Settings → AI & data). The in-app
// agents call Claude through @anthropic-ai/sdk; no Claude Code CLI is involved.
//
// Credential order (first match wins), mirroring the SDK's own resolution with the app's keychain slot inserted:
//   1. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the daemon's environment
//   2. an API key the user pasted in Flow, kept in the macOS login keychain (file store 0600 when headless)
//   3. an `ant auth login` profile (<ANTHROPIC_CONFIG_DIR | ~/.config/anthropic>/configs/<active>.json)
// The key never enters config.json, logs, /events or the renderer: routes only ever return `…last4`.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";
const KEYCHAIN_SERVICE = "flow/anthropic-api-key";
export const API_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;

export type CredentialSource = "env" | "keychain" | "profile" | null;

function useKeychain(env: NodeJS.ProcessEnv): boolean {
  return env.ATE_KEYSTORE !== "file" && process.platform === "darwin" && existsSync("/usr/bin/security");
}
const fileSlot = (home: string) => join(home, "keys", "anthropic-api-key");

/** The stored key, or null. Main-process/daemon only. */
export function loadStoredApiKey(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (useKeychain(env)) {
    try {
      const v = execFileSync("/usr/bin/security", ["find-generic-password", "-a", "ate", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return v || null;
    } catch {
      return null;
    }
  }
  const p = fileSlot(home);
  return existsSync(p) ? readFileSync(p, "utf8").trim() || null : null;
}

export function storeApiKey(home: string, key: string, env: NodeJS.ProcessEnv = process.env): "keychain" | "file" {
  if (!API_KEY_RE.test(key)) throw new Error("not an Anthropic API key (sk-ant-…)");
  if (useKeychain(env)) {
    // -U updates in place. The value is on argv for the lifetime of one `security` call (same-user visibility only).
    execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-a", "ate", "-s", KEYCHAIN_SERVICE, "-l", "Flow · Anthropic API key", "-w", key], { stdio: "ignore" });
    return "keychain";
  }
  mkdirSync(join(home, "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(fileSlot(home), key, { mode: 0o600 });
  chmodSync(fileSlot(home), 0o600);
  return "file";
}

export function removeApiKey(home: string, env: NodeJS.ProcessEnv = process.env): void {
  if (useKeychain(env)) {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-a", "ate", "-s", KEYCHAIN_SERVICE], { stdio: "ignore" });
    } catch {
      /* not there */
    }
  } else rmSync(fileSlot(home), { force: true });
}

export function profileName(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.ANTHROPIC_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".config", "anthropic");
  let name = env.ANTHROPIC_PROFILE ?? "default";
  if (!env.ANTHROPIC_PROFILE) {
    try {
      name = readFileSync(join(dir, "active_config"), "utf8").trim() || "default";
    } catch {
      /* default */
    }
  }
  return existsSync(join(dir, "configs", `${name}.json`)) ? name : null;
}

export interface ModelCredentials {
  source: CredentialSource;
  /** `…abcd` of the API key in use (env or keychain); null for profiles/tokens. */
  hint: string | null;
  profile: string | null;
  stored: boolean;
}

export function modelCredentials(home: string, env: NodeJS.ProcessEnv = process.env): ModelCredentials {
  const stored = loadStoredApiKey(home, env);
  const tail = (k: string) => `…${k.slice(-4)}`;
  if (env.ANTHROPIC_API_KEY) return { source: "env", hint: tail(env.ANTHROPIC_API_KEY), profile: null, stored: !!stored };
  if (env.ANTHROPIC_AUTH_TOKEN) return { source: "env", hint: null, profile: null, stored: !!stored };
  if (stored) return { source: "keychain", hint: tail(stored), profile: null, stored: true };
  const p = profileName(env);
  return p ? { source: "profile", hint: null, profile: p, stored: false } : { source: null, hint: null, profile: null, stored: false };
}

/**
 * Client for the in-app agents (lane D3's engine should construct its client here so the keychain key is used).
 * Env credentials and profiles are left to the SDK's default resolution.
 */
export function anthropicClient(home: string, env: NodeJS.ProcessEnv = process.env, opts: { timeout?: number; maxRetries?: number } = {}): Anthropic {
  const stored = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? null : loadStoredApiKey(home, env);
  return new Anthropic({ ...(stored ? { apiKey: stored } : {}), ...opts });
}

export interface ModelCheck {
  ok: boolean;
  model: string;
  ms: number;
  source: CredentialSource;
  detail: string;
}

/** One tiny request: proves credentials + network + model access. ~$0.0002 at low effort. */
export async function checkModel(home: string, env: NodeJS.ProcessEnv = process.env, model = DEFAULT_MODEL, client?: Anthropic): Promise<ModelCheck> {
  const creds = modelCredentials(home, env);
  if (!creds.source && !client) return { ok: false, model, ms: 0, source: null, detail: "no Anthropic credentials: paste an API key" };
  const c = client ?? anthropicClient(home, env, { timeout: 30_000, maxRetries: 0 });
  const t0 = Date.now();
  try {
    const r = await c.messages.create({ model, max_tokens: 256, output_config: { effort: "low" }, messages: [{ role: "user", content: "Reply with the single word: ok" }] });
    return { ok: true, model: r.model, ms: Date.now() - t0, source: creds.source, detail: `stop_reason ${r.stop_reason}` };
  } catch (e) {
    const ms = Date.now() - t0;
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, model, ms, source: creds.source, detail: "the API key was rejected (401)" };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, model, ms, source: creds.source, detail: `no access to ${model} (403)` };
    if (e instanceof Anthropic.NotFoundError) return { ok: false, model, ms, source: creds.source, detail: `model ${model} not found (404)` };
    if (e instanceof Anthropic.RateLimitError) return { ok: true, model, ms, source: creds.source, detail: "reachable, rate limited (429)" };
    if (e instanceof Anthropic.APIConnectionError) return { ok: false, model, ms, source: creds.source, detail: "cannot reach api.anthropic.com" };
    if (e instanceof Anthropic.APIError) return { ok: false, model, ms, source: creds.source, detail: `API error ${e.status ?? ""}`.trim() };
    return { ok: false, model, ms, source: creds.source, detail: (e as Error).message.split("\n")[0]!.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…") };
  }
}
