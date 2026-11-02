// Setup 2 · Set limits (SIMPLIFY.md): three plain sliders and the most the agent can lose, in dollars, computed live
// with the SPEC §4.6 formula (worstCase, same as the daemon). The vault enforces what is on chain, so a change is
// signed on the owner wallet (setLimits by QR) and read back before Continue.
import { useEffect, useMemo, useState } from "react";
import { worstCase } from "@ate/core";
import { ErrLine, Details, HandoffDialog, NumField, Section, Slider, Spinner, Wizard, go, useSetup, useSetupGet } from "./common";

interface Lim {
  maxTradeUsdE8: string;
  maxEpochUsdE8: string;
  maxExposureUsdE8: string;
  epochDuration: number;
  maxSlippageBps: number;
  maxOracleDeviationBps: number;
  maxExitDiscountBps: number;
  maxOracleAge: number;
  cooldown: number;
}
interface Limits {
  vaults: { market: string; address: string; limits: Lim | null }[];
  same: boolean;
}
interface Status {
  chainId: number;
  state: { plannedDepositUsd: number | null };
}
interface Fund {
  totalUsd: string;
}

const d8 = (e8: string) => Number(BigInt(e8)) / 1e8;
const e8 = (usd: number) => String(BigInt(Math.round(usd * 100)) * 1_000_000n);

export default function StepLimits() {
  const s = useSetup();
  const st = useSetupGet<Status>("/setup/status");
  const lim = useSetupGet<Limits>("/setup/limits");
  const fund = useSetupGet<Fund>("/setup/fund");
  const chain = lim.data?.vaults.find((v) => v.limits)?.limits ?? null;
  const [l, setL] = useState<Lim | null>(null);
  const [qr, setQr] = useState(false);
  useEffect(() => {
    if (chain && !l) setL(chain);
  }, [chain, l]);
  const n = lim.data?.vaults.length ?? 2;
  const wc = useMemo(() => (l ? worstCase(Array.from({ length: n }, () => l)) : null), [l, n]);
  const maxDay = wc ? Number(wc.maxLossUsdE8) / 1e8 : 0;
  const deposit = Number(fund.data?.totalUsd ?? 0) || st.data?.state.plannedDepositUsd || 280;
  const differs = !!l && !!chain && JSON.stringify(l) !== JSON.stringify(chain);
  const notSame = lim.data && !lim.data.same && n > 1;
  const set = (k: keyof Lim, v: number | string) => setL((x) => (x ? { ...x, [k]: v } : x));
  const next = async () => {
    await s.post("/setup/state", { step: 3, limitsAckAt: Math.floor(Date.now() / 1000), plannedDepositUsd: Math.round(deposit) });
    go("setup/3");
  };
  const pcBar = (bps: number) => (wc ? (bps / wc.vaults[0]!.totalBps) * 100 : 0);
  return (
    <Wizard
      step={2}
      chainId={st.data?.chainId ?? 133}
      shot={differs ? "02b-limits-changed" : "02-limits"}
      hint={differs ? "Your owner wallet must sign the new limits." : "These limits are already on your vaults."}
      next={() => void next()}
      nextDisabled={!l || differs || !!notSame}
    >
      <div className="eb">Step 2 of 3</div>
      <h1>
        Set <span className="hl">limits</span>
      </h1>
      <p className="lead">The vault refuses any trade outside these limits. Even a stolen key can't go past them.</p>
      {!l ? (
        <div style={{ marginTop: 24 }}>{lim.res?.ok === false ? <ErrLine error={lim.res.error} /> : <Spinner label="Reading your vault limits…" />}</div>
      ) : (
        <>
          <section className="card dk" style={{ marginTop: 24, padding: "26px 28px" }} aria-label="Most it can lose">
            <div className="lbl" style={{ color: "var(--sage)" }}>Most the agent can lose in a day</div>
            <div className="bignum" style={{ color: "var(--y)", marginTop: 10 }} aria-live="polite">${maxDay.toFixed(2)}</div>
            <div className="sm" style={{ color: "var(--sage)", marginTop: 8 }}>
              Across {n === 2 ? "both vaults" : "your vault"}, on every path. That is {((maxDay / deposit) * 100).toFixed(1)}% of ${deposit.toFixed(0)}.
            </div>
          </section>
          <Section title="Limits per vault" sub="Drag or type. Smaller numbers mean smaller worst days.">
            {(
              [
                ["Most per trade", "maxTradeUsdE8", 5, 1000, 5],
                ["Most per day", "maxEpochUsdE8", 10, 5000, 10],
                ["Most held at once", "maxExposureUsdE8", 10, 5000, 10],
              ] as const
            ).map(([label, k, min, max, step]) => {
              const v = d8(l[k]);
              const changed = chain && l[k] !== chain[k];
              return (
                <div key={k} className={`limrow${changed ? " chg" : ""}`}>
                  <span className="sm b5">{label}</span>
                  <Slider label={label} value={v} min={min} max={max} step={step} onChange={(x) => set(k, e8(x))} />
                  <NumField label={label} value={v} prefix="$" min={min} max={max} step={step} onChange={(x) => set(k, e8(x))} focus={!!changed} />
                </div>
              );
            })}
            <Details>
              {(
                [
                  ["Max slippage", "maxSlippageBps", 0, 1000, "bps"],
                  ["Max oracle deviation", "maxOracleDeviationBps", 0, 1000, "bps"],
                  ["Max exit discount", "maxExitDiscountBps", 0, 2000, "bps"],
                  ["Cooldown between trades", "cooldown", 0, 3600, "s"],
                ] as const
              ).map(([label, k, min, max, unit]) => (
                <div key={k} className={`limrow${chain && l[k] !== chain[k] ? " chg" : ""}`}>
                  <span className="sm b5">{label}</span>
                  <Slider label={label} value={l[k]} min={min} max={max} onChange={(x) => set(k, x)} />
                  <NumField label={label} value={l[k]} unit={unit} min={min} max={max} onChange={(x) => set(k, x)} />
                </div>
              ))}
              {wc && (
                <div style={{ marginTop: 14 }}>
                  <div className="wcbar" aria-hidden="true">
                    <div style={{ flex: pcBar(wc.vaults[0]!.oracleBps), background: "#ffe17c", borderRadius: "6px 0 0 6px" }} />
                    <div style={{ flex: pcBar(wc.vaults[0]!.exitBps), background: "#f0cf5c" }} />
                    <div style={{ flex: pcBar(wc.vaults[0]!.slippageBps), background: "#d8bb55" }} />
                    <div style={{ flex: pcBar(wc.vaults[0]!.feeBps), background: "#171e19", borderRadius: "0 6px 6px 0" }} />
                  </div>
                  <div className="row sb xs fg2" style={{ marginTop: 6 }}>
                    <span>oracle {wc.vaults[0]!.oracleBps}</span>
                    <span>exit {wc.vaults[0]!.exitBps}</span>
                    <span>slippage {wc.vaults[0]!.slippageBps}</span>
                    <span>fee {wc.vaults[0]!.feeBps}</span>
                  </div>
                  <div className="kv sm" style={{ marginTop: 8 }}><span className="k">Per vault</span><span className="v">${d8(l.maxEpochUsdE8).toFixed(0)} × {wc.vaults[0]!.totalBps} bps = ${(Number(wc.vaults[0]!.maxLossUsdE8) / 1e8).toFixed(2)}</span></div>
                  <div className="kv sm"><span className="k">Normal trades only</span><span className="v">${(Number(wc.normalLossUsdE8) / 1e8).toFixed(2)} a day</span></div>
                  <div className="kv sm"><span className="k">Any 24 hours</span><span className="v">${(Number(wc.rolling24hUsdE8) / 1e8).toFixed(2)}</span></div>
                  <div className="xs fg2" style={{ marginTop: 8 }}>Holds while the Supra price feed is live. Price moves on what the vault holds are the stop-loss's job.</div>
                </div>
              )}
            </Details>
            {differs ? (
              <div className="row g12" style={{ marginTop: 16 }}>
                <Btn2 onClick={() => setQr(true)}>Sign on owner wallet</Btn2>
                <button className="linkbtn sm" onClick={() => setL(chain)}>Undo changes</button>
              </div>
            ) : notSame ? (
              <p className="sm" style={{ marginTop: 14 }}>Your two vaults have different limits. Pick one set and sign it to continue.</p>
            ) : (
              <p className="sm" style={{ marginTop: 14 }}>
                <span className="gl-ok" aria-hidden="true" style={{ display: "inline-grid", marginRight: 8 }}>✓</span>Matches what is on your vaults.
              </p>
            )}
          </Section>
        </>
      )}
      <HandoffDialog
        open={qr}
        onClose={() => setQr(false)}
        title="Sign the new limits"
        intro="Scan each code with your owner wallet. Flow reads the limits back from the chain."
        body={qr && l ? { kind: "setLimits", limits: l } : null}
        onDone={() => lim.reload()}
      />
    </Wizard>
  );
}

function Btn2({ onClick, children }: { onClick(): void; children: string }) {
  return (
    <button type="button" className="btn pri lg" onClick={onClick}>
      {children}
    </button>
  );
}
