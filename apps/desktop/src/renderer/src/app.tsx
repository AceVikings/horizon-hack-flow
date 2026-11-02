// App state shared by every view: bridge, connection, polled daemon status + positions + markets (last good value
// kept while the daemon/RPC is unreachable, so screens can dim stale values), event stream, toasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DaemonEvent, MarketView } from "@ate/core";
import type { AteBridge, ConnectionInfo, Res, VaultsStatus } from "@shared/bridge";
import { createFixtureBridge } from "./fixtures";
import { explorer, label, setChain } from "./format";

export function pickBridge(): AteBridge {
  const forced = typeof location !== "undefined" && location.search.includes("fixtures");
  if (window.ate && !window.ate.fixtures && !forced) return window.ate;
  return createFixtureBridge();
}

export interface Toast {
  id: number;
  kind: "info" | "ok" | "error";
  text: string;
  sub?: string;
  href?: string;
  hrefLabel?: string;
}
interface Ctx {
  ate: AteBridge;
  conn: ConnectionInfo | null;
  /** Latest /status + ate_positions result (may be an error). */
  vs: Res<VaultsStatus> | null;
  /** Last successful status, kept through errors (render dimmed with `stale`). */
  vsOk: VaultsStatus | null;
  /** Latest ate_market_get result and last good value. */
  mk: Res<MarketView[]> | null;
  mkOk: MarketView[] | null;
  /** Unix seconds of the last successful status read. */
  fetchedAt: number;
  /** Set while status reads are failing: since when, and the error. */
  stale: { since: number; code: string; message: string } | null;
  refresh(): void;
  tick: number; // bumps on any daemon event: views refetch
  events: DaemonEvent[];
  toast(t: Omit<Toast, "id">): void;
  dismiss(id: number): void;
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
  const [vsOk, setVsOk] = useState<VaultsStatus | null>(null);
  const [mk, setMk] = useState<Res<MarketView[]> | null>(null);
  const [mkOk, setMkOk] = useState<MarketView[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [stale, setStale] = useState<Ctx["stale"]>(null);
  const [tick, setTick] = useState(0);
  const [events, setEvents] = useState<DaemonEvent[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nid = useRef(1);
  const inflight = useRef(false);

  const refresh = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    void Promise.all([ate.vaults.status(), ate.markets.list()])
      .then(([r, m]) => {
        setVs(r);
        setMk(m);
        if (m.ok) setMkOk(m.data);
        if (r.ok) {
          setChain(r.data.status.chainId);
          setVsOk(r.data);
          // The kill switch locks the agent key. Once the owner's unpause has landed on every vault, unlock it again
          // (sealed passphrase, no prompt, same as opening the app) so the agent can trade and pause again.
          const v = r.data.status.vaults;
          if (r.data.status.locked && v.length && v.every((x) => !x.paused)) void ate.setup?.unlock();
          setFetchedAt(Math.floor(Date.now() / 1000));
          setStale(null);
        } else {
          const at = Math.floor(Date.now() / 1000);
          setStale((s) => s ?? { since: at, code: r.error.code, message: r.error.message });
        }
      })
      .finally(() => (inflight.current = false));
    void ate.connection().then(setConn);
  }, [ate]);

  const dismiss = useCallback((id: number) => setToasts((x) => x.filter((y) => y.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nid.current++;
      setToasts((x) => [...x.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.kind === "error" ? 12_000 : 8000);
    },
    [dismiss],
  );

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    const un = ate.events.subscribe((e) => {
      setEvents((x) => [e, ...x].slice(0, 50));
      setTick((n) => n + 1);
      if (e.type === "trade.executed") toast({ kind: "ok", text: `${e.data.side === "buy" ? "Bought" : "Sold"} on ${label(e.data.market)}${e.data.exitPath ? " · exit path" : ""}`, sub: `Vault-${label(e.data.market)}`, href: explorer.tx(e.data.txHash), hrefLabel: e.data.txHash });
      if (e.type === "trade.rejected") toast({ kind: "error", text: `Refused on ${label(e.data.market)}: ${e.data.code}`, sub: e.data.message });
      if (e.type === "policy.violation") toast({ kind: "error", text: `Vault refused a trade (${e.data.code})`, ...(e.data.txHash ? { href: explorer.tx(e.data.txHash), hrefLabel: e.data.txHash } : {}) });
      if (e.type === "gas.low") toast({ kind: "error", text: `Agent gas low: ${e.data.agentHsk} HSK`, sub: `below ${e.data.thresholdHsk} HSK` });
      if (e.type === "daemon.locked" && e.data.locked) toast(e.data.reason === "ate_pause" ? { kind: "info", text: "Agent key locked until you resume" } : { kind: "error", text: "Daemon locked", sub: e.data.reason });
      refresh();
    });
    return () => {
      clearInterval(iv);
      un();
    };
  }, [ate, refresh, toast]);

  const value: Ctx = { ate, conn, vs, vsOk, mk, mkOk, fetchedAt, stale, refresh, tick, events, toast, dismiss, toasts };
  return <C.Provider value={value}>{children}</C.Provider>;
}

/** Fetch with refetch on mount, deps, daemon events and an optional interval. Keeps the last good value in `last`. */
export function useRemote<T>(fn: () => Promise<Res<T>>, deps: unknown[], opts: { every?: number; onEvents?: boolean } = {}): { res: Res<T> | null; last: T | null; loading: boolean; reload(): void } {
  const { tick } = useApp();
  const [res, setRes] = useState<Res<T> | null>(null);
  const [last, setLast] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void fn().then((r) => {
      if (live) {
        setRes(r);
        if (r.ok) setLast(r.data);
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
  return { res, last, loading, reload: () => setN((x) => x + 1) };
}

export function useNow(ms = 1000): number {
  const [t, setT] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const i = setInterval(() => setT(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(i);
  }, [ms]);
  return t;
}

/** Trader state for the rail pill, page pills and footer. */
export type TraderState = "running" | "idle" | "paused" | "offline" | "loading" | "setup";
export function useTraderState(): TraderState {
  const { vs, vsOk, stale, conn } = useApp();
  if (!vs && !vsOk) return conn?.mode === "offline" ? "offline" : "loading";
  if (stale || conn?.mode === "offline") return "offline";
  const st = vsOk!.status;
  if (st.vaults.some((v) => v.paused)) return "paused";
  return st.trader.running ? "running" : "idle";
}
