// Trade's chart (lane D4): simple by default — one price line — with a compact toolbar for the usual tools:
// line/candles, timeframes, indicators, compare (pool · HashKey Global · oracle), drawings saved per market
// (level, trendline, zone, Fibonacci, note), log scale, an OHLC readout, a cost-by-size view and recent trades.
// "Ask about this chart" sends the question to the chat agent (chat-scope tools only); a chart it builds with
// ate_chart (indicators, drawings, analysis) shows here, with "Keep drawings". Analysis is information, not advice.
import { useEffect, useMemo, useRef, useState } from "react";
import { ANALYSIS_DISCLAIMER, CHART_INDICATORS, MARKETS, type ChartDrawing, type ChartIndicator, type ChartInput, type ChartInterval, type ChartSpec, type DataTable, type DrawingKind, type MarketId } from "@ate/core";
import { useApp } from "../app";
import { Markdown } from "../Markdown";
import { ChartView, type Readout } from "./Chart";
import { DataTableCard, INDICATOR_LABEL, sourceLine } from "./ChartCard";
import { keepDrawings, useDrawings } from "./drawings";
import { isEmptySpec, loadWithTimeout } from "./load";
import { useChart } from "./useChart";

const INTERVALS: ChartInterval[] = ["1m", "5m", "1h", "1d"];
const TOOLS: { id: DrawingKind; name: string; hint: string }[] = [
  { id: "hline", name: "Level", hint: "Click the chart to place a level." },
  { id: "trend", name: "Trendline", hint: "Click the start, then the end of the line." },
  { id: "zone", name: "Zone", hint: "Click two corners of the zone." },
  { id: "fib", name: "Fibonacci", hint: "Click the swing start, then the swing end." },
  { id: "text", name: "Note", hint: "Type the note, then click where it goes." },
];
const COMPARE: { id: "cex" | "oracle"; name: string }[] = [
  { id: "cex", name: "HashKey Global" },
  { id: "oracle", name: "Oracle" },
];
const BARS: Record<ChartInterval, number> = { "1m": 120, "5m": 144, "1h": 72, "1d": 60 };

function Menu({ label, open, onOpen, children }: { label: string; open: boolean; onOpen(o: boolean): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onOpen(false);
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open, onOpen]);
  return (
    <div className="tmenu" ref={ref}>
      <button className="tbtn" aria-expanded={open} onClick={() => onOpen(!open)}>
        {label} ▾
      </button>
      {open && <div className="indmenu">{children}</div>}
    </div>
  );
}

const money = (v: number | undefined) => (v === undefined ? "—" : `$${v.toLocaleString(undefined, { maximumFractionDigits: v < 1 ? 6 : 2, minimumFractionDigits: v < 1 ? 4 : 2 })}`);
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function TradeChart({ market, height = 300 }: { market: MarketId; height?: number }) {
  const { ate } = useApp();
  const label = MARKETS[market].label;
  const [view, setView] = useState<"chart" | "depth" | "trades">("chart");
  const [interval, setIv] = useState<ChartInterval>("1h");
  const [indicators, setInd] = useState<ChartIndicator[]>([]);
  const [compare, setCompare] = useState<("cex" | "oracle")[]>([]);
  const [look, setLook] = useState<"line" | "candles">("line");
  const [log, setLog] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const [note, setNote] = useState("");
  const [readout, setReadout] = useState<Readout | null>(null);
  const [agentSpec, setAgentSpec] = useState<ChartSpec | null>(null);
  const [hl, setHl] = useState<string | null>(null);
  const draw = useDrawings(market);
  useEffect(() => {
    setAgentSpec(null);
    setTool(null);
  }, [market]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && setTool(null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const input = useMemo<ChartInput>(() => ({ kind: "price", market, interval, bars: BARS[interval], ...(indicators.length ? { indicators } : {}), ...(compare.length ? { compare } : {}) }), [market, interval, indicators, compare]);
  const { spec: mine, error, busy, retry } = useChart(input);
  const spec = agentSpec ?? mine;
  const toggle = <T,>(xs: T[], x: T): T[] => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const candles = spec?.series.find((s) => s.type === "candles")?.candles;
  const last = candles?.at(-1);
  const r = readout ?? (last ? { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c } : null);

  // ---- analyse without the agent (deterministic, same backend) and ask the agent
  const [analysing, setAnalysing] = useState(false);
  const analyseNow = async () => {
    if (!ate.charts) return;
    setAnalysing(true);
    const res = await loadWithTimeout(() => ate.charts!.chart({ ...input, analyse: true }));
    setAnalysing(false);
    if (res.ok) setAgentSpec(res.data);
  };

  const toolbar = (
    <div className="ttools" role="toolbar" aria-label="Chart tools">
      <div className="tf" role="group" aria-label="Timeframe">
        {INTERVALS.map((iv) => (
          <button key={iv} className={iv === interval ? "on" : ""} onClick={() => (setAgentSpec(null), setIv(iv))}>
            {iv}
          </button>
        ))}
      </div>
      <div className="tf" role="group" aria-label="Chart type">
        <button className={look === "line" ? "on" : ""} onClick={() => setLook("line")}>
          Line
        </button>
        <button className={look === "candles" ? "on" : ""} onClick={() => setLook("candles")}>
          Candles
        </button>
      </div>
      <Menu label="Indicators" open={menu === "ind"} onOpen={(o) => setMenu(o ? "ind" : null)}>
        {CHART_INDICATORS.filter((i) => i !== "atr14").map((i) => (
          <label key={i}>
            <input type="checkbox" checked={indicators.includes(i)} onChange={() => (setAgentSpec(null), setInd(toggle(indicators, i).slice(-4)))} /> {INDICATOR_LABEL[i]}
          </label>
        ))}
      </Menu>
      <Menu label="Compare" open={menu === "cmp"} onOpen={(o) => setMenu(o ? "cmp" : null)}>
        {COMPARE.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={compare.includes(c.id)} onChange={() => (setAgentSpec(null), setCompare(toggle(compare, c.id)))} /> {c.name}
          </label>
        ))}
      </Menu>
      <Menu label={tool ? `Drawing: ${TOOLS.find((t) => t.id === tool)!.name}` : "Draw"} open={menu === "draw"} onOpen={(o) => setMenu(o ? "draw" : null)}>
        {TOOLS.map((t) => (
          <button key={t.id} className="mi" onClick={() => (setTool(t.id), setMenu(null))}>
            {t.name}
          </button>
        ))}
        <hr />
        <button className="mi" disabled={!draw.drawings.length} onClick={() => draw.undo()}>
          Undo last drawing
        </button>
        <button className="mi" disabled={!draw.drawings.length} onClick={() => draw.clear()}>
          Clear my drawings
        </button>
      </Menu>
      <button className={`tbtn${log ? " on" : ""}`} aria-pressed={log} onClick={() => setLog(!log)} title="Logarithmic price scale">
        Log
      </button>
      <span className="grow" />
      <button className="tbtn" disabled={analysing} onClick={analyseNow}>
        {analysing ? "Analysing…" : "Analyse"}
      </button>
    </div>
  );

  return (
    <section className="chcard tchart" aria-label={`${label} chart`}>
      <header className="chh">
        <div className="tf" role="tablist" aria-label="View">
          {(["chart", "depth", "trades"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {v === "chart" ? "Price" : v === "depth" ? "Cost by size" : "Recent trades"}
            </button>
          ))}
        </div>
        {view === "chart" && r && (
          <p className="ohlc" aria-live="off">
            {r.c !== undefined ? (
              <>
                O {money(r.o)} · H {money(r.h)} · L {money(r.l)} · C <b>{money(r.c)}</b>
              </>
            ) : (
              <b>{money(r.v)}</b>
            )}
            <span> · {when(r.t)}</span>
          </p>
        )}
      </header>
      {view === "chart" && (
        <>
          {toolbar}
          {tool && (
            <div className="thint">
              <span>{TOOLS.find((t) => t.id === tool)!.hint}</span>
              {tool === "text" && <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note text" aria-label="Note text" maxLength={80} />}
              <button className="lnk" onClick={() => setTool(null)}>
                Done
              </button>
            </div>
          )}
          {!spec ? (
            <div className="chstate" style={{ height }}>
              <p className="chempty">{busy && !error ? "Loading the price…" : "Could not load the price chart."}</p>
              {error && <p className="chsub">{error}</p>}
              {!busy && (
                <button className="lnk" onClick={retry}>
                  Try again
                </button>
              )}
            </div>
          ) : isEmptySpec(spec) ? (
            <div className="chstate" style={{ height }}>
              <p className="chempty">No price history yet — trades will appear here.</p>
              <button className="lnk" onClick={retry}>
                Try again
              </button>
            </div>
          ) : (
            <ChartView
              spec={spec}
              height={height}
              look={look}
              logScale={log}
              drawings={draw.drawings}
              highlight={hl}
              onCrosshair={setReadout}
              drawTool={tool}
              drawText={note}
              onDraw={(d) => {
                draw.add(d);
                if (d.kind === "text") setNote("");
              }}
            />
          )}
          {spec && <p className="chsrc">{sourceLine(spec.sources)}{spec.notes[0] ? ` · ${spec.notes[0]}` : ""}</p>}
          {agentSpec && <AnalysisPanel spec={agentSpec} market={market} onHover={setHl} onClose={() => setAgentSpec(null)} />}
          <AskChart market={market} context={`${label}, ${interval} bars${indicators.length ? `, indicators ${indicators.join(", ")}` : ""}`} onChart={setAgentSpec} />
        </>
      )}
      {view === "depth" && <DepthView market={market} />}
      {view === "trades" && <TradesView market={market} />}
    </section>
  );
}

/** Findings tied to drawings (hover highlights the drawing), the disclaimer, and Keep drawings. */
export function AnalysisPanel({ spec, market, onHover, onClose }: { spec: ChartSpec; market: MarketId; onHover?(id: string | null): void; onClose?(): void }) {
  const [kept, setKept] = useState(false);
  const ds = (spec.drawings ?? []).filter((d) => d.by !== "user");
  return (
    <div className="tanalysis">
      {spec.analysis ? (
        <>
          <p className="tsum">{spec.analysis.summary}</p>
          <ul>
            {spec.analysis.findings.map((f, i) => (
              <li key={i} className={f.tone ?? ""} onMouseEnter={() => onHover?.(f.drawingId ?? null)} onMouseLeave={() => onHover?.(null)}>
                {f.text}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="tsum">{spec.title}: {spec.caption}</p>
      )}
      <p className="tdisc">{spec.analysis?.disclaimer ?? ANALYSIS_DISCLAIMER}</p>
      <div className="row g10">
        {ds.length > 0 && (
          <button
            className="lnk"
            disabled={kept}
            onClick={() => {
              keepDrawings(market, ds);
              setKept(true);
            }}
          >
            {kept ? "Drawings kept on this chart" : `Keep drawings (${ds.length})`}
          </button>
        )}
        {onClose && (
          <button className="lnk" onClick={onClose}>
            Back to my chart
          </button>
        )}
      </div>
    </div>
  );
}

/** "Ask about this chart": a question to the chat agent; an ate_chart it builds for this market lands on the chart. */
function AskChart({ market, context, onChart }: { market: MarketId; context: string; onChart(s: ChartSpec): void }) {
  const { ate } = useApp();
  const sid = useMemo(() => `trade-${MARKETS[market].label.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`, [market]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const turn = useRef<string | null>(null);
  const cb = useRef(onChart);
  cb.current = onChart;
  useEffect(
    () =>
      ate.events.subscribe((e) => {
        if (e.type !== "chat.delta" && e.type !== "chat.tool") return;
        const d = e.data as { sessionId: string; turnId: string; role?: string; text?: string; done?: boolean; tool?: string; result?: unknown };
        if (d.sessionId !== sid) return;
        if (e.type === "chat.tool") {
          const r = d.result as { ok?: boolean; data?: ChartSpec } | undefined;
          if (d.tool === "ate_chart" && r?.ok && r.data && r.data.market === market && r.data.x.type === "time") cb.current(r.data);
          return;
        }
        if (d.role !== "agent") return;
        if (turn.current !== d.turnId) {
          turn.current = d.turnId;
          setReply("");
        }
        setReply((x) => (x ?? "") + (d.text ?? ""));
        if (d.done) setBusy(false);
      }),
    [ate, sid, market],
  );
  const ask = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setReply(null);
    setQ("");
    const r = await loadWithTimeout(() => ate.chat.send(sid, `${t}\n\n(Asked from the Trade screen about the ${context} chart. I trade myself: inform me, do not trade. To show something, call ate_chart for market ${market}; add analyse: true when I ask for analysis, support or resistance.)`), 15_000);
    if (!r.ok) {
      setBusy(false);
      setReply(`Could not ask the agent: ${r.error.message}`);
    } else setTimeout(() => setBusy(false), 90_000);
  };
  return (
    <div className="taskbox">
      <form
        className="taskf"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Ask about this chart — "Where is support?"`} aria-label="Ask the agent about this chart" maxLength={400} />
        <button className="tbtn" type="submit" disabled={busy || !q.trim()}>
          {busy ? "Asking…" : "Ask"}
        </button>
      </form>
      {reply === null && !busy && (
        <p className="tsugg">
          Try:{" "}
          {[`Show me ${MARKETS[market].label} with RSI and the 1% gap line`, "Where is support?", "Analyse the last 24 h"].map((s, i) => (
            <button key={s} className="lnk" onClick={() => void ask(s)}>
              {s}
              {i < 2 ? "" : ""}
            </button>
          ))}
        </p>
      )}
      {(reply || busy) && <div className="treply">{reply ? <Markdown text={reply} /> : "The agent is looking…"}</div>}
    </div>
  );
}

function DepthView({ market }: { market: MarketId }) {
  const { spec, error, busy, retry } = useChart({ kind: "depth", market }, 30_000);
  if (!spec)
    return (
      <div className="chstate" style={{ height: 300 }}>
        <p className="chempty">{busy && !error ? "Getting live quotes…" : "Could not get live quotes."}</p>
        {!busy && (
          <button className="lnk" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    );
  return (
    <>
      <p className="chcap">{spec.caption}</p>
      <ChartView spec={spec} height={280} />
      <p className="chsrc">{sourceLine(spec.sources)}</p>
    </>
  );
}

function TradesView({ market }: { market: MarketId }) {
  const { ate } = useApp();
  const [t, setT] = useState<DataTable | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    if (!ate.charts) return void setErr("Needs the Flow service.");
    void loadWithTimeout(() => ate.charts!.data({ table: "swaps", market, limit: 15 })).then((r) => {
      if (!live) return;
      if (r.ok) (setT(r.data), setErr(null));
      else setErr(r.error.message);
    });
    return () => {
      live = false;
    };
  }, [ate, market, n]);
  if (!t)
    return (
      <div className="chstate" style={{ height: 300 }}>
        <p className="chempty">{err ? "Could not load recent trades." : "Loading recent trades…"}</p>
        {err && (
          <button className="lnk" onClick={() => setN((x) => x + 1)}>
            Try again
          </button>
        )}
      </div>
    );
  return <DataTableCard table={t} bare />;
}

export type { ChartDrawing };
