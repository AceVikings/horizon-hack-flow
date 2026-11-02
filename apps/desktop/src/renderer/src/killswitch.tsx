// 11 · Kill switch confirm. Pausing signs `pause()` on both vaults with the agent key via the daemon (ate_pause);
// "go to cash first" sets targetAssets = [] (tightening: the guard sells with no AI cycle), waits for the vaults to
// be flat, then pauses. Hold 1.5 s to fire.
import { useState } from "react";
import { MARKETS } from "@ate/core";
import { useApp } from "./app";
import { explorer, label, money } from "./format";
import { Btn, Check, Choice, Dialog, HoldButton } from "./ui";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function KillSwitchDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { ate, vsOk, refresh, toast } = useApp();
  const [mode, setMode] = useState<"now" | "cash">("now");
  const [busy, setBusy] = useState<string | null>(null);
  const pos = vsOk?.positions.markets ?? [];
  const held = pos.filter((p) => Number(p.exposureUsd) > 0.005);
  const total = held.reduce((a, p) => a + Number(p.exposureUsd), 0);
  const alreadyPaused = vsOk?.status.vaults.length ? vsOk.status.vaults.every((v) => v.paused) : false;

  const pause = async () => {
    setBusy("Signing pause() on both vaults…");
    const r = await ate.vaults.pause();
    setBusy(null);
    if (!r.ok) {
      toast({ kind: "error", text: `Pause failed: ${r.error.code}`, sub: r.error.message });
      return;
    }
    for (const v of r.data.vaults)
      toast({ kind: "ok", text: `Vault-${label(v.market)} ${v.status === "already_paused" ? "was already paused" : "paused"}`, sub: "pause() signed by the agent key", ...(v.status === "submitted" ? { href: explorer.tx(v.txHash), hrefLabel: v.txHash } : {}) });
    refresh();
    onClose();
  };

  const cashThenPause = async () => {
    setBusy("Guard is selling to cash…");
    const r = await ate.strategy.set({ targetAssets: [] }, "Kill switch: go to cash, then pause both vaults (desktop)");
    if (!r.ok) {
      setBusy(null);
      toast({ kind: "error", text: `Go to cash failed: ${r.error.code}`, sub: r.error.message });
      return;
    }
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const s = await ate.vaults.status();
      if (s.ok && s.data.positions.markets.every((p) => Number(p.exposureUsd) < 0.01)) break;
      setBusy(`Guard is selling to cash… ${(i + 1) * 5} s`);
    }
    await pause();
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      dismissable={!busy}
      eyebrow="Kill switch · both vaults"
      title={
        <>
          Pause both <span className="hl red">vaults?</span>
        </>
      }
      footer={
        <>
          <span className="xs fg2 grow" role="status">{busy ?? "Signed with the agent key on this Mac"}</span>
          <Btn onClick={onClose} disabled={!!busy} data-autofocus>
            Cancel
          </Btn>
          <HoldButton className="danger lg" onHold={() => void (mode === "now" ? pause() : cashThenPause())} disabled={!!busy || alreadyPaused} holdingLabel="Keep holding…">
            {alreadyPaused ? "Already paused" : "Hold to pause"}
          </HoldButton>
        </>
      }
    >
      <Check state="ok">
        Every new trade is refused on-chain, whoever holds the key.
      </Check>
      <Check state="ok">The trader stops proposing. Chat stays read-only.</Check>
      <Check state="warn">
        <b>Stop-loss exits stop too.</b>{" "}
        {held.length ? (
          <>
            {money(total)} of tokens ({held.map((p) => `${MARKETS[p.market].base} ${money(Number(p.exposureUsd))}`).join(", ")}) will be unprotected.
          </>
        ) : (
          "Both vaults hold only USDT right now."
        )}
      </Check>
      <Check state="warn">Only your owner device can unpause (QR handoff).</Check>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }} role="radiogroup" aria-label="How to pause">
        <Choice name="ks" checked={mode === "now"} onChange={() => setMode("now")} title="Pause now" sub="2 txs · ~4 s" />
        <Choice name="ks" checked={mode === "cash"} onChange={() => setMode("cash")} title="Go to cash, then pause" sub="guard sells first · ~1 min" />
      </div>
    </Dialog>
  );
}
