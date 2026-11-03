// Desktop owner service (FREEZE-NOTES CLOUD): Flow manages the owner key so nothing is signed by hand. The key is
// sealed for the owner role in <home>/owner/owner-keys/owner.json; its secret is a separate login-keychain item
// (`flow/owner-key-secret`), never the agent's. Main runs `flow-owner serve` as its own process and is the only holder
// of its bearer token; the daemon never sees either. Risk-raising ops come back as a payload that ate-approve signs
// after Touch ID; the owner service verifies that signature itself against the pinned approval key.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { decodePayload } from "@ate/approve";
import type { Res } from "../shared/bridge";
import type { DaemonClient } from "./daemon";
import { signApproval } from "./approve";
import { ateHome, BACKEND, backendCwd, backendEnv, findNode } from "./lifecycle";

const KC_SERVICE = "flow/owner-key-secret";
/** One keychain item per app home, so a second home (tests, demos) never overwrites another home's owner secret. */
const kcAccount = (home: string) => `flow-owner:${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16)}`;
const err = (message: string, code = "ATE_INTERNAL"): Res<never> => ({ ok: false, error: { code: code as never, message } });

function readSecret(home: string): string | null {
  if (process.platform === "darwin") {
    try {
      return execFileSync("/usr/bin/security", ["find-generic-password", "-a", kcAccount(home), "-s", KC_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  }
  const p = join(home, "owner", "secret");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}

function writeSecret(home: string, s: string): void {
  if (process.platform === "darwin") {
    execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-a", kcAccount(home), "-s", KC_SERVICE, "-w", s], { stdio: "ignore" });
    return;
  }
  mkdirSync(join(home, "owner"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "owner", "secret"), s, { mode: 0o600 });
}

export class DesktopOwner {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private token = randomBytes(32).toString("base64url");
  private starting: Promise<void> | null = null;
  address: string | null = null;
  lastError: string | null = null;

  constructor(
    private readonly appPath: string,
    private readonly daemon: DaemonClient,
    private readonly restartDaemon: () => Promise<unknown>,
  ) {}

  private bin() {
    return process.env.FLOW_OWNER_BIN ?? (BACKEND ? join(BACKEND, "owner", "bin.js") : resolve(this.appPath, "../owner/dist/bin.js"));
  }

  /** Creates the owner key on first use (sealed blob + keychain secret), then starts the service. */
  private async ensure(): Promise<void> {
    if (this.port) return;
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<void> {
    const home = ateHome();
    const node = findNode();
    if (!node || !existsSync(this.bin())) throw new Error("the owner service is not built (apps/owner)");
    let secret = readSecret(home);
    const blob = join(home, "owner", "owner-keys", "owner.json");
    if (!existsSync(blob) || !secret) {
      secret = randomBytes(32).toString("base64url");
      const sealed = await new Promise<string>((res, rej) => {
        const c = spawn(node, [this.bin(), "seal"], { cwd: backendCwd(this.appPath), env: backendEnv({ ...process.env, ATE_OWNER_KEY_ID: "owner" }), stdio: ["pipe", "pipe", "inherit"] });
        let out = "";
        c.stdout!.on("data", (d) => (out += d));
        c.on("exit", (code) => (code === 0 ? res(out.trim()) : rej(new Error("could not create the owner key"))));
        c.stdin!.end(`${JSON.stringify({ privateKey: `0x${randomBytes(32).toString("hex")}`, secret })}\n`);
      });
      mkdirSync(join(home, "owner", "owner-keys"), { recursive: true, mode: 0o700 });
      writeFileSync(blob, sealed, { mode: 0o600 });
      writeSecret(home, secret);
    }
    const chainId = (() => {
      try {
        return String((JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { chain: { id: number } }).chain.id);
      } catch {
        return "133";
      }
    })();
    const pin = [join(home, "approve-pubkey.json"), join(homedir(), ".ate", "approve-pubkey.json")].find((p) => existsSync(p));
    const env: NodeJS.ProcessEnv = { ...process.env, ATE_HOME: home, ATE_OWNER_KEY_ID: "owner", ATE_OWNER_KEY_SECRET: secret, FLOW_OWNER_STDIN: "1", FLOW_CHAIN_ID: chainId, ...(pin ? { ATE_APPROVE_PUBKEY: pin } : {}) };
    backendEnv(env);
    for (const k of Object.keys(env)) if (k.startsWith("ATE_AGENT_")) delete env[k];
    const child = spawn(node, [this.bin(), "serve"], { cwd: backendCwd(this.appPath), env, stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;
    child.stdin!.end(`${JSON.stringify({ token: this.token })}\n`);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("the owner service did not start")), 20_000);
      createInterface({ input: child.stdout! }).on("line", (l) => {
        try {
          const j = JSON.parse(l) as { type?: string; port?: number; owner?: string };
          if (j.type === "owner.ready") {
            clearTimeout(t);
            this.port = j.port ?? null;
            this.address = j.owner ?? null;
            res();
          }
        } catch {
          /* not ours */
        }
      });
      child.on("exit", (code) => {
        this.port = null;
        this.lastError = `owner service exited (${code})`;
        clearTimeout(t);
        rej(new Error(this.lastError));
      });
    });
  }

  stop() {
    this.child?.kill("SIGTERM");
    this.port = null;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: T }> {
    await this.ensure();
    const r = await fetch(`http://127.0.0.1:${this.port}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(600_000) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
  }

  /** Step 1, then (on 428) Touch ID over the owner service's payload, then step 2. */
  private async op(body: Record<string, unknown>): Promise<Res<{ txs: { hash: string }[]; result?: { vaults?: { market: string; address: string }[]; privateKey?: string; address?: string } }>> {
    type Out = { txs?: { hash: string }[]; result?: { vaults?: { market: string; address: string }[]; privateKey?: string; address?: string }; nonce?: string; payload?: string; error?: string };
    try {
      let r = await this.call<Out>("POST", "/owner/op", body);
      if (r.status === 428 && r.body.nonce && r.body.payload) {
        const s = await signApproval(decodePayload(r.body.payload));
        if (!s.ok)
          return err(
            !s.unavailable
              ? `Touch ID: ${s.message}`
              : process.platform === "darwin"
                ? "Touch ID approval (ate-approve) is not set up on this Mac; withdrawing, raising limits, gas top-ups and the key backup need it"
                : "This needs a Touch ID approval, which exists only on macOS. On this computer, do it from Flow on a Mac or in the cloud (passkey).",
            "ATE_APPROVAL_REQUIRED",
          );
        r = await this.call<Out>("POST", "/owner/op", { nonce: r.body.nonce, approval: { signature: s.signature } });
      }
      if (r.status !== 200) return err(r.body.error ?? `owner service HTTP ${r.status}`, r.status === 403 ? "ATE_APPROVAL_REQUIRED" : "ATE_INTERNAL");
      return { ok: true, data: { txs: r.body.txs ?? [], ...(r.body.result ? { result: r.body.result } : {}) } };
    } catch (e) {
      return err((e as Error).message);
    }
  }

  private async vaults(): Promise<string[]> {
    const r = await this.daemon.call<{ vaults: { address: string }[] }>("GET", "/setup/status");
    return r.ok ? r.data.vaults.map((v) => v.address) : [];
  }

  /** Point the daemon's config at `vaults` (other markets keep their vault), restarting it when that changed. */
  private async switchTo(vaults: { market: string; address: string }[]): Promise<Res<{ restarted: boolean }>> {
    const cur = await this.daemon.call<{ vaults: { market: string; address: string }[] }>("GET", "/setup/status");
    const keep = cur.ok ? cur.data.vaults.filter((v) => !vaults.some((n) => n.market === v.market)) : [];
    const sv = await this.daemon.call<{ restart?: boolean }>("POST", "/setup/vaults", { source: "deploy", vaults: [...keep, ...vaults].map((v) => ({ market: v.market, address: v.address })) });
    if (!sv.ok) return sv;
    if (sv.data.restart) await this.restartDaemon();
    return { ok: true, data: { restarted: !!sv.data.restart } };
  }

  /** window.ate.owner (shared/setup-bridge.ts OwnerBridge). */
  readonly api = {
    status: async (): Promise<Res<unknown>> => {
      try {
        const r = await this.call<{ owner: string; chainId: number }>("GET", "/owner/state");
        return r.status === 200 ? { ok: true, data: { ready: true, address: r.body.owner, ...r.body } } : err("owner service unavailable");
      } catch (e) {
        return { ok: true, data: { ready: false, address: this.address, chainId: 0, error: (e as Error).message } };
      }
    },
    /** Every vault this Flow wallet knows (active and earlier), with holdings, limits, paused; plus any unfinished creation. */
    state: async (): Promise<Res<unknown>> => {
      try {
        const [r, cfg] = await Promise.all([this.call<Record<string, unknown>>("GET", "/owner/state"), this.daemon.call<{ vaults: { market: string; address: string }[]; explorer: string }>("GET", "/setup/status")]);
        if (r.status !== 200) return err(String((r.body as { error?: string }).error ?? "owner service unavailable"));
        return { ok: true, data: { ...r.body, active: cfg.ok ? cfg.data.vaults : [], explorer: cfg.ok ? cfg.data.explorer : null } };
      } catch (e) {
        return err((e as Error).message);
      }
    },
    /** One vault read from chain (limits, paused, agent): the read-back after Change limits. */
    vault: async (address: string): Promise<Res<unknown>> => {
      try {
        const r = await this.call<Record<string, unknown>>("GET", `/owner/vault?address=${encodeURIComponent(String(address))}`);
        return r.status === 200 ? { ok: true, data: r.body } : err(String((r.body as { error?: string }).error ?? `owner service HTTP ${r.status}`));
      } catch (e) {
        return err((e as Error).message);
      }
    },
    /** Live progress of the latest vault creation (polled while it runs). */
    job: async (): Promise<Res<unknown>> => {
      try {
        const r = await this.call<{ job: unknown }>("GET", "/owner/job");
        return { ok: true, data: r.body.job ?? null };
      } catch (e) {
        return err((e as Error).message);
      }
    },
    /**
     * Deploy vaults for `markets` with `limits` (default: the §19 defaults; looser ones ask Touch ID first). Setup
     * (`use` true, the default) points the daemon at them at once; Wallet's "Create a new vault" passes `use: false`
     * and switches later with useVault.
     */
    createVaults: async (o?: { markets?: string[]; limits?: Record<string, string | number>; use?: boolean }): Promise<Res<unknown>> => {
      const ag = await this.daemon.call<{ address: string | null }>("GET", "/setup/agent");
      if (!ag.ok || !ag.data.address) return err("create or unlock the agent key first");
      const markets = [...new Set((o?.markets ?? ["hsk", "btc"]).map((m) => (/btc/i.test(String(m)) ? "btc" : "hsk")))];
      // the chain from the daemon's local status: GET /owner/state reads every vault on chain (seconds on a slow RPC)
      const ds = await this.daemon.call<{ chainId: number }>("GET", "/setup/status");
      const chainId = ds.ok ? ds.data.chainId : (await this.call<{ chainId: number }>("GET", "/owner/state")).body.chainId;
      const r = await this.op({ op: "deploy", markets, agent: ag.data.address, seed: chainId === 133, ...(o?.limits ? { limits: o.limits } : {}) });
      if (!r.ok) return r;
      const vaults = r.data.result?.vaults ?? [];
      const seconds = (r.data.result as { seconds?: number } | undefined)?.seconds ?? null;
      const seedError = (r.data.result as { seedError?: string } | undefined)?.seedError ?? null;
      if (o?.use !== false) {
        const u = await this.switchTo(vaults);
        if (!u.ok) return u;
      }
      return { ok: true, data: { txs: r.data.txs.map((t) => t.hash), vaults, seconds, seedError } };
    },
    /** Make `address` the active vault for `market` (config.json), then restart the daemon (the trader resumes). */
    useVault: async (o: { market: string; address: string }): Promise<Res<unknown>> => {
      try {
        const [st, ag] = await Promise.all([this.call<{ vaults: { address: string; market: string | null; agent?: string; ownedByUs?: boolean }[] }>("GET", "/owner/state"), this.daemon.call<{ address: string | null }>("GET", "/setup/agent")]);
        const v = st.body.vaults?.find((x) => x.address.toLowerCase() === String(o?.address).toLowerCase());
        if (!v) return err("Flow does not know this vault");
        if (!v.ownedByUs) return err("this vault is owned by another wallet");
        if (v.market !== o.market) return err("this vault trades another market");
        if (ag.ok && ag.data.address && v.agent?.toLowerCase() !== ag.data.address.toLowerCase()) return err("this vault is connected to a different agent key");
        return await this.switchTo([{ market: o.market, address: v.address }]);
      } catch (e) {
        return err((e as Error).message);
      }
    },
    setAgent: async (agent: string) => this.txs(await this.op({ op: "setAgent", agent: String(agent), vaults: await this.vaults() })),
    /** `o.vaults`: only these vaults (Wallet → Change limits); default every vault in use. Raising asks Touch ID. */
    setLimits: async (limits: unknown, o?: { vaults?: string[] }) => this.txs(await this.op({ op: "setLimits", limits, vaults: o?.vaults?.length ? o.vaults.map(String) : await this.vaults() })),
    unpause: async () => this.txs(await this.op({ op: "unpause", vaults: await this.vaults() })),
    /** Vault → `to` (default: the owner wallet). Amount in the token's smallest unit. Touch ID. */
    withdraw: async (o: { vault: string; token: string; amount: string; to?: string }) => this.txs(await this.op({ op: "withdraw", vault: String(o?.vault), token: String(o?.token), amount: String(o?.amount), ...(o?.to ? { to: String(o.to) } : {}) })),
    /** Owner wallet → agent key, `wei` of HSK for gas. Touch ID. */
    fundAgent: async (wei: string) => {
      const ag = await this.daemon.call<{ address: string | null }>("GET", "/setup/agent");
      if (!ag.ok || !ag.data.address) return err("create or unlock the agent key first");
      return this.txs(await this.op({ op: "fundAgent", agent: ag.data.address, wei: String(wei) }));
    },
    /** Backup: Touch ID, then the owner key once. */
    exportKey: async (): Promise<Res<{ address: string; privateKey: string }>> => {
      const r = await this.op({ op: "exportKey" });
      if (!r.ok) return r;
      const k = r.data.result;
      return k?.privateKey && k.address ? { ok: true, data: { address: k.address, privateKey: k.privateKey } } : err("the owner service returned no key");
    },
  };
  private txs(r: Res<{ txs: { hash: string }[] }>): Res<{ txs: string[] }> {
    return r.ok ? { ok: true, data: { txs: r.data.txs.map((t) => t.hash) } } : r;
  }
}
