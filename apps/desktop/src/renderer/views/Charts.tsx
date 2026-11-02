// Charts (⋯ menu, lane D4): the user's pinned charts in a two-column grid with a linked crosshair. Pins come from
// Ask ("Pin") or "Add chart" presets. Each chart keeps its own timeframe and indicators; "Trade this" opens
// Trade on that market with the order panel.
import { useState } from "react";
import type { ChartInput } from "@ate/core";
import { ChartCard, CrosshairLink, PRESETS, addPin, useChart, usePins, type Pin } from "../src/charts";
import { PageHead, useNav } from "../src/shell";
import { Btn, Dialog } from "../src/ui";
import type { ViewProps } from "./registry";

const TRADEABLE = new Set(["price", "cex", "spread", "depth", "oracle", "volume"]);

function PinnedChart({ pin, wide, first, last }: { pin: Pin; wide: boolean; first: boolean; last: boolean }) {
  const { remove, update, move } = usePins();
  const go = useNav();
  const { spec, error, busy, retry } = useChart(pin.input);
  const label = pin.input.market?.includes("WBTC") ? "BTC" : "HSK";
  const actions = (
    <>
      {TRADEABLE.has(pin.input.kind) && (
        <button className="lnk" onClick={() => go(`trade/${label.toLowerCase()}/order`)}>
          Trade {label}
        </button>
      )}
      {!first && (
        <button className="lnk ico" title="Move earlier" aria-label="Move earlier" onClick={() => move(pin.id, -1)}>
          ←
        </button>
      )}
      {!last && (
        <button className="lnk ico" title="Move later" aria-label="Move later" onClick={() => move(pin.id, 1)}>
          →
        </button>
      )}
      <button className="lnk" onClick={() => remove(pin.id)}>
        Remove
      </button>
    </>
  );
  return (
    <div className={wide ? "cg-wide" : ""}>
      {spec ? (
        <ChartCard spec={spec} height={wide ? 300 : 220} busy={busy} actions={actions} onChange={(i: ChartInput) => update(pin.id, i)} />
      ) : (
        <section className="chcard chload" style={{ minHeight: wide ? 360 : 280 }}>
          <header className="chh">
            <div>
              <h3>{PRESETS.find((p) => JSON.stringify(p.input) === JSON.stringify(pin.input))?.name ?? "Chart"}</h3>
              <p className="chcap">{error ? `Could not load this chart. ${error}` : busy ? "Loading…" : ""}</p>
              {error && !busy && (
                <button className="lnk" onClick={retry}>
                  Try again
                </button>
              )}
            </div>
            <div className="chact">{actions}</div>
          </header>
        </section>
      )}
    </div>
  );
}

export default function Charts(_: ViewProps) {
  const { pins } = usePins();
  const go = useNav();
  const [adding, setAdding] = useState(false);
  return (
    <div className="page1 charts-page">
      <PageHead title="Charts" sub="Charts you pinned. Ask the agent for any other chart." acts={<Btn kind="pri" onClick={() => setAdding(true)}>Add chart</Btn>} />
      {pins.length === 0 ? (
        <section className="chempty-big">
          <h3>No charts yet</h3>
          <p>Add one here, or ask the agent: "show me the HSK price this week".</p>
          <div className="row">
            <Btn kind="pri" onClick={() => setAdding(true)}>
              Add chart
            </Btn>
            <Btn onClick={() => go("ask")}>Ask the agent</Btn>
          </div>
        </section>
      ) : (
        <CrosshairLink>
          <div className="cgrid">
            {pins.map((p, i) => (
              <PinnedChart key={p.id} pin={p} wide={i === 0} first={i === 0} last={i === pins.length - 1} />
            ))}
          </div>
        </CrosshairLink>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a chart" width={560}>
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className="preset"
              onClick={() => {
                addPin(p.input);
                setAdding(false);
              }}
            >
              <b>{p.name}</b>
              <span>{p.sub}</span>
            </button>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
