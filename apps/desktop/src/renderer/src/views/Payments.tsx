import { useApp, useRemote } from "../app";
import { ContextPanel, Inspector } from "../shell";
import { Badge, Card, Empty, ErrorBox, KV, TxLink, type Tone } from "../ui";
import { ago, usd } from "../format";

// SPEC §9.4 happy path + terminal states
const FLOW = ["CREATED", "PREPARED", "SIGN_APPROVED", "SIGNED", "AUTH_FINALIZED", "SUBMIT_APPROVED", "SUBMITTED", "SAFE", "SETTLED"] as const;
const TERMINAL: Record<string, Tone> = { SETTLED: "ok", SETTLED_UNATTRIBUTED: "warn", FAILED: "bad", EXPIRED: "warn", UNCERTAIN: "warn" };

export default function Payments() {
  const { ate } = useApp();
  const { res } = useRemote(() => ate.payments.list(), [], { every: 10000 });
  if (res && !res.ok) return <ErrorBox {...res.error} />;
  const gate = res?.ok ? res.data.gate : "no-go";
  const rows = res?.ok ? res.data.rows : [];
  return (
    <>
      <ContextPanel>
        <h2>HSP gate (G-HSP)</h2>
        <Badge tone={gate === "go" ? "ok" : "warn"}>{gate === "go" ? "live" : "no-go: built, not live"}</Badge>
        <p className="small muted">The payment leg is built and tested on recorded responses. Live use needs the HSP QA allowlist. It never sits on the trade path: a payment cannot block or alter a trade.</p>
        <h2>Policy (enforced in ate-pay)</h2>
        <KV k="daily cap">$1.00</KV>
        <KV k="two approvals">signed, digest-bound</KV>
      </ContextPanel>

      {gate === "no-go" && <div className="notice warn" role="status"><Badge tone="warn">G-HSP no-go</Badge> Payments are not live. The state machine below is the built flow; rows below are recorded responses.</div>}

      <Card title="Settlement state machine">
        <ol className="flow">
          {FLOW.map((s) => <li key={s}><span className="st">{s}</span></li>)}
        </ol>
        <p className="small muted">Side exits: <code>FAILED(denied)</code> on approval denial or 120 s timeout, <code>EXPIRED</code> on error 30043 or quote expiry, <code>UNCERTAIN</code> on submit timeout or after 10 min with no result (reconciled every 60 s), <code>SETTLED_UNATTRIBUTED</code> when finalized without attribution (terminal, not evidence).</p>
      </Card>

      <Card title="Mandates">
        {rows.length === 0 ? <Empty title="No payments">No mandate has been created. The agent has not bought a signal.</Empty> : (
          <table className="tbl"><thead><tr><th>Payment</th><th>Offer</th><th className="r">Amount</th><th>Position</th><th>State</th><th>When</th></tr></thead><tbody>
            {rows.map((r) => {
              const idx = FLOW.indexOf(r.state as (typeof FLOW)[number]);
              return (
                <tr key={r.paymentId}>
                  <td className="mono">{r.paymentId}<div className="small muted">payTo {r.payTo}</div></td>
                  <td className="mono small">{r.offerId}</td>
                  <td className="r num">{usd(r.amountUsd)}</td>
                  <td><div className="pos" aria-label={`step ${idx + 1} of ${FLOW.length}`}>{FLOW.map((s, i) => <span key={s} className={`pip ${i <= idx ? "on" : ""}`} title={s} />)}</div><span className="small muted">{idx >= 0 ? `${idx + 1} / ${FLOW.length}` : r.state}</span></td>
                  <td><Badge tone={TERMINAL[r.state] ?? "info"}>{r.state}</Badge>{r.gatewayTx && <div className="small">gateway <TxLink hash={r.gatewayTx} /></div>}</td>
                  <td className="num">{ago(r.at)}</td>
                </tr>
              );
            })}
          </tbody></table>
        )}
      </Card>
      <Inspector>
        <h2>Approval dialog</h2>
        <p className="small muted">When a mandate needs approval, the full preview (amount, token, payTo, chainId, digest) shows here and Touch ID prompts from the same payload. Nothing is pending.</p>
      </Inspector>
    </>
  );
}
