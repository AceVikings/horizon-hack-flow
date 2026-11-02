// App shell (board "FRAME SHELL"): 76 px dark rail | [236 context] main [320 dark inspector] | evidence footer.
// Views fill the optional columns through <ContextPanel>/<Inspector> portals; empty columns collapse.
// Shared APIs (stable): PageHead, ContextPanel, Inspector, useKillSwitch, useNav.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MARKETS, type JournalEntry, type MarketId } from "@ate/core";
import { NAV, type NavId } from "../views/registry";
import { useApp, useNow, useTraderState, type TraderState } from "./app";
import { dur, clock, explorer, group, int, networkName, short, usd, usdE8Short } from "./format";
import { FlowMark, Link } from "./ui";
import { KillSwitchDialog } from "./killswitch";
import { worstCase } from "@ate/core";
import { centsE8 } from "./risk";

const Slots = createContext<{ ctx: HTMLElement | null; insp: HTMLElement | null }>({ ctx: null, insp: null });

/** Left context column (236 px, light): filters, market list. */
export function ContextPanel({ children }: { children: ReactNode }) {
  const { ctx } = useContext(Slots);
  return ctx ? createPortal(children, ctx) : null;
}
/** Right inspector column (320 px, dark). Use `.sec` + `<Eyebrow>` sections inside. */
export function Inspector({ children }: { children: ReactNode }) {
  const { insp } = useContext(Slots);
  return insp ? createPortal(children, insp) : null;
}

/** Page header (`.ph`): display title with the yellow highlight bar (on `hl`, default the whole title), sub line, actions. */
export function PageHead({ title, hl, sub, acts, crumb }: { title: ReactNode; hl?: ReactNode; sub?: ReactNode; acts?: ReactNode; crumb?: ReactNode }) {
  return (
    <div className="ph" style={crumb ? { paddingTop: 20 } : undefined}>
      <div style={{ minWidth: 0 }}>
        {crumb && <div className="crumb">{crumb}</div>}
        <h1>
          {hl === undefined ? <span className="hl">{title}</span> : <>{title} <span className="hl">{hl}</span></>}
        </h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {acts && <div className="acts">{acts}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- navigation + kill switch context

interface ShellCtx {
  go(path: string): void;
  openKill(): void;
}
const ShellC = createContext<ShellCtx>({ go: () => {}, openKill: () => {} });
/** Navigate: `go("decisions/exec_…")`. */
export const useNav = (): ((path: string) => void) => useContext(ShellC).go;
/** Open the kill-switch confirm dialog (also ⌘⇧K anywhere). */
export const useKillSwitch = (): (() => void) => useContext(ShellC).openKill;

const ICON: Record<string, ReactNode> = {
  home: <><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v10h12V10" /><path d="M10 20v-5h4v5" /></>,
  list: <><path d="M8 6h12M8 12h12M8 18h8" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>,
  chart: <><path d="M3 20h18" /><path d="M5 16l4.5-5 3.5 3 6-7" /><path d="M15 7h4v4" /></>,
  pie: <><path d="M12 3a9 9 0 1 0 9 9h-9z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" /></>,
  bot: <><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4" /><circle cx="9" cy="13" r="1.2" /><circle cx="15" cy="13" r="1.2" /></>,
  chat: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 10h8" /></>,
  shield: <><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  card: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h4" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
};
const Icon = ({ k }: { k: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {ICON[k]}
  </svg>
);

const TSTAT: Record<TraderState, [string, string]> = {
  running: ["running", "Trader running"],
  idle: ["setup", "Trader idle"],
  paused: ["paused", "Vaults paused"],
  offline: ["paused", "Offline"],
  loading: ["setup", "Connecting"],
  setup: ["setup", "Setting up"],
};

function Rail({ nav, go, pending }: { nav: NavId | string; go(p: string): void; pending?: boolean }) {
  const st = useTraderState();
  const [cls, txt] = TSTAT[st];
  return (
    <nav className="rail" aria-label="Main">
      <div className="lights drag" aria-hidden="true">
        <i /><i /><i />
      </div>
      <div className="logo"><FlowMark size={40} /></div>
      {NAV.map((n, i) => {
        const soon = "soon" in n && n.soon;
        return (
          <button
            key={n.id}
            className={`ri${nav === n.id ? " on" : ""}${soon ? " off" : ""}`}
            aria-current={nav === n.id ? "page" : undefined}
            aria-disabled={soon || undefined}
            title={soon ? "Payments: HSP is coming soon" : `${n.name} (⌘${i + 1})`}
            onClick={() => !soon && go(n.id)}
          >
            <Icon k={n.icon} />
            <span>{n.name}</span>
            {soon && <b className="soon">SOON</b>}
            {n.id === "agent" && pending && <i className="dotc" aria-label="approval waiting" />}
          </button>
        );
      })}
      <div className="sp" />
      <div className={`tstat ${cls}`} role="status" aria-live="polite">
        <i aria-hidden="true" />
        {txt.split(" ").map((w, i) => (
          <span key={i} style={{ display: "block" }}>{w}</span>
        ))}
      </div>
      <button className={`ri${nav === "settings" ? " on" : ""}`} aria-current={nav === "settings" ? "page" : undefined} onClick={() => go("settings")} title="Settings (⌘,)">
        <Icon k="settings" />
        <span>Settings</span>
      </button>
    </nav>
  );
}

export function Shell({ nav, chrome = "app", setupStep, children }: { nav: string; chrome?: "app" | "setup"; setupStep?: number; children: ReactNode }) {
  const { conn, toasts, dismiss } = useApp();
  const [ctx, setCtx] = useState<HTMLElement | null>(null);
  const [insp, setInsp] = useState<HTMLElement | null>(null);
  const [kill, setKill] = useState(false);
  const go = useCallback((p: string) => (location.hash = "#/" + p.replace(/^#?\/?/, "")), []);
  const openKill = useCallback(() => setKill(true), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setKill(true);
      } else if (!e.shiftKey && /^[1-7]$/.test(e.key)) {
        e.preventDefault();
        go(NAV[Number(e.key) - 1]!.id);
      } else if (e.key === ",") {
        e.preventDefault();
        go("settings");
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [go]);
  return (
    <ShellC.Provider value={{ go, openKill }}>
      <Slots.Provider value={{ ctx, insp }}>
        <div className={`frame${chrome === "setup" ? " norail" : ""}`}>
          {chrome === "app" && <Rail nav={nav} go={go} />}
          {chrome === "app" ? (
            <div className="body shellbody">
              <aside className="ctx" ref={setCtx} aria-label="Filters" />
              <main className="main" id="main">{children}</main>
              <aside className="insp" ref={setInsp} aria-label="Inspector" />
            </div>
          ) : (
            <div className="body">{children}</div>
          )}
          <Footer setupStep={chrome === "setup" ? (setupStep ?? 0) : undefined} />
        </div>
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast${t.kind === "error" ? " bad" : ""}`} role={t.kind === "error" ? "alert" : "status"}>
              <div className="row sb top">
                <div className="t1">
                  <span aria-hidden="true">{t.kind === "ok" ? "✓ " : t.kind === "error" ? "✕ " : "i "}</span>
                  {t.text}
                </div>
                <button className="linkbtn xs" onClick={() => dismiss(t.id)} aria-label="Dismiss">✕</button>
              </div>
              {(t.sub || t.href) && (
                <div className="t2">
                  {t.sub}
                  {t.sub && t.href && " · "}
                  {t.href && <Link href={t.href} mono>{t.hrefLabel ? short(t.hrefLabel, 6, 4) : "explorer"}</Link>}
                </div>
              )}
            </div>
          ))}
        </div>
        {conn?.mode === "fixtures" && <div className="fixbanner">Fixtures · synthetic data, no daemon</div>}
        <KillSwitchDialog open={kill} onClose={() => setKill(false)} />
      </Slots.Provider>
    </ShellC.Provider>
  );
}

// ---------------------------------------------------------------- evidence footer (SPEC §15.1)

/** Journal head + last executed trade + last pause, refreshed on daemon events. */
export function useEvidence(): { head: { seq: number; hash: string } | null; lastTx: JournalEntry | null; lastPause: JournalEntry | null } {
  const { ate, tick } = useApp();
  const [s, setS] = useState<ReturnType<typeof useEvidence>>({ head: null, lastTx: null, lastPause: null });
  useEffect(() => {
    let live = true;
    void Promise.all([ate.journal.list({ limit: 20, kind: ["execution"] }), ate.journal.list({ limit: 1, kind: ["pause"] })]).then(([ex, pz]) => {
      if (!live) return;
      setS({
        head: ex.ok ? ex.data.head : pz.ok ? pz.data.head : null,
        lastTx: ex.ok ? (ex.data.entries.find((e) => e.execution && !e.execution.reverted) ?? null) : null,
        lastPause: pz.ok ? (pz.data.entries[0] ?? null) : null,
      });
    });
    return () => {
      live = false;
    };
  }, [ate, tick]);
  return s;
}

const FI = ({ k, children, mut }: { k: string; children: ReactNode; mut?: boolean }) => (
  <span className={`fi${mut ? " mut" : ""}`}>
    <b>{k}</b>
    {children}
  </span>
);

function Footer({ setupStep }: { setupStep?: number }) {
  const { vsOk, mkOk, fetchedAt, stale } = useApp();
  const now = useNow();
  const ev = useEvidence();
  const st = vsOk?.status;
  const vault = (m: MarketId) => st?.vaults.find((v) => v.market === m);
  const lim = mkOk?.[0]?.vault.limits;
  const wc = mkOk?.length ? worstCase(mkOk.map((m) => m.vault.limits)) : null;
  const paused = st?.vaults.some((v) => v.paused);
  const up = st ? st.uptimeSec + Math.max(0, now - fetchedAt) : 0;
  const chip = stale ? (
    <><span className="up gr">RECONNECTING</span> last read {dur(now - fetchedAt).replace(/^0h /, "")} ago</>
  ) : setupStep !== undefined ? (
    <span className="up gr">SETUP {setupStep} / 6</span>
  ) : paused ? (
    <><span className="up red">PAUSED{ev.lastPause ? " " + clock(ev.lastPause.at) : ""}</span> {st ? `${int(st.cycles)} cycles · ${int(st.trades)} trades` : ""}</>
  ) : st ? (
    <><span className="up">{st.trader.running ? `RUNNING ${dur(up).toUpperCase()}` : "IDLE"}</span> {int(st.cycles)} cycles · {int(st.trades)} trades</>
  ) : (
    <span className="up gr">CONNECTING</span>
  );
  return (
    <footer className="foot" aria-label="Evidence">
      <div className="frow">
        {(Object.keys(MARKETS) as MarketId[]).map((m) => {
          const v = vault(m);
          return v ? (
            <FI key={m} k={`Vault-${MARKETS[m].label}`}><Link href={explorer.address(v.address)} mono>{v.address}</Link></FI>
          ) : (
            <FI key={m} k={`Vault-${MARKETS[m].label}`} mut>not connected</FI>
          );
        })}
        {setupStep === undefined && (
          <FI k="Chain head">
            <span className="mono" title={ev.head?.hash}>{ev.head ? short(ev.head.hash, 10, 8) : "—"}</span>
            {ev.head && <span style={{ color: "var(--sage)" }}> #{group(String(ev.head.seq))}</span>}
          </FI>
        )}
        <span className="sp" />
        {setupStep === undefined && <FI k="Last trade">{ev.lastTx?.execution ? <Link href={explorer.tx(ev.lastTx.execution.txHash)} mono>{short(ev.lastTx.execution.txHash, 10, 8)}</Link> : "—"}</FI>}
      </div>
      <div className="frow">
        <FI k="Limits">
          {lim && wc ? `${usdE8Short(lim.maxTradeUsdE8)}/trade · ${usdE8Short(lim.maxEpochUsdE8)}/${lim.epochDuration === 86_400 ? "UTC day" : `${lim.epochDuration / 3600} h`} · ${usdE8Short(lim.maxExposureUsdE8)} exposure · max loss ${centsE8(wc.maxLossUsdE8)}/day` : <span style={{ color: "var(--sage)" }}>read from the vaults…</span>}
        </FI>
        <span className="fi">{chip}</span>
        {st && setupStep === undefined && <FI k="HSKSwap">{int(st.hskswapTrades)} trades routed · {usd(st.routedUsd)}</FI>}
        <span className="sp" />
        {st && <FI k={networkName(st.chainId)}>block {group(st.blockNumber)}</FI>}
        <span className="fi">
          <Link href="https://flowverse.cloud/proof">flowverse.cloud/proof</Link>
        </span>
      </div>
    </footer>
  );
}

