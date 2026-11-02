import { MARKET_IDS, MARKETS } from "@ate/core";
import { useApp } from "../app";
import { ContextPanel, Inspector } from "../shell";
import { AddrLink, Badge, Card, Empty, ErrorBox, KV, PnL } from "../ui";
import { dateTime, fmtUnits, px8, usd } from "../format";

export default function Positions() {
  const { vs } = useApp();
  if (!vs) return <div className="muted">Loading…</div>;
  if (!vs.ok) return <ErrorBox {...vs.error} />;
  const { positions: P } = vs.data;
  const pf = P.portfolio;
  const flat = P.markets.every((m) => m.qty === "0");
  return (
    <>
      <ContextPanel>
        <h2>Portfolio</h2>
        <KV k="exposure">{usd(pf.exposureUsd)}</KV>
        <KV k="cap">{usd(pf.maxPortfolioExposureUsd)}</KV>
        <KV k="daily P&L"><PnL usd={pf.dailyPnlUsd} /></KV>
        <h2>Marks</h2>
        <p className="small muted"><b>Exit-executable</b>: what selling the whole position through the pool realises now (QuoterV2). <b>CEX-marked</b>: valued at the HashKey Global mid, a paper gap realised only if the pool reverts. They are shown side by side and never netted.</p>
      </ContextPanel>

      {flat && <Empty title="No positions">The vaults hold only USDT. Entries appear after the first fill.</Empty>}

      <Card title="Portfolio summary">
        <div className="grid4">
          <Stat k="Realised" v={<PnL usd={pf.realisedUsd} />} />
          <Stat k="Unrealised, exit-executable" v={<PnL usd={pf.unrealisedExitUsd} />} />
          <Stat k="Unrealised, CEX-marked" v={<PnL usd={pf.unrealisedCexUsd} />} />
          <Stat k="Exposure" v={<span className="num big">{usd(pf.exposureUsd)}</span>} />
        </div>
      </Card>

      <div className="grid2">
        {MARKET_IDS.map((id) => {
          const m = P.markets.find((x) => x.market === id)!;
          const bd = MARKETS[id].baseDecimals;
          return (
            <Card key={id} title={`${MARKETS[id].base}/USDT`} right={<AddrLink addr={m.vault} />}>
              <KV k="USDT balance">{fmtUnits(m.balanceQuote, 6)} USDT</KV>
              <KV k={`${MARKETS[id].base} balance`}>{fmtUnits(m.balancePrice, bd, 2)} {MARKETS[id].base}</KV>
              <KV k="average entry (fees in)">{m.avgEntry ? "$" + px8(m.avgEntry) : "flat"}</KV>
              <KV k="exit-executable mark">{m.mark ? "$" + px8(m.mark) : "—"}</KV>
              <KV k="CEX mid">{m.cexMid ? "$" + px8(m.cexMid) : "—"}</KV>
              <hr />
              <KV k="Realised"><PnL usd={m.realisedUsd} /></KV>
              <KV k="Unrealised, exit-executable"><PnL usd={m.unrealisedExitUsd} bps={m.unrealisedExitBps} /></KV>
              <KV k="Unrealised, CEX-marked"><PnL usd={m.unrealisedCexUsd} bps={m.unrealisedCexBps} /></KV>
              <KV k="Fee drag">{usd(m.feeDragUsd)}</KV>
              {m.reentryLockUntil && <KV k="re-entry lock until">{dateTime(m.reentryLockUntil)}</KV>}
            </Card>
          );
        })}
      </div>

      <Card title="Spread-revert lots" right={<span className="muted small">sub-ledger, reported alongside, never summed</span>}>
        {P.markets.every((m) => m.lots.length === 0) ? <Empty title="No open lots" /> : (
          <table className="tbl"><thead><tr><th>Lot</th><th>Market</th><th className="r">Qty remaining</th><th className="r">Entry</th><th className="r">Realised</th><th>Opened</th><th>State</th></tr></thead><tbody>
            {P.markets.flatMap((m) => m.lots).map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.id}</td><td>{MARKETS[l.market].base}</td>
                <td className="r num">{fmtUnits(l.qtyRemaining, MARKETS[l.market].baseDecimals, 2)}</td>
                <td className="r num">${px8(l.entryPrice)}</td><td className="r num">{usd(l.realisedUsd)}</td>
                <td className="num">{dateTime(l.openedAt)}</td><td><Badge tone={l.closedAt ? "mute" : "info"}>{l.closedAt ? "closed" : "open"}</Badge></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </Card>
      <Inspector>
        <h2>Epoch</h2>
        {P.markets.map((m) => (
          <div key={m.market}>
            <b>{MARKETS[m.market].base}</b>
            <KV k="spent">{usd(m.epoch.spentUsd)} of {usd(m.epoch.capUsd)}</KV>
            <KV k="resets">{dateTime(m.epoch.resetsAt)}</KV>
            <KV k="turnover left">{usd(m.turnoverRemainingUsd)}</KV>
          </div>
        ))}
      </Inspector>
    </>
  );
}
function Stat({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="stat"><span className="k">{k}</span><span className="sv">{v}</span></div>;
}
