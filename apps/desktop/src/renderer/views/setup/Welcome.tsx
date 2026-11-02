// 00 Welcome (docs/design/flow 00-welcome): the promise, read from the defaults; "Set up Flow" or connect existing.
import { worstCase } from "@ate/core";
import {Btn} from "../../src/ui";
import { Logo, go, useSetup, useSetupGet } from "./common";

interface Status {
  state: { step: number; completedAt: number | null };
  chainId: number;
}
interface Limits {
  worstCase: { maxLossUsd: string };
  vaults: { limits: { maxExposureUsdE8: string } | null }[];
}

export default function Welcome() {
  const s = useSetup();
  const st = useSetupGet<Status>("/setup/status");
  const lim = useSetupGet<Limits>("/setup/limits");
  // Defaults (SPEC §19): $250/day budget at 1030 bps per vault; replaced by the live vaults once readable.
  const def = worstCase([{ maxEpochUsdE8: 250_00000000n, maxSlippageBps: 250, maxOracleDeviationBps: 250, maxExitDiscountBps: 500 }, { maxEpochUsdE8: 250_00000000n, maxSlippageBps: 250, maxOracleDeviationBps: 250, maxExitDiscountBps: 500 }]);
  const max = Number(lim.data?.worstCase.maxLossUsd ?? Number(def.maxLossUsdE8) / 1e8).toFixed(2);
  const exp = lim.data?.vaults[0]?.limits ? (Number(BigInt(lim.data.vaults[0].limits.maxExposureUsdE8)) / 1e8).toFixed(0) : "150";
  const pct = ((Number(max) / 280) * 100).toFixed(0);
  const resume = st.data && st.data.state.step > 0 && !st.data.state.completedAt ? st.data.state.step : 0;
  const start = async (existing: boolean) => {
    await s.post("/setup/state", { step: 1 });
    go("setup/1");
    void existing;
  };
  return (
    <div className="welcome" data-shot="00-welcome">
      <div className="wl">
        <Logo size={64} />
        <div style={{ marginTop: "auto" }} />
        <h1>
          Let an AI trade.
          <br />
          Know the
          <br />
          <span className="hl">worst case</span> first.
        </h1>
        <p className="lead">
          Flow runs an AI trader on HSKSwap around the clock. Your funds sit in a vault contract that checks every trade, so <b>a bad prompt or a stolen key can't cost more than the limit you set.</b>
        </p>
        <div className="row g18" style={{ marginTop: 34 }}>
          {resume ? (
            <Btn kind="pri" size="xl" className="hot" onClick={() => go(`setup/${resume}`)}>
              Resume setup · step {resume}
            </Btn>
          ) : (
            <Btn kind="pri" size="xl" className="hot" onClick={() => void start(false)}>
              Set up Flow
            </Btn>
          )}
          <Btn size="lg" className="ghostlight" onClick={() => void start(true)}>
            I already have vaults
          </Btn>
        </div>
        <div style={{ marginBottom: "auto" }} />
      </div>
      <div className="wr">
        <div className="stepno" style={{ color: "var(--sage)", marginBottom: 14 }}>With the default limits</div>
        <div className="pc">
          <div className="pn">01</div>
          <div>
            <div className="pt">The key can never withdraw</div>
            <div className="pd2">The agent key may trade inside your limits or pause. Only your owner device can move funds out of a vault.</div>
          </div>
        </div>
        <div className="pc">
          <div className="pn">02</div>
          <div>
            <div className="pt">≤ ${max} a day</div>
            <div className="pd2">Worst-case execution loss across both vaults, on every path, while the Supra price feed is live. About {pct}% of a $280 test wallet.</div>
          </div>
        </div>
        <div className="pc">
          <div className="pn">03</div>
          <div>
            <div className="pt">≤ ${exp} per vault</div>
            <div className="pd2">Exposure cap checked on-chain at every buy. Price risk on what is held is managed by the stop-loss, not the contract.</div>
          </div>
        </div>
        <div className="card d2" style={{ marginTop: 26, background: "#1f2622", borderColor: "rgba(183,198,194,.14)", padding: "18px 20px" }}>
          <div className="lbl" style={{ color: "var(--sage)" }}>Every trade, every time</div>
          <div className="row g8" style={{ marginTop: 14, alignItems: "stretch" }}>
            <div className="grow" style={{ border: "1px solid rgba(183,198,194,.2)", borderRadius: 10, padding: "10px 12px" }}>
              <div className="h4">AI agent</div>
              <div className="xs mt4" style={{ color: "var(--sage)" }}>decides and signs</div>
            </div>
            <div style={{ alignSelf: "center", color: "var(--y)", fontSize: 18 }} aria-hidden="true">→</div>
            <div className="grow" style={{ border: "1.5px solid var(--y)", borderRadius: 10, padding: "10px 12px" }}>
              <div className="h4" style={{ color: "var(--y)" }}>Vault</div>
              <div className="xs mt4" style={{ color: "var(--sage)" }}>checks 13 rules</div>
            </div>
            <div style={{ alignSelf: "center", color: "var(--y)", fontSize: 18 }} aria-hidden="true">→</div>
            <div className="grow" style={{ border: "1px solid rgba(183,198,194,.2)", borderRadius: 10, padding: "10px 12px" }}>
              <div className="h4">HSKSwap</div>
              <div className="xs mt4" style={{ color: "var(--sage)" }}>fills or reverts</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
