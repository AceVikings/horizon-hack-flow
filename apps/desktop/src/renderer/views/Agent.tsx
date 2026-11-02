// Agent & strategy (Flow v1, simplified per docs/design/flow/SIMPLIFY.md): "How should your agent trade?" —
// Careful / Balanced / Active presets, the model, on / suggest-only / off; looser changes wait under "Needs your OK"
// for Touch ID. Strategy numbers (yours vs agent-tuned), effort and runner details sit behind "Advanced".
import { useState } from "react";
import { MARKETS, RISK_PROFILES, type MarketId, type RiskProfile, type StrategyGetOutput, type StrategyParams } from "@ate/core";
import type { AiHealth, EngineProviders, PendingChange, Res, TraderStatus } from "@shared/bridge";
import { useApp, useNow, useRemote } from "../src/app";
import { ago, int } from "../src/format";
import { PageHead, useNav } from "../src/shell";
import { Btn, Seg } from "../src/ui";
import { CodeApprove, approveRiskier } from "./approveCode";
import type { ViewProps } from "./registry";

type Mode = "autonomous" | "propose" | "watch";
const HSK: MarketId = "hsk-dex:WHSK/USDT:3000";
const BTC: MarketId = "hsk-dex:WBTC/USDT:3000";
const offline = <T,>(m: string): Promise<Res<T>> => Promise.resolve({ ok: false, error: { code: "ATE_INTERNAL", message: m } });

const PRESETS: { id: RiskProfile; name: string }[] = [
  { id: "conservative", name: "Careful" },
  { id: "balanced", name: "Balanced" },
  { id: "aggressive", name: "Active" },
];
const presetLine = (p: RiskProfile) => {
  const r = RISK_PROFILES[p];
  return `$${Number(r.tradeSizeUsd)} trades. Sells if a trade is down ${r.stopLossBps / 100}%. Trades when the gap beats costs by ${r.minNetEdgeBps / 100}%.`;
};

function profileOf(s: StrategyGetOutput | null, m: MarketId): RiskProfile | null {
  if (!s) return null;
  const a = { ...s.strategy.markets[m], ...s.anchors[m] };
  for (const [id, p] of Object.entries(RISK_PROFILES) as [RiskProfile, (typeof RISK_PROFILES)[RiskProfile]][]) {
    if (Number(a.tradeSizeUsd) === Number(p.tradeSizeUsd) && a.entrySpreadBps === p.entrySpreadBps && a.minNetEdgeBps === p.minNetEdgeBps && a.stopLossBps === p.stopLossBps) return id;
  }
  return null;
}

const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
const scopeLabel = (s: string) => (s === "portfolio" ? "all" : (MARKETS[s as MarketId]?.asset.replace("WHSK", "HSK").replace("WBTC", "BTC") ?? s));
const FIELD: Record<string, string> = { stopLossBps: "Sell-if-down", takeProfitBps: "Take profit", tradeSizeUsd: "Trade size", entrySpreadBps: "Entry gap", minNetEdgeBps: "Min edge", targetAssets: "Holds", cycleSeconds: "Checks every", maxPositionUsd: "Max position" };
const val = (f: string, v: unknown) => (Array.isArray(v) ? (v.length ? v.map((x) => String(x).replace(/^W/, "")).join(", ") : "cash only") : f.endsWith("Bps") ? `${Number(v) / 100}%` : f.endsWith("Usd") ? `$${Number(v)}` : f === "cycleSeconds" ? `${v} s` : String(v));
const via = (v: string) => (v === "chat" ? "From Ask" : v === "ui" ? "From this app" : v === "session" ? "From ate chat" : `From ${v}`);

export default function Agent(_: ViewProps) {
  const { ate, vsOk, toast } = useApp();
  const go = useNav();
  const now = useNow(1000);
  const [busy, setBusy] = useState<string | null>(null);
  const [adv, setAdv] = useState(false);
  const [market, setMarket] = useState<MarketId>(BTC);
  const trader = useRemote<TraderStatus>(() => (ate.trader ? ate.trader.status() : offline("trader control needs the live daemon")), [], { every: 5000 });
  const strat = useRemote(() => ate.strategy.get(), []);
  const ai = useRemote<AiHealth>(() => (ate.ai ? ate.ai.health() : offline("AI engine needs the live daemon")), [], { every: 15000 });
  const prov = useRemote<EngineProviders>(() => (ate.engine ? ate.engine.providers() : offline("AI engine needs the live daemon")), [], { every: 30000 });
  const pend = useRemote<PendingChange[]>(() => (ate.approvals ? ate.approvals.list() : Promise.resolve({ ok: true as const, data: [] })), [], { every: 4000 });

  const t = trader.last;
  const st = vsOk?.status;
  const s = strat.last;
  const pending = (pend.last ?? []).filter((p) => p.expiresAt > now);
  const mode: Mode | "" = !t ? "" : t.running ? t.mode : t.external ? "autonomous" : "watch";
  const ph = profileOf(s, HSK);
  const pb = profileOf(s, BTC);
  const preset = ph && ph === pb ? ph : null;
  const sel = prov.last?.providers.find((p) => p.selected);
  const models = sel?.models.filter((m) => m.tools !== false) ?? [];

  const act = async (key: string, f: () => Promise<Res<unknown>>, okText?: string) => {
    setBusy(key);
    try {
      const r = await f();
      // approval-required results are explained by the caller (they land under "Needs your OK")
      if (!r.ok && r.error.code !== "ATE_APPROVAL_REQUIRED") toast({ kind: "error", text: r.error.message, ...(r.error.hint ? { sub: r.error.hint } : {}) });
      else if (okText) toast({ kind: "ok", text: okText });
      return r;
    } finally {
      setBusy(null);
      trader.reload();
      strat.reload();
      pend.reload();
      ai.reload();
      prov.reload();
    }
  };
  const setMode = (m: Mode) => {
    if (!ate.trader || m === mode) return;
    if (m === "watch") return void act("mode", () => ate.trader!.stop(), "Agent paused. The vault still sells to protect you.");
    // without an AI account the agent runs on simple rules (same guard, same limits) until one is connected
    const engine = ai.last?.credential === "none" ? "rules" : "llm";
    void act("mode", () => ate.trader!.start({ mode: m, engine }), `${m === "propose" ? "The agent now only suggests trades" : "The agent is trading"}${engine === "rules" ? " on simple rules (no AI account yet)" : ""}`);
  };
  const setPreset = async (p: RiskProfile) => {
    const r = await act("preset", () => ate.strategy.set({ riskProfile: p }, `Desktop: trade ${PRESETS.find((x) => x.id === p)!.name.toLowerCase()} (${p})`));
    if (!r.ok && r.error.code === "ATE_APPROVAL_REQUIRED") toast({ kind: "info", text: `${PRESETS.find((x) => x.id === p)!.name} takes more risk`, sub: "Approve it below with Touch ID" });
    else if (r.ok) toast({ kind: "ok", text: `Trading ${PRESETS.find((x) => x.id === p)!.name.toLowerCase()}` });
  };
  const setModel = (m: string) => sel && void act("model", () => ate.engine!.select(sel.id, m), `Model: ${models.find((x) => x.id === m)?.label ?? m}`);
  const [codes, setCodes] = useState<Record<string, { code: string; expiresAt: number } | null>>({});
  const approve = async (p: PendingChange) => {
    // go to cash only tightens risk: a plain confirm, no Touch ID
    if (p.confirm === "sells_now") return act(p.changeId, () => (ate.approvals ? ate.approvals.confirm(p.changeId) : Promise.resolve({ ok: false as const, error: { code: "ATE_INTERNAL" as never, message: "offline" } })), "Confirmed. The vault sells now.");
    setBusy(p.changeId);
    const r = await approveRiskier(ate, p.changeId);
    setBusy(null);
    if (r.done) toast({ kind: "ok", text: "Approved" });
    else if (r.code) setCodes((c) => ({ ...c, [p.changeId]: r.code }));
    else toast({ kind: "error", text: r.message });
    pend.reload();
    strat.reload();
  };
  const reject = (p: PendingChange) => act(p.changeId, () => (ate.approvals ? ate.approvals.reject(p.changeId) : Promise.resolve({ ok: true as const, data: null })), "Rejected. Nothing changed.");

  const status = t?.stopping ? "Stopping after this check." : t?.running ? (t.mode === "propose" ? "Your agent suggests trades. It does not trade." : t.runtime === "rules" ? "Your agent is trading on simple rules (no AI account yet)." : "Your agent is trading.") : t?.external ? "Your agent is trading (started outside Flow)." : t ? "Your agent is off. The vault still sells to protect you." : "";

  return (
    <div className="page1">
      <PageHead title="Agent" sub="How should your agent trade?" />

      {pending.length > 0 && (
        <section className="card" style={{ border: "2px solid var(--c)", padding: "16px 20px", marginBottom: 22 }} aria-label="Needs your OK">
          <header className="ch">
            <h2 className="h4">Needs your OK</h2>
            <span className="sm b7 num">{pending.length} waiting</span>
          </header>
          {pending.map((p, i) => (
            <div key={p.changeId} style={i ? { marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" } : undefined}>
              <div className="sm">
                <span className="fg2">{via(p.via)} · </span>“{p.rationale.slice(0, 140)}”
              </div>
              <div className="sm" style={{ marginTop: 8 }}>
                {p.diff.map((d) => (
                  <div key={`${d.scope}${d.field}`}>
                    {FIELD[d.field] ?? d.field} ({scopeLabel(d.scope)}): <s className="fg2">{val(d.field, d.before)}</s> → <b>{val(d.field, d.after)}</b>
                  </div>
                ))}
              </div>
              <div className="row g8" style={{ marginTop: 12, alignItems: "center" }}>
                <Btn kind="pri" disabled={busy === p.changeId} onClick={() => void approve(p)}>
                  {p.confirm === "sells_now" ? "Confirm" : busy === p.changeId ? "Touch ID…" : "Approve with Touch ID"}
                </Btn>
                <Btn disabled={busy === p.changeId} onClick={() => void reject(p)}>
                  Reject
                </Btn>
                <span className="xs fg2 num" style={{ marginLeft: "auto" }}>
                  {p.confirm === "sells_now" ? "sells now" : "takes more risk"} · expires in {mmss(p.expiresAt - now)}
                </span>
              </div>
              {codes[p.changeId] && (
                <CodeApprove
                  ate={ate}
                  changeId={p.changeId}
                  code={codes[p.changeId]!}
                  onDone={(ok, m) => {
                    toast(ok ? { kind: "ok", text: "Approved" } : { kind: "error", text: m ?? "Code rejected" });
                    if (ok) setCodes((c) => ({ ...c, [p.changeId]: null }));
                    pend.reload();
                    strat.reload();
                  }}
                />
              )}
            </div>
          ))}
        </section>
      )}

      <div className="sentence" style={{ fontSize: 20 }} role="status">
        {status || "Reading your agent…"}
      </div>
      <div style={{ marginTop: 14 }}>
        <Seg<Mode | "">
          label="Agent"
          value={mode}
          onChange={(m) => m && setMode(m)}
          options={[
            { id: "autonomous", label: "Let it trade" },
            { id: "propose", label: "Only suggest" },
            { id: "watch", label: "Off" },
          ]}
        />
      </div>

      <h2 className="h4" style={{ marginTop: 32 }}>How boldly</h2>
      <div className="starts" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))", marginTop: 10 }} role="radiogroup" aria-label="How boldly">
        {PRESETS.map((p) => (
          <button key={p.id} className="start" role="radio" aria-checked={preset === p.id} disabled={busy === "preset"} onClick={() => preset !== p.id && void setPreset(p.id)} style={preset === p.id ? { background: "var(--y)", borderColor: "var(--c)" } : undefined}>
            <div>
              <div className="st">
                {preset === p.id && <span aria-hidden="true">✓ </span>}
                {p.name}
              </div>
              <div className="sd">{presetLine(p.id)}</div>
            </div>
          </button>
        ))}
      </div>
      {s && !preset && <div className="xs fg2" style={{ marginTop: 8 }}>Your settings are custom. Pick one to reset both markets.</div>}

      <h2 className="h4" style={{ marginTop: 32 }}>Model</h2>
      <div className="row g10" style={{ marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select className="inp" aria-label="Model" style={{ width: 280 }} value={ai.last?.model ?? ""} disabled={!sel || busy === "model"} onChange={(e) => setModel(e.target.value)}>
          {!models.some((m) => m.id === ai.last?.model) && ai.last && <option value={ai.last.model}>{ai.last.modelLabel}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="sm fg2">
          {sel ? `${sel.label}${sel.configured ? "" : " · not set up"}` : (ai.last?.providerLabel ?? "")} ·{" "}
          <button className="disclose" style={{ padding: 0 }} onClick={() => go("accounts")}>
            Change provider
          </button>
        </span>
      </div>
      {ai.last && ai.last.credential === "none" && <div className="xs bad b7" style={{ marginTop: 6 }}>No API key for {ai.last.providerLabel}. Add one in Accounts.</div>}

      <div style={{ marginTop: 28 }}>
        <button className="disclose" aria-expanded={adv} onClick={() => setAdv(!adv)}>
          <span aria-hidden="true">{adv ? "▾" : "▸"}</span> Advanced
        </button>
      </div>
      {adv && (
        <div style={{ marginTop: 12 }}>
          <section className="card" style={{ padding: "14px 20px" }} aria-label="Strategy">
            <header className="ch">
              <h2 className="h4">Strategy · {MARKETS[market].label}</h2>
              <Seg<MarketId> label="Market" value={market} onChange={setMarket} options={[{ id: HSK, label: "HSK" }, { id: BTC, label: "BTC" }]} />
            </header>
            {s ? <StrategyTable s={s} m={market} /> : <div className="sm fg2">{strat.res && !strat.res.ok ? strat.res.error.message : "Reading strategy…"}</div>}
            <div className="xs fg2 mt8">The agent may tune its own numbers within ×{s?.strategy.portfolio.agentTuneRange[0] ?? 0.5}–×{s?.strategy.portfolio.agentTuneRange[1] ?? 1.5} of yours. Every change is journalled.</div>
          </section>
          <section className="card" style={{ padding: "14px 20px", marginTop: 14 }} aria-label="Runner">
            <div className="kv"><span className="k">Runs</span><span className="v">{t?.runtime === "rules" ? "rules engine (no AI)" : ai.last?.engine === "claude-code" ? "Claude Code CLI" : `in Flow · ${ai.last?.providerLabel ?? ""}`}</span></div>
            <div className="kv"><span className="k">Effort</span><span className="v">{ai.last ? `trader ${ai.last.traderEffort} · chat ${ai.last.chatEffort}` : "—"}</span></div>
            <div className="kv"><span className="k">Last check</span><span className="v num">{(t?.lastCycleAt ?? st?.trader.lastCycleAt) ? ago((t?.lastCycleAt ?? st?.trader.lastCycleAt)!, now) : "—"}</span></div>
            <div className="kv"><span className="k">Checks</span><span className="v num">{st ? int(st.cycles) : "—"}{t?.running ? ` · every ${t.cycleSeconds} s` : ""}</span></div>
            <div className="kv"><span className="k">Agent gas</span><span className="v num">{st ? `${Number(st.gas.agentHsk).toFixed(3)} HSK` : "—"}</span></div>
            {ai.last?.lastUsage && <div className="kv"><span className="k">Prompt cache</span><span className="v num">{int(ai.last.lastUsage.cacheReadTokens)} tokens read · {ai.last.lastUsage.kind}</span></div>}
            {t?.lastError && <div className="xs bad" style={{ marginTop: 8 }}>Last check: {t.lastError.slice(0, 160)}</div>}
            <div className="xs fg2" style={{ marginTop: 8 }}>“Off” stops the AI here. The vault still sells to protect you. To stop everything, use Pause on Home.</div>
          </section>
        </div>
      )}
    </div>
  );
}

function StrategyTable({ s, m }: { s: StrategyGetOutput; m: MarketId }) {
  const cur = s.strategy.markets[m] as StrategyParams["markets"][MarketId];
  const anc = s.anchors[m];
  const pf = s.strategy.portfolio;
  const [lo, hi] = pf.agentTuneRange;
  const range = (a: number, unit: string, dp = 0) => `${(a * lo).toFixed(dp)} – ${(a * hi).toFixed(dp)}${unit}`;
  const usdR = (a: number) => `$${(a * lo).toFixed(2).replace(/\.00$/, "")} – $${(a * hi).toFixed(2).replace(/\.00$/, "")}`;
  const tuned = (yours: number, now: number, fmt: (n: number) => string, tighterWhenUp: boolean) =>
    yours === now ? (
      fmt(now)
    ) : (
      <span className="info b7">
        <span aria-hidden="true">{now > yours === tighterWhenUp ? "↑" : "↓"}</span> {fmt(now)} · {now > yours === tighterWhenUp ? "tighter" : "looser"}
      </span>
    );
  const rows: [string, string, React.ReactNode, string][] = [
    ["Trade size", `$${Number(anc.tradeSizeUsd)}`, tuned(Number(anc.tradeSizeUsd), Number(cur.tradeSizeUsd), (n) => `$${n}`, false), usdR(Number(anc.tradeSizeUsd))],
    ["Entry spread", `${anc.entrySpreadBps} bps`, tuned(anc.entrySpreadBps, cur.entrySpreadBps, String, true), range(anc.entrySpreadBps, "")],
    ["Min net edge", `${anc.minNetEdgeBps} bps`, tuned(anc.minNetEdgeBps, cur.minNetEdgeBps, String, true), range(anc.minNetEdgeBps, "")],
    ["Stop-loss", `${cur.stopLossBps} bps`, String(cur.stopLossBps), "yours only"],
    ["Take-profit", `${cur.takeProfitBps} bps`, String(cur.takeProfitBps), "yours only"],
    ["Cycle", `${anc.cycleSeconds} s`, tuned(anc.cycleSeconds, cur.cycleSeconds, (n) => `${n} s`, true), range(anc.cycleSeconds, " s")],
    ["Discretionary", `${pf.discretionaryTradesPerDay} × $${Number(pf.discretionaryUsd)}/day`, "same", "yours only"],
  ];
  return (
    <table className="tbl cmp sm">
      <thead>
        <tr>
          <th scope="col">Setting</th>
          <th className="r" scope="col">Yours</th>
          <th className="r" scope="col">Agent-tuned</th>
          <th className="r" scope="col">Agent may set</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, y, a, r]) => (
          <tr key={k}>
            <td>{k}</td>
            <td className="r b7 num">{y}</td>
            <td className="r num">{a}</td>
            <td className="r fg2 num">{r}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
