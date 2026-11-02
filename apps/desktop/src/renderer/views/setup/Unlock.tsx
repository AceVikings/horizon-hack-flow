// Daemon gate (lane D2): the app starts its own daemon, attaches with Touch ID or the daemon's one-time code shown
// here, unlocks the agent key, then routes to the setup step to resume or to Overview.
import { useEffect, useState } from "react";
import type { DaemonState } from "@shared/setup-bridge";
import { Badge, Btn } from "../../src/ui";
import { CodeInput, CodeShow, ErrLine, Lights, Logo, Spinner, go, useSetup } from "./common";

const PHASE: Record<DaemonState["phase"], string> = {
  starting: "Starting the Flow daemon…",
  attaching: "Connecting to the daemon…",
  code: "Confirm this Mac",
  unlocking: "Unlocking the agent key…",
  ready: "Ready",
  stopped: "The daemon is stopped",
  error: "The daemon needs attention",
};

export default function Unlock() {
  const s = useSetup();
  const [st, setSt] = useState<DaemonState | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const tick = () => void s.daemon().then((d) => live && setSt(d as DaemonState));
    tick();
    const iv = setInterval(tick, 700);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [s]);
  const locked = st?.phase === "ready" && st.agent?.exists && !st.agent.unlocked;
  useEffect(() => {
    if (!st || st.phase !== "ready" || locked) return;
    if (st.setupDone) go("home");
    else if (!st.setupStep) go("welcome");
    else go(`setup/${Math.min(3, st.setupStep)}`);
  }, [st, locked]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await s.submitCode(code);
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const unlock = async () => {
    setBusy(true);
    setError(null);
    const r = await s.unlock();
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const shot = st?.phase === "code" ? "00b-unlock-code" : locked ? "00c-unlock-key" : "00a-unlock";
  return (
    <div className="unlock" data-shot={st ? shot : undefined}>
      <div className="box">
        <Lights />
        <Logo size={48} />
        <div className="eb" style={{ color: "var(--sage)", marginTop: 34 }}>
          {st?.owned === false ? "Attached to a running daemon" : "Daemon managed by Flow"} · {st?.home ?? ""}
        </div>
        <h1 className="disp" style={{ fontSize: 64, margin: "16px 0 0" }}>{locked ? "Unlock the agent key" : PHASE[st?.phase ?? "starting"]}</h1>
        {!st || ["starting", "attaching", "unlocking"].includes(st.phase) ? (
          <div style={{ marginTop: 24 }}>
            <Spinner label={st?.detail || "one moment"} />
          </div>
        ) : null}
        {st?.phase === "code" && (
          <div style={{ marginTop: 18 }}>
            <p className="sm" style={{ color: "var(--sage)", lineHeight: 1.55 }}>
              Touch ID approval is not installed on this Mac, so the daemon issued a single-use code that only this app can read. Type it to let this window control Flow. It expires in 60 seconds.
            </p>
            <CodeShow code={st.code?.code} />
            <CodeInput value={code} onChange={setCode} onSubmit={() => void submit()} autoFocus />
            <div className="row g10" style={{ marginTop: 14 }}>
              <span className="grow" />
              <Btn kind="pri" size="lg" disabled={code.length !== 8 || busy} onClick={() => void submit()}>
                Approve
              </Btn>
            </div>
          </div>
        )}
        {locked && (
          <div style={{ marginTop: 18 }}>
            <p className="sm" style={{ color: "var(--sage)" }}>
              Agent <span className="mono">{st?.agent?.address}</span> is locked. {st?.touchId.unlock ? "Touch ID releases its passphrase from the keychain." : "Its passphrase is sealed in your login keychain."}
            </p>
            <div className="row g10" style={{ marginTop: 18 }}>
              <Btn kind="pri" size="lg" disabled={busy} onClick={() => void unlock()}>
                {st?.touchId.unlock ? "Unlock with Touch ID" : "Unlock"}
              </Btn>
              <Btn kind="ghost" onClick={() => go("home")}>Continue read-only</Btn>
            </div>
          </div>
        )}
        {(st?.phase === "error" || st?.phase === "stopped") && (
          <div style={{ marginTop: 18 }}>
            <p className="sm mono" style={{ color: "var(--sage)" }}>{st.detail}</p>
            <div className="row g10" style={{ marginTop: 14 }}>
              <Btn kind="pri" size="lg" disabled={busy} onClick={() => (setBusy(true), void s.start().finally(() => setBusy(false)))}>
                Start the daemon
              </Btn>
            </div>
          </div>
        )}
        <ErrLine error={error} />
        <div className="row g8" style={{ marginTop: 30 }}>
          <Badge tone={st?.touchId.approve ? "ok" : "mute"}>Touch ID approvals {st?.touchId.approve ? "on" : "off · one-time codes"}</Badge>
          {st?.pid && <Badge>pid {st.pid}</Badge>}
        </div>
      </div>
    </div>
  );
}
