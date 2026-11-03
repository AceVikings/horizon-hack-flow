// OpenCode card (Accounts and Setup's AI step), over lane D3's opencode engine (FREEZE-NOTES §D3.9): status from
// GET /engine/opencode, "Use OpenCode" selects it, "Test" lists its models, and if not signed in "Sign in in
// Terminal" runs `opencode auth login` (main process). The model picker shows a short curated list; "Show all
// models" opens a searchable list (opencode can report hundreds).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn } from "../../src/ui";
import { ErrLine, Spinner, StatusText, useSetup } from "./common";
import { copyText } from "../../src/copy";

interface OcStatus {
  installed: boolean;
  signedIn: boolean;
  logins: string[];
  running: boolean;
  lastError: string | null;
  selectedModel: string | null;
  models: (string | { id: string; label?: string })[];
}
interface Providers {
  selected: { provider: string; model: string };
}

const RECOMMENDED = ["opencode/deepseek-v4.1-flash", "opencode/glm-5.3-flash"];
const BEST = [/claude-opus/i, /claude-sonnet/i, /gpt-5(?!.*mini)/i, /gemini.*pro/i];
const idOf = (m: string | { id: string }) => (typeof m === "string" ? m : m.id);

/** Recommended first, then the best model of each big family the user's logins offer (max 6). */
export function curate(all: string[]): string[] {
  const out = RECOMMENDED.filter((m) => all.includes(m));
  for (const re of BEST) {
    const hit = all.filter((m) => re.test(m)).sort().reverse()[0];
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.slice(0, 6);
}

export function OpencodeCard({ onUsed }: { onUsed?(): void }) {
  const s = useSetup();
  const [st, setSt] = useState<OcStatus | null>(null);
  const [inUse, setInUse] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const refresh = useCallback(async () => {
    const [r, p] = await Promise.all([s.get<OcStatus>("/engine/opencode"), s.get<Providers>("/engine/providers")]);
    if (r.ok) setSt(r.data);
    else setError(r.error);
    if (p.ok) setInUse(p.data.selected.provider === "opencode");
  }, [s]);
  useEffect(() => {
    if (inUse && st?.signedIn) onUsed?.();
  }, [inUse, st, onUsed]);
  useEffect(() => void refresh(), [refresh]);
  const models = useMemo(() => (st?.models ?? []).map(idOf), [st]);
  const short = useMemo(() => curate(models), [models]);
  const found = useMemo(() => (q ? models.filter((m) => m.toLowerCase().includes(q.toLowerCase())) : models).slice(0, 60), [models, q]);

  if (!st) return error ? <ErrLine error={error} /> : <Spinner label="Checking OpenCode…" />;
  const select = async (model?: string) => {
    setError(null);
    const r = await s.post("/engine/select", { provider: "opencode", ...(model ? { model } : {}) });
    if (!r.ok) return setError(r.error);
    await refresh();
    onUsed?.();
  };
  const test = async () => {
    setBusy("Starting OpenCode and listing models…");
    setError(null);
    const r = await s.post("/engine/opencode/test", {});
    setBusy(null);
    if (!r.ok) setError(r.error);
    await refresh();
  };
  const signIn = async () => {
    setError(null);
    const r = await s.proxyCli({ op: "opencode-login" });
    if (!r.ok) return setError(r.error);
    if (!r.data.opened) {
      void copyText(r.data.command);
      return setBusy(null);
    }
    setBusy("Finish signing in to OpenCode in Terminal…");
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const x = await s.get<OcStatus>("/engine/opencode");
      if (x.ok && x.data.signedIn) break;
    }
    setBusy(null);
    await refresh();
  };
  const current = st.selectedModel ?? "";
  return (
    <section className={`card prov${inUse ? " on" : ""}`} aria-label="OpenCode">
      <div className="row sb top">
        <div>
          <h2 className="h3">OpenCode</h2>
          <p className="xs fg2" style={{ marginTop: 6 }}>Use the models your OpenCode login gives you.</p>
        </div>
        {inUse && <StatusText tone="ok">in use</StatusText>}
      </div>
      <div className="row g12" style={{ marginTop: 10 }}>
        {!st.installed ? (
          <StatusText tone="mute">OpenCode is not installed on this Mac</StatusText>
        ) : st.signedIn ? (
          <StatusText tone="ok">signed in{st.logins.length ? ` · ${st.logins.join(", ")}` : ""}</StatusText>
        ) : (
          <StatusText tone="warn">not signed in</StatusText>
        )}
        {st.lastError && <StatusText tone="bad">{st.lastError}</StatusText>}
      </div>
      {st.installed && (
        <div className="row g8" style={{ marginTop: 12, flexWrap: "wrap" }}>
          {!st.signedIn && <Btn size="sm" kind="solid" disabled={!!busy} onClick={() => void signIn()}>Sign in in Terminal</Btn>}
          {st.signedIn && !inUse && <Btn size="sm" kind="solid" disabled={!!busy} onClick={() => void select()}>Use OpenCode</Btn>}
          {st.signedIn && <Btn size="sm" disabled={!!busy} onClick={() => void test()}>Test</Btn>}
        </div>
      )}
      {busy && <div style={{ marginTop: 10 }}><Spinner label={busy} /></div>}
      {st.signedIn && models.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="row g10 sm" style={{ flexWrap: "wrap" }}>
            <span>Model:</span>
            <select className="textin" style={{ width: 260, height: 32 }} aria-label="OpenCode model" value={short.includes(current) ? current : ""} onChange={(e) => void select(e.target.value || undefined)}>
              <option value="">{current && !short.includes(current) ? current : "Recommended (automatic)"}</option>
              {short.map((m) => (
                <option key={m} value={m}>{m}{RECOMMENDED.includes(m) ? " · recommended" : ""}</option>
              ))}
            </select>
            <button className="linkbtn sm" onClick={() => setAll((x) => !x)} aria-expanded={all}>{all ? "Hide all models" : `Show all models (${models.length})`}</button>
          </div>
          {all && (
            <div style={{ marginTop: 10 }}>
              <input className="textin" placeholder="Search models" aria-label="Search OpenCode models" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="col" role="listbox" aria-label="All OpenCode models" style={{ maxHeight: 220, overflowY: "auto", marginTop: 8 }}>
                {found.map((m) => (
                  <button key={m} role="option" aria-selected={m === current} className="kv sm linkrow" onClick={() => void select(m)} style={{ textAlign: "left", background: "none", border: 0, cursor: "pointer", fontWeight: m === current ? 700 : 400 }}>
                    <span className="k mono">{m}</span>
                    {m === current && <span className="v">✓</span>}
                  </button>
                ))}
                {models.length > found.length && <p className="xs fg2" style={{ marginTop: 6 }}>Showing {found.length} of {q ? "the matches" : models.length}. Type to narrow.</p>}
              </div>
            </div>
          )}
        </div>
      )}
      {st.signedIn && models.length === 0 && !busy && <p className="xs fg2" style={{ marginTop: 8 }}>Press Test to list the models.</p>}
      <ErrLine error={error} />
    </section>
  );
}
