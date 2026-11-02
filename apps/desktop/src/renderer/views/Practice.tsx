// Practice (lane STRAT): past prices replayed as a live market on a fast clock, with your AI deciding through the same
// tools it uses live, against paper vaults (never your vault, never the journal). Pick the period, speed and how often
// the AI decides; see the cost first; watch it run; then "Improve it" (tested suggestions + lessons) and "Use this".
import { useEffect, useState } from "react";
import { useApp, useRemote } from "../src/app";
import { PageHead, useNav } from "../src/shell";
import { Btn, Seg } from "../src/ui";
import type { ViewProps } from "./registry";
import { PnlChart, ResultView, UseButtons, money, pct, strat, type BtResult, type SavedStrategy, type SimDecision } from "./strategyKit";

interface Estimate {
  aiCalls: number;
  costLine: string;
  minutes: number;
  candidateCycles: number;
  cycles: number;
}
interface RunState {
  runId: string;
  status: "running" | "paused" | "done" | "stopped" | "error";
  progress: number;
  virtualNow: number;
  speed: number;
  aiCalls: number;
  engine: { provider: string; model: string; mode: string } | null;
  curve: { t: number; v: number }[];
  decisions: SimDecision[];
  result: (BtResult & { aiCalls: number }) | null;
  rules: { pnlUsd: number; returnPct: number; trades: number; maxDrawdownPct: number; curve: { t: number; v: number }[] } | null;
  error: string | null;
}
interface Suggestion {
  changes: { path: string; value: number }[];
  sentence: string;
  effect: string;
  pnlDeltaUsd: number;
  source: "rules" | "ai";
  why?: string;
}
interface SweepOut {
  rows: { values: Record<string, number>; pnlUsd: number; returnPct: number; trades: number; winRate: number | null; maxDrawdownPct: number }[];
  best: { values: Record<string, number> } | null;
  holdout: { pnlUsd: number; returnPct: number; trades: number; current: { pnlUsd: number; returnPct: number } } | null;
  warning: string | null;
}

const SPEEDS = [
  { id: "60", label: "60×" },
  { id: "600", label: "600×" },
  { id: "0", label: "Fastest" },
];
const SAMPLE = [
  { id: "1", label: "Every time" },
  { id: "4", label: "1 in 4" },
  { id: "10", label: "1 in 10" },
];
const PATH_LABEL: Record<string, string> = { "exit.takeProfitPct": "Take profit (%)", "exit.stopLossPct": "Stop (%)", "sizing.value": "Size", "limits.cooldownMin": "Minutes between buys", "limits.maxTradesPerDay": "Buys a day" };

export default function Practice({ params }: ViewProps) {
  const { ate, toast } = useApp();
  const go = useNav();
  const id = params[0] ?? null;
  const list = useRemote(() => strat<{ strategies: SavedStrategy[] }>(ate, "/strategies"), [id]);
  const s = list.last?.strategies.find((x) => x.id === id) ?? null;
  const [days, setDays] = useState<"7" | "30" | "90">("7");
  const [speed, setSpeed] = useState("600");
  const [sample, setSample] = useState("4");
  const [est, setEst] = useState<Estimate | null>(null);
  const [estBusy, setEstBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [st, setSt] = useState<RunState | null>(null);
  const [train, setTrain] = useState<{ suggestions: Suggestion[]; lessons: string[]; aiNote: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // the estimate follows the choices
  useEffect(() => {
    if (!id) return;
    let live = true;
    setEstBusy(true);
    void strat<Estimate>(ate, "/practice/estimate", { strategyId: id, days: Number(days), sampleEvery: Number(sample) }).then((r) => {
      if (!live) return;
      setEstBusy(false);
      setEst(r.ok ? r.data : null);
      if (!r.ok) toast({ kind: "error", text: r.error.message });
    });
    return () => {
      live = false;
    };
  }, [id, days, sample, ate, toast]);

  // poll the run
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const tick = async () => {
      const r = await strat<RunState>(ate, "/practice/state", { runId });
      if (stop) return;
      if (r.ok) setSt(r.data);
      if (!r.ok || r.data.status === "running" || r.data.status === "paused") setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [runId, ate]);

  const start = async () => {
    setBusy("start");
    setTrain(null);
    setSt(null);
    const r = await strat<{ runId: string }>(ate, "/practice/start", { strategyId: id, days: Number(days), speed: Number(speed), sampleEvery: Number(sample) });
    setBusy(null);
    if (!r.ok) return toast({ kind: "error", text: r.error.message });
    setRunId(r.data.runId);
  };
  const control = async (action: "pause" | "resume" | "step" | "stop" | "speed", sp?: number) => {
    if (!runId) return;
    const r = await strat<RunState>(ate, "/practice/control", { runId, action, ...(sp !== undefined ? { speed: sp } : {}) });
    if (r.ok) setSt(r.data);
  };
  const improve = async () => {
    setBusy("train");
    const r = await strat<{ suggestions: Suggestion[]; lessons: string[]; aiNote: string | null }>(ate, "/train", { strategyId: id, days: Number(days), ...(runId ? { runId } : {}) });
    setBusy(null);
    if (!r.ok) return toast({ kind: "error", text: r.error.message });
    setTrain(r.data);
  };
  const adopt = async (changes: { path: string; value: number }[], lessons?: string[]) => {
    if (!id) return;
    const r = await strat<SavedStrategy>(ate, "/strategies/adopt", { id, changes, ...(lessons ? { lessons } : {}) });
    if (!r.ok) return toast({ kind: "error", text: r.error.message });
    toast({ kind: "ok", text: `Saved as version ${r.data.version}`, sub: "Run it again to check, then use it." });
    list.reload();
  };

  if (!id) return <div className="page1"><PageHead title="Practice" sub="Pick a strategy on the Agent page first." /></div>;
  const running = st && (st.status === "running" || st.status === "paused");
  const done = st && (st.status === "done" || st.status === "stopped") && st.result;
  return (
    <div className="page1">
      <PageHead title="Practice" sub={s ? `“${s.spec.name}” on past prices, with your AI deciding` : "Reading the strategy…"} crumb={<button className="disclose" style={{ padding: 0 }} onClick={() => go(s ? `strategy/${s.id}` : "agent")}>‹ {s?.spec.name ?? "Agent"}</button>} />

      {!running && (
        <section>
          <div className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 16 }}>
            <div>
              <span className="lbl">Period</span>
              <div className="mt8">
                <Seg<"7" | "30" | "90"> label="Period" value={days} onChange={setDays} options={[{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "90", label: "90 days" }]} />
              </div>
            </div>
            <div>
              <span className="lbl">Speed</span>
              <div className="mt8">
                <Seg<string> label="Speed" value={speed} onChange={setSpeed} options={SPEEDS} />
              </div>
            </div>
            <div>
              <span className="lbl">The AI decides</span>
              <div className="mt8">
                <Seg<string> label="The AI decides" value={sample} onChange={setSample} options={SAMPLE} />
              </div>
            </div>
          </div>
          <div className="sm" style={{ marginTop: 16 }} aria-live="polite">
            {estBusy ? "Loading past prices and counting the decisions…" : est ? `${est.costLine}${est.aiCalls ? ` It takes about ${Math.max(1, est.minutes)} minute${est.minutes > 1 ? "s" : ""}.` : ""} The rules decide the rest.` : ""}
          </div>
          <div className="row g10 mt12">
            <Btn kind="pri" disabled={!est || busy === "start"} onClick={() => void start()}>
              {busy === "start" ? "Starting…" : done ? "Run again" : "Start"}
            </Btn>
          </div>
          <div className="xs fg2 mt8">Paper money only. Nothing reaches your vault or your activity.</div>
        </section>
      )}

      {st && (
        <section style={{ marginTop: 26 }}>
          {running && (
            <div className="row g10" style={{ flexWrap: "wrap", alignItems: "center" }}>
              {st.status === "paused" ? <Btn kind="pri" onClick={() => void control("resume")}>Play</Btn> : <Btn onClick={() => void control("pause")}>Pause</Btn>}
              <Btn disabled={st.status !== "paused"} onClick={() => void control("step")}>
                One step
              </Btn>
              <Seg<string> label="Speed" value={String(st.speed)} onChange={(v) => void control("speed", Number(v))} options={SPEEDS} />
              <Btn onClick={() => void control("stop")}>Stop</Btn>
              <span className="sm fg2 num" style={{ marginLeft: "auto" }}>
                {new Date(st.virtualNow * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {Math.round(st.progress * 100)}% · {st.aiCalls} AI decisions
              </span>
            </div>
          )}
          {st.status === "error" && <div className="sm bad">The run stopped: {st.error}</div>}
          {running && (
            <div style={{ marginTop: 14 }}>
              <div className="sentence" style={{ fontSize: 20 }}>
                So far: {money(st.curve[st.curve.length - 1]?.v ?? 0)}
              </div>
              <div className="mt12">
                <PnlChart curve={st.curve} decisions={st.decisions.filter((d) => d.by !== "rules" || d.action !== "skipped")} compare={null} height={240} />
              </div>
              <LatestDecisions ds={st.decisions} />
            </div>
          )}
          {done && st.result && (
            <div>
              <div className="sentence" style={{ fontSize: 20 }}>
                {st.status === "stopped" ? "Stopped early. " : ""}
                {st.result.summary.line}. The rules alone: {pct(st.rules?.returnPct ?? 0)}.
              </div>
              <div className="mt12">
                <ResultView r={st.result} compare={st.rules ? { label: "The rules alone", curve: st.rules.curve } : null} />
              </div>
              <div className="row g10" style={{ marginTop: 22, flexWrap: "wrap" }}>
                <Btn kind="pri" disabled={busy === "train"} onClick={() => void improve()}>
                  {busy === "train" ? "Looking for improvements…" : "Improve it"}
                </Btn>
                {s && <UseButtons ate={ate} s={s} toast={toast} onDone={() => list.reload()} />}
              </div>
            </div>
          )}
        </section>
      )}

      {train && (
        <section style={{ marginTop: 26 }} aria-label="Improvements">
          <h2 className="h4">What would have helped</h2>
          {train.aiNote && <div className="sm fg2 mt8">{train.aiNote}</div>}
          {train.suggestions.length === 0 && <div className="sm mt8">No change we tried did better on this period. Keep it as it is, or test a longer period.</div>}
          {train.suggestions.map((g, k) => (
            <div key={k} className="card" style={{ marginTop: 12, padding: "14px 18px" }}>
              <div className="b7">{g.sentence}</div>
              <div className="sm mt4">{g.effect}</div>
              {g.why && <div className="xs fg2 mt4">The AI's reason: {g.why}</div>}
              <div className="row g8 mt12">
                <Btn kind="pri" onClick={() => void adopt(g.changes)}>
                  Save as new version
                </Btn>
              </div>
            </div>
          ))}
          {train.lessons.length > 0 && (
            <div className="card" style={{ marginTop: 12, padding: "14px 18px" }}>
              <div className="b7">Lessons for the AI</div>
              <ul className="sm" style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
                {train.lessons.map((l, k) => (
                  <li key={k}>{l}</li>
                ))}
              </ul>
              <div className="row g8 mt12">
                <Btn onClick={() => void adopt([], train.lessons)}>Keep these lessons</Btn>
              </div>
            </div>
          )}
          {s && <Sweep id={s.id} days={days} spec={s.spec} onAdopt={(c) => void adopt(c)} />}
        </section>
      )}
    </div>
  );
}

function LatestDecisions({ ds }: { ds: SimDecision[] }) {
  const xs = ds.filter((d) => d.by !== "rules" || d.action !== "skipped").slice(-5).reverse();
  if (!xs.length) return null;
  const A: Record<SimDecision["action"], string> = { bought: "Bought", sold: "Sold", skipped: "Skipped", vetoed: "Said no", sized_down: "Bought less", timeout: "Out of time" };
  return (
    <ul className="sm" style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
      {xs.map((d, k) => (
        <li key={k} style={{ padding: "6px 0", borderTop: k ? "1px solid var(--line)" : undefined }}>
          <span className="fg2 num">{new Date(d.t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span> · <b>{A[d.action]}</b>
          {d.action === "bought" || d.action === "sold" || d.action === "sized_down" ? ` $${d.usd.toFixed(2)}` : ""}
          {d.by === "llm" ? " (AI)" : ""} — {d.summary.replace(/^(Bought|Sold):\s*/, "")}
        </li>
      ))}
    </ul>
  );
}

/** Try a few values of two numbers on the first part of the period, check the best on the rest. */
function Sweep({ id, days, spec, onAdopt }: { id: string; days: string; spec: SavedStrategy["spec"]; onAdopt(c: { path: string; value: number }[]): void }) {
  const { ate, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<SweepOut | null>(null);
  const [metric, setMetric] = useState<"pnl" | "return_per_dip" | "win_rate">("pnl");
  const entry = spec.entry.conditions[0];
  const params: { path: string; values: number[]; label: string }[] = [];
  if (entry && entry.signal !== "hour") params.push({ path: "entry.conditions.0.value", values: [0.5, 0.75, 1, 1.5, 2].map((f) => Math.round(entry.value * f * 1000) / 1000), label: "Buy rule value" });
  if (spec.exit.takeProfitPct) params.push({ path: "exit.takeProfitPct", values: [0.5, 1, 1.5, 2].map((f) => Math.round(spec.exit.takeProfitPct! * f * 1000) / 1000), label: PATH_LABEL["exit.takeProfitPct"]! });
  else if (spec.exit.stopLossPct) params.push({ path: "exit.stopLossPct", values: [0.5, 1, 1.5].map((f) => Math.round(spec.exit.stopLossPct! * f * 1000) / 1000), label: PATH_LABEL["exit.stopLossPct"]! });
  const run = async () => {
    setBusy(true);
    const r = await strat<SweepOut>(ate, "/sweep", { strategyId: id, days: Number(days), params: params.map(({ path, values }) => ({ path, values })), metric });
    setBusy(false);
    if (!r.ok) return toast({ kind: "error", text: r.error.message });
    setOut(r.data);
  };
  const label = (p: string) => params.find((x) => x.path === p)?.label ?? PATH_LABEL[p] ?? p;
  return (
    <div style={{ marginTop: 18 }}>
      <button className="disclose" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> Try many settings
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <div className="sm">
            Tries {params.map((p) => `${p.label.toLowerCase()} (${p.values.join(", ")})`).join(" and ")} on the first 70% of the period, then checks the best on the last 30%, which it never saw.
          </div>
          <div className="row g10 mt12">
            <Seg<"pnl" | "return_per_dip" | "win_rate"> label="Best by" value={metric} onChange={setMetric} options={[{ id: "pnl", label: "Most profit" }, { id: "return_per_dip", label: "Profit per dip" }, { id: "win_rate", label: "Most wins" }]} />
            <Btn kind="pri" disabled={busy || params.length === 0} onClick={() => void run()}>
              {busy ? "Trying…" : "Try them"}
            </Btn>
          </div>
          {out && (
            <div style={{ marginTop: 14 }}>
              {out.warning && <div className="sm b7" style={{ marginBottom: 10 }}>{out.warning}</div>}
              {out.holdout && <div className="sm">On the unseen days, the best settings made {money(out.holdout.pnlUsd)} ({out.holdout.trades} trades); yours made {money(out.holdout.current.pnlUsd)}.</div>}
              <table className="tbl sm mt12">
                <thead>
                  <tr>
                    {params.map((p) => (
                      <th key={p.path} scope="col">
                        {p.label}
                      </th>
                    ))}
                    <th className="r" scope="col">Made</th>
                    <th className="r" scope="col">Trades</th>
                    <th className="r" scope="col">Worst dip</th>
                  </tr>
                </thead>
                <tbody>
                  {out.rows.slice(0, 12).map((r, k) => (
                    <tr key={k} className={k === 0 ? "sel" : undefined}>
                      {params.map((p) => (
                        <td key={p.path} className="num">
                          {r.values[p.path]}
                        </td>
                      ))}
                      <td className="r num">{money(r.pnlUsd)}</td>
                      <td className="r num">{r.trades}</td>
                      <td className="r num">{r.maxDrawdownPct ? `−${r.maxDrawdownPct}%` : "0%"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {out.best && (
                <div className="row g8 mt12">
                  <Btn onClick={() => onAdopt(Object.entries(out.best!.values).map(([path, value]) => ({ path, value })))}>Save the best as a new version</Btn>
                  <span className="xs fg2">{Object.entries(out.best.values).map(([p, v]) => `${label(p)} ${v}`).join(", ")}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

