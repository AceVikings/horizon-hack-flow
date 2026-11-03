// Wallet → Vaults: every vault the Flow wallet owns, the ones in use and earlier ones (each keeps Deposit / Withdraw,
// so money is never stranded in a vault Flow no longer trades), "Use this vault" to switch a market's active vault,
// and "Create a new vault" with limits and live on-chain progress. Creating runs in the owner service; limits above
// the defaults ask Touch ID there. Switching rewrites config.json and restarts the daemon (the trader resumes).
import { useEffect, useMemo, useRef, useState } from "react";
import { worstCase } from "@ate/core";
import type { OwnerJob, OwnerJobStep, OwnerState, OwnerVault } from "../../shared/setup-bridge";
import { useApp } from "../src/app";
import { AddrLink, Btn, Dialog, TxLink } from "../src/ui";
import { money, short } from "../src/format";
import { Details, ErrLine, HandoffDialog, NumField, Section, Spinner, StatusText, useOwner } from "./setup/common";
import { foreignOwnerOf, type Ownership } from "./setup/ownership";

interface Token {
  symbol: string;
  address: string;
  decimals: number;
  amount: string;
  usd: string;
}
/** /setup/fund (the vaults in use, any owner). */
export interface Fund {
  chainId: number;
  vaults: { market: string; address: string; usd: string; tokens: Token[] }[];
  totalUsd: string;
  agent: { address: string; hsk: string | null } | null;
  hskFaucet: string | null;
}
interface Row {
  market: string;
  address: string;
  active: boolean;
  /** Withdraw / switch need the Flow wallet as owner. */
  ours: boolean;
  paused: boolean | null;
  limits: Record<string, string> | null;
  agent: string | null;
  createdAt: number | null;
  tokens: Token[];
  usd: number;
}
type Err = { message: string } | null;
type Mk = "btc" | "hsk";

const mkOf = (market: string): Mk => (market.includes("WBTC") ? "btc" : "hsk");
const NAME: Record<Mk, string> = { btc: "BTC", hsk: "HSK" };
const lc = (s: string) => s.toLowerCase();
const d8 = (e8: string | undefined) => (e8 ? Number(BigInt(e8)) / 1e8 : 0);
const e8 = (usd: number) => String(BigInt(Math.round(usd * 100)) * 1_000_000n);
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
const fmtAmt = (raw: string, dec: number) => {
  const n = Number(raw) / 10 ** dec;
  return n.toFixed(dec === 6 ? 2 : n > 0 && n < 0.01 ? 6 : 4);
};
const date = (t: number) => new Date(t * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const secs = (ms: number) => (ms < 60_000 ? `${Math.max(0, ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/** "1.5" with `dec` decimals → base units string; null when not a positive number. */
function toUnits(v: string, dec: number): string | null {
  if (!/^\d*\.?\d*$/.test(v) || !(Number(v) > 0)) return null;
  const [w, f = ""] = v.split(".");
  return (BigInt(w || "0") * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0")).toString();
}

/** Worst day for one vault with these limits (SPEC §4.6, same formula as setup). */
function worstDay(l: Record<string, string>, n = 1): number {
  const one = { maxEpochUsdE8: l.maxEpochUsd ?? "0", maxSlippageBps: Number(l.maxSlippageBps), maxOracleDeviationBps: Number(l.maxOracleDeviationBps), maxExitDiscountBps: Number(l.maxExitDiscountBps) };
  return Number(worstCase(Array.from({ length: n }, () => one) as never).maxLossUsdE8) / 1e8;
}
/** Owner-service RISK_UP: caps and tolerances raise risk going up; a shorter epoch or cooldown raises it going down. */
const DOWN_RAISES = new Set(["epochDuration", "cooldown"]);
const raises = (base: Record<string, string>, l: Record<string, string>) => Object.keys(base).filter((k) => (DOWN_RAISES.has(k) ? BigInt(l[k] ?? "0") < BigInt(base[k]!) : BigInt(l[k] ?? "0") > BigInt(base[k]!)));
const limitLine = (l: Record<string, string>) => `${money(d8(l.maxTradeUsd), 0)} a trade · ${money(d8(l.maxEpochUsd), 0)} a day · ${money(d8(l.maxExposureUsd), 0)} held · worst day ${money(worstDay(l))}`;

function rowsOf(st: OwnerState | null, fund: Fund | null): Row[] {
  const active = new Set([...(st?.active ?? []), ...(fund?.vaults ?? [])].map((v) => lc(v.address)));
  const out: Row[] = [];
  for (const v of st?.vaults ?? []) {
    if (!v.market || (!v.ownedByUs && !active.has(lc(v.address)))) continue;
    const px = v.holdings?.priceE8 ? Number(v.holdings.priceE8) / 1e8 : 0;
    const tokens = (v.holdings?.tokens ?? []).map((t, i) => {
      const amt = Number(t.raw) / 10 ** t.decimals;
      return { symbol: t.symbol, address: t.address, decimals: t.decimals, amount: fmtAmt(t.raw, t.decimals), usd: (i === 0 ? amt : amt * px).toFixed(2) };
    });
    const f = fund?.vaults.find((x) => lc(x.address) === lc(v.address));
    out.push({
      market: v.market,
      address: v.address,
      active: active.has(lc(v.address)),
      ours: !!v.ownedByUs,
      paused: v.paused ?? null,
      limits: v.limits ?? null,
      agent: v.agent ?? null,
      createdAt: v.createdAt ?? null,
      tokens: tokens.length ? tokens : (f?.tokens ?? []),
      usd: tokens.length ? tokens.reduce((a, t) => a + Number(t.usd), 0) : Number(f?.usd ?? 0),
    });
  }
  // a vault in use that the owner service does not list (owned elsewhere, "I already have vaults")
  for (const f of fund?.vaults ?? []) {
    if (out.some((r) => lc(r.address) === lc(f.address))) continue;
    out.push({ market: f.market, address: f.address, active: true, ours: false, paused: null, limits: null, agent: null, createdAt: null, tokens: f.tokens, usd: Number(f.usd) });
  }
  const order = (r: Row) => (r.active ? 0 : 1);
  return out.sort((a, b) => order(a) - order(b) || (a.active ? mkOf(a.market).localeCompare(mkOf(b.market)) : (b.createdAt ?? 0) - (a.createdAt ?? 0)));
}

export function VaultsPart({ fund, ownerAddr, own, reload: reloadFund }: { fund: Fund | null; ownerAddr: string | null; own: Ownership & { flow: string | null }; reload(): void }) {
  const owner = useOwner()!;
  const { toast } = useApp();
  const [st, setSt] = useState<OwnerState | null>(null);
  const [stErr, setStErr] = useState<Err>(null);
  const [n, setN] = useState(0);
  const [form, setForm] = useState<{ kind: "deposit" | "withdraw"; vault: string; market: string; token: string; amount: string; to: string } | null>(null);
  const [dep, setDep] = useState<{ market: string; token: string; amount: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  const [creating, setCreating] = useState(false);
  const [useIt, setUseIt] = useState<Row | null>(null);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (!owner.state) return;
    let live = true;
    const run = () => void owner.state!().then((r) => live && (r.ok ? (setSt(r.data), setStErr(null)) : setStErr(r.error)));
    run();
    const iv = setInterval(run, 15_000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [owner, n]);
  const reload = () => (setN((x) => x + 1), reloadFund());
  const rows = useMemo(() => rowsOf(st, fund), [st, fund]);
  const total = rows.filter((r) => r.active).reduce((a, r) => a + r.usd, 0);

  const v = form && rows.find((x) => x.address === form.vault);
  const t = v?.tokens.find((x) => x.address === form?.token);
  const units = t && form ? toUnits(form.amount, t.decimals) : null;
  const tooMuch = !!t && !!form && Number(form.amount) > Number(t.amount);
  const open = (kind: "deposit" | "withdraw", x: Row) => {
    setError(null);
    const tk = x.tokens.find((k) => Number(k.amount) > 0) ?? x.tokens[0]!;
    setForm({ kind, vault: x.address, market: x.market, token: tk.address, amount: kind === "deposit" ? "100" : tk.amount, to: "" });
  };
  const withdraw = async () => {
    if (!form || !units || !owner.withdraw) return;
    setBusy(true);
    setError(null);
    const r = await owner.withdraw({ vault: form.vault, token: form.token, amount: units, to: form.to.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast({ kind: "ok", text: `Withdrew ${form.amount} ${t!.symbol}`, sub: `to ${short(form.to.trim(), 6, 4)}` });
    setForm(null);
    reload();
  };
  const switchTo = async (r: Row) => {
    if (!owner.useVault) return;
    setSwitching(true);
    setError(null);
    const x = await owner.useVault({ market: r.market, address: r.address });
    setSwitching(false);
    setUseIt(null);
    if (!x.ok) return setError(x.error);
    toast({ kind: "ok", text: `Now trading from the ${NAME[mkOf(r.market)]} vault ${short(r.address, 6, 4)}`, sub: "The agent restarted on it." });
    reload();
  };
  const current = useIt ? rows.find((r) => r.active && r.market === useIt.market) : null;

  return (
    <Section title="Vaults" sub="Your money. Only your Flow wallet can take it out." right={rows.length > 0 && <span className="h3">{money(total)}</span>}>
      {!st && !fund ? (
        <div style={{ marginTop: 12 }}><Spinner label="Reading your vaults…" /></div>
      ) : rows.length === 0 ? (
        <p className="sm fg2" style={{ marginTop: 10 }}>No vaults yet.</p>
      ) : (
        <div className="col" style={{ gap: 8, marginTop: 14 }}>
          {rows.map((x) => {
            const other = !x.ours ? (foreignOwnerOf(own, own.flow, x.address) ?? "another wallet") : null;
            const empty = x.tokens.every((k) => Number(k.amount) === 0);
            return (
              <div key={x.address} className="hx" data-vault={x.address}>
                <div className="row g12" style={{ flexWrap: "wrap" }}>
                  <span className="b7">{NAME[mkOf(x.market)]} vault</span>
                  {x.active ? <StatusText tone="ok">In use</StatusText> : <StatusText>Earlier vault</StatusText>}
                  {x.paused && <StatusText tone="warn">Paused</StatusText>}
                  <span className="grow" />
                  <span className="sm b7">{money(x.usd)}</span>
                  <Btn size="sm" onClick={() => open("deposit", x)}>Deposit</Btn>
                  {owner.withdraw && x.ours && <Btn size="sm" disabled={empty} onClick={() => open("withdraw", x)}>Withdraw</Btn>}
                  {!x.active && x.ours && owner.useVault && <Btn size="sm" kind="solid" onClick={() => setUseIt(x)}>Use this vault</Btn>}
                </div>
                <div className="sm fg2" style={{ marginTop: 6 }}>{x.tokens.map((k) => `${k.amount} ${k.symbol}`).join(" · ") || "…"}</div>
                <div className="xs fg2 row g10" style={{ marginTop: 4, flexWrap: "wrap" }}>
                  <AddrLink addr={x.address} />
                  {x.limits && <span>{limitLine(x.limits)}</span>}
                  {x.createdAt && <span>Created {date(x.createdAt)}</span>}
                </div>
                {other && <div className="xs fg2" style={{ marginTop: 6 }}>Withdraw is off here: this vault is owned by <span className="mono">{other}</span>. Only that wallet can withdraw or resume.</div>}
                {form && form.vault === x.address && (
                  <div style={{ marginTop: 12 }}>
                    <div className="row g12" style={{ flexWrap: "wrap" }}>
                      <select className="textin" style={{ width: 120 }} aria-label="Token" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}>
                        {x.tokens.map((k) => (
                          <option key={k.address} value={k.address}>{k.symbol}</option>
                        ))}
                      </select>
                      <input className="textin" style={{ width: 140 }} aria-label="Amount" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^0-9.]/g, "") })} />
                      {form.kind === "withdraw" && (
                        <input className="textin mono" style={{ flex: "1 1 260px" }} aria-label="Send to address" placeholder="Your address (0x…)" spellCheck={false} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
                      )}
                    </div>
                    <div className="row g12" style={{ marginTop: 10 }}>
                      {form.kind === "withdraw" ? (
                        <>
                          <span className="xs fg2">
                            {tooMuch ? "That is more than the vault holds." : form.to && !isAddr(form.to) ? "That is not an address." : "Touch ID confirms it. The money leaves the vault at once."}
                            {ownerAddr && !form.to && (
                              <> <button className="linkbtn" onClick={() => setForm({ ...form, to: ownerAddr })}>Use my Flow wallet</button></>
                            )}
                          </span>
                          <span className="grow" />
                          <Btn kind="solid" size="sm" disabled={busy || !units || tooMuch || !isAddr(form.to)} onClick={() => void withdraw()}>{busy ? "Waiting for Touch ID…" : "Withdraw to my address"}</Btn>
                        </>
                      ) : (
                        <>
                          <span className="xs fg2">Send from any wallet that holds the tokens. Flow shows a QR code.</span>
                          <span className="grow" />
                          <Btn kind="solid" size="sm" disabled={!units} onClick={() => setDep({ market: form.market, token: form.token, amount: units! })}>Show QR</Btn>
                        </>
                      )}
                      <button className="linkbtn sm" onClick={() => setForm(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {owner.state && st && (creating || st.job?.state === "running" ? (
        <CreatePanel st={st} onClose={() => setCreating(false)} onCreated={() => reload()} onUse={(r) => setUseIt(r)} rows={rows} />
      ) : (
        <div className="row g12" style={{ marginTop: 14 }}>
          <Btn kind="solid" onClick={() => setCreating(true)}>{st.unfinished.length ? "Finish creating your vault" : "Create a new vault"}</Btn>
          {st.unfinished.length > 0 && <span className="xs fg2">A creation stopped part way. Flow keeps what is on chain and does the rest.</span>}
        </div>
      ))}
      <ErrLine error={error ?? stErr} />
      <HandoffDialog open={!!dep} onClose={() => setDep(null)} title="Deposit" eyebrow="From any wallet" intro="Scan with any wallet that holds the tokens. It sends them straight into the vault." body={dep ? { kind: "deposit", ...dep } : null} onDone={() => (reload(), setForm(null))} />
      <Dialog
        open={!!useIt}
        onClose={() => !switching && setUseIt(null)}
        title={useIt ? `Use this ${NAME[mkOf(useIt.market)]} vault?` : ""}
        footer={
          <>
            <span className="grow" />
            <Btn kind="ghost" disabled={switching} onClick={() => setUseIt(null)}>Cancel</Btn>
            <Btn kind="pri" disabled={switching} onClick={() => useIt && void switchTo(useIt)}>{switching ? "Switching…" : "Use this vault"}</Btn>
          </>
        }
      >
        {useIt && (
          <>
            <p className="sm">The agent trades {NAME[mkOf(useIt.market)]} from <span className="mono">{short(useIt.address, 6, 4)}</span> from now on{useIt.limits ? `: ${limitLine(useIt.limits)}` : ""}.</p>
            {current && <p className="sm fg2" style={{ marginTop: 8 }}>The vault in use now, <span className="mono">{short(current.address, 6, 4)}</span>, keeps its {money(current.usd)} and stays listed here. You can withdraw from it or switch back at any time.</p>}
            <p className="sm fg2" style={{ marginTop: 8 }}>The agent restarts on the new vault, which takes a few seconds.</p>
          </>
        )}
      </Dialog>
    </Section>
  );
}

const GROUPS: { g: OwnerJobStep["group"]; label: string }[] = [
  { g: "deploy", label: "Deploying" },
  { g: "limits", label: "Setting limits" },
  { g: "agent", label: "Connecting the agent" },
  { g: "seed", label: "Adding test tokens" },
];

function CreatePanel({ st, rows, onClose, onCreated, onUse }: { st: OwnerState; rows: Row[]; onClose(): void; onCreated(): void; onUse(r: Row): void }) {
  const owner = useOwner()!;
  const { toast } = useApp();
  const defaults = st.defaults;
  const unfinished = st.unfinished.map((u) => mkOf(u.market));
  const [mk, setMk] = useState<Mk[]>(unfinished.length ? [...new Set(unfinished)] : ["btc"]);
  const [l, setL] = useState<Record<string, string>>(() => ({ ...defaults }));
  const [job, setJob] = useState<OwnerJob | null>(st.job?.state === "running" ? st.job : null);
  const [running, setRunning] = useState(st.job?.state === "running");
  const [done, setDone] = useState<{ vaults: { market: string; address: string }[]; seconds: number | null; seedError: string | null } | null>(null);
  const [error, setError] = useState<Err>(null);
  const [, tick] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const testnet = st.chainId === 133;
  const up = raises(defaults, l);
  const worst = worstDay(l, mk.length);
  const gas = st.gasHsk === null ? null : Number(st.gasHsk);
  const lowGas = gas !== null && gas < 0.006 * mk.length;
  const resume = mk.some((m) => unfinished.includes(m));

  // Live progress: poll the owner service's job while a creation runs (also one started before this screen opened).
  useEffect(() => {
    if (!running || !owner.job) return;
    let live = true;
    const iv = setInterval(() => {
      tick((x) => x + 1);
      void owner.job!().then((r) => {
        if (!live || !r.ok || !r.data) return;
        setJob(r.data);
        if (r.data.state !== "running" && !timer.current) {
          setRunning(false);
          onCreated();
        }
      });
    }, 700);
    return () => {
      live = false;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, owner]);

  const create = async () => {
    setError(null);
    setDone(null);
    setJob(null);
    setRunning(true);
    timer.current = setInterval(() => tick((x) => x + 1), 500);
    const r = await owner.createVaults({ markets: mk, limits: l, use: false });
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    const j = owner.job ? await owner.job() : null;
    if (j?.ok && j.data) setJob(j.data);
    setRunning(false);
    onCreated();
    if (!r.ok) return setError(r.error);
    setDone({ vaults: r.data.vaults, seconds: r.data.seconds ?? null, seedError: r.data.seedError ?? null });
    toast({ kind: "ok", text: r.data.vaults.length === 2 ? "Two vaults created" : `${NAME[mkOf(r.data.vaults[0]!.market)]} vault created`, sub: r.data.seconds ? `in ${r.data.seconds} s` : undefined });
  };
  const set = (k: string, usd: number) => setL((x) => ({ ...x, [k]: e8(usd) }));
  const setN = (k: string, v: number) => setL((x) => ({ ...x, [k]: String(v) }));
  const toggle = (m: Mk) => setMk((x) => (x.includes(m) ? (x.length > 1 ? x.filter((y) => y !== m) : x) : [...x, m].sort() as Mk[]));

  return (
    <div className="hx" style={{ marginTop: 14 }} aria-label="Create a new vault">
      <div className="row g12">
        <span className="h3">{resume && !running && !done ? "Finish creating your vault" : "Create a new vault"}</span>
        <span className="grow" />
        {!running && <button className="linkbtn sm" onClick={onClose}>{done ? "Close" : "Cancel"}</button>}
      </div>
      {!running && !done && (
        <>
          {resume && <p className="sm" style={{ marginTop: 8 }}>A creation stopped part way. Flow keeps what is already on chain and does the rest.</p>}
          <div className="grid" role="group" aria-label="Market" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            {(["btc", "hsk"] as const).map((m) => (
              <button key={m} role="checkbox" aria-checked={mk.includes(m)} className={`optrow${mk.includes(m) ? " on" : ""}`} onClick={() => toggle(m)}>
                <span className={`radio${mk.includes(m) ? " on" : ""}`} aria-hidden="true" />
                <span className="grow">
                  <b>{NAME[m]} vault</b>
                  <span className="xs fg2" style={{ display: "block" }}>{m === "btc" ? "Trades WBTC against USDT" : "Trades WHSK against USDT"}</span>
                </span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            {(
              [
                ["Most per trade", "maxTradeUsd", 5, 1000, 5],
                ["Most per day", "maxEpochUsd", 10, 5000, 10],
                ["Most held at once", "maxExposureUsd", 10, 5000, 10],
              ] as const
            ).map(([label, k, min, max, step]) => (
              <div key={k} className="row g12" style={{ marginTop: 8 }}>
                <span className="sm grow">{label}</span>
                {l[k] !== defaults[k] && <span className="xs fg2">default {money(d8(defaults[k]), 0)}</span>}
                <NumField label={label} value={d8(l[k])} prefix="$" min={min} max={max} step={step} onChange={(x) => set(k, x)} />
              </div>
            ))}
            <Details summary="More limits">
              {(
                [
                  ["Max slippage", "maxSlippageBps", 0, 1000, "bps"],
                  ["Max oracle deviation", "maxOracleDeviationBps", 0, 1000, "bps"],
                  ["Max exit discount", "maxExitDiscountBps", 0, 2000, "bps"],
                  ["Cooldown between trades", "cooldown", 0, 3600, "s"],
                ] as const
              ).map(([label, k, min, max, unit]) => (
                <div key={k} className="row g12" style={{ marginTop: 8 }}>
                  <span className="sm grow">{label}</span>
                  <NumField label={label} value={Number(l[k])} unit={unit} min={min} max={max} onChange={(x) => setN(k, x)} />
                </div>
              ))}
            </Details>
          </div>
          <div className="row g12 base" style={{ marginTop: 14 }}>
            <span className="sm">Most it can lose in a day</span>
            <span className="h3">{money(worst)}</span>
            <span className="xs fg2">{mk.length === 2 ? "across both vaults" : ""}</span>
          </div>
          {d8(l.maxEpochUsd) < d8(l.maxTradeUsd) && <StatusText tone="warn">The daily budget must be at least the per-trade cap.</StatusText>}
          <div className="xs fg2" style={{ marginTop: 8 }}>
            {up.length ? "Higher than the defaults, so Touch ID confirms it." : "Nothing to sign."} About 0.004 HSK of gas per vault from your Flow wallet ({gas === null ? "…" : `${gas.toFixed(3)} HSK`}).
            {testnet ? " Flow adds test tokens: 150 tUSDT and $50 of the coin." : ""} Your vaults in use stay as they are until you pick Use this vault.
          </div>
          {lowGas && <StatusText tone="warn">Your Flow wallet needs a little more HSK for gas.</StatusText>}
          <Btn kind="pri" style={{ marginTop: 12 }} disabled={lowGas || d8(l.maxEpochUsd) < d8(l.maxTradeUsd)} onClick={() => void create()}>
            {resume ? "Finish creating" : mk.length === 2 ? "Create two vaults" : `Create ${NAME[mk[0]!]} vault`}
            {up.length ? " · raises risk" : ""}
          </Btn>
        </>
      )}
      {(running || job) && <Progress job={job} running={running} testnet={testnet} />}
      {done && (
        <div style={{ marginTop: 12 }}>
          <StatusText tone="ok">{done.vaults.length === 2 ? "Both vaults are ready" : "Your vault is ready"}{done.seconds ? ` · ${done.seconds} s` : ""}. Every step is confirmed on chain.</StatusText>
          {done.seedError && <div className="xs fg2" style={{ marginTop: 6 }}>The test tokens did not go in: {done.seedError}. Deposit some from the vault's row.</div>}
          <div className="col" style={{ gap: 8, marginTop: 10 }}>
            {done.vaults.map((v) => {
              const r = rows.find((x) => lc(x.address) === lc(v.address));
              return (
                <div key={v.address} className="row g12">
                  <span className="sm b7">{NAME[mkOf(v.market)]} vault</span>
                  <AddrLink addr={v.address} />
                  <span className="grow" />
                  {r && !r.active && <Btn size="sm" kind="solid" onClick={() => onUse(r)}>Use this vault</Btn>}
                  {r?.active && <StatusText tone="ok">In use</StatusText>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {error && !running && (
        <div style={{ marginTop: 10 }}>
          <ErrLine error={error} />
          <Btn style={{ marginTop: 10 }} onClick={() => void create()}>Try again</Btn>
          <div className="xs fg2" style={{ marginTop: 6 }}>Flow continues where it stopped. Nothing on chain is redone.</div>
        </div>
      )}
    </div>
  );
}

function Progress({ job, running, testnet }: { job: OwnerJob | null; running: boolean; testnet: boolean }) {
  const now = Date.now();
  const start = job?.startedAt ?? now;
  const markets = job ? [...new Set(job.steps.map((s) => s.market))] : [];
  return (
    <div style={{ marginTop: 12 }} aria-live="polite">
      <div className="row g12">
        {running ? <Spinner label={job ? "Creating on chain…" : "Starting…"} /> : <span className="sm b7">{job?.state === "done" ? "Created" : "Stopped"}</span>}
        <span className="grow" />
        <span className="mono sm">{secs((job?.finishedAt ?? now) - start)}</span>
      </div>
      {markets.map((m) => (
        <div key={m} style={{ marginTop: 10 }}>
          {markets.length > 1 && <div className="xs b7" style={{ marginBottom: 4 }}>{NAME[mkOf(m)]} vault</div>}
          {GROUPS.filter((g) => g.g !== "seed" || testnet).map(({ g, label }) => {
            const ss = job!.steps.filter((s) => s.market === m && s.group === g);
            if (!ss.length && g === "seed") return null;
            const live = ss.filter((s) => s.state !== "skipped");
            const state = !live.length ? "skipped" : live.some((s) => s.state === "failed") ? "failed" : live.every((s) => s.state === "done") ? "done" : live.some((s) => s.state === "sent") ? "sent" : "waiting";
            const t0 = Math.min(...live.map((s) => s.sentAt ?? Infinity));
            const t1 = live.every((s) => s.doneAt) ? Math.max(...live.map((s) => s.doneAt!)) : now;
            return (
              <div key={g} className="row g10 sm" style={{ marginTop: 4, flexWrap: "wrap" }}>
                <span style={{ width: 18, display: "inline-grid", placeItems: "center" }} aria-hidden="true">
                  {state === "done" ? <span className="gl-ok">✓</span> : state === "failed" ? "✕" : state === "sent" ? <span className="gl-run" /> : state === "skipped" ? "✓" : "·"}
                </span>
                <span className={state === "waiting" ? "fg2" : ""} style={{ minWidth: 170 }}>{label}</span>
                <span className="xs fg2" style={{ minWidth: 48 }}>{state === "skipped" ? "already done" : Number.isFinite(t0) ? secs(t1 - t0) : ""}</span>
                {live.filter((s) => s.hash).map((s) => (
                  <span key={s.id} className="xs" title={s.label}><TxLink hash={s.hash!} /></span>
                ))}
                {live.find((s) => s.state === "failed")?.error && <span className="xs" style={{ color: "var(--bad, #b42318)" }}>{live.find((s) => s.state === "failed")!.error}</span>}
              </div>
            );
          })}
        </div>
      ))}
      {job?.state === "failed" && job.error && !running && <div className="xs fg2" style={{ marginTop: 8 }}>{job.error}</div>}
    </div>
  );
}

export type { OwnerVault };
