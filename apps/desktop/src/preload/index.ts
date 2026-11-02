// Frozen preload (SPEC §10.2): exposes window.ate only. No ipcRenderer, no require, no arbitrary channels.
import { contextBridge, ipcRenderer } from "electron";
import type { DaemonEvent } from "@ate/core";
import { EVENT_CHANNEL, type IpcMethod } from "../shared/bridge";

const call = (m: IpcMethod, a?: unknown, b?: unknown) => ipcRenderer.invoke(`ate:${m}`, a, b);

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
  strategy: Object.freeze({ get: () => call("strategy.get"), set: (patch: unknown, rationale: string) => call("strategy.set", patch, rationale) }),
  journal: Object.freeze({ list: (f: unknown) => call("journal.list", f), get: (id: string) => call("journal.get", id) }),
  chat: Object.freeze({ send: (s: string, t: string) => call("chat.send", s, t), history: (s: string) => call("chat.history", s) }),
  payments: Object.freeze({ list: () => call("payments.list"), approve: (id: string, d: string) => call("payments.approve", id, d), deny: (id: string) => call("payments.deny", id) }),
  settings: Object.freeze({ get: () => call("settings.get"), set: (p: unknown) => call("settings.set", p) }),
  events: Object.freeze({
    subscribe: (handler: (e: DaemonEvent) => void) => {
      const l = (_: unknown, e: DaemonEvent) => handler(e);
      ipcRenderer.on(EVENT_CHANNEL, l);
      return () => void ipcRenderer.removeListener(EVENT_CHANNEL, l);
    },
  }),
});

contextBridge.exposeInMainWorld("ate", ate);
