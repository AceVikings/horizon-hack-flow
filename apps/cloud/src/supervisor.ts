// Process supervisor: the owner service and the daemon (agent runtime) are separate child processes with separate
// credentials. The owner child gets ATE_OWNER_* (and no ATE_AGENT_*); the daemon gets ATE_AGENT_* with every
// ATE_OWNER_* removed (it refuses to start otherwise). Each child's token reaches only the gateway, over a pipe.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { withoutOwnerCredentials } from "@ate/wallet";

const here = dirname(fileURLToPath(import.meta.url));
const appBin = (app: string) => {
  for (const c of [resolve(here, `../../${app}/dist/bin.js`), resolve(process.cwd(), `apps/${app}/dist/bin.js`)]) if (existsSync(c)) return c;
  return resolve(here, `../../${app}/dist/bin.js`);
};

const withoutAgentCredentials = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("ATE_AGENT_"))) as NodeJS.ProcessEnv;

export class OwnerProcess {
  child: ChildProcess | null = null;
  port: number | null = null;
  address: string | null = null;
  error: string | null = null;
  readonly token = randomBytes(32).toString("base64url");
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly log: (m: string) => void) {}

  start(): Promise<void> {
    const env = { ...withoutAgentCredentials(this.env), FLOW_OWNER_STDIN: "1" };
    const child = spawn(process.execPath, [this.env.FLOW_OWNER_BIN ?? appBin("owner"), "serve"], { env, stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;
    child.stdin!.end(`${JSON.stringify({ token: this.token })}\n`);
    return new Promise((res) => {
      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (l) => {
        try {
          const j = JSON.parse(l) as { type?: string; port?: number; owner?: string };
          if (j.type === "owner.ready") {
            this.port = j.port ?? null;
            this.address = j.owner ?? null;
            this.error = null;
            this.log(`owner service ready: ${this.address}`);
            res();
          }
        } catch {
          /* not ours */
        }
      });
      child.on("exit", (code) => {
        this.port = null;
        this.error = `owner service exited (${code})`;
        this.log(this.error);
        res();
        if (code !== 0 || this.env.FLOW_OWNER_RESTART !== "0") setTimeout(() => void this.start(), 5000);
      });
    });
  }

  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: T }> {
    if (!this.port) return { status: 503, body: { error: this.error ?? "owner service is not running" } as T };
    const r = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(600_000),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
  }
}

export class DaemonProcess {
  child: ChildProcess | null = null;
  uiToken: string | null = null;
  exited = false;
  private onToken: ((t: string) => void) | null = null;
  private stopping = false;
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly log: (m: string) => void,
    private readonly args: string[],
  ) {}

  /** Start and resolve with the ui token the daemon writes to fd 3. */
  start(): Promise<string> {
    const env = { ...withoutOwnerCredentials(this.env), ATE_APPROVAL_CODE_FD: "3", ATE_APPROVAL_STDIN: "1" };
    const child = spawn(process.execPath, [this.env.FLOW_DAEMON_BIN ?? appBin("daemon"), "start", "--setup", ...this.args], { env, stdio: ["pipe", "inherit", "inherit", "pipe"] });
    this.child = child;
    this.exited = false;
    this.uiToken = null;
    const p = new Promise<string>((res) => (this.onToken = res));
    createInterface({ input: child.stdio[3] as NodeJS.ReadableStream }).on("line", (l) => {
      try {
        const j = JSON.parse(l) as { type?: string; token?: string };
        if (j.type === "ui.token" && j.token) {
          this.uiToken = j.token;
          this.onToken?.(j.token);
        }
      } catch {
        /* ignore */
      }
    });
    child.on("exit", (code) => {
      this.exited = true;
      this.log(`daemon exited (${code})`);
      if (!this.stopping) setTimeout(() => void this.start().then((t) => this.restarted?.(t)), 5000);
    });
    return p;
  }

  restarted: ((token: string) => void) | null = null;

  async restart(): Promise<string> {
    await this.stop();
    const t = await this.start();
    return t;
  }

  stop(): Promise<void> {
    const c = this.child;
    if (!c || this.exited) return Promise.resolve();
    this.stopping = true;
    return new Promise((r) => {
      c.once("exit", () => {
        this.stopping = false;
        r();
      });
      c.kill("SIGTERM");
      setTimeout(() => c.kill("SIGKILL"), 10_000);
    });
  }
}

export const homeDir = (env: NodeJS.ProcessEnv) => env.ATE_HOME ?? join(process.cwd(), ".flow-home");
