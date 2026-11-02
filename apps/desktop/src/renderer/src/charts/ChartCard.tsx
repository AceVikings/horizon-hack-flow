// A chart with its plain-language frame: title, one-sentence caption, the chart, where the data came from, and
// small actions (Pin, timeframe, Add indicator). Used by Ask (inline tool results), Charts and Trade.
import { useState, type ReactNode } from "react";
import { CHART_INDICATORS, MARKETS, type ChartIndicator, type ChartInput, type ChartInterval, type ChartSpec, type DataTable } from "@ate/core";
import { ago, dateTime } from "../format";
import { ChartView } from "./Chart";

export const INDICATOR_LABEL: Record<ChartIndicator, string> = {
  ema20: "Average, 20 bars (EMA)",
  ema50: "Average, 50 bars (EMA)",
  sma20: "Simple average, 20 bars",
  sma50: "Simple average, 50 bars",
  vwap: "Average price by volume (VWAP)",
  bb20: "Bollinger bands",
  rsi14: "Momentum (RSI)",
  macd: "Trend (MACD)",
  atr14: "Volatility (ATR)",
  volume: "Volume",
};
const INTERVALS: ChartInterval[] = ["1m", "5m", "1h", "1d"];
const TIMEFRAMED = new Set(["price", "cex", "oracle", "spread", "volume", "pnl", "exposure", "budget"]);
const CANDLED = new Set(["price", "cex"]);

/** "HashKey Global · 2 min ago" — the freshest source, in plain words. */
export function sourceLine(sources: ChartSpec["sources"]): string {
  if (!sources.length) return "";
  const names = sources.map((s) => s.name.replace(/\s*\(.*\)$/, "")).join(" + ");
  const last = Math.max(...sources.map((s) => s.lastT ?? 0));
  return last ? `${names} · latest ${ago(last)}` : names;
}

export function ChartCard({
  spec,
  height = 260,
  actions,
  onChange,
  busy,
  compact,
}: {
  spec: ChartSpec;
  height?: number;
  /** Extra actions, right of the title (Pin, Remove …). */
  actions?: ReactNode;
  /** When set, shows timeframe and indicator controls; called with the new input. */
  onChange?(input: ChartInput): void;
  busy?: boolean;
  compact?: boolean;
}) {
  const [look, setLook] = useState<"line" | "candles">("line");
  const [menu, setMenu] = useState(false);
  const input = spec.input;
  const ind = input.indicators ?? [];
  const toggle = (i: ChartIndicator) => onChange?.({ ...input, indicators: ind.includes(i) ? ind.filter((x) => x !== i) : [...ind, i].slice(-4) });
  return (
    <section className={`chcard${compact ? " compact" : ""}${busy ? " busy" : ""}`} aria-label={spec.title}>
      <header className="chh">
        <div>
          <h3>{spec.title}</h3>
          <p className="chcap">{spec.caption}</p>
        </div>
        <div className="chact">{actions}</div>
      </header>
      {onChange && (
        <div className="chctl">
          {TIMEFRAMED.has(spec.kind) && (
            <div className="tf" role="group" aria-label="Timeframe">
              {INTERVALS.map((iv) => (
                <button key={iv} className={iv === input.interval ? "on" : ""} onClick={() => onChange({ ...input, interval: iv })}>
                  {iv}
                </button>
              ))}
            </div>
          )}
          {CANDLED.has(spec.kind) && (
            <button className="lnk" onClick={() => setLook(look === "line" ? "candles" : "line")}>
              {look === "line" ? "Show candles" : "Show line"}
            </button>
          )}
          {CANDLED.has(spec.kind) && (
            <div className="addind">
              <button className="lnk" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                + Add indicator
              </button>
              {menu && (
                <div className="indmenu" role="menu" onMouseLeave={() => setMenu(false)}>
                  {CHART_INDICATORS.map((i) => (
                    <label key={i}>
                      <input type="checkbox" checked={ind.includes(i)} onChange={() => toggle(i)} /> {INDICATOR_LABEL[i]}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {ind.length > 0 && (
            <span className="indon">
              {ind.map((i) => (
                <button key={i} title="Remove" onClick={() => toggle(i)}>
                  {INDICATOR_LABEL[i].replace(/ \(.*\)$/, "")} ×
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      <ChartView spec={spec} height={height} look={look} />
      <footer className="chsrc">
        <span>{sourceLine(spec.sources)}</span>
        {spec.notes.length > 0 && <span className="chnote">{spec.notes[0]}</span>}
      </footer>
    </section>
  );
}

const fmtCell = (v: string | number | null, unit?: string): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (unit === "time") return typeof v === "number" ? dateTime(v) : String(v);
  if (unit === "usd") return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  if (unit === "price") {
    const n = Number(v);
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 2, minimumFractionDigits: n < 1 ? 4 : 2 })}`;
  }
  if (unit === "qty") return Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (unit === "tx") return `${String(v).slice(0, 8)}…`;
  if (v === "buy") return "Buy";
  if (v === "sell") return "Sell";
  return String(v);
};

export function DataTableCard({ table, actions, bare }: { table: DataTable; actions?: ReactNode; bare?: boolean }) {
  return (
    <section className={bare ? "chbare" : "chcard"} aria-label={table.title}>
      <header className="chh">
        <div>
          <h3>{table.title}</h3>
          <p className="chcap">{table.caption}</p>
        </div>
        <div className="chact">{actions}</div>
      </header>
      {table.rows.length ? (
        <div className="dtw">
          <table className="dt">
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c.key} className={c.align === "right" ? "r" : ""}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {table.columns.map((c) => (
                    <td key={c.key} className={c.align === "right" ? "r" : ""}>
                      {fmtCell(r[c.key] ?? null, c.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="chempty">Nothing to show yet.</p>
      )}
      <footer className="chsrc">
        <span>{sourceLine(table.sources)}</span>
        {table.notes.length > 0 && <span className="chnote">{table.notes[0]}</span>}
      </footer>
    </section>
  );
}

export const marketName = (m?: string) => (m && m in MARKETS ? MARKETS[m as keyof typeof MARKETS].label : "");
