// Daemon lifecycle (lane D2): the app starts, stops and restarts `ate-daemon` itself, so no step needs a terminal.
// The child gets an extra pipe (fd 3) that carries its one-time approval codes to this process only (never a log),
// and a stdin pipe for `approval-fallback enable`. If a daemon is already running for this ATE_HOME (started by
// hand), the app attaches to it instead and leaves its lifecycle alone.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { RuntimeJson } from "@ate/core";

export interface CodeLine {
  code: string | null;
  line: string;
  at: number;
}

export function ateHome(): string {
  return process.env.ATE_HOME ?? join(homedir(), ".ate");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readRuntime(home = ateHome()): RuntimeJson | null {
  try {
    const rt = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")) as RuntimeJson;
    return alive(rt.pid) ? rt : null;
  } catch {
    return null;
  }
}

/** The daemon needs the system Node (better-sqlite3 is built for it, not for Electron's ABI). */
export function findNode(): string | null {
  if (process.env.ATE_NODE && existsSync(process.env.ATE_NODE)) return process.env.ATE_NODE;
  const dirs = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".volta/bin")];
  const nvm = join(homedir(), ".nvm/versions/node");
  if (existsSync(nvm)) {
    try {
      const vs = readdirSync(nvm).sort().reverse();
      for (const v of vs) dirs.push(join(nvm, v, "bin"));
    } catch {
      /* ignore */
    }
  }
  for (const d of dirs) if (d && existsSync(join(d, "node"))) return join(d, "node");
  return null;
}

export function daemonBin(appPath: string): string {
  return process.env.ATE_DAEMON_BIN ?? resolve(appPath, "../daemon/dist/bin.js");
}

export class DaemonSupervisor {
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  readonly codes: CodeLine[] = [];
  private codeWaiters: ((c: CodeLine) => void)[] = [];
  owned = false;
  lastError = "";

  constructor(
    private readonly appPath: string,
    private readonly onExit: (code: number | null) => void,
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? readRuntime()?.pid ?? null;
  }
  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  /** Next code line the daemon writes (resolves on the first code issued after this call). */
  nextCode(timeoutMs = 8000): Promise<CodeLine | null> {
    return new Promise((res) => {
      const t = setTimeout(() => {
        this.codeWaiters = this.codeWaiters.filter((w) => w !== f);
        res(null);
      }, timeoutMs);
      const f = (c: CodeLine) => {
        clearTimeout(t);
        res(c);
      };
      this.codeWaiters.push(f);
    });
  }

  /** `approval-fallback enable` on the daemon's stdin (only for a daemon we spawned). */
  enableFallback(): boolean {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write("approval-fallback enable\n");
    return true;
  }

  /** Start ours, or adopt one already running for this home. Resolves once runtime.json names a live pid. */
  async start(): Promise<RuntimeJson> {
    const home = ateHome();
    const existing = readRuntime(home);
    if (existing && (!this.child || existing.pid !== this.child.pid)) {
      this.owned = false;
      return existing;
    }
    if (this.running) return this.waitRuntime(this.child!.pid!);
    const node = findNode();
    if (!node) throw new Error("Node.js not found (set ATE_NODE)");
    const bin = daemonBin(this.appPath);
    if (!existsSync(bin)) throw new Error(`daemon not built: ${bin}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    rmSync(join(home, "runtime.json"), { force: true });
    this.log = createWriteStream(join(home, "daemon.log"), { flags: "a", mode: 0o600 });
    const args = [bin, "start", "--setup", "--approval-fallback=armed", ...(process.env.ATE_DAEMON_ARGS ?? "").split(" ").filter(Boolean)];
    const env = { ...process.env, ATE_HOME: home, ATE_APPROVAL_CODE_FD: "3", ATE_APPROVAL_STDIN: "1", ELECTRON_RUN_AS_NODE: undefined };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(node, args, { cwd: resolve(this.appPath, "../.."), env, stdio: ["pipe", "pipe", "pipe", "pipe"], detached: false });
    this.child = child;
    this.owned = true;
    child.stdout?.pipe(this.log, { end: false });
    child.stderr?.on("data", (b: Buffer) => {
      this.log?.write(b);
      const s = b.toString().trim().split("\n").pop() ?? "";
      if (/error|fail/i.test(s)) this.lastError = s.slice(0, 300);
    });
    const fd3 = child.stdio[3] as NodeJS.ReadableStream | undefined;
    if (fd3) {
      createInterface({ input: fd3 }).on("line", (l) => {
        try {
          const j = JSON.parse(l) as { line: string; code: string | null };
          const c = { code: j.code, line: j.line, at: Math.floor(Date.now() / 1000) };
          this.codes.push(c);
          if (this.codes.length > 20) this.codes.shift();
          if (c.code) for (const w of this.codeWaiters.splice(0)) w(c);
        } catch {
          /* ignore */
        }
      });
    }
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      this.log?.end();
      this.onExit(code);
    });
    return this.waitRuntime(child.pid!);
  }

  private async waitRuntime(pid: number, timeoutMs = 45_000): Promise<RuntimeJson> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const rt = readRuntime();
      if (rt && rt.pid === pid) return rt;
      if (this.child?.pid === pid && this.child.exitCode !== null) throw new Error(`daemon exited (${this.child.exitCode}): ${this.lastError}`);
      if (!this.child && this.owned) throw new Error(`daemon exited: ${this.lastError}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("daemon did not come up within 45 s");
  }

  async stop(): Promise<void> {
    const c = this.child;
    if (!c) return;
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        c.kill("SIGKILL");
        res();
      }, 8000);
      c.once("exit", () => {
        clearTimeout(t);
        res();
      });
      c.kill("SIGTERM");
    });
    rmSync(join(ateHome(), "runtime.json"), { force: true });
  }

  async restart(): Promise<RuntimeJson> {
    if (!this.owned) throw new Error("this daemon was started outside the app; restart it there");
    await this.stop();
    return this.start();
  }
}
