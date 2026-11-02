// Strategy (lane STRAT): one of the user's own strategies. New: describe it in your words (the AI writes it) or fill
// in the form; Flow reads it back as sentences. Saved: the sentences, "Test on past data" (7/30/90 days) with one
// P&L chart and five plain numbers, "Use on HSK/BTC" (Touch ID when it takes more risk) and "Practise with the AI".
import { useEffect, useRef, useState } from "react";
import { SIGNAL_IDS, type Condition, type SignalId, type StrategySpec } from "@ate/core";
import { useApp, useRemote } from "../src/app";
import { PageHead, useNav } from "../src/shell";
import { Btn, Seg } from "../src/ui";
import type { ViewProps } from "./registry";
import { ResultView, UseButtons, strat, type BtResult, type SavedStrategy } from "./strategyKit";

const TEMPLATE: StrategySpec = {
  schema: "flow.strategy/v1",
  name: "My strategy",
  kind: "rules",
  markets: ["BTC"],
  barMinutes: 5,
  entry: { when: "all", conditions: [{ signal: "gap_cex", op: "below", value: -1 }] },
  exit: { when: "any", conditions: [], takeProfitPct: 0.8, stopLossPct: 2 },
  sizing: { mode: "usd", value: 10 },
  limits: { maxTradesPerDay: 4, cooldownMin: 30 },
};

const SIGNAL_LABEL: Record<SignalId, string> = {
  gap_cex: "Pool vs HashKey Global (%)",
  gap_oracle: "Pool vs oracle (%)",
  change: "Price change (%)",
  ema: "Price vs EMA (%)",
  sma: "Price vs average (%)",
  vwap: "Price vs VWAP (%)",
  rsi: "RSI (0–100)",
  bollinger: "Bollinger position (0 = low band, 1 = high)",
  hour: "Hour (UTC)",
  pnl: "Trade result (%)",
  ma_cross: "Fast vs slow average (%)",
  resistance: "Price vs recent high (%)",
  support: "Price vs recent low (%)",
  volatility: "Swings per bar (%)",
  trend: "Trend (%)",
  volume: "Pool volume (100 = usual)",
};
const needsPeriod = (s: SignalId) => s !== "gap_cex" && s !== "gap_oracle" && s !== "change" && s !== "hour" && s !== "pnl";

export default function Strategy({ params }: ViewProps) {
  const { ate, toast } = useApp();
  const go = useNav();
  const id = params[0] && params[0] !== "new" ? params[0] : null;
  const list = useRemote(() => strat<{ strategies: SavedStrategy[] }>(ate, "/strategies"), [id]);
  const saved = id ? (list.last?.strategies.find((s) => s.id === id) ?? null) : null;
  const [spec, setSpec] = useState<StrategySpec | null>(id ? null : null);
  const [editing, setEditing] = useState(!id);
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [sentences, setSentences] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [result, setResult] = useState<BtResult | null>(null);

  useEffect(() => {
    if (saved && !spec) setSpec(saved.spec);
  }, [saved, spec]);
  // live read-back of the form as sentences
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!spec || !editing) return;
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => {
      void strat<{ ok: boolean; sentences: string[]; errors: string[] }>(ate, "/strategies/describe", { spec }).then((r) => {
        if (r.ok) {
          setSentences(r.data.sentences);
          setErrors(r.data.errors);
        }
      });
    }, 250);
  }, [spec, editing, ate]);

  const draft = async () => {
    setBusy("draft");
    try {
      const r = await strat<{ spec: StrategySpec | null; sentences: string[]; errors: string[] }>(ate, "/strategies/draft", { text: words, ...(spec && id ? { base: spec } : {}) });
      if (!r.ok) return toast({ kind: "error", text: r.error.message });
      if (!r.data.spec) return toast({ kind: "error", text: "The AI could not turn that into a strategy", sub: r.data.errors.slice(0, 2).join("; ") });
      setSpec(r.data.spec);
      setSentences(r.data.sentences);
      setEditing(true);
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    if (!spec) return;
    setBusy("save");
    try {
      const r = await strat<SavedStrategy>(ate, "/strategies/save", { spec, ...(id ? { id } : {}) });
      if (!r.ok) return toast({ kind: "error", text: r.error.message });
      toast({ kind: "ok", text: id ? `Saved as version ${r.data.version}` : "Strategy saved", sub: "Saving does not change what trades." });
      setEditing(false);
      setResult(null);
      list.reload();
      if (!id) go(`strategy/${r.data.id}`);
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    setResult(null);
    try {
      const r = await strat<BtResult>(ate, "/backtest", id && !editing ? { strategyId: id, days: Number(days) } : { spec, days: Number(days) });
      if (!r.ok) return toast({ kind: "error", text: r.error.message });
      setResult(r.data);
      list.reload();
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!id) return;
    const r = await strat(ate, "/strategies/remove", { id });
    if (!r.ok) return toast({ kind: "error", text: r.error.message });
    toast({ kind: "ok", text: "Strategy deleted" });
    go("agent");
  };

  const shown = editing ? sentences : (saved?.sentences ?? sentences);
  return (
    <div className="page1">
      <PageHead title={saved ? saved.spec.name : "New strategy"} sub={saved ? `Version ${saved.version}${saved.activeOn.length ? ` · trading ${saved.activeOn.join(" and ")}` : ""}` : "Say what it should do. Flow reads it back."} crumb={<button className="disclose" style={{ padding: 0 }} onClick={() => go("agent")}>‹ Agent</button>} />

      {(!id || editing) && (
        <section style={{ marginTop: 8 }}>
          <label className="lbl" htmlFor="words">
            {id ? "Change it in your words" : "In your words"}
          </label>
          <textarea id="words" className="inp" style={{ height: 88, width: "100%", padding: 12, marginTop: 8, font: "500 15px/1.4 var(--body)", resize: "vertical" }} placeholder="Buy BTC when the pool is more than 1% under HashKey Global, sell at +0.8% or −2%" value={words} onChange={(e) => setWords(e.target.value)} />
          <div className="row g10 mt12">
            <Btn kind="pri" disabled={!words.trim() || busy === "draft"} onClick={() => void draft()}>
              {busy === "draft" ? "Writing it…" : "Write it for me"}
            </Btn>
            {!spec && <Btn onClick={() => setSpec(structuredClone(TEMPLATE))}>Fill in a form instead</Btn>}
          </div>
        </section>
      )}

      {shown.length > 0 && (
        <section className="card" style={{ marginTop: 22, padding: "18px 22px" }} aria-label="What it does">
          {shown.map((x, k) => (
            <p key={k} style={{ margin: k ? "8px 0 0" : 0, font: k ? "400 15px/1.45 var(--body)" : "600 17px/1.4 var(--body)" }}>
              {x}
            </p>
          ))}
          {saved?.lessons && saved.lessons.length > 0 && !editing && (
            <p className="sm fg2" style={{ margin: "12px 0 0" }}>
              Lessons from practice: {saved.lessons.join(" ")}
            </p>
          )}
        </section>
      )}
      {errors.length > 0 && editing && (
        <div className="sm bad" style={{ marginTop: 10 }}>
          {errors.slice(0, 3).map((e) => e.replace(/^[\w.]+: /, "")).join(". ")}
        </div>
      )}

      {editing && spec && <Form spec={spec} onChange={setSpec} />}

      {editing && spec && (
        <div className="row g10" style={{ marginTop: 18 }}>
          <Btn kind="pri" disabled={busy === "save" || errors.length > 0} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : id ? "Save new version" : "Save strategy"}
          </Btn>
          {id && (
            <Btn
              onClick={() => {
                setEditing(false);
                setSpec(saved?.spec ?? null);
              }}
            >
              Cancel
            </Btn>
          )}
        </div>
      )}

      {saved && !editing && (
        <>
          <div className="row g10" style={{ marginTop: 18, flexWrap: "wrap" }}>
            <UseButtons ate={ate} s={saved} toast={toast} onDone={() => list.reload()} />
            <Btn onClick={() => setEditing(true)}>Edit</Btn>
            <Btn onClick={() => go(`practice/${saved.id}`)}>Practise with the AI</Btn>
          </div>

          <h2 className="h4" style={{ marginTop: 34 }}>
            Test on past data
          </h2>
          <div className="row g10" style={{ marginTop: 10 }}>
            <Seg<"7" | "30" | "90"> label="Period" value={days} onChange={setDays} options={[{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "90", label: "90 days" }]} />
            <Btn kind="pri" disabled={busy === "test"} onClick={() => void test()}>
              {busy === "test" ? "Replaying…" : "Test on past data"}
            </Btn>
          </div>
          {busy === "test" && <div className="sm fg2 mt8">Loading {days} days of prices. The first time can take a minute or two.</div>}
          {!result && busy !== "test" && saved.lastBacktest && <div className="sm mt12">Last test: {saved.lastBacktest.line}.</div>}
          {result && (
            <section style={{ marginTop: 18 }}>
              <div className="sentence" style={{ fontSize: 20 }}>
                {result.summary.line}.
              </div>
              <div style={{ marginTop: 14 }}>
                <ResultView r={result} />
              </div>
            </section>
          )}
          <div style={{ marginTop: 36 }}>
            <button className="disclose" onClick={() => void remove()} disabled={saved.activeOn.length > 0}>
              Delete this strategy
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ form

function Num({ label, value, onChange, step = 0.1, unit, optional }: { label: string; value: number | undefined; onChange(v: number | undefined): void; step?: number; unit?: string; optional?: boolean }) {
  return (
    <label style={{ display: "block" }}>
      <span className="lbl">{label}</span>
      <span className="inp" style={{ marginTop: 6 }}>
        <input type="number" step={step} value={value ?? ""} placeholder={optional ? "off" : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} aria-label={label} />
        {unit && <span className="u">{unit}</span>}
      </span>
    </label>
  );
}

function CondRow({ c, onChange, onRemove, exit }: { c: Condition; onChange(c: Condition): void; onRemove(): void; exit?: boolean }) {
  const sigs = SIGNAL_IDS.filter((s) => exit || s !== "pnl");
  return (
    <div className="row g8" style={{ marginTop: 8, flexWrap: "wrap" }}>
      <select className="inp" aria-label="Signal" style={{ width: 250 }} value={c.signal} onChange={(e) => onChange({ ...c, signal: e.target.value as SignalId, ...(needsPeriod(e.target.value as SignalId) && !c.period ? { period: 20 } : {}), ...(e.target.value === "change" && !c.windowMin ? { windowMin: 60 } : {}) })}>
        {sigs.map((s) => (
          <option key={s} value={s}>
            {SIGNAL_LABEL[s]}
          </option>
        ))}
      </select>
      <select className="inp" aria-label="Is" style={{ width: 120 }} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as Condition["op"], ...(e.target.value === "between" && c.value2 === undefined ? { value2: c.value + 1 } : {}) })}>
        <option value="below">is below</option>
        <option value="above">is above</option>
        <option value="between">is between</option>
        <option value="crosses_above">crosses above</option>
        <option value="crosses_below">crosses below</option>
      </select>
      <span className="inp" style={{ width: 96 }}>
        <input type="number" step={0.1} aria-label="Value" value={c.value} onChange={(e) => onChange({ ...c, value: Number(e.target.value) })} />
      </span>
      {c.op === "between" && (
        <span className="inp" style={{ width: 96 }}>
          <input type="number" step={0.1} aria-label="and" value={c.value2 ?? ""} onChange={(e) => onChange({ ...c, value2: Number(e.target.value) })} />
        </span>
      )}
      {needsPeriod(c.signal) && (
        <span className="inp" style={{ width: 120 }}>
          <input type="number" step={1} aria-label="Bars" value={c.period ?? 20} onChange={(e) => onChange({ ...c, period: Number(e.target.value) })} />
          <span className="u">bars</span>
        </span>
      )}
      {c.signal === "ma_cross" && (
        <span className="inp" style={{ width: 130 }}>
          <input type="number" step={1} aria-label="Slow bars" value={c.period2 ?? 50} onChange={(e) => onChange({ ...c, period2: Number(e.target.value) })} />
          <span className="u">slow</span>
        </span>
      )}
      {c.signal === "change" && (
        <span className="inp" style={{ width: 120 }}>
          <input type="number" step={5} aria-label="Minutes" value={c.windowMin ?? 60} onChange={(e) => onChange({ ...c, windowMin: Number(e.target.value) })} />
          <span className="u">min</span>
        </span>
      )}
      <button className="disclose" onClick={onRemove} aria-label="Remove this rule">
        Remove
      </button>
    </div>
  );
}

function Form({ spec, onChange }: { spec: StrategySpec; onChange(s: StrategySpec): void }) {
  const set = (p: Partial<StrategySpec>) => onChange({ ...spec, ...p });
  const markets = (m: "HSK" | "BTC") => {
    const has = spec.markets.includes(m);
    const next = has ? spec.markets.filter((x) => x !== m) : [...spec.markets, m];
    if (next.length) set({ markets: next });
  };
  return (
    <section className="card" style={{ marginTop: 18, padding: "18px 22px" }} aria-label="Details">
      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", gap: 14 }}>
        <label style={{ display: "block" }}>
          <span className="lbl">Name</span>
          <span className="inp" style={{ marginTop: 6 }}>
            <input value={spec.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} aria-label="Name" />
          </span>
        </label>
        <div>
          <span className="lbl">Who decides</span>
          <div style={{ marginTop: 6 }}>
            <Seg<"rules" | "ai"> label="Who decides" value={spec.kind} onChange={(k) => set({ kind: k })} options={[{ id: "rules", label: "The rules" }, { id: "ai", label: "AI checks" }]} />
          </div>
        </div>
      </div>
      <div className="row g18 mt16">
        <span className="lbl">Trades</span>
        {(["HSK", "BTC"] as const).map((m) => (
          <label key={m} className="row g6 sm">
            <input type="checkbox" checked={spec.markets.includes(m)} onChange={() => markets(m)} /> {m}
          </label>
        ))}
      </div>

      <h3 className="h4" style={{ marginTop: 22 }}>
        Buy when
      </h3>
      {spec.entry.conditions.length > 1 && (
        <div style={{ marginTop: 8 }}>
          <Seg<"all" | "any"> label="Match" value={spec.entry.when} onChange={(w) => set({ entry: { ...spec.entry, when: w } })} options={[{ id: "all", label: "All of these" }, { id: "any", label: "Any of these" }]} />
        </div>
      )}
      {spec.entry.conditions.map((c, k) => (
        <CondRow key={k} c={c} onChange={(n) => set({ entry: { ...spec.entry, conditions: spec.entry.conditions.map((x, j) => (j === k ? n : x)) } })} onRemove={() => spec.entry.conditions.length > 1 && set({ entry: { ...spec.entry, conditions: spec.entry.conditions.filter((_, j) => j !== k) } })} />
      ))}
      {spec.entry.conditions.length < 6 && (
        <button className="disclose mt8" onClick={() => set({ entry: { ...spec.entry, conditions: [...spec.entry.conditions, { signal: "rsi", op: "below", value: 30, period: 14 }] } })}>
          + Add a rule
        </button>
      )}

      <h3 className="h4" style={{ marginTop: 22 }}>
        Sell when
      </h3>
      <div className="grid mt8" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 12 }}>
        <Num label="Up by" unit="%" optional value={spec.exit.takeProfitPct} onChange={(v) => set({ exit: { ...spec.exit, takeProfitPct: v } })} />
        <Num label="Down by" unit="%" optional value={spec.exit.stopLossPct} onChange={(v) => set({ exit: { ...spec.exit, stopLossPct: v } })} />
        <Num label="Falls from its high by" unit="%" optional value={spec.exit.trailingStopPct} onChange={(v) => set({ exit: { ...spec.exit, trailingStopPct: v } })} />
        <Num label="Held for" unit="hours" step={1} optional value={spec.exit.maxHoldHours} onChange={(v) => set({ exit: { ...spec.exit, maxHoldHours: v } })} />
      </div>
      {spec.exit.conditions.map((c, k) => (
        <CondRow key={k} exit c={c} onChange={(n) => set({ exit: { ...spec.exit, conditions: spec.exit.conditions.map((x, j) => (j === k ? n : x)) } })} onRemove={() => set({ exit: { ...spec.exit, conditions: spec.exit.conditions.filter((_, j) => j !== k) } })} />
      ))}
      {spec.exit.conditions.length < 6 && (
        <button className="disclose mt8" onClick={() => set({ exit: { ...spec.exit, conditions: [...spec.exit.conditions, { signal: "ema", op: "below", value: 0, period: 20 }] } })}>
          + Add a sell rule
        </button>
      )}

      <h3 className="h4" style={{ marginTop: 22 }}>
        How much
      </h3>
      <div className="grid mt8" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 12, alignItems: "end" }}>
        <div>
          <span className="lbl">Size in</span>
          <div style={{ marginTop: 6 }}>
            <Seg<"usd" | "pct"> label="Size in" value={spec.sizing.mode} onChange={(m) => set({ sizing: { mode: m, value: m === "usd" ? 10 : 10 } })} options={[{ id: "usd", label: "Dollars" }, { id: "pct", label: "% of budget" }]} />
          </div>
        </div>
        <Num label={spec.sizing.mode === "usd" ? "Each buy" : "Share of the day's budget"} unit={spec.sizing.mode === "usd" ? "$" : "%"} step={1} value={spec.sizing.value} onChange={(v) => set({ sizing: { ...spec.sizing, value: v ?? 1 } })} />
        <Num label="Buys a day at most" step={1} value={spec.limits.maxTradesPerDay} onChange={(v) => set({ limits: { ...spec.limits, maxTradesPerDay: Math.round(v ?? 1) } })} />
        <Num label="Minutes between buys" step={5} value={spec.limits.cooldownMin} onChange={(v) => set({ limits: { ...spec.limits, cooldownMin: Math.round(v ?? 0) } })} />
      </div>

      {spec.kind === "ai" && (
        <label style={{ display: "block", marginTop: 18 }}>
          <span className="lbl">What the AI should look out for</span>
          <textarea className="inp" style={{ height: 70, width: "100%", padding: 10, marginTop: 6, font: "500 14px/1.4 var(--body)" }} maxLength={1000} value={spec.instructions ?? ""} onChange={(e) => set({ instructions: e.target.value || undefined })} placeholder="Skip when BTC is falling fast on the exchange" />
        </label>
      )}
    </section>
  );
}
