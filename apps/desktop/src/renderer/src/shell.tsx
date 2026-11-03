// App shell (SIMPLIFY.md): 76 px dark rail (Home · Ask · Trade · Activity + ⋯ menu) | [236 context] main [320 dark
// inspector, Pro mode only]. No footer of any kind: status lives in Home's sentence and the ⋯ menu.
// Shared APIs (stable): PageHead, ContextPanel, Inspector, useKillSwitch, useNav, useMode, useEvidence.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { JournalEntry } from "@ate/core";
import { MENU, NAV } from "../views/registry";
import { useApp, useTraderState, type TraderState } from "./app";
import { dur, clock, explorer, group, networkName, short } from "./format";
import { FlowMark, Link, Seg } from "./ui";
import { KillSwitchDialog } from "./killswitch";

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

// ---------------------------------------------------------------- navigation, mode, kill switch

export type Mode = "simple" | "pro";
interface ShellCtx {
  go(path: string): void;
  openKill(): void;
  mode: Mode;
  setMode(m: Mode): void;
}
const ShellC = createContext<ShellCtx>({ go: () => {}, openKill: () => {}, mode: "simple", setMode: () => {} });
/** Navigate: `go("activity/exec_…")`. */
export const useNav = (): ((path: string) => void) => useContext(ShellC).go;
/** Open the kill-switch confirm dialog (also ⌘⇧K anywhere). */
export const useKillSwitch = (): (() => void) => useContext(ShellC).openKill;
/** Simple (default) or Pro (dense v1 panels). Persisted per user (localStorage "flow.mode"). */
export const useMode = (): [Mode, (m: Mode) => void] => {
  const c = useContext(ShellC);
  return [c.mode, c.setMode];
};

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
  book: <><path d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4z" /><path d="M9 8h6M9 12h6" /></>,
  wallet: <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="4" y="8" width="16" height="11" rx="2" /><circle cx="16" cy="13.5" r="1.2" /></>,
  key: <><circle cx="8" cy="14" r="4" /><path d="M11 11l8-8M16 6l2 2M14 8l2 2" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
};
const Icon = ({ k }: { k: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {ICON[k]}
  </svg>
);

const TSTAT: Record<TraderState, [string, string]> = {
  running: ["running", "Agent running"],
  idle: ["setup", "Agent stopped"],
  paused: ["paused", "Trading paused"],
  offline: ["paused", "Offline"],
  loading: ["setup", "Connecting"],
  setup: ["setup", "Setting up"],
};

function Rail({ nav, go, mode, setMode }: { nav: string; go(p: string): void; mode: Mode; setMode(m: Mode): void }) {
  const st = useTraderState();
  const [cls, txt] = TSTAT[st];
  const [open, setOpen] = useState(false);
  const inMenu = MENU.some((m) => m.id === nav);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const c = (e: MouseEvent) => !(e.target as HTMLElement).closest(".menu, .ri.more") && setOpen(false);
    window.addEventListener("keydown", k);
    window.addEventListener("mousedown", c);
    return () => {
      window.removeEventListener("keydown", k);
      window.removeEventListener("mousedown", c);
    };
  }, [open]);
  return (
    <nav className="rail" aria-label="Main">
      <div className="titlebar drag" aria-hidden="true" />
      <div className="logo"><FlowMark size={40} /></div>
      {NAV.map((n, i) => (
        <button key={n.id} className={`ri${nav === n.id ? " on" : ""}`} aria-current={nav === n.id ? "page" : undefined} title={`${n.name} (⌘${i + 1})`} onClick={() => go(n.id)}>
          <Icon k={n.icon} />
          <span>{n.name}</span>
        </button>
      ))}
      <button className={`ri more${inMenu || open ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="More">
        <Icon k="more" />
        <span>More</span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="More">
          <MenuStatus />
          <div className="mdiv" />
          {MENU.map((m) => {
            const soon = "soon" in m && m.soon;
            return (
              <button
                key={m.id}
                role="menuitem"
                className={`mi${nav === m.id ? " on" : ""}`}
                aria-disabled={soon || undefined}
                title={soon ? "HSP payments need merchant access from the organizers; not connected" : undefined}
                onClick={() => {
                  if (soon) return;
                  setOpen(false);
                  go(m.id);
                }}
              >
                <Icon k={m.icon} />
                <span className="grow">{m.name}</span>
                {soon && <b className="soon2">not live</b>}
              </button>
            );
          })}
          <div className="mdiv" />
          <div className="row sb" style={{ padding: "6px 10px" }}>
            <span className="sm">View</span>
            <Seg<Mode> label="Simple or Pro view" value={mode} onChange={setMode} options={[{ id: "simple", label: "Simple" }, { id: "pro", label: "Pro" }]} />
          </div>
        </div>
      )}
      <div className="sp" />
      <div className={`tstat ${cls}`} role="status" aria-live="polite">
        <i aria-hidden="true" />
        {txt.split(" ").map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
    </nav>
  );
}

export function Shell({ nav, chrome = "app", children }: { nav: string; chrome?: "app" | "setup"; setupStep?: number; children: ReactNode }) {
  const { toasts, dismiss } = useApp();
  const [ctx, setCtx] = useState<HTMLElement | null>(null);
  const [insp, setInsp] = useState<HTMLElement | null>(null);
  const [kill, setKill] = useState(false);
  const [mode, setModeS] = useState<Mode>(() => (localStorage.getItem("flow.mode") === "pro" ? "pro" : "simple"));
  const setMode = useCallback((m: Mode) => {
    localStorage.setItem("flow.mode", m);
    setModeS(m);
  }, []);
  const go = useCallback((p: string) => (location.hash = "#/" + p.replace(/^#?\/?/, "")), []);
  const openKill = useCallback(() => setKill(true), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setKill(true);
      } else if (!e.shiftKey && /^[1-4]$/.test(e.key)) {
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
  const pro = mode === "pro";
  return (
    <ShellC.Provider value={{ go, openKill, mode, setMode }}>
      <Slots.Provider value={{ ctx, insp: pro ? insp : null }}>
        <div className={`frame${chrome === "setup" ? " norail" : ""}${pro ? " pro" : " simple"}`}>
          {chrome === "app" && <Rail nav={nav} go={go} mode={mode} setMode={setMode} />}
          {chrome === "app" ? (
            <div className="body shellbody">
              <aside className="ctx" ref={setCtx} aria-label="Filters" />
              <main className="main" id="main">{children}</main>
              {pro && <aside className="insp" ref={setInsp} aria-label="Inspector" />}
            </div>
          ) : (
            <div className="body">{children}</div>
          )}
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

/** Status lives in Home's sentence and here (no footer, per SIMPLIFY.md): network, vaults, agent, chain head. */
function MenuStatus() {
  const { vsOk, stale } = useApp();
  const ev = useEvidence();
  const st = vsOk?.status;
  const paused = st?.vaults.filter((v) => v.paused).length ?? 0;
  const dot = (tone: "ok" | "bad" | "warn", t: ReactNode) => (
    <div className={`sbi ${tone}`}>
      <i aria-hidden="true" />
      {t}
    </div>
  );
  return (
    <div className="mstat" role="status">
      {st ? dot("ok", `${networkName(st.chainId)} · block ${group(st.blockNumber)}`) : dot("warn", "Connecting…")}
      {stale ? dot("bad", "Engine unreachable · limits still hold on-chain") : st && dot(paused ? "bad" : "ok", paused ? (paused === st.vaults.length ? "Both vaults paused" : `${paused} vault paused`) : `${st.vaults.length === 2 ? "Both vaults" : "Vault"} OK`)}
      {st && !stale && dot(st.trader.running ? "ok" : "warn", st.trader.running ? `Agent running · ${dur(st.uptimeSec)}` : "Agent stopped")}
      {ev.lastTx?.execution && <div className="xs fg2" style={{ paddingLeft: 14 }}>Last trade <Link href={explorer.tx(ev.lastTx.execution.txHash)} mono>{short(ev.lastTx.execution.txHash, 6, 4)}</Link> · {clock(ev.lastTx.at).slice(0, 5)}</div>}
    </div>
  );
}
