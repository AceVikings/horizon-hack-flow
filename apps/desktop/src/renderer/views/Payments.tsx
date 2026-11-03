// 80 Payments (Flow v1): HSP payments are not live — HSP needs merchant access that only the hackathon organizers can
// grant. Visible, greyed out, no actions, no numbers (FLOW.md screen 80).
import type { ViewProps } from "./registry";

export default function Payments(_: ViewProps) {
  return (
    <>
      <div className="ph">
        <div>
          <h1 style={{ opacity: 0.45 }}>Payments</h1>
          <div className="sub">Agent-to-agent payments over HSP</div>
        </div>
        <div className="acts">
          <span className="sm fg2">Not connected</span>
        </div>
      </div>
      <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
        <section className="card" style={{ width: 620, maxWidth: "100%", padding: "36px 40px", textAlign: "center", borderStyle: "dashed" }} aria-label="Connect HSP">
          <div className="disp" style={{ fontSize: 54, opacity: 0.5 }}>
            Connect HSP
          </div>
          <p className="fg2" style={{ marginTop: 16, fontSize: 14, lineHeight: 1.6 }}>
            Your trader will be able to buy premium signals from other agents and settle through the HashKey Settlement Protocol, with a signed mandate for every payment. It never sits on the trade path.
          </p>
          <div style={{ marginTop: 24 }}>
            <button type="button" className="btn lg dis" disabled aria-disabled="true" title="HSP needs merchant access from the organizers">
              Connect HSP · needs organizer access
            </button>
          </div>
          <div className="xs fg2" style={{ marginTop: 14 }}>
            Not live in this build: HSP needs merchant access that only the organizers can grant. The payment code is tested on recorded responses; no payment has been made.
          </div>
        </section>
      </div>
    </>
  );
}
