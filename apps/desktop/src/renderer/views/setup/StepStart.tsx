// Setup 3 · Start (SIMPLIFY.md): AI account, money in the vaults + agent gas, and the health checks (run silently;
// only failures show, each with one fix). "Start trading" saves the trader mode and starts the in-app trader.
import { useEffect, useState } from "react";
import { viaClaudeCode, type AiHealth } from "@shared/bridge";
import { useApp } from "../../src/app";
import {Btn, QR} from "../../src/ui";
import { SubscriptionSignIn } from "./Subscriptions";
import { OpencodeCard } from "./Opencode";
import { Details, ErrLine, HandoffDialog, Section, Spinner, Wizard, go, useOwner, useSetup, useSetupGet, StatusText } from "./common";

interface Fund {
  chainId: number;
  vaults: { market: string; address: string; usd: string; tokens: { symbol: string; address: string; decimals: number; amount: string; usd: string }[] }[];
  totalUsd: string;
  worstDayUsd: string;
  agent: { address: string; hsk: string | null } | null;
  faucets: { symbol: string; address: string; amount: string | null }[];
  hskFaucet: string | null;
}
interface Check {
  id: string;
  group: string;
  label: string;
  status: "pass" | "warn" | "fail" | "running";
  value: string;
  detail?: string;
  fix?: string;
}
interface Doctor {
  report: { checks: Check[]; pass: number; warn: number; fail: number; total: number };
}

const pair = (m: string) => (m.includes("WBTC") ? "WBTC/USDT" : "WHSK/USDT");

function AiPart({ onState, rules, setRules }: { onState(ok: boolean): void; rules: boolean; setRules(v: boolean): void }) {
  const [sub, setSub] = useState(false);
  const { ate } = useApp();
  const [h, setH] = useState<AiHealth | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  useEffect(() => {
    if (!ate.ai) return;
    void ate.ai.health().then((r) => {
      if (!r.ok) return setError(r.error);
      setH(r.data);
      if (r.data.credential !== "none" && !r.data.lastCheck) void ate.ai!.check().then((c) => c.ok && setH(c.data));
    });
  }, [ate]);
  const cli = !!h && viaClaudeCode(h);
  const ok = sub || cli || (!!h && h.credential !== "none" && h.lastCheck?.reachable !== false);
  useEffect(() => onState(ok), [ok, onState]);
  const save = async () => {
    if (!ate.ai) return;
    setBusy(true);
    setError(null);
    const r = await ate.ai.setKey(key.trim());
    setKey("");
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setH(r.data);
  };
  const useEngine = async (engine: "sdk" | "claude-code") => {
    setBusy(true);
    setError(null);
    const r = await ate.ai!.config({ engine });
    const c = r.ok ? await ate.ai!.check() : r;
    setBusy(false);
    if (!c.ok) return setError(c.error);
    setH(c.data);
  };
  const recheck = async () => {
    setBusy(true);
    const r = await ate.ai!.check();
    setBusy(false);
    if (r.ok) setH(r.data);
  };
  return (
    <Section title="AI account" done={ok} sub="Sign in with the AI subscription you already have." right={<button className="linkbtn sm" onClick={() => go("accounts")}>Other accounts</button>}>
      {!ate.ai ? (
        <p className="sm fg2" style={{ marginTop: 8 }}>The AI engine is not available in this build.</p>
      ) : !h ? (
        <div style={{ marginTop: 12 }}><Spinner label="Looking for an account…" /></div>
      ) : cli ? (
        <div className="row g12" style={{ marginTop: 12 }}>
          <span className="sm">{h.modelLabel} · Claude Code on this Mac</span>
          <StatusText tone="ok">ready</StatusText>
          <span className="grow" />
          <button className="linkbtn sm" disabled={busy} onClick={() => void useEngine("sdk")}>Use an API key instead</button>
        </div>
      ) : h.credential === "none" ? (
        <>
          <SubscriptionSignIn onConnected={setSub} />
          <div style={{ marginTop: 14 }}>
            <OpencodeCard onUsed={() => setSub(true)} />
          </div>
          <Details summary="Other ways to connect (advanced)">
          <div className="row g12">
            <input className="textin" type="password" autoComplete="off" spellCheck={false} placeholder="Anthropic API key (sk-ant-…)" aria-label="Anthropic API key" value={key} onChange={(e) => setKey(e.target.value)} />
            <Btn kind="solid" disabled={busy || !/^sk-ant-/.test(key.trim())} onClick={() => void save()}>{busy ? "Checking…" : "Save"}</Btn>
          </div>
          <div className="xs fg2" style={{ marginTop: 6 }}>An API key is kept in your macOS keychain and never shown again.</div>
          {h.claudeCli && (
            <Btn size="sm" disabled={busy} style={{ marginTop: 12 }} onClick={() => void useEngine("claude-code")}>
              Use Claude Code on this Mac
            </Btn>
          )}
          </Details>
          <label className="row g10 sm" style={{ marginTop: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={rules} onChange={(e) => setRules(e.target.checked)} style={{ width: 18, height: 18, accentColor: "#171e19" }} />
            Start without AI for now: a simple rules trader runs until you add an account.
          </label>
        </>
      ) : (
        <div className="row g12" style={{ marginTop: 12 }}>
          <span className="sm">
            {h.modelLabel} · {h.credential === "env" ? "from your environment" : h.credential === "profile" ? "from your Anthropic login" : "key in your keychain"}
          </span>
          {h.lastCheck ? <StatusText tone={h.lastCheck.reachable ? "ok" : "bad"}>{h.lastCheck.reachable ? "connected" : h.lastCheck.error?.message ?? "not reachable"}</StatusText> : <Spinner label="Checking…" />}
          <span className="grow" />
          <button className="linkbtn sm" disabled={busy} onClick={() => void recheck()}>Check again</button>
        </div>
      )}
      <ErrLine error={error} />
    </Section>
  );
}

function FundPart({ onState }: { onState(ok: boolean): void }) {
  const s = useSetup();
  const f = useSetupGet<Fund>("/setup/fund", { every: 6000 });
  const d = f.data;
  const [dep, setDep] = useState<{ market: string; token: string; amount: string } | null>(null);
  const [tok, setTok] = useState<string | null>(null);
  const [form, setForm] = useState<{ market: string; token: string; amount: string } | null>(null);
  const total = Number(d?.totalUsd ?? 0);
  const gas = Number(d?.agent?.hsk ?? 0);
  const gasOk = gas >= (d?.chainId === 133 ? 0.01 : 2);
  useEffect(() => onState(total > 0 && gasOk), [total, gasOk, onState]);
  return (
    <Section title="Money" done={total > 0 && gasOk} sub="Deposits go from your owner wallet into the vaults. Only the owner can take them out.">
      {!d ? (
        <div style={{ marginTop: 12 }}><Spinner label="Reading balances…" /></div>
      ) : (
        <>
          <div className="row g18" style={{ marginTop: 14, alignItems: "baseline" }}>
            <span className="big">${total.toFixed(2)}</span>
            <span className="sm fg2">in your vaults</span>
            <span className="grow" />
            <StatusText tone={gasOk ? "ok" : "warn"}>agent gas {gas.toFixed(3)} HSK</StatusText>
          </div>
          <div className="col" style={{ gap: 8, marginTop: 12 }}>
            {d.vaults.map((v) => (
              <div key={v.address} className="row g12 hx" style={{ padding: "10px 14px" }}>
                <span className="b7">{pair(v.market)}</span>
                <span className="sm fg2">{v.tokens.map((t) => `${t.amount} ${t.symbol}`).join(" · ")}</span>
                <span className="grow" />
                <span className="sm b7">${v.usd}</span>
                <Btn size="sm" onClick={() => setForm({ market: v.market, token: v.tokens[0]!.address, amount: "100" })}>Add funds</Btn>
              </div>
            ))}
          </div>
          {form && (
            <div className="hx" style={{ marginTop: 10 }}>
              <div className="row g12">
                <select className="textin" style={{ width: 160 }} aria-label="Token" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}>
                  {d.vaults.find((v) => v.market === form.market)!.tokens.map((t) => (
                    <option key={t.address} value={t.address}>{t.symbol}</option>
                  ))}
                </select>
                <input className="textin" style={{ width: 160 }} aria-label="Amount" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^0-9.]/g, "") })} />
                <Btn
                  kind="solid"
                  disabled={!(Number(form.amount) > 0)}
                  onClick={() => {
                    const t = d.vaults.find((v) => v.market === form.market)!.tokens.find((x) => x.address === form.token)!;
                    const [w, fr = ""] = form.amount.split(".");
                    setDep({ market: form.market, token: form.token, amount: (BigInt(w || "0") * 10n ** BigInt(t.decimals) + BigInt((fr + "0".repeat(t.decimals)).slice(0, t.decimals) || "0")).toString() });
                  }}
                >
                  Show QR
                </Btn>
                <button className="linkbtn sm" onClick={() => setForm(null)}>Cancel</button>
              </div>
            </div>
          )}
          {!gasOk && d.agent && (
            <div className="row g18 top" style={{ marginTop: 14 }}>
              <QR data={`ethereum:${d.agent.address}@${d.chainId}`} size={110} label="Agent address QR" />
              <div className="col g8" style={{ gap: 8 }}>
                <div className="sm b7">The agent needs a little HSK to pay gas.</div>
                <div className="mono xs">{d.agent.address}</div>
                {d.hskFaucet && <Btn size="sm" onClick={() => void s.open(d.hskFaucet!)}>Get free test HSK ↗</Btn>}
              </div>
            </div>
          )}
          {d.faucets.length > 0 && (
            <Details summary="Get test tokens">
              <p className="sm fg2">Each code calls the token's free faucet() from the wallet that scans it (once an hour). Then deposit with “Add funds”.</p>
              <div className="row g8" style={{ marginTop: 10, flexWrap: "wrap" }}>
                {d.faucets.map((t) => (
                  <Btn key={t.address} size="sm" onClick={() => setTok(t.address)}>
                    {t.symbol}{t.amount ? ` · ${Number(t.amount).toLocaleString("en-US")}` : ""}
                  </Btn>
                ))}
                {d.hskFaucet && <Btn size="sm" onClick={() => void s.open(d.hskFaucet!)}>HSK for gas ↗</Btn>}
              </div>
            </Details>
          )}
        </>
      )}
      <HandoffDialog open={!!dep} onClose={() => setDep(null)} title="Deposit" intro="Scan with your owner wallet. It sends the tokens straight into the vault." body={dep ? { kind: "deposit", ...dep } : null} onDone={() => (f.reload(), setForm(null))} />
      <HandoffDialog open={!!tok} onClose={() => setTok(null)} title="Free test tokens" intro="Scan with any wallet you choose. The faucet mints test tokens to that wallet." body={tok ? { kind: "faucet", token: tok } : null} />
    </Section>
  );
}

const FIX: Record<string, { label: string; to?: string; owner?: "setAgent" | "unpause" }> = {
  agent: { label: "Connect the key", owner: "setAgent" },
  paused: { label: "Resume the vaults", owner: "unpause" },
  rpc: { label: "Change the RPC", to: "settings" },
  "chain-id": { label: "Change the RPC", to: "settings" },
  model: { label: "Fix the AI account", to: "accounts" },
};

function ChecksPart({ onState }: { onState(ok: boolean | null): void }) {
  const d = useSetupGet<Doctor>("/setup/doctor");
  const owner = useOwner();
  const ag = useSetupGet<{ address: string | null }>("/setup/agent");
  const [fixing, setFixing] = useState<string | null>(null);
  const fix = async (id: string, what: "setAgent" | "unpause") => {
    if (!owner) return;
    setFixing(id);
    const r = what === "unpause" ? await owner.unpause() : ag.data?.address ? await owner.setAgent(ag.data.address) : null;
    setFixing(null);
    if (r && r.ok) d.reload();
  };
  const fails = d.data?.report.checks.filter((c) => c.status === "fail") ?? [];
  const warns = d.data?.report.checks.filter((c) => c.status === "warn") ?? [];
  useEffect(() => onState(d.data ? fails.length === 0 : null), [d.data, fails.length, onState]);
  return (
    <Section title="Safety checks" done={!!d.data && fails.length === 0} sub={!d.data ? "Checking the chain, prices and services…" : fails.length ? `${fails.length} thing${fails.length > 1 ? "s" : ""} to fix before trading.` : `All ${d.data.report.total} checks passed.`}>
      {d.loading && <div style={{ marginTop: 12 }}><Spinner label="Running checks" /></div>}
      {fails.length > 0 && (
        <div className="fails" style={{ marginTop: 10 }}>
          {fails.map((c) => {
            const fx = FIX[c.id];
            return (
              <div className="chk" key={c.id}>
                <span className="gl-bad" aria-hidden="true">✕</span>
                <div>
                  <div className="b5">{c.label}</div>
                  <div className="xs fg2">{c.fix ?? c.detail ?? c.value}</div>
                </div>
                {fx?.owner && owner ? <Btn size="sm" kind="solid" disabled={fixing === c.id} onClick={() => void fix(c.id, fx.owner!)}>{fixing === c.id ? "Working…" : fx.label}</Btn> : fx?.to ? <Btn size="sm" kind="solid" onClick={() => go(fx.to!)}>{fx.label}</Btn> : <Btn size="sm" kind="solid" onClick={d.reload}>Check again</Btn>}
              </div>
            );
          })}
        </div>
      )}
      {d.data && (
        <Details>
          {[...warns, ...d.data.report.checks.filter((c) => c.status === "pass")].map((c) => (
            <div className="kv sm" key={c.id}>
              <span className="k">
                {c.status === "warn" ? "! " : "✓ "}
                {c.label}
              </span>
              <span className="v">{c.value}</span>
            </div>
          ))}
          <button className="linkbtn sm" style={{ marginTop: 8 }} onClick={d.reload}>Run all checks again</button>
        </Details>
      )}
    </Section>
  );
}

export default function StepStart() {
  const s = useSetup();
  const { ate } = useApp();
  const st = useSetupGet<{ chainId: number }>("/setup/status");
  const [ai, setAi] = useState(false);
  const [rules, setRules] = useState(false);
  const [money, setMoney] = useState(false);
  const [checks, setChecks] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"autonomous" | "confirm">("autonomous");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await s.post("/setup/complete", { mode });
    if (!r.ok) {
      setBusy(false);
      return setError(r.error);
    }
    const t = await ate.trader?.start({ mode: mode === "confirm" ? "propose" : "autonomous", engine: ai ? "llm" : "rules" } as never);
    setBusy(false);
    if (t && !t.ok) return setError(t.error);
    go("home");
  };
  const ready = (ai || rules) && money && checks === true;
  return (
    <Wizard step={3} chainId={st.data?.chainId ?? 133} shot={ready ? "03-start-ready" : "03-start"} hint="The kill switch is on every screen from now on." next={() => void start()} nextLabel="Start trading" nextDisabled={!ready} busy={busy}>
      <div className="stepno">Step 3 of 3</div>
      <h1>
        Ready to <span className="hl">start</span>
      </h1>
      <p className="lead">Connect the AI, add some money, and Flow checks the rest.</p>
      <AiPart onState={setAi} rules={rules} setRules={setRules} />
      <FundPart onState={setMoney} />
      <ChecksPart onState={setChecks} />
      <Section title="How should it trade?">
        <div className="grid" role="radiogroup" aria-label="Trader mode" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          {(
            [
              ["autonomous", "On its own", "Trades inside your limits without asking."],
              ["confirm", "Ask me first", "Waits for your OK on every trade."],
            ] as const
          ).map(([id, t, sub]) => (
            <button key={id} role="radio" aria-checked={mode === id} className={`optrow${mode === id ? " on" : ""}`} onClick={() => setMode(id)}>
              <span className={`radio${mode === id ? " on" : ""}`} aria-hidden="true" />
              <span>
                <b>{t}</b>
                <span className="xs fg2" style={{ display: "block" }}>{sub}</span>
              </span>
            </button>
          ))}
        </div>
      </Section>
      <ErrLine error={error} />
    </Wizard>
  );
}
