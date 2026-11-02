// In-UI approval of a loosening strategy change (§11.5). The renderer only names the changeId; main rebuilds the
// payload from the daemon's pending change and signs it with ate-approve (Touch ID), or forwards an 8-digit code
// printed on the daemon's own terminal (§10.1 armed fallback).
import { useState } from "react";
import { useApp } from "./app";
import { Badge, ErrorBox } from "./ui";

export function LooseningApproval({ changeId, renderedDiff, onApplied }: { changeId: string; renderedDiff?: string; onApplied?: () => void }) {
  const { ate, toast, refresh } = useApp();
  const [busy, setBusy] = useState<"sign" | "code" | null>(null);
  const [code, setCode] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string; hint?: string } | null>(null);

  async function approve(withCode: boolean) {
    setBusy(withCode ? "code" : "sign");
    setError(null);
    const r = await ate.strategy.approve(changeId, withCode ? code.trim() : undefined);
    setBusy(null);
    if (r.ok) {
      setDone(r.data.decisionId);
      toast({ kind: "ok", text: `Strategy change applied (${r.data.decisionId})` });
      refresh();
      onApplied?.();
    } else setError({ code: r.error.code, message: r.error.message, ...(r.error.hint ? { hint: r.error.hint } : {}) });
  }

  if (done) {
    return (
      <div className="notice" role="status">
        <Badge tone="ok">approved</Badge> Applied, journal <span className="mono">{done}</span>
      </div>
    );
  }
  return (
    <div className="notice warn" role="alertdialog" aria-label="Approve loosening change">
      <div><Badge tone="warn">Touch ID required</Badge> This change loosens risk limits. <span className="mono small muted">{changeId}</span></div>
      {renderedDiff && <pre className="raw">{renderedDiff}</pre>}
      <div className="actions">
        <button className="btn primary" disabled={!!busy} onClick={() => void approve(false)}>{busy === "sign" ? "Waiting for Touch ID…" : "Approve with Touch ID"}</button>
      </div>
      <form className="composer" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void approve(true); }}>
        <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="or the 8-digit code from the daemon's terminal" aria-label="TTY code" inputMode="numeric" />
        <button className="btn" type="submit" disabled={!!busy || code.length !== 8}>{busy === "code" ? "Sending…" : "Use code"}</button>
      </form>
      <p className="small muted">Pending changes expire after 60 s; re-issue the change if it lapses.</p>
      {error && <ErrorBox {...error} />}
    </div>
  );
}

/** Daemon-issued changeIds quoted in an agent reply (chat turns run in the daemon; only the text reaches main). */
export const changeIdsIn = (text: string): string[] => [...new Set(text.match(/\bchg_[0-9a-f]{16}\b/g) ?? [])];
