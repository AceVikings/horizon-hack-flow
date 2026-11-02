// Accounts (⋯ menu; from Setup's AI step and Settings): the AI providers the in-app agent can use, over lane D3's
// /engine/providers routes. Simple by default: one card per provider with status, Test, and the key. Replacing or
// removing a stored key needs Touch ID (or the daemon's one-time code). The local proxy lives under "Advanced".
import { useEffect, useState } from "react";
import {Btn} from "../../src/ui";
import { PageHead } from "../../src/shell";
import { Details, ErrLine, Spinner, useApproval, useSetup, useSetupGet, StatusText } from "./common";

interface Model {
  id: string;
  label: string;
  tools?: boolean;
}
interface Provider {
  id: "anthropic" | "openai" | "gemini" | "openrouter" | "ollama" | "proxy";
  label: string;
  protocol: string;
  key: "required" | "optional" | "none";
  warning: string | null;
  settings: { baseURL?: string; protocol?: "openai" | "anthropic" };
  credential: { source: string; hint: string | null; stored: boolean };
  configured: boolean;
  selected: boolean;
  health: { at: number; ok: boolean; error?: { kind: string; message: string } } | null;
  models: Model[];
}
interface Providers {
  selected: { provider: string; model: string };
  providers: Provider[];
}

const BLURB: Record<string, string> = {
  anthropic: "Claude. The default and best-tested choice.",
  openai: "GPT models with an OpenAI API key.",
  gemini: "Google Gemini with an API key.",
  openrouter: "Many models through one OpenRouter key.",
  ollama: "Models running on this Mac. No key needed.",
  proxy: "An OpenAI- or Claude-compatible endpoint you run yourself.",
};
const PROXY_WARNING = "Using consumer subscriptions through a proxy may break the provider's terms and can get the account suspended. API keys are the supported path.";

function status(p: Provider): { tone: "ok" | "warn" | "bad" | "mute"; text: string } {
  if (!p.configured) return { tone: "mute", text: "not connected" };
  if (p.health && !p.health.ok) return { tone: "bad", text: p.health.error?.message ?? "not reachable" };
  if (p.health?.ok) return { tone: "ok", text: `connected · ${p.models.length} models` };
  return { tone: "warn", text: p.credential.source === "profile" ? "signed in (ant auth)" : "connected · not tested" };
}

function ProviderCard({ p, selectedModel, onChanged }: { p: Provider; selectedModel: string; onChanged(): void }) {
  const s = useSetup();
  const ap = useApproval();
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(p.settings.baseURL ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  const st = status(p);
  const path = `/engine/providers/${p.id}/credential` as const;
  const cred = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const r = await ap.run(path, body);
    setBusy(false);
    setKey("");
    if (!r.ok && r.error) setError(r.error);
    onChanged();
  };
  const test = async () => {
    setBusy(true);
    setError(null);
    const r = await s.post(`/engine/providers/${p.id}/test`, {});
    setBusy(false);
    if (!r.ok) setError(r.error);
    onChanged();
  };
  const use = async (model: string) => {
    const r = await s.post("/engine/select", { provider: p.id, model });
    if (!r.ok) setError(r.error);
    onChanged();
  };
  return (
    <section className={`card prov${p.selected ? " on" : ""}`} aria-label={p.label}>
      <div className="row sb top">
        <div>
          <h2 className="h3">{p.label}</h2>
          <p className="xs fg2" style={{ marginTop: 6 }}>{BLURB[p.id]}</p>
        </div>
        {p.selected && <StatusText y glyph="★">in use</StatusText>}
      </div>
      <div className="row g8" style={{ marginTop: 12 }}>
        <StatusText tone={st.tone}>{st.text}</StatusText>
        {p.credential.hint && <span className="mono xs fg2">{p.credential.hint}</span>}
      </div>
      {p.id === "proxy" || p.id === "ollama" ? (
        <div className="row g8" style={{ marginTop: 12 }}>
          <input className="textin" placeholder={p.id === "ollama" ? "http://127.0.0.1:11434/v1" : "Base URL (https://… or http://127.0.0.1:…)"} aria-label={`${p.label} base URL`} value={url} onChange={(e) => setUrl(e.target.value)} />
          <Btn size="sm" disabled={busy || !url} onClick={() => void cred({ baseURL: url.trim() })}>Save</Btn>
        </div>
      ) : null}
      {p.key !== "none" && (
        <div className="row g8" style={{ marginTop: 10 }}>
          <input className="textin" type="password" autoComplete="off" spellCheck={false} placeholder={p.credential.stored ? "New key to replace the stored one" : p.key === "optional" ? "API key (optional)" : "API key"} aria-label={`${p.label} API key`} value={key} onChange={(e) => setKey(e.target.value)} />
          <Btn size="sm" kind="solid" disabled={busy || key.trim().length < 8} onClick={() => void cred({ action: "set", apiKey: key.trim() })}>{p.credential.stored ? "Replace" : "Save"}</Btn>
        </div>
      )}
      <div className="row g8" style={{ marginTop: 12 }}>
        <Btn size="sm" disabled={busy || !p.configured} onClick={() => void test()}>{busy ? "Working…" : "Test"}</Btn>
        {p.credential.stored && <Btn size="sm" kind="ghost" disabled={busy} onClick={() => void cred({ action: "remove" })}>Remove key</Btn>}
        <span className="grow" />
        {p.configured && p.models.length > 0 && (
          <select className="textin" style={{ width: 200, height: 32 }} aria-label={`Model for the agent (${p.label})`} value={p.selected ? selectedModel : ""} onChange={(e) => void use(e.target.value)}>
            {!p.selected && <option value="">Use for the agent…</option>}
            {p.models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        )}
      </div>
      {(p.credential.stored || p.id === "proxy") && <div className="xs fg2" style={{ marginTop: 8 }}>Replacing or removing a key asks for Touch ID.</div>}
      <ErrLine error={error} />
      {ap.dialog}
    </section>
  );
}

const FLAG_LABEL: Record<string, string> = { "--claude-login": "Claude", "--codex-login": "Codex / ChatGPT", "--login": "Gemini", "--antigravity-login": "Antigravity", "--xai-login": "Grok", "--grok-login": "Grok", "--kimi-login": "Kimi", "--qwen-login": "Qwen", "--iflow-login": "iFlow" };

/** The user's own CLIProxyAPI: sign-in happens in their Terminal; Flow only opens it and lists what the proxy reports. */
function ProxyCli({ baseURL }: { baseURL: string }) {
  const s = useSetup();
  const [info, setInfo] = useState<{ bin: string | null; flags: string[]; platform: string; install: string } | null>(null);
  const [models, setModels] = useState<{ running: boolean; models: { id: string }[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const detect = async (op: "detect" | "pick" = "detect") => {
    const r = await s.proxyCli({ op });
    if (r.ok) setInfo(r.data);
    const m = await s.proxyCli({ op: "models", baseURL: baseURL || "http://127.0.0.1:8317" });
    if (m.ok) setModels(m.data);
  };
  useEffect(() => void detect(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const login = async (flag: string) => {
    const r = await s.proxyCli({ op: "login", flag });
    if (!r.ok) return setMsg(r.error.message);
    if (!r.data.opened) {
      void navigator.clipboard?.writeText(r.data.command);
      setMsg("Copied. Paste it into your terminal to sign in.");
    } else setMsg("Terminal opened. Finish the sign-in there, then press Refresh.");
  };
  const copy = (flag: string) => {
    if (!info?.bin) return;
    void navigator.clipboard?.writeText(`'${info.bin}' ${flag}`);
    setMsg("Command copied.");
  };
  if (!info) return <Spinner label="Looking for CLIProxyAPI…" />;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="row g10 sm">
        {info.bin ? <StatusText tone="ok">CLIProxyAPI found</StatusText> : <StatusText tone="warn">CLIProxyAPI not found</StatusText>}
        {models && <StatusText tone={models.running ? "ok" : "mute"}>{models.running ? `server running · ${models.models.length} models` : "server not running"}</StatusText>}
        <span className="grow" />
        <button className="linkbtn sm" onClick={() => void detect("pick")}>Choose the program…</button>
        <button className="linkbtn sm" onClick={() => void detect()}>Refresh</button>
      </div>
      {!info.bin && (
        <p className="sm fg2" style={{ marginTop: 8 }}>
          Flow does not include or install it. <button className="linkbtn" onClick={() => void s.open(info.install + "/")}>Get CLIProxyAPI ↗</button>
        </p>
      )}
      {info.bin && (
        <div style={{ marginTop: 10 }}>
          {info.flags.length === 0 && <p className="sm fg2">This version lists no sign-in options in its help.</p>}
          {info.flags.map((f) => (
            <div key={f} className="kv sm">
              <span className="k">{FLAG_LABEL[f] ?? (f.replace(/^--|-login$/g, "") || "Gemini")}</span>
              <span className="v row g8">
                {info.platform === "darwin" && <Btn size="sm" onClick={() => void login(f)}>Sign in in Terminal</Btn>}
                <Btn size="sm" kind="ghost" onClick={() => copy(f)}>Copy command</Btn>
              </span>
            </div>
          ))}
        </div>
      )}
      {models?.models.length ? <div className="xs fg2" style={{ marginTop: 8 }}>Models: {models.models.slice(0, 12).map((m) => m.id).join(", ")}{models.models.length > 12 ? "…" : ""}</div> : null}
      {msg && <p className="sm" role="status" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}

function ProxyAccounts({ baseURL }: { baseURL: string }) {
  const s = useSetup();
  const [mgmt, setMgmt] = useState("");
  const [accounts, setAccounts] = useState<unknown>(null);
  const [msg, setMsg] = useState<{ message: string } | null>(null);
  const list = async () => {
    setMsg(null);
    const r = await s.proxy({ baseURL, mgmtKey: mgmt, op: "accounts" });
    if (!r.ok) return setMsg(r.error);
    setAccounts(r.data);
  };
  const login = async (provider: string) => {
    setMsg(null);
    const r = await s.proxy({ baseURL, mgmtKey: mgmt, op: "auth-url", provider });
    if (!r.ok) return setMsg(r.error);
    const state = String((r.data as { state?: string }).state ?? "");
    setMsg({ message: "Finish the login in your browser. Flow checks every few seconds." });
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const st = await s.proxy({ baseURL, mgmtKey: mgmt, op: "status", state });
      const v = st.ok ? String((st.data as { status?: string }).status ?? "") : "";
      if (v === "ok" || v === "success" || v === "done") {
        setMsg({ message: "Connected." });
        return void list();
      }
      if (v === "error" || v === "failed") return setMsg({ message: "The login did not finish." });
    }
  };
  const files = (accounts as { files?: { name?: string; email?: string; type?: string; provider?: string }[] } | null)?.files ?? [];
  return (
    <div style={{ marginTop: 14 }}>
      <div className="lbl">Proxy accounts</div>
      <div className="row g8" style={{ marginTop: 8 }}>
        <input className="textin" type="password" autoComplete="off" placeholder="Proxy management key" aria-label="Proxy management key" value={mgmt} onChange={(e) => setMgmt(e.target.value)} />
        <Btn size="sm" disabled={!mgmt || !baseURL} onClick={() => void list()}>Show accounts</Btn>
      </div>
      {accounts !== null && (
        <div style={{ marginTop: 10 }}>
          {files.length ? files.map((f, i) => <div key={i} className="kv sm"><span className="k">{f.provider ?? f.type ?? "account"}</span><span className="v">{f.email ?? f.name ?? "—"}</span></div>) : <p className="sm fg2">No accounts connected in the proxy.</p>}
          <div className="row g8" style={{ marginTop: 10, flexWrap: "wrap" }}>
            {["claude", "codex", "antigravity", "xai", "kimi"].map((p) => (
              <Btn key={p} size="sm" onClick={() => void login(p)}>Log in: {p}</Btn>
            ))}
          </div>
        </div>
      )}
      {msg && <p className="sm" style={{ marginTop: 8 }} role="status">{msg.message}</p>}
    </div>
  );
}

export default function Accounts() {
  const pr = useSetupGet<Providers>("/engine/providers");
  const d = pr.data;
  const main = d?.providers.filter((p) => p.id !== "proxy") ?? [];
  const proxy = d?.providers.find((p) => p.id === "proxy");
  return (
    <div className="sw-col" data-shot="accounts" style={{ paddingTop: 10 }}>
      <PageHead title="Accounts" sub="Pick the AI the agent thinks with. API keys stay in your Mac's keychain." />
      {!d ? (
        pr.res?.ok === false ? <ErrLine error={pr.res.error} /> : <Spinner label="Loading accounts…" />
      ) : (
        <>
          <div className="provgrid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 8 }}>
            {main.map((p) => (
              <ProviderCard key={p.id} p={p} selectedModel={d.selected.model} onChanged={pr.reload} />
            ))}
          </div>
          {proxy && (
            <Details summary="Advanced: local proxy">
              <div className="warnbox sm" role="note" style={{ marginBottom: 12 }}>
                <b>Careful.</b> {PROXY_WARNING}
              </div>
              <p className="sm fg2" style={{ marginBottom: 10 }}>Flow does not include a proxy. Run your own and point Flow at it.</p>
              <ProviderCard p={proxy} selectedModel={d.selected.model} onChanged={pr.reload} />
              <ProxyCli baseURL={proxy.settings.baseURL ?? ""} />
              {proxy.settings.baseURL && <Details summary="Proxy management key (optional)"><ProxyAccounts baseURL={proxy.settings.baseURL} /></Details>}
            </Details>
          )}
        </>
      )}
    </div>
  );
}
