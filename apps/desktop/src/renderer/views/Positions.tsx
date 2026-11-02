// 40 Positions (+ 41 after go-to-cash). Three marks per market: what you paid (avg cost), what selling now returns
// after fees (exit-executable mark), and HashKey Global's mid. "Go to cash" removes the asset from targetAssets
// (tightening: the guard sells with no AI cycle); the daemon may ask for a Touch ID confirmation because it sells now.
import { useState } from "react";
import { MARKETS, MARKET_IDS, type JournalEntry, type MarketId, type MarketPosition, type TargetAsset } from "@ate/core";
import type { ViewProps } from "./registry";
import { useApp, useRemote } from "../src/app";
import { Inspector, PageHead } from "../src/shell";
import { Badge, Btn, Check, Dialog, Eyebrow, KV, Link, Skeleton, Table, ErrorBox } from "../src/ui";
import { clock, explorer, fmtUnits, money, price8, short, tokenAmt } from "../src/format";
import { clean } from "../src/journal";

export default function Positions(_: ViewProps) {
  const { ate, vsOk, vs, mkOk, toast, refresh } = useApp();
  const strat = useRemote(() => ate.strategy.get(), []);
  const j = useRemote(() => ate.journal.list({ limit: 100, kind: ["execution", "attestation"] }), []);
  const [confirm, setConfirm] = useState<TargetAsset[] | null>(null);
  const [busy, setBusy] = useState(false);

  if (!vsOk) return vs && !vs.ok ? <><PageHead title="Positions" /><ErrorBox code={vs.error.code} message="Can't read positions" hint={vs.error.message} action={<Btn kind="solid" onClick={refresh}>Retry</Btn>} /></> : <PositionsLoading />;
  const pos = vsOk.positions;
  const s = strat.last?.strategy;
  const targets = s?.portfolio.targetAssets ?? (MARKET_IDS.map((m) => MARKETS[m].base) as TargetAsset[]);
  const n = (x: string) => Number(x);
  const inVaults = pos.markets.reduce((a, p) => a + Number(p.balanceQuote) / 1e6 + n(p.exposureUsd), 0);
  const feeDrag = pos.markets.reduce((a, p) => a + n(p.feeDragUsd), 0);
  const held = pos.markets.filter((p) => BigInt(p.qty) > 0n);

  /** Apply a targetAssets change; a sells-now confirm or a loosening comes back as ATE_APPROVAL_REQUIRED → Touch ID. */
  const setTargets = async (next: TargetAsset[], why: string) => {
    setBusy(true);
    const r = await ate.strategy.set({ targetAssets: next }, why);
    let fail = r.ok ? null : r.error;
    if (!r.ok && r.error.code === "ATE_APPROVAL_REQUIRED" && typeof r.error.details?.changeId === "string") {
      const a = await ate.strategy.approve(r.error.details.changeId);
      fail = a.ok ? null : a.error;
    }
    setBusy(false);
    setConfirm(null);
    strat.reload();
    refresh();
    if (fail) toast({ kind: "error", text: `Not applied: ${fail.code}`, sub: fail.message });
    else toast({ kind: "ok", text: next.length < targets.length ? `Going to cash: the guard is selling ${targets.filter((t) => !next.includes(t)).join(" and ")}` : `Trading ${next.filter((t) => !targets.includes(t)).join(", ")} again`, sub: "Target assets: " + (next.length ? next.join(", ") : "none (all cash)") });
  };

  const lastGuardSale = (m: MarketId): { e: JournalEntry; att?: JournalEntry } | null => {
    const e = (j.last?.entries ?? []).find((x) => x.kind === "execution" && x.market === m && x.intent?.side === "sell" && x.execution && !x.execution.reverted);
    if (!e) return null;
    return { e, att: (j.last?.entries ?? []).find((x) => x.kind === "attestation" && x.refId === e.refId) };
  };

  return (
    <>
      <PageHead
        title="Positions"
        sub="Three marks: what you paid, what selling now returns after fees, and HashKey Global's mid"
        acts={<Btn disabled={!held.length || busy} onClick={() => setConfirm([])}>Go to cash · both</Btn>}
      />
      <section className="card dk" style={{ padding: "18px 24px" }} aria-label="Portfolio marks">
        <div className="grid" style={{ gridTemplateColumns: "repeat(4,1fr)", gap: 0 }}>
          <Hero label="In the vaults" value={money(inVaults)} />
          <Hero label="Realised today" value={signed(n(pos.portfolio.realisedUsd))} tone={n(pos.portfolio.realisedUsd)} sep />
          <Hero label="If sold now" value={signed(n(pos.portfolio.unrealisedExitUsd))} tone={n(pos.portfolio.unrealisedExitUsd)} sep />
          <Hero label="At CEX mark" value={signed(n(pos.portfolio.unrealisedCexUsd))} sep />
        </div>
      </section>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 16 }}>
        {MARKET_IDS.map((m) => {
          const p = pos.markets.find((x) => x.market === m);
          if (!p) return null;
          const base = MARKETS[m].base as TargetAsset;
          const isTarget = targets.includes(base);
          const cash = BigInt(p.qty) === 0n;
          const sl = s?.markets[m]?.stopLossBps;
          const sale = cash ? lastGuardSale(m) : null;
          return (
            <MarketCard
              key={m}
              p={p}
              isTarget={isTarget}
              cash={cash}
              stopLossBps={sl}
              sale={sale}
              busy={busy}
              mark={mkOk?.find((x) => x.market === m)?.exitMark ?? null}
              onCash={() => setConfirm(targets.filter((t) => t !== base))}
              onAgain={() => void setTargets([...targets, base], `Trade ${MARKETS[m].label} again (desktop Positions)`)}
            />
          );
        })}
      </div>

      <Inspector>
        <div className="sec">
          <Eyebrow>Portfolio guard</Eyebrow>
          <KV k="Exposure">{money(n(pos.portfolio.exposureUsd))} of {money(n(pos.portfolio.maxPortfolioExposureUsd), 0)}</KV>
          <KV k="Turnover today">{money(n(pos.portfolio.turnoverUsedUsd))} of {s ? money(n(s.portfolio.maxDailyTurnoverUsd), 0) : money(n(pos.portfolio.turnoverUsedUsd) + n(pos.portfolio.turnoverRemainingUsd))}</KV>
          <KV k="Daily loss breaker" vClass={pos.portfolio.breaker === "armed" ? "ok" : "bad b7"}>
            {pos.portfolio.breaker === "armed" ? "✓ armed" : pos.portfolio.breaker === "flattening" ? "! flattening" : "✕ tripped"}
            {s ? ` · −${money(n(s.portfolio.dailyLossLimitUsd), 0).replace("$", "$")}` : ""}
          </KV>
          <KV k="Target assets">{targets.length ? targets.join(", ") : "none · all cash"}</KV>
        </div>
        <div className="sec">
          <Eyebrow>Fee drag today</Eyebrow>
          <div className="big num">{money(feeDrag)}</div>
          <div className="xs mt4" style={{ color: "var(--sage)" }}>pool fees + impact, both vaults</div>
        </div>
        <div className="xs" style={{ marginTop: "auto", color: "var(--sage)", paddingTop: 16 }}>Price risk on held exposure is managed by the stop-loss, not the contract.</div>
      </Inspector>

      <GoToCashDialog
        next={confirm}
        current={targets}
        positions={pos.markets}
        busy={busy}
        onClose={() => !busy && setConfirm(null)}
        onConfirm={(next) => void setTargets(next, next.length ? `Go to cash on ${targets.filter((t) => !next.includes(t)).join(", ")} (desktop Positions)` : "Go to cash on both markets (desktop Positions)")}
      />
    </>
  );
}

const signed = (v: number): string => (v > 0 ? "+" : "") + money(v);

function Hero({ label, value, tone, sep }: { label: string; value: string; tone?: number; sep?: boolean }) {
  const cls = tone === undefined ? "" : tone > 0 ? "ok" : tone < 0 ? "bad" : "";
  return (
    <div style={sep ? { borderLeft: "1px solid rgba(183,198,194,.16)", paddingLeft: 22 } : undefined}>
      <div className="lbl" style={{ color: "var(--sage)" }}>{label}</div>
      <div className={`big mt8 num ${cls}`}>
        {value}
        {tone !== undefined && tone !== 0 && <span className="sr">{tone > 0 ? " gain" : " loss"}</span>}
      </div>
    </div>
  );
}

function Delta({ usd, bps }: { usd: string; bps?: number }) {
  const v = Number(usd);
  const cls = v > 0 ? "ok b7" : v < 0 ? "bad b7" : "b7";
  return (
    <span className={cls}>
      <span aria-hidden="true">{v > 0 ? "▲ " : v < 0 ? "▼ " : "■ "}</span>
      {signed(v)}
      {bps !== undefined && ` · ${bps > 0 ? "+" : bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(1)}%`}
      <span className="sr">{v > 0 ? " gain" : v < 0 ? " loss" : ""}</span>
    </span>
  );
}

function MarketCard({ p, isTarget, cash, stopLossBps, sale, busy, onCash, onAgain }: { p: MarketPosition; isTarget: boolean; cash: boolean; stopLossBps?: number; sale: { e: JournalEntry; att?: JournalEntry } | null; busy: boolean; mark: string | null; onCash(): void; onAgain(): void }) {
  const mk = MARKETS[p.market];
  const stopPx = p.avgEntry && stopLossBps !== undefined ? ((BigInt(p.avgEntry) * BigInt(10_000 - stopLossBps)) / 10_000n).toString() : null;
  const badge = isTarget ? <Badge tone="ok">target asset</Badge> : cash ? <Badge tone="info" glyph="$">in cash</Badge> : <Badge tone="warn">selling to cash</Badge>;
  const action = isTarget ? (
    <Btn size="sm" disabled={cash || busy} onClick={onCash} title={cash ? "Nothing to sell" : undefined}>Go to cash on {mk.label}</Btn>
  ) : (
    <Btn size="sm" disabled={busy} onClick={onAgain}>Trade {mk.label} again</Btn>
  );
  const openLots = p.lots.filter((l) => BigInt(l.qtyRemaining) > 0n);
  const closedLots = p.lots.filter((l) => BigInt(l.qtyRemaining) === 0n);
  return (
    <section className="card" style={!isTarget && cash ? { border: "2px solid var(--c)" } : undefined} aria-label={`${mk.base}/${mk.quote} position`}>
      <div className="ch">
        <div className="row g10 base">
          <h2 className="h3">{mk.base}/{mk.quote}</h2>
          {badge}
        </div>
        {action}
      </div>
      <KV k="Holding" className="sm">{tokenAmt(p.qty, mk.baseDecimals)} {mk.base}{cash ? "" : ` · ${money(Number(p.exposureUsd))}`}</KV>
      <KV k="Cash" className="sm" vClass={cash ? "b7" : ""}>{tokenAmt(p.balanceQuote, 6)} USDT</KV>
      {cash && sale ? (
        <>
          <KV k="Last sale" className="sm">{sale.e.intent ? `${tokenAmt(sale.e.intent.amountIn, mk.baseDecimals)} ${mk.base} → ${tokenAmt(sale.e.execution!.amountOut, 6)} USDT` : "—"}</KV>
          <KV k="Realised today" className="sm"><Delta usd={p.realisedUsd} /></KV>
          <KV k="Reason" className="sm">{sale.e.origin === "guard" ? "target_assets · guard, no AI" : clean(sale.e.rationale).slice(0, 60)}</KV>
          <div className="card soft tight" style={{ marginTop: 14 }}>
            <div className="xs">
              <b>{clock(sale.e.at)}</b> · {sale.e.origin === "guard" ? "guard exit" : "sale"} · <Link href={explorer.tx(sale.e.execution!.txHash)} mono>{short(sale.e.execution!.txHash, 6, 4)}</Link>
              {sale.att?.attestation && <> · EAS <Link href={explorer.tx(sale.att.attestation.txHash)} mono>{short(sale.att.attestation.easUid, 6, 4)}</Link></>}
            </div>
          </div>
        </>
      ) : (
        <>
          <KV k="Avg cost" className="sm">{p.avgEntry ? price8(p.avgEntry) : "—"}</KV>
          <KV k="If sold now" className="sm"><Delta usd={p.unrealisedExitUsd} bps={p.unrealisedExitBps} /></KV>
          <KV k="At CEX mark" className="sm"><Delta usd={p.unrealisedCexUsd} bps={p.unrealisedCexBps} /></KV>
          <KV k="Realised today" className="sm"><Delta usd={p.realisedUsd} /></KV>
          <KV k="Stop-loss" className="sm">{stopLossBps !== undefined ? `${stopLossBps} bps${stopPx ? " · " + price8(stopPx) : ""}` : "—"}</KV>
          {p.reentryLockUntil && <KV k="Re-entry" className="sm">locked until {clock(p.reentryLockUntil)}</KV>}
        </>
      )}
      {p.lots.length > 0 && (
        <>
          <div className="lbl" style={{ marginTop: 14 }}>Lots · spread-revert ledger</div>
          <Table
            compact
            className="xs"
            caption="Lots"
            rowKey={(l) => l.id}
            rows={[...openLots, ...closedLots].slice(0, 4)}
            cols={[
              { key: "w", label: "Opened", render: (l) => `${l.closedAt ? "closed" : "open"} (${clock(l.openedAt).slice(0, 5)})` },
              { key: "q", label: "Qty @ entry", align: "r", render: (l) => `${tokenAmt(l.closedAt ? l.qtyOpen : l.qtyRemaining, mk.baseDecimals)} @ ${price8(l.entryPrice).replace("$", "")}` },
              { key: "r", label: "Realised", align: "r", render: (l) => (l.closedAt ? <Delta usd={l.realisedUsd} /> : <span className="fg2">pending</span>) },
            ]}
          />
        </>
      )}
    </section>
  );
}

function GoToCashDialog({ next, current, positions, busy, onClose, onConfirm }: { next: TargetAsset[] | null; current: TargetAsset[]; positions: MarketPosition[]; busy: boolean; onClose(): void; onConfirm(n: TargetAsset[]): void }) {
  if (!next) return null;
  const selling = current.filter((t) => !next.includes(t));
  const ps = positions.filter((p) => selling.includes(MARKETS[p.market].base as TargetAsset) && BigInt(p.qty) > 0n);
  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!busy}
      eyebrow="Go to cash · sells now"
      title={<>Sell {selling.length > 1 ? "both" : selling[0]} <span className="hl">now?</span></>}
      footer={
        <>
          <span className="xs fg2 grow" role="status">{busy ? "Applying… confirm with Touch ID if asked" : "Tightening: applies at once, no AI cycle"}</span>
          <Btn onClick={onClose} disabled={busy} data-autofocus>Cancel</Btn>
          <Btn kind="danger" size="lg" disabled={busy} onClick={() => onConfirm(next)}>{busy ? "Selling…" : `Go to cash on ${selling.join(" + ")}`}</Btn>
        </>
      }
    >
      {ps.map((p) => {
        const mk = MARKETS[p.market];
        return (
          <Check key={p.market} state="warn" aside={`if sold now ${signed(Number(p.unrealisedExitUsd))}`}>
            The guard sells <b>{fmtUnits(p.qty, mk.baseDecimals, 2)} {mk.base}</b> ({money(Number(p.exposureUsd))}) on the exit path, floored at min(oracle, TWAP).
          </Check>
        );
      })}
      <Check state="ok">Target assets become <b>{next.length ? next.join(", ") : "none (all cash)"}</b>. The agent stops buying {selling.join(" and ")}.</Check>
      <Check state="ok">Each sale passes the same vault checks and is journalled as yours, with a tx and an EAS attestation.</Check>
    </Dialog>
  );
}

function PositionsLoading() {
  return (
    <>
      <PageHead title="Positions" sub="Reading balances and marks…" />
      <div className="card dk" style={{ height: 96, padding: 20 }} aria-busy="true"><Skeleton h={40} style={{ background: "rgba(183,198,194,.12)" }} /></div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 16 }}>
        {[0, 1].map((i) => <div key={i} className="card" style={{ height: 320 }}>{[0, 1, 2, 3, 4, 5].map((k) => <Skeleton key={k} h={12} style={{ margin: "16px 0" }} />)}</div>)}
      </div>
    </>
  );
}
