// CLIProxyAPI sidecar (Flow v1 default engine): the daemon finds the user's CLIProxyAPI binary or installs the official
// release (github.com/router-for-me/CLIProxyAPI, checksum-verified, into <home>/bin), writes a minimal config bound to
// 127.0.0.1 with a generated client key and management key (both in the keychain), starts / stops / restarts it and
// health-checks it through /v1/models. Sign-in to the subscriptions happens in the user's terminal with the binary's
// own login flags; Flow never sees those credentials. No request "cloaking" keys are written: the proxy's defaults apply.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { ProviderKeys } from "./providers.js";

export const RELEASES_API = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";
const NAMES = ["cli-proxy-api", "cliproxyapi", "CLIProxyAPI", "cli_proxy_api"];
const DEFAULT_PORT = 8317;

export interface SidecarStatus {
  installed: boolean;
  bin: string | null;
  /** "flow" = installed by Flow into <home>/bin; "user" = found on this Mac. */
  source: "flow" | "user" | null;
  version: string | null;
  running: boolean;
  owned: boolean;
  pid: number | null;
  port: number;
  baseURL: string;
  healthy: boolean;
  /** Models the signed-in subscriptions expose (empty until the user signs in). */
  models: string[];
  lastError: string | null;
  checkedAt: number | null;
  /** Login flags the installed binary offers (from its --help), e.g. --claude-login. */
  loginFlags: string[];
}

interface State {
  bin?: string;
  version?: string;
  port?: number;
}

type Fetch = typeof fetch;

/** Release asset name suffix for this platform (darwin arm64 is "aarch64" in CLIProxyAPI's release names). */
export function assetSuffix(platform = process.platform, arch = process.arch): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : platform;
  const a = arch === "arm64" ? "aarch64" : arch === "x64" ? "amd64" : arch;
  return `_${os}_${a}.${platform === "win32" ? "zip" : "tar.gz"}`;
}

/** Minimal config: loopback only, generated keys, management localhost-only. Nothing else (proxy defaults). */
export function configYaml(o: { port: number; apiKey: string; mgmtKey: string }): string {
  return [
    "# Written by Flow. Loopback only; keys are generated and kept in the macOS keychain.",
    "server:",
    `  host: "127.0.0.1"`,
    `  port: ${o.port}`,
    "access:",
    "  api-keys:",
    `    - "${o.apiKey}"`,
    "management:",
    `  secret-key: "${o.mgmtKey}"`,
    "  allow-remote: false",
    "",
  ].join("\n");
}

export class ProxySidecar {
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private st: { healthy: boolean; models: string[]; lastError: string | null; checkedAt: number | null } = { healthy: false, models: [], lastError: null, checkedAt: null };
  private readonly dir: string;
  private readonly stateFile: string;

  constructor(
    private readonly home: string,
    private readonly keys: ProviderKeys,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.dir = join(home, "cliproxy");
    this.stateFile = join(home, "cliproxy", "sidecar.json");
  }

  private state(): State {
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as State;
    } catch {
      return {};
    }
  }
  private save(s: State) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.stateFile, JSON.stringify({ ...this.state(), ...s }, null, 2), { mode: 0o600 });
  }
  get port(): number {
    return this.state().port ?? DEFAULT_PORT;
  }
  get baseURL(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /** The client key the engine sends to the proxy (generated once, keychain). */
  apiKey(): string {
    let k = this.keys.load("subscription");
    if (!k) {
      k = `flow-${randomBytes(24).toString("base64url")}`;
      this.keys.save("subscription", k);
    }
    return k;
  }
  private mgmtKey(): string {
    let k = this.keys.load("subscription-mgmt");
    if (!k) {
      k = `flow-mgmt-${randomBytes(24).toString("base64url")}`;
      this.keys.save("subscription-mgmt", k);
    }
    return k;
  }

  /** Flow-installed binary, then ATE_CLIPROXY_BIN, then PATH and the usual install dirs. */
  detect(): { bin: string; source: "flow" | "user" } | null {
    const s = this.state();
    if (s.bin && existsSync(s.bin)) return { bin: s.bin, source: s.bin.startsWith(join(this.home, "bin")) ? "flow" : "user" };
    if (this.env.ATE_CLIPROXY_BIN && existsSync(this.env.ATE_CLIPROXY_BIN)) return { bin: this.env.ATE_CLIPROXY_BIN, source: "user" };
    const dirs = [...(this.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), join(homedir(), "go/bin")];
    for (const d of dirs) for (const n of NAMES) if (d && existsSync(join(d, n))) return { bin: join(d, n), source: "user" };
    return null;
  }

  private help(bin: string): string {
    try {
      return execFileSync(bin, ["--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string };
      return `${x.stdout ?? ""}${x.stderr ?? ""}`; // Go flag prints usage to stderr and exits 2
    }
  }
  loginFlags(bin = this.detect()?.bin): string[] {
    if (!bin) return [];
    return [...new Set([...this.help(bin).matchAll(/(?:^|\s)(--?(?:[a-z][a-z0-9-]*-)?login)\b/gm)].map((m) => m[1]!.replace(/^-(?!-)/, "--")))];
  }
  private configFlag(bin: string): string {
    return /(^|\s)--config\b/m.test(this.help(bin)) ? "--config" : "-config";
  }

  /**
   * One-click install: latest official release for this platform, sha256 checked against the release's checksums.txt,
   * unpacked into <home>/bin/cliproxyapi-<version>/. Never runs anything it did not verify.
   */
  async install(): Promise<SidecarStatus> {
    const gh = { headers: { accept: "application/vnd.github+json", "user-agent": "flow-daemon" }, signal: AbortSignal.timeout(30_000) };
    const rel = (await (await this.fetchImpl(RELEASES_API, gh)).json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
    const suffix = assetSuffix();
    const asset = rel.assets?.find((a) => a.name.endsWith(suffix) && !a.name.includes("no-plugin"));
    const sums = rel.assets?.find((a) => a.name === "checksums.txt");
    if (!rel.tag_name || !asset || !sums) throw Object.assign(new Error(`no CLIProxyAPI release asset for this platform (${suffix})`), { status: 502, code: "ATE_INTERNAL" });
    const sumsText = await (await this.fetchImpl(sums.browser_download_url, { signal: AbortSignal.timeout(30_000) })).text();
    const want = sumsText
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .find((p) => p[1] === asset.name)?.[0]
      ?.toLowerCase();
    if (!want || !/^[0-9a-f]{64}$/.test(want)) throw Object.assign(new Error(`checksums.txt has no entry for ${asset.name}`), { status: 502, code: "ATE_INTERNAL" });
    const buf = Buffer.from(await (await this.fetchImpl(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== want) throw Object.assign(new Error(`checksum mismatch for ${asset.name}: refusing to install`), { status: 502, code: "ATE_INTERNAL" });
    const version = rel.tag_name.replace(/^v/, "");
    const dest = join(this.home, "bin", `cliproxyapi-${version}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    const tmp = join(tmpdir(), `flow-cliproxy-${randomBytes(4).toString("hex")}-${asset.name}`);
    writeFileSync(tmp, buf, { mode: 0o600 });
    try {
      execFileSync("/usr/bin/tar", ["-xzf", tmp, "-C", dest], { stdio: "ignore" });
    } finally {
      rmSync(tmp, { force: true });
    }
    const bin = this.findBin(dest);
    if (!bin) throw Object.assign(new Error("the release archive has no CLIProxyAPI binary"), { status: 502, code: "ATE_INTERNAL" });
    chmodSync(bin, 0o755);
    this.save({ bin, version });
    return this.status();
  }

  private findBin(dir: string): string | null {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const st = statSync(p);
      if (st.isDirectory()) {
        const r = this.findBin(p);
        if (r) return r;
      } else if (NAMES.some((n) => f.toLowerCase() === n.toLowerCase()) || /^cli-?proxy-?api$/i.test(f)) return p;
    }
    return null;
  }

  private async freePort(from: number): Promise<number> {
    for (let p = from; p < from + 10; p++) {
      const ok = await new Promise<boolean>((res) => {
        const srv = createServer();
        srv.once("error", () => res(false));
        srv.listen(p, "127.0.0.1", () => srv.close(() => res(true)));
      });
      if (ok) return p;
    }
    throw Object.assign(new Error("no free local port for the proxy (8317–8326)"), { status: 409, code: "ATE_INTERNAL" });
  }

  async start(): Promise<SidecarStatus> {
    if (this.child && this.child.exitCode === null) return this.check();
    const found = this.detect();
    if (!found) throw Object.assign(new Error("CLIProxyAPI is not installed: install it first"), { status: 409, code: "ATE_CONFIG_INVALID" });
    const port = await this.freePort(this.state().port ?? DEFAULT_PORT);
    this.save({ port, ...(found.source === "user" ? { bin: found.bin } : {}) });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const cfg = join(this.dir, "config.yaml");
    writeFileSync(cfg, configYaml({ port, apiKey: this.apiKey(), mgmtKey: this.mgmtKey() }), { mode: 0o600 });
    this.log?.end();
    this.log = createWriteStream(join(this.dir, "proxy.log"), { flags: "a", mode: 0o600 });
    const child = spawn(found.bin, [this.configFlag(found.bin), cfg], { cwd: this.dir, stdio: ["ignore", "pipe", "pipe"], env: { ...this.env } });
    child.stdout?.pipe(this.log, { end: false });
    child.stderr?.pipe(this.log, { end: false });
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        this.st.healthy = false;
        this.st.lastError = `proxy exited (${code ?? "signal"})`;
      }
    });
    this.child = child;
    // never leave the proxy running without its daemon
    const killOnExit = () => child.exitCode === null && child.kill("SIGTERM");
    process.once("exit", killOnExit);
    child.once("exit", () => process.removeListener("exit", killOnExit));
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const s = await this.check();
      if (s.healthy || !this.child) return s;
    }
    return this.status();
  }

  async stop(): Promise<SidecarStatus> {
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) {
      c.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (c.exitCode === null) c.kill("SIGKILL");
    }
    this.st.healthy = false;
    return this.status();
  }
  async restart(): Promise<SidecarStatus> {
    await this.stop();
    return this.start();
  }

  /** Health: GET /v1/models with the client key. 200 = up; the model list says which subscriptions are signed in. */
  async check(): Promise<SidecarStatus> {
    try {
      const r = await this.fetchImpl(`${this.baseURL}/models`, { headers: { authorization: `Bearer ${this.apiKey()}` }, signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`proxy answered HTTP ${r.status}`);
      const j = (await r.json()) as { data?: { id: string }[] };
      this.st = { healthy: true, models: (j.data ?? []).map((m) => m.id), lastError: null, checkedAt: Math.floor(Date.now() / 1000) };
    } catch (e) {
      this.st = { ...this.st, healthy: false, lastError: (e as Error).message.split("\n")[0]!, checkedAt: Math.floor(Date.now() / 1000) };
    }
    return this.status();
  }

  /** Up and signed in to at least one subscription (no process spawn: cached from the last check). */
  get ready(): boolean {
    return this.st.healthy && this.st.models.length > 0;
  }

  status(): SidecarStatus {
    const found = this.detect();
    const s = this.state();
    return {
      installed: !!found,
      bin: found?.bin ?? null,
      source: found?.source ?? null,
      version: s.version ?? null,
      running: !!this.child && this.child.exitCode === null,
      owned: !!this.child,
      pid: this.child?.pid ?? null,
      port: this.port,
      baseURL: this.baseURL,
      healthy: this.st.healthy,
      models: this.st.models,
      lastError: this.st.lastError,
      checkedAt: this.st.checkedAt,
      loginFlags: found ? this.loginFlags(found.bin) : [],
    };
  }
}

/** Best model from a subscription's list: Claude Opus → Sonnet, then the GPT-5 family, then Gemini Pro. Newest first. */
export function bestModel(ids: readonly string[]): string | null {
  const ver = (id: string) => (id.match(/\d+(?:[.-]\d+)*/g) ?? []).join(".");
  const newest = (xs: string[]) => [...xs].sort((a, b) => ver(b).localeCompare(ver(a), undefined, { numeric: true }))[0] ?? null;
  for (const re of [/claude.*opus/i, /claude.*sonnet/i, /^gpt-5(?!.*(mini|nano))/i, /^gpt-5/i, /gemini.*pro/i]) {
    const m = newest(ids.filter((x) => re.test(x)));
    if (m) return m;
  }
  return ids[0] ?? null;
}
