// The owner service: plans an owner op, asks for the user's approval when the op raises risk, verifies that approval
// itself, then signs and sends with the owner signer. It is reachable only by its supervisor (Electron main on the
// desktop, the cloud gateway) with a bearer token the agent runtime never receives.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPayload, encodePayload, renderReason, type ConfigApproval } from "@ate/approve";
import { formatEther, isAddress, type Address, type Hex } from "viem";
import { challengeFor, type ApprovalInput, type Approver } from "./approvals.js";
import type { Deployment, OwnerChain, VaultState } from "./chain.js";
import { MARKET_OF } from "./chain.js";
import { DEFAULT_LIMITS, OP_NAMES, OwnerError, diffLimits, limitsJson, parseLimits, type OwnerOp } from "./ops.js";

export const APPROVAL_TTL_SEC = 120;

export interface Plan {
  op: OwnerOp;
  raisesRisk: boolean;
  changes: { key: string; before: unknown; after: unknown }[];
  summary: string;
}

export type OpResult =
  | { done: true; op: OwnerOp["op"]; approvedBy: "touch-id" | "passkey" | null; txs: { label: string; hash: Hex }[]; result?: unknown }
  | { needsApproval: true; nonce: string; expiresAt: number; payload: string; challenge: string; prompt: string; changes: Plan["changes"] };

type ChainLike = Pick<OwnerChain, "address" | "vault" | "call" | "send" | "deploy" | "seed" | "balance"> & { dep: Deployment };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const addr = (x: unknown, what: string): Address => {
  if (typeof x !== "string" || !isAddress(x)) throw new OwnerError(400, `${what} must be an address`);
  return x;
};

export class OwnerService {
  private pending = new Map<string, { payload: ConfigApproval; run: (by: "touch-id" | "passkey") => Promise<OpResult> }>();
  constructor(
    private readonly o: { chain: ChainLike; approver: Approver; home: string; env?: NodeJS.ProcessEnv; log?: (m: string) => void; now?: () => number },
  ) {}

  private now() {
    return this.o.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Vaults this owner manages: the base deployment's plus every vault it deployed. */
  knownVaults(): { market: string; address: Address }[] {
    const st = this.readState();
    const base = Object.entries(this.o.chain.dep.markets).map(([market, m]) => ({ market, address: m.vault as Address }));
    const all = [...st.deployed.flatMap((d) => d.vaults.map((v) => ({ market: v.market, address: v.vault }))), ...base];
    return all.filter((v, i) => all.findIndex((w) => w.address.toLowerCase() === v.address.toLowerCase()) === i);
  }

  private statePath() {
    return join(this.o.home, "owner-state.json");
  }
  readState(): { deployed: { at: number; vaults: { market: string; vault: Address; adapter: Address }[]; txs: { label: string; hash: Hex }[] }[]; partial?: { market: string; vault?: Address; adapter?: Address }[] } {
    try {
      return existsSync(this.statePath()) ? JSON.parse(readFileSync(this.statePath(), "utf8")) : { deployed: [] };
    } catch {
      return { deployed: [] };
    }
  }
  private writeState(s: ReturnType<OwnerService["readState"]>) {
    mkdirSync(this.o.home, { recursive: true, mode: 0o700 });
    writeFileSync(this.statePath(), JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  async state() {
    const c = this.o.chain;
    const vaults = await Promise.all(
      this.knownVaults().map(async (v) => {
        try {
          const s = await c.vault(v.address, v.market);
          return { ...s, limits: limitsJson(s.limits), ownedByUs: s.owner.toLowerCase() === c.address.toLowerCase() };
        } catch (e) {
          return { market: v.market, address: v.address, error: (e as Error).message.split("\n")[0] };
        }
      }),
    );
    const bal = await c.balance().catch(() => null);
    return {
      chainId: c.dep.chainId,
      owner: c.address,
      gasHsk: bal === null ? null : formatEther(bal),
      vaults,
      latestDeploy: this.readState().deployed.at(-1) ?? null,
      approvals: this.o.approver.methods,
      defaults: limitsJson(DEFAULT_LIMITS),
    };
  }

  /** Our vaults among `x` ("all" / missing → every known vault we own). */
  private async ownVaults(x: unknown): Promise<VaultState[]> {
    const want = x === undefined || x === "all" ? this.knownVaults().map((v) => v.address) : Array.isArray(x) ? x.map((a) => addr(a, "vault")) : [addr(x, "vault")];
    const known = this.knownVaults();
    const out: VaultState[] = [];
    for (const a of want) {
      const s = await this.o.chain.vault(a, known.find((k) => k.address.toLowerCase() === a.toLowerCase())?.market ?? null).catch(() => null);
      if (s && s.owner.toLowerCase() === this.o.chain.address.toLowerCase()) out.push(s);
      else if (x !== undefined && x !== "all") throw new OwnerError(403, `${a} is not a vault this owner controls`);
    }
    if (!out.length) throw new OwnerError(404, "no vault owned by this owner key");
    return out;
  }

  async plan(body: unknown): Promise<Plan> {
    const b = (body ?? {}) as Record<string, unknown>;
    const op = b.op;
    if (typeof op !== "string" || !(OP_NAMES as readonly string[]).includes(op)) throw new OwnerError(400, `op must be one of ${OP_NAMES.join(", ")}`);
    switch (op) {
      case "deploy": {
        const markets = (Array.isArray(b.markets) ? b.markets : ["hsk", "btc"]).filter((m): m is "hsk" | "btc" => m === "hsk" || m === "btc");
        if (!markets.length) throw new OwnerError(400, "markets: hsk and/or btc");
        const limits = b.limits === undefined ? DEFAULT_LIMITS : parseLimits(b.limits);
        const agent = addr(b.agent, "agent");
        const guardian = b.guardian === undefined ? undefined : addr(b.guardian, "guardian");
        const looser = diffLimits(DEFAULT_LIMITS, limits).filter((c) => c.raisesRisk);
        const seed = b.seed === true && this.o.chain.dep.chainId === 133;
        return {
          op: { op: "deploy", markets, agent, ...(guardian ? { guardian } : {}), limits, seed },
          raisesRisk: looser.length > 0,
          changes: looser.map((c) => ({ key: `new vaults ${c.field}`, before: c.before, after: c.after })),
          summary: `Create ${markets.length === 2 ? "two vaults" : "a vault"} (${markets.map((m) => m.toUpperCase()).join(", ")}) for agent ${short(agent)}${seed ? " and fill them with test tokens" : ""}`,
        };
      }
      case "setLimits": {
        const limits = parseLimits(b.limits);
        const vs = await this.ownVaults(b.vaults);
        const changes: Plan["changes"] = [];
        let risk = false;
        for (const v of vs) {
          for (const c of diffLimits(v.limits, limits)) {
            risk ||= c.raisesRisk;
            changes.push({ key: `${v.market ? (v.market.includes("WBTC") ? "BTC" : "HSK") : short(v.address)} ${c.field}`, before: c.before, after: c.after });
          }
        }
        if (!changes.length) throw new OwnerError(409, "these limits are already on the vaults");
        return { op: { op: "setLimits", vaults: vs.map((v) => v.address), limits }, raisesRisk: risk, changes, summary: risk ? "Raise vault limits" : "Tighten vault limits" };
      }
      case "setAgent":
      case "setGuardian": {
        const role = op === "setAgent" ? "agent" : "guardian";
        const who = addr(b[role], role);
        const vs = await this.ownVaults(b.vaults);
        const changes = vs.filter((v) => v[role].toLowerCase() !== who.toLowerCase()).map((v) => ({ key: `${short(v.address)} ${role}`, before: v[role], after: who }));
        if (!changes.length) throw new OwnerError(409, `the vaults already use this ${role}`);
        const opv = op === "setAgent" ? { op: "setAgent" as const, vaults: vs.map((v) => v.address), agent: who } : { op: "setGuardian" as const, vaults: vs.map((v) => v.address), guardian: who };
        return { op: opv, raisesRisk: true, changes, summary: `New ${role} ${short(who)}` };
      }
      case "pause":
      case "unpause": {
        const vs = (await this.ownVaults(b.vaults)).filter((v) => v.paused === (op === "unpause"));
        if (!vs.length) throw new OwnerError(409, `the vaults are already ${op === "pause" ? "paused" : "running"}`);
        return {
          op: { op, vaults: vs.map((v) => v.address) },
          raisesRisk: op === "unpause",
          changes: vs.map((v) => ({ key: `${short(v.address)} paused`, before: v.paused, after: op === "pause" })),
          summary: op === "pause" ? "Pause the vaults" : "Let the agent trade again",
        };
      }
      case "withdraw": {
        const [v] = await this.ownVaults(b.vault);
        const token = addr(b.token, "token");
        if (typeof b.amount !== "string" || !/^[0-9]{1,40}$/.test(b.amount)) throw new OwnerError(400, "amount: integer string in the token's smallest unit");
        const to = b.to === undefined ? this.o.chain.address : addr(b.to, "to");
        return {
          op: { op: "withdraw", vault: v!.address, token, amount: BigInt(b.amount), to },
          raisesRisk: true,
          changes: [{ key: `withdraw from ${short(v!.address)}`, before: `token ${short(token)}`, after: `${b.amount} to ${short(to)}` }],
          summary: `Withdraw to ${short(to)}`,
        };
      }
      case "fundAgent": {
        const agent = addr(b.agent, "agent");
        if (typeof b.wei !== "string" || !/^[0-9]{1,30}$/.test(b.wei) || BigInt(b.wei) === 0n) throw new OwnerError(400, "wei: positive integer string");
        return { op: { op: "fundAgent", agent, wei: BigInt(b.wei) }, raisesRisk: true, changes: [{ key: `gas to agent ${short(agent)}`, before: "0", after: `${formatEther(BigInt(b.wei))} HSK` }], summary: "Send gas to the agent" };
      }
      case "seed": {
        if (this.o.chain.dep.chainId !== 133) throw new OwnerError(403, "seeding with test tokens is testnet only");
        const vs = await this.ownVaults(b.vaults);
        return { op: { op: "seed", vaults: vs.map((v) => v.address) }, raisesRisk: false, changes: [], summary: "Fill the vaults with test tokens" };
      }
    }
    throw new OwnerError(400, "unknown op");
  }

  /** Step 1 (`{ op, … }`) or step 2 (`{ nonce, approval }`). */
  async request(body: unknown): Promise<OpResult> {
    const b = (body ?? {}) as { nonce?: unknown; approval?: ApprovalInput };
    if (typeof b.nonce === "string") return this.redeem(b.nonce, b.approval);
    const plan = await this.plan(body);
    if (!plan.raisesRisk) return this.execute(plan, null);
    return this.ask(plan.summary, plan.changes, (by) => this.execute(plan, by));
  }

  /** Register a passkey for approvals: the first freely, later ones with an approval from a registered one. */
  async addPasskey(body: unknown): Promise<OpResult | { added: true; passkeys: number }> {
    const b = (body ?? {}) as { nonce?: unknown; approval?: ApprovalInput; id?: unknown; publicKey?: unknown; counter?: unknown; transports?: unknown };
    if (typeof b.nonce === "string") return this.redeem(b.nonce, b.approval);
    if (typeof b.id !== "string" || typeof b.publicKey !== "string") throw new OwnerError(400, "id and publicKey (base64url) required");
    const k = { id: b.id, publicKey: b.publicKey, counter: typeof b.counter === "number" ? b.counter : 0, ...(Array.isArray(b.transports) ? { transports: b.transports.map(String).slice(0, 6) } : {}) };
    if (!this.o.approver.passkeys().length) {
      this.o.approver.addPasskey(k, false);
      return { added: true, passkeys: 1 };
    }
    if (this.o.approver.passkeys().some((x) => x.id === k.id)) return { added: true, passkeys: this.o.approver.passkeys().length };
    return this.ask("Add a passkey that can approve owner actions", [{ key: "passkey", before: null, after: `${k.id.slice(0, 10)}…` }], async (by) => {
      this.o.approver.addPasskey(k, true);
      return { done: true, op: "seed", approvedBy: by, txs: [], result: { added: true } } as OpResult;
    });
  }

  private ask(summary: string, changes: Plan["changes"], run: (by: "touch-id" | "passkey") => Promise<OpResult>): OpResult {
    const nonce = randomBytes(16).toString("base64url");
    const expiresAt = this.now() + APPROVAL_TTL_SEC;
    const payload = configPayload({ nonce, expiresAt, changes: [{ key: "owner action", before: null, after: summary }, ...changes] });
    for (const [k, v] of this.pending) if (v.payload.expiresAt < this.now()) this.pending.delete(k);
    this.pending.set(nonce, { payload, run });
    return { needsApproval: true, nonce, expiresAt, payload: encodePayload(payload), challenge: challengeFor(payload), prompt: renderReason(payload), changes };
  }

  private async redeem(nonce: string, approval: ApprovalInput | undefined): Promise<OpResult> {
    const p = this.pending.get(nonce);
    if (!p || p.payload.expiresAt < this.now()) throw new OwnerError(410, "this approval request expired; start again");
    const by = await this.o.approver.verify(p.payload, approval);
    this.pending.delete(nonce);
    return p.run(by);
  }

  /** Owner txs run one op at a time, in order (with the chain-side nonce manager in OwnerChain.submit). */
  private queue: Promise<unknown> = Promise.resolve();
  private execute(plan: Plan, approvedBy: "touch-id" | "passkey" | null): Promise<OpResult> {
    const p = this.queue.then(() => this.executeNow(plan, approvedBy));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async executeNow(plan: Plan, approvedBy: "touch-id" | "passkey" | null): Promise<OpResult> {
    const c = this.o.chain;
    const op = plan.op;
    this.o.log?.(`owner: ${op.op}${approvedBy ? ` (approved by ${approvedBy})` : ""}`);
    try {
      const txs: { label: string; hash: Hex }[] = [];
      let result: unknown;
      switch (op.op) {
        case "deploy": {
          // An interrupted deploy is resumed: contracts already created are reused, settings already applied skipped.
          const prior = this.readState().partial ?? [];
          const d = await c.deploy({
            markets: op.markets,
            agent: op.agent,
            ...(op.guardian ? { guardian: op.guardian } : {}),
            limits: op.limits ?? DEFAULT_LIMITS,
            ...(this.o.env ? { env: this.o.env } : {}),
            prior,
            onStep: (p) => {
              const st = this.readState();
              st.partial = [...(st.partial ?? []).filter((x) => x.market !== p.market), p];
              this.writeState(st);
            },
          });
          txs.push(...d.txs);
          const st = this.readState();
          st.deployed.push({ at: this.now(), vaults: d.vaults, txs: d.txs });
          delete st.partial;
          this.writeState(st);
          if (op.seed) txs.push(...(await c.seed(d.vaults)));
          result = { vaults: d.vaults.map((v) => ({ market: v.market, address: v.vault, adapter: v.adapter })) };
          break;
        }
        case "setLimits":
          for (const v of op.vaults) txs.push(await c.call(`limits ${short(v)}`, v, "setLimits", [op.limits]));
          break;
        case "setAgent":
          for (const v of op.vaults) txs.push(await c.call(`agent ${short(v)}`, v, "setAgent", [op.agent]));
          break;
        case "setGuardian":
          for (const v of op.vaults) txs.push(await c.call(`guardian ${short(v)}`, v, "setGuardian", [op.guardian]));
          break;
        case "pause":
        case "unpause":
          for (const v of op.vaults) txs.push(await c.call(`${op.op} ${short(v)}`, v, op.op));
          break;
        case "withdraw":
          txs.push(await c.call(`withdraw ${short(op.vault)}`, op.vault, "withdraw", [op.token, op.to, op.amount]));
          break;
        case "fundAgent":
          txs.push(await c.send("gas to agent", op.agent, "0x", op.wei));
          break;
        case "seed": {
          const known = this.knownVaults();
          txs.push(...(await c.seed(op.vaults.map((v) => ({ vault: v, market: known.find((k) => k.address.toLowerCase() === v.toLowerCase())?.market ?? "" })))));
          break;
        }
      }
      return { done: true, op: op.op, approvedBy, txs, ...(result !== undefined ? { result } : {}) };
    } finally {
      /* queue continues */
    }
  }
}

export { MARKET_OF };
