// MCP servers the agents may use (Flow v1 "Tools (MCP)"): Flow's own server (always on, every server-side rule), the
// servers in the user's opencode config (read-only definitions), and servers the user adds in Flow (stdio command or
// Streamable HTTP URL). Each can be enabled for the chat agent and for the trader separately; the trader starts with
// Flow's server only, and turning another server on for it raises risk, so the route asks for Touch ID. Definitions
// live in <home>/mcp.json; env / header values are secrets and live in the keychain (never in the file).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAT_TOOL_ALLOWLIST, TOOL_NAMES } from "@ate/core";
import type { ProviderKeys } from "./providers.js";

export type McpAgent = "chat" | "trader";
export interface McpServerDef {
  id: string;
  name: string;
  source: "flow" | "opencode" | "user";
  type: "builtin" | "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Names only; values are in the keychain (user servers) or the opencode config (opencode servers). */
  envKeys?: string[];
  headerKeys?: string[];
  enabled: Record<McpAgent, boolean>;
}
export interface McpServerStatus extends McpServerDef {
  state: "connected" | "available" | "error";
  error: string | null;
  tools: { name: string; description: string }[];
  checkedAt: number | null;
}
export interface ExtraTool {
  /** Name the model sees: mcp__<server>__<tool> (sanitised, ≤ 64 chars). */
  name: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31) || "server";
const qualify = (server: string, tool: string) => `mcp__${server.replace(/-/g, "_")}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);

interface Stored {
  servers: McpServerDef[];
  /** enable flags for Flow's and opencode's servers (their definitions are not ours to store) */
  enabled: Record<string, Record<McpAgent, boolean>>;
}

export class McpServers {
  private status_ = new Map<string, { state: McpServerStatus["state"]; error: string | null; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]; checkedAt: number }>();
  private clients = new Map<string, Client>();
  private readonly file: string;
  /** Called when the enabled set changes (the opencode engine restarts its server). */
  onChange?: () => void;

  constructor(
    private readonly home: string,
    private readonly keys: ProviderKeys,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = join(home, "mcp.json");
  }

  private load(): Stored {
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Stored>;
      return { servers: Array.isArray(j.servers) ? j.servers : [], enabled: j.enabled ?? {} };
    } catch {
      return { servers: [], enabled: {} };
    }
  }
  private save(s: Stored) {
    writeFileSync(this.file, JSON.stringify(s, null, 2), { mode: 0o600 });
    this.onChange?.();
  }

  /** The user's opencode config (`~/.config/opencode/opencode.json[c]`), `mcp` section, raw. */
  private opencodeRaw(): Record<string, { type?: string; command?: string[]; url?: string; environment?: Record<string, string>; headers?: Record<string, string>; enabled?: boolean }> {
    const dir = this.env.ATE_OPENCODE_CONFIG_DIR ?? join(this.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
    for (const f of ["opencode.json", "opencode.jsonc"]) {
      const p = join(dir, f);
      if (!existsSync(p)) continue;
      try {
        const t = readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, "");
        const j = JSON.parse(t.replace(/[\u0000-\u001f]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? c : ""))) as { mcp?: Record<string, never> };
        return j.mcp ?? {};
      } catch {
        return {};
      }
    }
    return {};
  }
  /** opencode's own names for its servers (so Flow can switch them off inside its private opencode server). */
  opencodeNames(): string[] {
    return Object.keys(this.opencodeRaw());
  }

  list(): McpServerDef[] {
    const s = this.load();
    const en = (id: string, d: Record<McpAgent, boolean>) => s.enabled[id] ?? d;
    const flow: McpServerDef = { id: "flow", name: "Flow", source: "flow", type: "builtin", enabled: { chat: true, trader: true } };
    const oc: McpServerDef[] = Object.entries(this.opencodeRaw()).map(([name, v]) => {
      const id = `oc-${slug(name)}`;
      return {
        id,
        name,
        source: "opencode",
        type: v.type === "remote" ? "http" : "stdio",
        ...(v.type === "remote" ? { url: v.url ?? "" } : { command: v.command?.[0] ?? "", args: v.command?.slice(1) ?? [] }),
        envKeys: Object.keys(v.environment ?? {}),
        headerKeys: Object.keys(v.headers ?? {}),
        enabled: en(id, { chat: false, trader: false }),
      };
    });
    return [flow, ...oc, ...s.servers.map((x) => ({ ...x, source: "user" as const, enabled: s.enabled[x.id] ?? x.enabled }))];
  }

  status(): McpServerStatus[] {
    return this.list().map((d) => {
      if (d.type === "builtin")
        return { ...d, state: "connected", error: null, checkedAt: null, tools: TOOL_NAMES.map((n) => ({ name: n, description: CHAT_TOOL_ALLOWLIST.includes(n as never) ? "chat + trader" : "trader" })) };
      const st = this.status_.get(d.id);
      return { ...d, state: st?.state ?? "available", error: st?.error ?? null, checkedAt: st?.checkedAt ?? null, tools: (st?.tools ?? []).map((t) => ({ name: t.name, description: t.description })) };
    });
  }

  /** Add a server (stdio command or Streamable HTTP URL). env / header values go to the keychain. */
  add(b: { name?: string; type?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> }): McpServerDef {
    const name = String(b.name ?? "").trim().slice(0, 60);
    if (!name) throw Object.assign(new Error("name required"), { status: 400, code: "ATE_CONFIG_INVALID" });
    const s = this.load();
    let id = `u-${slug(name)}`;
    for (let i = 2; s.servers.some((x) => x.id === id); i++) id = `u-${slug(name)}-${i}`;
    if (!ID_RE.test(id)) throw Object.assign(new Error("bad name"), { status: 400, code: "ATE_CONFIG_INVALID" });
    let def: McpServerDef;
    if (b.type === "http") {
      let u: URL;
      try {
        u = new URL(String(b.url ?? ""));
      } catch {
        throw Object.assign(new Error("URL required"), { status: 400, code: "ATE_CONFIG_INVALID" });
      }
      const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
      if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) throw Object.assign(new Error("use https (or http on this Mac)"), { status: 400, code: "ATE_CONFIG_INVALID" });
      def = { id, name, source: "user", type: "http", url: u.toString(), headerKeys: Object.keys(b.headers ?? {}), enabled: { chat: true, trader: false } };
    } else {
      const command = String(b.command ?? "").trim();
      if (!command) throw Object.assign(new Error("command required"), { status: 400, code: "ATE_CONFIG_INVALID" });
      def = { id, name, source: "user", type: "stdio", command, args: (b.args ?? []).map(String).slice(0, 40), envKeys: Object.keys(b.env ?? {}), enabled: { chat: true, trader: false } };
    }
    for (const [k, v] of Object.entries(b.env ?? {})) this.keys.save(`mcp:${id}:env:${k}`, String(v));
    for (const [k, v] of Object.entries(b.headers ?? {})) this.keys.save(`mcp:${id}:hdr:${k}`, String(v));
    s.servers.push(def);
    this.save(s);
    return def;
  }

  remove(id: string): void {
    const s = this.load();
    const d = s.servers.find((x) => x.id === id);
    if (!d) throw Object.assign(new Error("only servers added in Flow can be removed"), { status: 400, code: "ATE_CONFIG_INVALID" });
    for (const k of d.envKeys ?? []) this.keys.remove(`mcp:${id}:env:${k}`);
    for (const k of d.headerKeys ?? []) this.keys.remove(`mcp:${id}:hdr:${k}`);
    s.servers = s.servers.filter((x) => x.id !== id);
    delete s.enabled[id];
    void this.clients.get(id)?.close().catch(() => {});
    this.clients.delete(id);
    this.status_.delete(id);
    this.save(s);
  }

  /** True when this change needs Touch ID: turning a non-Flow server on for the trader. */
  needsApproval(id: string, agent: McpAgent, on: boolean): boolean {
    return agent === "trader" && on && id !== "flow";
  }
  setEnabled(id: string, agent: McpAgent, on: boolean): McpServerDef {
    if (id === "flow") throw Object.assign(new Error("Flow's own server is always on"), { status: 400, code: "ATE_CONFIG_INVALID" });
    const d = this.list().find((x) => x.id === id);
    if (!d) throw Object.assign(new Error("unknown server"), { status: 404, code: "ATE_CONFIG_INVALID" });
    const s = this.load();
    s.enabled[id] = { ...d.enabled, [agent]: on };
    this.save(s);
    return { ...d, enabled: s.enabled[id]! };
  }

  /** Secrets for a server (user: keychain; opencode: its own config) — only ever handed to the transport. */
  private secrets(d: McpServerDef): { env: Record<string, string>; headers: Record<string, string> } {
    if (d.source === "opencode") {
      const v = this.opencodeRaw()[d.name] ?? {};
      return { env: v.environment ?? {}, headers: v.headers ?? {} };
    }
    const env = Object.fromEntries((d.envKeys ?? []).map((k) => [k, this.keys.load(`mcp:${d.id}:env:${k}`) ?? ""]));
    const headers = Object.fromEntries((d.headerKeys ?? []).map((k) => [k, this.keys.load(`mcp:${d.id}:hdr:${k}`) ?? ""]));
    return { env, headers };
  }

  /** The command / URL / secrets for a server, in opencode's config shape (for the opencode engine). */
  opencodeConfigFor(d: McpServerDef): { type: "local"; command: string[]; environment: Record<string, string>; enabled: true } | { type: "remote"; url: string; headers: Record<string, string>; enabled: true; oauth: false } {
    const sec = this.secrets(d);
    return d.type === "http" ? { type: "remote", url: d.url!, headers: sec.headers, enabled: true, oauth: false } : { type: "local", command: [d.command!, ...(d.args ?? [])], environment: sec.env, enabled: true };
  }

  private async client(d: McpServerDef): Promise<Client> {
    const have = this.clients.get(d.id);
    if (have) return have;
    const sec = this.secrets(d);
    const transport =
      d.type === "http"
        ? new StreamableHTTPClientTransport(new URL(d.url!), { requestInit: { headers: sec.headers } })
        : new StdioClientTransport({ command: d.command!, args: d.args ?? [], env: { ...(process.env as Record<string, string>), ...sec.env }, stderr: "ignore" });
    const c = new Client({ name: "flow-daemon", version: "0.1.0" });
    await c.connect(transport);
    this.clients.set(d.id, c);
    return c;
  }

  /** Connect, list tools, cache the state. Never throws. */
  async test(id: string): Promise<McpServerStatus> {
    const d = this.list().find((x) => x.id === id);
    if (!d) throw Object.assign(new Error("unknown server"), { status: 404, code: "ATE_CONFIG_INVALID" });
    if (d.type !== "builtin") {
      const at = Math.floor(Date.now() / 1000);
      try {
        const c = await Promise.race([this.client(d), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out connecting")), 15_000))]);
        const r = await c.listTools(undefined, { timeout: 10_000 });
        this.status_.set(id, { state: "connected", error: null, checkedAt: at, tools: r.tools.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 500), inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> })) });
      } catch (e) {
        void this.clients.get(id)?.close().catch(() => {});
        this.clients.delete(id);
        this.status_.set(id, { state: "error", error: (e as Error).message.split("\n")[0]!.slice(0, 200), checkedAt: at, tools: [] });
      }
    }
    return this.status().find((x) => x.id === id)!;
  }

  /** Extra tools (from connected, enabled, non-Flow servers) for one agent, as the model sees them. */
  extraTools(agent: McpAgent): ExtraTool[] {
    const out: ExtraTool[] = [];
    for (const d of this.list()) {
      if (d.type === "builtin" || !d.enabled[agent]) continue;
      for (const t of this.status_.get(d.id)?.tools ?? []) out.push({ name: qualify(d.id, t.name), server: d.id, tool: t.name, description: `[${d.name}] ${t.description}`, inputSchema: t.inputSchema });
    }
    return out;
  }
  /** Servers enabled for `agent` other than Flow's (ids). */
  enabledFor(agent: McpAgent): McpServerDef[] {
    return this.list().filter((d) => d.type !== "builtin" && d.enabled[agent]);
  }

  async call(agent: McpAgent, name: string, args: unknown): Promise<{ content: string; isError: boolean }> {
    const t = this.extraTools(agent).find((x) => x.name === name);
    if (!t) return { content: `tool ${name} is not enabled for the ${agent}`, isError: true };
    const d = this.list().find((x) => x.id === t.server)!;
    const c = await this.client(d);
    const r = (await c.callTool({ name: t.tool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: 60_000 })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (r.content ?? []).map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
    return { content: text.length > 60_000 ? `${text.slice(0, 60_000)}…(truncated)` : text, isError: !!r.isError };
  }

  async closeAll(): Promise<void> {
    for (const c of this.clients.values()) await c.close().catch(() => {});
    this.clients.clear();
  }
}
