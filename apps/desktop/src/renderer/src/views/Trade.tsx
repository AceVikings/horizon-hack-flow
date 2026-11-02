import { useEffect, useMemo, useRef, useState } from "react";
import { MARKET_IDS, MARKETS, SUPRA_PAIRS, reasonName, type MarketId, type MarketView, type ProposeOutput, type Quote, type Side } from "@ate/core";
import { useApp, useNow, useRemote } from "../app";
import { ContextPanel, Inspector } from "../shell";
import { Badge, Card, Empty, ErrorBox, KV, Link, TxLink, type Tone } from "../ui";
import { bps, ago, fmtUnits, px8, usdE8 } from "../format";

const QUOTE_FRESH_SEC = 15;
const HINTS: Record<string, string> = {
  ATE_POLICY_TRADE_CAP: "Lower the amount below the per-trade cap shown in the checklist.",
  ATE_POLICY_EPOCH_CAP: "The epoch budget is spent. Wait for the epoch reset or trade smaller.",
  ATE_ORACLE_DEVIATION: "Pool spot is too far from the Supra oracle. Wait for the pool to converge; do not force it.",
  ATE_ORACLE_STALE: "The Supra oracle is older than maxOracleAge. Entries wait; exits use the min(oracle, TWAP) floor.",
  ATE_POLICY_COOLDOWN: "Cooldown between trades has not elapsed.",
  ATE_POLICY_PAUSED: "Vault is paused. Unpause is owner-only: run `ate-owner unpause --all` on the owner's device.",
  ATE_POLICY_ZERO_AMOUNT: "Enter an amount greater than zero.",
  ATE_INSUFFICIENT_BALANCE: "The vault does not hold enough of the input token.",
  ATE_POLICY_EXPOSURE: "This buy would exceed the vault's max exposure. Sell first or reduce size.",
  ATE_SLIPPAGE: "Expected output is below the on-chain slippage floor. Reduce size.",
};

type Phase = "empty" | "loading" | "quoted" | "blocked" | "proposing" | "proposed" | "submitting" | "filled" | "error";

export default function Trade() {
  const { ate, toast, refresh } = useApp();
  const now = useNow();
  const [market, setMarket] = useState<MarketId>(MARKET_IDS[0]);
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [qErr, setQErr] = useState<{ code: string; message: string; hint?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [proposal, setProposal] = useState<ProposeOutput | null>(null);
  const [phase, setPhase] = useState<"idle" | "proposing" | "submitting" | "filled" | "error">("idle");
  const [fill, setFill] = useState<{ txHash: string; amountOut: string } | null>(null);
  const seqRef = useRef(0);
  const m = MARKETS[market];

  const { res: mres } = useRemote(() => ate.markets.get(market), [market], { every: 10000 });
  const mv = mres?.ok ? mres.data : null;

  const baseDp = m.baseDecimals;
  const inDp = side === "buy" ? 6 : baseDp;
  const amountIn = useMemo(() => toUnits(amount, inDp), [amount, inDp]);

  // Quote on input change (debounced). New input invalidates the proposal.
  useEffect(() => {
    setProposal(null);
    setFill(null);
    setPhase("idle");
    if (!amountIn || amountIn === "0") { setQuote(null); setQErr(null); return; }
    const my = ++seqRef.current;
    setLoading(true);
    const t = setTimeout(() => {
      void ate.quote.get({ market, side, amountIn }).then((r) => {
        if (my !== seqRef.current) return;
        setLoading(false);
        if (r.ok) { setQuote(r.data); setQErr(null); } else { setQuote(null); setQErr({ code: r.error.code, message: r.error.message, ...(r.error.hint ? { hint: r.error.hint } : {}) }); }
      });
    }, 300);
    return () => clearTimeout(t);
  }, [ate, market, side, amountIn]);

  const age = quote ? now - quote.at : null;
  const fresh = age !== null && age < QUOTE_FRESH_SEC;
  const blockedCode = quote && quote.policy.code !== "OK" ? quote.policy.code : null;
  const phaseV: Phase = !amountIn || amountIn === "0" ? "empty" : phase === "proposing" ? "proposing" : phase === "submitting" ? "submitting" : phase === "filled" ? "filled" : phase === "error" ? "error" : loading ? "loading" : blockedCode ? "blocked" : quote ? (proposal ? "proposed" : "quoted") : qErr ? "error" : "loading";
  const needsHuman = proposal?.status === "awaiting_human";
  const canExecute = !!proposal && !needsHuman && fresh && !blockedCode && phase === "idle";
  const [approving, setApproving] = useState(false);

  /** confirm mode: Touch ID over the daemon-issued trade payload (main does /trade/approve both steps). */
  async function doApprove() {
    if (!proposal) return;
    setApproving(true);
    const r = await ate.trade.approve(proposal.proposalId, proposal.journalHash);
    setApproving(false);
    if (r.ok) { setProposal({ ...proposal, status: "approved", approvedBy: "human" }); toast({ kind: "ok", text: "Trade approved (Touch ID). Execute when ready." }); }
    else { setQErr({ code: r.error.code, message: r.error.message, ...(r.error.hint ? { hint: r.error.hint } : {}) }); toast({ kind: "error", text: `${r.error.code}: ${r.error.message}` }); }
  }

  async function doPropose() {
    if (!quote) return;
    setPhase("proposing");
    // No origin: a ui-scope proposal is origin=human (approved in autonomous mode, awaiting_human in confirm mode).
    const r = await ate.trade.propose({ market, side, amountIn: quote.amountIn, rationale: "Manual trade from desktop UI" });
    if (r.ok) { setProposal(r.data); setPhase("idle"); } else { setPhase("error"); setQErr({ code: r.error.code, message: r.error.message, ...(r.error.hint ? { hint: r.error.hint } : {}) }); }
  }
  async function doExecute() {
    if (!proposal || !canExecute) return;
    setPhase("submitting");
    const r = await ate.trade.execute(proposal.proposalId);
    if (r.ok) { setFill({ txHash: r.data.txHash, amountOut: r.data.amountOut }); setPhase("filled"); toast({ kind: "ok", text: "Trade submitted", href: `https://hsk.blockscout.com/tx/${r.data.txHash}` }); refresh(); }
    else { setPhase("error"); setQErr({ code: r.error.code, message: r.error.message, ...(r.error.hint ? { hint: r.error.hint } : {}) }); toast({ kind: "error", text: `${r.error.code}: ${r.error.message}` }); }
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void doExecute(); }
      if (e.key === "Escape") { setProposal(null); setAmount(""); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const checks = useMemo(() => buildChecklist(mv, quote, side), [mv, quote, side]);

  return (
    <>
      <ContextPanel>
        <h2>Market</h2>
        <div className="mlist" role="radiogroup" aria-label="Market">
          {MARKET_IDS.map((id) => (
            <button key={id} role="radio" aria-checked={market === id} className={`mbtn ${market === id ? "on" : ""}`} onClick={() => { setMarket(id); setAmount(""); }}>
              <b>{MARKETS[id].base}/USDT</b><span className="muted small">0.30% pool · {MARKETS[id].cexSymbol}</span>
            </button>
          ))}
        </div>
        <h2>Quote state</h2>
        <StateLine phase={phaseV} />
        <p className="muted small">Execute needs a quote younger than {QUOTE_FRESH_SEC} s and a passing vault check(). Keyboard: ⌘Enter execute, Esc cancel.</p>
      </ContextPanel>

      <MarketHeader mv={mv} market={market} />

      <div className="cols2">
        <Card title="Order">
          <div className="seg" role="radiogroup" aria-label="Side">
            {(["buy", "sell"] as const).map((s) => (
              <button key={s} role="radio" aria-checked={side === s} className={side === s ? "on" : ""} onClick={() => { setSide(s); setAmount(""); }}>{s === "buy" ? "Buy" : "Sell"} {s === "buy" ? m.base : m.base}</button>
            ))}
          </div>
          <label className="field">
            <span>Amount in ({side === "buy" ? "USDT" : m.base})</span>
            <input className="num" inputMode="decimal" placeholder={side === "buy" ? "25" : "0"} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Amount in" />
          </label>
          {side === "buy" && <div className="chips">{["5", "10", "25"].map((v) => <button key={v} className="chip" onClick={() => setAmount(v)}>${v}</button>)}</div>}

          {phaseV === "empty" && <Empty title="Enter an amount">A simulated quote and the vault check() run as you type.</Empty>}
          {phaseV === "loading" && <div className="muted">Simulating quote…</div>}
          {quote && phaseV !== "empty" && (
            <div className="quote">
              <KV k="You pay">{quote.amountInHuman}</KV>
              <KV k="You receive (simulated)">{quote.amountOutHuman}</KV>
              <KV k="Price impact">{quote.impactBps} bps</KV>
              <KV k="minOutFloor (on-chain)">{fmtUnits(quote.minOutFloor, side === "buy" ? baseDp : 6, 2)}</KV>
              <KV k="Notional">{usdE8(quote.policy.notionalUsdE8)}</KV>
              <KV k="Path">{quote.exitPath ? "exit path (floor min(oracle, TWAP))" : "normal"}</KV>
              <KV k="Quote age"><span className={fresh ? "" : "stale"}>{age} s {fresh ? "" : "(stale: re-quote)"}</span></KV>
            </div>
          )}
          {qErr && <ErrorBox {...qErr} />}
          {phaseV === "blocked" && blockedCode && (
            <div className="blocked" role="alert">
              <Badge tone="bad">{blockedCode}</Badge> <b>{reasonName(quote!.policy.reason)}</b>
              <div>{HINTS[blockedCode] ?? "The vault check() rejected this order."}</div>
            </div>
          )}
          <div className="actions">
            <button className="btn" disabled={!quote || !!blockedCode || phase !== "idle" || !!proposal} onClick={doPropose}>{phase === "proposing" ? "Proposing…" : "Propose"}</button>
            {needsHuman && <button className="btn primary" disabled={approving || !fresh} onClick={doApprove} title="confirm mode: approve this trade with Touch ID">{approving ? "Waiting for Touch ID…" : "Approve (Touch ID)"}</button>}
            <button className="btn primary" disabled={!canExecute} onClick={doExecute} title={canExecute ? "⌘Enter" : "Needs a proposal, a fresh quote and check() = OK"}>{phase === "submitting" ? "Submitting…" : "Execute  ⌘↵"}</button>
            <button className="btn ghost" onClick={() => { setProposal(null); setAmount(""); }}>Cancel  Esc</button>
          </div>
          {proposal && <p className="small muted">Proposal <span className="mono">{proposal.proposalId}</span> · {proposal.status === "awaiting_human" ? <Badge tone="warn">awaiting your approval (confirm mode)</Badge> : <Badge tone="ok">{proposal.status}{proposal.approvedBy ? ` · ${proposal.approvedBy}` : ""}</Badge>} · valid until {new Date(proposal.expiresAt * 1000).toLocaleTimeString()} · reserved turnover ${proposal.reservedTurnoverUsd}</p>}
          {phase === "filled" && fill && (
            <div className="filled" role="status"><Badge tone="ok">filled</Badge> tx <TxLink hash={fill.txHash} /> · amountOut {fill.amountOut}</div>
          )}
        </Card>

        <Card title="Policy checklist" right={<span className="muted small">live</span>}>
          {checks.length === 0 ? <Empty title="No quote yet">Checks tick as soon as a quote exists.</Empty> : (
            <ul className="checks">
              {checks.map((c) => (
                <li key={c.name}>
                  <Badge tone={c.tone}>{c.tone === "ok" ? "pass" : c.tone === "bad" ? "fail" : c.tone === "warn" ? "watch" : "n/a"}</Badge>
                  <span className="cn">{c.name}</span>
                  <span className="num cv">{c.value}</span>
                </li>
              ))}
            </ul>
          )}
          {quote && <p className="small">Vault verdict: <Badge tone={blockedCode ? "bad" : "ok"}>{quote.policy.code === "OK" ? "OK" : `${quote.policy.code} (${reasonName(quote.policy.reason)})`}</Badge></p>}
        </Card>
      </div>

      <Inspector>
        <h2>Vault limits</h2>
        {mv ? <Limits mv={mv} /> : <span className="muted">—</span>}
      </Inspector>
    </>
  );
}

function StateLine({ phase }: { phase: Phase }) {
  const map: Record<Phase, [Tone, string]> = {
    empty: ["mute", "empty"], loading: ["info", "loading"], quoted: ["ok", "quoted"], blocked: ["bad", "blocked"],
    proposing: ["info", "submitting"], proposed: ["ok", "proposed"], submitting: ["info", "submitting"], filled: ["ok", "filled"], error: ["bad", "error"],
  };
  return <Badge tone={map[phase][0]}>{map[phase][1]}</Badge>;
}

function toUnits(v: string, dp: number): string | null {
  if (!v || !/^\d*\.?\d*$/.test(v) || v === ".") return null;
  const [i = "0", f = ""] = v.split(".");
  const frac = f.slice(0, dp).padEnd(dp, "0");
  return (BigInt(i || "0") * 10n ** BigInt(dp) + BigInt(frac || "0")).toString();
}

function MarketHeader({ mv, market }: { mv: MarketView | null; market: MarketId }) {
  const m = MARKETS[market];
  if (!mv) return <div className="mhead ate-dark"><span className="muted">Loading {m.base}/USDT…</span></div>;
  const cexGap = mv.cex ? Math.round(((Number(mv.cex.mid) - Number(mv.pool.price)) / Number(mv.cex.mid)) * 10000) : null;
  const o = mv.oracle;
  return (
    <div className="mhead ate-dark">
      <div className="mtitle"><h2>{m.base}/USDT</h2><span className="muted">{m.cexSymbol}</span></div>
      <div className="mstats">
        <div><span className="k">Supra oracle (pair {SUPRA_PAIRS[market]})</span><span className="big num">${px8(o.price)}</span><Badge tone={o.health === "fresh" ? "ok" : o.health === "aging" ? "warn" : "bad"}>{o.health} · {o.ageSec} s old</Badge></div>
        <div><span className="k">Pool spot</span><span className="big num">${px8(mv.pool.price)}</span><span className="muted num">TWAP ${px8(mv.pool.twap)}</span></div>
        <div><span className="k">CEX mid</span><span className="big num">{mv.cex ? "$" + px8(mv.cex.mid) : "—"}</span><span className="muted num">half-spread {mv.cex?.halfSpreadBps ?? "—"} bps</span></div>
        <div className="badges">
          <Badge tone={Math.abs(mv.pool.deviationBps) > 150 ? "warn" : "ok"}>oracle deviation {bps(mv.pool.deviationBps)}</Badge>
          <Badge tone={mv.supra?.active ? (Math.abs(mv.supra.disagreeBps ?? 0) > 50 ? "warn" : "ok") : "mute"} title="APRO cross-check: Supra vs APRO">APRO cross-check {mv.supra?.active ? bps(mv.supra.disagreeBps) : "inactive"}</Badge>
          <Badge tone={cexGap !== null && cexGap > 60 ? "info" : "mute"}>CEX gap {cexGap === null ? "—" : bps(cexGap)}</Badge>
          {mv.readOnly && <Badge tone="bad">read-only</Badge>}
          {mv.vault.paused && <Badge tone="bad">vault paused</Badge>}
        </div>
      </div>
    </div>
  );
}

function buildChecklist(mv: MarketView | null, q: Quote | null, side: Side): { name: string; value: string; tone: Tone }[] {
  if (!mv || !q) return [];
  const L = mv.vault.limits;
  const notional = BigInt(q.policy.notionalUsdE8);
  const spent = BigInt(mv.vault.epoch.spentUsdE8);
  const exposure = BigInt(mv.vault.exposureUsdE8);
  const dev = Math.abs(mv.pool.deviationBps);
  const code = q.policy.code;
  const cd = Math.max(0, mv.vault.lastTradeAt + L.cooldown - q.at);
  return [
    { name: "Vault not paused", value: mv.vault.paused ? "paused" : "active", tone: mv.vault.paused ? "bad" : "ok" },
    { name: "Oracle valid and fresh", value: `${mv.oracle.ageSec} s of ${L.maxOracleAge} s`, tone: mv.oracle.ageSec > L.maxOracleAge ? "bad" : mv.oracle.health === "fresh" ? "ok" : "warn" },
    { name: "Spot vs oracle deviation", value: `${dev} of ${L.maxOracleDeviationBps} bps`, tone: side === "sell" ? "mute" : dev > L.maxOracleDeviationBps ? "bad" : "ok" },
    { name: "Per-trade cap", value: `${usdE8(q.policy.notionalUsdE8)} of ${usdE8(L.maxTradeUsdE8)}`, tone: notional > BigInt(L.maxTradeUsdE8) ? "bad" : "ok" },
    { name: "Epoch budget", value: `${usdE8((spent + notional).toString())} of ${usdE8(L.maxEpochUsdE8)}`, tone: spent + notional > BigInt(L.maxEpochUsdE8) ? "bad" : "ok" },
    { name: "Cooldown", value: cd > 0 ? `${cd} s left` : `elapsed (${L.cooldown} s)`, tone: cd > 0 ? "bad" : "ok" },
    { name: "Slippage floor", value: `impact ${q.impactBps} bps of ${L.maxSlippageBps} bps`, tone: q.impactBps > L.maxSlippageBps ? "bad" : "ok" },
    { name: "Exposure (buys)", value: `${usdE8(exposure.toString())} of ${usdE8(L.maxExposureUsdE8)}`, tone: side === "sell" ? "mute" : exposure + notional > BigInt(L.maxExposureUsdE8) ? "bad" : "ok" },
    { name: "check() on vault", value: code === "OK" ? "OK" : code, tone: code === "OK" ? "ok" : "bad" },
  ];
}

function Limits({ mv }: { mv: MarketView }) {
  const L = mv.vault.limits;
  return (
    <>
      <KV k="maxTradeUsd">{usdE8(L.maxTradeUsdE8)}</KV>
      <KV k="maxEpochUsd">{usdE8(L.maxEpochUsdE8)}</KV>
      <KV k="maxExposureUsd">{usdE8(L.maxExposureUsdE8)}</KV>
      <KV k="epochDuration">{L.epochDuration} s</KV>
      <KV k="maxSlippage">{L.maxSlippageBps} bps</KV>
      <KV k="maxOracleDeviation">{L.maxOracleDeviationBps} bps</KV>
      <KV k="maxExitDiscount">{L.maxExitDiscountBps} bps</KV>
      <KV k="maxOracleAge">{L.maxOracleAge} s</KV>
      <KV k="cooldown">{L.cooldown} s</KV>
      <KV k="last trade">{ago(mv.vault.lastTradeAt)}</KV>
      <h2>Roles</h2>
      <div className="small muted">agent</div><div className="mono wrap small">{mv.vault.agent}</div>
      <div className="small muted">guardian</div><div className="mono wrap small">{mv.vault.guardian}</div>
      <div className="small muted">owner</div><div className="mono wrap small">{mv.vault.owner}</div>
      <p><Link href={`https://hsk.blockscout.com/address/${mv.vault.address}`}>Vault on Blockscout</Link></p>
    </>
  );
}
