// Touch ID approval for changes that raise risk, with the one-time-code fallback when Touch ID (ate-approve) is not set
// up on this Mac: the daemon's armed fallback issues a code for the pending change, D2's main process hands it to the
// app (`setup.strategyCode(changeId)`), the user types it, and `strategy.approve(changeId, code)` applies the change.
import { useState } from "react";
import type { AteBridge, Res } from "@shared/bridge";
import { Btn } from "../src/ui";
import { CodeInput, CodeShow } from "./setup/common";

type CodeRes = { code: string; expiresAt: number } | null;

/** Ask the app for the pending change's one-time code (null when none was issued). */
async function codeFor(ate: AteBridge, changeId: string): Promise<CodeRes> {
  const fn = (ate.setup as unknown as { strategyCode?: (id: string) => Promise<Res<CodeRes> | CodeRes> } | undefined)?.strategyCode;
  if (!fn) return null;
  const r = await fn(changeId).catch(() => null);
  if (!r) return null;
  if ("ok" in r) return r.ok ? r.data : null;
  return r;
}

export type ApproveOutcome = { done: true } | { done: false; code: CodeRes; message: string };

/** Touch ID first; if it is unavailable, fetch the fallback code for the caller to show. */
export async function approveRiskier(ate: AteBridge, changeId: string): Promise<ApproveOutcome> {
  const r = await ate.strategy.approve(changeId);
  if (r.ok) return { done: true };
  const code = await codeFor(ate, changeId);
  return { done: false, code, message: code ? "Touch ID isn't set up on this Mac. Type this one-time code to approve." : r.error.message };
}

/** Inline code entry shown under a pending change when Touch ID is unavailable. */
export function CodeApprove({ ate, changeId, code, onDone }: { ate: AteBridge; changeId: string; code: CodeRes; onDone(ok: boolean, message?: string): void }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!/^\d{8}$/.test(v)) return;
    setBusy(true);
    const r = await ate.strategy.approve(changeId, v);
    setBusy(false);
    onDone(r.ok, r.ok ? undefined : r.error.message);
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div className="sm">Touch ID isn't set up on this Mac. Type this one-time code to approve:</div>
      <div style={{ marginTop: 8, maxWidth: 360 }}>
        <CodeShow code={code?.code} />
      </div>
      <div className="row g10" style={{ marginTop: 8, maxWidth: 420, alignItems: "center" }}>
        <CodeInput value={v} onChange={setV} onSubmit={() => void submit()} autoFocus />
        <Btn kind="pri" disabled={busy || !/^\d{8}$/.test(v)} onClick={() => void submit()}>
          Approve
        </Btn>
      </div>
    </div>
  );
}
