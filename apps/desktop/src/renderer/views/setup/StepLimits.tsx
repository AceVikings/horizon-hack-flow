// Setup 2 · Set limits (SIMPLIFY.md): three plain sliders and the most the agent can lose, in dollars, computed live
// with the SPEC §4.6 formula (worstCase, same as the daemon). Changes go on chain through Flow's managed owner
// service: lower limits at once, higher limits after Touch ID; read back before Continue.
import { useEffect, useMemo, useState } from "react";
import { worstCase } from "@ate/core";
import { Dialog, Btn } from "../../src/ui";
import { ErrLine, Section, Spinner, Wizard, go, isLoosening, useOwner, useSetup, useSetupGet } from "./common";
import { LimitsEditor, limError, type Lim } from "./LimitsEditor";

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

export default function StepLimits() {
  const s = useSetup();
  const st = useSetupGet<Status>("/setup/status");
  const lim = useSetupGet<Limits>("/setup/limits");
  const fund = useSetupGet<Fund>("/setup/fund");
  const chain = lim.data?.vaults.find((v) => v.limits)?.limits ?? null;
  const [l, setL] = useState<Lim | null>(null);
  const owner = useOwner();
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  useEffect(() => {
    if (chain && !l) setL(chain);
  }, [chain, l]);
  const n = lim.data?.vaults.length ?? 2;
  const wc = useMemo(() => (l ? worstCase(Array.from({ length: n }, () => l)) : null), [l, n]);
  const maxDay = wc ? Number(wc.maxLossUsdE8) / 1e8 : 0;
  const deposit = Number(fund.data?.totalUsd ?? 0) || st.data?.state.plannedDepositUsd || 280;
  const differs = !!l && !!chain && JSON.stringify(l) !== JSON.stringify(chain);
  const notSame = lim.data && !lim.data.same && n > 1;
  const next = async () => {
    await s.post("/setup/state", { step: 3, limitsAckAt: Math.floor(Date.now() / 1000), plannedDepositUsd: Math.round(deposit) });
    go("setup/3");
  };
  const loosen = !!l && !!chain && isLoosening(chain as unknown as Record<string, string | number>, l as unknown as Record<string, string | number>);
  /** Tightening applies at once; raising risk asks Touch ID (or an in-app confirm when Touch ID isn't set up). */
  const apply = async (confirmed = false) => {
    if (!owner || !l) return;
    setError(null);
    if (loosen && !confirmed) {
      const r = await s.confirmRisk(`raise the limits to $${d8(l.maxTradeUsdE8)} a trade and $${d8(l.maxEpochUsdE8)} a day`);
      if (!r.ok) return setError(r.error);
      if (r.data.method === "none") return setAsk(true);
    }
    setAsk(false);
    setBusy("Saving the new limits on chain…");
    const r = await owner.setLimits(l, { loosening: loosen });
    if (!r.ok) {
      setBusy(null);
      return setError(r.error);
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const x = await s.get<Limits>("/setup/limits");
      const c = x.ok ? x.data.vaults.find((v) => v.limits)?.limits : null;
      if (c && JSON.stringify(c) === JSON.stringify(l)) break;
    }
    setBusy(null);
    lim.reload();
  };
  return (
    <Wizard
      step={2}
      chainId={st.data?.chainId ?? 133}
      shot={differs ? "02b-limits-changed" : "02-limits"}
      hint={differs ? (loosen ? "Raising limits asks for Touch ID." : "Lower limits save at once.") : "These limits are already on your vaults."}
      next={() => void next()}
      nextDisabled={!l || differs || !!notSame}
    >
      <div className="stepno">Step 2 of 3</div>
      <h1>
        Set <span className="hl">limits</span>
      </h1>
      <p className="lead">The vault refuses any trade outside these limits. Even a stolen key can't go past them.</p>
      {!l ? (
        <div style={{ marginTop: 24 }}>{lim.res?.ok === false ? <ErrLine error={lim.res.error} /> : <Spinner label="Reading your vault limits…" />}</div>
      ) : (
        <>
          <Section title="Limits per vault" sub={`Pick a preset or set each one. Smaller numbers mean smaller worst days. That is ${((maxDay / deposit) * 100).toFixed(1)}% of $${deposit.toFixed(0)}.`}>
            <div style={{ marginTop: 14 }}>
              <LimitsEditor value={l} onChange={setL} base={chain ?? l} vaults={n} />
            </div>
            {differs ? (
              <div className="row g12" style={{ marginTop: 16 }}>
                {owner ? (
                  <Btn2 onClick={() => void apply()} disabled={!!busy || !!limError(l)}>{loosen ? "Save · raises risk" : "Save limits"}</Btn2>
                ) : (
                  <span className="sm fg2">These vaults are owned outside Flow: their owner must change the limits.</span>
                )}
                <button className="linkbtn sm" onClick={() => setL(chain)}>Undo changes</button>
              </div>
            ) : notSame ? (
              <p className="sm" style={{ marginTop: 14 }}>Your two vaults have different limits. Pick one set and save it to continue.</p>
            ) : (
              <p className="sm" style={{ marginTop: 14 }}>
                <span className="gl-ok" aria-hidden="true" style={{ display: "inline-grid", marginRight: 8 }}>✓</span>Matches what is on your vaults.
              </p>
            )}
          </Section>
        </>
      )}
      {busy && <div style={{ marginTop: 14 }}><Spinner label={busy} /></div>}
      <ErrLine error={error} />
      <Dialog
        open={ask}
        onClose={() => setAsk(false)}
        title="Raise the limits?"
        footer={
          <>
            <span className="grow" />
            <Btn kind="ghost" onClick={() => setAsk(false)}>Cancel</Btn>
            <Btn kind="danger" onClick={() => void apply(true)}>Raise limits</Btn>
          </>
        }
      >
        <p className="sm">The most the agent can lose in a day becomes ${maxDay.toFixed(2)}. Touch ID isn't set up on this Mac, so confirm here.</p>
      </Dialog>
    </Wizard>
  );
}

function Btn2({ onClick, children, disabled }: { onClick(): void; children: string; disabled?: boolean }) {
  return (
    <button type="button" className="btn pri lg" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
