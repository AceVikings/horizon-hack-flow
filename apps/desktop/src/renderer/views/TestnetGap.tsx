// Testnet (chain 133) only: the test pools have no arbitrageurs, so they sit on the oracle and the agent never sees
// an opportunity. This moves the test pool off the oracle price (or back) with a separate market-maker key, so a
// trade can fire during a demo. Hidden on any other chain and when the daemon has no market-maker key.
import { useState } from "react";
import { MARKETS, type MarketId } from "@ate/core";
import { useApp, useRemote } from "../src/app";
import { Btn } from "../src/ui";
import { explorer } from "../src/format";

/** The pool 1.5% under the oracle: above the ~0.6% round-trip cost, inside the vault's 2.5% oracle-deviation limit. */
const STAGE_BPS = -150;

export function TestnetGap({ market }: { market: MarketId }) {
  const { ate, vsOk, toast, refresh } = useApp();
  const st = useRemote(() => (ate.testnet ? ate.testnet.pool() : Promise.resolve({ ok: false as const, error: { code: "ATE_INTERNAL" as never, message: "off" } })), [], { every: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  if (!ate.testnet || vsOk?.status.chainId !== 133) return null;
  const d = st.last;
  if (!d?.available) return null;
  const label = MARKETS[market].label;
  const key = label.toLowerCase() === "btc" ? "btc" : "hsk";
  const gap = d.pools.find((p) => p.market === market)?.gapBps ?? null;
  const move = async (offsetBps: number) => {
    setBusy(offsetBps === 0 ? "Putting the pool back on the oracle price…" : "Moving the test pool… about 15 seconds.");
    const r = await ate.testnet!.move(key, offsetBps);
    setBusy(null);
    if (!r.ok) return toast({ kind: "error", text: "Couldn't move the test pool", sub: r.error.message });
    const last = r.data.txs.at(-1);
    toast({
      kind: "ok",
      text: offsetBps === 0 ? `${label} pool is back on the oracle price` : `${label} pool is now ${(Math.abs(offsetBps) / 100).toFixed(2)}% under the oracle`,
      sub: "Testnet only",
      ...(last ? { href: explorer.tx(last), hrefLabel: last } : {}),
    });
    st.reload();
    refresh();
  };
  return (
    <section className="card soft tight" style={{ borderStyle: "dashed" }} aria-label="Testnet price gap">
      <div className="row g10" style={{ flexWrap: "wrap" }}>
        <span className="b7">Testnet: price gap</span>
        {gap !== null && <span className="xs fg2">{label} pool is {Math.abs(gap) < 5 ? "on" : `${(Math.abs(gap) / 100).toFixed(2)}% ${gap < 0 ? "under" : "over"}`} the oracle price</span>}
        <span className="grow" />
        <Btn kind="solid" disabled={!!busy} onClick={() => void move(STAGE_BPS)}>Create a price gap (testnet)</Btn>
        <Btn disabled={!!busy || (gap !== null && Math.abs(gap) < 5)} onClick={() => void move(0)}>Restore price</Btn>
      </div>
      <p className="xs fg2" style={{ marginTop: 8 }}>
        {busy ?? "Testnet pools have no arbitrageurs. This moves the test pool so the agent has something to trade."}
      </p>
    </section>
  );
}
