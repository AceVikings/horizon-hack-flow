// Daemon client (main process only). Reads ~/.ate/runtime.json, attaches for a `ui` token (SPEC §10.1),
// calls MCP tools over Streamable HTTP /mcp, and relays WS /events. Tokens never leave main.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type {
  ChatRequest,
  ChatResponse,
  DaemonEvent,
  RuntimeJson,
  StatusResponse,
  ToolName,
  ToolInput,
  ToolOutput,
  ToolResult,
  UiAttachStep1Response,
  UiAttachStep2Response,
} from "@ate/core";
import { uiAttachPayload } from "@ate/approve";
import type { AteErrorCode } from "@ate/core";
import type { ConnectionInfo, Res } from "../shared/bridge";
import { signApproval } from "./approve";

const ORIGIN = "ate://local";

export class DaemonClient {
  private rt: RuntimeJson | null = null;
  private uiToken: string | null = process.env.ATE_UI_TOKEN ?? null;
  private mcpSession: string | null = null;
  private ws: WebSocket | null = null;
  private reconnect: NodeJS.Timeout | null = null;
  private info: ConnectionInfo = { mode: "offline", detail: "not connected" };
  constructor(private onEvent: (e: DaemonEvent) => void) {}

  connection(): ConnectionInfo {
    return this.info;
  }

  private base(): string {
    if (!this.rt) throw new Error("no daemon");
    return `http://127.0.0.1:${this.rt.port}`;
  }

  /** (Re)load runtime.json and attach. Never restarts the trader. */
  async connect(): Promise<ConnectionInfo> {
    try {
      const path = process.env.ATE_RUNTIME_JSON ?? join(process.env.ATE_HOME ?? join(homedir(), ".ate"), "runtime.json");
      this.rt = JSON.parse(await readFile(path, "utf8")) as RuntimeJson;
    } catch {
      this.info = { mode: "offline", detail: "daemon not running (no ~/.ate/runtime.json)" };
      return this.info;
    }
    try {
      if (!this.uiToken) this.uiToken = await this.attach();
      this.mcpSession = null;
      this.openEvents();
      this.info = { mode: "live", port: this.rt.port, scope: "ui", detail: `daemon pid ${this.rt.pid} v${this.rt.version}` };
    } catch (e) {
      this.uiToken = null;
      this.info = { mode: "offline", port: this.rt.port, detail: `attach failed: ${(e as Error).message}` };
    }
    return this.info;
  }

  /**
   * POST /ui/attach: nonce, then an ate-approve (Touch ID) signature over uiAttachPayload. Step 2 carries the agent
   * token from runtime.json as its bearer (Lane E route). Without ate-approve, set ATE_UI_TOKEN (dev only).
   */
  private async attach(): Promise<string> {
    const r1 = await this.http<UiAttachStep1Response>("POST", "/ui/attach", {}, false);
    const s = await signApproval(uiAttachPayload({ nonce: r1.nonce, expiresAt: r1.expiresAt, pid: this.rt!.pid, port: this.rt!.port }));
    if (!s.ok) throw new Error(`ate-approve ${s.code}: ${s.message}`);
    const r2 = await this.http<UiAttachStep2Response>("POST", "/ui/attach", { nonce: r1.nonce, approval: s.signature }, false, this.rt!.agentToken);
    return r2.uiToken;
  }

  /** Structured call for the approval routes: daemon errors (`{error:{code,message,details}}`) become Res errors. */
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Res<T>> {
    if (this.info.mode !== "live" || !this.rt) return { ok: false, error: { code: "ATE_DAEMON_LOCKED", message: this.info.detail ?? "daemon offline" } };
    try {
      const res = await fetch(this.base() + path, {
        method,
        headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${this.uiToken}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let j: any = {};
      try {
        j = text ? JSON.parse(text) : {};
      } catch {
        j = { error: text.slice(0, 200) };
      }
      if (!res.ok || j?.ok === false) {
        const e = j?.error;
        const code = (typeof e === "object" && e?.code ? e.code : res.status === 401 ? "ATE_APPROVAL_REQUIRED" : "ATE_INTERNAL") as AteErrorCode;
        const message = typeof e === "object" && e ? String(e.message ?? code) : String(e ?? `HTTP ${res.status}`);
        return { ok: false, error: { code, message, ...(typeof e === "object" && e?.hint ? { hint: e.hint } : {}), ...(typeof e === "object" && e?.details ? { details: e.details } : {}) } };
      }
      return { ok: true, data: (j && typeof j === "object" && "ok" in j && "data" in j ? j.data : j) as T };
    } catch (e) {
      return { ok: false, error: { code: "ATE_INTERNAL", message: (e as Error).message } };
    }
  }

  private async http<T>(method: "GET" | "POST", path: string, body?: unknown, auth = true, bearer?: string): Promise<T> {
    const token = bearer ?? (auth ? this.uiToken : null);
    const res = await fetch(this.base() + path, {
      method,
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  status(): Promise<StatusResponse> {
    return this.http("GET", "/status");
  }
  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.http("POST", "/chat", req);
  }
  cycle(): Promise<unknown> {
    return this.http("POST", "/cycle", {});
  }

  // ---- MCP over Streamable HTTP (minimal client: initialize, tools/call) ----
  private async rpc(method: string, params: unknown, id?: number): Promise<any> {
    const res = await fetch(this.base() + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: ORIGIN,
        authorization: `Bearer ${this.uiToken}`,
        ...(this.mcpSession ? { "mcp-session-id": this.mcpSession } : {}),
      },
      body: JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.mcpSession = sid;
    if (id === undefined) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`mcp ${method} → ${res.status} ${text.slice(0, 200)}`);
    const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .find((m) => m.id === id)
      : JSON.parse(text);
    if (payload?.error) throw new Error(payload.error.message ?? "mcp error");
    return payload?.result;
  }

  async tool<N extends ToolName>(name: N, args: ToolInput<N>): Promise<Res<ToolOutput<N>>> {
    if (this.info.mode !== "live") return { ok: false, error: { code: "ATE_DAEMON_LOCKED", message: this.info.detail ?? "daemon offline", hint: "Start the daemon (`ate daemon`), then restart or re-attach." } };
    try {
      if (!this.mcpSession) {
        await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ate-desktop", version: "0.1.0" } }, 1);
        await this.rpc("notifications/initialized", {});
      }
      const result = await this.rpc("tools/call", { name, arguments: args }, Date.now());
      const text = result?.content?.[0]?.text;
      const parsed = JSON.parse(text) as ToolResult<ToolOutput<N>>;
      return parsed.ok ? { ok: true, data: parsed.data } : { ok: false, error: parsed.error };
    } catch (e) {
      return { ok: false, error: { code: "ATE_INTERNAL", message: (e as Error).message } };
    }
  }

  // ---- /events ----
  private openEvents(): void {
    this.ws?.close();
    const ws = new WebSocket(`ws://127.0.0.1:${this.rt!.port}/events`, { headers: { authorization: `Bearer ${this.uiToken}`, origin: ORIGIN } });
    this.ws = ws;
    ws.on("message", (raw) => {
      try {
        this.onEvent(JSON.parse(raw.toString()) as DaemonEvent);
      } catch {
        /* ignore malformed frame */
      }
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.reconnect = setTimeout(() => void this.connect(), 3000);
    });
    ws.on("error", () => ws.close());
  }

  close(): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.ws?.close();
  }
}
