// App state: bridge, connection, polled vault status, event stream, toasts, inspector slot.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DaemonEvent } from "@ate/core";
import type { AteBridge, ConnectionInfo, Res, VaultsStatus } from "@shared/bridge";
import { createFixtureBridge } from "./fixtures";

export function pickBridge(): AteBridge {
  const forced = typeof location !== "undefined" && location.search.includes("fixtures");
  if (window.ate && !window.ate.fixtures && !forced) return window.ate;
  return createFixtureBridge();
}

export interface Toast {
  id: number;
  kind: "info" | "ok" | "error";
  text: string;
  href?: string;
}
interface Ctx {
  ate: AteBridge;
  conn: ConnectionInfo | null;
  vs: Res<VaultsStatus> | null;
  fetchedAt: number;
  refresh(): void;
  tick: number; // bumps on any daemon event: views refetch
  events: DaemonEvent[];
  toast(t: Omit<Toast, "id">): void;
  toasts: Toast[];
}
const C = createContext<Ctx | null>(null);
export const useApp = (): Ctx => {
  const c = useContext(C);
  if (!c) throw new Error("no app");
  return c;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const ate = useMemo(pickBridge, []);
  const [conn, setConn] = useState<ConnectionInfo | null>(null);
  const [vs, setVs] = useState<Res<VaultsStatus> | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [tick, setTick] = useState(0);
  const [events, setEvents] = useState<DaemonEvent[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nid = useRef(1);

  const refresh = useCallback(() => {
    void ate.vaults.status().then((r) => {
      setVs(r);
      setFetchedAt(Math.floor(Date.now() / 1000));
    });
  }, [ate]);

  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = nid.current++;
    setToasts((x) => [...x, { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 7000);
  }, []);

  useEffect(() => {
    void ate.connection().then(setConn);
    refresh();
    const iv = setInterval(refresh, 5000);
    const un = ate.events.subscribe((e) => {
      setEvents((x) => [e, ...x].slice(0, 50));
      setTick((n) => n + 1);
      if (e.type === "trade.executed") toast({ kind: "ok", text: `Trade executed: ${e.data.side} on ${e.data.market}`, href: `https://hsk.blockscout.com/tx/${e.data.txHash}` });
      if (e.type === "trade.rejected") toast({ kind: "error", text: `Rejected ${e.data.code}: ${e.data.message}` });
      if (e.type === "policy.violation") toast({ kind: "error", text: `Policy violation reason ${e.data.reason}`, ...(e.data.txHash ? { href: `https://hsk.blockscout.com/tx/${e.data.txHash}` } : {}) });
      if (e.type === "gas.low") toast({ kind: "error", text: `Agent gas low: ${e.data.agentHsk} HSK` });
      if (e.type === "daemon.locked" && e.data.locked) toast({ kind: "error", text: "Daemon locked" });
      refresh();
    });
    return () => {
      clearInterval(iv);
      un();
    };
  }, [ate, refresh, toast]);

  const value: Ctx = { ate, conn, vs, fetchedAt, refresh, tick, events, toast, toasts };
  return <C.Provider value={value}>{children}</C.Provider>;
}

/** Fetch with refetch on mount, deps, daemon events and an optional interval. */
export function useRemote<T>(fn: () => Promise<Res<T>>, deps: unknown[], opts: { every?: number; onEvents?: boolean } = {}): { res: Res<T> | null; loading: boolean; reload(): void } {
  const { tick } = useApp();
  const [res, setRes] = useState<Res<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void fn().then((r) => {
      if (live) {
        setRes(r);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n, opts.onEvents === false ? 0 : tick]);
  useEffect(() => {
    if (!opts.every) return;
    const i = setInterval(() => setN((x) => x + 1), opts.every);
    return () => clearInterval(i);
  }, [opts.every]);
  return { res, loading, reload: () => setN((x) => x + 1) };
}

export function useNow(ms = 1000): number {
  const [t, setT] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const i = setInterval(() => setT(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(i);
  }, [ms]);
  return t;
}
