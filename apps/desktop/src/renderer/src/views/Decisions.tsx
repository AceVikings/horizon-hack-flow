import { useMemo, useState } from "react";
import { MARKET_IDS, MARKETS, type JournalEntry, type MarketId } from "@ate/core";
import { useApp, useRemote } from "../app";
import { ContextPanel, Inspector } from "../shell";
import { Badge, Empty, ErrorBox, KV, Link, TxLink, type Tone } from "../ui";
import { bps, clock, dateTime, dayKey, explorer, fmtUnits, label, px8, short } from "../format";

type FilterId = "all" | "trade" | "no_trade" | "rejected" | "exit" | "discretionary" | "payment";
const FILTERS: { id: FilterId; name: string }[] = [
  { id: "all", name: "All" }, { id: "trade", name: "Trades" }, { id: "no_trade", name: "No-trade" }, { id: "rejected", name: "Rejected" },
  { id: "exit", name: "Exit-path" }, { id: "discretionary", name: "Discretionary" }, { id: "payment", name: "Payment" },
];

const marketOf = (e: JournalEntry): MarketId | undefined => (e.market ?? (e.intent?.market as MarketId | undefined));
function matches(e: JournalEntry, f: FilterId): boolean {
  switch (f) {
    case "all": return true;
    case "trade": return e.kind === "execution" || (e.kind === "proposal" && e.verdict.ok);
    case "no_trade": return e.kind === "no_trade";
    case "rejected": return !e.verdict.ok;
    case "exit": return !!e.execution?.exitPath || e.context.quote?.exitPath === true || e.origin === "guard";
    case "discretionary": return e.origin === "discretionary";
    case "payment": return e.kind === "payment" || e.kind === "payment_update";
  }
}

function verdictOf(e: JournalEntry): { tone: Tone; text: string } {
  if (!e.verdict.ok) return { tone: "bad", text: `rejected ${e.verdict.code}` };
  if (e.kind === "no_trade") return { tone: "mute", text: `no trade${e.verdict.message ? ` · ${e.verdict.message}` : ""}` };
  if (e.kind === "execution") return { tone: e.execution?.reverted ? "bad" : "ok", text: e.execution?.reverted ? "reverted" : "executed" };
  if (e.kind === "outcome") return { tone: e.outcome && e.outcome.savedBps >= 0 ? "ok" : "warn", text: `saved ${bps(e.outcome?.savedBps)}` };
  if (e.kind === "proposal") return { tone: "info", text: `proposed${e.verdict.approvedBy ? ` · ${e.verdict.approvedBy}` : ""}` };
  return { tone: "mute", text: e.kind.replace("_", " ") };
}

function summary(e: JournalEntry): string {
  if (e.intent) {
    const m = MARKETS[e.intent.market as MarketId];
    const buy = e.intent.side === "buy";
    const amt = buy ? `${fmtUnits(e.intent.amountIn, 6)} USDT` : `${fmtUnits(e.intent.amountIn, m.baseDecimals)} ${m.base}`;
    return `${e.intent.side.toUpperCase()} ${amt}`;
  }
  if (e.execution) return `amountOut ${e.execution.amountOut}${e.execution.exitPath ? " · exit path" : ""}`;
  return e.rationale.slice(0, 90);
}

export default function Decisions() {
  const { ate } = useApp();
  const [f, setF] = useState<FilterId>("all");
  const [mkt, setMkt] = useState<MarketId | "">("");
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { res, loading } = useRemote(() => ate.journal.list({ limit: 200, ...(mkt ? { market: mkt } : {}) }), [mkt], { every: 15000 });

  const rows = useMemo(() => (res?.ok ? res.data.entries.filter((e) => matches(e, f)).sort((a, b) => b.at - a.at) : []), [res, f]);
  const days = useMemo(() => {
    const g = new Map<string, JournalEntry[]>();
    for (const e of rows) g.set(dayKey(e.at), [...(g.get(dayKey(e.at)) ?? []), e]);
    return [...g.entries()];
  }, [rows]);
  const selected = res?.ok ? res.data.entries.find((e) => e.id === sel) : undefined;
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((x) => [x.id, res?.ok ? res.data.entries.filter((e) => matches(e, x.id)).length : 0])), [res]);

  return (
    <>
      <ContextPanel>
        <h2>Filters</h2>
        <div className="chips" role="group" aria-label="Record type">
          {FILTERS.map((x) => (
            <button key={x.id} className={`chip ${f === x.id ? "on" : ""}`} onClick={() => setF(x.id)} aria-pressed={f === x.id}>
              {x.name} <span className="num muted">{counts[x.id]}</span>
            </button>
          ))}
        </div>
        <h2>Market</h2>
        <div className="chips" role="group" aria-label="Market">
          <button className={`chip ${mkt === "" ? "on" : ""}`} onClick={() => setMkt("")} aria-pressed={mkt === ""}>Both</button>
          {MARKET_IDS.map((m) => (
            <button key={m} className={`chip ${mkt === m ? "on" : ""}`} onClick={() => setMkt(m)} aria-pressed={mkt === m}>{MARKETS[m].base}/USDT</button>
          ))}
        </div>
        <h2>Journal head</h2>
        {res?.ok ? (
          <>
            <KV k="records" >{res.data.head.seq}</KV>
            <div className="mono wrap small" title={res.data.head.hash}>{res.data.head.hash}</div>
            <p className="muted small">Hash chain: each record commits to the previous. Only executed trades carry an on-chain rationale hash.</p>
          </>
        ) : <span className="muted">—</span>}
      </ContextPanel>

      {res && !res.ok && <ErrorBox {...res.error} />}
      {loading && !res && <div className="muted">Loading journal…</div>}
      {res?.ok && rows.length === 0 && <Empty title="No decisions yet">The trader writes a record every cycle, including when it decides not to trade. {f !== "all" && "Try the All filter."}</Empty>}

      <div className="timeline">
        {days.map(([day, es]) => (
          <section key={day}>
            <h2 className="dayhead">{day}</h2>
            {es.map((e) => {
              const v = verdictOf(e);
              const isOpen = open.has(e.id);
              return (
                <article key={e.id} className={`drow ${sel === e.id ? "sel" : ""}`}>
                  <button
                    data-testid="row"
                    className="dhead"
                    aria-expanded={isOpen}
                    onClick={() => {
                      setSel(e.id);
                      setOpen((o) => { const n = new Set(o); n.has(e.id) ? n.delete(e.id) : n.add(e.id); return n; });
                    }}
                  >
                    <span className="num t">{clock(e.at)}</span>
                    <span className="kind">{e.kind.replace("_", " ")}</span>
                    <span className="mk">{label(marketOf(e))}</span>
                    <span className="sum">{summary(e)}</span>
                    <span className="tags">
                      {e.context.signal && <Badge tone="info">{e.context.signal.generator}</Badge>}
                      {e.origin && <Badge>{e.origin}</Badge>}
                      <Badge>{e.engine}</Badge>
                      {e.execution?.exitPath && <Badge tone="warn">exit path</Badge>}
                    </span>
                    <Badge tone={v.tone}>{v.text}</Badge>
                    <span aria-hidden="true" className="chev">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && <Record e={e} />}
                </article>
              );
            })}
          </section>
        ))}
      </div>

      <Inspector>
        <h2>Record</h2>
        {selected ? (
          <>
            <KV k="id" mono>{selected.id}</KV>
            <KV k="seq">{selected.seq}</KV>
            <KV k="at">{dateTime(selected.at)}</KV>
            <KV k="actor">{selected.actor.kind}{selected.actor.via ? ` via ${selected.actor.via}` : ""}</KV>
            <KV k="profile">{selected.profile}</KV>
            <div className="small muted">hash</div><div className="mono wrap small">{selected.hash}</div>
            <div className="small muted">prevHash</div><div className="mono wrap small">{selected.prevHash}</div>
            <div className="small muted">rationaleHash</div><div className="mono wrap small">{selected.rationaleHash}</div>
            <details><summary>Raw JSON</summary><pre className="raw">{JSON.stringify(selected, null, 2)}</pre></details>
          </>
        ) : <p className="muted">Select a record to see its hashes and raw JSON.</p>}
      </Inspector>
    </>
  );
}

function Record({ e }: { e: JournalEntry }) {
  const c = e.context;
  return (
    <div className="record">
      <div className="rat">
        <div className="small muted">Rationale{e.thesis ? " and thesis" : ""}</div>
        <p>{e.rationale}</p>
        {e.thesis && <p><b>Thesis:</b> {e.thesis}</p>}
        {e.verdict.message && <p className="small"><b>Verdict:</b> {e.verdict.code} · {e.verdict.message}</p>}
      </div>
      <div className="grid3">
        <div>
          <h4>Oracle (APRO)</h4>
          <KV k="price">${px8(c.oracle.price, 2)}</KV>
          <KV k="age">{c.oracle.ageSec} s</KV>
          <KV k="round" mono>{short(c.oracle.roundId, 6, 4)}</KV>
        </div>
        <div>
          <h4>Pool</h4>
          <KV k="spot">${px8(c.pool.price, 2)}</KV>
          <KV k="TWAP">${px8(c.pool.twap, 2)}</KV>
          <KV k="oracle deviation">{bps(c.pool.deviationBps)}</KV>
          <KV k="TWAP deviation">{bps(c.pool.twapDeviationBps)}</KV>
        </div>
        <div>
          <h4>CEX reference</h4>
          {c.cex ? <><KV k="mid">${px8(c.cex.mid, 2)}</KV><KV k="half-spread">{c.cex.halfSpreadBps} bps</KV><KV k="top depth">${c.cex.topDepthUsd}</KV></> : <span className="muted">none</span>}
        </div>
      </div>
      {c.signal && <p className="small"><b>Signal:</b> {c.signal.generator}{c.signal.leg ? ` (${c.signal.leg})` : ""} · gap {c.signal.edgeBps} bps · cost {c.signal.costBps} bps · net {c.signal.edgeBps - c.signal.costBps} bps</p>}
      {c.suppressed && <p className="small"><b>Suppressed:</b> {c.suppressed.cause} on {c.suppressed.side} ({c.suppressed.bps} bps)</p>}
      {c.quote && <p className="small"><b>Quote:</b> out {c.quote.amountOut} · impact {c.quote.impactBps} bps · minOutFloor {c.quote.minOutFloor} · {c.quote.exitPath ? "exit path" : "normal path"} · {c.quote.source}</p>}
      <p className="small"><b>Policy:</b> trade cap ${c.policy.maxTradeUsd} · epoch left ${c.policy.epochRemainingUsd} · turnover left ${c.policy.turnoverRemainingUsd} · cooldown {c.policy.cooldownRemainingSec} s · block {c.blockNumber}</p>
      {e.outcome && <p className="small"><b>Outcome (30 min):</b> declined {e.outcome.declinedAmountIn} · mark then ${px8(e.outcome.markThen)} · saved {bps(e.outcome.savedBps)} (${e.outcome.savedUsd})</p>}
      <div className="links">
        {e.execution && <span>Trade tx <TxLink hash={e.execution.txHash} /> · block {e.execution.blockNumber} · gas {e.execution.gasUsed}</span>}
        {e.attestation && <><span>Attest tx <TxLink hash={e.attestation.txHash} /></span><span>EAS UID <Link href={explorer.attestation(e.attestation.easUid)} title={e.attestation.easUid}>{short(e.attestation.easUid, 10, 8)}</Link> (getAttestation)</span></>}
        {e.intent && <span>Vault <Link href={explorer.address(e.intent.vault)} title={e.intent.vault}>{e.intent.vault}</Link></span>}
        {e.refId && <span>Refers to <span className="mono">{e.refId}</span></span>}
      </div>
    </div>
  );
}
