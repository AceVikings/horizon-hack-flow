// 20 Decisions (journal timeline, filters, selected-record inspector) and 21 Decision record (`#/decisions/<id>`).
import { useEffect, useMemo, useRef, useState } from "react";
import { MARKETS, MARKET_IDS, type JournalEntry, type MarketId } from "@ate/core";
import type { ViewProps } from "./registry";
import { useApp, useRemote } from "../src/app";
import { ContextPanel, Inspector, PageHead, useMode, useNav } from "../src/shell";
import { Badge, Btn, Card, Check, Empty, ErrorBox, Eyebrow, Gauge, KV, Link, Pill, Skeleton, TxLink } from "../src/ui";
import { clock, dayKey, dayName, explorer, int, money, price8, short, tokenAmt } from "../src/format";
import { REASON, SHOW, clean, decidedBy, kindLabel, marketOf, result, summary, tag, tradeLine, type ShowKey } from "../src/journal";

const HIDDEN = new Set(["attestation", "oracle_refresh", "payment_update"]);
const SHOW_LABEL: Record<ShowKey, string> = { all: "All", trades: "Trades", notrade: "No trade", rejected: "Rejected", exit: "Exit path", discretionary: "Discretionary", you: "You" };
type By = "any" | "AI" | "guard" | "rules";

export default function Decisions({ params }: ViewProps) {
  return params[0] ? <Record id={params[0]} /> : <Timeline />;
}

/** Shared journal page (newest first), with "load older". */
function useJournal() {
  const { ate } = useApp();
  const [older, setOlder] = useState<JournalEntry[]>([]);
  const [more, setMore] = useState(true);
  const j = useRemote(() => ate.journal.list({ limit: 200 }), []);
  const entries = useMemo(() => {
    const seen = new Set<string>();
    return [...(j.last?.entries ?? []), ...older].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  }, [j.last, older]);
  const loadOlder = async () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    const r = await ate.journal.list({ limit: 200, before: last.at });
    if (r.ok) {
      setOlder((o) => [...o, ...r.data.entries]);
      if (r.data.entries.length < 200) setMore(false);
    }
  };
  return { j, entries, head: j.last?.head ?? null, loadOlder, more: more && (j.last?.entries.length ?? 0) >= 200 };
}

function Timeline() {
  const go = useNav();
  const { j, entries, head, loadOlder, more } = useJournal();
  const [show, setShow] = useState<ShowKey>("all");
  const [market, setMarket] = useState<MarketId | "both">("both");
  const [by, setBy] = useState<By>("any");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const base = entries.filter((e) => !HIDDEN.has(e.kind));
  const inMarket = base.filter((e) => market === "both" || marketOf(e) === market);
  const rows = inMarket.filter((e) => SHOW[show](e) && (by === "any" || decidedBy(e) === by) && (!q || (summary(e) + " " + clean(e.rationale) + " " + e.id).toLowerCase().includes(q.toLowerCase())));
  const selected = rows.find((e) => e.id === sel) ?? rows[0] ?? null;
  const linked = entries.every((e, i) => i === entries.length - 1 || entries[i + 1]!.seq !== e.seq - 1 || entries[i + 1]!.hash === e.prevHash);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const move = (d: number) => {
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, rows.findIndex((r) => r.id === selected?.id) + d));
    setSel(rows[i]!.id);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${rows[i]!.id}"]`)?.focus();
  };

  // group by local day
  const groups: { key: string; at: number; rows: JournalEntry[] }[] = [];
  for (const e of rows) {
    const k = dayKey(e.at);
    const g = groups[groups.length - 1];
    if (g && g.key === k) g.rows.push(e);
    else groups.push({ key: k, at: e.at, rows: [e] });
  }
  const todayKey = dayKey(Math.floor(Date.now() / 1000));

  return (
    <>
      <ContextPanel>
        <Eyebrow>Show</Eyebrow>
        <div className="flt" style={{ margin: "10px 0 18px" }}>
          {(Object.keys(SHOW) as ShowKey[]).map((k) => (
            <Pill key={k} on={show === k} onClick={() => setShow(k)} count={inMarket.filter(SHOW[k]).length}>
              {SHOW_LABEL[k]}
            </Pill>
          ))}
        </div>
        <Eyebrow>Market</Eyebrow>
        <div className="flt" style={{ margin: "10px 0 18px" }}>
          <Pill on={market === "both"} onClick={() => setMarket("both")}>Both</Pill>
          {MARKET_IDS.map((m) => (
            <Pill key={m} on={market === m} onClick={() => setMarket(m)}>
              {MARKETS[m].base}/{MARKETS[m].quote}
            </Pill>
          ))}
        </div>
        <Eyebrow>Decided by</Eyebrow>
        <div className="flt" style={{ margin: "10px 0 18px" }}>
          {(["any", "AI", "guard", "rules"] as By[]).map((b) => (
            <Pill key={b} on={by === b} onClick={() => setBy(b)}>
              {b === "any" ? "Anyone" : b === "guard" ? "Guard" : b === "rules" ? "Rules" : "AI"}
            </Pill>
          ))}
        </div>
        <Eyebrow>Journal</Eyebrow>
        <KV k="Records" className="sm mt8">{head ? int(head.seq) : "—"}</KV>
        <KV k="Head" mono className="sm">{head ? short(head.hash, 6, 4) : "—"}</KV>
        <KV k="Chain" className="sm" vClass={linked ? "ok b7" : "bad b7"}>
          {linked ? "✓ linked" : "✕ gap"}
        </KV>
        <div className="xs fg2" style={{ lineHeight: 1.5, marginTop: 8 }}>
          Each record commits to the one before it (prevHash). Executed trades carry the record hash on-chain as the proposalId.
        </div>
        <div style={{ marginTop: "auto", paddingTop: 16 }} className="col g8">
          <Btn size="sm" onClick={() => exportJournal(entries)} disabled={!entries.length}>
            Export journal
          </Btn>
        </div>
      </ContextPanel>

      <PageHead
        title="Decisions"
        sub="Every trade and every skipped trade, with the reason"
        acts={
          <label className="inp search">
            <span className="sr">Search reasons</span>
            <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reasons…" />
            <span className="xs fg2" aria-hidden="true">⌘F</span>
          </label>
        }
      />
      {j.res && !j.res.ok && !j.last ? (
        <ErrorBox code={j.res.error.code} message="Can't read the journal" hint={j.res.error.message} action={<Btn kind="solid" onClick={j.reload}>Retry</Btn>} />
      ) : !j.last ? (
        <div className="tl" aria-busy="true">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} h={44} style={{ borderRadius: 12 }} />)}</div>
      ) : rows.length === 0 ? (
        <Empty title={base.length ? "Nothing matches" : "No decisions yet"}>{base.length ? "Clear a filter or the search." : "The first trader cycle records a decision here, including skipped trades."}</Empty>
      ) : (
        <div ref={listRef} onKeyDown={(e) => (e.key === "ArrowDown" ? (e.preventDefault(), move(1)) : e.key === "ArrowUp" ? (e.preventDefault(), move(-1)) : undefined)}>
          {groups.map((g) => (
            <section key={g.key} aria-label={dayName(g.at)} style={{ marginBottom: 14 }}>
              <h2 className="dayh">{g.key === todayKey ? "Today · " : ""}{dayName(g.at)}</h2>
              <div className="tl" role="listbox" aria-label={`Decisions ${dayName(g.at)}`}>
                {g.rows.map((e) => (
                  <TRow key={e.id} e={e} sel={selected?.id === e.id} onSelect={() => setSel(e.id)} onOpen={() => go("activity/" + e.id)} />
                ))}
              </div>
            </section>
          ))}
          {more && (
            <div className="c" style={{ margin: "8px 0 16px" }}>
              <Btn size="sm" onClick={() => void loadOlder()}>Load older</Btn>
            </div>
          )}
        </div>
      )}

      <Inspector>{selected ? <SelectedRecord e={selected} entries={entries} onOpen={() => go("activity/" + selected.id)} /> : <span className="sm" style={{ color: "var(--sage)" }}>Select a record.</span>}</Inspector>
    </>
  );
}

function TRow({ e, sel, onSelect, onOpen }: { e: JournalEntry; sel: boolean; onSelect(): void; onOpen(): void }) {
  const r = result(e);
  const who = decidedBy(e);
  const exit = e.kind === "execution" && e.execution?.exitPath;
  const tl = e.kind === "execution" ? tradeLine(e) : null;
  return (
    <button
      className={`tr2${sel ? " sel" : ""}`}
      data-id={e.id}
      role="option"
      aria-selected={sel}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onFocus={onSelect}
      onKeyDown={(k) => k.key === "Enter" && (k.preventDefault(), onOpen())}
    >
      <span className="t">{clock(e.at)}</span>
      <span className="k">{kindLabel(e)}</span>
      <span className="m">{tag(e)}</span>
      <span className="x" title={clean(e.rationale)}>
        {tl && sel ? <b>{tl}</b> : summary(e)}
      </span>
      <span className="bs">
        {exit && <Badge tone="warn">exit path</Badge>}
        {who !== "you" ? (r.text !== "executed" || !exit ? <Badge glyph="">{who}</Badge> : null) : <Badge glyph="">you</Badge>}
        <Badge tone={r.tone} glyph={r.glyph}>{r.text}</Badge>
      </span>
    </button>
  );
}

function SelectedRecord({ e, entries, onOpen }: { e: JournalEntry; entries: JournalEntry[]; onOpen(): void }) {
  const att = e.refId ? entries.find((x) => x.kind === "attestation" && x.refId === e.refId) : undefined;
  return (
    <>
      <div className="sec">
        <Eyebrow>Selected record</Eyebrow>
        <div className="h3" style={{ fontSize: 26, margin: "4px 0 10px" }}>{headline(e)}</div>
        <KV k="id" mono>{e.id}</KV>
        <KV k="at">{dayName(e.at)} · {clock(e.at)}</KV>
        <KV k="decided by">{actorLine(e)}</KV>
        {e.context.signal && <KV k="signal">{e.context.signal.generator}{e.context.signal.leg ? ` · ${e.context.signal.leg}` : ""}</KV>}
        <KV k="profile">{e.profile}</KV>
      </div>
      {(e.execution || e.kind === "proposal" || att) && (
        <div className="sec">
          <Eyebrow>On-chain</Eyebrow>
          <KV k="trade tx">{e.execution ? <TxLink hash={e.execution.txHash} /> : "—"}</KV>
          <KV k="block">{e.execution ? int(e.execution.blockNumber) : int(e.context.blockNumber)}</KV>
          <KV k="attestation">{att?.attestation ? <Link href={explorer.tx(att.attestation.txHash)} mono>EAS {short(att.attestation.easUid, 6, 4)}</Link> : "—"}</KV>
          <KV k="rationale hash" mono>{short(e.rationaleHash, 6, 4)}</KV>
        </div>
      )}
      <div className="sec">
        <Eyebrow>Hash chain</Eyebrow>
        <div className="lbl" style={{ color: "var(--sage)", marginBottom: 4 }}>hash</div>
        <div className="addr">{e.hash}</div>
        <div className="lbl" style={{ color: "var(--sage)", margin: "10px 0 4px" }}>prev</div>
        <div className="addr">{e.prevHash}</div>
      </div>
      <div style={{ marginTop: "auto", paddingTop: 16 }}>
        <Btn kind="pri" style={{ width: "100%" }} onClick={onOpen}>Open record</Btn>
      </div>
    </>
  );
}

const actorLine = (e: JournalEntry): string => {
  const who = decidedBy(e);
  if (who === "you") return `You${e.actor.via ? " · " + e.actor.via : ""}`;
  if (who === "guard") return "Guard · no AI";
  if (who === "rules") return "Rules engine";
  return `AI${e.actor.via ? " via " + e.actor.via.toUpperCase() : ""}${e.actor.agentId ? " · " + e.actor.agentId : ""}`;
};

/** Display headline for a record: "Bought $25.00 WBTC", "No trade on BTC"… */
function headline(e: JournalEntry): string {
  const m = marketOf(e);
  const mk = m ? MARKETS[m] : undefined;
  if ((e.kind === "execution" || e.kind === "proposal") && e.intent && mk) {
    const verb = e.kind === "execution" ? (e.intent.side === "buy" ? "Bought" : "Sold") : e.intent.side === "buy" ? "Buy" : "Sell";
    return e.intent.side === "buy" ? `${verb} $${tokenAmt(e.intent.amountIn, 6)} ${mk.base}` : `${verb} ${tokenAmt(e.intent.amountIn, mk.baseDecimals)} ${mk.base}`;
  }
  if (e.kind === "no_trade") return `${e.verdict.message === "llm_veto" ? "Vetoed" : "No trade"}${mk ? " · " + mk.label : ""}`;
  if (e.kind === "strategy_change") return "Strategy change";
  if (e.kind === "pause") return "Paused vaults";
  return kindLabel(e) + (mk ? " · " + mk.label : "");
}

function exportJournal(entries: JournalEntry[]) {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `flow-journal-${dayKey(Math.floor(Date.now() / 1000))}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- 21 record

const CODE_CHECK: Record<string, number> = {
  ATE_POLICY_PAUSED: 0,
  ATE_POLICY_NOT_AGENT: 1,
  ATE_TOOL_NOT_ALLOWED: 1,
  ATE_POLICY_ZERO_AMOUNT: 2,
  ATE_DEADLINE: 3,
  ATE_POLICY_PAIR: 4,
  ATE_ORACLE_STALE: 5,
  ATE_ORACLE_INVALID: 5,
  ATE_ORACLE_DEVIATION: 6,
  ATE_POLICY_TRADE_CAP: 7,
  ATE_POLICY_EPOCH_CAP: 8,
  ATE_POLICY_COOLDOWN: 9,
  ATE_SLIPPAGE: 10,
  ATE_EXIT_PRICE: 10,
  ATE_INSUFFICIENT_BALANCE: 11,
  ATE_POLICY_EXPOSURE: 12,
};

function Record({ id }: { id: string }) {
  const { ate, mkOk, vsOk } = useApp();
  const [mode] = useMode();
  const [showWhy, setShowWhy] = useState(false);
  const go = useNav();
  const { entries } = useJournal();
  const r = useRemote(() => ate.journal.get(id), [id], { onEvents: false });
  const e = r.last;
  if (r.res && !r.res.ok) return <><PageHead title="Record" crumb={<><button className="linkbtn" onClick={() => go("activity")}>Decisions</button> / {id}</>} /><ErrorBox code={r.res.error.code} message="Can't read this record" hint={r.res.error.message} /></>;
  if (!e) return <div aria-busy="true" style={{ paddingTop: 26 }}><Skeleton w={420} h={52} /><Skeleton h={150} style={{ marginTop: 24, borderRadius: 14 }} /></div>;

  const m = marketOf(e);
  const mk = m ? MARKETS[m] : undefined;
  // the trade's other records: proposal ↔ execution ↔ attestation share refId / id
  const propId = e.kind === "proposal" ? e.id : e.refId;
  const prop = e.kind === "proposal" ? e : entries.find((x) => x.id === propId);
  const exec = e.kind === "execution" ? e : entries.find((x) => x.kind === "execution" && x.refId === propId);
  const att = entries.find((x) => x.kind === "attestation" && x.refId === propId);
  const ctx = (prop ?? e).context;
  const lim = mkOk?.find((x) => x.market === m)?.vault.limits;
  const p = m ? vsOk?.positions.markets.find((x) => x.market === m) : undefined;
  const res = result(e);
  const visible = entries.filter((x) => !HIDDEN.has(x.kind));
  const idx = visible.findIndex((x) => x.id === e.id);
  const prev = idx >= 0 ? visible[idx + 1] : undefined;
  const next = idx > 0 ? visible[idx - 1] : undefined;
  const sig = ctx.signal;
  const oracleDev = ctx.pool.deviationBps;
  const cex = ctx.cex;
  const tradeLike = !!(e.intent || prop?.intent);
  const intent = e.intent ?? prop?.intent;

  // 13 vault checks, derived from the record context and the vault limits at decision time
  const notional = intent ? (intent.side === "buy" ? Number(intent.amountIn) / 1e6 : (Number(intent.amountIn) / 10 ** (mk?.baseDecimals ?? 18)) * (Number(ctx.oracle.price) / 1e8)) : 0;
  const checks: string[] = [
    "Not paused",
    "Caller is agent",
    "Amount > 0",
    "Deadline",
    "Pair allowed",
    `Oracle fresh · ${Math.round(ctx.oracle.ageSec / 60)}m`,
    `Deviation ${oracleDev > 0 ? "+" : oracleDev < 0 ? "−" : ""}${Math.abs(oracleDev)} ≤ ${lim?.maxOracleDeviationBps ?? 250}`,
    `Trade ${money(notional)} ≤ $${ctx.policy.maxTradeUsd}`,
    `Budget ${money(notional)} of ${money(Number(ctx.policy.epochRemainingUsd))} left`,
    `Cooldown ${lim?.cooldown ?? 60} s`,
    `Floor ${ctx.quote ? tokenAmt(ctx.quote.minOutFloor, intent?.side === "buy" ? (mk?.baseDecimals ?? 18) : 6) : "—"}`,
    "Balance",
    `Exposure ≤ ${lim ? money(Number(lim.maxExposureUsdE8) / 1e8, 0) : "$150"}`,
  ];
  const failed = e.verdict.ok ? -1 : (CODE_CHECK[e.verdict.code] ?? -2);
  const gapBps = sig ? sig.edgeBps : cex ? ((Number(cex.mid) - Number(ctx.pool.price)) / Number(ctx.pool.price)) * 10_000 : null;
  const costBps = sig ? sig.costBps : cex ? 30 + (ctx.quote?.impactBps ?? 0) + cex.halfSpreadBps : null;
  const story = buildStory({ e, prop, exec, mk, ctx, intent, notional, gapBps, costBps, lim, generator: sig?.generator });
  const why = splitReasoning(clean((prop ?? e).thesis ? `${(prop ?? e).thesis}\n${(prop ?? e).rationale}` : (prop ?? e).rationale));

  return (
    <>
      <PageHead
        crumb={<><button className="linkbtn" onClick={() => go("activity")}>Activity</button> / {clock(e.at)} · {mk ? `${mk.base}/${mk.quote}` : "portfolio"}{mode === "pro" ? ` · ${e.id}` : ""}</>}
        title={headline(e).replace(/ \S+$/, "")}
        hl={headline(e).split(" ").pop()}
        sub={subline(e, mk?.label)}
        acts={
          <>
            <Badge tone={res.tone} glyph={res.glyph} lg>{res.text}</Badge>
            {exec?.execution && <a className="btn" href={explorer.tx(exec.execution.txHash)} target="_blank" rel="noreferrer noopener">Explorer ↗</a>}
            {att?.attestation && <a className="btn" href={explorer.tx(att.attestation.txHash)} target="_blank" rel="noreferrer noopener">EAS attestation ↗</a>}
          </>
        }
      />
      <p className="sentence" style={{ fontSize: 20, margin: "4px 0 20px" }}>{story.sentence}</p>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
        <Card title="The numbers">
          {story.rows.length ? (
            story.rows.map(([k, v, cls]) => <KV key={k} k={k} vClass={cls}>{v}</KV>)
          ) : (
            <p className="sm fg2">No prices were needed for this record.</p>
          )}
          {gapBps !== null && costBps !== null && <Gauge cost={Math.round(costBps)} gap={Math.max(0, Math.round(gapBps))} under={`edge ${pctS(gapBps - costBps)}`} fmt={pct} />}
        </Card>
        <Card title="Checks">
          {story.checks.map(([state, text], i) => (
            <Check key={i} state={state}>{text}</Check>
          ))}
          {mode === "pro" && tradeLike && (
            <details style={{ marginTop: 10 }}>
              <summary className="disclose">All 13 vault checks</summary>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "0 18px" }}>
                  {checks.map((c, i) => (
                    <div key={i} className="row g8 xs" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                      {failed === i ? <span className="bad b7" aria-label="failed">✕</span> : failed === -1 || i < failed ? <span className="ok b7" aria-label="passed">✓</span> : <span className="fg2" aria-label="not reached">·</span>}
                      {c}
                    </div>
                  ))}
                </div>
              {!e.verdict.ok && <p className="xs mt8"><b>{e.verdict.code}</b> {e.verdict.message ? "· " + clean(e.verdict.message) : ""}</p>}
            </details>
          )}
        </Card>
      </div>
      <section className="card" style={{ marginTop: 16 }} aria-label="AI's reasoning">
        <button className="disclose" aria-expanded={showWhy} onClick={() => setShowWhy((x) => !x)}>
          <span aria-hidden="true">{showWhy ? "▾" : "▸"}</span> {showWhy ? "Hide reasoning" : decidedBy(e) === "AI" ? "Show the AI's reasoning" : "Show the reasoning"}
        </button>
        {why.summary && <p style={{ fontSize: 14, marginTop: 6 }}>{why.summary}</p>}
        {showWhy && (
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6, maxHeight: 360, overflowY: "auto" }}>
            {why.bullets.map((t, i) => <li key={i} style={{ marginBottom: 4 }}>{t}</li>)}
          </ul>
        )}
        <p className="xs fg2" style={{ marginTop: 10 }}>
          {exec?.execution ? <>A fingerprint of this text is stored on-chain with the trade · <Link href={explorer.tx(exec.execution.txHash)} mono>{short(exec.execution.txHash, 6, 4)}</Link></> : "A fingerprint of this text is kept in the tamper-evident journal."}
        </p>
      </section>
      {mode === "pro" && <div style={{ marginTop: 16 }}>
      <section className="card dk" style={{ padding: "18px 24px" }} aria-label="Prices at the decision">
          <div className="row sb">
            <div className="eb">Prices at the decision</div>
            <span className="xs" style={{ color: "var(--sage)" }}>block {int(ctx.blockNumber)} · {clock((prop ?? e).at)}</span>
          </div>
          <div className="px3" style={{ marginTop: 12 }}>
            <div>
              <div className="lbl" style={{ color: "var(--sage)" }}>Supra oracle</div>
              <div className="pv num">{price8(ctx.oracle.price)}</div>
              <Badge tone={lim && ctx.oracle.ageSec > lim.maxOracleAge ? "bad" : "ok"}>{Math.round(ctx.oracle.ageSec / 60)} min old · max {lim ? Math.round(lim.maxOracleAge / 3600) : 25} h</Badge>
            </div>
            <div>
              <div className="lbl" style={{ color: "var(--sage)" }}>HSKSwap pool</div>
              <div className="pv num">{price8(ctx.pool.price)}</div>
              <Badge tone={Math.abs(oracleDev) <= (lim?.maxOracleDeviationBps ?? 250) ? "ok" : "bad"}>{oracleDev > 0 ? "+" : oracleDev < 0 ? "−" : ""}{Math.abs(oracleDev)} bps vs oracle · max {lim?.maxOracleDeviationBps ?? 250}</Badge>
            </div>
            <div>
              <div className="lbl" style={{ color: "var(--sage)" }}>HashKey Global mid</div>
              <div className="pv num" style={{ color: "var(--y)" }}>{cex ? price8(cex.mid) : "—"}</div>
              {cex && <Badge>half-spread {cex.halfSpreadBps} bps · depth {money(Number(cex.topDepthUsd), 0)}</Badge>}
            </div>
          </div>
        </section>

      </div>}

      {mode === "pro" && exec?.execution && (
        <section className="card" style={{ marginTop: 16, padding: "14px 20px" }} aria-label="Transaction">
          <div className="grid" style={{ gridTemplateColumns: "2.1fr 1fr 1fr 1fr 1fr", gap: 18 }}>
            <div><div className="lbl">Trade tx</div><div className="mono mt4" style={{ fontSize: 11, wordBreak: "break-all" }}><Link href={explorer.tx(exec.execution.txHash)} mono>{exec.execution.txHash}</Link></div></div>
            <div><div className="lbl">Received</div><div className="b7 mt4 num">{intent && mk ? `${tokenAmt(exec.execution.amountOut, intent.side === "buy" ? mk.baseDecimals : 6)} ${intent.side === "buy" ? mk.base : "USDT"}` : exec.execution.amountOut}</div></div>
            <div><div className="lbl">Floor (min out)</div><div className="b5 mt4 num">{ctx.quote && intent && mk ? tokenAmt(ctx.quote.minOutFloor, intent.side === "buy" ? mk.baseDecimals : 6) : "—"}</div></div>
            <div><div className="lbl">Gas</div><div className="b5 mt4 num">{int(exec.execution.gasUsed)}</div></div>
            <div><div className="lbl">Attestation</div><div className="mt4">{att?.attestation ? <Link href={explorer.tx(att.attestation.txHash)} mono>{short(att.attestation.easUid, 6, 4)}</Link> : "pending"}</div></div>
          </div>
        </section>
      )}

      <Inspector>
        <div className="sec">
          <Eyebrow>Record</Eyebrow>
          <KV k="seq">{int(e.seq)}</KV>
          <KV k="actor">{actorLine(e)}</KV>
          <KV k="engine">{e.engine}</KV>
          {e.origin && <KV k="origin">{e.origin}</KV>}
          <KV k="approved by">{e.verdict.approvedBy === "policy" ? "vault policy" : e.verdict.approvedBy === "human" ? "you" : "—"}</KV>
        </div>
        <div className="sec">
          <Eyebrow>Hash chain</Eyebrow>
          <div className="lbl" style={{ color: "var(--sage)", marginBottom: 4 }}>record hash{e.kind === "proposal" ? " = proposalId" : ""}</div>
          <div className="addr">{e.hash}</div>
          <div className="lbl" style={{ color: "var(--sage)", margin: "10px 0 4px" }}>rationaleHash</div>
          <div className="addr">{e.rationaleHash}</div>
          <div className="lbl" style={{ color: "var(--sage)", margin: "10px 0 4px" }}>prev</div>
          <div className="addr">{e.prevHash}</div>
          {exec && prop && <KV k="on-chain proposalId" className="mt8" vClass="ok b7">{exec.refId === prop.id ? "✓ = proposal hash" : "—"}</KV>}
        </div>
        {p && tradeLike && (
          <div className="sec">
            <Eyebrow>Afterwards</Eyebrow>
            <KV k="holding">{tokenAmt(p.qty, mk!.baseDecimals)} {mk!.base}</KV>
            <KV k="if sold now" vClass={Number(p.unrealisedExitUsd) < 0 ? "bad b7" : Number(p.unrealisedExitUsd) > 0 ? "ok b7" : ""}>
              {Number(p.unrealisedExitUsd) < 0 ? "▼ " : Number(p.unrealisedExitUsd) > 0 ? "▲ +" : ""}{money(Number(p.unrealisedExitUsd))}
            </KV>
          </div>
        )}
        <div style={{ marginTop: "auto", paddingTop: 16 }} className="col g8">
          <Btn style={{ width: "100%" }} onClick={() => go(`ask/${encodeURIComponent(`Why did you make decision ${e.id}?`)}`)}>Ask in Chat: “why this {e.kind === "execution" ? "trade" : "decision"}?”</Btn>
          <div className="row g8">
            <Btn size="sm" className="grow" disabled={!prev} onClick={() => prev && go("activity/" + prev.id)}>← Previous</Btn>
            <Btn size="sm" className="grow" disabled={!next} onClick={() => next && go("activity/" + next.id)}>Next →</Btn>
          </div>
        </div>
      </Inspector>
    </>
  );
}

function subline(e: JournalEntry, mlabel?: string): string {
  const who = decidedBy(e);
  const by = who === "AI" ? "decided by the AI" : who === "guard" ? "decided by the guard, no AI" : who === "you" ? "decided by you" : "decided by the rules engine";
  const appr = e.verdict.approvedBy === "policy" ? ", approved by vault policy, no human in the loop" : e.verdict.approvedBy === "human" ? ", approved by you" : "";
  const tl = tradeLine(e);
  return `${tl ? tl + (mlabel ? ` · Vault-${mlabel}` : "") + " · " : ""}${by}${appr}`;
}


// ---------------------------------------------------------------- plain-language story for a record

const pctS = (bps: number): string => `${bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`;
const pct = (bps: number): string => `${(Math.abs(bps) / 100).toFixed(2)}%`;

type CheckState = "ok" | "bad" | "warn" | "q";
function buildStory(o: {
  e: JournalEntry;
  prop?: JournalEntry;
  exec?: JournalEntry;
  mk?: (typeof MARKETS)[MarketId];
  ctx: JournalEntry["context"];
  intent?: JournalEntry["intent"];
  notional: number;
  gapBps: number | null;
  costBps: number | null;
  lim?: { maxOracleAge: number; maxOracleDeviationBps: number; maxExposureUsdE8: string };
  generator?: string;
}): { sentence: string; rows: [string, string, string?][]; checks: [CheckState, string][] } {
  const { e, exec, mk, ctx, intent, notional, gapBps, costBps, lim } = o;
  const label = mk?.label ?? "the market";
  const edge = gapBps !== null && costBps !== null ? gapBps - costBps : null;
  const gapLine =
    gapBps === null || costBps === null
      ? ""
      : gapBps > 0
        ? ` The pool was ${pct(gapBps)} cheaper than HashKey Global; costs were ${pct(costBps)}, so ${edge! >= 0 ? `about ${pct(edge!)} was left as edge` : "there was no edge left"}.`
        : ` The pool was ${pct(gapBps)} dearer than HashKey Global; costs were ${pct(costBps)}.`;
  const rebalance = o.generator === "rebalance" ? " This was a rebalance toward your target mix, not a price bet." : "";
  const refused = !e.verdict.ok || !!exec?.execution?.reverted;
  const reason = REASON[e.verdict.code] ?? (e.verdict.message ? clean(e.verdict.message) : "the vault said no");
  let sentence = "";
  if (intent && mk) {
    const amt = intent.side === "buy" ? `${money(notional)} of ${label}` : `${tokenAmt(intent.amountIn, mk.baseDecimals)} ${mk.base}`;
    const done = exec?.execution && !exec.execution.reverted;
    if (refused) sentence = `Wanted to ${intent.side} ${amt}, but it didn't go through: ${reason}.`;
    else if (done) sentence = `${intent.side === "buy" ? "Bought" : "Sold"} ${amt}${intent.side === "sell" ? ` for ${money(Number(exec!.execution!.amountOut) / 1e6)}` : ""}.${gapLine}${rebalance}`;
    else sentence = `Planned to ${intent.side} ${amt}.${gapLine}${rebalance}`;
  } else if (e.kind === "no_trade") {
    sentence = `${e.verdict.message === "llm_veto" ? `The AI turned down a ${label} trade.` : `No trade on ${label}.`}${gapBps !== null && costBps !== null ? ` The price gap (${pct(gapBps)}) ${edge! > 0 ? "beat" : "didn't beat"} the cost of trading (${pct(costBps)}).` : ""}`;
  } else if (e.kind === "strategy_change") sentence = `You changed the strategy: “${clean(e.rationale).replace(/\.$/, "")}”.`;
  else if (e.kind === "pause") sentence = "Trading was paused on both vaults.";
  else if (e.kind === "outcome" && e.outcome) sentence = `Thirty minutes after a skipped trade, skipping it ${e.outcome.savedBps >= 0 ? "saved" : "cost"} ${money(Math.abs(Number(e.outcome.savedUsd)))}.`;
  else sentence = clean(e.rationale).split(/(?<=[.!?])\s+/)[0] ?? "";

  const rows: [string, string, string?][] = [];
  if (gapBps !== null) rows.push(["Price gap", `${pct(gapBps)} ${gapBps >= 0 ? "pool cheaper" : "pool dearer"}`]);
  if (costBps !== null) rows.push(["Trading cost", pct(costBps)]);
  if (edge !== null) rows.push(["Edge after costs", pctS(edge), edge >= 0 ? "ok b7" : "bad b7"]);
  if (intent && ctx.position && mk) {
    const before = (Number(ctx.position.qty) / 10 ** mk.baseDecimals) * (Number(ctx.position.mark) / 1e8);
    const after = intent.side === "buy" ? before + notional : Math.max(0, before - notional);
    rows.push(["Exposure after trade", `${money(after)}${lim ? ` of ${money(Number(lim.maxExposureUsdE8) / 1e8, 0)}` : ""}`]);
  }
  if (intent) rows.push(["Budget left today", money(Math.max(0, Number(ctx.policy.epochRemainingUsd) - (refused ? 0 : notional)))]);

  const checks: [CheckState, string][] = [];
  const cexFresh = ctx.cex && Math.abs(e.at - ctx.cex.at) < 300;
  checks.push(ctx.cex ? [cexFresh ? "ok" : "warn", cexFresh ? "Price confirmed on HashKey Global" : "HashKey Global price was a few minutes old"] : ["warn", "No HashKey Global price to confirm against"]);
  if (intent) {
    const inside = notional <= Number(ctx.policy.maxTradeUsd) && notional <= Number(ctx.policy.epochRemainingUsd) + 0.005;
    checks.push([inside ? "ok" : "bad", inside ? "Inside your vault limits" : "Over a vault limit"]);
  }
  const ageOk = !lim || ctx.oracle.ageSec <= lim.maxOracleAge;
  const devOk = !lim || Math.abs(ctx.pool.deviationBps) <= lim.maxOracleDeviationBps;
  const ageTxt = ctx.oracle.ageSec >= 3600 ? `${(ctx.oracle.ageSec / 3600).toFixed(1)} h old` : `${Math.max(1, Math.round(ctx.oracle.ageSec / 60))} min old`;
  checks.push([ageOk && devOk ? "ok" : "bad", `Oracle ${ageOk && devOk ? "within range" : "out of range"} (${ageTxt})`]);
  if (intent) checks.push(refused ? ["bad", `Vault check failed: ${reason}`] : exec?.execution ? ["ok", "Vault check passed"] : ["q", "Not sent to the vault yet"]);
  else if (e.kind === "no_trade") checks.push(["q", "Nothing was sent to the vault"]);
  return { sentence, rows, checks };
}

/** "Summary: …" first line → summary; the rest split into short bullets at sentence boundaries (no clipping). */
function splitReasoning(text: string): { summary: string | null; bullets: string[] } {
  let t = text.trim();
  let summary: string | null = null;
  const m = /^summary:\s*(.+?)(?:\n|(?<=[.!?])\s|$)/i.exec(t);
  if (m) {
    summary = m[1]!.trim();
    t = t.slice(m[0].length).trim();
  }
  const bullets = t
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z(“"])/)
    .map((x) => x.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
  return { summary, bullets };
}
