// Frozen preload (SPEC §10.2): exposes window.ate only. No ipcRenderer, no require, no arbitrary channels.
import { contextBridge, ipcRenderer } from "electron";
import type { DaemonEvent } from "@ate/core";
import { EVENT_CHANNEL, type IpcMethod } from "../shared/bridge";
import type { SetupIpc } from "../shared/setup-bridge";

const call = (m: IpcMethod, a?: unknown, b?: unknown) => ipcRenderer.invoke(`ate:${m}`, a, b);
const sc = (m: SetupIpc, a?: unknown, b?: unknown, c?: unknown) => ipcRenderer.invoke(`ate:${m}`, a, b, c);

const ate = Object.freeze({
  fixtures: process.argv.includes("--ate-fixtures"),
  connection: () => call("connection"),
  markets: Object.freeze({ list: () => call("markets.list"), get: (id: string) => call("markets.get", id) }),
  quote: Object.freeze({ get: (req: unknown) => call("quote.get", req) }),
  trade: Object.freeze({
    propose: (req: unknown) => call("trade.propose", req),
    approve: (id: string, digest: string) => call("trade.approve", id, digest),
    execute: (id: string) => call("trade.execute", id),
  }),
  vaults: Object.freeze({ status: () => call("vaults.status"), pause: () => call("vaults.pause") }),
  strategy: Object.freeze({ get: () => call("strategy.get"), set: (patch: unknown, rationale: string) => call("strategy.set", patch, rationale), approve: (changeId: string, ttyCode?: string) => call("strategy.approve", changeId, ttyCode) }),
  journal: Object.freeze({ list: (f: unknown) => call("journal.list", f), get: (id: string) => call("journal.get", id) }),
  chat: Object.freeze({ send: (s: string, t: string) => call("chat.send", s, t), history: (s: string) => call("chat.history", s) }),
  payments: Object.freeze({ list: () => call("payments.list"), approve: (id: string, d: string) => call("payments.approve", id, d), deny: (id: string) => call("payments.deny", id) }),
  settings: Object.freeze({ get: () => call("settings.get"), set: (p: unknown) => call("settings.set", p) }),
  // Lane D2: setup wizard, Settings saves and the app-owned daemon lifecycle (allowlisted in main/setup-ipc.ts).
  setup: Object.freeze({
    daemon: () => sc("setup.daemon"),
    start: () => sc("setup.start"),
    stop: () => sc("setup.stop"),
    submitCode: (code: string) => sc("setup.submitCode", code),
    unlock: () => sc("setup.unlock"),
    get: (path: string, query?: Record<string, string>) => sc("setup.get", path, query),
    post: (path: string, body?: unknown) => sc("setup.post", path, body),
    keygen: (privateKey?: string) => sc("setup.keygen", privateKey),
    approveStart: (path: string, body: unknown) => sc("setup.approveStart", path, body),
    approveFinish: (path: string, nonce: string, code: string) => sc("setup.approveFinish", path, nonce, code),
    open: (url: string) => sc("setup.open", url),
    saveJson: (name: string, data: unknown) => sc("setup.saveJson", name, data),
    proxy: (o: unknown) => sc("setup.proxy", o),
  }),
  trader: Object.freeze({ status: () => call("trader.status"), start: (o: unknown) => call("trader.start", o), stop: () => call("trader.stop") }),
  approvals: Object.freeze({ list: () => call("approvals.list"), reject: (id: string) => call("approvals.reject", id), confirm: (id: string) => call("approvals.confirm", id) }),
  ai: Object.freeze({ health: () => call("ai.health"), check: () => call("ai.check"), setKey: (k: string) => call("ai.setKey", k), clearKey: () => call("ai.clearKey"), config: (p: unknown) => call("ai.config", p) }),
  engine: Object.freeze({ providers: () => call("engine.providers"), test: (id: string) => call("engine.test", id), credential: (id: string, b: unknown) => call("engine.credential", id, b), confirm: (id: string, nonce: string, code: string) => call("engine.confirm", id, { nonce, code }), select: (p: string, m?: string) => call("engine.select", p, m) }),
  proof: Object.freeze({ get: () => call("proof.get"), run: (o?: unknown) => call("proof.run", o), stop: () => call("proof.stop") }),
  candidates: Object.freeze({ get: (m?: string) => call("candidates.get", m) }),
  charts: Object.freeze({ chart: (i: unknown) => call("charts.chart", i), data: (i: unknown) => call("charts.data", i) }),
  cycle: Object.freeze({ request: () => call("cycle.request") }),
  events: Object.freeze({
    subscribe: (handler: (e: DaemonEvent) => void) => {
      const l = (_: unknown, e: DaemonEvent) => handler(e);
      ipcRenderer.on(EVENT_CHANNEL, l);
      return () => void ipcRenderer.removeListener(EVENT_CHANNEL, l);
    },
  }),
});

contextBridge.exposeInMainWorld("ate", ate);
