// Wallet: the two wallets Flow made for the user and the money in the vaults. The owner (Flow-managed, its own
// process) holds the vaults Flow created and is the only key that can withdraw them (vaults from "I already have
// vaults" are owned by another wallet: Withdraw is off for those, with the reason); the agent only trades and pays gas. Withdraw,
// gas top-up and the key backup are owner ops that raise risk, so main runs Touch ID before the owner service acts.
import { useEffect, useState } from "react";
import type { ViewProps } from "./registry";
import { useApp } from "../src/app";
import { PageHead } from "../src/shell";
import { Btn, Dialog, QR } from "../src/ui";
import { short } from "../src/format";
import { ErrLine, NoTouchIdNote, Section, Spinner, StatusText, useOwner, useSetup, useSetupGet, useVaultOwnership } from "./setup/common";
import { foreignOwnerLine } from "./setup/ownership";
import { VaultsPart, type Fund } from "./WalletVaults";
import { copyText } from "../src/copy";

type Err = { message: string } | null;

const hsk = (v: string | null | undefined) => (v == null ? "…" : `${Number(v).toFixed(Number(v) < 0.01 && Number(v) > 0 ? 4 : 3)} HSK`);

/** "1.5" with `dec` decimals → base units string; null when not a positive number. */
export function toUnits(v: string, dec: number): string | null {
  if (!/^\d*\.?\d*$/.test(v) || !(Number(v) > 0)) return null;
  const [w, f = ""] = v.split(".");
  return (BigInt(w || "0") * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0")).toString();
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="linkbtn sm" onClick={() => void copyText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}>
      {done ? "Copied" : label}
    </button>
  );
}

export default function Wallet(_: ViewProps) {
  const owner = useOwner();
  const s = useSetup();
  const { toast } = useApp();
  const f = useSetupGet<Fund>("/setup/fund", { every: 10_000 });
  const [o, setO] = useState<{ address: string | null; chainId: number; gasHsk?: string | null } | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!owner) return;
    void owner.status().then((r) => r.ok && setO(r.data));
  }, [owner, n]);
  const reload = () => (setN((x) => x + 1), f.reload());
  const d = f.data;
  const chainId = d?.chainId ?? o?.chainId ?? 133;
  const faucet = d?.hskFaucet ?? (chainId === 133 ? "https://faucet.hsk.xyz/faucet" : null);
  const ownerGas = Number(o?.gasHsk ?? 0);
  // Vaults from "I already have vaults" are owned by another wallet (the deployer), not the Flow wallet.
  const own = useVaultOwnership();
  const foreignLine = foreignOwnerLine(own.foreign);

  return (
    <div className="sw-col" data-shot="wallet" style={{ paddingTop: 10 }}>
      <PageHead title="Wallet" sub="Your money, and the two wallets Flow made for you." />
      <NoTouchIdNote />
      {!owner ? (
        <p className="sm fg2" style={{ marginTop: 10 }}>This build has no Flow wallet. Your vaults are owned outside Flow.</p>
      ) : (
        <>
          <Section title="Your Flow wallet" sub={foreignLine ? "Flow created this wallet for you. It does not own these vaults. It never trades." : "Flow created this wallet for you. It owns your vaults and is the only key that can withdraw. It never trades."}>
            {!o?.address ? (
              <div style={{ marginTop: 12 }}><Spinner label="Starting your wallet…" /></div>
            ) : (
              <div className="row g18 top" style={{ marginTop: 14 }}>
                <QR data={`ethereum:${o.address}@${chainId}`} size={120} label="Flow wallet address QR" />
                <div className="col" style={{ gap: 8, minWidth: 0 }}>
                  <div className="row g10 base">
                    <span className="big">{hsk(o.gasHsk)}</span>
                    <span className="sm fg2">for gas</span>
                  </div>
                  <div className="row g10">
                    <span className="mono sm" style={{ wordBreak: "break-all" }}>{o.address}</span>
                    <Copy text={o.address} />
                  </div>
                  {ownerGas < 0.01 && <StatusText tone="warn">Needs a little HSK to send transactions. Send some to this address.</StatusText>}
                  {chainId === 133 && faucet && (
                    <button className="linkbtn sm" style={{ alignSelf: "flex-start" }} onClick={() => void s.open(faucet)}>Get free test HSK ↗</button>
                  )}
                </div>
              </div>
            )}
          </Section>

          <AgentPart d={d} reload={reload} toast={toast} ownerGas={ownerGas} />
          <VaultsPart fund={d} ownerAddr={o?.address ?? null} own={own} reload={reload} />
          <BackupPart foreign={!!foreignLine} />
        </>
      )}
    </div>
  );
}

type ToastFn = ReturnType<typeof useApp>["toast"];

function AgentPart({ d, reload, toast, ownerGas }: { d: Fund | null; reload(): void; toast: ToastFn; ownerGas: number }) {
  const owner = useOwner()!;
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState("0.05");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  const a = d?.agent;
  const low = Number(a?.hsk ?? 0) < (d?.chainId === 133 ? 0.01 : 2);
  const send = async () => {
    const wei = toUnits(amt, 18);
    if (!wei || !owner.fundAgent) return;
    setBusy(true);
    setError(null);
    const r = await owner.fundAgent(wei);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setOpen(false);
    toast({ kind: "ok", text: `Sent ${amt} HSK to the agent` });
    reload();
  };
  return (
    <Section title="Agent" sub="Trades inside your limits and pays gas. It can never withdraw.">
      {!d ? (
        <div style={{ marginTop: 12 }}><Spinner label="Reading balances…" /></div>
      ) : !a ? (
        <p className="sm fg2" style={{ marginTop: 10 }}>No agent key yet. Setup creates it.</p>
      ) : (
        <>
          <div className="row g12" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <span className="mono sm">{a.address}</span>
            <Copy text={a.address} />
            <span className="grow" />
            <StatusText tone={low ? "warn" : "ok"}>{hsk(a.hsk)} for gas</StatusText>
            {owner.fundAgent && !open && <Btn size="sm" onClick={() => setOpen(true)}>Top up gas</Btn>}
          </div>
          {open && (
            <div className="hx" style={{ marginTop: 12 }}>
              <div className="row g12">
                <input className="textin" style={{ width: 140 }} aria-label="HSK to send" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
                <span className="sm">HSK from your Flow wallet</span>
                <span className="grow" />
                <Btn kind="solid" size="sm" disabled={busy || !toUnits(amt, 18) || Number(amt) > ownerGas} onClick={() => void send()}>{busy ? "Waiting for Touch ID…" : "Send"}</Btn>
                <button className="linkbtn sm" onClick={() => setOpen(false)}>Cancel</button>
              </div>
              <div className="xs fg2" style={{ marginTop: 8 }}>
                {Number(amt) > ownerGas ? "Your Flow wallet does not have that much HSK." : "Touch ID confirms it."}
              </div>
            </div>
          )}
        </>
      )}
      <ErrLine error={error} />
    </Section>
  );
}

function BackupPart({ foreign }: { foreign: boolean }) {
  const owner = useOwner()!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  const [key, setKey] = useState<{ address: string; privateKey: string } | null>(null);
  if (!owner.exportKey) return null;
  const show = async () => {
    setBusy(true);
    setError(null);
    const r = await owner.exportKey!();
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setKey(r.data);
  };
  return (
    <Section title="Back up your Flow wallet" sub={foreign ? "Keep a copy of its key somewhere safe." : "Keep a copy of its key somewhere safe. With it you can reach your vaults from any wallet app."}>
      <Btn size="sm" style={{ marginTop: 12 }} disabled={busy} onClick={() => void show()}>{busy ? "Waiting for Touch ID…" : "Show the key"}</Btn>
      <div className="xs fg2" style={{ marginTop: 6 }}>Touch ID first. Flow shows it once.</div>
      <ErrLine error={error} />
      <Dialog
        open={!!key}
        onClose={() => setKey(null)}
        dismissable={false}
        eyebrow="Your Flow wallet"
        title="Save this key"
        width={600}
        footer={
          <>
            <span className="grow" />
            <Btn kind="pri" size="lg" onClick={() => setKey(null)}>I saved it</Btn>
          </>
        }
      >
        <p className="sm"><b>{foreign ? "Anyone with this key controls your Flow wallet." : "Anyone with this key can take everything in your vaults."}</b></p>
        <p className="sm fg2" style={{ marginTop: 6 }}>Write it down or keep it in a password manager. Never paste it into a website or a chat.</p>
        <div className="hx mono sm" style={{ marginTop: 14, wordBreak: "break-all", userSelect: "text" }} aria-label="Owner private key">{key?.privateKey}</div>
        <div className="row g12" style={{ marginTop: 10 }}>
          <span className="xs fg2">Address {key ? short(key.address, 6, 4) : ""}</span>
          <span className="grow" />
          {key && <Copy text={key.privateKey} label="Copy the key" />}
        </div>
      </Dialog>
    </Section>
  );
}
