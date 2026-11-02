// Flow desktop v1 routes: pending list/reject, chat "sells now" confirmation, proof suite testnet-only gate, trader state.
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "@ate/core/fixtures";
import { createChainClient } from "@ate/chain";
import { Journal, migrate } from "@ate/journal";
import { AgentSigner } from "@ate/wallet";
import { registerAppRoutes } from "../src/app-routes.js";
import { AiEngine } from "../src/engine.js";
import { DaemonHttp, Routes, TokenRegistry } from "../src/http.js";
import { AteService } from "../src/service.js";
import { loadStrategy } from "../src/strategy-stub.js";
import { TxQueue } from "../src/txqueue.js";

let http: DaemonHttp;
let svc: AteService;
const tokens = new TokenRegistry();
const ui = tokens.mint({ scope: "ui" });
const view = tokens.mint({ scope: "view" });
let base = "";

beforeAll(async () => {
  const db = new Database(":memory:");
  migrate(db);
  const chain = createChainClient({ urls: ["http://127.0.0.1:9"], retries: 0 });
  const signer = new AgentSigner(FIXTURE_CONFIG.agentKeyId);
  const txq = new TxQueue({ chain: { pendingNonce: async () => 0, suggestFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), sendRaw: async () => "0x" as const, receipt: async () => null }, account: () => signer.get(), chainId: 177 });
  const strategy = await loadStrategy(() => svc.openProposals());
  svc = new AteService({ cfg: FIXTURE_CONFIG, db, journal: new Journal(db), chain, signer, txq, strategy, candidateTtlSec: 180, version: "test", emit: () => {} });
  const routes = new Routes();
  http = new DaemonHttp({ service: svc, tokens, routes, version: "test" });
  const port = await http.listen();
  const home = mkdtempSync(join(tmpdir(), "ate-app-"));
  registerAppRoutes({ routes, tokens, service: svc, home, port, deploymentsPath: null, ai: new AiEngine(home, { ATE_KEYSTORE: "file" }, { openai: () => ({ chat: { completions: { create: async () => ({}) } }, models: { list: async () => [{ id: "gpt-x" }] } }) as never }),
    approval: { verifier: null, tty: { issue: () => "12345678", redeem: (_p, _n, code) => ({ ok: code === "12345678" }) } },
  });
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => http.close());

const req = (method: string, path: string, token: string, body?: unknown) =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("chat go-to-cash confirmation (FLOW.md journey C)", () => {
  it("a chat change that drops a target asset is held for Touch ID and listed as pending", async () => {
    const before = svc.strategy.portfolio.targetAssets;
    expect(before.length).toBeGreaterThan(1);
    const keep = before.filter((a) => a !== before[0]);
    const r = await svc.callTool("chat", "ate_strategy_set", { patch: { targetAssets: keep }, rationale: "go to cash on one asset, keep the other" });
    expect(r.ok).toBe(false);
    const det = (r as unknown as { error: { code: string; details: { changeId: string; confirm?: string } } }).error;
    expect(det.code).toBe("ATE_APPROVAL_REQUIRED");
    expect(det.details.confirm).toBe("sells_now");
    expect(svc.strategy.portfolio.targetAssets).toEqual(before);
    const list = (await (await req("GET", "/strategy/pending", ui)).json()) as { pending: { changeId: string; via: string }[] };
    expect(list.pending.map((p) => p.changeId)).toContain(det.details.changeId);
    expect(list.pending[0]!.via).toBe("chat");
    const rej = (await (await req("POST", "/strategy/reject", ui, { changeId: det.details.changeId })).json()) as { rejected: boolean };
    expect(rej.rejected).toBe(true);
    expect(svc.listPendingChanges()).toHaveLength(0);
  });
  it("the same tightening from the ui scope applies at once", async () => {
    const before = svc.strategy.portfolio.targetAssets;
    const r = await svc.callTool("ui", "ate_strategy_set", { patch: { targetAssets: before.slice(1) }, rationale: "desktop go to cash test" });
    expect(r.ok).toBe(true);
  });
});

describe("proof + trader routes", () => {
  it("the attack suite refuses to run on mainnet (177) and GET /proof is view-readable", async () => {
    const r = await req("POST", "/proof/run", ui, {});
    expect(r.status).toBe(403);
    const g = await req("GET", "/proof", view);
    expect(g.status).toBe(200);
    const j = (await g.json()) as { chainId: number; runnable: boolean; run: unknown };
    expect(j.chainId).toBe(177);
    expect(j.runnable).toBe(false);
    expect(j.run).toBeNull();
  });
  it("trader state is ui/view only and starts stopped", async () => {
    const r = await req("GET", "/trader", ui);
    const j = (await r.json()) as { running: boolean; supervised: boolean };
    expect(j).toMatchObject({ running: false, supervised: true });
    expect((await req("POST", "/trader/start", view, {})).status).toBe(403);
  });
});

describe("engine providers (Accounts)", () => {
  it("lists every provider; first key is stored directly, replace/remove need Touch ID or the one-time code", async () => {
    const list = (await (await req("GET", "/engine/providers", ui)).json()) as { selected: { provider: string }; providers: { id: string; configured: boolean; warning: string | null }[] };
    expect(list.selected.provider).toBe("anthropic");
    expect(list.providers.map((p) => p.id)).toEqual(["anthropic", "openai", "gemini", "openrouter", "ollama", "proxy"]);
    expect(list.providers.find((p) => p.id === "proxy")!.warning).toMatch(/terms/);
    const key = "sk-proj-" + "a".repeat(40);
    const first = (await (await req("POST", "/engine/providers/openai/credential", ui, { action: "set", apiKey: key })).json()) as { saved: boolean; provider: { configured: boolean } };
    expect(first).toMatchObject({ saved: true, provider: { configured: true } });
    const step1 = (await (await req("POST", "/engine/providers/openai/credential", ui, { action: "remove" })).json()) as { nonce: string; codeIssued: boolean; payload: { kind: string } };
    expect(step1).toMatchObject({ codeIssued: true, payload: { kind: "config" } });
    expect((await req("POST", "/engine/providers/openai/credential", ui, { nonce: step1.nonce, approval: "00000000" })).status).toBe(401);
    const s2 = (await (await req("POST", "/engine/providers/openai/credential", ui, { action: "remove" })).json()) as { nonce: string };
    const done = (await (await req("POST", "/engine/providers/openai/credential", ui, { nonce: s2.nonce, approval: "12345678" })).json()) as { provider: { configured: boolean } };
    expect(done.provider.configured).toBe(false);
    expect((await req("POST", "/engine/providers/openai/credential", view, { action: "remove" })).status).toBe(403);
  });
  it("selects a provider and refuses unknown ones", async () => {
    expect((await req("POST", "/engine/select", ui, { provider: "nope" })).status).toBe(400);
    const r = (await (await req("POST", "/engine/select", ui, { provider: "anthropic", model: "claude-sonnet-5-5" })).json()) as { selected: { model: string } };
    expect(r.selected.model).toBe("claude-sonnet-5-5");
  });
});
