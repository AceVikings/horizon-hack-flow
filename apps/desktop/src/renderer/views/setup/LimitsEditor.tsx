// The one limits editor (setup's Set limits, Wallet → Create a new vault, Wallet → Change limits): presets, the six
// limits a user chooses, and the most the agent can lose in a day, recomputed live with the SPEC §4.6 formula
// (worstCase, the same as the daemon). Values use the daemon's /setup/limits shape (USD caps × 1e8 as strings).
import { useMemo } from "react";
import { worstCase } from "@ate/core";
import { Details, NumField, Slider } from "./common";

export interface Lim {
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

const usd = (n: number) => String(BigInt(Math.round(n * 100)) * 1_000_000n);
export const d8 = (e8: string) => Number(BigInt(e8)) / 1e8;

/** The §19 defaults (owner service DEFAULT_LIMITS). */
export const DEFAULT_LIM: Lim = { maxTradeUsdE8: usd(100), maxEpochUsdE8: usd(250), maxExposureUsdE8: usd(150), epochDuration: 86_400, maxSlippageBps: 250, maxOracleDeviationBps: 250, maxExitDiscountBps: 500, maxOracleAge: 90_000, cooldown: 60 };
export const PRESETS: { id: string; label: string; sub: string; l: Lim }[] = [
  { id: "careful", label: "Careful", sub: "$25 a trade, $100 a day", l: { ...DEFAULT_LIM, maxTradeUsdE8: usd(25), maxEpochUsdE8: usd(100), maxExposureUsdE8: usd(50), maxSlippageBps: 100, maxOracleDeviationBps: 150, maxExitDiscountBps: 300, cooldown: 300 } },
  { id: "default", label: "Default", sub: "$100 a trade, $250 a day", l: DEFAULT_LIM },
  { id: "active", label: "Active", sub: "$200 a trade, $1,000 a day", l: { ...DEFAULT_LIM, maxTradeUsdE8: usd(200), maxEpochUsdE8: usd(1000), maxExposureUsdE8: usd(500), maxSlippageBps: 400, maxOracleDeviationBps: 400, maxExitDiscountBps: 800, cooldown: 30 } },
];

const KEYS = Object.keys(DEFAULT_LIM) as (keyof Lim)[];
export const sameLim = (a: Lim, b: Lim) => KEYS.every((k) => String(a[k]) === String(b[k]));
/** Owner service shape (maxTradeUsd …) ↔ this shape (maxTradeUsdE8 …). */
export function limFromOwner(o: Record<string, string | number>): Lim {
  const n = (k: string) => Number(o[k]);
  return { maxTradeUsdE8: String(o.maxTradeUsd ?? o.maxTradeUsdE8), maxEpochUsdE8: String(o.maxEpochUsd ?? o.maxEpochUsdE8), maxExposureUsdE8: String(o.maxExposureUsd ?? o.maxExposureUsdE8), epochDuration: n("epochDuration"), maxSlippageBps: n("maxSlippageBps"), maxOracleDeviationBps: n("maxOracleDeviationBps"), maxExitDiscountBps: n("maxExitDiscountBps"), maxOracleAge: n("maxOracleAge"), cooldown: n("cooldown") };
}
/** Fields where `l` takes more risk than `base`: caps and tolerances up, a shorter day or cooldown. */
export function riskier(base: Lim, l: Lim): (keyof Lim)[] {
  return KEYS.filter((k) => (k === "epochDuration" || k === "cooldown" ? Number(l[k]) < Number(base[k]) : BigInt(String(l[k])) > BigInt(String(base[k]))));
}
/** PolicyVault.setLimits bounds, in plain words (null when the vault will accept them). */
export function limError(l: Lim): string | null {
  if (BigInt(l.maxEpochUsdE8) < BigInt(l.maxTradeUsdE8)) return "The daily budget must be at least the most per trade.";
  if (l.maxSlippageBps > 1000 || l.maxOracleDeviationBps > 1000) return "Slippage and price gap can be at most 1,000 bps (10%).";
  if (l.maxExitDiscountBps < l.maxOracleDeviationBps) return "The stop-loss allowance must be at least the price gap.";
  if (l.maxExitDiscountBps > 2000) return "The stop-loss allowance can be at most 2,000 bps.";
  return null;
}
export function worstDayUsd(l: Lim, n = 1): number {
  return Number(worstCase(Array.from({ length: n }, () => l)).maxLossUsdE8) / 1e8;
}

const FIELDS: { k: keyof Lim; label: string; help: string; usd?: boolean; min: number; max: number; step: number; unit?: string }[] = [
  { k: "maxTradeUsdE8", label: "Most per trade", help: "Any single trade above this is refused.", usd: true, min: 5, max: 1000, step: 5 },
  { k: "maxEpochUsdE8", label: "Daily budget", help: "Total it can trade in a day. Your worst day is a share of this.", usd: true, min: 10, max: 5000, step: 5 },
  { k: "maxExposureUsdE8", label: "Most held at once", help: "Coins it may hold, in dollars.", usd: true, min: 10, max: 5000, step: 10 },
  { k: "maxSlippageBps", label: "Slippage", help: "How much worse than the quote a fill may be. 100 bps = 1%.", min: 0, max: 1000, step: 10, unit: "bps" },
  { k: "maxOracleDeviationBps", label: "Price gap", help: "How far the pool may be from the oracle price.", min: 0, max: 1000, step: 10, unit: "bps" },
  { k: "cooldown", label: "Cooldown", help: "Wait between two trades.", min: 0, max: 3600, step: 10, unit: "s" },
];

/** `base`: what is on chain now (or the defaults), for marking changes. `vaults`: how many vaults share these limits. */
export function LimitsEditor({ value: l, onChange, base, baseLabel = "before", vaults = 1, presets = true }: { value: Lim; onChange(l: Lim): void; base: Lim; baseLabel?: string; vaults?: number; presets?: boolean }) {
  const worst = useMemo(() => worstDayUsd(l, vaults), [l, vaults]);
  const before = useMemo(() => worstDayUsd(base, vaults), [base, vaults]);
  const set = (k: keyof Lim, v: number) => onChange({ ...l, [k]: FIELDS.find((f) => f.k === k)?.usd ? usd(v) : v });
  const err = limError(l);
  const up = riskier(base, l);
  return (
    <div className="limed">
      {presets && (
        <div className="grid" role="radiogroup" aria-label="Preset" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {PRESETS.map((p) => {
            const on = sameLim(p.l, l);
            return (
              <button key={p.id} role="radio" aria-checked={on} className={`optrow${on ? " on" : ""}`} onClick={() => onChange({ ...p.l })}>
                <span className={`radio${on ? " on" : ""}`} aria-hidden="true" />
                <span className="grow">
                  <b>{p.label}</b>
                  <span className="xs fg2" style={{ display: "block" }}>{p.sub}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        {FIELDS.map((f) => {
          const v = f.usd ? d8(String(l[f.k])) : Number(l[f.k]);
          const changed = String(l[f.k]) !== String(base[f.k]);
          return (
            <div key={f.k} className={`limrow${changed ? " chg" : ""}`} title={f.help}>
              <span className="sm b5">
                {f.label}
                <span className="xs fg2" style={{ display: "block", fontWeight: 400 }}>{f.help}</span>
              </span>
              <Slider label={f.label} value={v} min={f.min} max={f.max} step={f.step} onChange={(x) => set(f.k, x)} />
              <NumField label={f.label} value={v} {...(f.usd ? { prefix: "$" } : { unit: f.unit! })} min={f.min} max={f.max} step={f.step} onChange={(x) => set(f.k, x)} focus={changed} />
            </div>
          );
        })}
        <Details summary="Stop-loss allowance">
          <div className={`limrow${l.maxExitDiscountBps !== base.maxExitDiscountBps ? " chg" : ""}`}>
            <span className="sm b5">
              Stop-loss allowance
              <span className="xs fg2" style={{ display: "block", fontWeight: 400 }}>How far below the price an emergency sale may fill. At least the price gap.</span>
            </span>
            <Slider label="Stop-loss allowance" value={l.maxExitDiscountBps} min={0} max={2000} step={10} onChange={(x) => onChange({ ...l, maxExitDiscountBps: x })} />
            <NumField label="Stop-loss allowance" value={l.maxExitDiscountBps} unit="bps" min={0} max={2000} step={10} onChange={(x) => onChange({ ...l, maxExitDiscountBps: x })} />
          </div>
        </Details>
      </div>
      <section className="card dk" style={{ marginTop: 14, padding: "18px 22px" }} aria-label="Most it can lose in a day">
        <div className="sm" style={{ color: "var(--sage)" }}>Most the agent can lose in a day</div>
        <div className="row g12 base" style={{ marginTop: 6 }}>
          <span className="bignum" style={{ color: "var(--y)", fontSize: 44 }} aria-live="polite">${worst.toFixed(2)}</span>
          {Math.abs(worst - before) >= 0.005 && <span className="sm" style={{ color: "var(--sage)" }}>was ${before.toFixed(2)}</span>}
        </div>
        <div className="sm" style={{ color: "var(--sage)", marginTop: 6 }}>
          Even if every trade it makes goes the worst way the vault allows{vaults > 1 ? ", across both vaults" : ""}. The vault refuses anything outside these limits.
        </div>
      </section>
      {!err && (() => {
        // The agent keeps enough of the daily budget to sell everything it may hold, so it buys with the rest.
        const room = d8(l.maxEpochUsdE8) - d8(l.maxExposureUsdE8);
        return (
          <div className="sm" style={{ marginTop: 10 }}>
            {room > 0
              ? `The agent can buy up to $${room.toFixed(0)} a day: it keeps $${d8(l.maxExposureUsdE8).toFixed(0)} of the daily budget to sell what it holds.`
              : "With the daily budget at or below most held, the agent cannot buy: it keeps that much of the budget to sell what it holds. Raise the daily budget above most held."}
          </div>
        );
      })()}
      {err ? (
        <div className="sm" role="alert" style={{ marginTop: 10 }}>{err}</div>
      ) : (
        <div className="xs fg2" style={{ marginTop: 8 }}>{up.length ? `Some limits are higher than ${baseLabel}, so Touch ID confirms them.` : "Lower or equal limits need no Touch ID."}</div>
      )}
    </div>
  );
}
