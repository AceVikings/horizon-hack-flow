// Activity (SIMPLIFY.md): decisions, trades and positions in one plain timeline; details on expand.
// Pro mode shows the dense v1 panels (20 Decisions / 40 Positions). `#/activity/<id>` is the full record (21).
import { useState } from "react";
import { MARKETS, MARKET_IDS, type JournalEntry } from "@ate/core";
import type { ViewProps } from "./registry";
import Decisions from "./Decisions";
import Positions from "./Positions";
import { useApp, useRemote } from "../src/app";
import { PageHead, useMode, useNav } from "../src/shell";
import { Btn, Empty, ErrorBox, Seg, Skeleton } from "../src/ui";
import { dayKey, dayName, hm, money, tokenAmt } from "../src/format";
import { clean, decidedBy, marketOf, tradeLine } from "../src/journal";

export default function Activity({ params }: ViewProps) {
  const [mode] = useMode();
  const [tab, setTab] = useState<"decisions" | "positions">("decisions");
  if (params[0]) return <Decisions params={params} />;
  if (mode === "simple") return <SimpleActivity />;
  return (
    <>
      <div style={{ paddingTop: 18 }}>
        <Seg label="Activity view" value={tab} onChange={setTab} options={[{ id: "decisions", label: "Decisions" }, { id: "positions", label: "Positions" }]} />
      </div>
      {tab === "decisions" ? <Decisions params={[]} /> : <Positions params={[]} />}
    </>
  );
}

const REASON: Record<string, string> = {
  ATE_POLICY_COOLDOWN: "too soon after the last trade",
  ATE_POLICY_EPOCH_CAP: "today's budget is used up",
  ATE_POLICY_TRADE_CAP: "over the per-trade limit",
  ATE_POLICY_EXPOSURE: "it would hold too much",
  ATE_ORACLE_DEVIATION: "the pool price was too far from the oracle",
  ATE_ORACLE_STALE: "the oracle price was too old",
  ATE_POLICY_PAUSED: "trading is paused",
  ATE_STRATEGY_BLOCKED: "your strategy doesn't allow it",
  ATE_SLIPPAGE: "the price moved too much",
  ATE_TOOL_NOT_ALLOWED: "that key isn't allowed to do it",
  ATE_POLICY_NOT_AGENT: "that key isn't allowed to do it",
  ATE_INSUFFICIENT_BALANCE: "not enough funds in the vault",
};

/** One plain sentence per record (no bps, hashes or codes). null = not shown in the simple timeline. */
function plain(e: JournalEntry): { icon: string; text: string; tone: "ok" | "bad" | "" } | null {
  const m = marketOf(e);
  const asset = m ? MARKETS[m].base : "";
  if (e.kind === "execution") {
    if (e.execution?.reverted || !e.verdict.ok) return { icon: "✕", text: `A ${asset} trade was refused by the vault${REASON[e.verdict.code] ? ": " + REASON[e.verdict.code] : ""}`, tone: "bad" };
    const t = tradeLine(e) ?? `Traded ${asset}`;
    return { icon: "✓", text: `${t}${decidedBy(e) === "guard" ? " (safety rule)" : decidedBy(e) === "you" ? " (you)" : ""}`, tone: "ok" };
  }
  if (e.kind === "proposal") {
    if (e.verdict.ok) return null; // the execution line tells the story
    const side = e.intent?.side === "sell" ? "sell" : "buy";
    return { icon: "✕", text: `Wanted to ${side} ${asset}, but ${REASON[e.verdict.code] ?? "the vault said no"}`, tone: "bad" };
  }
  if (e.kind === "strategy_change") return { icon: "✎", text: `You changed the strategy: “${clean(e.rationale).replace(/\.$/, "")}”`, tone: "" };
  if (e.kind === "pause") return { icon: "❚❚", text: "Trading was paused on both vaults", tone: "bad" };
  if (e.kind === "outcome" && e.outcome) return { icon: "i", text: `Skipping a trade earlier ${e.outcome.savedBps >= 0 ? "saved" : "cost"} ${money(Math.abs(Number(e.outcome.savedUsd)))}`, tone: e.outcome.savedBps >= 0 ? "ok" : "" };
  return null;
}

function SimpleActivity() {
  const { ate, vsOk } = useApp();
  const go = useNav();
  const j = useRemote(() => ate.journal.list({ limit: 200 }), []);
  const [open, setOpen] = useState<string | null>(null);
  const [skips, setSkips] = useState(false);
  const entries = j.last?.entries ?? [];
  const shown = entries.map((e) => ({ e, p: plain(e) })).filter((x) => x.p || (skips && x.e.kind === "no_trade"));
  const checks = entries.filter((e) => e.kind === "no_trade").length;
  const days: { key: string; at: number; rows: typeof shown }[] = [];
  for (const x of shown) {
    const k = dayKey(x.e.at);
    const d = days[days.length - 1];
    if (d && d.key === k) d.rows.push(x);
    else days.push({ key: k, at: x.e.at, rows: [x] });
  }
  const pos = vsOk?.positions;

  return (
    <div className="page1">
      <PageHead title="Activity" sub="What your agent did, and what you hold now" />
      {pos && (
        <section className="card" aria-label="What you hold" style={{ padding: "18px 22px" }}>
          <h2 className="h4" style={{ marginBottom: 10 }}>What you hold</h2>
          {MARKET_IDS.map((m) => {
            const p = pos.markets.find((x) => x.market === m);
            if (!p) return null;
            const mk = MARKETS[m];
            const held = BigInt(p.qty) > 0n;
            return (
              <div key={m} className="row sb" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <span style={{ fontSize: 15 }}>
                  <b>{held ? money(Number(p.exposureUsd)) : "$0.00"}</b> in {mk.base} <span className="fg2 sm">{held ? `${tokenAmt(p.qty, mk.baseDecimals)} ${mk.base}` : "all cash"}</span>
                </span>
                <span className="sm fg2">{money(Number(p.balanceQuote) / 1e6)} cash</span>
              </div>
            );
          })}
          <p className="sm" style={{ marginTop: 10 }}>
            If you sold everything now: <b className={Number(pos.portfolio.unrealisedExitUsd) < 0 ? "bad" : "ok"}>{Number(pos.portfolio.unrealisedExitUsd) > 0 ? "+" : ""}{money(Number(pos.portfolio.unrealisedExitUsd))}</b> compared with what you paid.
          </p>
        </section>
      )}

      <div className="row sb" style={{ marginTop: 26 }}>
        <h2 className="h4">Timeline</h2>
        {checks > 0 && <button className="linkbtn sm" onClick={() => setSkips((s) => !s)} aria-pressed={skips}>{skips ? "Hide checks without a trade" : `Show ${checks} checks without a trade`}</button>}
      </div>
      {j.res && !j.res.ok && !j.last ? (
        <ErrorBox code={j.res.error.code} message="Can't read the activity" hint={j.res.error.message} action={<Btn kind="solid" onClick={j.reload}>Retry</Btn>} />
      ) : !j.last ? (
        [0, 1, 2, 3].map((i) => <Skeleton key={i} h={20} style={{ margin: "18px 0" }} />)
      ) : shown.length === 0 ? (
        <Empty title="Nothing yet">{checks ? `The agent checked the markets ${checks} times and hasn't traded.` : "Your agent's first decisions show up here."}</Empty>
      ) : (
        days.map((d) => (
          <section key={d.key} aria-label={dayName(d.at)} style={{ marginTop: 10 }}>
            <div className="lbl" style={{ padding: "10px 4px 2px" }}>{d.key === dayKey(Math.floor(Date.now() / 1000)) ? "Today" : dayName(d.at)}</div>
            {d.rows.map(({ e, p }) => {
              const line = p ?? { icon: "·", text: `Checked ${marketOf(e) ? MARKETS[marketOf(e)!].label : "the markets"}, no trade`, tone: "" as const };
              const isOpen = open === e.id;
              return (
                <div key={e.id} className="act">
                  <button aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : e.id)}>
                    <span className="t">{hm(e.at)}</span>
                    <span className={`ic ${line.tone}`} aria-hidden="true">{line.icon}</span>
                    <span style={{ color: line.tone === "" && line.icon === "·" ? "var(--fg2)" : undefined }}>{line.text}</span>
                    <span className="xs fg2" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && (
                    <div className="more">
                      <p>{clean(e.thesis ?? e.rationale)}</p>
                      <button className="linkbtn sm" style={{ marginTop: 8 }} onClick={() => go("activity/" + e.id)}>Open the full record</button>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))
      )}
    </div>
  );
}
