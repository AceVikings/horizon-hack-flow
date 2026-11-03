// Ask: strategy work drawn inline. ate_backtest → a result card (P&L chart, the plain numbers, vs just holding, and the
// previous backtest in this conversation as a grey line); ate_strategy_save → a Save card (the strategy read back,
// Save strategy / Not now). Saving never changes what trades.
import { useState } from "react";
import { useApp } from "../src/app";
import { useNav } from "../src/shell";
import { Btn } from "../src/ui";
import { PnlChart, pct, strat, type SavedStrategy } from "./strategyKit";

export type AskBacktest = {
  name: string | null;
  days: number;
  curve: { t: number; v: number }[];
  pnlUsd: number;
  returnPct: number;
  trades: number;
  winRate: number | null;
  worstDipPct: number;
  feesUsd: number;
  justHolding: { pnlUsd: number; returnPct: number };
  currentSettings: { name: string; returnPct: number; trades: number } | null;
  coverage?: string[];
};

export const isAskBacktest = (d: unknown): d is AskBacktest => !!d && typeof d === "object" && Array.isArray((d as AskBacktest).curve) && typeof (d as AskBacktest).returnPct === "number";

const usd = (x: number) => `${x < 0 ? "−" : x > 0 ? "+" : ""}$${Math.abs(x).toFixed(2)}`;

function Num({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "bad" }) {
  return (
    <div>
      <div className="xs fg2" style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div className={`b7 num ${tone ?? ""}`} style={{ fontSize: 20, marginTop: 2 }}>{value}</div>
      {sub && <div className="xs fg2">{sub}</div>}
    </div>
  );
}

export function BacktestCard({ d, prev }: { d: AskBacktest; prev?: { label: string; curve: { t: number; v: number }[] } | null }) {
  const better = d.returnPct > d.justHolding.returnPct;
  return (
    <section className="tc" style={{ margin: "8px 0" }} aria-label="Backtest result">
      <div className="tch">
        <b>Backtest{d.name ? ` · ${d.name}` : ""}</b>
        <span className="grow" />
        <span className="xs fg2">last {d.days} days · simulated</span>
      </div>
      <div className="tcb">
        <PnlChart curve={d.curve} decisions={[]} compare={prev ?? null} height={180} />
        <div className="grid" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 14, marginTop: 12 }}>
          <Num label="Result" value={pct(d.returnPct)} sub={usd(d.pnlUsd)} tone={d.pnlUsd > 0 ? "ok" : d.pnlUsd < 0 ? "bad" : undefined} />
          <Num label="Trades" value={String(d.trades)} sub={d.winRate === null ? "none closed" : `${Math.round(d.winRate * 100)}% won`} />
          <Num label="Worst dip" value={d.worstDipPct ? `−${d.worstDipPct}%` : "0%"} />
          <Num label="Just holding" value={pct(d.justHolding.returnPct)} sub={usd(d.justHolding.pnlUsd)} tone={d.justHolding.pnlUsd < 0 ? "bad" : undefined} />
        </div>
        <div className="sm" style={{ marginTop: 10 }}>
          {better ? "Beat" : "Trailed"} just holding by <b>{Math.abs(d.returnPct - d.justHolding.returnPct).toFixed(2)} points</b>
          {d.currentSettings ? ` · your current ${d.currentSettings.name} settings: ${pct(d.currentSettings.returnPct)}` : ""}
          {prev ? ` · grey line: ${prev.label.toLowerCase()}` : ""}
        </div>
      </div>
    </section>
  );
}

export function SaveCard({ d }: { d: { pendingId: string; name: string; sentences: string[] } }) {
  const { ate, toast } = useApp();
  const go = useNav();
  const [st, setSt] = useState<"idle" | "busy" | "saved" | "dropped">("idle");
  const [savedId, setSavedId] = useState<string | null>(null);
  const save = async () => {
    setSt("busy");
    const r = await strat<SavedStrategy>(ate, "/strategies/confirm-save", { pendingId: d.pendingId });
    if (!r.ok) {
      setSt("idle");
      return toast({ kind: "error", text: "Couldn't save it", sub: r.error.message });
    }
    setSt("saved");
    setSavedId(r.data.id);
    toast({ kind: "ok", text: `Saved “${d.name}”`, sub: "It doesn't trade until you pick Use on BTC or HSK." });
  };
  const drop = async () => {
    setSt("busy");
    await strat(ate, "/strategies/drop-save", { pendingId: d.pendingId });
    setSt("dropped");
  };
  return (
    <section className="tc" style={{ borderColor: "var(--c)", borderWidth: 1.5, margin: "8px 0" }} aria-label="Save this strategy?">
      <div className="tch" style={{ background: "var(--y)" }}>
        <b>Save this strategy?</b>
        <span className="grow" />
        <span className="xs">{st === "saved" ? "saved" : st === "dropped" ? "not saved" : d.name}</span>
      </div>
      <div className="tcb">
        {d.sentences.map((x, i) => (
          <div key={i} className="sm" style={{ marginTop: i ? 4 : 0 }}>{x}</div>
        ))}
        <div className="xs fg2" style={{ marginTop: 8 }}>Saving never changes what trades. You pick where it runs afterwards.</div>
        {(st === "idle" || st === "busy") && (
          <div className="row g10" style={{ marginTop: 12 }}>
            <Btn kind="pri" disabled={st === "busy"} onClick={() => void save()}>Save strategy</Btn>
            <Btn disabled={st === "busy"} onClick={() => void drop()}>Not now</Btn>
          </div>
        )}
        {st === "saved" && savedId && (
          <div className="row g10" style={{ marginTop: 12 }}>
            <Btn onClick={() => go(`strategy/${savedId}`)}>Open it</Btn>
            <Btn onClick={() => go(`practice/${savedId}`)}>Practise with the AI</Btn>
          </div>
        )}
      </div>
    </section>
  );
}
