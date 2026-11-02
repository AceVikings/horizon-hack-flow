import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MARKET_IDS, MARKETS } from "@ate/core";
import { useApp, useNow } from "./app";
import { AddrLink, Badge, Link } from "./ui";
import { dur, explorer, short, usd } from "./format";

export const VIEWS = [
  { id: "decisions", name: "Decisions", icon: "≡" },
  { id: "trade", name: "Trade", icon: "⇄" },
  { id: "agents", name: "Agents", icon: "◉" },
  { id: "positions", name: "Positions", icon: "▤" },
  { id: "chat", name: "Chat", icon: "✎" },
  { id: "payments", name: "Payments", icon: "$" },
] as const;
export type ViewId = (typeof VIEWS)[number]["id"];

const Slots = createContext<{ ctx: HTMLElement | null; insp: HTMLElement | null }>({ ctx: null, insp: null });

export function ContextPanel({ children }: { children: ReactNode }) {
  const { ctx } = useContext(Slots);
  return ctx ? createPortal(children, ctx) : null;
}
export function Inspector({ children }: { children: ReactNode }) {
  const { insp } = useContext(Slots);
  return insp ? createPortal(children, insp) : null;
}

export function Shell({ view, setView, children }: { view: ViewId; setView(v: ViewId): void; children: ReactNode }) {
  const { conn, toasts } = useApp();
  const [ctx, setCtx] = useState<HTMLElement | null>(null);
  const [insp, setInsp] = useState<HTMLElement | null>(null);
  const [inspOpen, setInspOpen] = useState(true);
  return (
    <Slots.Provider value={{ ctx, insp }}>
      <div className={`app ${inspOpen ? "" : "noinsp"}`}>
        <nav className="rail" aria-label="Views">
          <div className="logo" aria-hidden="true">ATE</div>
          {VIEWS.map((v, i) => (
            <button key={v.id} className={`railbtn ${view === v.id ? "on" : ""}`} onClick={() => setView(v.id)} aria-label={v.name} aria-current={view === v.id ? "page" : undefined} title={`${v.name} (⌘${i + 1})`}>
              <span aria-hidden="true" className="ric">{v.icon}</span>
              <span className="rlabel">{v.name}</span>
            </button>
          ))}
          <div className="grow" />
          <button className="railbtn" onClick={() => setInspOpen((o) => !o)} aria-label="Toggle inspector" aria-pressed={inspOpen} title="Toggle inspector">
            <span aria-hidden="true" className="ric">▥</span>
            <span className="rlabel">Panel</span>
          </button>
        </nav>
        <aside className="ctxpanel" ref={setCtx} aria-label="Context" />
        <main className="main">
          <div className="topbar">
            <h1>{VIEWS.find((v) => v.id === view)!.name}</h1>
            <ConnBadge />
          </div>
          <div className="content">{children}</div>
        </main>
        <aside className="inspector" ref={setInsp} aria-label="Inspector" hidden={!inspOpen} />
        <Footer />
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              <span aria-hidden="true">{t.kind === "ok" ? "✓" : t.kind === "error" ? "✕" : "i"}</span> {t.text}
              {t.href && <> <Link href={t.href}>Blockscout</Link></>}
            </div>
          ))}
        </div>
        {conn?.mode === "fixtures" && <div className="fixbanner">FIXTURES: synthetic data, no daemon</div>}
      </div>
    </Slots.Provider>
  );
}

function ConnBadge() {
  const { conn } = useApp();
  if (!conn) return <Badge>connecting</Badge>;
  const tone = conn.mode === "live" ? "ok" : conn.mode === "fixtures" ? "info" : "bad";
  return <Badge tone={tone} title={conn.detail}>{conn.mode === "live" ? `daemon :${conn.port}` : conn.mode === "fixtures" ? "fixtures mode" : "daemon offline"}</Badge>;
}

/** Persistent evidence footer (SPEC §15.1): vaults, limits, chain head, last trade tx, uptime, HSKSwap counters, JUDGE link. */
function Footer() {
  const { vs, fetchedAt, ate } = useApp();
  const now = useNow();
  const [head, setHead] = useState<{ hash: string; seq: number } | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const { tick } = useApp();
  useHeadEffect(ate, tick, setHead, setLastTx);
  if (!vs) return <footer className="footer"><span className="muted">Loading evidence…</span></footer>;
  if (!vs.ok) return <footer className="footer"><Badge tone="bad">{vs.error.code}</Badge> <span className="muted">{vs.error.message}</span></footer>;
  const { status } = vs.data;
  const up = status.uptimeSec + Math.max(0, now - fetchedAt);
  return (
    <footer className="footer" aria-label="Evidence">
      <div className="frow">
        {status.vaults.map((v) => (
          <span key={v.market} className="fitem">
            <b>Vault-{MARKETS[v.market].label}</b> <AddrLink addr={v.address} full /> {v.paused && <Badge tone="bad">paused</Badge>}
          </span>
        ))}
        <span className="fitem"><b>Chain head</b> <span className="mono" title={head?.hash}>{head ? short(head.hash, 12, 8) : "—"}</span>{head && <span className="muted"> #{head.seq}</span>}</span>
        <span className="fitem"><b>Last TradeExecuted</b> {lastTx ? <Link href={explorer.tx(lastTx)} title={lastTx}>{short(lastTx, 10, 8)}</Link> : "—"}</span>
      </div>
      <div className="frow">
        <span className="fitem"><b>Limits</b> <LimitsSummary /></span>
        <span className="fitem uptime" title="Computed by the daemon from the journal since the trader's start record">
          <b>running {dur(up)}</b> · {status.cycles.toLocaleString("en-US")} cycles · {status.trades} trades
        </span>
        <span className="fitem"><b>HSKSwap</b> {status.hskswapTrades} trades routed · {usd(status.routedUsd)} routed</span>
        <span className="fitem"><span title="Judge verification page in the repo">docs/JUDGE.md</span></span>
      </div>
    </footer>
  );
}

import { useEffect } from "react";
import type { AteBridge } from "@shared/bridge";
function useHeadEffect(ate: AteBridge, tick: number, setHead: (h: { hash: string; seq: number }) => void, setTx: (t: string | null) => void) {
  useEffect(() => {
    void ate.journal.list({ limit: 50, kind: ["execution"] }).then((r) => {
      if (!r.ok) return;
      setHead(r.data.head);
      const ex = r.data.entries.find((e) => e.execution && !e.execution.reverted);
      setTx(ex?.execution?.txHash ?? null);
    });
  }, [ate, tick, setHead, setTx]);
}

function LimitsSummary() {
  const { ate, tick } = useApp();
  const [txt, setTxt] = useState("—");
  useEffect(() => {
    void ate.markets.list().then((r) => {
      if (!r.ok) return;
      const l = r.data[0]?.vault.limits;
      if (!l) return;
      const e8 = (s: string) => "$" + (BigInt(s) / 100_000_000n).toString();
      setTxt(`${e8(l.maxTradeUsdE8)}/trade · ${e8(l.maxEpochUsdE8)}/${l.epochDuration === 86400 ? "UTC day" : `${l.epochDuration / 3600}h`} · ${e8(l.maxExposureUsdE8)} exposure · slippage ${l.maxSlippageBps} bps · oracle dev ${l.maxOracleDeviationBps} bps`);
    });
  }, [ate, tick]);
  return <span className="num">{txt}</span>;
}

export { MARKET_IDS };
