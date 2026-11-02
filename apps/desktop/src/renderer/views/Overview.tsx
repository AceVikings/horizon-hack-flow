// 10 Overview (+ 12 paused, 13 empty, 14 loading, 15 error). "Am I safe, is it working": worst-case loss used today
// from the vaults' epoch() × the §4.6 bound, per-vault budget and exposure, the kill switch, last decisions, the AI
// scoreboard; inspector with uptime, health and keys.
import { useState } from "react";
import { MARKETS, MARKET_IDS, type JournalEntry, type MarketId, type MarketView, type MarketPosition } from "@ate/core";
import type { ViewProps } from "./registry";
import { useApp, useNow, useRemote, useTraderState } from "../src/app";
import { PageHead, Inspector, useEvidence, useKillSwitch, useMode, useNav } from "../src/shell";
import { AddrLink, Badge, Banner, Btn, Card, Check, Dialog, Empty, Eyebrow, KV, Meter, NetPill, QR, Skeleton, StatPill, TxLink } from "../src/ui";
import { age, ago, clock, dayName, dur, e8n, hm, int, money, networkName, short, tokenAmt } from "../src/format";
import { centsE8, portfolioRisk, vaultRisk } from "../src/risk";
import { result, summary, tag } from "../src/journal";

const UTC_DAY = 86_400;

export default function Home(props: ViewProps) {
  const [mode] = useMode();
  return mode === "pro" ? <Overview {...props} /> : <SimpleHome />;
}

const START = [
  { id: "agent", title: "Let the agent trade", desc: "Pick how bold it is. It stays inside your limits.", icon: <><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4" /><circle cx="9" cy="13" r="1.2" /><circle cx="15" cy="13" r="1.2" /></> },
  { id: "ask", title: "Ask the agent", desc: "“How am I doing?” “Go to cash on HSK.”", icon: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 10h8" /></> },
  { id: "trade", title: "Trade it myself", desc: "See prices and place an order by hand.", icon: <><path d="M3 20h18" /><path d="M5 16l4.5-5 3.5 3 6-7" /><path d="M15 7h4v4" /></> },
  { id: "proof", title: "Check safety", desc: "See what the vault refuses, with proof.", icon: <><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></> },
];

/** Home (SIMPLIFY.md): one sentence, one control, four start actions; details on request. */
function SimpleHome() {
  const { ate, vsOk, mkOk, stale, toast, refresh } = useApp();
  const kill = useKillSwitch();
  const go = useNav();
  const [details, setDetails] = useState(false);
  const [unpause, setUnpause] = useState(false);
  const [starting, setStarting] = useState(false);
  const j = useRemote(() => ate.journal.list({ limit: 40 }), []);
  if (!vsOk || !mkOk) return <div className="page1" style={{ paddingTop: 40 }} aria-busy="true"><Skeleton w={220} h={44} /><Skeleton h={32} style={{ marginTop: 28 }} /><Skeleton h={64} w={260} style={{ marginTop: 28, borderRadius: 99 }} /></div>;
  const st = vsOk.status;
  const risk = portfolioRisk(mkOk.map((m) => m.vault));
  const paused = st.vaults.some((v) => v.paused);
  const running = st.trader.running;
  const today = Number(vsOk.positions.portfolio.realisedUsd);
  const todayTxt = `${today > 0 ? "+" : ""}${money(today)}`;
  const sentence = stale ? (
    <>Flow can't reach its engine right now. <b>Your vaults still enforce every limit.</b></>
  ) : paused ? (
    <>Trading is <b>paused</b>. Nothing can trade until you resume on your owner device.</>
  ) : running ? (
    <>Your agent is trading. Today: <b className={today < 0 ? "bad" : today > 0 ? "ok" : ""}>{todayTxt}</b>. It can lose at most <b>{centsE8(risk.maxE8)}</b> today.</>
  ) : (
    <>Your agent is stopped. Your money is safe in the vaults; at most <b>{centsE8(risk.maxE8)}</b> a day can be lost while it trades.</>
  );
  const startAgent = async () => {
    if (!ate.trader) return go("agent");
    setStarting(true);
    const r = await ate.trader.start({});
    setStarting(false);
    if (!r.ok) toast({ kind: "error", text: `Couldn't start the agent: ${r.error.code}`, sub: r.error.message });
    refresh();
  };
  const last = (j.last?.entries ?? []).filter((e) => e.kind !== "attestation" && e.kind !== "oracle_refresh").slice(0, 3);
  // Money in the vaults (cash + tokens at the oracle price), as a small way into Wallet.
  const held = mkOk.reduce((a, m) => a + Number(m.vault.balanceQuote) / 1e6 + (Number(m.vault.balancePrice) / 10 ** MARKETS[m.market].baseDecimals) * (Number(m.oracle.price) / 1e8), 0);
  return (
    <div className="page1">
      <PageHead title="Home" acts={<button className="linkbtn sm" onClick={() => go("wallet")}>Wallet · {money(held)}</button>} />
      <p className="sentence" role="status">{sentence}</p>
      <div className="row g18" style={{ marginTop: 26 }}>
        {paused ? (
          <button className="bigctl resume" onClick={() => setUnpause(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>Resume trading
          </button>
        ) : running ? (
          <button className="bigctl pause" onClick={kill} title="⌘⇧K">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v8" /><path d="M6.3 6.8a8 8 0 1 0 11.4 0" /></svg>Pause trading
          </button>
        ) : (
          <button className="bigctl resume" onClick={() => void startAgent()} disabled={starting || !!stale}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>{starting ? "Starting…" : "Start trading"}
          </button>
        )}
        <span className="sm fg2" style={{ maxWidth: 300 }}>{paused ? "Resuming needs your owner device. Flow shows a QR code." : running ? "Pausing stops both vaults on-chain. You hold to confirm." : "The agent trades only inside the limits set on your vaults."}</span>
      </div>

      <div className="starts" style={{ marginTop: 40 }}>
        {START.map((c) => (
          <button key={c.id} className="start" onClick={() => go(c.id)}>
            <span className="si"><svg viewBox="0 0 24 24" aria-hidden="true">{c.icon}</svg></span>
            <span>
              <span className="st" style={{ display: "block" }}>{c.title}</span>
              <span className="sd" style={{ display: "block" }}>{c.desc}</span>
            </span>
          </button>
        ))}
      </div>

      <button className="disclose" style={{ marginTop: 30 }} aria-expanded={details} onClick={() => setDetails((d) => !d)}>
        <span aria-hidden="true">{details ? "▾" : "▸"}</span> {details ? "Hide details" : "Show details"}
      </button>
      {details && (
        <div className="col" style={{ gap: 14, marginTop: 8 }}>
          <section className="card" style={{ padding: "18px 22px" }} aria-label="Most you can lose today">
            <div className="row sb base">
              <span className="sm b5">Most you can still lose today</span>
              <span className="sm fg2">{centsE8(risk.usedE8)} of {centsE8(risk.maxE8)} already at risk</span>
            </div>
            <Meter value={Number(risk.usedE8)} max={Number(risk.maxE8)} label="Worst-case loss used today" size="thick" style={{ marginTop: 10 }} />
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 16 }}>
              {mkOk.map((m) => {
                const v = m.vault;
                const used = e8n(v.epoch.spentUsdE8);
                const cap = e8n(v.limits.maxEpochUsdE8);
                return (
                  <div key={m.market}>
                    <div className="row sb sm"><b>{MARKETS[m.market].base} vault</b><span className="fg2">{money(used)} of {money(cap, 0)} traded today</span></div>
                    <Meter value={used} max={cap} label={`${MARKETS[m.market].base} daily budget used`} style={{ marginTop: 6 }} />
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card" style={{ padding: "12px 22px" }} aria-label="Last decisions">
            {last.length === 0 ? <p className="sm fg2" style={{ padding: "8px 0" }}>No decisions yet.</p> : last.map((e) => <DecRow key={e.id} e={e} onOpen={() => go("activity/" + e.id)} />)}
            <button className="linkbtn sm" style={{ margin: "10px 0 4px" }} onClick={() => go("activity")}>All activity →</button>
          </section>
        </div>
      )}
      <UnpauseDialog open={unpause} onClose={() => setUnpause(false)} />
    </div>
  );
}

function Overview(_: ViewProps) {
  const { ate, vsOk, mkOk, stale, refresh, fetchedAt } = useApp();
  const now = useNow();
  const state = useTraderState();
  const kill = useKillSwitch();
  const go = useNav();
  const ev = useEvidence();
  const [unpause, setUnpause] = useState(false);
  const j = useRemote(() => ate.journal.list({ limit: 150 }), []);
  const strat = useRemote(() => ate.strategy.get(), [], { onEvents: false });
  const journal = j.last?.entries ?? [];

  if (!vsOk || !mkOk) return <Loading />;

  const st = vsOk.status;
  const pos = vsOk.positions;
  const vaults = mkOk.map((m) => m.vault);
  const risk = portfolioRisk(vaults);
  const paused = st.vaults.some((v) => v.paused);
  const allPaused = st.vaults.every((v) => v.paused);
  const dayStart = Math.floor(now / UTC_DAY) * UTC_DAY;
  const resetsIn = (vaults[0] ? vaults[0].epoch.start + vaults[0].limits.epochDuration : dayStart + UTC_DAY) - now;
  const visible = journal.filter((e) => e.kind !== "attestation" && e.kind !== "oracle_refresh");
  const today = journal.filter((e) => e.at >= dayStart);
  const execToday = today.filter((e) => e.kind === "execution" && e.execution && !e.execution.reverted);
  const attested = new Set(today.filter((e) => e.kind === "attestation").map((e) => e.refId));
  const empty = visible.length === 0 && risk.usedE8 === 0n;
  const realised = Number(pos.portfolio.realisedUsd);
  const ifSold = Number(pos.portfolio.unrealisedExitUsd);
  const discPerDay = strat.last?.strategy.portfolio.discretionaryTradesPerDay;

  const sub = stale
    ? `Showing values from ${hm(fetchedAt)} · daemon unreachable for ${age(now - stale.since)}`
    : paused
      ? `Paused${ev.lastPause ? " " + clock(ev.lastPause.at) : ""} · ${allPaused ? "both vaults" : "one vault"} · trader idle`
      : empty
        ? `${dayName(now)} · trader started ${ago(st.startedAt, now)} · first decisions appear here`
        : `${dayName(now)} · UTC day resets in ${dur(resetsIn)} · ${st.vaults.length === 2 ? "both vaults" : `${st.vaults.length} vault`} active`;
  const pill = stale ? (
    <StatPill tone="bad">Daemon unreachable</StatPill>
  ) : paused ? (
    <StatPill tone="bad">Vaults paused</StatPill>
  ) : state === "running" ? (
    <StatPill>Trader running · {st.trader.mode}</StatPill>
  ) : (
    <StatPill tone="warn">Trader idle · {st.trader.mode}</StatPill>
  );

  const posOf = (m: MarketId) => pos.markets.find((p) => p.market === m);
  const lastExec = (m: MarketId) => journal.find((e) => e.kind === "execution" && e.market === m && e.execution && !e.execution.reverted);

  return (
    <>
      <PageHead title="Overview" sub={sub} acts={<>{pill}<NetPill label={networkName(st.chainId)} /></>} />
      {stale && (
        <Banner
          tone="bad"
          icon="!"
          title={`Can't reach the daemon · ${stale.code}`}
          sub="The vaults still enforce every limit on-chain. Values below are the last good read; the kill switch retries on the next attempt."
          action={<Btn kind="solid" onClick={refresh}>Retry now</Btn>}
        />
      )}
      {paused && !stale && (
        <Banner
          tone="paused"
          icon="❚❚"
          title={allPaused ? "Both vaults are paused on-chain" : `${st.vaults.filter((v) => v.paused).map((v) => "Vault-" + MARKETS[v.market].label).join(", ")} is paused on-chain`}
          sub="New trades are refused. Stop-loss exits are off too. Only the owner device can unpause."
          action={<Btn kind="pri" onClick={() => setUnpause(true)}>Unpause on owner device</Btn>}
        />
      )}
      <div className={stale ? "stale" : ""}>
        <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 290px" }}>
          <section className={`card dk ov-meter${stale ? " vals" : ""}`} style={{ padding: "20px 24px" }} aria-label="Worst-case loss used today">
            <div className="row sb">
              <div className="eb">Worst-case loss used today</div>
              <span className="xs" style={{ color: "var(--sage)" }}>limit set on-chain · {vaults.length === 2 ? "both vaults" : `${vaults.length} vault`}</span>
            </div>
            <div className="row base g12" style={{ marginTop: 14, gap: 12 }}>
              <span className="huge num" style={{ color: "var(--y)" }}>{centsE8(risk.usedE8)}</span>
              <span className="of" style={{ color: "var(--sage)", fontSize: 16 }}>
                of <b style={{ color: "#fff" }}>{centsE8(risk.maxE8)}</b> {paused ? "· frozen while paused" : `max today · ${risk.pct.toFixed(1)}%`}
              </span>
            </div>
            <Meter value={Number(risk.usedE8)} max={Number(risk.maxE8)} label="Worst-case loss used today" size="xl" style={{ marginTop: 16, background: "rgba(183,198,194,.1)", borderColor: "rgba(183,198,194,.25)" }} />
            <div className="grid" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 0, marginTop: 16 }}>
              {risk.vaults.map((v, i) => (
                <div key={v.market} style={i ? { borderLeft: "1px solid rgba(183,198,194,.16)", paddingLeft: 18 } : undefined} title={`epoch spent ${centsE8(v.spentE8)} × ${v.bps} bps`}>
                  <div className="lbl" style={{ color: "var(--sage)" }}>Vault-{MARKETS[v.market].label}</div>
                  <div className="mt4">
                    <b className="num" style={{ fontSize: 16 }}>{centsE8(v.usedE8)}</b> <span className="xs" style={{ color: "var(--sage)" }}>of {centsE8(v.maxE8)}</span>
                  </div>
                </div>
              ))}
              <div style={{ borderLeft: "1px solid rgba(183,198,194,.16)", paddingLeft: 18 }}>
                <div className="lbl" style={{ color: "var(--sage)" }}>P&amp;L today</div>
                <div className="mt4">
                  <Signed n={realised} size={16} /> <span className="xs" style={{ color: "var(--sage)" }}>realised</span>
                </div>
                <div className="xs" style={{ color: "var(--sage)" }}>
                  <Signed n={ifSold} /> if sold now
                </div>
              </div>
            </div>
          </section>
          {paused ? (
            <section className="card dk" style={{ padding: "18px 20px", border: "2px solid #ff8d95" }} aria-label="Kill switch: paused">
              <div className="eb">Kill switch</div>
              <div className="disp" style={{ fontSize: 44, color: "#ff8d95", marginTop: 12 }}>Paused</div>
              <div className="xs" style={{ color: "var(--sage)", marginTop: 8 }}>
                {ev.lastPause ? clock(ev.lastPause.at) : "—"}
                {ev.lastPause?.execution && <> · <TxLink hash={ev.lastPause.execution.txHash} /></>}
              </div>
              <div className="row g8" style={{ marginTop: 14 }}>
                <button className="linkbtn" onClick={() => setUnpause(true)} aria-label="Show unpause QR codes" style={{ textDecoration: "none" }}>
                  <QR data={unpauseUri(st.vaults.find((v) => v.paused)!.address, st.chainId)} size={64} pad={4} label="Unpause QR" />
                </button>
                <span className="xs" style={{ color: "var(--sage)" }}>Scan on the owner device to unpause {allPaused ? "both vaults" : "the paused vault"}.</span>
              </div>
            </section>
          ) : (
            <section className="card ks" style={{ padding: "18px 20px" }} aria-label="Kill switch">
              <div className="row sb">
                <div className="eb">Kill switch</div>
                <kbd className="xs fg2" style={{ font: "inherit" }}>⌘⇧K</kbd>
              </div>
              <p className="sm fg2 mt8" style={{ lineHeight: 1.5 }}>Pauses both vaults on-chain. New trades and stop-loss exits stop until your owner device unpauses.</p>
              <button className="ks-btn" onClick={kill}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v8" /><path d="M6.3 6.8a8 8 0 1 0 11.4 0" /></svg>
                Pause all
              </button>
              <div className="row sb xs" style={{ marginTop: 12 }}>
                <span className="fg2">Signed by the agent key · {st.vaults.length} txs</span>
                <button className="linkbtn" onClick={kill}>Go to cash first</button>
              </div>
            </section>
          )}
        </div>

        <div className={`grid${stale ? " dim" : ""}`} style={{ gridTemplateColumns: "1fr 1fr", marginTop: 16 }}>
          {MARKET_IDS.map((m) => {
            const mv = mkOk.find((x) => x.market === m);
            return mv ? <VaultCard key={m} mv={mv} p={posOf(m)} last={lastExec(m)} paused={!!st.vaults.find((v) => v.market === m)?.paused} /> : null;
          })}
        </div>

        <div className={`grid fill${stale ? " dim" : ""}`} style={{ gridTemplateColumns: "minmax(0,1fr) 300px", marginTop: 16 }}>
          <Card
            title="Last decisions"
            right={visible.length ? <button className="linkbtn sm" onClick={() => go("activity")}>All decisions →</button> : undefined}
            style={{ padding: "14px 20px 8px" }}
            headStyle={{ marginBottom: 4 }}
          >
            {j.res && !j.res.ok && !j.last ? (
              <p className="sm bad">Journal unavailable: {j.res.error.message}</p>
            ) : !j.last ? (
              [0, 1, 2, 3].map((i) => <Skeleton key={i} h={14} style={{ margin: "14px 0" }} />)
            ) : visible.length === 0 ? (
              <Empty title="No decisions yet">The first cycle reads three prices and decides in about {strat.last ? strat.last.strategy.portfolio.scanSeconds ?? 20 : 20} s. Skipped trades show up here too.</Empty>
            ) : (
              visible.slice(0, 4).map((e) => <DecRow key={e.id} e={e} onOpen={() => go("activity/" + e.id)} />)
            )}
          </Card>
          <section className="card dk" style={{ padding: "14px 20px" }} aria-label="AI scoreboard">
            <div className="ch" style={{ marginBottom: 10 }}>
              <h2 className="h4">AI scoreboard</h2>
              <span className="xs" style={{ color: "var(--sage)" }}>today</span>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
              <div><div className="sc-n num">{pos.scoreboard.acts}</div><div className="xs mt4" style={{ color: "var(--sage)" }}>acts</div></div>
              <div><div className="sc-n num">{pos.scoreboard.vetoes}</div><div className="xs mt4" style={{ color: "var(--sage)" }}>vetoes · {pos.scoreboard.sizeDowns} size-down{pos.scoreboard.sizeDowns === 1 ? "" : "s"}</div></div>
              <div>
                <div className="sc-n num">
                  {pos.scoreboard.discretionary}
                  {discPerDay !== undefined && <span style={{ fontSize: 22, color: "var(--sage)" }}>/{discPerDay}</span>}
                </div>
                <div className="xs mt4" style={{ color: "var(--sage)" }}>discretionary</div>
              </div>
            </div>
            <div className="hr" style={{ margin: "12px 0 8px" }} />
            <KV k="Vetoes saved at +30 min" className="xs" vClass={pos.scoreboard.savedBps > 0 ? "ok" : pos.scoreboard.savedBps < 0 ? "bad" : ""}>
              {pos.scoreboard.savedBps >= 0 ? "+" : "−"}{Math.abs(pos.scoreboard.savedBps)} bps · {money(Math.abs(Number(pos.scoreboard.savedUsd)))}
            </KV>
            <KV k="Rationale hashes on-chain" className="xs">
              {execToday.filter((e) => e.refId && attested.has(e.refId)).length} of {execToday.length}
            </KV>
          </section>
        </div>
      </div>

      <Inspector>
        <OverviewInspector paused={paused} lastPauseAt={ev.lastPause?.at} />
      </Inspector>

      <UnpauseDialog open={unpause} onClose={() => setUnpause(false)} />
    </>
  );
}

function Signed({ n, size }: { n: number; size?: number }) {
  const tone = n > 0 ? "ok" : n < 0 ? "bad" : "";
  return (
    <b className={`num ${tone}`} style={size ? { fontSize: size } : undefined}>
      <span aria-hidden="true">{n > 0 ? "▲" : n < 0 ? "▼" : "■"}</span> {n > 0 ? "+" : ""}
      {money(n)}
      <span className="sr">{n > 0 ? " gain" : n < 0 ? " loss" : " flat"}</span>
    </b>
  );
}

function DecRow({ e, onOpen }: { e: JournalEntry; onOpen(): void }) {
  const r = result(e);
  return (
    <button className="drow" onClick={onOpen} style={{ width: "100%", background: "none", border: 0, borderBottom: "1px solid var(--line)", textAlign: "left" }}>
      <span className="t">{hm(e.at)}</span>
      <span className="m">{tag(e)}</span>
      <span className="x" title={summary(e)}>{summary(e)}</span>
      <Badge tone={r.tone} glyph={r.glyph}>{r.text}</Badge>
    </button>
  );
}

function VaultCard({ mv, p, last, paused }: { mv: MarketView; p?: MarketPosition; last?: JournalEntry; paused: boolean }) {
  const mk = MARKETS[mv.market];
  const v = mv.vault;
  const r = vaultRisk(v);
  const qty = BigInt(v.balancePrice);
  const cash = qty === 0n;
  const usedUsd = e8n(v.epoch.spentUsdE8);
  const capUsd = e8n(v.limits.maxEpochUsdE8);
  const exp = e8n(v.exposureUsdE8);
  const maxExp = e8n(v.limits.maxExposureUsdE8);
  const badge = paused ? <Badge tone="bad" glyph="❚❚">paused</Badge> : cash ? <Badge tone="info" glyph="$">in cash</Badge> : <Badge tone="ok">active</Badge>;
  const lastTxt = last ? `${hm(last.at)} · ${summary(last).replace(/ on the exit path$/, "").replace(/^(Bought|Sold)/, (s) => s.toLowerCase())}` : "no trades yet";
  return (
    <section className="card" aria-label={`${mk.base}/${mk.quote} vault`}>
      <div className="row sb">
        <div className="row g10 base">
          <h2 className="h3">{mk.base}/{mk.quote}</h2>
          <span className="xs fg2">Vault-{mk.label} · <AddrLink addr={v.address} /></span>
        </div>
        {badge}
      </div>
      <div className="vals">
        <div className="row sb sm" style={{ marginTop: 14 }}>
          <span className="fg2">Budget today</span>
          <span className="num"><b>{money(usedUsd)}</b> used · {money(capUsd - usedUsd)} left of {money(capUsd, capUsd % 1 ? 2 : 0)}</span>
        </div>
        <Meter value={Number(r.spentE8)} max={Number(BigInt(v.limits.maxEpochUsdE8))} label={`Vault-${mk.label} budget used today`} style={{ marginTop: 6 }} />
        <div className="row sb sm" style={{ marginTop: 12 }}>
          <span className="fg2">Exposure</span>
          <span className="num"><b>{money(exp)}</b> of {money(maxExp, maxExp % 1 ? 2 : 0)}</span>
        </div>
        <Meter value={exp} max={maxExp} label={`Vault-${mk.label} exposure`} style={{ marginTop: 6 }} />
        <div className="row sb xs fg2" style={{ marginTop: 12 }}>
          <span className="num">{tokenAmt(v.balanceQuote, 6)} USDT · {tokenAmt(v.balancePrice, mk.baseDecimals)} {mk.base}</span>
          <span title={last?.id}>{lastTxt}</span>
        </div>
        {p && p.reentryLockUntil && <span className="sr">re-entry locked</span>}
      </div>
    </section>
  );
}

function OverviewInspector({ paused, lastPauseAt }: { paused: boolean; lastPauseAt?: number }) {
  const { vsOk, mkOk, fetchedAt } = useApp();
  const now = useNow();
  if (!vsOk || !mkOk) return null;
  const st = vsOk.status;
  const up = st.uptimeSec + Math.max(0, now - fetchedAt);
  const v0 = mkOk[0]?.vault;
  const oracle = (m: MarketView) => {
    const a = m.oracle.ageSec + Math.max(0, now - m.at);
    const maxAge = m.vault.limits.maxOracleAge;
    return { state: (a > maxAge ? "bad" : m.oracle.health === "fresh" ? "ok" : "warn") as "ok" | "warn" | "bad", text: `${age(a)} old` };
  };
  const cexAge = (m: MarketView) => (m.cex ? Math.max(0, now - m.cex.at) : null);
  const lastCycle = st.trader.lastCycleAt;
  return (
    <>
      <div className="sec">
        <Eyebrow>{paused ? "Stopped" : "Uptime"}</Eyebrow>
        <div className="huge num" style={{ fontSize: 60, ...(paused ? { color: "#ff8d95" } : {}) }}>{paused ? "Paused" : dur(up)}</div>
        <KV k="Cycles" className="mt12">{int(st.cycles)}</KV>
        <KV k="Trades">{int(st.trades)} · {money(Number(st.routedUsd))} routed</KV>
        {paused ? <KV k="Paused at">{lastPauseAt ? clock(lastPauseAt) : "—"}</KV> : <KV k="Last cycle">{lastCycle ? ago(lastCycle, now) : "none yet"}</KV>}
      </div>
      <div className="sec">
        <Eyebrow>Health</Eyebrow>
        <Check state={Math.max(0, now - fetchedAt) < 30 ? "ok" : "warn"} aside={`block ${int(st.blockNumber)}`} style={{ padding: "6px 0" }}>RPC · chain {st.chainId}</Check>
        {mkOk.map((m) => {
          const o = oracle(m);
          return (
            <Check key={m.market} state={o.state} aside={o.text} style={{ padding: "6px 0" }}>
              Supra {MARKETS[m.market].label}/USD
            </Check>
          );
        })}
        {(() => {
          const a = mkOk.map(cexAge).filter((x): x is number => x !== null);
          return <Check state={a.length ? (Math.max(...a) < 120 ? "ok" : "warn") : "bad"} aside={a.length ? `${age(Math.max(...a))} ago` : "no quote"} style={{ padding: "6px 0" }}>HashKey Global</Check>;
        })()}
        <Check state={st.trader.running ? "ok" : "warn"} aside={st.trader.engine === "llm" ? "LLM" : "rules"} style={{ padding: "6px 0" }}>AI model</Check>
        <Check state={st.gas.low ? "bad" : "ok"} aside={`${st.gas.agentHsk} HSK`} style={{ padding: "6px 0" }}>Agent gas</Check>
      </div>
      {v0 && (
        <div className="sec">
          <Eyebrow>Keys</Eyebrow>
          <KV k="Agent · this Mac" mono>{short(v0.agent, 6, 4)}</KV>
          <KV k="Guardian · pause" mono>{short(v0.guardian, 6, 4)}</KV>
          <KV k="Owner · device" mono>{short(v0.owner, 6, 4)}</KV>
          <div className="xs mt8" style={{ color: "var(--sage)" }}>The agent key can never withdraw.</div>
        </div>
      )}
    </>
  );
}

/** EIP-681 call of `unpause()` on a vault (owner-only), for the owner device to scan. */
export const unpauseUri = (vault: string, chainId: number): string => `ethereum:${vault}@${chainId}/unpause`;

function UnpauseDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { vsOk } = useApp();
  if (!vsOk) return null;
  const st = vsOk.status;
  const ps = st.vaults.filter((v) => v.paused);
  return (
    <Dialog open={open} onClose={onClose} eyebrow="Owner device · QR handoff" title={<>Unpause on your <span className="hl">owner device</span></>} width={680} footer={<><span className="xs fg2 grow">Your owner key never touches this Mac.</span><Btn onClick={onClose} data-autofocus>Done</Btn></>}>
      {ps.length === 0 ? (
        <p className="sm">Both vaults are running.</p>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: `repeat(${ps.length},minmax(0,1fr))`, gap: 18 }}>
          {ps.map((v) => (
            <div key={v.market} className="col g8" style={{ alignItems: "center", textAlign: "center" }}>
              <QR data={unpauseUri(v.address, st.chainId)} size={180} label={`Unpause Vault-${MARKETS[v.market].label}`} />
              <b>Vault-{MARKETS[v.market].label}</b>
              <span className="mono xs" style={{ wordBreak: "break-all" }}>{v.address}</span>
              <span className="xs fg2">Scan with the wallet that holds your owner key to resume this vault.</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function Loading() {
  return (
    <>
      <PageHead title="Overview" sub="Reading limits() and balances…" acts={<StatPill tone="warn">Connecting…</StatPill>} />
      <div aria-busy="true" aria-label="Loading overview">
        <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 290px" }}>
          <div className="card dk" style={{ height: 220, padding: 22 }}>
            <Skeleton w="40%" />
            <Skeleton w="30%" h={70} style={{ marginTop: 18 }} />
            <Skeleton h={30} style={{ marginTop: 18 }} />
          </div>
          <div className="card" style={{ height: 220, padding: 22 }}>
            <Skeleton w="50%" />
            <Skeleton h={74} style={{ marginTop: 80, background: "rgba(179,32,45,.15)" }} />
          </div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 16 }}>
          {[0, 1].map((i) => (
            <div key={i} className="card" style={{ height: 170, padding: 20 }}>
              <Skeleton w="45%" h={20} />
              <Skeleton h={10} style={{ marginTop: 30 }} />
              <Skeleton h={10} style={{ marginTop: 30 }} />
            </div>
          ))}
        </div>
        <div className="card" style={{ marginTop: 16, padding: 20 }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} h={14} style={{ margin: "14px 0" }} />)}
        </div>
        <div className="xs fg2 c" style={{ marginTop: 10 }}>Reading limits() and balances from the chain…</div>
      </div>
      <Inspector>
        <Skeleton w="40%" style={{ background: "rgba(183,198,194,.12)" }} />
        <Skeleton w="70%" h={56} style={{ marginTop: 14, background: "rgba(183,198,194,.12)" }} />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} style={{ marginTop: 22, background: "rgba(183,198,194,.1)" }} />)}
      </Inspector>
    </>
  );
}

