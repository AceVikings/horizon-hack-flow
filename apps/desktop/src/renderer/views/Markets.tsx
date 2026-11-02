// 30 Markets (+ 31 no market enabled, 32 loading, 33 oracle stale / read error, 34 paused). Three prices, the gap,
// the cost, live candidates, vault limits; "Advanced: manual order" runs the propose → execute flow through the same
// on-chain check().
import { useEffect, useMemo, useRef, useState } from "react";
import { MARKETS, MARKET_WBTC, MARKET_WHSK, reasonName, type Candidate, type JournalEntry, type MarketId, type MarketView, type ProposeOutput, type Quote, type Side } from "@ate/core";
import type { ViewProps } from "./registry";
import { useApp, useNow, useRemote } from "../src/app";
import { ContextPanel, Inspector, PageHead, useMode, useNav } from "../src/shell";
import { Badge, Banner, Btn, Card, Empty, ErrorBox, Eyebrow, Gauge, KV, Link, Seg, Skeleton, StatPill, Table, TxLink } from "../src/ui";
import { age, explorer, fmtUnits, money, price8, tokenAmt, usdE8Short } from "../src/format";
import { centsE8, vaultRisk } from "../src/risk";
import { clean, marketOf } from "../src/journal";
import { PriceChart } from "../src/charts";

const ORDER: MarketId[] = [MARKET_WBTC, MARKET_WHSK];
const FEE_BPS = 30;
const byLabel = (s?: string): MarketId => ORDER.find((m) => MARKETS[m].label.toLowerCase() === (s ?? "").toLowerCase()) ?? MARKET_WBTC;
/** CEX mid vs pool, bps; positive = pool below HashKey Global. */
const gapBps = (mv: MarketView): number | null => (mv.cex ? Math.round(((Number(mv.cex.mid) - Number(mv.pool.price)) / Number(mv.pool.price)) * 10_000) : null);

export default function Trade(props: ViewProps) {
  const [mode] = useMode();
  return mode === "pro" ? <Markets {...props} /> : <SimpleTrade {...props} />;
}

/** Trade (SIMPLIFY.md): prices in dollars and one plain sentence per market, a chart, the manual order collapsed. */
function SimpleTrade({ params }: ViewProps) {
  const { mkOk, stale } = useApp();
  const go = useNav();
  const now = useNow();
  const market = byLabel(params[0]);
  const mkd = MARKETS[market];
  const mv = mkOk?.find((m) => m.market === market);
  const g = mv ? gapBps(mv) : null;
  const cost = FEE_BPS + (mv?.cex?.halfSpreadBps ?? 0) + 5;
  const pct = (bps: number) => `${(Math.abs(bps) / 100).toFixed(2)}%`;
  const line =
    g === null
      ? "HashKey Global has no price right now, so the agent waits."
      : g > cost
        ? `The pool is ${pct(g)} cheaper than HashKey Global. That beats the ${pct(cost)} trading cost, so buying can pay.`
        : g > 0
          ? `The pool is ${pct(g)} cheaper than HashKey Global. Costs are about ${pct(cost)}, so there's no edge yet.`
          : `The pool is ${pct(g)} dearer than HashKey Global. No reason to buy here now.`;
  return (
    <div className="page1">
      <PageHead title="Trade" sub="Prices, what they mean, and an order panel if you want to trade yourself" acts={<Seg label="Market" value={mkd.label} onChange={(l) => go(`trade/${l.toLowerCase()}`)} options={[{ id: "BTC", label: "BTC" }, { id: "HSK", label: "HSK" }]} />} />
      {!mv ? (
        <MarketsLoading />
      ) : (
        <div className="col" style={{ gap: 16 }}>
          {mv.vault.paused && <Banner tone="paused" icon="❚❚" title="Trading is paused" sub="Prices keep updating. Orders wait until you resume." action={<Btn kind="pri" onClick={() => go("home")}>Resume on owner device</Btn>} />}
          <section className={`card${stale ? " dim" : ""}`} style={{ padding: "22px 24px" }} aria-label={`${mkd.base} price`}>
            <div className="lbl">{mkd.label} price on HashKey Global</div>
            <div className="huge num" style={{ marginTop: 10 }}>{mv.cex ? price8(mv.cex.mid) : price8(mv.pool.price)}</div>
            <p style={{ fontSize: 15, marginTop: 12, maxWidth: 640 }}>{line}</p>
            <p className="sm fg2" style={{ marginTop: 6 }}>Pool {price8(mv.pool.price)} · oracle {price8(mv.oracle.price)}, updated {age(mv.oracle.ageSec + Math.max(0, now - mv.at))} ago</p>
          </section>
          <PriceChart market={market} />
          <ManualOrder key={market + (params[1] ?? "")} mv={mv} disabled={mv.vault.paused} initialOpen={params[1] === "order"} />
        </div>
      )}
    </div>
  );
}

function Markets({ params }: ViewProps) {
  const { ate, mkOk, mk, refresh, stale } = useApp();
  const go = useNav();
  const now = useNow();
  const market = byLabel(params[0]);
  const mkd = MARKETS[market];
  const cands = useRemote(() => (ate.candidates ? ate.candidates.get() : Promise.resolve({ ok: true as const, data: { candidates: [], suppressed: [], candidateTtlSec: 0, cycle: 0, generatedAt: 0 } })), [], { every: 10_000 });
  const strat = useRemote(() => ate.strategy.get(), [], { onEvents: true });
  const hist = useRemote(() => ate.journal.list({ limit: 200, market }), [market]);
  const [busy, setBusy] = useState(false);

  const mv = mkOk?.find((m) => m.market === market);
  const s = strat.last?.strategy;
  const enabledAny = s ? s.enabled && ORDER.some((m) => s.markets[m]?.enabled !== false) : true;
  const paused = !!mv?.vault.paused;
  const oracleAge = mv ? mv.oracle.ageSec + Math.max(0, now - mv.at) : 0;
  const oracleStale = !!mv && oracleAge > mv.vault.limits.maxOracleAge;
  const gap = mv ? gapBps(mv) : null;
  // newest per (market, generator, side, leg), unexpired; the daemon keeps a short history across cycles
  const allC = useMemo(() => {
    const best = new Map<string, Candidate>();
    for (const c of cands.last?.candidates ?? []) {
      if (c.expiresAt < now - 5) continue;
      const k = `${c.market}|${c.generator}|${c.side}|${c.leg ?? ""}`;
      const o = best.get(k);
      if (!o || (c.createdAt ?? 0) > (o.createdAt ?? 0)) best.set(k, c);
    }
    return [...best.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cands.last, Math.floor(now / 5)]);
  const sup = (cands.last?.suppressed ?? []).filter((x) => x.market === market);
  const mc = allC.filter((c) => c.market === market);
  const entry = mc.find((c) => c.generator === "spread-revert" || c.generator === "rebalance");
  const costBps = entry ? Math.round(entry.costBps) : FEE_BPS + (mv?.cex?.halfSpreadBps ?? 0) + 5;
  const minNet = s?.markets[market]?.minNetEdgeBps;
  const net = gap !== null ? gap - costBps : null;

  const { toast } = useApp();
  const enable = async (m: MarketId) => {
    setBusy(true);
    const r = await ate.strategy.set({ market: m, enabled: true }, `Enable ${MARKETS[m].base}/USDT from Markets (desktop)`);
    let fail = r.ok ? null : r.error;
    if (!r.ok && r.error.code === "ATE_APPROVAL_REQUIRED" && typeof r.error.details?.changeId === "string") {
      const a = await ate.strategy.approve(r.error.details.changeId);
      fail = a.ok ? null : a.error;
    }
    setBusy(false);
    strat.reload();
    if (fail) toast({ kind: "error", text: `Couldn't enable: ${fail.code}`, sub: fail.message });
    else toast({ kind: "ok", text: `${MARKETS[m].base}/USDT enabled` });
  };

  const loading = !mkOk && !mk;
  const readErr = mk && !mk.ok ? mk.error : null;

  return (
    <>
      <ContextPanel>
        <Eyebrow>Markets</Eyebrow>
        <div className="col g8" style={{ marginTop: 10 }} role="radiogroup" aria-label="Market">
          {ORDER.map((m) => {
            const v = mkOk?.find((x) => x.market === m);
            const g = v ? gapBps(v) : null;
            const c = allC.find((x) => x.market === m && (x.generator === "spread-revert" || x.generator === "rebalance"));
            const cost = c ? Math.round(c.costBps) : FEE_BPS + (v?.cex?.halfSpreadBps ?? 0) + 5;
            const on = m === market;
            return (
              <button key={m} role="radio" aria-checked={on} className={`card tight mbtn${on ? " on" : ""}`} style={{ textAlign: "left", opacity: enabledAny ? 1 : 0.5 }} onClick={() => go(`trade/${MARKETS[m].label.toLowerCase()}`)}>
                <div className="row sb">
                  <span className="h3">{MARKETS[m].base}/{MARKETS[m].quote}</span>
                  {g !== null && <Badge glyph="" y={on && g > cost}>{g > 0 ? "+" : g < 0 ? "−" : ""}{Math.abs(g)}</Badge>}
                </div>
                <div className="xs fg2 mt4">{g === null ? "no HashKey Global quote" : g > cost ? "gap bps vs HashKey Global" : `below cost ${cost} bps`} · Vault-{MARKETS[m].label}</div>
              </button>
            );
          })}
        </div>
        <Eyebrow style={{ marginTop: 20 }}>Sources</Eyebrow>
        {mv ? (
          <>
            <KV k="Supra oracle" className="sm mt8" vClass={oracleStale ? "bad b7" : ""}>{age(oracleAge)}</KV>
            <KV k="Pool TWAP" className="sm">{mv.pool.twap ? "300 s" : "unavailable"}</KV>
            <KV k="HashKey Global" className="sm">{mv.cex ? age(Math.max(0, now - mv.cex.at)) : "—"}</KV>
            <KV k="APRO" className="sm" vClass="fg2">{mv.apro ? `${age(mv.apro.ageSec)} · ${mv.apro.disagreeBps} bps` : "off on this chain"}</KV>
          </>
        ) : (
          <Skeleton h={90} style={{ marginTop: 8 }} />
        )}
        <div style={{ marginTop: "auto", paddingTop: 16 }}>
          <Btn size="sm" style={{ width: "100%" }} onClick={() => { refresh(); cands.reload(); }}>Refresh prices now</Btn>
        </div>
      </ContextPanel>

      <PageHead
        title="Markets"
        sub="Three prices, the gap, the cost, and what the agent may do about it"
        acts={stale || readErr ? <StatPill tone="bad">Prices unavailable</StatPill> : mv ? <StatPill tone={oracleStale ? "warn" : "ok"}>Live · {age(Math.max(0, now - mv.at))}</StatPill> : <StatPill tone="warn">Connecting…</StatPill>}
      />

      {loading ? (
        <MarketsLoading />
      ) : s && !enabledAny ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", minHeight: 420 }}>
          <div className="card" style={{ width: 520, padding: 32, textAlign: "center", borderStyle: "dashed" }}>
            <div className="disp" style={{ fontSize: 40 }}>No market enabled</div>
            <p className="fg2" style={{ marginTop: 12 }}>{s.enabled ? "Both markets are switched off in your strategy" : "The strategy is switched off"}, so the agent only watches. Turn one on here, in Agent, or ask Chat “trade BTC again”.</p>
            <div style={{ marginTop: 20 }}>
              <Btn kind="pri" disabled={busy} onClick={() => void enable(market)}>{busy ? "Waiting for approval…" : `Enable ${mkd.base}/USDT`}</Btn>
            </div>
            <p className="xs fg2" style={{ marginTop: 10 }}>Enabling loosens the strategy, so it asks for Touch ID.</p>
          </div>
        </div>
      ) : !mv ? (
        readErr ? <ErrorBox code={readErr.code} message="Can't read market data" hint={readErr.message} action={<Btn kind="solid" onClick={refresh}>Retry</Btn>} /> : <MarketsLoading />
      ) : (
        <div className="col" style={{ gap: 16 }}>
          {paused && <Banner tone="paused" icon="❚❚" title="Vaults paused · candidates are not traded" sub="Prices keep updating. Manual orders are disabled until the owner unpauses." action={<Btn kind="pri" onClick={() => go("home")}>Unpause on owner device</Btn>} />}
          {!paused && oracleStale && (
            <Banner tone="bad" icon="!" title={`Supra ${mkd.label}/USD is ${age(oracleAge)} old: over the vault's ${Math.round(mv.vault.limits.maxOracleAge / 3600)} h limit`} sub="Buys are refused on-chain (OracleStale) until it refreshes; the daemon pull-refreshes Supra before a trade. Exits still use the min(oracle, TWAP) floor." action={<Btn kind="solid" onClick={() => { refresh(); cands.reload(); }}>Refresh prices</Btn>} />
          )}
          {(stale || readErr) && <Banner tone="bad" icon="!" title="Prices are from the last good read" sub={(readErr ?? stale)!.message} action={<Btn kind="solid" onClick={refresh}>Retry</Btn>} />}
          <div className={oracleStale || stale ? "dim" : ""} style={{ display: "contents" }}>
            <section className="card dk" style={{ padding: "18px 22px" }} aria-label="Prices">
              <div className="px3">
                <div>
                  <div className="lbl" style={{ color: "var(--sage)" }}>Supra oracle</div>
                  <div className="pv num">{price8(mv.oracle.price)}</div>
                  <span className="xs" style={{ color: oracleStale ? "#ff8d95" : "var(--sage)" }}>{oracleStale ? "✕ " : ""}{age(oracleAge)} old</span>
                </div>
                <div>
                  <div className="lbl" style={{ color: "var(--sage)" }}>HSKSwap pool</div>
                  <div className="pv num">{price8(mv.pool.price)}</div>
                  <span className="xs" style={{ color: "var(--sage)" }}>{mv.pool.deviationBps > 0 ? "+" : mv.pool.deviationBps < 0 ? "−" : ""}{Math.abs(mv.pool.deviationBps)} bps vs oracle</span>
                </div>
                <div>
                  <div className="lbl" style={{ color: "var(--sage)" }}>HashKey Global</div>
                  <div className="pv num" style={{ color: "var(--y)" }}>{mv.cex ? price8(mv.cex.mid) : "—"}</div>
                  <span className="xs" style={{ color: "var(--sage)" }}>{mv.cex ? `mid · ${mv.cex.halfSpreadBps} bps half-spread` : "no quote"}</span>
                </div>
              </div>
            </section>
            <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
              <Card tight title="Gap vs cost" right={net === null ? <Badge>no CEX quote</Badge> : <Badge tone={net >= (minNet ?? 0) ? "ok" : net >= 0 ? "warn" : "mute"}>net {net >= 0 ? "+" : "−"}{Math.abs(net)} bps</Badge>}>
                {gap !== null ? <Gauge cost={costBps} gap={Math.max(0, gap)} under={minNet !== undefined ? `min net edge ${minNet}` : undefined} /> : <p className="sm fg2">HashKey Global has no quote right now.</p>}
              </Card>
              <Card tight title="Gap · 6 h" right={<span className="xs fg2">cost line {costBps} bps</span>} className="chart">
                <GapChart entries={hist.last?.entries ?? []} market={market} now={now} cost={costBps} live={gap} />
              </Card>
            </div>
            <Card title="Live candidates" right={<span className="xs fg2">computed by the daemon, decided by the AI</span>} style={{ padding: "14px 20px" }} headStyle={{ marginBottom: 4 }}>
              {cands.res && !cands.res.ok && !cands.last ? (
                <p className="sm bad">Candidates unavailable: {cands.res.error.message}</p>
              ) : mc.length === 0 ? (
                <p className="sm fg2" style={{ padding: "8px 0" }}>No candidate for {mkd.base}/USDT this cycle: the gap doesn't clear cost, or the market has nothing to exit.</p>
              ) : (
                <div style={paused ? { opacity: 0.45 } : undefined}>
                  <Table<Candidate>
                    compact
                    className="sm"
                    caption={`Live candidates for ${mkd.base}/USDT`}
                    rowKey={(c) => c.candidateId}
                    rows={mc}
                    cols={[
                      { key: "s", label: "Signal", className: "b5", render: (c) => `${c.generator}${c.leg ? " · " + c.leg : ""}` },
                      { key: "side", label: "Side", render: (c) => c.side },
                      { key: "size", label: "Size", align: "r", render: (c) => (c.side === "buy" ? `$${tokenAmt(c.maxAmountIn, 6)}` : tokenAmt(c.maxAmountIn, mkd.baseDecimals)) },
                      { key: "net", label: "Net edge", align: "r", className: "b7", render: (c) => <span className={c.netEdgeBps >= 0 ? "ok" : "bad"}>{c.netEdgeBps >= 0 ? "+" : "−"}{Math.abs(Math.round(c.netEdgeBps))} bps</span> },
                      { key: "exp", label: "Expires", align: "r", render: (c) => (c.generator === "discretionary_exit" ? "standing" : clockLeft(c.expiresAt - now)) },
                      { key: "st", label: "State", align: "r", render: (c) => <CandState c={c} sup={sup} paused={paused} entries={hist.last?.entries ?? []} /> },
                    ]}
                  />
                </div>
              )}
            </Card>
          </div>
          <ManualOrder key={market + (params[1] ?? "")} mv={mv} disabled={paused} initialOpen={params[1] === "order"} />
        </div>
      )}

      <Inspector>{mv ? <LimitsInspector mv={mv} /> : <Skeleton h={200} style={{ background: "rgba(183,198,194,.1)" }} />}</Inspector>
    </>
  );
}

const clockLeft = (s: number): string => (s <= 0 ? "expired" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);

function CandState({ c, sup, paused, entries }: { c: Candidate; sup: { side: Side; cause: string; bps: number }[]; paused: boolean; entries: JournalEntry[] }) {
  if (paused) return <Badge tone="bad" glyph="❚❚">vault paused</Badge>;
  const taken = entries.find((e) => e.candidateId === c.candidateId && (e.kind === "proposal" || e.kind === "execution"));
  if (taken) return <Badge tone={taken.verdict.ok ? "ok" : "bad"}>{taken.kind === "execution" ? "executed" : taken.verdict.ok ? "proposed" : "refused"}</Badge>;
  const s = sup.find((x) => x.side === c.side);
  if (s) return <Badge tone="warn">{s.cause === "entry_interval" ? "entry interval open" : s.cause === "deviation" ? `deviation ${s.bps} bps` : `oracle disagree ${s.bps} bps`}</Badge>;
  const skipped = entries.find((e) => e.candidateId === c.candidateId && e.kind === "no_trade");
  return skipped ? <Badge>{skipped.verdict.message === "llm_veto" ? "vetoed" : "not taken"}</Badge> : <Badge tone="info">open</Badge>;
}

/** Gap (bps, CEX mid vs pool) over the last 6 h from the prices journalled with every decision, plus the live point. */
function GapChart({ entries, market, now, cost, live }: { entries: JournalEntry[]; market: MarketId; now: number; cost: number; live: number | null }) {
  const pts = entries
    .filter((e) => marketOf(e) === market && e.context.cex && Number(e.context.cex.mid) > 0 && e.at >= now - 6 * 3600 && !clean(e.rationale).startsWith("[rogue]"))
    .map((e) => ({ t: e.at, g: ((Number(e.context.cex!.mid) - Number(e.context.pool.price)) / Number(e.context.pool.price)) * 10_000 }))
    .filter((p) => Math.abs(p.g) < 1500)
    .sort((a, b) => a.t - b.t);
  if (live !== null) pts.push({ t: now, g: live });
  if (pts.length < 2) return <p className="sm fg2" style={{ height: 64, display: "grid", placeItems: "center" }}>Builds up as the trader records decisions.</p>;
  const t0 = now - 6 * 3600;
  const vals = [...pts.map((p) => p.g), cost, 0];
  const lo = Math.min(...vals) - 5;
  const hi = Math.max(...vals) + 5;
  const x = (t: number) => ((t - t0) / (6 * 3600)) * 300;
  const y = (g: number) => 60 - ((g - lo) / (hi - lo)) * 56;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.g).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  return (
    <svg viewBox="0 0 300 64" height="64" width="100%" preserveAspectRatio="none" role="img" aria-label={`Gap over 6 hours: now ${Math.round(last.g)} bps, cost ${cost} bps, ${pts.length} readings`}>
      <path d={`M0 ${y(cost).toFixed(1)}H300`} stroke="#b3202d" strokeDasharray="4 4" strokeWidth="1" />
      <path d={d} fill="none" stroke="#171e19" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function LimitsInspector({ mv }: { mv: MarketView }) {
  const now = useNow();
  const L = mv.vault.limits;
  const r = vaultRisk(mv.vault);
  const cd = Math.max(0, mv.vault.lastTradeAt + L.cooldown - now);
  const label = MARKETS[mv.market].label;
  return (
    <>
      <div className="sec">
        <Eyebrow>Vault-{label} limits</Eyebrow>
        <KV k="Per trade">{usdE8Short(L.maxTradeUsdE8)}.00</KV>
        <KV k="Budget left today">{centsE8(r.capE8 - r.spentE8)} of {usdE8Short(L.maxEpochUsdE8)}</KV>
        <KV k="Exposure">{centsE8(r.exposureE8)} of {usdE8Short(L.maxExposureUsdE8)}</KV>
        <KV k="Slippage">{L.maxSlippageBps} bps</KV>
        <KV k="Oracle deviation">{L.maxOracleDeviationBps} bps · now {mv.pool.deviationBps > 0 ? "+" : mv.pool.deviationBps < 0 ? "−" : ""}{Math.abs(mv.pool.deviationBps)}</KV>
        <KV k="Exit discount">{L.maxExitDiscountBps} bps</KV>
        <KV k="Cooldown">{L.cooldown} s · {cd > 0 ? `${cd} s left` : "ready"}</KV>
        <KV k="Oracle max age">{Math.round(L.maxOracleAge / 3600)} h</KV>
      </div>
      <div className="sec">
        <Eyebrow>Worst case</Eyebrow>
        <div className="big num" style={{ color: "var(--y)" }}>{centsE8(r.maxE8)}</div>
        <div className="xs mt4" style={{ color: "var(--sage)" }}>per UTC day on this vault ({r.bps} bps of the {usdE8Short(L.maxEpochUsdE8)} budget)</div>
      </div>
      <div style={{ marginTop: "auto", paddingTop: 16 }}>
        <Link href={explorer.address(mv.vault.address)} className="sm">Vault-{label} on explorer</Link>
      </div>
    </>
  );
}

function MarketsLoading() {
  return (
    <div className="col" style={{ gap: 16 }} aria-busy="true">
      <div className="card dk" style={{ height: 130, padding: 20 }}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(3,1fr)", gap: 22 }}>
          {[0, 1, 2].map((i) => <div key={i}><Skeleton w="60%" h={10} style={{ background: "rgba(183,198,194,.12)" }} /><Skeleton h={40} style={{ marginTop: 14, background: "rgba(183,198,194,.12)" }} /></div>)}
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {[0, 1].map((i) => <div key={i} className="card" style={{ height: 120 }}><Skeleton w="40%" h={16} /><Skeleton h={12} style={{ marginTop: 40 }} /></div>)}
      </div>
      <div className="card" style={{ height: 150 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={12} style={{ margin: "14px 0" }} />)}</div>
      <div className="xs fg2 c">Reading Supra, the pool TWAP and HashKey Global…</div>
    </div>
  );
}

// ---------------------------------------------------------------- Advanced: manual order (propose → execute)

const QUOTE_FRESH_SEC = 15;
function toUnits(v: string, dp: number): string | null {
  if (!v || !/^\d*\.?\d*$/.test(v) || v === ".") return null;
  const [i = "0", f = ""] = v.split(".");
  return (BigInt(i || "0") * 10n ** BigInt(dp) + BigInt(f.slice(0, dp).padEnd(dp, "0") || "0")).toString();
}

function ManualOrder({ mv, disabled, initialOpen = false }: { mv: MarketView; disabled: boolean; initialOpen?: boolean }) {
  const { ate, toast, refresh } = useApp();
  const now = useNow();
  const market = mv.market;
  const mkd = MARKETS[market];
  const [open, setOpen] = useState(initialOpen);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (initialOpen) detailsRef.current?.scrollIntoView({ block: "nearest" });
  }, [initialOpen]);
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<{ code: string; message: string; hint?: string } | null>(null);
  const [proposal, setProposal] = useState<ProposeOutput | null>(null);
  const [phase, setPhase] = useState<"idle" | "quoting" | "proposing" | "approving" | "submitting" | "filled">("idle");
  const [fill, setFill] = useState<string | null>(null);
  const seq = useRef(0);
  const inDp = side === "buy" ? 6 : mkd.baseDecimals;
  const amountIn = useMemo(() => toUnits(amount, inDp), [amount, inDp]);

  useEffect(() => {
    setProposal(null);
    setFill(null);
    setErr(null);
    if (!amountIn || amountIn === "0") return setQuote(null);
    const my = ++seq.current;
    setPhase("quoting");
    const t = setTimeout(() => {
      void ate.quote.get({ market, side, amountIn }).then((r) => {
        if (my !== seq.current) return;
        setPhase("idle");
        if (r.ok) setQuote(r.data);
        else {
          setQuote(null);
          setErr(r.error);
        }
      });
    }, 300);
    return () => clearTimeout(t);
  }, [ate, market, side, amountIn]);

  const qAge = quote ? now - quote.at : null;
  const fresh = qAge !== null && qAge < QUOTE_FRESH_SEC;
  const blocked = quote && quote.policy.code !== "OK" ? quote.policy.code : null;
  const needsHuman = proposal?.status === "awaiting_human";
  const canExecute = !!proposal && !needsHuman && fresh && !blocked && phase === "idle" && !disabled;

  const propose = async () => {
    if (!quote) return;
    setPhase("proposing");
    const r = await ate.trade.propose({ market, side, amountIn: quote.amountIn, rationale: "Manual order from the desktop app (Markets → Advanced)" });
    setPhase("idle");
    if (r.ok) setProposal(r.data);
    else setErr(r.error);
  };
  const approve = async () => {
    if (!proposal) return;
    setPhase("approving");
    const r = await ate.trade.approve(proposal.proposalId, proposal.journalHash);
    setPhase("idle");
    if (r.ok) setProposal({ ...proposal, status: "approved", approvedBy: "human" });
    else setErr(r.error);
  };
  const execute = async () => {
    if (!proposal || !canExecute) return;
    setPhase("submitting");
    const r = await ate.trade.execute(proposal.proposalId);
    if (r.ok) {
      setPhase("filled");
      setFill(r.data.txHash);
      toast({ kind: "ok", text: `Manual ${side} on ${mkd.label} executed`, sub: `Vault-${mkd.label}`, href: explorer.tx(r.data.txHash), hrefLabel: r.data.txHash });
      refresh();
    } else {
      setPhase("idle");
      setErr(r.error);
    }
  };
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void execute();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <details ref={detailsRef} className="card soft tight" style={{ borderStyle: "dashed" }} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="row g10" style={{ cursor: "pointer", listStyle: "none" }}>
        <span className="b7">{open ? "▾" : "▸"} Advanced: manual order</span>
        <span className="xs fg2">checked by your vault like every trade · ⌘↵ to place</span>
        <span className="grow" />
        {disabled && <span className="xs fg2">off while paused</span>}
      </summary>
      {open && (
        <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 18, marginTop: 14 }}>
          <div className="col g10">
            <Seg<Side> label="Side" value={side} onChange={(v) => { setSide(v); setAmount(""); }} options={[{ id: "buy", label: `Buy ${mkd.base}` }, { id: "sell", label: `Sell ${mkd.base}` }]} />
            <label className="field">
              <span className="lbl">Amount in ({side === "buy" ? "USDT" : mkd.base})</span>
              <span className="inp">
                <input inputMode="decimal" placeholder={side === "buy" ? "25.00" : "0"} value={amount} disabled={disabled} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
                <span className="u">{side === "buy" ? "USDT" : mkd.base}</span>
              </span>
            </label>
            <div className="row g8">
              <Btn disabled={!quote || !!blocked || !!proposal || phase !== "idle" || disabled} onClick={() => void propose()}>{phase === "proposing" ? "Proposing…" : "Propose"}</Btn>
              {needsHuman && <Btn kind="solid" disabled={phase !== "idle" || !fresh} onClick={() => void approve()}>{phase === "approving" ? "Waiting for Touch ID…" : "Approve · Touch ID"}</Btn>}
              <Btn kind="pri" disabled={!canExecute} onClick={() => void execute()} title={canExecute ? "⌘↵" : "Needs a proposal, a quote younger than 15 s and check() = OK"}>{phase === "submitting" ? "Submitting…" : "Execute ⌘↵"}</Btn>
              <Btn kind="ghost" onClick={() => { setAmount(""); setProposal(null); }}>Clear</Btn>
            </div>
            {proposal && <p className="xs fg2">Proposal <span className="mono">{proposal.proposalId}</span> · {proposal.status}{proposal.approvedBy ? ` · ${proposal.approvedBy}` : ""}</p>}
            {fill && <p className="sm"><Badge tone="ok">filled</Badge> tx <TxLink hash={fill} /></p>}
          </div>
          <div>
            {phase === "quoting" && <p className="sm fg2">Simulating the swap and the vault check()…</p>}
            {err && <ErrorBox code={err.code} message={err.message} hint={err.hint} />}
            {quote && (
              <>
                <KV k="You pay" className="sm">{quote.amountInHuman}</KV>
                <KV k="You receive (simulated)" className="sm">{quote.amountOutHuman}</KV>
                <KV k="Min out (on-chain floor)" className="sm">{fmtUnits(quote.minOutFloor, side === "buy" ? mkd.baseDecimals : 6, 2)} {side === "buy" ? mkd.base : "USDT"}</KV>
                <KV k="Price impact" className="sm">{quote.impactBps} bps</KV>
                <KV k="Notional" className="sm">{money(Number(quote.policy.notionalUsdE8) / 1e8)}</KV>
                <KV k="Path" className="sm">{quote.exitPath ? "exit (floor min(oracle, TWAP))" : "normal"}</KV>
                <KV k="Vault check()" className="sm" vClass={blocked ? "bad b7" : "ok b7"}>{blocked ? `✕ ${blocked} · ${reasonName(quote.policy.reason)}` : "✓ OK"}</KV>
                <KV k="Quote age" className="sm" vClass={fresh ? "" : "warn"}>{qAge} s{fresh ? "" : " · re-quote"}</KV>
              </>
            )}
            {!quote && !err && phase !== "quoting" && <Empty title="Enter an amount">You see the price and your vault's safety check as you type.</Empty>}
          </div>
        </div>
      )}
    </details>
  );
}
