// Tools & guides (⋯ menu, lane D4). Calculators for manual traders, one simple card each, plain labels:
// position size, risk/reward, price impact (live quote), fees + gas, worst case for chosen limits (SPEC §4.6, the
// shared `worstCase`), break-even after fees, P&L. Guides: short plain-language pages, each linking to a tool or chart.
// Routes: #/tools · #/tools/<calcId> · #/tools/guides · #/tools/guide/<id>.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MARKETS, POOL_FEE_BPS, worstCase, type MarketId, type Quote } from "@ate/core";
import { useApp } from "../src/app";
import { addPin } from "../src/charts";
import { PageHead, useNav } from "../src/shell";
import { Btn } from "../src/ui";
import type { ViewProps } from "./registry";

const HSK: MarketId = "hsk-dex:WHSK/USDT:3000";
const BTC: MarketId = "hsk-dex:WBTC/USDT:3000";
const FEE = POOL_FEE_BPS / 10_000;
const money = (n: number) => (Number.isFinite(n) ? `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");
const price = (n: number) => (Number.isFinite(n) && n > 0 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 2, minimumFractionDigits: n < 1 ? 4 : 2 })}` : "—");
const pct = (n: number, dp = 2) => (Number.isFinite(n) ? `${n.toFixed(dp)}%` : "—");

function Num({ label, value, onChange, suffix, prefix, step = "any" }: { label: string; value: number; onChange(v: number): void; suffix?: string; prefix?: string; step?: string }) {
  return (
    <label className="tnum">
      <span>{label}</span>
      <span className="tin">
        {prefix && <i>{prefix}</i>}
        <input type="number" inputMode="decimal" step={step} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} />
        {suffix && <i>{suffix}</i>}
      </span>
    </label>
  );
}
function Out({ label, children, main }: { label: string; children: ReactNode; main?: boolean }) {
  return (
    <div className={`tout${main ? " tmain" : ""}`}>
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}
function MarketPick({ value, onChange }: { value: MarketId; onChange(m: MarketId): void }) {
  return (
    <div className="tf" role="group" aria-label="Market">
      {[HSK, BTC].map((m) => (
        <button key={m} className={m === value ? "on" : ""} onClick={() => onChange(m)}>
          {MARKETS[m].label}
        </button>
      ))}
    </div>
  );
}
function Tool({ id, title, what, children, focus }: { id: string; title: string; what: string; children: ReactNode; focus: boolean }) {
  return (
    <section id={`tool-${id}`} className={`tcard${focus ? " focus" : ""}`} aria-label={title}>
      <h3>{title}</h3>
      <p className="twhat">{what}</p>
      {children}
    </section>
  );
}

/** Live pool price for a market (from the app's market poll), USD per token. */
function usePoolPrice(m: MarketId): number {
  const { mkOk } = useApp();
  const mv = mkOk?.find((x) => x.market === m);
  return mv ? Number(mv.pool.price) / 1e8 : NaN;
}

/** Price inputs start from the live HSK pool price (once it arrives), scaled by `k`; the user can then edit them. */
function useLiveSeed(k: number[], set: ((v: number) => void)[]): void {
  const p = usePoolPrice(HSK);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done || !(p > 0)) return;
    const dp = p < 1 ? 5 : 2;
    k.forEach((x, i) => set[i]!(Number((p * x).toFixed(dp))));
    setDone(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, done]);
}

function PositionSize({ focus }: { focus: boolean }) {
  const [capital, setCapital] = useState(250);
  const [risk, setRisk] = useState(1);
  const [entry, setEntry] = useState(0.0875);
  const [stop, setStop] = useState(0.085);
  useLiveSeed([1, 0.97], [setEntry, setStop]);
  const lossPerDollar = (entry - stop) / entry + 2 * FEE;
  const riskUsd = (capital * risk) / 100;
  const size = lossPerDollar > 0 ? riskUsd / lossPerDollar : NaN;
  return (
    <Tool id="size" focus={focus} title="Position size" what="How big a trade can be if you only want to lose a set part of your money at the stop.">
      <div className="tgrid">
        <Num label="Money you trade with" prefix="$" value={capital} onChange={setCapital} />
        <Num label="Most you want to lose" suffix="%" value={risk} onChange={setRisk} />
        <Num label="Buy price" prefix="$" value={entry} onChange={setEntry} />
        <Num label="Sell if it falls to" prefix="$" value={stop} onChange={setStop} />
      </div>
      <Out main label="Trade size">{stop >= entry ? "Set the stop below the buy price" : money(Math.min(size, capital))}</Out>
      <Out label="You lose at the stop (incl. fees)">{money(riskUsd)}</Out>
      {size > capital && <p className="twarn">This is more than your money. The size is capped at {money(capital)}.</p>}
    </Tool>
  );
}

function RiskReward({ focus }: { focus: boolean }) {
  const [entry, setEntry] = useState(0.0875);
  const [stop, setStop] = useState(0.085);
  const [target, setTarget] = useState(0.093);
  useLiveSeed([1, 0.97, 1.06], [setEntry, setStop, setTarget]);
  const down = (entry - stop) / entry + 2 * FEE;
  const up = (target - entry) / entry - 2 * FEE;
  const r = up / down;
  return (
    <Tool id="rr" focus={focus} title="Risk and reward" what="Compare what you can win with what you can lose, after the pool fee on both trades.">
      <div className="tgrid three">
        <Num label="Buy price" prefix="$" value={entry} onChange={setEntry} />
        <Num label="Stop price" prefix="$" value={stop} onChange={setStop} />
        <Num label="Target price" prefix="$" value={target} onChange={setTarget} />
      </div>
      <Out main label="Reward for each $1 of risk">{down > 0 && up > 0 ? `$${r.toFixed(2)}` : "—"}</Out>
      <Out label="Win at the target">{pct(up * 100)}</Out>
      <Out label="Loss at the stop">{pct(-down * 100)}</Out>
      <Out label="You must be right more than">{down > 0 && up > 0 ? pct((1 / (1 + r)) * 100, 0) : "—"}</Out>
    </Tool>
  );
}

function Impact({ focus }: { focus: boolean }) {
  const { ate } = useApp();
  const [m, setM] = useState<MarketId>(HSK);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [usd, setUsd] = useState(25);
  const [slip, setSlip] = useState(0.5);
  const p = usePoolPrice(m);
  const [q, setQ] = useState<{ quote: Quote | null; err: string | null; busy: boolean }>({ quote: null, err: null, busy: false });
  useEffect(() => {
    if (!(usd > 0)) return;
    const d = MARKETS[m].baseDecimals;
    const amountIn = side === "buy" ? BigInt(Math.round(usd * 1e6)).toString() : p > 0 ? (BigInt(Math.round((usd / p) * 1e8)) * 10n ** BigInt(d - 8)).toString() : null;
    if (!amountIn) return;
    setQ((x) => ({ ...x, busy: true }));
    const t = setTimeout(() => {
      void ate.quote.get({ market: m, side, amountIn }).then((r) => setQ({ quote: r.ok ? r.data : null, err: r.ok ? null : r.error.message, busy: false }));
    }, 300);
    return () => clearTimeout(t);
  }, [ate, m, side, usd, p]);
  const quote = q.quote;
  const outN = quote ? Number(quote.amountOut) / 10 ** (side === "buy" ? MARKETS[m].baseDecimals : 6) : NaN;
  const minOut = outN * (1 - slip / 100);
  return (
    <Tool id="impact" focus={focus} title="Price impact and slippage" what="What a trade gets right now from the pool, and the least it accepts with your slippage.">
      <div className="trow">
        <MarketPick value={m} onChange={setM} />
        <div className="tf" role="group" aria-label="Side">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} className={s === side ? "on" : ""} onClick={() => setSide(s)}>
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
      </div>
      <div className="tgrid">
        <Num label="Trade size" prefix="$" value={usd} onChange={setUsd} />
        <Num label="Slippage you accept" suffix="%" value={slip} onChange={setSlip} />
      </div>
      {q.err ? (
        <p className="twarn">No live quote: {q.err}</p>
      ) : (
        <>
          <Out main label="You get now">{quote ? `${outN.toLocaleString(undefined, { maximumFractionDigits: side === "buy" ? 6 : 2 })} ${side === "buy" ? MARKETS[m].label : "USDT"}` : q.busy ? "…" : "—"}</Out>
          <Out label="Worse than the pool price by">{quote ? pct(quote.impactBps / 100) : "—"}</Out>
          <Out label="Least you accept">{quote ? `${minOut.toLocaleString(undefined, { maximumFractionDigits: side === "buy" ? 6 : 2 })} ${side === "buy" ? MARKETS[m].label : "USDT"}` : "—"}</Out>
        </>
      )}
      <button className="lnk" onClick={() => addPin({ kind: "depth", market: m })}>
        Pin the cost-by-size chart
      </button>
    </Tool>
  );
}

function Fees({ focus }: { focus: boolean }) {
  const hsk = usePoolPrice(HSK);
  const { vsOk } = useApp();
  const testnet = vsOk?.status.chainId === 133;
  const [usd, setUsd] = useState(25);
  const [gasUnits, setGasUnits] = useState(250_000);
  const [gwei, setGwei] = useState(500);
  const [seeded, setSeeded] = useState(false);
  // testnet gas is about 1 gwei; on mainnet type the current gas price from the explorer
  useEffect(() => {
    if (seeded || !vsOk) return;
    if (testnet) setGwei(1);
    setSeeded(true);
  }, [vsOk, testnet, seeded]);
  const gasHsk = (gasUnits * gwei) / 1e9;
  // no live HSK price: gas is shown in HSK only, never at a made-up dollar price
  const gasUsd = hsk > 0 ? gasHsk * hsk : 0;
  const fee = usd * FEE;
  return (
    <Tool id="fees" focus={focus} title="Fees and gas" what="What one trade costs: the 0.30% pool fee plus network gas, paid in HSK.">
      <div className="tgrid three">
        <Num label="Trade size" prefix="$" value={usd} onChange={setUsd} />
        <Num label="Gas used" value={gasUnits} onChange={setGasUnits} step="1000" />
        <Num label="Gas price" suffix="gwei" value={gwei} onChange={setGwei} />
      </div>
      <Out main label="Total cost">{money(fee + gasUsd)}</Out>
      <Out label="Pool fee">{money(fee)}</Out>
      <Out label="Gas">{hsk > 0 ? `${money(gasUsd)} (${gasHsk.toFixed(4)} HSK)` : `${gasHsk.toFixed(4)} HSK (no live HSK price, not in the total)`}</Out>
      <Out label="Round trip (buy and sell)">{money(2 * (fee + gasUsd))}</Out>
    </Tool>
  );
}

function WorstCase({ focus }: { focus: boolean }) {
  const { mkOk } = useApp();
  const live = mkOk?.[0]?.vault.limits;
  const [cap, setCap] = useState(250);
  const [slip, setSlip] = useState(250);
  const [dev, setDev] = useState(250);
  const [exit, setExit] = useState(500);
  const [vaults, setVaults] = useState(2);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (live && !seeded) {
      setCap(Number(live.maxEpochUsdE8) / 1e8);
      setSlip(live.maxSlippageBps);
      setDev(live.maxOracleDeviationBps);
      setExit(live.maxExitDiscountBps);
      setVaults(Math.max(1, mkOk?.length ?? 2));
      setSeeded(true);
    }
  }, [live, seeded, mkOk]);
  const w = useMemo(() => {
    const one = { maxEpochUsdE8: BigInt(Math.round((Number.isFinite(cap) ? cap : 0) * 1e8)), maxSlippageBps: slip || 0, maxOracleDeviationBps: dev || 0, maxExitDiscountBps: exit || 0 };
    return worstCase(Array.from({ length: vaults }, () => one));
  }, [cap, slip, dev, exit, vaults]);
  const e8 = (b: bigint) => Number(b) / 1e8;
  return (
    <Tool id="worst" focus={focus} title="Most it can lose" what="The most the vaults can lose in one day with these limits, even if the agent goes wrong. Starts from your live limits.">
      <div className="tgrid">
        <Num label="Daily trading cap per vault" prefix="$" value={cap} onChange={setCap} />
        <Num label="Vaults" value={vaults} onChange={(v) => setVaults(Math.max(1, Math.min(2, Math.round(v || 1))))} step="1" />
        <Num label="Slippage limit" suffix="%" value={slip / 100} onChange={(v) => setSlip(Math.round(v * 100))} />
        <Num label="Oracle gap limit" suffix="%" value={dev / 100} onChange={(v) => setDev(Math.round(v * 100))} />
        <Num label="Emergency-sell discount" suffix="%" value={exit / 100} onChange={(v) => setExit(Math.round(v * 100))} />
      </div>
      <Out main label="Most it can lose in a day">{money(e8(w.maxLossUsdE8))}</Out>
      <Out label="On normal trades only">{money(e8(w.normalLossUsdE8))}</Out>
      <Out label="Over any 24 hours">{money(e8(w.rolling24hUsdE8))}</Out>
    </Tool>
  );
}

function BreakEven({ focus }: { focus: boolean }) {
  const [entry, setEntry] = useState(0.0875);
  const [usd, setUsd] = useState(25);
  const [gas, setGas] = useState(0.02);
  useLiveSeed([1], [setEntry]);
  const be = entry * ((1 + FEE) / (1 - FEE)) * (1 + (2 * gas) / usd);
  return (
    <Tool id="breakeven" focus={focus} title="Break-even price" what="The price you must sell at to get your money back after fees on both trades.">
      <div className="tgrid three">
        <Num label="Buy price" prefix="$" value={entry} onChange={setEntry} />
        <Num label="Trade size" prefix="$" value={usd} onChange={setUsd} />
        <Num label="Gas per trade" prefix="$" value={gas} onChange={setGas} />
      </div>
      <Out main label="Sell at least at">{price(be)}</Out>
      <Out label="That is a rise of">{pct((be / entry - 1) * 100)}</Out>
    </Tool>
  );
}

function PnlSim({ focus }: { focus: boolean }) {
  const [entry, setEntry] = useState(0.0875);
  const [exit, setExit] = useState(0.0905);
  useLiveSeed([1, 1.034], [setEntry, setExit]);
  const [usd, setUsd] = useState(25);
  const qty = (usd * (1 - FEE)) / entry;
  const back = qty * exit * (1 - FEE);
  const pnl = back - usd;
  return (
    <Tool id="pnl" focus={focus} title="Profit and loss" what="What you make or lose if you buy at one price and sell at another, after fees.">
      <div className="tgrid three">
        <Num label="Buy price" prefix="$" value={entry} onChange={setEntry} />
        <Num label="Sell price" prefix="$" value={exit} onChange={setExit} />
        <Num label="Trade size" prefix="$" value={usd} onChange={setUsd} />
      </div>
      <Out main label={pnl >= 0 ? "You make" : "You lose"}>{money(Math.abs(pnl))}</Out>
      <Out label="Return">{pct((pnl / usd) * 100)}</Out>
      <Out label="Fees paid">{money(usd * FEE + qty * exit * FEE)}</Out>
    </Tool>
  );
}

const CALCS = [
  { id: "size", name: "Position size", C: PositionSize },
  { id: "rr", name: "Risk and reward", C: RiskReward },
  { id: "impact", name: "Price impact", C: Impact },
  { id: "fees", name: "Fees and gas", C: Fees },
  { id: "worst", name: "Most it can lose", C: WorstCase },
  { id: "breakeven", name: "Break-even", C: BreakEven },
  { id: "pnl", name: "Profit and loss", C: PnlSim },
] as const;

// ---------------------------------------------------------------- guides (short, plain, one idea per sentence)

type Link = { label: string; tool?: string; chart?: Parameters<typeof addPin>[0]; to?: string };
const GUIDES: { id: string; title: string; sub: string; body: string[]; links: Link[] }[] = [
  {
    id: "spread",
    title: "The gap and the cost",
    sub: "When a price gap is worth a trade.",
    body: [
      "The pool price and the on-chain oracle price are not always the same. The difference is the gap.",
      "A trade closes part of the gap. But each trade has a cost: the 0.30% pool fee, the price impact and gas.",
      "Trade only when the gap is larger than the cost. If the gap is smaller, the trade loses money even when you are right.",
      "Watch the gap over time. A gap that stays open for hours can mean the oracle price is stale, not that the pool is cheap. The HashKey Global exchange price is extra context, not the reference.",
    ],
    links: [
      { label: "Pin the HSK gap chart", chart: { kind: "spread", market: HSK, interval: "1h", bars: 72 } },
      { label: "Open the fees tool", tool: "fees" },
    ],
  },
  {
    id: "slippage",
    title: "Slippage on thin pools",
    sub: "Why big trades get worse prices.",
    body: [
      "A pool has a limited amount of tokens. When you buy, the price goes up while your trade fills. This is price impact.",
      "Small pools move more. A $25 trade can move a thin pool more than a $2,500 trade moves a deep one.",
      "Slippage is the extra price change you accept between the quote and the fill. Set it low. The vault refuses fills worse than its limit.",
      "Check the cost for your trade size before you trade. If the cost is high, split the trade or wait.",
    ],
    links: [
      { label: "Open the price impact tool", tool: "impact" },
      { label: "Pin HSK cost by trade size", chart: { kind: "depth", market: HSK } },
    ],
  },
  {
    id: "oracles",
    title: "Oracles and stale prices",
    sub: "The price the vault trusts.",
    body: [
      "The vault does not trust the pool price. It checks each trade against an oracle price from Supra.",
      "A second oracle, APRO, is a cross-check. If the two disagree too much, the agent does not open new trades.",
      "Oracle prices update on a timer or when the price moves. An old price is stale. The vault refuses trades when the oracle is too old.",
      "If the pool and the oracle are far apart, buys stop. Sells can still use the emergency-sell path, at a limited discount.",
    ],
    links: [
      { label: "Pin the BTC oracle chart", chart: { kind: "oracle", market: BTC, interval: "1h", bars: 72 } },
      { label: "Ask the agent about the oracle", to: "ask" },
    ],
  },
  {
    id: "stops",
    title: "Stop-loss and take-profit",
    sub: "Decide your exit before you enter.",
    body: [
      "A stop-loss sells when the price falls to a level you choose. It limits the loss on one trade.",
      "A take-profit sells when the price rises to a level you choose. It keeps a gain before it goes away.",
      "Set both before you buy. Then size the trade so the loss at the stop is a small part of your money.",
      "A pause stops all trades, including stop-loss sells. To leave a market, go to cash instead.",
    ],
    links: [
      { label: "Open the position size tool", tool: "size" },
      { label: "Open the risk and reward tool", tool: "rr" },
    ],
  },
  {
    id: "limits",
    title: "The vault limits",
    sub: "What the vault never lets anyone do.",
    body: [
      "Your money stays in a vault on the chain. The agent can trade with it, but it cannot withdraw it.",
      "The vault has hard limits: the size of one trade, the total per day, the slippage and the most it can hold.",
      "Only you, the owner, can change the limits. The agent and the app cannot.",
      "From the limits we know the most the vaults can lose in one day, even if the agent goes wrong.",
    ],
    links: [
      { label: "Open the most-it-can-lose tool", tool: "worst" },
      { label: "Pin the BTC daily budget", chart: { kind: "budget", market: BTC, interval: "1h", bars: 48 } },
    ],
  },
  {
    id: "record",
    title: "Reading a decision record",
    sub: "Why the agent did what it did.",
    body: [
      "Each decision has a record: the prices at that time, the reason, the checks and the result.",
      "\"Gap\" and \"cost\" show if the trade had an edge. \"Checks\" show each vault limit that passed.",
      "Records link in a chain. If one record changes, the chain breaks, so the history cannot be changed later.",
      "An executed trade also has a transaction on the chain that you can open.",
    ],
    links: [{ label: "Open Activity", to: "activity" }, { label: "Pin HSK price with decisions", chart: { kind: "price", market: HSK, interval: "1h", bars: 72, markers: true } }],
  },
  {
    id: "modes",
    title: "Trading yourself or with the agent",
    sub: "Who decides, and what stays the same.",
    body: [
      "With the agent on, it decides and trades inside the limits.",
      "With suggest-only, the agent proposes and you approve each trade.",
      "When you trade yourself, the agent only informs. Ask it for charts and data. It does not trade for you.",
      "In every mode the vault checks every trade against the same limits.",
    ],
    links: [{ label: "Open Agent & strategy", to: "agent" }, { label: "Trade it myself", to: "trade" }],
  },
];

export default function Tools({ params }: ViewProps) {
  const go = useNav();
  const { toast } = useApp();
  const tab = params[0] === "guides" || params[0] === "guide" ? "guides" : "tools";
  const focus = tab === "tools" ? (params[0] ?? null) : null;
  useEffect(() => {
    if (focus) document.getElementById(`tool-${focus}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);
  const guide = params[0] === "guide" ? GUIDES.find((g) => g.id === params[1]) : undefined;
  const follow = (l: Link) => {
    if (l.tool) go(`tools/${l.tool}`);
    else if (l.to) go(l.to);
    else if (l.chart) {
      addPin(l.chart);
      toast({ kind: "ok", text: "Pinned to Charts" });
      go("charts");
    }
  };
  return (
    <div className="page1 tools-page">
      <PageHead
        title={guide ? guide.title : "Tools & guides"}
        sub={guide ? guide.sub : tab === "tools" ? "Work out a trade before you make it." : "Short guides in plain words."}
        crumb={guide ? <button className="lnk" onClick={() => go("tools/guides")}>← Guides</button> : undefined}
      />
      {!guide && (
        <div className="tf tabs" role="tablist">
          <button role="tab" aria-selected={tab === "tools"} className={tab === "tools" ? "on" : ""} onClick={() => go("tools")}>
            Calculators
          </button>
          <button role="tab" aria-selected={tab === "guides"} className={tab === "guides" ? "on" : ""} onClick={() => go("tools/guides")}>
            Guides
          </button>
        </div>
      )}
      {guide ? (
        <article className="guide">
          {guide.body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          <div className="glinks">
            {guide.links.map((l) => (
              <Btn key={l.label} onClick={() => follow(l)}>
                {l.label}
              </Btn>
            ))}
          </div>
        </article>
      ) : tab === "guides" ? (
        <div className="glist">
          {GUIDES.map((g) => (
            <button key={g.id} className="gitem" onClick={() => go(`tools/guide/${g.id}`)}>
              <b>{g.title}</b>
              <span>{g.sub}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="tlist">
          {CALCS.map(({ id, C }) => (
            <C key={id} focus={focus === id} />
          ))}
        </div>
      )}
    </div>
  );
}
