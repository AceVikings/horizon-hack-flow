// Setup 1 · Connect (SIMPLIFY.md): network, the vaults (owner confirmed by QR on the owner device), the agent key
// (Touch ID) and the owner's setAgent by QR. Technical facts sit behind "Show details"; deploy-new and key import
// behind "Advanced".
import { useEffect, useState } from "react";
import { MARKETS, type MarketId } from "@ate/core";
import { short } from "../../src/format";
import { AddrLink, Badge, Btn, QR } from "../../src/ui";
import { Details, ErrLine, HandoffDialog, Section, Spinner, TxQR, Wizard, go, useHandoff, useSetup, useSetupGet } from "./common";

interface Net {
  chainId: 133 | 177;
  rpc: string;
  ms: number | null;
  block: string | null;
  ok: boolean;
  explorer: string;
  deployment: { vaults: number; owner: string | null } | null;
  current: boolean;
}
interface VaultRow {
  market: MarketId;
  address: string;
  verified: boolean | null;
  owner?: string;
  agent?: string;
  paused?: boolean;
  pool?: string;
  poolPinned?: boolean;
  supraPair?: number | null;
  limits?: { maxTradeUsdE8: string; maxEpochUsdE8: string; maxExposureUsdE8: string };
  error?: string;
}
interface Vaults {
  found: number;
  vaults: VaultRow[];
  owner: string | null;
  ownerMatches: boolean;
  ownerIsContract: boolean;
}
interface Status {
  chainId: number;
  state: { vaultsConfirmedAt: number | null };
  vaults: { market: MarketId; address: string }[];
}
interface Agent {
  exists: boolean;
  address: string | null;
  unlocked: boolean;
  vaults: { market: string; address: string; agent: string | null; matches: boolean }[];
}

const usd = (e8?: string) => (e8 ? `$${(Number(BigInt(e8)) / 1e8).toFixed(0)}` : "—");
const pair = (m: MarketId) => `${MARKETS[m].base}/${MARKETS[m].quote}`;

function Network({ chainId, onBusy }: { chainId: number; onBusy(b: boolean): void }) {
  const s = useSetup();
  const nets = useSetupGet<Net[]>("/setup/networks");
  const [error, setError] = useState<{ message: string } | null>(null);
  const pick = async (id: 133 | 177) => {
    if (id === chainId) return;
    onBusy(true);
    setError(null);
    const r = await s.post("/setup/network", { chainId: id });
    onBusy(false);
    if (!r.ok) return setError(r.error);
    location.reload();
  };
  return (
    <Section title="Network" sub="Practice with test money first. You can switch later.">
      <div className="grid" role="radiogroup" aria-label="Network" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
        {([133, 177] as const).map((id) => {
          const n = nets.data?.find((x) => x.chainId === id);
          const on = chainId === id;
          return (
            <button key={id} role="radio" aria-checked={on} className={`optrow${on ? " on" : ""}`} onClick={() => void pick(id)}>
              <span className={`radio${on ? " on" : ""}`} aria-hidden="true" />
              <span className="grow">
                <b>{id === 133 ? "Testnet" : "Mainnet"}</b>
                <span className="xs fg2" style={{ display: "block" }}>{id === 133 ? "Free test tokens. Start here." : "Real money."}</span>
              </span>
              {n ? <Badge tone={n.ok ? "ok" : "bad"}>{n.ok ? `${n.ms} ms` : "offline"}</Badge> : <span className="xs fg2">…</span>}
            </button>
          );
        })}
      </div>
      <Details>
        {nets.data?.map((n) => (
          <div key={n.chainId} className="kv sm">
            <span className="k">Chain {n.chainId}</span>
            <span className="v mono">
              {n.rpc} · block {n.block ? Number(n.block).toLocaleString("en-US") : "—"} · {n.explorer.replace("https://", "")}
            </span>
          </div>
        ))}
      </Details>
      <ErrLine error={error} />
    </Section>
  );
}

function Deploy({ chainId, onDeployed }: { chainId: number; onDeployed(vaults: { market: MarketId; address: string }[]): void }) {
  const s = useSetup();
  const [owner, setOwner] = useState("");
  const ho = useHandoff((h, p) => {
    if (p.done && h.predicted) onDeployed(h.predicted.map((address, i) => ({ market: (["hsk-dex:WHSK/USDT:3000", "hsk-dex:WBTC/USDT:3000"] as MarketId[])[i]!, address })));
  });
  const valid = /^0x[0-9a-fA-F]{40}$/.test(owner);
  return (
    <div>
      <p className="sm fg2">Flow builds the transactions. Your owner wallet sends them and pays the gas.</p>
      <div className="row g12" style={{ marginTop: 10 }}>
        <input className="textin" placeholder="Owner wallet address (0x…)" aria-label="Owner address" value={owner} onChange={(e) => setOwner(e.target.value.trim())} />
        <Btn kind="solid" disabled={!valid || ho.busy} onClick={() => void ho.start({ kind: "deploy", owner })}>Build</Btn>
      </div>
      <ErrLine error={ho.error} />
      {ho.handoff && (
        <div style={{ marginTop: 14 }}>
          <div className="row sb">
            <span className="sm b7">Send these {ho.handoff.txs.length} transactions in order.</span>
            <Btn size="sm" onClick={() => void s.saveJson(`flow-deploy-${chainId}.json`, { chainId, from: owner, transactions: ho.handoff!.txs.map((t) => ({ to: t.to, value: t.value, data: t.data, label: t.label })) })}>Export bundle</Btn>
          </div>
          <div className="col" style={{ gap: 10, marginTop: 10 }}>
            {ho.handoff.txs.map((t, i) => (
              <TxQR key={i} tx={t} size={110} landed={i < (ho.handoff!.predicted?.length ?? 0) ? ho.poll?.results[i]?.done : undefined} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function VaultsPart({ chainId, confirmed, onConfirmed }: { chainId: number; confirmed: boolean; onConfirmed(): void }) {
  const s = useSetup();
  const v = useSetupGet<Vaults>("/setup/vaults");
  const [mine, setMine] = useState(confirmed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  const d = v.data;
  const use = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const r = await s.post("/setup/vaults", body);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onConfirmed();
  };
  const healthy = !!d && d.found > 0 && d.ownerMatches && d.vaults.every((x) => !x.error);
  return (
    <Section
      title="Your vaults"
      done={confirmed}
      sub={d?.found ? `We found ${d.found} vault${d.found > 1 ? "s" : ""}. Each one holds funds and checks every trade.` : "Each vault holds funds and checks every trade."}
    >
      {v.loading && !d && <div style={{ marginTop: 12 }}><Spinner label="Reading the vaults from the chain…" /></div>}
      {d && d.found > 0 && (
        <>
          <div className="col" style={{ gap: 8, marginTop: 14 }}>
            {d.vaults.map((x) => (
              <div key={x.address} className="row g12 hx" style={{ padding: "12px 14px" }}>
                <span className="h3">{pair(x.market)}</span>
                <span className="grow" />
                {x.error ? <Badge tone="bad">not a vault</Badge> : x.paused ? <Badge tone="warn">paused</Badge> : <Badge tone="ok">ready</Badge>}
              </div>
            ))}
          </div>
          <div className="row g18 top" style={{ marginTop: 16 }}>
            {d.owner && <QR data={`ethereum:${d.owner}@${chainId}`} size={112} label="Owner address QR" />}
            <div className="col g8" style={{ gap: 8 }}>
              <div className="sm">
                Owned by <span className="mono b7">{d.owner ? short(d.owner, 6, 4) : "different wallets"}</span>.
              </div>
              <div className="xs fg2">Scan with your owner wallet. It should show your own address. Flow never asks for the owner key.</div>
              <label className="row g10 sm" style={{ cursor: "pointer", marginTop: 4 }}>
                <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} style={{ width: 18, height: 18, accentColor: "#171e19" }} />
                This is my wallet
              </label>
              {!confirmed && (
                <Btn kind="solid" disabled={!healthy || !mine || busy} onClick={() => void use({ source: "deployment" })} style={{ alignSelf: "flex-start" }}>
                  {busy ? "Connecting…" : "Use these vaults"}
                </Btn>
              )}
            </div>
          </div>
          <Details>
            {d.vaults.map((x) => (
              <div key={x.address} style={{ marginBottom: 10 }}>
                <div className="kv sm"><span className="k">Vault-{x.market.includes("WBTC") ? "BTC" : "HSK"}</span><span className="v"><AddrLink addr={x.address} full /></span></div>
                <div className="row g6" style={{ flexWrap: "wrap", marginTop: 6 }}>
                  <Badge tone={x.verified ? "ok" : "warn"}>{x.verified ? "verified source" : "source not verified"}</Badge>
                  {x.pool && <Badge tone={x.poolPinned ? "ok" : "warn"}>pool {short(x.pool, 6, 4)}</Badge>}
                  {x.supraPair !== undefined && x.supraPair !== null && <Badge>Supra pair {x.supraPair}</Badge>}
                  {x.limits && <Badge>{usd(x.limits.maxTradeUsdE8)} trade · {usd(x.limits.maxEpochUsdE8)}/day · {usd(x.limits.maxExposureUsdE8)} held</Badge>}
                </div>
              </div>
            ))}
            <div className="xs fg2">Owner is {d.ownerIsContract ? "a Safe (contract)" : "a plain wallet: fine on testnet, use a Safe or hardware wallet on mainnet"}.</div>
          </Details>
        </>
      )}
      {d && d.found === 0 && <p className="sm fg2" style={{ marginTop: 10 }}>No vaults are known for this network yet. Deploy your own below.</p>}
      <Details summary="Advanced: deploy new vaults" open={d?.found === 0}>
        <Deploy chainId={chainId} onDeployed={(vs) => void use({ source: "deploy", vaults: vs })} />
      </Details>
      <ErrLine error={error} />
    </Section>
  );
}

function AgentPart({ enabled }: { enabled: boolean }) {
  const s = useSetup();
  const a = useSetupGet<Agent>("/setup/agent", { every: 5000, skip: !enabled });
  const d = a.data;
  const [pk, setPk] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [qr, setQr] = useState(false);
  const create = async (privateKey?: string) => {
    setBusy(true);
    setError(null);
    const r = await s.keygen(privateKey);
    setPk("");
    setBusy(false);
    if (!r.ok) return setError(r.error);
    a.reload();
  };
  const linked = !!d?.exists && d.vaults.every((v) => v.matches);
  return (
    <Section title="Agent key" done={linked} sub="The agent signs trades from this Mac. It can trade and pause. It can never withdraw.">
      {!enabled ? (
        <p className="sm fg2" style={{ marginTop: 8 }}>Connect your vaults first.</p>
      ) : !d ? (
        <div style={{ marginTop: 12 }}><Spinner label="Reading the keystore…" /></div>
      ) : !d.exists ? (
        <>
          <Btn kind="pri" size="lg" disabled={busy} onClick={() => void create()} style={{ marginTop: 14 }}>{busy ? "Working…" : "Create the key with Touch ID"}</Btn>
          <Details summary="Advanced: use an existing key">
            <div className="row g12">
              <input className="textin" type="password" autoComplete="off" spellCheck={false} placeholder="Private key (0x…)" aria-label="Agent private key" value={pk} onChange={(e) => setPk(e.target.value)} />
              <Btn kind="solid" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(pk.trim())} onClick={() => void create(pk.trim())}>Import</Btn>
            </div>
            <div className="xs fg2" style={{ marginTop: 6 }}>Encrypted at once and kept on this Mac.</div>
          </Details>
        </>
      ) : (
        <>
          <div className="row g12" style={{ marginTop: 12 }}>
            <span className="mono sm">{d.address}</span>
            <Badge tone={d.unlocked ? "ok" : "warn"}>{d.unlocked ? "unlocked" : "locked"}</Badge>
          </div>
          <div className="col" style={{ gap: 6, marginTop: 12 }}>
            {d.vaults.map((v) => (
              <div key={v.address} className="row g10 sm">
                <span className={v.matches ? "gl-ok" : "gl-run"} aria-hidden="true">{v.matches ? "✓" : ""}</span>
                {pair(v.market as MarketId)} {v.matches ? "accepts this key" : "waits for your owner wallet"}
              </div>
            ))}
          </div>
          {!linked && (
            <Btn kind="pri" size="lg" style={{ marginTop: 14 }} onClick={() => setQr(true)}>Approve on owner wallet</Btn>
          )}
        </>
      )}
      <ErrLine error={error} />
      <HandoffDialog
        open={qr}
        onClose={() => setQr(false)}
        title="Approve the agent"
        intro="Scan each code with your owner wallet. Flow reads the result back from the chain."
        body={qr ? { kind: "setAgent" } : null}
        onDone={() => a.reload()}
      />
    </Section>
  );
}

export default function StepConnect() {
  const s = useSetup();
  const st = useSetupGet<Status>("/setup/status");
  const chainId = st.data?.chainId ?? 133;
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (st.data?.state.vaultsConfirmedAt) setConfirmed(true);
  }, [st.data]);
  const agent = useSetupGet<Agent>("/setup/agent", { every: 5000, skip: !confirmed });
  const ready = confirmed && !!agent.data?.exists && agent.data.vaults.every((v) => v.matches);
  const next = async () => {
    await s.post("/setup/state", { step: 2 });
    go("setup/2");
  };
  return (
    <Wizard step={1} chainId={chainId} shot={ready ? "01-connect-done" : confirmed ? "01b-connect-key" : "01-connect"} hint="Nothing leaves your owner wallet in this step." next={() => void next()} nextDisabled={!ready} busy={busy}>
      <div className="eb">Step 1 of 3</div>
      <h1>
        Connect <span className="hl">Flow</span>
      </h1>
      <p className="lead">Pick a network, confirm your vaults, and create the agent's key.</p>
      <Network chainId={chainId} onBusy={setBusy} />
      <VaultsPart chainId={chainId} confirmed={confirmed} onConfirmed={() => (setConfirmed(true), st.reload())} />
      <AgentPart enabled={confirmed} />
    </Wizard>
  );
}
