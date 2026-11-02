import { useState } from "react";
import { MARKET_IDS, MARKETS, type MarketId } from "@ate/core";
import { useApp, useRemote } from "../app";
import { ContextPanel, Inspector } from "../shell";
import { AddrLink, Badge, Bar, Card, Empty, ErrorBox, KV, PnL } from "../ui";
import { ago, bps, label, short, usd } from "../format";

export default function Agents() {
  const { ate, vs, toast, refresh } = useApp();
  const { res: sres } = useRemote(() => ate.strategy.get(), [], { every: 20000 });
  const { res: mres } = useRemote(() => ate.markets.list(), [], { every: 20000 });
  const { res: jres } = useRemote(() => ate.journal.list({ limit: 200 }), [], { every: 20000 });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  if (vs && !vs.ok) return <ErrorBox {...vs.error} />;
  if (!vs) return <div className="muted">Loading…</div>;
  const { status, positions } = vs.data;
  const sb = positions.scoreboard;
  const pf = positions.portfolio;
  const strat = sres?.ok ? sres.data : null;
  const vetoes = jres?.ok ? jres.data.entries.filter((e) => e.kind === "outcome" || (e.kind === "no_trade" && e.verdict.message === "llm_veto")) : [];

  async function pause() {
    setBusy(true);
    const r = await ate.vaults.pause();
    setBusy(false);
    setConfirm(false);
    toast(r.ok ? { kind: "ok", text: "Pause submitted on both vaults; daemon locked." } : { kind: "error", text: `${r.error.code}: ${r.error.message}` });
    refresh();
  }

  return (
    <>
      <ContextPanel>
        <h2>Trader</h2>
        <div><Badge tone={status.locked ? "bad" : status.trader.running ? "ok" : "warn"}>{status.locked ? "locked" : status.trader.running ? "running" : "paused"}</Badge></div>
        <KV k="mode">{status.trader.mode}</KV>
        <KV k="engine">{status.trader.engine}{status.trader.engine === "rules" ? " (fallback)" : ""}</KV>
        <KV k="last cycle">{status.trader.lastCycleAt ? ago(status.trader.lastCycleAt) : "—"}</KV>
        <KV k="cycles">{status.cycles.toLocaleString("en-US")}</KV>
        <h2>Agent gas</h2>
        <KV k="balance">{status.gas.agentHsk} HSK</KV>
        <div>{status.gas.low ? <Badge tone="bad">LOW GAS: top up the agent address</Badge> : <Badge tone="ok">gas ok</Badge>}</div>
        <KV k="attestations deferred">{status.gas.attestationsDeferred}</KV>
        <h2>Kill switch</h2>
        {!confirm ? (
          <button className="btn danger" onClick={() => setConfirm(true)}>Pause all vaults</button>
        ) : (
          <div className="confirm" role="alertdialog" aria-label="Confirm pause">
            <p className="small">Signs <code>pause()</code> on both vaults and locks the daemon. A pause also stops stop-loss exits. Unpause is owner-only (<code>ate-owner unpause --all</code>).</p>
            <button className="btn danger" disabled={busy} onClick={pause}>{busy ? "Pausing…" : "Confirm pause"}</button>{" "}
            <button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        )}
      </ContextPanel>

      <div className="grid2">
        <Card title="AI scoreboard" right={<span className="muted small">today</span>}>
          <p className="score">
            LLM decisions today: <b className="num">{sb.acts}</b> acts / <b className="num">{sb.vetoes}</b> vetoes + <b className="num">{sb.sizeDowns}</b> size-downs
            {" "}(<b className="num">{bps(sb.savedBps)}</b> saved, {usd(sb.savedUsd)}) / <b className="num">{sb.discretionary}</b> of 3 discretionary
          </p>
          {vetoes.length === 0 ? <Empty title="No vetoes recorded yet" /> : (
            <table className="tbl"><thead><tr><th>Record</th><th>Rationale hash</th><th className="r">Result</th></tr></thead><tbody>
              {vetoes.slice(0, 5).map((e) => (
                <tr key={e.id}>
                  <td><span className="mono">{e.id}</span><div className="small muted">{e.kind === "outcome" ? "30-min outcome" : "veto"} · {label(e.market)}</div></td>
                  <td className="mono small" title={e.rationaleHash}>{short(e.rationaleHash, 12, 8)}</td>
                  <td className="r num">{e.outcome ? <Badge tone={e.outcome.savedBps >= 0 ? "ok" : "warn"}>{bps(e.outcome.savedBps)} · {usd(e.outcome.savedUsd)}</Badge> : <Badge>veto</Badge>}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Card>

        <Card title="Portfolio budgets">
          <Bar label="Exposure" value={Number(pf.exposureUsd)} max={Number(pf.maxPortfolioExposureUsd)} right={`${usd(pf.exposureUsd)} of ${usd(pf.maxPortfolioExposureUsd)}`} />
          <Bar label="Daily turnover" value={Number(pf.turnoverUsedUsd)} max={Number(pf.turnoverUsedUsd) + Number(pf.turnoverRemainingUsd)} right={`${usd(pf.turnoverUsedUsd)} used · ${usd(pf.turnoverRemainingUsd)} left`} />
          <KV k="daily P&L"><PnL usd={pf.dailyPnlUsd} /></KV>
          <KV k="circuit breaker"><Badge tone={pf.breaker === "armed" ? "ok" : "bad"}>{pf.breaker}</Badge></KV>
          <KV k="discretionary used">{pf.discretionaryUsedToday} of {strat?.strategy.portfolio.discretionaryTradesPerDay ?? 3}</KV>
        </Card>
      </div>

      <div className="grid2">
        {MARKET_IDS.map((id) => {
          const p = positions.markets.find((x) => x.market === id)!;
          return (
            <Card key={id} title={`${MARKETS[id].base}/USDT vault`} right={<Badge tone={p.paused ? "bad" : "ok"}>{p.paused ? "paused" : "active"}</Badge>}>
              <Bar label="Epoch budget" value={Number(p.epoch.spentUsd)} max={Number(p.epoch.capUsd)} right={`${usd(p.epoch.spentUsd)} spent · ${usd(p.epoch.remainingUsd)} left`} />
              <KV k="exit reserve">{usd(p.exitReserveUsd)}</KV>
              <KV k="realised"><PnL usd={p.realisedUsd} /></KV>
              <KV k="fee drag">{usd(p.feeDragUsd)}</KV>
              <KV k="vault"><AddrLink addr={p.vault} full /></KV>
            </Card>
          );
        })}
      </div>

      <Card title="Strategy parameters" right={<span className="muted small">human anchor vs agent-tuned</span>}>
        {!strat ? <div className="muted">Loading…</div> : (
          <table className="tbl">
            <thead><tr><th>Parameter</th>{MARKET_IDS.map((m) => <th key={m} className="r" colSpan={2}>{MARKETS[m].label}</th>)}</tr><tr><th /> {MARKET_IDS.map((m) => <><th key={m + "a"} className="r small">anchor</th><th key={m + "b"} className="r small">effective</th></>)}</tr></thead>
            <tbody>
              {(["entrySpreadBps", "minNetEdgeBps", "tradeSizeUsd", "cycleSeconds"] as const).map((f) => (
                <tr key={f}>
                  <td>{f}</td>
                  {MARKET_IDS.map((m) => <Cmp key={m} a={String(strat.anchors[m][f])} b={String(strat.strategy.markets[m][f])} />)}
                </tr>
              ))}
              {(["stopLossBps", "takeProfitBps", "maxPositionUsd", "rebalanceTargetPct", "reentryCooldownSec"] as const).map((f) => (
                <tr key={f}>
                  <td>{f}</td>
                  {MARKET_IDS.map((m) => <td key={m} className="r num" colSpan={2}>{String(strat.strategy.markets[m][f] ?? "none")}</td>)}
                </tr>
              ))}
              <tr><td>profile / generators</td>{MARKET_IDS.map((m) => <td key={m} className="r small" colSpan={2}>{strat.strategy.markets[m].profile} · {strat.strategy.markets[m].generators.join(", ")}</td>)}</tr>
              <tr><td>targetAssets</td><td className="r num" colSpan={4}>{strat.strategy.portfolio.targetAssets.join(", ") || "none (cash)"}</td></tr>
            </tbody>
          </table>
        )}
        <p className="small muted">Tuned values stay within ×0.5 to ×1.5 of the human anchor. Human changes are made in Chat (loosening needs Touch ID).</p>
      </Card>

      <Inspector>
        <h2>Key fingerprints</h2>
        {mres?.ok && mres.data[0] ? (
          <>
            <div className="small muted">agent key (trades inside limits; can pause)</div><div className="mono wrap small">{mres.data[0].vault.agent}</div>
            <div className="small muted">guardian (independent pause)</div><div className="mono wrap small">{mres.data[0].vault.guardian}</div>
            <div className="small muted">owner (limits, unpause, withdraw)</div><div className="mono wrap small">{mres.data[0].vault.owner}</div>
            <p className="small muted">The agent key can never withdraw.</p>
          </>
        ) : <span className="muted">—</span>}
      </Inspector>
    </>
  );
}

function Cmp({ a, b }: { a: string; b: string }) {
  const diff = a !== b;
  const up = Number(b) > Number(a);
  return (
    <>
      <td className="r num">{a}</td>
      <td className="r num">{b}{diff && <Badge tone="info" title="Tuned by the agent">{up ? "▲" : "▼"} tuned</Badge>}</td>
    </>
  );
}
export type { MarketId };
