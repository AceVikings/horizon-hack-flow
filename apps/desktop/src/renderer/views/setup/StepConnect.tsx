// Setup 1 · Connect (SIMPLIFY.md): network, the vaults (Flow creates them through its managed owner service; no
// manual signing), the agent key, connected to the vaults automatically. Technical facts sit behind "Show details"; deploy-new and key import
// behind "Advanced".
import { useEffect, useState } from "react";
import { MARKETS, type MarketId } from "@ate/core";
import { short } from "../../src/format";
import { AddrLink, Btn } from "../../src/ui";
import { Details, ErrLine, Section, Spinner, StatusText, Wizard, go, useOwner, useSetup, useSetupGet } from "./common";

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
              {n ? <StatusText tone={n.ok ? "ok" : "bad"}>{n.ok ? `${n.ms} ms` : "offline"}</StatusText> : <span className="xs fg2">…</span>}
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

function VaultsPart({ chainId, confirmed, onConfirmed }: { chainId: number; confirmed: boolean; onConfirmed(): void }) {
  const s = useSetup();
  const owner = useOwner();
  const v = useSetupGet<Vaults>("/setup/vaults");
  const [mine, setMine] = useState(confirmed);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const d = v.data;
  const use = async (body: Record<string, unknown>) => {
    setError(null);
    const r = await s.post("/setup/vaults", body);
    if (!r.ok) return setError(r.error);
    onConfirmed();
  };
  const create = async () => {
    if (!owner) return;
    setBusy("Creating your vaults on chain… this takes about a minute.");
    setError(null);
    const r = await owner.createVaults();
    if (!r.ok) {
      setBusy(null);
      return setError(r.error);
    }
    await use({ source: "deploy", vaults: r.data.vaults });
    setBusy(null);
  };
  const healthy = !!d && d.found > 0 && d.ownerMatches && d.vaults.every((x) => !x.error);
  const existing = d && d.found > 0 && (
    <>
      <div className="col" style={{ gap: 8, marginTop: 14 }}>
        {d.vaults.map((x) => (
          <div key={x.address} className="row g12 hx" style={{ padding: "12px 14px" }}>
            <span className="h3">{pair(x.market)}</span>
            <span className="grow" />
            {x.error ? <StatusText tone="bad">not a vault</StatusText> : x.paused ? <StatusText tone="warn">paused</StatusText> : <StatusText tone="ok">ready</StatusText>}
          </div>
        ))}
      </div>
      <div className="sm" style={{ marginTop: 14 }}>
        Owned by <span className="mono b7">{d.owner ? short(d.owner, 6, 4) : "different wallets"}</span>.
      </div>
      <label className="row g10 sm" style={{ cursor: "pointer", marginTop: 8 }}>
        <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} style={{ width: 18, height: 18, accentColor: "#171e19" }} />
        This is my wallet
      </label>
      {!confirmed && (
        <Btn kind="solid" disabled={!healthy || !mine || !!busy} onClick={() => void use({ source: "deployment" })} style={{ marginTop: 12 }}>
          Use these vaults
        </Btn>
      )}
      <Details>
        {d.vaults.map((x) => (
          <div key={x.address} style={{ marginBottom: 10 }}>
            <div className="kv sm"><span className="k">Vault-{x.market.includes("WBTC") ? "BTC" : "HSK"}</span><span className="v"><AddrLink addr={x.address} full /></span></div>
            <div className="row g12" style={{ flexWrap: "wrap", marginTop: 6 }}>
              <StatusText tone={x.verified ? "ok" : "warn"}>{x.verified ? "verified source" : "source not verified"}</StatusText>
              {x.pool && <StatusText tone={x.poolPinned ? "ok" : "warn"}>pool {short(x.pool, 6, 4)}</StatusText>}
              {x.limits && <StatusText>{usd(x.limits.maxTradeUsdE8)} a trade · {usd(x.limits.maxEpochUsdE8)} a day · {usd(x.limits.maxExposureUsdE8)} held</StatusText>}
            </div>
          </div>
        ))}
      </Details>
    </>
  );
  return (
    <Section title="Your vaults" done={confirmed} sub="Each vault holds your funds and checks every trade.">
      {v.loading && !d && <div style={{ marginTop: 12 }}><Spinner label="Reading the vaults from the chain…" /></div>}
      {owner ? (
        <>
          {!confirmed && (
            <>
              <p className="sm" style={{ marginTop: 10 }}>Flow will create your vaults. Nothing to sign.</p>
              <Btn kind="pri" size="lg" disabled={!!busy} onClick={() => void create()} style={{ marginTop: 12 }}>Create my vaults</Btn>
            </>
          )}
          {busy && <div style={{ marginTop: 12 }}><Spinner label={busy} /></div>}
          {existing && !confirmed && <Details summary="Use vaults I already have">{existing}</Details>}
          {confirmed && existing}
        </>
      ) : d && d.found > 0 ? (
        existing
      ) : (
        d && <p className="sm fg2" style={{ marginTop: 10 }}>No vaults on this network yet. Flow creates them once vault creation is available in this build.</p>
      )}
      <ErrLine error={error} />
    </Section>
  );
}

function AgentPart({ enabled }: { enabled: boolean }) {
  const s = useSetup();
  const owner = useOwner();
  const a = useSetupGet<Agent>("/setup/agent", { every: 5000, skip: !enabled });
  const d = a.data;
  const [pk, setPk] = useState("");
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
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
  // With Flow-managed owner signing, the key is connected to the vaults automatically.
  useEffect(() => {
    if (!owner || !d?.exists || !d.address || linked || linking) return;
    setLinking(true);
    void owner.setAgent(d.address).then((r) => {
      if (!r.ok) setError(r.error);
      a.reload();
    });
  }, [owner, d, linked, linking, a]);
  return (
    <Section title="Agent key" done={linked} sub="The agent signs trades from this Mac. It can trade and pause. It can never withdraw.">
      {!enabled ? (
        <p className="sm fg2" style={{ marginTop: 8 }}>Connect your vaults first.</p>
      ) : !d ? (
        <div style={{ marginTop: 12 }}><Spinner label="Reading the keystore…" /></div>
      ) : !d.exists ? (
        <>
          <Btn kind="pri" size="lg" disabled={busy} onClick={() => void create()} style={{ marginTop: 14 }}>{busy ? "Working…" : "Create the key"}</Btn>
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
            <StatusText tone={d.unlocked ? "ok" : "warn"}>{d.unlocked ? "unlocked" : "locked"}</StatusText>
          </div>
          <div className="col" style={{ gap: 6, marginTop: 12 }}>
            {d.vaults.map((v) => (
              <div key={v.address} className="row g10 sm">
                <span className={v.matches ? "gl-ok" : "gl-run"} aria-hidden="true">{v.matches ? "✓" : ""}</span>
                {pair(v.market as MarketId)} {v.matches ? "accepts this key" : owner ? "is being connected…" : "waits for its owner to accept this key"}
              </div>
            ))}
          </div>
          {!linked && !owner && <p className="xs fg2" style={{ marginTop: 10 }}>These vaults are owned outside Flow. Their owner must make this key the agent; Flow sees it here as soon as it happens.</p>}
        </>
      )}
      <ErrLine error={error} />
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
    <Wizard step={1} chainId={chainId} shot={ready ? "01-connect-done" : confirmed ? "01b-connect-key" : "01-connect"} hint="Nothing to sign in this step." next={() => void next()} nextDisabled={!ready} busy={busy}>
      <div className="stepno">Step 1 of 3</div>
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
