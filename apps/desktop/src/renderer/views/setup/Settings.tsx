// Settings (⋯ menu, docs/design/flow 90, simplified per SIMPLIFY.md): network, agent key, AI account, approvals and
// the daemon. Technical fields (RPCs, oracle refresh, auto-lock) sit under "Advanced"; saving them is signed with
// Touch ID (ate-approve) or the daemon's one-time code, then the daemon restarts with the new config.
import { useEffect, useState } from "react";
import type { DaemonState } from "@shared/setup-bridge";
import { useApp } from "../../src/app";
import { PageHead } from "../../src/shell";
import {Btn, QR} from "../../src/ui";
import { Details, ErrLine, Section, Spinner, go, netLabel, useApproval, useOwner, useSetup, useSetupGet, StatusText } from "./common";

interface Cfg {
  chainId: number;
  network: string;
  rpcs: { url: string; role: string; ms: number | null; ok: boolean; error: string | null }[];
  oracleRefreshSec: number | null;
  oracleMaxAgeSec: number;
  supra: { market: string; ageSec: number | null }[];
  autoLockMinutes: number;
  approval: { touchId: boolean; keyId: string | null; fallback: { mode: string; enabled: boolean } | null; windowSec: number };
  agent: { keyId: string; exists: boolean; address: string | null; store: string; unlocked: boolean };
  journal: { records: number | null };
}

const hm = (sec: number) => (sec >= 3600 ? `${Math.round(sec / 360) / 10} h` : `${Math.round(sec / 60)} min`);
const asset = (m: string) => (m.includes("WBTC") ? "BTC" : "HSK");

export default function Settings() {
  const s = useSetup();
  const { ate } = useApp();
  const c = useSetupGet<Cfg>("/setup/config");
  const d = c.data;
  const ap = useApproval();
  const [daemon, setDaemon] = useState<DaemonState | null>(null);
  const [rpcs, setRpcs] = useState<string[] | null>(null);
  const [refreshH, setRefreshH] = useState<number | null>(null);
  const [lockMin, setLockMin] = useState<number | null>(null);
  const [newRpc, setNewRpc] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [gas, setGas] = useState(false);
  const owner = useOwner();
  const [aiLabel, setAiLabel] = useState<string | null>(null);
  useEffect(() => {
    void s.daemon().then((x) => setDaemon(x as DaemonState));
    void ate.ai?.health().then((r) => r.ok && setAiLabel(`${r.data.modelLabel} · ${r.data.credential === "none" ? "not connected" : "connected"}`));
  }, [s, ate]);
  useEffect(() => {
    if (!d) return;
    setRpcs(d.rpcs.map((r) => r.url));
    setRefreshH(d.oracleRefreshSec ? d.oracleRefreshSec / 3600 : null);
    setLockMin(d.autoLockMinutes);
  }, [d]);

  const changes: { key: string; after: unknown; text: string }[] = [];
  if (d && rpcs && JSON.stringify(rpcs) !== JSON.stringify(d.rpcs.map((r) => r.url))) changes.push({ key: "chain.rpcUrls", after: rpcs, text: `RPCs: ${rpcs.length}` });
  if (d?.oracleRefreshSec && refreshH !== null && Math.round(refreshH * 3600) !== d.oracleRefreshSec) changes.push({ key: "supra.pull.refreshAgeSec", after: Math.round(refreshH * 3600), text: `price refresh ${hm(d.oracleRefreshSec)} → ${refreshH} h` });
  if (d && lockMin !== null && lockMin !== d.autoLockMinutes) changes.push({ key: "daemon.autoLockMinutes", after: lockMin, text: `auto-lock ${d.autoLockMinutes} → ${lockMin} min` });

  const save = async () => {
    setError(null);
    const r = await s.post("/setup/config", { changes: changes.map(({ key, after }) => ({ key, after })) });
    if (!r.ok) return setError(r.error);
    setSaved(true);
    c.reload();
  };
  const discard = () => {
    if (!d) return;
    setRpcs(d.rpcs.map((r) => r.url));
    setRefreshH(d.oracleRefreshSec ? d.oracleRefreshSec / 3600 : null);
    setLockMin(d.autoLockMinutes);
  };
  const switchNet = async () => {
    const to = d?.chainId === 133 ? 177 : 133;
    const r = await s.post("/setup/network", { chainId: to });
    if (!r.ok) return setError(r.error);
    go("unlock");
  };
  const touch = d?.approval.touchId;

  return (
    <div className="sw-col" data-shot="settings" style={{ paddingTop: 10 }}>
      <PageHead title="Settings" sub="Changes save right away." />
      {!d ? (
        c.res?.ok === false ? <ErrLine error={c.res.error} /> : <Spinner label="Loading settings…" />
      ) : (
        <>
          <Section title="Network" sub="Each network keeps its own vaults, agent key and history." right={<span className="stx">{netLabel(d.chainId)}</span>}>
            <Btn size="sm" style={{ marginTop: 12 }} onClick={() => void switchNet()}>Switch to {d.chainId === 133 ? "mainnet" : "testnet"}</Btn>
          </Section>

          <Section title="Agent key" sub="Signs trades from this Mac. It can never withdraw.">
            {d.agent.exists ? (
              <>
                <div className="row g10" style={{ marginTop: 10 }}>
                  <span className="mono sm">{d.agent.address}</span>
                  <StatusText tone={d.agent.unlocked ? "ok" : "warn"}>{d.agent.unlocked ? "unlocked" : "locked"}</StatusText>
                </div>
                <div className="row g8" style={{ marginTop: 12 }}>
                  {!d.agent.unlocked && <Btn size="sm" kind="solid" onClick={() => void s.unlock().then(() => c.reload())}>Unlock</Btn>}
                  <Btn size="sm" onClick={() => setGas((x) => !x)}>Top up gas</Btn>
                  {owner && <Btn size="sm" onClick={() => void owner.unpause().then((r) => (r.ok ? c.reload() : setError(r.error)))}>Resume the vaults</Btn>}
                </div>
                {gas && d.agent.address && (
                  <div className="row g18 top" style={{ marginTop: 12 }}>
                    <QR data={`ethereum:${d.agent.address}@${d.chainId}`} size={110} label="Agent address QR" />
                    <div className="xs fg2">Send HSK to this address from any wallet.{d.chainId === 133 && <> <button className="linkbtn" onClick={() => void s.open("https://faucet.hsk.xyz/faucet")}>Free test HSK ↗</button></>}</div>
                  </div>
                )}
                <Details>
                  <div className="kv sm"><span className="k">Key id</span><span className="v mono">{d.agent.keyId}</span></div>
                  <div className="kv sm"><span className="k">Stored in</span><span className="v">{d.agent.store === "keychain" ? "macOS keychain" : "encrypted file"}</span></div>
                  <div className="xs fg2" style={{ marginTop: 8 }}>Lost this Mac? Restore your Flow wallet from its backup and set a new agent; the old agent key loses all rights.</div>
                </Details>
              </>
            ) : (
              <Btn size="sm" kind="solid" style={{ marginTop: 10 }} onClick={() => go("setup/1")}>Create the agent key</Btn>
            )}
          </Section>

          <Section title="AI account" sub={aiLabel ?? "The AI the agent thinks with."} right={<Btn size="sm" onClick={() => go("accounts")}>Manage accounts</Btn>} />

          <Section title="Approvals" sub={`Flow asks for ${touch ? "Touch ID" : "a one-time code"} only to loosen limits, approve payments, or replace or remove a saved key.`}>
            <Details>
              <div className="kv sm"><span className="k">Method</span><span className="v">{touch ? `Touch ID · key ${d.approval.keyId ?? ""}` : "One-time code (single use, 60 s)"}</span></div>
              <div className="kv sm"><span className="k">Approval window</span><span className="v">{d.approval.windowSec} s</span></div>
            </Details>
          </Section>

          <Section
            title="Flow service"
            sub={daemon ? `${daemon.phase === "ready" ? "Running" : daemon.phase} · ${daemon.owned ? "managed by Flow" : "started outside Flow"}` : "…"}
            right={
              <span className="row g8">
                <Btn size="sm" onClick={() => void s.start().then((x) => (setDaemon(x as DaemonState), go("unlock")))}>Restart</Btn>
                <Btn size="sm" kind="ghost" onClick={() => void s.stop().then((x) => setDaemon(x as DaemonState))}>Stop</Btn>
              </span>
            }
          >
            <Details>
              <div className="kv sm"><span className="k">Data folder</span><span className="v mono">{daemon?.home}</span></div>
              <div className="kv sm"><span className="k">Journal</span><span className="v">{d.journal.records ?? "—"} records</span></div>
            </Details>
          </Section>

          <Details summary="Advanced">
            <Section title="RPC endpoints" sub="The first one is used; the rest are fallbacks.">
              {rpcs?.map((u, i) => {
                const p = d.rpcs.find((r) => r.url === u);
                return (
                  <div key={u} className="kv sm">
                    <span className="k mono">{u.replace("https://", "")}</span>
                    <span className="v">
                      {i === 0 ? "primary" : "fallback"} · {p ? (p.ok ? `${p.ms} ms` : "down") : <StatusText y glyph="">new</StatusText>}{" "}
                      {rpcs.length > 1 && <button className="linkbtn xs" onClick={() => setRpcs(rpcs.filter((x) => x !== u))}>remove</button>}
                    </span>
                  </div>
                );
              })}
              <div className="row g8" style={{ marginTop: 10 }}>
                <input className="textin" placeholder="https://…" aria-label="Add an RPC URL" value={newRpc} onChange={(e) => setNewRpc(e.target.value)} />
                <Btn size="sm" disabled={!/^https:\/\/\S+$/.test(newRpc) || rpcs?.includes(newRpc)} onClick={() => (setRpcs([...(rpcs ?? []), newRpc.trim()]), setNewRpc(""))}>Add</Btn>
              </div>
            </Section>
            <Section title="Price refresh" sub="Flow refreshes the Supra price when it gets older than this.">
              {refreshH !== null && (
                <div className="row g12" style={{ marginTop: 10 }}>
                  <select className="textin" style={{ width: 160 }} aria-label="Refresh threshold" value={refreshH} onChange={(e) => setRefreshH(Number(e.target.value))}>
                    {[1, 2, 3, 6, 12, 18, 24].filter((h) => h * 3600 < d.oracleMaxAgeSec).map((h) => (
                      <option key={h} value={h}>{h} h</option>
                    ))}
                  </select>
                  <span className="xs fg2">{d.supra.map((x) => `${asset(x.market)} now ${x.ageSec === null ? "—" : hm(x.ageSec)} old`).join(" · ")}</span>
                </div>
              )}
            </Section>
            <Section title="Auto-lock" sub="The agent key locks itself after this long.">
              {lockMin !== null && (
                <select className="textin" style={{ width: 160, marginTop: 10 }} aria-label="Auto-lock" value={lockMin} onChange={(e) => setLockMin(Number(e.target.value))}>
                  {[...new Set([15, 60, 240, 480, 720, 1440, d.autoLockMinutes])].sort((a, b) => a - b).map((m) => (
                    <option key={m} value={m}>{m >= 60 ? `${m / 60} h` : `${m} min`}</option>
                  ))}
                </select>
              )}
            </Section>
          </Details>

          {changes.length > 0 && (
            <div className="sw-acts" role="region" aria-label="Unsaved changes">
              <StatusText y glyph="">{changes.length} unsaved</StatusText>
              <span className="hint">{changes.map((x) => x.text).join(" · ")}</span>
              <span className="grow" />
              <Btn kind="ghost" onClick={discard}>Discard</Btn>
              <Btn kind="pri" size="lg" disabled={ap.busy} onClick={() => void save()}>Save</Btn>
            </div>
          )}
          {saved && !changes.length && <p className="sm" role="status" style={{ marginTop: 14 }}>Saved. The daemon restarted with the new settings.</p>}
          <ErrLine error={error} />
        </>
      )}
      {ap.dialog}
    </div>
  );
}
