// Safety & proof (Flow v1, simplified per docs/design/flow/SIMPLIFY.md): one sentence ("7 attacks tried, 7 stopped by
// the vault"), Pause / Resume, and "Run safety test" — the rogue suite run in-app on testnet through the daemon
// (POST /proof/run; view-only on mainnet). The attack list is collapsed by default; decoded refusals, tx links and the
// pause history sit behind "Show details". Live progress while the test runs.
import { useState } from "react";
import { MARKETS } from "@ate/core";
import type { PauseEvent, ProofAttack, ProofRun, ProofState, Res } from "@shared/bridge";
import { useApp, useNow, useRemote } from "../src/app";
import { short } from "../src/format";
import { PageHead, useKillSwitch, useMode } from "../src/shell";
import { Badge, Btn, Dialog, Link, QR } from "../src/ui";
import type { ViewProps } from "./registry";

const ATTACKS: Record<ProofAttack["attack"], { name: string; stops: string }> = {
  trade_cap: { name: "A $5,000 buy", stops: "Trade too big" },
  exposure: { name: "Buying past the holding limit", stops: "Holding limit" },
  slippage: { name: "Selling at any price (minimum out = 1)", stops: "Price floor" },
  pair: { name: "Paying with a fake token", stops: "Only the pinned pair" },
  withdraw: { name: "Withdrawing all the money", stops: "Only the owner can withdraw" },
  set_limits: { name: "Raising its own limits", stops: "Only the owner can change limits" },
  paused: { name: "Trading after a pause", stops: "Vault is paused" },
};
const ORDER = Object.keys(ATTACKS) as ProofAttack["attack"][];

/** Decoded custom error, with USD (8-dp) arguments shown as dollars and addresses shortened. */
function prettyError(d: string | undefined, attack: string): string | null {
  if (!d) return null;
  const m = /^(\w+)\((.*)\)$/.exec(d);
  if (!m) return d;
  const args = m[2] ? m[2].split(", ") : [];
  const usd = attack === "trade_cap" || attack === "exposure";
  return `${m[1]}(${args.map((a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? short(a, 6, 4) : usd && /^\d+$/.test(a) ? (Number(a) / 1e8).toFixed(2) : /^\d{13,}$/.test(a) ? `${a.slice(0, 6)}…` : a)).join(", ")})`;
}
const when = (at: number) => new Date(at * 1000).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dur = (a: number, b: number) => `${Math.floor((b - a) / 60)}m ${String((b - a) % 60).padStart(2, "0")}s`;

export default function Proof(_: ViewProps) {
  const { ate, vsOk, toast } = useApp();
  const kill = useKillSwitch();
  const [mode] = useMode();
  const now = useNow(1000);
  const [showList, setShowList] = useState(false);
  const [details, setDetails] = useState(false);
  const [qr, setQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const [poll, setPoll] = useState(10_000);
  const p = useRemote<ProofState>(() => (ate.proof ? ate.proof.get() : Promise.resolve({ ok: false, error: { code: "ATE_INTERNAL", message: "Safety needs the live daemon" } } as Res<ProofState>)), [], { every: poll, onEvents: false });
  const s = p.last;
  const running = s?.run?.status === "running";
  if (running && poll !== 1500) setPoll(1500);
  if (!running && poll !== 10_000 && s) setPoll(10_000);

  const run: ProofRun | null = s?.run ?? s?.recorded[0] ?? null;
  const attacks = run ? ORDER.map((a) => run.attacks.find((x) => x.attack === a) ?? { attack: a, expected: "", status: "queued" as const }) : [];
  const tried = attacks.filter((a) => a.status !== "queued" && a.status !== "skipped" && a.status !== "running").length;
  const stopped = attacks.filter((a) => a.status === "reverted").length;
  const paused = vsOk?.status.vaults.some((v) => v.paused) ?? false;
  const hskPaused = !!s?.paused["hsk-dex:WHSK/USDT:3000"];
  const doneCount = attacks.filter((a) => a.status !== "queued" && a.status !== "running").length;
  const current = attacks.findIndex((a) => a.status === "running");

  const start = async () => {
    if (!ate.proof) return;
    setConfirmRun(false);
    setBusy(true);
    const r = await ate.proof.run({});
    setBusy(false);
    if (!r.ok) toast({ kind: "error", text: r.error.message });
    else setShowList(true);
    setPoll(1500);
    p.reload();
  };
  const stop = async () => {
    if (!ate.proof) return;
    await ate.proof.stop();
    toast({ kind: "info", text: "Stopping after this attack" });
    p.reload();
  };
  const exportRun = () => {
    if (!run) return;
    const blob = new Blob([JSON.stringify({ chainId: s?.chainId, explorer: s?.explorer, run, pauses: s?.pauses }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `flow-safety-test-${run.startedAt}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const sentence = !s
    ? p.res && !p.res.ok
      ? p.res.error.message
      : "Reading the last safety test…"
    : running
      ? `Trying attack ${Math.min(doneCount + 1, 7)} of 7 on your vault…`
      : run
        ? `${tried} attacks tried, ${stopped} stopped by the vault.`
        : "No safety test yet.";

  return (
    <div className="page1">
      <PageHead title="Safety" sub="We attack your vault with the agent's own key. The vault must refuse every time." />

      <div className="sentence" role="status" style={{ fontSize: 26 }}>
        {sentence}
      </div>
      {run && !running && (
        <div className="sm fg2" style={{ marginTop: 6 }}>
          {run.finishedAt ? `Last test ${when(run.finishedAt)}` : ""} · {s?.chainId === 133 ? "on testnet" : "recorded on testnet"} · every refusal is a real transaction you can open.
        </div>
      )}
      {running && run && (
        <>
          <div className="bar thick stripe" style={{ marginTop: 16 }} role="progressbar" aria-valuemin={0} aria-valuemax={7} aria-valuenow={doneCount}>
            <i style={{ width: `${(doneCount / 7) * 100}%` }} />
          </div>
          <div className="sm fg2" style={{ marginTop: 8 }}>
            {dur(run.startedAt, now)} so far. The agent holds new trades on Vault-HSK until the test ends; protective sells still run.
            {current === 6 && " Waiting for your guardian device to pause the vault."}
          </div>
        </>
      )}

      <div className="row g10" style={{ marginTop: 22, flexWrap: "wrap", alignItems: "center" }}>
        {running ? (
          <Btn onClick={() => void stop()} disabled={!!run?.stopRequested}>
            {run?.stopRequested ? "Stopping after this attack…" : "Stop after this attack"}
          </Btn>
        ) : s?.runnable ? (
          <Btn kind="pri" size="lg" onClick={() => setConfirmRun(true)} disabled={busy}>
            Run safety test
          </Btn>
        ) : (
          s && <Badge glyph="i">Tests run on testnet only. On mainnet this page shows recorded results.</Badge>
        )}
        {paused ? (
          <Btn onClick={() => setQr(true)}>Resume on owner device</Btn>
        ) : (
          <Btn kind="danger" onClick={kill}>
            Pause trading
          </Btn>
        )}
      </div>

      {hskPaused && !running && run?.attacks.some((a) => a.attack === "paused" && a.status === "reverted") && (
        <section className="card" style={{ marginTop: 20, padding: "14px 18px", background: "var(--bg3)" }} aria-label="Vault paused">
          <b>Vault-HSK is paused.</b> The last attack needed it. Unpause on your owner device to trade HSK again.
        </section>
      )}

      {run && (
        <div style={{ marginTop: 26 }}>
          <button className="disclose" aria-expanded={showList || running} onClick={() => setShowList(!showList)}>
            <span aria-hidden="true">{showList || running ? "▾" : "▸"}</span> {showList || running ? "Hide the 7 attacks" : "Show the 7 attacks"}
          </button>
          {(showList || running) && (
            <div style={{ marginTop: 8 }}>
              {attacks.map((a, i) => (
                <div key={a.attack} className="act">
                  <div style={{ display: "grid", gridTemplateColumns: "26px minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "12px 4px" }}>
                    <span className="b7 num">{i + 1}</span>
                    <div>
                      <div className="sm b7">{ATTACKS[a.attack].name}</div>
                      <div className="xs fg2">
                        {a.status === "reverted" ? `Stopped: ${ATTACKS[a.attack].stops.toLowerCase()}` : a.note ? a.note.slice(0, 140) : `Should stop: ${ATTACKS[a.attack].stops.toLowerCase()}`}
                        {details && a.decoded && <span className="mono"> · {prettyError(a.decoded, a.attack)}</span>}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <StatusBadge a={a} />
                      {a.txHash && (
                        <div className="xs" style={{ marginTop: 4 }}>
                          <Link href={`${s!.explorer}/tx/${a.txHash}`} mono title={a.txHash}>
                            {short(a.txHash, 6, 4)}
                          </Link>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {running && run.log.length > 0 && (
                <div className="logbox" style={{ marginTop: 14, maxHeight: 220, overflow: "auto" }} aria-label="Live log">
                  {run.log.slice(-14).map((l, i) => (
                    <div key={i}>
                      {new Date(l.at * 1000).toTimeString().slice(0, 8)} {l.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <button className="disclose" aria-expanded={details} onClick={() => setDetails(!details)}>
          <span aria-hidden="true">{details ? "▾" : "▸"}</span> {details ? "Hide details" : "Show details"}
        </button>
      </div>
      {details && s && (
        <div style={{ marginTop: 10 }}>
          <section className="card" style={{ padding: "14px 20px" }} aria-label="Pause history">
            <header className="ch">
              <h2 className="h4">Pauses</h2>
              <span className="xs fg2">{s.pauses.length} on-chain</span>
            </header>
            {s.pauses.length === 0 && <div className="sm fg2">No pause yet.</div>}
            {s.pauses.slice(0, 8).map((e) => (
              <PauseRow key={e.txHash + e.kind} e={e} explorer={s.explorer} />
            ))}
          </section>
          <section className="card" style={{ padding: "14px 20px", marginTop: 14 }} aria-label="How it works">
            <div className="sm" style={{ lineHeight: 1.55 }}>
              The test signs with the <b>agent key</b>, the same key the trader uses, with fixed gas and no pre-check, so each refusal lands on-chain. Two attacks cannot be sent at all: routing through another pool (the vault has no pool parameter) and changing limits with stolen app access (there is no owner key on this Mac).
            </div>
            <div className="kv sm" style={{ marginTop: 10 }}>
              <span className="k">Vault</span>
              <span className="v mono">{s.target.vault ? short(s.target.vault, 6, 4) : "—"}</span>
            </div>
            <div className="kv sm">
              <span className="k">Agent key</span>
              <span className="v mono">{s.target.agent ? short(s.target.agent, 6, 4) : "—"}</span>
            </div>
            <div className="kv sm">
              <span className="k">Guardian</span>
              <span className="v mono">{s.target.guardian ? short(s.target.guardian, 6, 4) : "—"}</span>
            </div>
            {mode === "pro" && run && (
              <div className="kv sm">
                <span className="k">Run</span>
                <span className="v num">
                  {run.source === "app" ? "from this app" : "from the journal"} · {run.finishedAt ? dur(run.startedAt, run.finishedAt) : "running"} · {MARKETS[run.market].label}
                </span>
              </div>
            )}
            <div className="row g10" style={{ marginTop: 12 }}>
              <Btn size="sm" onClick={exportRun} disabled={!run}>
                Export evidence
              </Btn>
              <Link href="https://flowverse.cloud/proof">flowverse.cloud/proof</Link>
            </div>
          </section>
        </div>
      )}

      <Dialog
        open={confirmRun}
        onClose={() => setConfirmRun(false)}
        eyebrow="Safety test · testnet"
        title="Attack your vault?"
        footer={
          <>
            <span className="xs fg2 grow">Uses a little testnet gas from the agent key.</span>
            <Btn onClick={() => setConfirmRun(false)}>Cancel</Btn>
            <Btn kind="pri" onClick={() => void start()} data-autofocus>
              Run safety test
            </Btn>
          </>
        }
      >
        <div className="sm" style={{ lineHeight: 1.6 }}>
          Seven attacks are sent to Vault-HSK with the agent's own key. Each one should fail on-chain. It takes a few minutes, mostly waiting out the vault's cooldown. New HSK trades wait until it ends.
          <br />
          The last attack needs the vault paused: when it is reached, pause it from your guardian device.
        </div>
      </Dialog>
      <Dialog open={qr} onClose={() => setQr(false)} eyebrow="Owner device" title="Resume trading" footer={<Btn onClick={() => setQr(false)}>Done</Btn>}>
        <div className="sm" style={{ marginBottom: 12 }}>Scan with your owner wallet to unpause the vaults. Only the owner can unpause.</div>
        {vsOk?.status.vaults
          .filter((v) => v.paused)
          .map((v) => (
            <div key={v.address} className="row g16" style={{ alignItems: "center", marginTop: 8 }}>
              <QR data={`ethereum:${v.address}@${vsOk.status.chainId}/unpause`} size={120} label={`Unpause ${MARKETS[v.market].label}`} />
              <div className="sm">
                <b>{MARKETS[v.market].label}</b>
                <div className="mono xs">{v.address}</div>
              </div>
            </div>
          ))}
      </Dialog>
    </div>
  );
}

function StatusBadge({ a }: { a: ProofAttack }) {
  if (a.status === "reverted") return <Badge tone="ok">stopped</Badge>;
  if (a.status === "running") return <Badge tone="warn" glyph="◌">trying</Badge>;
  if (a.status === "queued") return <Badge glyph="·">next</Badge>;
  if (a.status === "skipped") return <Badge glyph="–">skipped</Badge>;
  return <Badge tone="bad">{a.status === "aborted" ? "aborted" : "not stopped"}</Badge>;
}

function PauseRow({ e, explorer }: { e: PauseEvent; explorer: string }) {
  const who = e.role === "guardian" ? "Guardian" : e.role === "owner" ? "Owner" : e.role === "agent" ? "Agent" : short(e.by, 6, 4);
  const mk = e.market ? MARKETS[e.market].label : "vault";
  return (
    <div className="kv sm">
      <span className="k">{e.at ? when(e.at) : `block ${e.blockNumber}`}</span>
      <span className="v">
        {who} {e.kind} {mk} ·{" "}
        <Link href={`${explorer}/tx/${e.txHash}`} mono title={e.txHash}>
          {short(e.txHash, 6, 4)}
        </Link>
      </span>
    </div>
  );
}
