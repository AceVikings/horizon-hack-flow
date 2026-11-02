// "Sign in with your subscription" (Setup's AI step and the top of Accounts). Sign-in runs through the user's
// CLIProxyAPI: on the desktop Flow opens Terminal on the matching login command; in cloud mode it uses the proxy's
// management OAuth link in the browser. If the helper is missing, one button asks the daemon to install the official
// release (lane D3 endpoint). Flow then points the agent at the proxy and shows the models it reports.
import { useCallback, useEffect, useState } from "react";
import { Btn } from "../../src/ui";
import { ErrLine, Spinner, StatusText, useSetup } from "./common";

const PROXY_URL = "http://127.0.0.1:8317";
export const TERMS_LINE = "Subscriptions are used through CLIProxyAPI and are subject to each provider's terms.";

const SUBS = [
  { id: "claude", label: "Claude", flags: ["--claude-login"], oauth: "claude", match: /claude/i },
  { id: "codex", label: "ChatGPT / Codex", flags: ["--codex-login"], oauth: "codex", match: /gpt|codex|^o\d/i },
  { id: "gemini", label: "Gemini", flags: ["--login", "--antigravity-login"], oauth: "antigravity", match: /gemini/i },
  { id: "grok", label: "Grok", flags: ["--xai-login", "--grok-login"], oauth: "xai", match: /grok/i },
  { id: "kimi", label: "Kimi", flags: ["--kimi-login"], oauth: "kimi", match: /kimi|moonshot/i },
] as const;

interface Cli {
  bin: string | null;
  flags: string[];
  platform: string;
}
interface ModelList {
  running: boolean;
  models: { id: string }[];
}

export function SubscriptionSignIn({ onConnected }: { onConnected?(ok: boolean): void }) {
  const s = useSetup();
  const [cli, setCli] = useState<Cli | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const r = await s.proxyCli({ op: "detect" });
    setCli(r.ok ? r.data : { bin: null, flags: [], platform: "web" });
    const m = await s.proxyCli({ op: "models", baseURL: PROXY_URL });
    if (m.ok) setModels(m.data);
  }, [s]);
  useEffect(() => void refresh(), [refresh]);
  const connected = !!models?.running && models.models.length > 0;
  useEffect(() => onConnected?.(connected), [connected, onConnected]);

  const install = async () => {
    setBusy("Installing the sign-in helper…");
    setError(null);
    const r = await s.post("/engine/proxy/install" as never, {});
    setBusy(null);
    if (!r.ok) return setError({ message: r.error.message.includes("not found") ? "Installing the helper isn't available in this build yet." : r.error.message });
    await refresh();
  };
  const signIn = async (sub: (typeof SUBS)[number]) => {
    setError(null);
    setMsg(null);
    const flag = sub.flags.find((f) => cli?.flags.includes(f));
    if (cli?.bin && flag && cli.platform === "darwin") {
      const r = await s.proxyCli({ op: "login", flag });
      if (!r.ok) return setError(r.error);
      setMsg(`Terminal opened. Finish signing in to ${sub.label} there, then come back.`);
    } else {
      // cloud mode (or no Terminal): the proxy's own OAuth page in the browser
      const r = await s.proxy({ baseURL: PROXY_URL, mgmtKey: "", op: "auth-url", provider: sub.oauth });
      if (!r.ok) return setError(r.error);
      setMsg(`Finish signing in to ${sub.label} in your browser.`);
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 4000));
      const m = await s.proxyCli({ op: "models", baseURL: PROXY_URL });
      if (m.ok) setModels(m.data);
      if (m.ok && m.data.models.some((x: { id: string }) => sub.match.test(x.id))) {
        setMsg(`${sub.label} connected.`);
        return useForAgent(m.data.models.find((x: { id: string }) => sub.match.test(x.id))!.id);
      }
    }
  };
  const useForAgent = async (model: string) => {
    await s.approveStart("/engine/providers/proxy/credential", { baseURL: PROXY_URL, protocol: /claude/i.test(model) ? "anthropic" : "openai" });
    await s.post("/engine/select", { provider: "proxy", model });
  };

  if (!cli) return <Spinner label="Checking sign-in…" />;
  return (
    <div>
      {!cli.bin && cli.platform !== "web" && (
        <div className="row g12" style={{ marginTop: 12 }}>
          <span className="sm">Flow needs a small sign-in helper first.</span>
          <span className="grow" />
          <Btn kind="solid" disabled={!!busy} onClick={() => void install()}>Install sign-in helper</Btn>
        </div>
      )}
      {busy && <div style={{ marginTop: 10 }}><Spinner label={busy} /></div>}
      <div className="provgrid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", marginTop: 14 }}>
        {SUBS.map((sub) => {
          const on = !!models?.models.some((m) => sub.match.test(m.id));
          return (
            <div key={sub.id} className={`hx col${on ? " prov on" : ""}`} style={{ gap: 10 }}>
              <b>{sub.label}</b>
              {on ? <StatusText tone="ok">connected</StatusText> : <Btn size="sm" disabled={!cli.bin && cli.platform !== "web"} onClick={() => void signIn(sub)}>Sign in</Btn>}
            </div>
          );
        })}
      </div>
      {connected && (
        <div className="row g10 sm" style={{ marginTop: 12, flexWrap: "wrap" }}>
          <span>Models available:</span>
          <select className="textin" style={{ width: 240, height: 32 }} aria-label="Model for the agent" defaultValue="" onChange={(e) => e.target.value && void useForAgent(e.target.value)}>
            <option value="">Choose for the agent…</option>
            {models!.models.map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
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
