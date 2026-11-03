// "Sign in with your subscription" (Setup's AI step and the top of Accounts), over lane D3's managed CLIProxyAPI
// sidecar (`window.ate.subscription`, FREEZE-NOTES §D3.8). Primary: in-app sign-in (the provider's login page in the
// browser, polled through the daemon). Secondary: "Sign in in Terminal" runs `<bin> -config <configPath> <flag>`
// from main with values the daemon reports, so the login lands in Flow's proxy. Missing helper: one Install button.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SubscriptionStatus } from "@shared/bridge";
import { useApp } from "../../src/app";
import { Btn } from "../../src/ui";
import { ErrLine, Spinner, StatusText, useSetup } from "./common";
import { copyText } from "../../src/copy";

export const TERMS_LINE = "Subscriptions are used through CLIProxyAPI and are subject to each provider's terms.";

type LoginProvider = "claude" | "codex" | "antigravity" | "kimi" | "xai";
const SUBS: { id: LoginProvider; label: string; flag: RegExp; match: RegExp }[] = [
  { id: "claude", label: "Claude", flag: /^-+claude-login$/, match: /claude/i },
  { id: "codex", label: "ChatGPT / Codex", flag: /^-+codex-login$/, match: /gpt|codex|^o\d/i },
  { id: "antigravity", label: "Gemini", flag: /^-+antigravity-login$|^-+login$/, match: /gemini/i },
  { id: "xai", label: "Grok", flag: /^-+(xai|grok)-login$/, match: /grok/i },
  { id: "kimi", label: "Kimi", flag: /^-+kimi-login$/, match: /kimi|moonshot/i },
];

export function SubscriptionSignIn({ onConnected }: { onConnected?(ok: boolean): void }) {
  const { ate } = useApp();
  const s = useSetup();
  const sub = ate.subscription;
  const [st, setSt] = useState<SubscriptionStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const refresh = useCallback(async () => {
    if (!sub) return;
    const r = await sub.status();
    if (r.ok) setSt(r.data);
    else setError(r.error);
  }, [sub]);
  useEffect(() => void refresh(), [refresh]);
  const connected = !!st?.healthy && st.models.length > 0;
  // only when `connected` changes: callers pass an inline callback that reloads data, so depending on its identity
  // re-ran it on every render (Accounts reloaded /engine/providers in a loop and exhausted local TCP ports)
  const cb = useRef(onConnected);
  cb.current = onConnected;
  useEffect(() => cb.current?.(connected), [connected]);

  if (!sub) return <p className="sm fg2" style={{ marginTop: 8 }}>Subscription sign-in isn't available in this build.</p>;
  if (!st) return error ? <ErrLine error={error} /> : <Spinner label="Checking sign-in…" />;

  const install = async () => {
    setBusy("Installing the sign-in helper…");
    setError(null);
    const r = await sub.op("install");
    if (r.ok) {
      setBusy(null);
      return setSt(r.data);
    }
    // the download can outlast the request: keep checking for up to 3 minutes before reporting the error
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const x = await sub.status();
      if (x.ok && x.data.installed) {
        setBusy(null);
        return setSt(x.data);
      }
    }
    setBusy(null);
    setError(r.error);
  };
  const waitFor = async (p: (typeof SUBS)[number], state: string | null) => {
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      if (state) {
        const r = await sub.loginStatus(state);
        if (r.ok && (r.data.login || r.data.models.some((m) => p.match.test(m)))) break;
      } else {
        const r = await sub.status();
        if (r.ok && r.data.models.some((m) => p.match.test(m))) break;
      }
    }
    await refresh();
    setBusy(null);
    setMsg(null);
  };
  const signIn = async (p: (typeof SUBS)[number]) => {
    setError(null);
    const r = await sub.login(p.id);
    if (!r.ok) return setError(r.error);
    await s.open(r.data.url);
    setBusy(`Finish signing in to ${p.label} in your browser…`);
    await waitFor(p, r.data.state);
  };
  const terminal = async (p: (typeof SUBS)[number], flag: string) => {
    setError(null);
    const r = await s.proxyCli({ op: "login", flag });
    if (!r.ok) return setError(r.error);
    if (!r.data.opened) {
      void copyText(r.data.command);
      setMsg("Command copied. Paste it into a terminal to sign in.");
      return;
    }
    setBusy(`Finish signing in to ${p.label} in Terminal…`);
    await waitFor(p, null);
  };

  return (
    <div>
      {!st.installed ? (
        <div className="row g12" style={{ marginTop: 12 }}>
          <span className="sm">Flow needs a small sign-in helper first.</span>
          <span className="grow" />
          <Btn kind="solid" disabled={!!busy} onClick={() => void install()}>Install sign-in helper</Btn>
        </div>
      ) : (
        !st.healthy && (
          <div className="row g12" style={{ marginTop: 12 }}>
            <StatusText tone="warn">The sign-in helper is not running.</StatusText>
            <span className="grow" />
            <Btn size="sm" onClick={() => void sub.op("start").then((r) => r.ok && setSt(r.data))}>Start it</Btn>
          </div>
        )
      )}
      {busy && <div style={{ marginTop: 10 }}><Spinner label={busy} /></div>}
      <div className="provgrid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", marginTop: 14 }}>
        {SUBS.map((p) => {
          const on = st.models.some((m) => p.match.test(m));
          const flag = st.loginFlags.find((f) => p.flag.test(f));
          return (
            <div key={p.id} className={`hx col${on ? " prov on" : ""}`} style={{ gap: 8 }}>
              <b>{p.label}</b>
              {on ? (
                <StatusText tone="ok">connected</StatusText>
              ) : (
                <>
                  <Btn size="sm" kind="solid" disabled={!st.installed || !!busy} onClick={() => void signIn(p)}>Sign in</Btn>
                  {flag && (
                    <button className="linkbtn xs" disabled={!!busy} onClick={() => void terminal(p, flag)} style={{ alignSelf: "flex-start" }}>
                      Sign in in Terminal
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {connected && (
        <div className="row g10 sm" style={{ marginTop: 12, flexWrap: "wrap" }}>
          <span>The agent uses:</span>
          <select
            className="textin"
            style={{ width: 260, height: 32 }}
            aria-label="Model for the agent"
            value={st.selectedModel ?? ""}
            onChange={(e) => void ate.engine?.select("subscription", e.target.value || undefined).then(() => refresh())}
          >
            <option value="">Best available (automatic)</option>
            {st.models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      )}
      {msg && <p className="sm" role="status" style={{ marginTop: 10 }}>{msg}</p>}
      <ErrLine error={error} />
      <p className="xs fg2" style={{ marginTop: 10 }}>{TERMS_LINE}</p>
    </div>
  );
}
