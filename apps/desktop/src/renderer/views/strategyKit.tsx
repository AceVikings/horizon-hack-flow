// Lane STRAT: shared pieces of the strategy screens (Agent → Your strategies, Strategy, Practice): the daemon call,
// result types, the P&L chart with decision markers (hover shows the plain summary), the plain numbers, the trades
// and data notes behind disclosures, and "Use on HSK/BTC" with Touch ID (or the one-time code) when it raises risk.
import { useState, type ReactNode } from "react";
import type { ChartMarker, ChartSpec, SavedStrategy, StrategySpec } from "@ate/core";
import type { AteBridge, Res, StratPath } from "@shared/bridge";
import { ChartView } from "../src/charts";
import { Btn, Stat } from "../src/ui";
import { CodeApprove, approveRiskier } from "./approveCode";

export type { SavedStrategy, StrategySpec };

export interface SimTrade {
  t: number;
  market: string;
  side: "buy" | "sell";
  usd: number;
  price: number;
  feeUsd: number;
  by: "rules" | "llm" | "guard";
  reason: string;
  pnlUsd?: number;
}
export interface SimDecision {
  t: number;
  cycle: number;
  market: string;
  action: "bought" | "sold" | "skipped" | "vetoed" | "sized_down" | "timeout";
  usd: number;
  by: "rules" | "llm" | "guard";
  summary: string;
}
export interface BtResult {
  days: number;
  capitalUsd: number;
  pnlUsd: number;
  returnPct: number;
  trades: SimTrade[];
  buys: number;
  sells: number;
  winRate: number | null;
  roundTrips: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  feesUsd: number;
  timeInMarketPct: number;
  curve: { t: number; v: number }[];
  decisions: SimDecision[];
  hold: { pnlUsd: number; returnPct: number };
  preset: { name: string; pnlUsd: number; returnPct: number; trades: number } | null;
  coverage: string[];
  summary: { line: string };
  sentences?: string[];
}

const offline = <T,>(): Promise<Res<T>> => Promise.resolve({ ok: false, error: { code: "ATE_INTERNAL" as never, message: "Strategies need the live daemon" } });
export const strat = <T,>(ate: AteBridge, path: StratPath, body?: unknown): Promise<Res<T>> => (ate.strat ? ate.strat.call<T>(path, body) : offline<T>());

export const money = (x: number, plus = true) => `${x < 0 ? "−" : plus && x > 0 ? "+" : ""}$${Math.abs(x).toFixed(Math.abs(x) >= 100 ? 0 : 2)}`;
export const pct = (x: number, plus = true) => `${x < 0 ? "−" : plus && x > 0 ? "+" : ""}${Math.abs(x).toFixed(Math.abs(x) >= 10 ? 1 : 2).replace(/\.?0+$/, "") || "0"}%`;
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ACTION: Record<SimDecision["action"], string> = { bought: "Bought", sold: "Sold", skipped: "Skipped", vetoed: "Said no to", sized_down: "Bought less", timeout: "Ran out of time on" };

/** P&L over time with decision markers. `compare` adds a second (muted) line, e.g. the rules-only run. */
export function PnlChart({ curve, decisions, compare, height = 260 }: { curve: { t: number; v: number }[]; decisions: SimDecision[]; compare?: { label: string; curve: { t: number; v: number }[] } | null; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const markers: ChartMarker[] = decisions.slice(-300).map((d, k) => ({
    t: d.t,
    kind: d.action === "bought" || d.action === "sized_down" ? "buy" : d.action === "sold" ? "sell" : "no_trade",
    label: d.summary,
    id: `d${k}`,
  }));
  const spec: ChartSpec = {
    v: 1,
    kind: "pnl",
    title: "",
    caption: "",
    x: { type: "time" },
    // dates on the axis for multi-day runs
    ...(curve.length > 1 && curve[curve.length - 1]!.t - curve[0]!.t > 2 * 86_400 ? { interval: "1d" as const } : {}),
    series: [
      { id: "pnl", label: "Profit and loss", type: "area", unit: "usd", pane: 0, role: "primary", points: dedupe(curve) },
      ...(compare && compare.curve.length ? [{ id: "cmp", label: compare.label, type: "line" as const, unit: "usd" as const, pane: 0 as const, role: "muted" as const, points: dedupe(compare.curve) }] : []),
    ],
    overlays: [],
    markers,
    lines: [{ v: 0, label: "Start", role: "muted" }],
    sources: [],
    generatedAt: 0,
    notes: [],
    input: { kind: "pnl" },
  };
  const near = hover === null ? [] : decisions.filter((d) => Math.abs(d.t - hover) <= 900).slice(0, 3);
  const at = hover === null ? null : [...curve].reverse().find((p) => p.t <= hover);
  return (
    <div>
      <div className="sm" style={{ minHeight: 20 }} aria-live="polite">
        {hover !== null && (
          <span>
            <span className="fg2">{when(hover)}</span>
            {at && <span className="num b7"> · {money(at.v)}</span>}
            {near.map((d, k) => (
              <span key={k}>
                {" · "}
                {ACTION[d.action]} {d.action === "skipped" || d.action === "vetoed" || d.action === "timeout" ? "a" : `$${d.usd.toFixed(2)}`}
                {d.action === "skipped" || d.action === "vetoed" || d.action === "timeout" ? " trade" : ""}
                {d.summary ? `: ${d.summary.replace(/^(Bought|Sold):\s*/, "")}` : ""}
                {d.by === "llm" ? " (AI)" : ""}
              </span>
            ))}
          </span>
        )}
      </div>
      <ChartView spec={spec} height={height} onCrosshair={(r) => setHover(r ? r.t : null)} />
      {compare && compare.curve.length > 0 && <div className="xs fg2 mt4">The grey line is {compare.label.toLowerCase()}.</div>}
    </div>
  );
}

function dedupe(xs: { t: number; v: number }[]) {
  const m = new Map<number, number>();
  for (const p of xs) m.set(p.t, p.v);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

/** The plain numbers: result, trades, won, worst dip, fees. */
export function Numbers({ r }: { r: Pick<BtResult, "pnlUsd" | "returnPct" | "trades" | "buys" | "winRate" | "maxDrawdownPct" | "feesUsd" | "roundTrips"> }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: 16 }}>
      <Stat label="Result" value={pct(r.returnPct)} sub={money(r.pnlUsd)} tone={r.pnlUsd > 0 ? "ok" : r.pnlUsd < 0 ? "bad" : undefined} />
      <Stat label="Trades" value={String(r.trades.length)} sub={`${r.buys} buys`} />
      <Stat label="Won" value={r.winRate === null ? "—" : `${Math.round(r.winRate * 100)}%`} sub={r.roundTrips ? `of ${r.roundTrips} closed` : "none closed"} />
      <Stat label="Worst dip" value={r.maxDrawdownPct ? `−${r.maxDrawdownPct}%` : "0%"} />
      <Stat label="Fees" value={money(r.feesUsd, false)} />
    </div>
  );
}

function Disclose({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <button className="disclose" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> {label}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

/** A finished backtest: chart, numbers, one comparison sentence, trades and data notes behind disclosures. */
export function ResultView({ r, compare }: { r: BtResult; compare?: { label: string; curve: { t: number; v: number }[] } | null }) {
  const vs = [`Just holding: ${pct(r.hold.returnPct)}`, ...(r.preset ? [`${r.preset.name}: ${pct(r.preset.returnPct)} (${r.preset.trades} trades)`] : [])];
  return (
    <div>
      <PnlChart curve={r.curve} decisions={r.decisions.filter((d) => d.action !== "skipped" || d.by !== "rules")} compare={compare ?? null} />
      <div style={{ marginTop: 18 }}>
        <Numbers r={r} />
      </div>
      <div className="sm" style={{ marginTop: 14 }}>
        {vs.join(". ")}. Time holding a position: {r.timeInMarketPct}%.
      </div>
      <Disclose label={`Trades (${r.trades.length})`}>
        <table className="tbl sm">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
              <th className="r" scope="col">Amount</th>
              <th className="r" scope="col">Made</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {r.trades.slice(-200).map((t, k) => (
              <tr key={k}>
                <td className="num">{when(t.t)}</td>
                <td>{t.side === "buy" ? "Buy" : "Sell"} {t.market.includes("WBTC") ? "BTC" : "HSK"}</td>
                <td className="r num">${t.usd.toFixed(2)}</td>
                <td className={`r num${(t.pnlUsd ?? 0) > 0 ? " ok" : (t.pnlUsd ?? 0) < 0 ? " bad" : ""}`}>{t.pnlUsd === undefined ? "" : money(t.pnlUsd)}</td>
                <td className="fg2">{t.reason}{t.by === "llm" ? " (AI)" : t.by === "guard" ? " (safety rule)" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Disclose>
      <Disclose label="About the data">
        <ul className="sm" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          {r.coverage.map((c, k) => (
            <li key={k}>{c}</li>
          ))}
          <li>Simulated on past prices with your vault's limits. Past results do not promise future ones.</li>
        </ul>
      </Disclose>
    </div>
  );
}

/** "Use on HSK / BTC" and "Stop using": safer applies at once; riskier asks for Touch ID (or the one-time code). */
export function UseButtons({ ate, s, toast, onDone }: { ate: AteBridge; s: SavedStrategy; toast(t: { kind: "ok" | "error" | "info"; text: string; sub?: string }): void; onDone(): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState<{ changeId: string; code: { code: string; expiresAt: number } | null } | null>(null);
  const use = async (market: "HSK" | "BTC", on: boolean) => {
    setBusy(market);
    try {
      const r = await strat<{ result: Res<unknown>; riskier: boolean; reasons: string[] }>(ate, "/strategies/use", { id: on ? s.id : null, market });
      if (!r.ok) return toast({ kind: "error", text: r.error.message });
      const res = r.data.result;
      if (res.ok) {
        toast({ kind: "ok", text: on ? `“${s.spec.name}” now trades ${market}` : `${market} is back on your preset` });
        return onDone();
      }
      const changeId = (res.error.details as { changeId?: string } | undefined)?.changeId;
      if (res.error.code !== "ATE_APPROVAL_REQUIRED" || !changeId) return toast({ kind: "error", text: res.error.message });
      toast({ kind: "info", text: "This takes more risk", sub: r.data.reasons.length ? `It has ${r.data.reasons.join(", ")}. Approve with Touch ID.` : "Approve with Touch ID." });
      const a = await approveRiskier(ate, changeId);
      if (a.done) {
        toast({ kind: "ok", text: on ? `“${s.spec.name}” now trades ${market}` : `${market} is back on your preset` });
        onDone();
      } else if (a.code) setCode({ changeId, code: a.code });
      else toast({ kind: "error", text: a.message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <div className="row g8" style={{ flexWrap: "wrap" }}>
        {s.spec.markets.map((m) =>
          s.activeOn.includes(m) ? (
            <Btn key={m} disabled={!!busy} onClick={() => void use(m, false)}>
              {busy === m ? "Working…" : `Stop using on ${m}`}
            </Btn>
          ) : (
            <Btn key={m} kind="pri" disabled={!!busy} onClick={() => void use(m, true)}>
              {busy === m ? "Working…" : `Use on ${m}`}
            </Btn>
          ),
        )}
      </div>
      {code && (
        <CodeApprove
          ate={ate}
          changeId={code.changeId}
          code={code.code}
          onDone={(ok, m) => {
            toast(ok ? { kind: "ok", text: "Approved" } : { kind: "error", text: m ?? "Code rejected" });
            if (ok) {
              setCode(null);
              onDone();
            }
          }}
        />
      )}
    </div>
  );
}
