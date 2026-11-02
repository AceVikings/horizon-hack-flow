// Sign in to the Flow cloud app: passkey first, password as the fallback. After a password sign-in without a passkey,
// the user adds one (approvals of risky changes in the cloud need it).
import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { addPasskey, setCsrf } from "./bridge";

const box: React.CSSProperties = { maxWidth: 380, margin: "16vh auto 0", padding: "0 24px", font: "15px/1.5 system-ui, sans-serif", color: "#171e19" };
const btn = (pri: boolean): React.CSSProperties => ({ width: "100%", border: 0, borderRadius: 10, padding: "12px 16px", font: "600 15px system-ui", cursor: "pointer", marginTop: 12, background: pri ? "#171e19" : "#e9e6dc", color: pri ? "#fff" : "#171e19" });

async function post(path: string, body: unknown) {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, j: (await r.json().catch(() => ({}))) as { csrf?: string; error?: string; flow?: string; options?: never } };
}

export default function Login({ passkeys, password }: { passkeys: number; password: boolean }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState(false);
  const withPasskey = async () => {
    setErr(null);
    setBusy(true);
    try {
      const o = await post("/auth/passkey/options", {});
      const response = await startAuthentication({ optionsJSON: o.j.options! });
      const r = await post("/auth/passkey/login", { flow: o.j.flow, response });
      if (!r.ok) throw new Error(r.j.error ?? "sign-in failed");
      location.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withPassword = async () => {
    setErr(null);
    setBusy(true);
    const r = await post("/auth/password", { password: pw });
    setBusy(false);
    if (!r.ok) return setErr(r.j.error ?? "sign-in failed");
    setCsrf(r.j.csrf ?? "");
    if (passkeys === 0) setOffer(true);
    else location.reload();
  };
  const add = async () => {
    setErr(null);
    setBusy(true);
    const r = await addPasskey();
    setBusy(false);
    if (!r.ok) return setErr(r.message ?? "could not add the passkey");
    location.reload();
  };
  return (
    <div style={box}>
      <h1 style={{ fontSize: 40, margin: "0 0 6px", letterSpacing: -0.5 }}>Flow</h1>
      {offer ? (
        <>
          <p>Add a passkey. You will use it to sign in and to approve changes that raise risk.</p>
          <button style={btn(true)} disabled={busy} onClick={() => void add()}>Add a passkey</button>
          <button style={btn(false)} disabled={busy} onClick={() => location.reload()}>Later</button>
        </>
      ) : (
        <>
          {passkeys > 0 && <button style={btn(true)} disabled={busy} onClick={() => void withPasskey()}>Sign in with a passkey</button>}
          {password && (
            <form onSubmit={(e) => (e.preventDefault(), void withPassword())} style={{ marginTop: passkeys > 0 ? 22 : 12 }}>
              <input type="password" autoComplete="current-password" aria-label="Password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} style={{ width: "100%", boxSizing: "border-box", padding: "11px 12px", borderRadius: 10, border: "1px solid #cfcabb", font: "15px system-ui" }} />
              <button type="submit" style={btn(passkeys === 0)} disabled={busy || pw.length === 0}>Sign in</button>
            </form>
          )}
        </>
      )}
      {err && <p role="alert" style={{ color: "#a33", marginTop: 14 }}>{err}</p>}
    </div>
  );
}
